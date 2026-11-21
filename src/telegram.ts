import https from "node:https";
import type { ApplyResult, AssetSource, Notifier } from "./apply.ts";
import type { Store } from "./store/db.ts";

/**
 * Telling someone on their phone what the doorbell did, without them having
 * to open the dashboard to find out.
 *
 * Three parts, split so the interesting one is testable:
 *
 *   - alertsFor: pure. An apply result and "was this door already failing"
 *     in, the messages worth sending out. This is where the noise control
 *     lives - the scheduler retries a failure every five minutes, and a
 *     phone that buzzes every five minutes is a phone that gets muted.
 *   - TelegramNotifier: reads the settings fresh each time, so the UI takes
 *     effect without a restart, and sends what alertsFor chose.
 *   - The client: three Bot API calls over node:https.
 */

export type AlertKind =
  | "changed"
  | "failed"
  | "recovered"
  | "refused"
  | "sound"
  | "drift"
  | "noTheme"
  | "stalled";

/** Every kind, in the order the settings page lists them. */
export const ALERT_KINDS: Array<{ key: AlertKind; label: string; description: string; default: boolean }> = [
  { key: "changed", label: "New theme", description: "Each day's new image goes up, with the GIF and its ring sound", default: true },
  { key: "failed", label: "Something failed", description: "A doorbell could not be updated - once, not on every retry", default: true },
  { key: "recovered", label: "Working again", description: "The first success after a failure", default: true },
  { key: "refused", label: "Image refused", description: "Protect would not take a GIF, so it was set aside", default: true },
  { key: "sound", label: "Ring sound problem", description: "The image went up but the ring sound could not be set", default: true },
  { key: "drift", label: "Changed outside Doorman", description: "The doorbell was showing something Doorman did not put there", default: true },
  { key: "stalled", label: "Schedule stalled", description: "Nothing has been applied for over a day", default: true },
  { key: "noTheme", label: "Nothing to show", description: "No theme was eligible, so the doorbell was left alone", default: false },
];

export interface Alert {
  kind: AlertKind;
  /** Telegram HTML. */
  text: string;
  /** Send the theme's GIF with it, the text as its caption. */
  withImage?: boolean;
}

const esc = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The detail after the scheduler's "(priority 0, 3 of 5 ...)" preamble. */
const detail = (event: ApplyResult) => event.error ?? event.reason.split("; ").slice(1).join("; ");

/**
 * Which messages an apply is worth.
 *
 * `failing` is whether this doorbell's last run failed; the returned
 * `failing` is what to remember for next time. Only the first failure of a
 * streak is news - the five-minute retries are not - and the streak ending
 * is news too.
 */
export function alertsFor(
  event: ApplyResult,
  failing: boolean,
  names: { device: string; sound?: string | null },
): { alerts: Alert[]; failing: boolean } {
  const door = `<b>${esc(names.device)}</b>`;
  const theme = `<b>${esc(event.themeName ?? event.themeId ?? "a theme")}</b>`;

  // A refusal is about the image, not the door: the scheduler has already
  // moved on to another theme in the same run, so this is not the start of
  // a failure streak.
  if (event.refused) {
    return {
      failing,
      alerts: [{
        kind: "refused",
        text: `🚫 Protect refused ${theme}'s image for ${door}.\n${esc(detail(event))}\n\nIt is set aside and another theme is used instead.`,
      }],
    };
  }

  if (event.outcome === "failed") {
    return {
      failing: true,
      alerts: failing
        ? []
        : [{
            kind: "failed",
            text: `⚠️ ${door} could not be updated.\n${esc(detail(event))}\n\nDoorman keeps retrying; you will hear when it works again.`,
          }],
    };
  }

  // Dry runs are someone at the dashboard, not news.
  if (event.outcome === "dry-run") return { failing, alerts: [] };

  const alerts: Alert[] = [];
  if (failing) alerts.push({ kind: "recovered", text: `✅ ${door} is working again.` });

  if (event.outcome === "no-theme") {
    alerts.push({ kind: "noTheme", text: `💤 No theme is eligible for ${door} today, so it was left as it is.` });
  }

  if (event.image === "applied") {
    const sound =
      names.sound ? `🔔 ${esc(names.sound)}`
      : event.ringtoneId ? "🔔 the default ring sound"
      : "🔕 ring sound left as it was";
    const stoodIn = event.reason.match(/instead of (.+), which Protect refused/);
    alerts.push({
      kind: "changed",
      withImage: true,
      text:
        `🚪 ${door} is now showing ${theme}\n${sound}` +
        (stoodIn ? `\n<i>Standing in for ${esc(stoodIn[1]!)}, which Protect refused</i>` : ""),
    });
  }

  if (event.sound === "failed") {
    alerts.push({ kind: "sound", text: `🔇 ${door}: the ring sound could not be set.\n${esc(detail(event))}` });
  }

  if (event.drift) {
    alerts.push({
      kind: "drift",
      text: `👀 ${door} was showing something Doorman did not put there - changed in Protect, or the doorbell restarted.`,
    });
  }

  return { failing: false, alerts };
}

// ------------------------------------------------------------- settings

export interface TelegramSettings {
  enabled: boolean;
  token: string | null;
  chatId: string | null;
  events: Record<AlertKind, boolean>;
  /** Where the UI lives, for an "Open Doorman" link. Taken from the browser that saved the settings. */
  baseUrl: string | null;
  /** Which of token and chat came from the environment rather than the UI. */
  tokenSource: "settings" | "environment" | null;
  chatSource: "settings" | "environment" | null;
}

/**
 * The UI's settings over the environment's, like every other setting.
 * The token is stored on its own key so nothing that returns the rest can
 * hand it back by accident.
 */
export function telegramSettings(store: Store, env: NodeJS.ProcessEnv = process.env): TelegramSettings {
  let saved: Partial<{ enabled: boolean; chatId: string; events: Partial<Record<AlertKind, boolean>>; baseUrl: string }> = {};
  try {
    saved = JSON.parse(store.setting("telegram") ?? "{}");
  } catch {
    // A hand-edited row is not worth refusing to start over.
  }
  const storedToken = store.setting("telegram.token");
  const token = storedToken ?? env.TELEGRAM_BOT_TOKEN ?? null;
  const chatId = saved.chatId ?? env.TELEGRAM_CHAT_ID ?? null;
  const events = Object.fromEntries(
    ALERT_KINDS.map((k) => [k.key, saved.events?.[k.key] ?? k.default]),
  ) as Record<AlertKind, boolean>;
  return {
    // Supplying both through the environment is a choice to have it on.
    enabled: saved.enabled ?? Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    token,
    chatId,
    events,
    baseUrl: saved.baseUrl ?? null,
    tokenSource: storedToken ? "settings" : env.TELEGRAM_BOT_TOKEN ? "environment" : null,
    chatSource: saved.chatId ? "settings" : env.TELEGRAM_CHAT_ID ? "environment" : null,
  };
}

export function saveTelegramSettings(
  store: Store,
  patch: { enabled?: boolean; chatId?: string | null; events?: Partial<Record<AlertKind, boolean>>; baseUrl?: string | null },
): void {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(store.setting("telegram") ?? "{}");
  } catch {
    // Start again from the patch.
  }
  if (patch.enabled !== undefined) saved.enabled = patch.enabled;
  if (patch.chatId !== undefined) saved.chatId = patch.chatId || undefined;
  if (patch.baseUrl !== undefined) saved.baseUrl = patch.baseUrl || undefined;
  if (patch.events) saved.events = { ...(saved.events as object), ...patch.events };
  store.setSetting("telegram", JSON.stringify(saved));
}

// --------------------------------------------------------------- client

/** The three Bot API calls Doorman makes. A port, so tests need no network. */
export interface TelegramApi {
  sendMessage(chatId: string, html: string): Promise<void>;
  sendAnimation(chatId: string, file: { bytes: Uint8Array; filename: string }, caption: string): Promise<void>;
  /** Chats that have messaged the bot recently, for "find my chat". */
  recentChats(): Promise<Array<{ id: string; name: string; type: string }>>;
}

export class TelegramError extends Error {}

/**
 * Over node:https rather than fetch, for one reason: this process may have
 * set NODE_TLS_REJECT_UNAUTHORIZED=0 to reach a UniFi console's self-signed
 * certificate, and fetch would inherit that and send the bot token over an
 * unverified connection. An explicit rejectUnauthorized wins over the
 * environment, so Telegram's certificate is always checked.
 */
export function createTelegramClient(token: string): TelegramApi {
  async function call<T>(method: string, body: { json?: unknown; form?: FormData }): Promise<T> {
    const encoded = body.form ? new Response(body.form) : null;
    const payload = encoded
      ? Buffer.from(await encoded.arrayBuffer())
      : Buffer.from(JSON.stringify(body.json ?? {}));
    const contentType = encoded ? encoded.headers.get("content-type")! : "application/json";

    const text = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          host: "api.telegram.org",
          path: `/bot${token}/${method}`,
          method: "POST",
          rejectUnauthorized: true,
          timeout: 30_000,
          headers: { "Content-Type": contentType, "Content-Length": payload.length },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        },
      );
      req.on("timeout", () => req.destroy(new TelegramError("Telegram did not answer in time")));
      // Never let the URL - which holds the token - into an error message.
      req.on("error", (error) => reject(new TelegramError(`Could not reach Telegram: ${error.message.replaceAll(token, "…")}`)));
      req.end(payload);
    });

    let parsed: { ok?: boolean; result?: T; description?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TelegramError("Telegram sent back something that was not JSON");
    }
    if (!parsed.ok) throw new TelegramError(`Telegram said: ${parsed.description ?? "unknown error"}`);
    return parsed.result as T;
  }

  return {
    async sendMessage(chatId, html) {
      await call("sendMessage", {
        json: { chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      });
    },
    async sendAnimation(chatId, file, caption) {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", caption);
      form.append("parse_mode", "HTML");
      form.append("animation", new Blob([file.bytes], { type: "image/gif" }), file.filename);
      await call("sendAnimation", { form });
    },
    async recentChats() {
      type Chat = { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string };
      const updates = await call<Array<{ message?: { chat: Chat }; my_chat_member?: { chat: Chat }; channel_post?: { chat: Chat } }>>(
        "getUpdates",
        { json: { allowed_updates: ["message", "my_chat_member", "channel_post"] } },
      );
      const chats = new Map<string, { id: string; name: string; type: string }>();
      for (const update of updates) {
        const chat = update.message?.chat ?? update.my_chat_member?.chat ?? update.channel_post?.chat;
        if (!chat) continue;
        const name =
          chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id));
        chats.set(String(chat.id), { id: String(chat.id), name, type: chat.type });
      }
      return [...chats.values()];
    },
  };
}

// ------------------------------------------------------------- notifier

export class TelegramNotifier implements Notifier {
  readonly #store: Store;
  readonly #source: AssetSource;
  readonly #client: (token: string) => TelegramApi;
  readonly #log: (message: string) => void;

  constructor(options: {
    store: Store;
    source: AssetSource;
    client?: (token: string) => TelegramApi;
    log?: (message: string) => void;
  }) {
    this.#store = options.store;
    this.#source = options.source;
    this.#client = options.client ?? createTelegramClient;
    this.#log = options.log ?? (() => {});
  }

  async send(event: ApplyResult): Promise<void> {
    const deviceId = event.deviceId ?? "default";
    const key = `telegram.failing.${deviceId}`;
    const theme = event.themeId ? this.#store.themes().find((t) => t.id === event.themeId) : undefined;
    const { alerts, failing } = alertsFor(event, this.#store.setting(key) === "1", {
      device: event.deviceName ?? "The doorbell",
      sound: theme?.soundName,
    });
    if (failing) this.#store.setSetting(key, "1");
    else this.#store.clearSetting(key);

    for (const alert of alerts) {
      await this.#deliver(alert, alert.withImage && theme ? theme.image : undefined);
    }
  }

  /** A roll that threw before apply could even report, counted as a failure. */
  async rollFailed(deviceId: string, deviceName: string, message: string): Promise<void> {
    await this.send({
      outcome: "failed",
      reason: message,
      error: message,
      deviceId,
      deviceName,
      themeId: null,
      themeName: null,
      assetName: null,
    });
  }

  /** Once per stall: keyed by the last apply, so the hourly check does not repeat it. */
  async stalled(hours: number, lastAt: string): Promise<void> {
    if (this.#store.setting("telegram.stalledSince") === lastAt) return;
    this.#store.setSetting("telegram.stalledSince", lastAt);
    await this.#deliver({
      kind: "stalled",
      text: `⏰ Nothing has been applied for ${hours} hours. The schedule may be stuck.`,
    });
  }

  async #deliver(alert: Alert, imageHash?: string): Promise<void> {
    const settings = telegramSettings(this.#store);
    if (!settings.enabled || !settings.token || !settings.chatId || !settings.events[alert.kind]) return;
    const client = this.#client(settings.token);
    const text = settings.baseUrl ? `${alert.text}\n\n<a href="${esc(settings.baseUrl)}">Open Doorman</a>` : alert.text;
    try {
      const file = imageHash ? await this.#source.read(imageHash).catch(() => null) : null;
      if (file) {
        try {
          await client.sendAnimation(settings.chatId, file, text);
          return;
        } catch (error) {
          // The words matter more than the picture; fall through and send
          // them on their own.
          this.#log(`telegram: could not send the GIF, sending text instead: ${(error as Error).message}`);
        }
      }
      await client.sendMessage(settings.chatId, text);
    } catch (error) {
      this.#log(`telegram: ${(error as Error).message}`);
    }
  }
}
