import type { ApplyResult, Notifier } from "./apply.ts";

/**
 * Telling you when something happened, or should have and didn't.
 *
 * A single configurable HTTP call rather than a provider library, because
 * that covers everything worth covering with no dependency and no list to
 * maintain: Uptime Kuma push URLs are a GET; ntfy, Discord, Slack, Gotify and
 * Home Assistant webhooks are a POST with a JSON body.
 *
 * `{status}` and `{msg}` in the URL are substituted and encoded, which is
 * what makes Uptime Kuma work without special-casing it.
 */
export interface NotifyOptions {
  url: string;
  method?: string;
  /** Send a JSON body describing the apply. Off for GET-style pings. */
  sendBody?: boolean;
}

export class HttpNotifier implements Notifier {
  readonly #options: NotifyOptions;

  constructor(options: NotifyOptions) {
    this.#options = options;
  }

  async send(event: ApplyResult): Promise<void> {
    await this.post(statusOf(event), summarise(event), event);
  }

  /**
   * Also used for the stall alarm, which has no ApplyResult behind it - the
   * whole point is that no apply happened.
   */
  async post(status: "up" | "down", message: string, event?: ApplyResult): Promise<void> {
    const method = (this.#options.method ?? "POST").toUpperCase();
    const url = this.#options.url
      .replaceAll("{status}", encodeURIComponent(status))
      .replaceAll("{msg}", encodeURIComponent(message));

    const sendBody = this.#options.sendBody ?? method !== "GET";
    await fetch(url, {
      method,
      ...(sendBody
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status, message, ...event }),
          }
        : {}),
      signal: AbortSignal.timeout(15_000),
    });
  }
}

/**
 * Only a failed apply is "down".
 *
 * `no-theme` deliberately is not: having nothing scheduled right now is a
 * configuration choice, not a fault, and a monitor that goes red every time
 * a season ends is a monitor people mute.
 */
function statusOf(event: ApplyResult): "up" | "down" {
  return event.outcome === "failed" ? "down" : "up";
}

function summarise(event: ApplyResult): string {
  const parts = [event.reason];
  if (event.sound === "failed") parts.push("ringtone failed");
  if (event.drift) parts.push(`drift: device had ${event.drift.found}`);
  return parts.join("; ");
}
