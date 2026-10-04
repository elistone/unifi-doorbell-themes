import { DatabaseSync } from "node:sqlite";
import type { Cursor, Device, Rule, Selection, Theme } from "../domain/types.ts";

/**
 * Storage.
 *
 * Four tables, and the split between them is the point: configuration is what
 * a person authored, runtime state is what the scheduler has done, the
 * manifest is what the NVR knows about, and applies are the audit trail.
 * Mixing the first two is what makes state impossible to reason about later -
 * every daily roll would dirty the config, and a human editing it would race
 * the daemon writing it.
 *
 * node:sqlite rather than a driver, so the project keeps its no-dependency,
 * no-build-step property. It prints an ExperimentalWarning on startup; that is
 * noise, not instability, and the alternative is a native module that needs
 * compiling on every platform this is published for.
 */

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  -- The doorbells. One row per camera this instance drives.
  --
  -- Seeded from PROTECT_CAMERA_ID on first run so a single-doorbell setup
  -- never has to think about this, and added through the UI after that.
  -- The name is the user's, not Protect's: "Front door" is what you want to
  -- read on a theme, not "UVC G4 Doorbell Pro".
  CREATE TABLE IF NOT EXISTS devices (
    id         TEXT PRIMARY KEY,          -- the Protect camera id
    name       TEXT    NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
  );

  -- Configuration: authored by a person or the UI.
  CREATE TABLE IF NOT EXISTS themes (
    id        TEXT PRIMARY KEY,
    name      TEXT    NOT NULL,
    image     TEXT    NOT NULL,              -- content hash, resolved via assets
    sound     TEXT,                          -- content hash; null until sound lands
    priority  INTEGER NOT NULL DEFAULT 0,
    enabled   INTEGER NOT NULL DEFAULT 1,
    rules     TEXT    NOT NULL DEFAULT '[]', -- JSON array of Rule
    -- JSON array of device ids. EMPTY MEANS EVERY DOORBELL, which is what
    -- makes adding a second one not silently unschedule the first - and
    -- what lets every theme written before devices existed keep working.
    devices   TEXT    NOT NULL DEFAULT '[]'
  );

  -- The manifest. Content hash -> the asset name the NVR gave back.
  --
  -- This is what makes upload-once work. Protect mints a fresh UUID on every
  -- upload and offers no overwrite, so without a record of what has already
  -- been sent, every rotation would leak a new permanent asset.
  CREATE TABLE IF NOT EXISTS assets (
    hash          TEXT PRIMARY KEY,
    asset_name    TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size          INTEGER,
    uploaded_at   TEXT NOT NULL
  );

  -- Runtime state. Deliberately not in the config tables.
  CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Accounts. Normally exactly one; the schema does not insist on it.
  --
  -- "No rows" is the first-run signal the UI keys off, which is why there is
  -- no seeded default account: a default credential that nobody is forced to
  -- change is the same as no credential at all.
  CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  -- Sessions. Only the digest of each token is stored - see digestToken.
  CREATE TABLE IF NOT EXISTS sessions (
    token_digest TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (username);

  -- Audit. Answers "why is it showing that" without guessing.
  CREATE TABLE IF NOT EXISTS applies (
    at         TEXT NOT NULL,
    device_id  TEXT,
    theme_id   TEXT,
    asset_name TEXT,
    reason     TEXT NOT NULL,
    outcome    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS applies_at ON applies (at DESC);
`;

export interface AssetRecord {
  hash: string;
  assetName: string;
  originalName: string;
  size: number | null;
  uploadedAt: string;
}

export type Outcome = "applied" | "unchanged" | "failed" | "dry-run" | "no-theme";

export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  /**
   * Add columns to tables that already exist.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that is already
   * there, so the schema above only describes a fresh database. Every
   * installation that predates a column needs it added here, and the
   * deployed one has real themes in it - getting this wrong does not throw,
   * it quietly reads NULL for a column the code expects.
   *
   * Checked against table_info rather than tracked with a version number:
   * there are few enough of these that "is the column there" is both
   * simpler and impossible to get out of step with reality.
   */
  #migrate(): void {
    const columns = (table: string): Set<string> =>
      new Set(
        (this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );

    if (!columns("themes").has("devices")) {
      this.#db.exec("ALTER TABLE themes ADD COLUMN devices TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns("applies").has("device_id")) {
      this.#db.exec("ALTER TABLE applies ADD COLUMN device_id TEXT");
    }
  }

  close(): void {
    this.#db.close();
  }

  // ---------------------------------------------------------------- themes

  themes(): Theme[] {
    const rows = this.#db.prepare("SELECT * FROM themes ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(toTheme);
  }

  /**
   * Themes that may apply to one doorbell.
   *
   * A theme with no devices listed applies everywhere. That default is what
   * keeps adding a second doorbell from silently unscheduling the first,
   * and what lets themes written before devices existed carry on working.
   */
  themesFor(deviceId: string): Theme[] {
    return this.themes().filter((t) => t.devices.length === 0 || t.devices.includes(deviceId));
  }

  upsertTheme(theme: Theme): void {
    this.#db
      .prepare(
        `INSERT INTO themes (id, name, image, sound, priority, enabled, rules, devices)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, image = excluded.image, sound = excluded.sound,
           priority = excluded.priority, enabled = excluded.enabled,
           rules = excluded.rules, devices = excluded.devices`,
      )
      .run(
        theme.id,
        theme.name,
        theme.image,
        theme.sound ?? null,
        theme.priority,
        theme.enabled ? 1 : 0,
        JSON.stringify(theme.rules),
        JSON.stringify(theme.devices ?? []),
      );
  }

  // -------------------------------------------------------------- devices

  devices(): Device[] {
    const rows = this.#db
      .prepare("SELECT * FROM devices ORDER BY position, name")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      enabled: Number(row.enabled) === 1,
      position: Number(row.position),
    }));
  }

  device(id: string): Device | null {
    return this.devices().find((d) => d.id === id) ?? null;
  }

  upsertDevice(device: Device): void {
    this.#db
      .prepare(
        `INSERT INTO devices (id, name, enabled, position, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, enabled = excluded.enabled, position = excluded.position`,
      )
      .run(
        device.id,
        device.name,
        device.enabled ? 1 : 0,
        device.position ?? 0,
        new Date().toISOString(),
      );
  }

  /**
   * Forget a doorbell, and drop it from every theme that named it.
   *
   * Leaving the id behind in themes would be worse than untidy: a theme
   * scoped only to a removed device matches nothing, and reads in the UI
   * as enabled-but-never-applies with no visible reason.
   */
  deleteDevice(id: string): void {
    this.#db.prepare("DELETE FROM devices WHERE id = ?").run(id);

    for (const theme of this.themes()) {
      if (!theme.devices.includes(id)) continue;
      const remaining = theme.devices.filter((d) => d !== id);

      // A theme scoped ONLY to the doorbell being removed must not be left
      // with an empty list, because empty means "everywhere" - deleting a
      // doorbell would silently promote its themes onto all the others.
      // Disabled instead: visible, reversible, and does nothing until
      // someone decides what it should apply to now.
      this.upsertTheme(
        remaining.length === 0
          ? { ...theme, devices: [], enabled: false }
          : { ...theme, devices: remaining },
      );
    }

    this.#db.prepare("DELETE FROM state WHERE key LIKE ?").run(`device:${id}:%`);
  }

  deleteTheme(id: string): void {
    this.#db.prepare("DELETE FROM themes WHERE id = ?").run(id);
  }

  // --------------------------------------------------------------- assets

  asset(hash: string): AssetRecord | null {
    const row = this.#db.prepare("SELECT * FROM assets WHERE hash = ?").get(hash) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      hash: String(row.hash),
      assetName: String(row.asset_name),
      originalName: String(row.original_name),
      size: row.size == null ? null : Number(row.size),
      uploadedAt: String(row.uploaded_at),
    };
  }

  recordAsset(record: AssetRecord): void {
    this.#db
      .prepare(
        `INSERT INTO assets (hash, asset_name, original_name, size, uploaded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(record.hash, record.assetName, record.originalName, record.size, record.uploadedAt);
  }

  assets(): AssetRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM assets ORDER BY uploaded_at")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      hash: String(row.hash),
      assetName: String(row.asset_name),
      originalName: String(row.original_name),
      size: row.size == null ? null : Number(row.size),
      uploadedAt: String(row.uploaded_at),
    }));
  }

  /**
   * Drop manifest entries for assets the NVR no longer has.
   *
   * Needed because the NVR is the authority, not us: someone can delete an
   * image through Protect's own UI, and a stale manifest would then hand out
   * a name that no longer resolves. Protect degrades gracefully when that
   * happens (it resets lcdMessage), but a silent fallback to the default
   * image is exactly the kind of quiet wrongness worth avoiding.
   */
  reconcileAssets(namesOnNvr: Set<string>): string[] {
    const dropped: string[] = [];
    for (const record of this.assets()) {
      if (!namesOnNvr.has(record.assetName)) {
        this.#db.prepare("DELETE FROM assets WHERE hash = ?").run(record.hash);
        dropped.push(record.assetName);
      }
    }
    return dropped;
  }

  // ---------------------------------------------------------------- state

  selection(): Selection {
    return this.#value("selection") === "sequential" ? "sequential" : "random";
  }

  setSelection(selection: Selection): void {
    this.#setValue("selection", selection);
  }

  /**
   * Rotation position, per doorbell.
   *
   * Per device because two doorbells sharing one cursor would advance it
   * twice a day each and skip half the library between them.
   */
  cursor(deviceId: string): Cursor {
    const raw = this.#value(`device:${deviceId}:cursor`);
    return raw ? (JSON.parse(raw) as Cursor) : {};
  }

  setCursor(deviceId: string, cursor: Cursor): void {
    this.#setValue(`device:${deviceId}:cursor`, JSON.stringify(cursor));
  }

  /**
   * The local date of the last successful roll, as YYYY-MM-DD.
   *
   * A date rather than a timestamp, because the question the daemon asks is
   * "have we rolled today", and that survives restarts, clock changes and
   * downtime in a way "is it 24 hours since last time" does not.
   */
  lastRolledDate(): string | null {
    return this.#value("lastRolledDate");
  }

  setLastRolledDate(date: string): void {
    this.#setValue("lastRolledDate", date);
  }

  /** The asset name we last successfully set on a doorbell, for drift. */
  lastAppliedAsset(deviceId: string): string | null {
    return this.#value(`device:${deviceId}:lastAppliedAsset`);
  }

  setLastAppliedAsset(deviceId: string, name: string): void {
    this.#setValue(`device:${deviceId}:lastAppliedAsset`, name);
  }

  // ------------------------------------------------------------- settings

  /**
   * User-facing preferences, as opposed to the deployment's environment.
   *
   * Stored rather than configured so they can be changed from the UI
   * without a redeploy. Each falls back to its environment variable, which
   * stays the way a headless or first-boot install is configured.
   */
  setting(key: string): string | null {
    return this.#value(`setting:${key}`);
  }

  setSetting(key: string, value: string): void {
    this.#setValue(`setting:${key}`, value);
  }

  clearSetting(key: string): void {
    this.#db.prepare("DELETE FROM state WHERE key = ?").run(`setting:${key}`);
  }

  #value(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  #setValue(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  // ----------------------------------------------------------------- auth

  userCount(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return Number(row.n);
  }

  user(username: string): { username: string; passwordHash: string } | null {
    const row = this.#db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      | Record<string, unknown>
      | undefined;
    return row ? { username: String(row.username), passwordHash: String(row.password_hash) } : null;
  }

  createUser(username: string, passwordHash: string): void {
    this.#db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username, passwordHash, new Date().toISOString());
  }

  setPassword(username: string, passwordHash: string): void {
    this.#db
      .prepare("UPDATE users SET password_hash = ? WHERE username = ?")
      .run(passwordHash, username);
  }

  createSession(digest: string, username: string, expiresAt: Date): void {
    this.#db
      .prepare("INSERT INTO sessions (token_digest, username, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(digest, username, new Date().toISOString(), expiresAt.toISOString());
  }

  /** The username for a live session, or null. Expired rows are swept here. */
  sessionUser(digest: string): string | null {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE token_digest = ?").get(digest) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (new Date(String(row.expires_at)).getTime() < Date.now()) {
      this.deleteSession(digest);
      return null;
    }
    return String(row.username);
  }

  deleteSession(digest: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE token_digest = ?").run(digest);
  }

  /**
   * Drop every session for a user.
   *
   * Called on a password change: the point of changing a password is to lock
   * someone out, and leaving their existing session valid would not.
   */
  deleteSessionsFor(username: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE username = ?").run(username);
  }

  deleteExpiredSessions(): number {
    const result = this.#db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  // --------------------------------------------------------------- applies

  recordApply(entry: {
    at: string;
    deviceId: string | null;
    themeId: string | null;
    assetName: string | null;
    reason: string;
    outcome: Outcome;
  }): void {
    this.#db
      .prepare(
        "INSERT INTO applies (at, device_id, theme_id, asset_name, reason, outcome) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.at, entry.deviceId, entry.themeId, entry.assetName, entry.reason, entry.outcome);
  }

  recentApplies(limit = 20, deviceId?: string): Array<{
    at: string;
    deviceId: string | null;
    themeId: string | null;
    assetName: string | null;
    reason: string;
    outcome: string;
  }> {
    const rows = (
      deviceId
        ? this.#db
            .prepare("SELECT * FROM applies WHERE device_id = ? ORDER BY at DESC LIMIT ?")
            .all(deviceId, limit)
        : this.#db.prepare("SELECT * FROM applies ORDER BY at DESC LIMIT ?").all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      at: String(row.at),
      deviceId: row.device_id == null ? null : String(row.device_id),
      themeId: row.theme_id == null ? null : String(row.theme_id),
      assetName: row.asset_name == null ? null : String(row.asset_name),
      reason: String(row.reason),
      outcome: String(row.outcome),
    }));
  }
}

function toTheme(row: Record<string, unknown>): Theme {
  return {
    id: String(row.id),
    name: String(row.name),
    image: String(row.image),
    sound: row.sound == null ? undefined : String(row.sound),
    priority: Number(row.priority),
    enabled: Number(row.enabled) === 1,
    rules: JSON.parse(String(row.rules)) as Rule[],
    // Older rows predate the column; the migration backfills '[]', but a
    // null here would otherwise crash rather than mean "everywhere".
    devices: row.devices == null ? [] : (JSON.parse(String(row.devices)) as string[]),
  };
}
