import { DatabaseSync } from "node:sqlite";
import type { Cursor, Rule, Selection, Theme } from "../domain/types.ts";

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

  -- Configuration: authored by a person or the UI.
  CREATE TABLE IF NOT EXISTS themes (
    id        TEXT PRIMARY KEY,
    name      TEXT    NOT NULL,
    image     TEXT    NOT NULL,              -- content hash, resolved via assets
    sound     TEXT,                          -- content hash; null until sound lands
    priority  INTEGER NOT NULL DEFAULT 0,
    enabled   INTEGER NOT NULL DEFAULT 1,
    rules     TEXT    NOT NULL DEFAULT '[]'  -- JSON array of Rule
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

  -- Audit. Answers "why is it showing that" without guessing.
  CREATE TABLE IF NOT EXISTS applies (
    at         TEXT NOT NULL,
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
  }

  close(): void {
    this.#db.close();
  }

  // ---------------------------------------------------------------- themes

  themes(): Theme[] {
    const rows = this.#db.prepare("SELECT * FROM themes ORDER BY id").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      image: String(row.image),
      sound: row.sound == null ? undefined : String(row.sound),
      priority: Number(row.priority),
      enabled: Number(row.enabled) === 1,
      rules: JSON.parse(String(row.rules)) as Rule[],
    }));
  }

  upsertTheme(theme: Theme): void {
    this.#db
      .prepare(
        `INSERT INTO themes (id, name, image, sound, priority, enabled, rules)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, image = excluded.image, sound = excluded.sound,
           priority = excluded.priority, enabled = excluded.enabled, rules = excluded.rules`,
      )
      .run(
        theme.id,
        theme.name,
        theme.image,
        theme.sound ?? null,
        theme.priority,
        theme.enabled ? 1 : 0,
        JSON.stringify(theme.rules),
      );
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

  cursor(): Cursor {
    const raw = this.#value("cursor");
    return raw ? (JSON.parse(raw) as Cursor) : {};
  }

  setCursor(cursor: Cursor): void {
    this.#setValue("cursor", JSON.stringify(cursor));
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

  /** The asset name we last successfully set, for skip-if-unchanged. */
  lastAppliedAsset(): string | null {
    return this.#value("lastAppliedAsset");
  }

  setLastAppliedAsset(name: string): void {
    this.#setValue("lastAppliedAsset", name);
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

  // --------------------------------------------------------------- applies

  recordApply(entry: {
    at: string;
    themeId: string | null;
    assetName: string | null;
    reason: string;
    outcome: Outcome;
  }): void {
    this.#db
      .prepare("INSERT INTO applies (at, theme_id, asset_name, reason, outcome) VALUES (?, ?, ?, ?, ?)")
      .run(entry.at, entry.themeId, entry.assetName, entry.reason, entry.outcome);
  }

  recentApplies(limit = 20): Array<{
    at: string;
    themeId: string | null;
    assetName: string | null;
    reason: string;
    outcome: string;
  }> {
    const rows = this.#db
      .prepare("SELECT * FROM applies ORDER BY at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      at: String(row.at),
      themeId: row.theme_id == null ? null : String(row.theme_id),
      assetName: row.asset_name == null ? null : String(row.asset_name),
      reason: String(row.reason),
      outcome: String(row.outcome),
    }));
  }
}
