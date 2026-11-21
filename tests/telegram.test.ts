import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { ApplyResult, AssetSource } from "../src/apply.ts";
import { Store } from "../src/store/db.ts";
import { TelegramNotifier, alertsFor, saveTelegramSettings, telegramSettings } from "../src/telegram.ts";
import type { TelegramApi } from "../src/telegram.ts";

/**
 * What reaches someone's phone. The point of most of this is restraint:
 * the scheduler retries a failure every five minutes, and a notifier that
 * repeats each one gets muted - after which it tells nobody anything.
 */

const result = (overrides: Partial<ApplyResult> = {}): ApplyResult => ({
  outcome: "applied",
  reason: "Stitch (priority 0, 1 of 3 candidates, random seeded 2026-11-21)",
  themeId: "stitch",
  themeName: "Stitch",
  assetName: "asset-1",
  deviceId: "front",
  deviceName: "Front Doorbell",
  image: "applied",
  ...overrides,
});

const names = { device: "Front Doorbell", sound: "Ohana" };
const kinds = (out: ReturnType<typeof alertsFor>) => out.alerts.map((a) => a.kind);

describe("alertsFor", () => {
  it("announces a new image with its GIF and ring sound", () => {
    const out = alertsFor(result(), false, names);
    assert.deepEqual(kinds(out), ["changed"]);
    assert.equal(out.alerts[0]!.withImage, true);
    assert.match(out.alerts[0]!.text, /Front Doorbell<\/b> is now showing <b>Stitch<\/b>\n🔔 Ohana/);
  });

  it("stays quiet when the doorbell was already right", () => {
    assert.deepEqual(kinds(alertsFor(result({ outcome: "unchanged", image: "unchanged" }), false, names)), []);
  });

  it("reports the first failure of a streak, and none of the retries", () => {
    const failed = result({ outcome: "failed", image: undefined, error: "POST /files/animations failed with 500" });
    const first = alertsFor(failed, false, names);
    assert.deepEqual(kinds(first), ["failed"]);
    assert.match(first.alerts[0]!.text, /failed with 500/);
    assert.equal(first.failing, true);

    const retry = alertsFor(failed, true, names);
    assert.deepEqual(kinds(retry), []);
    assert.equal(retry.failing, true);
  });

  it("says when it is working again", () => {
    const out = alertsFor(result(), true, names);
    assert.deepEqual(kinds(out), ["recovered", "changed"]);
    assert.equal(out.failing, false);
  });

  it("treats a refused image as its own news, not the start of a failure streak", () => {
    const out = alertsFor(result({ outcome: "failed", refused: true, error: "Protect could not process big.gif" }), false, names);
    assert.deepEqual(kinds(out), ["refused"]);
    assert.equal(out.failing, false);
  });

  it("mentions what a stand-in replaced", () => {
    const out = alertsFor(result({ reason: "Stitch (...); instead of Severance, which Protect refused" }), false, names);
    assert.match(out.alerts[0]!.text, /Standing in for Severance/);
  });

  it("reports a ring sound failure and drift alongside the change", () => {
    const out = alertsFor(result({ sound: "failed", drift: { expected: "a", found: "b" } }), false, names);
    assert.deepEqual(kinds(out), ["changed", "sound", "drift"]);
  });

  it("escapes names, since Telegram reads the text as HTML", () => {
    const out = alertsFor(result({ themeName: "<Tom & Jerry>" }), false, names);
    assert.match(out.alerts[0]!.text, /&lt;Tom &amp; Jerry&gt;/);
  });

  it("ignores dry runs", () => {
    assert.deepEqual(kinds(alertsFor(result({ outcome: "dry-run", image: undefined }), false, names)), []);
  });
});

class FakeTelegram implements TelegramApi {
  sent: Array<{ chatId: string; text: string; gif?: string }> = [];
  failGif = false;
  async sendMessage(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }
  async sendAnimation(chatId: string, file: { filename: string }, text: string) {
    if (this.failGif) throw new Error("too big");
    this.sent.push({ chatId, text, gif: file.filename });
  }
  async recentChats() {
    return [];
  }
}

const source = {
  read: async (hash: string) => ({ bytes: new Uint8Array([1]), filename: `${hash}.gif`, mimeType: "image/gif" }),
} as unknown as AssetSource;

describe("TelegramNotifier", () => {
  let store: Store;
  let telegram: FakeTelegram;
  let notifier: TelegramNotifier;

  beforeEach(() => {
    store = new Store(":memory:");
    telegram = new FakeTelegram();
    notifier = new TelegramNotifier({ store, source, client: () => telegram });
    store.upsertTheme({ id: "stitch", name: "Stitch", image: "hash-stitch", priority: 0, enabled: true, rules: [{}], devices: [] });
    store.setSetting("telegram.token", "123:abc");
    saveTelegramSettings(store, { enabled: true, chatId: "42" });
  });

  it("sends nothing until it is switched on", async () => {
    saveTelegramSettings(store, { enabled: false });
    await notifier.send(result());
    assert.equal(telegram.sent.length, 0);
  });

  it("sends the GIF with the change", async () => {
    await notifier.send(result());
    assert.deepEqual(telegram.sent.map((m) => [m.chatId, m.gif]), [["42", "hash-stitch.gif"]]);
  });

  it("falls back to words when the GIF will not send", async () => {
    telegram.failGif = true;
    await notifier.send(result());
    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0]!.gif, undefined);
  });

  it("respects a kind switched off", async () => {
    saveTelegramSettings(store, { events: { changed: false } });
    await notifier.send(result());
    assert.equal(telegram.sent.length, 0);
  });

  it("remembers a failure streak across runs, so retries stay quiet", async () => {
    const failed = result({ outcome: "failed", image: undefined, error: "offline" });
    await notifier.send(failed);
    await notifier.send(failed);
    await notifier.send(failed);
    assert.equal(telegram.sent.length, 1);
    await notifier.send(result({ outcome: "unchanged", image: "unchanged" }));
    assert.equal(telegram.sent.length, 2);
    assert.match(telegram.sent[1]!.text, /working again/);
  });

  it("reports a stall once, not every hour", async () => {
    await notifier.stalled(26, "2026-11-20T04:00:00Z");
    await notifier.stalled(27, "2026-11-20T04:00:00Z");
    assert.equal(telegram.sent.length, 1);
  });

  it("links back to the UI when it knows where that is", async () => {
    saveTelegramSettings(store, { baseUrl: "https://doorbell.example" });
    await notifier.send(result());
    assert.match(telegram.sent[0]!.text, /href="https:\/\/doorbell\.example">Open Doorman/);
  });
});

describe("telegramSettings", () => {
  it("falls back to the environment, and is on when both are supplied there", () => {
    const store = new Store(":memory:");
    const settings = telegramSettings(store, { TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "7" });
    assert.equal(settings.enabled, true);
    assert.equal(settings.tokenSource, "environment");
    assert.equal(settings.chatId, "7");
  });

  it("lets the UI override the environment, including switching it off", () => {
    const store = new Store(":memory:");
    saveTelegramSettings(store, { enabled: false, chatId: "99" });
    const settings = telegramSettings(store, { TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_CHAT_ID: "7" });
    assert.equal(settings.enabled, false);
    assert.equal(settings.chatId, "99");
    assert.equal(settings.chatSource, "settings");
  });

  it("defaults each kind sensibly", () => {
    const { events } = telegramSettings(new Store(":memory:"), {});
    assert.equal(events.failed, true);
    assert.equal(events.noTheme, false);
  });
});
