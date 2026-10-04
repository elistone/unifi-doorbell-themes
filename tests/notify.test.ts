import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HttpNotifier } from "../src/notify.ts";
import type { ApplyResult } from "../src/apply.ts";

/** Captures what would have been sent, instead of sending it. */
function capture() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const applied: ApplyResult = {
  outcome: "applied", reason: "christmas (priority 10)",
  themeId: "xmas", themeName: "Christmas", assetName: "abc.png",
};

describe("notifications", () => {
  it("substitutes status and message into the URL, for Uptime Kuma", async () => {
    const { calls, restore } = capture();
    await new HttpNotifier({
      url: "https://kuma/api/push/abc?status={status}&msg={msg}",
      method: "GET",
    }).send(applied);
    restore();
    assert.match(calls[0]!.url, /status=up/);
    assert.match(calls[0]!.url, /msg=christmas%20\(priority%2010\)/);
    assert.equal(calls[0]!.body, undefined, "a GET ping should carry no body");
  });

  it("posts a JSON body by default", async () => {
    const { calls, restore } = capture();
    await new HttpNotifier({ url: "https://ntfy/topic" }).send(applied);
    restore();
    assert.equal(calls[0]!.method, "POST");
    assert.equal((calls[0]!.body as Record<string, unknown>).themeName, "Christmas");
  });

  it("reports a failed apply as down", async () => {
    const { calls, restore } = capture();
    await new HttpNotifier({ url: "https://x/{status}" }).send({ ...applied, outcome: "failed" });
    restore();
    assert.match(calls[0]!.url, /\/down$/);
  });

  it("does not report 'nothing scheduled' as down", async () => {
    // A monitor that goes red every time a season ends is a monitor people
    // mute, and then it is worth nothing when something real breaks.
    const { calls, restore } = capture();
    await new HttpNotifier({ url: "https://x/{status}" }).send({ ...applied, outcome: "no-theme" });
    restore();
    assert.match(calls[0]!.url, /\/up$/);
  });

  it("mentions a failed ringtone even when the image succeeded", async () => {
    const { calls, restore } = capture();
    await new HttpNotifier({ url: "https://x?m={msg}" }).send({ ...applied, sound: "failed" });
    restore();
    assert.match(decodeURIComponent(calls[0]!.url), /ringtone failed/);
  });
});
