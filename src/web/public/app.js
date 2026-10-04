/**
 * Doorman UI.
 *
 * Plain modules, no framework and no build step - the same rule the server
 * follows. The page is six lists and one form; everything here is fetch,
 * template strings and one render function per tab.
 */

// ------------------------------------------------------------------ utils

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** Escape anything that came from the user or the device before it is HTML. */
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const kb = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "bad" ? 9000 : 4500);
}

/**
 * Every call goes through here so an error becomes a toast exactly once.
 *
 * The server puts a human-readable sentence in `error`; surfacing that
 * verbatim is the difference between "something went wrong" and "that GIF is
 * still used by a theme".
 */
/**
 * Requests in flight.
 *
 * A counter rather than a boolean: two overlapping calls would otherwise
 * have the first to finish hide the bar while the second was still running.
 */
let inFlight = 0;

function trackRequest(delta) {
  inFlight = Math.max(0, inFlight + delta);
  const bar = $("#progress");
  if (bar) bar.hidden = inFlight === 0;
}

async function api(path, options = {}) {
  trackRequest(1);
  let response;
  let text;
  try {
    response = await fetch(path, options);
    text = await response.text();
  } finally {
    // In `finally`, so a network error does not leave the bar spinning
    // forever with nothing behind it.
    trackRequest(-1);
  }
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text.slice(0, 200) || `${response.status} ${response.statusText}`);
  }
  if (response.status === 401 && !path.startsWith("/api/login")) {
    // The session went away - expired, swept, or revoked by a password
    // change elsewhere. Show the gate rather than a wall of failed requests.
    showGate();
    throw new Error("Your session ended. Sign in again.");
  }
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  return body;
}

/**
 * Disable a button and put a spinner in it for the duration.
 *
 * Rethrows, so the caller decides how to report the failure - the gate
 * forms show it in the card, everything else toasts it.
 */
async function busyWhile(button, fn) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spin"></span> ${original}`;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/** busyWhile, reporting any failure as a toast. */
async function withBusy(button, fn) {
  try {
    return await busyWhile(button, fn);
  } catch (error) {
    toast(error.message, "bad");
  }
}

/** The submit button of a form, for busyWhile. */
const submitter = (form) => form.querySelector('button[type="submit"]');

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeRule(rule) {
  const parts = [];
  if (rule.dateWindow) parts.push(`${rule.dateWindow.from} → ${rule.dateWindow.to}`);
  if (rule.weekdays?.length) parts.push(rule.weekdays.map((d) => DAY_NAMES[d]).join(", "));
  if (rule.timeOfDay) parts.push(`${rule.timeOfDay.from}–${rule.timeOfDay.to}`);
  return parts.join(" · ") || "always";
}

const VERDICT = {
  safe: ["ok", "fits"],
  borderline: ["warn", "borderline"],
  "likely-fails": ["bad", "too big"],
};

// -------------------------------------------------------------- skeletons

const skLines = (n = 2) => Array.from({ length: n }, () => '<div class="sk sk-line"></div>').join("");

const skeletonRows = (n) =>
  Array.from(
    { length: n },
    () => `<div class="sk-row"><div class="sk sk-thumb"></div><div>${skLines(2)}</div><div class="sk sk-line"></div></div>`,
  ).join("");

const skeletonTiles = (n) =>
  Array.from(
    { length: n },
    () => `<div class="sk-tile"><div class="sk sk-img"></div><div class="sk-body">${skLines(2)}</div></div>`,
  ).join("");

// Wrapped in the same month/grid shell the real calendar uses, or the
// placeholder is a flat column that collapses into a grid when data lands.
const skeletonDays = (n) =>
  `<section class="month"><div class="sk sk-line" style="width:140px;height:15px;margin-bottom:10px"></div>
    <div class="cal">${Array.from({ length: n }, () => '<div class="sk sk-day"></div>').join("")}</div>
  </section>`;

/**
 * Stops an older response for a tab overwriting a newer one.
 *
 * Keyed per tab, which is the case that actually matters: leaving Images
 * and coming back starts a second request while the first is still in
 * flight, and Images runs ffprobe over the whole library so the two can
 * easily land out of order. Each render takes a ticket and discards its
 * result if another render of the same tab has started since.
 *
 * A render finishing while a DIFFERENT tab is showing is left alone - it
 * paints into a hidden element and that tab re-renders when it is next
 * opened, so there is nothing to protect against.
 */
const renderTickets = {};
function ticket(name) {
  const value = (renderTickets[name] ?? 0) + 1;
  renderTickets[name] = value;
  return () => renderTickets[name] === value;
}

// ------------------------------------------------------------------ state

let state = null;
let themes = [];
let media = [];
let sounds = { ringtones: [], limit: 12 };

// ------------------------------------------------------------------- tabs

const TABS = ["now", "themes", "media", "sounds", "calendar", "history", "settings"];

function show(tab) {
  if (!TABS.includes(tab)) return;
  for (const name of TABS) $(`#tab-${name}`).hidden = name !== tab;
  for (const button of $$("nav button")) {
    if (button.dataset.tab === tab) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  location.hash = tab;

  // Back to the top. Arriving at a new tab already scrolled halfway down
  // the previous one is disorienting, and the calendar and image grid are
  // both long enough for it to happen constantly.
  window.scrollTo({ top: 0, behavior: "instant" });

  // A renderer that throws would otherwise leave its skeleton shimmering
  // forever, which reads as "still loading" rather than "this failed".
  RENDERERS[tab]?.().catch((error) => {
    toast(error.message, "bad");
    const target = TAB_CONTENT[tab];
    if (target) {
      $(target).innerHTML = emptyState("Could not load this", error.message);
    }
  });
}

/** Where each tab's content goes, for the failure case above. */
const TAB_CONTENT = {
  themes: "#themes-list",
  media: "#media-grid",
  sounds: "#sounds-list",
  calendar: "#calendar",
  history: "#history",
  now: "#now-panel",
  settings: "#devices-list",
};

// [data-tab] rather than every button in the nav: the account button lives
// there too, and without the filter clicking it called show(undefined),
// which hid every section and left a blank page behind the dialog.
$$("nav button[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));

// -------------------------------------------------------------- Now panel

async function renderNow() {
  const fresh = ticket("now");
  $("#now-panel").innerHTML = `<div class="card now">
    <div class="sk" style="aspect-ratio:1;border-radius:var(--radius)"></div>
    <div>${skLines(5)}</div></div>`;

  state = await api("/api/state");
  if (!fresh()) return;

  $("#version").textContent = `v${state.version}`;
  if (state.username) $("#who").textContent = state.username;

  if (state.doorbells.length === 0) {
    $("#now-panel").innerHTML = emptyState(
      "No doorbell configured",
      "Add one in Settings and Doorman will start scheduling it.",
    );
  } else {
    $("#now-panel").innerHTML = state.doorbells.map(doorbellCard).join("");
  }

  $("#counts").innerHTML = `
    <dt>Doorbells</dt><dd>${state.counts.devices}</dd>
    <dt>Themes</dt><dd>${state.counts.themes}</dd>
    <dt>Images</dt><dd>${state.counts.media}</dd>
    <dt>Ring sounds</dt><dd>${state.counts.ringtones} of ${state.counts.ringtoneLimit}</dd>`;

  // Per-doorbell apply, wired after render.
  $$("[data-apply-device]").forEach((b) =>
    b.addEventListener("click", (e) =>
      withBusy(e.target, async () => {
        const { results } = await api(
          `/api/apply?device=${encodeURIComponent(b.dataset.applyDevice)}`,
          { method: "POST" },
        );
        reportApplies(results);
        await renderNow();
      }),
    ),
  );
}

/** One doorbell: what it is showing, what it will show, and why. */
function doorbellCard(d) {
  const image = d.showing.filename
    ? `<img src="/media/${encodeURIComponent(d.showing.filename)}" alt="">`
    : `<div class="empty">${d.showing.assetName ? "Showing something not in this library" : "Nothing set"}</div>`;

  const sound = !state.soundEnabled
    ? `<span class="badge mute">no admin credentials</span>`
    : d.ringtone.dangling
      ? `<span class="badge bad">points at a ring sound that no longer exists</span>`
      : esc(d.ringtone.name ?? "—");

  const last = d.last;
  const outcome = last
    ? `<span class="badge ${last.outcome === "failed" ? "bad" : last.outcome === "no-theme" ? "warn" : "ok"}">${esc(last.outcome)}</span>`
    : `<span class="badge mute">never run</span>`;

  return `
    <div class="card now" style="margin-bottom:14px">
      <div class="frame">${image}</div>
      <div>
        <div class="row" style="margin-bottom:10px">
          <strong style="font-size:16px">${esc(d.name)}</strong>
          ${d.enabled ? "" : `<span class="badge mute">disabled</span>`}
          <div class="spacer"></div>
          <button class="btn small" data-apply-device="${esc(d.id)}">Apply now</button>
        </div>
        <dl class="kv">
          <dt>Image</dt><dd>${esc(d.showing.filename ?? d.showing.assetName ?? "nothing")}</dd>
          <dt>Sound</dt><dd>${sound}</dd>
          <dt>Today</dt><dd>${esc(d.today.themeName ?? "none eligible")}</dd>
          <dt>Because</dt><dd class="mono">${esc(d.today.reason)}</dd>
          <dt>Last run</dt><dd>${outcome} <span style="color:var(--text-dim);font-weight:400">${last ? esc(new Date(last.at).toLocaleString()) : ""}</span></dd>
          <dt>Themes</dt><dd>${d.themeCount} eligible to this doorbell</dd>
        </dl>
      </div>
    </div>`;
}

/** Summarise an apply that may have covered several doorbells. */
function reportApplies(results) {
  for (const r of results) {
    toast(
      `${r.deviceName ? `${r.deviceName}: ` : ""}${r.outcome} — ${r.reason}`,
      r.outcome === "failed" ? "bad" : "ok",
    );
  }
}

const emptyState = (title, body) =>
  `<div class="empty-state"><strong>${esc(title)}</strong>${esc(body)}</div>`;

/**
 * Swap a poster frame for the real GIF on hover.
 *
 * Delegated from the document, so it keeps working across re-renders
 * without rewiring, and the animation is only ever fetched for the tile
 * someone is actually looking at. Loading all of them is what made this
 * tab pull 47MB in the first place.
 */
document.addEventListener(
  "mouseover",
  (event) => {
    const img = event.target.closest?.("img[data-animate]");
    if (!img || img.dataset.animating) return;
    img.dataset.animating = "1";
    img.src = img.dataset.animate;
  },
  // Capture, because mouseover does not bubble usefully from every nested
  // element otherwise.
  true,
);

$("#apply-now").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const { results } = await api("/api/apply", { method: "POST" });
    reportApplies(results);
    await renderNow();
  }),
);

$("#dry-run").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const { results } = await api("/api/apply?dryRun=true", { method: "POST" });
    for (const r of results) {
      toast(`${r.deviceName ? `${r.deviceName}: ` : ""}${r.outcome} — ${r.reason}`);
    }
  }),
);

// ---------------------------------------------------------------- settings

let devices = [];

async function saveSetting(patch, note) {
  try {
    await api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    toast(note, "ok");
  } catch (error) {
    toast(error.message, "bad");
    await renderSettings();
  }
}

async function renderSettings() {
  const fresh = ticket("settings");
  $("#devices-list").innerHTML = skeletonRows(2);

  const [list, settings] = await Promise.all([api("/api/devices"), api("/api/settings")]);
  await loadSounds();
  if (!fresh()) return;
  devices = list;
  const themeList = await api("/api/themes");

  $("#devices-list").innerHTML =
    devices.length === 0
      ? emptyState("No doorbells yet", "Add one and Doorman will start scheduling it.")
      : devices
          .map((d) => {
            const scoped = themeList.filter((t) => t.devices.includes(d.id)).length;
            const all = themeList.filter((t) => t.devices.length === 0).length;
            return `
            <div class="theme ${d.enabled ? "" : "off"}">
              <div class="noimg" style="font-size:20px">🔔</div>
              <div>
                <div class="name">
                  ${esc(d.name)}
                  ${d.enabled ? "" : `<span class="badge mute">disabled</span>`}
                </div>
                <div class="meta mono">${esc(d.id)}</div>
                <div class="meta">${all + scoped} themes apply here${scoped > 0 ? ` (${scoped} only here)` : ""}</div>
              </div>
              <div class="row">
                <button class="btn small" data-rename="${esc(d.id)}">Rename</button>
                <button class="btn small" data-toggle-device="${esc(d.id)}">${d.enabled ? "Disable" : "Enable"}</button>
                <button class="btn small danger" data-remove-device="${esc(d.id)}">Remove</button>
              </div>
            </div>`;
          })
          .join("");

  $("#selection").value = settings.selection;

  $("#roll-hour").innerHTML = Array.from({ length: 24 }, (_, h) => {
    const label = `${String(h).padStart(2, "0")}:00`;
    return `<option value="${h}" ${h === settings.rollHour.value ? "selected" : ""}>${label}</option>`;
  }).join("");

  $("#default-ringtone").innerHTML =
    `<option value="">None — leave whatever is set</option>` +
    sounds.ringtones
      .map(
        (r) =>
          `<option value="${esc(r.id)}" ${r.id === settings.defaultRingtone.value ? "selected" : ""}>${esc(r.name)}</option>`,
      )
      .join("");

  // Worth saying out loud: a value coming from the environment is one the
  // deployment chose, and editing it here takes it over for good.
  const fromEnv = [
    settings.rollHour.source === "environment" ? "the change hour" : null,
    settings.defaultRingtone.source === "environment" ? "the default ring sound" : null,
  ].filter(Boolean);
  $("#settings-source").textContent = fromEnv.length
    ? `${fromEnv.join(" and ")} ${fromEnv.length === 1 ? "is" : "are"} currently coming from the deployment's configuration. Changing ${fromEnv.length === 1 ? "it" : "them"} here overrides that.`
    : "";

  wireDeviceButtons();
}

function wireDeviceButtons() {
  $$("[data-rename]").forEach((b) =>
    b.addEventListener("click", async () => {
      const device = devices.find((d) => d.id === b.dataset.rename);
      const name = prompt(`What should this doorbell be called?`, device.name);
      if (name === null || name.trim() === device.name) return;
      try {
        await api("/api/devices", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...device, name: name.trim() }),
        });
        await renderSettings();
      } catch (error) {
        toast(error.message, "bad");
      }
    }),
  );

  $$("[data-toggle-device]").forEach((b) =>
    b.addEventListener("click", (e) =>
      withBusy(e.target, async () => {
        const device = devices.find((d) => d.id === b.dataset.toggleDevice);
        await api("/api/devices", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...device, enabled: !device.enabled }),
        });
        // A disabled doorbell keeps its themes and history; it is just
        // skipped by the scheduler.
        toast(`${device.name} ${device.enabled ? "disabled" : "enabled"}.`, "ok");
        await renderSettings();
      }),
    ),
  );

  $$("[data-remove-device]").forEach((b) =>
    b.addEventListener("click", async () => {
      const device = devices.find((d) => d.id === b.dataset.removeDevice);
      if (
        !confirm(
          `Remove "${device.name}"?\n\nIts themes and history are kept. Any theme that applies ONLY to this doorbell will be disabled rather than spread to the others.`,
        )
      ) {
        return;
      }
      try {
        const result = await api(`/api/devices?id=${encodeURIComponent(device.id)}`, {
          method: "DELETE",
        });
        toast(
          result.themesDisabled > 0
            ? `Removed. ${result.themesDisabled} theme${result.themesDisabled === 1 ? " was" : "s were"} disabled.`
            : "Removed.",
          "ok",
        );
        await renderSettings();
      } catch (error) {
        toast(error.message, "bad");
      }
    }),
  );
}

$("#add-doorbell").addEventListener("click", (e) =>
  withBusy(e.target, async () => {
    const found = await api("/api/devices/discover");
    if (found.length === 0) {
      toast("No other camera on the controller can display a welcome image.", "bad");
      return;
    }
    // A prompt rather than a dialog: this is a once-or-twice-ever action,
    // and the list is short because it excludes doorbells already added.
    const choice = prompt(
      `Cameras that can show a welcome image:\n\n${found
        .map((c, i) => `${i + 1}. ${c.name} (${c.type})`)
        .join("\n")}\n\nWhich number?`,
      "1",
    );
    if (choice === null) return;
    const picked = found[Number(choice) - 1];
    if (!picked) {
      toast("No camera with that number.", "bad");
      return;
    }
    const name = prompt("What should it be called?", picked.name);
    if (name === null || !name.trim()) return;

    await api("/api/devices", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: picked.id, name: name.trim(), enabled: true }),
    });
    toast(`Added ${name.trim()}.`, "ok");
    await renderSettings();
  }),
);

$("#selection").addEventListener("change", (e) =>
  saveSetting({ selection: e.target.value }, `Selection is now ${e.target.value}.`),
);
$("#roll-hour").addEventListener("change", (e) =>
  saveSetting(
    { rollHour: Number(e.target.value) },
    `Themes will change at ${String(e.target.value).padStart(2, "0")}:00.`,
  ),
);
$("#default-ringtone").addEventListener("change", (e) =>
  saveSetting({ defaultRingtone: e.target.value }, "Default ring sound saved."),
);

// --------------------------------------------------------------- dark mode

const THEME_KEY = "doorman-theme";
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  // Private window or blocked storage. The OS preference still applies.
}
$("#toggle-theme").addEventListener("click", () => {
  // Flip the EFFECTIVE theme, not the attribute. With no explicit choice
  // stored the attribute is absent and the OS decides, so reading the
  // attribute alone made the first click set "dark" on an already-dark page
  // and appear to do nothing.
  const current =
    document.documentElement.dataset.theme ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Not worth telling anyone about - the toggle still worked for this view.
  }
});

// ------------------------------------------------------------------ themes

async function renderThemes() {
  const fresh = ticket("themes");
  $("#themes-list").innerHTML = skeletonRows(4);

  [themes, media, devices] = await Promise.all([
    api("/api/themes"),
    api("/api/media"),
    api("/api/devices"),
  ]);
  await loadSounds();
  if (!fresh()) return;

  if (themes.length === 0) {
    $("#themes-list").innerHTML = emptyState(
      "No themes yet",
      "Without one the scheduler leaves the doorbell alone.",
    );
    return;
  }

  const sorted = [...themes].sort(
    (a, b) => b.priority - a.priority || a.name.localeCompare(b.name),
  );

  $("#themes-list").innerHTML = sorted
    .map((theme) => {
      const sound = sounds.ringtones.find((r) => r.id === theme.sound);
      const thumb = theme.filename
        ? `<img loading="lazy" alt="" src="/thumb/${encodeURIComponent(theme.filename)}"
                data-animate="/media/${encodeURIComponent(theme.filename)}">`
        : `<div class="noimg">missing</div>`;
      return `
      <div class="theme ${theme.enabled ? "" : "off"}">
        ${thumb}
        <div>
          <div class="name">
            ${esc(theme.name)}
            ${theme.priority > 0 ? `<span class="badge mute">priority ${theme.priority}</span>` : ""}
            ${theme.enabled ? "" : `<span class="badge mute">disabled</span>`}
            ${theme.missing ? `<span class="badge bad">image missing</span>` : ""}
          </div>
          <div class="meta">
            ${esc(theme.rules.map(describeRule).join("  or  "))}
            · ${sound ? esc(sound.name) : theme.sound ? `<span style="color:var(--bad)">sound missing</span>` : "default sound"}
            ${
              devices.length > 1
                ? ` · ${
                    theme.devices.length === 0
                      ? "all doorbells"
                      : esc(
                          theme.devices
                            .map((id) => devices.find((d) => d.id === id)?.name ?? id)
                            .join(", "),
                        )
                  }`
                : ""
            }
          </div>
        </div>
        <button class="btn small" data-edit="${esc(theme.id)}">Edit</button>
      </div>`;
    })
    .join("");

  $$("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openTheme(themes.find((t) => t.id === b.dataset.edit))),
  );
}

$("#new-theme").addEventListener("click", () => openTheme(null));

// -------------------------------------------------------- theme edit form

let editing = null;

function ruleRow(rule = {}) {
  const checked = (d) => (rule.weekdays?.includes(d) ? "checked" : "");
  return `
  <div class="rule">
    <label class="field">
      <span>Date window <span class="hint">— MM-DD, wraps across new year</span></span>
      <div class="row">
        <input type="text" class="r-from" placeholder="12-01" pattern="\\d{2}-\\d{2}" value="${esc(rule.dateWindow?.from ?? "")}" style="flex:1">
        <span style="color:var(--text-dim)">to</span>
        <input type="text" class="r-to" placeholder="12-26" pattern="\\d{2}-\\d{2}" value="${esc(rule.dateWindow?.to ?? "")}" style="flex:1">
      </div>
    </label>
    <label class="field">
      <span>Weekdays <span class="hint">— none means every day</span></span>
      <div class="weekdays">
        ${DAY_NAMES.map((n, d) => `<label><input type="checkbox" class="r-day" value="${d}" ${checked(d)}>${n}</label>`).join("")}
      </div>
    </label>
    <label class="field" style="margin-bottom:0">
      <span>Time of day <span class="hint">— wraps past midnight</span></span>
      <div class="row">
        <input type="time" class="r-tfrom" value="${esc(rule.timeOfDay?.from ?? "")}" style="flex:1">
        <span style="color:var(--text-dim)">to</span>
        <input type="time" class="r-tto" value="${esc(rule.timeOfDay?.to ?? "")}" style="flex:1">
      </div>
    </label>
    <div class="row end" style="margin-top:9px">
      <button type="button" class="btn small danger r-del">Remove window</button>
    </div>
  </div>`;
}

function wireRuleButtons() {
  $$(".r-del").forEach((b) =>
    b.addEventListener("click", () => {
      // Always leave one. A theme with no rules can never match, which looks
      // like a bug rather than a choice.
      if ($$("#f-rules .rule").length === 1) {
        toast("A theme needs at least one window. Leave it blank for 'always'.");
        return;
      }
      b.closest(".rule").remove();
    }),
  );
}

function openTheme(theme) {
  editing = theme;
  $("#theme-dialog-title").textContent = theme ? `Edit ${theme.name}` : "New theme";
  $("#f-name").value = theme?.name ?? "";
  $("#f-id").value = theme?.id ?? "";
  $("#f-id").disabled = Boolean(theme);
  $("#f-priority").value = theme?.priority ?? 0;
  $("#f-enabled").checked = theme ? theme.enabled : true;
  $("#delete-theme").hidden = !theme;

  $("#f-image").innerHTML = media
    .map((m) => {
      const [, label] = VERDICT[m.verdict] ?? ["", "unknown"];
      return `<option value="${esc(m.filename)}" ${m.filename === theme?.filename ? "selected" : ""}>${esc(m.filename)} — ${esc(label)}</option>`;
    })
    .join("");

  $("#f-sound").innerHTML =
    `<option value="">Default ring sound</option>` +
    sounds.ringtones
      .map((r) => `<option value="${esc(r.id)}" ${r.id === theme?.sound ? "selected" : ""}>${esc(r.name)}</option>`)
      .join("");

  // Only worth showing with more than one doorbell; with one it is noise
  // and the empty default already means "that one".
  $("#f-devices-field").hidden = devices.length < 2;
  $("#f-devices").innerHTML = devices
    .map(
      (d) => `<label><input type="checkbox" class="f-device" value="${esc(d.id)}"
        ${theme?.devices?.includes(d.id) ? "checked" : ""}>${esc(d.name)}</label>`,
    )
    .join("");

  $("#f-rules").innerHTML = (theme?.rules?.length ? theme.rules : [{}]).map(ruleRow).join("");
  wireRuleButtons();
  $("#theme-dialog").showModal();
  // showModal() focuses the dialog itself, not the first field, so without
  // this the first thing typed goes nowhere.
  $("#f-name").focus();
}

$("#add-rule").addEventListener("click", () => {
  $("#f-rules").insertAdjacentHTML("beforeend", ruleRow());
  wireRuleButtons();
});

$("#cancel-theme").addEventListener("click", () => $("#theme-dialog").close());

// Derive an id from the name, but only while creating and only until the
// field is touched - changing an id later would orphan the theme's history.
$("#f-name").addEventListener("input", (e) => {
  if (editing || $("#f-id").dataset.touched) return;
  $("#f-id").value = e.target.value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
});
$("#f-id").addEventListener("input", () => ($("#f-id").dataset.touched = "1"));

$("#theme-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  const rules = $$("#f-rules .rule").map((row) => {
    const rule = {};
    const from = row.querySelector(".r-from").value.trim();
    const to = row.querySelector(".r-to").value.trim();
    if (from && to) rule.dateWindow = { from, to };
    const days = [...row.querySelectorAll(".r-day:checked")].map((c) => Number(c.value));
    if (days.length > 0) rule.weekdays = days;
    const tFrom = row.querySelector(".r-tfrom").value;
    const tTo = row.querySelector(".r-tto").value;
    if (tFrom && tTo) rule.timeOfDay = { from: tFrom, to: tTo };
    return rule;
  });

  const body = {
    id: $("#f-id").value.trim(),
    name: $("#f-name").value.trim(),
    filename: $("#f-image").value,
    // Empty means every doorbell, which is what the label says and what
    // the server treats it as.
    devices: [...document.querySelectorAll(".f-device:checked")].map((c) => c.value),
    sound: $("#f-sound").value || undefined,
    priority: Number($("#f-priority").value),
    enabled: $("#f-enabled").checked,
    rules,
  };

  try {
    await busyWhile(submitter($("#theme-form")), () =>
      api("/api/themes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    $("#theme-dialog").close();
    toast(`Saved ${body.name}.`, "ok");
    await renderThemes();
  } catch (error) {
    toast(error.message, "bad");
  }
});

$("#delete-theme").addEventListener("click", async () => {
  if (!editing) return;
  // Deliberately a confirm: it is destructive, instant and not undoable.
  if (!confirm(`Delete the theme "${editing.name}"? The GIF itself is kept.`)) return;
  try {
    await api(`/api/themes?id=${encodeURIComponent(editing.id)}`, { method: "DELETE" });
    $("#theme-dialog").close();
    toast(`Deleted ${editing.name}.`, "ok");
    await renderThemes();
  } catch (error) {
    toast(error.message, "bad");
  }
});

// ------------------------------------------------------------------- media

async function renderMedia() {
  const fresh = ticket("media");
  // The slowest tab by far - ffprobe decodes every frame of every GIF to
  // count them. Tiles the right shape keep the layout from jumping.
  $("#media-grid").innerHTML = skeletonTiles(10);

  media = await api("/api/media");
  if (!fresh()) return;
  if (media.length === 0) {
    $("#media-grid").innerHTML = emptyState("No images yet", "Upload a GIF to get started.");
    return;
  }

  $("#media-grid").innerHTML = media
    .map((m) => {
      const [kind, label] = VERDICT[m.verdict] ?? ["mute", "unreadable"];
      return `
      <div class="tile">
        <div class="thumb">
          <img loading="lazy" alt="" src="/thumb/${encodeURIComponent(m.filename)}"
               data-animate="/media/${encodeURIComponent(m.filename)}">
          <span class="play" aria-hidden="true">▶</span>
        </div>
        <div class="body">
          <div class="fname" title="${esc(m.filename)}">${esc(m.filename)}</div>
          <div class="facts">
            <span class="badge ${kind}">${esc(label)}</span>
            ${m.frames ? `<span>${m.frames} frames</span>` : ""}
            <span>${kb(m.bytes)}</span>
          </div>
          ${m.inUse ? `<div class="facts"><span class="badge mute">used by a theme</span></div>` : ""}
          ${m.verdict && m.verdict !== "safe" ? `<div class="facts" style="font-size:11.5px">${esc(m.advice ?? "")}</div>` : ""}
          <div class="acts">
            ${m.verdict === "likely-fails" ? `<button class="btn small" data-fit="${esc(m.filename)}">Shrink</button>` : ""}
            <button class="btn small danger" data-del-media="${esc(m.filename)}" ${m.inUse ? "disabled title='Used by a theme'" : ""}>Delete</button>
          </div>
        </div>
      </div>`;
    })
    .join("");

  $$("[data-fit]").forEach((b) =>
    b.addEventListener("click", (e) =>
      withBusy(e.target, async () => {
        const result = await api(`/api/media/fit?filename=${encodeURIComponent(b.dataset.fit)}`, {
          method: "POST",
        });
        toast(`Wrote ${result.to} — the original is untouched.`, "ok");
        await renderMedia();
      }),
    ),
  );

  $$("[data-del-media]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`Delete ${b.dataset.delMedia} from the library?`)) return;
      try {
        await api(`/api/media?filename=${encodeURIComponent(b.dataset.delMedia)}`, { method: "DELETE" });
        toast("Deleted.", "ok");
        await renderMedia();
      } catch (error) {
        toast(error.message, "bad");
      }
    }),
  );
}

$("#upload-gif").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    const result = await api("/api/media", { method: "POST", body: form });
    toast(
      result.duplicateOf
        ? `Already in the library as ${result.duplicateOf}.`
        : `Uploaded ${result.filename}.`,
      "ok",
    );
    await renderMedia();
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    event.target.value = "";
  }
});

// ------------------------------------------------------------------ sounds

async function loadSounds() {
  try {
    sounds = await api("/api/ringtones");
  } catch {
    // 503 when no admin credentials are configured. Images still work, which
    // is the whole reason the sound half is optional.
    sounds = { ringtones: [], limit: 12, unavailable: true };
  }
}

async function renderSounds() {
  const fresh = ticket("sounds");
  $("#sounds-list").innerHTML = skeletonRows(5);

  await loadSounds();
  if (!fresh()) return;
  if (sounds.unavailable) {
    $("#sounds-list").innerHTML = emptyState(
      "Ring sounds are unavailable",
      "They need PROTECT_ADMIN_USER and PROTECT_ADMIN_PASS. Welcome images work without them.",
    );
    return;
  }

  const rows = sounds.ringtones
    .map(
      (r) => `
      <tr>
        <td><strong>${esc(r.name)}</strong> ${r.isDefault ? `<span class="badge mute">stock</span>` : ""}</td>
        <td class="mono">${esc(r.id)}</td>
        <td>${r.inUse ? `<span class="badge ok">in use</span>` : ""}</td>
        <td style="text-align:right">
          ${r.isDefault ? "" : `<button class="btn small danger" data-del-sound="${esc(r.id)}" data-name="${esc(r.name)}">Delete</button>`}
        </td>
      </tr>`,
    )
    .join("");

  const full = sounds.ringtones.length >= sounds.limit;
  $("#sounds-list").innerHTML = `
    <p class="sub">
      ${sounds.ringtones.length} of ${sounds.limit} slots used.
      ${full ? `<strong style="color:var(--bad)">Full — delete one before uploading.</strong>` : ""}
    </p>
    <table>
      <thead><tr><th>Name</th><th>Id</th><th></th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  $$("[data-del-sound]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm(`Delete the ring sound "${b.dataset.name}"? This cannot be undone.`)) return;
      try {
        await api(`/api/ringtones?id=${encodeURIComponent(b.dataset.delSound)}`, { method: "DELETE" });
        toast("Deleted.", "ok");
        await renderSounds();
      } catch (error) {
        toast(error.message, "bad");
      }
    }),
  );
}

$("#upload-sound").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  try {
    const result = await api("/api/ringtones", { method: "POST", body: form });
    toast(`Uploaded ${result.name}.`, "ok");
    await renderSounds();
  } catch (error) {
    toast(error.message, "bad");
  } finally {
    event.target.value = "";
  }
});

// ---------------------------------------------------------------- calendar

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Monday-first, matching how a wall calendar reads here. */
const WEEK_START = 1;
const WEEKDAY_HEADS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const columnOf = (date) => (date.getDay() - WEEK_START + 7) % 7;

async function renderCalendar() {
  const fresh = ticket("calendar");

  // Each doorbell has its own rotation, so the calendar has to be about
  // one of them. The picker only appears when there is a choice to make.
  if (devices.length === 0) devices = await api("/api/devices");
  const field = $("#cal-device-field");
  field.hidden = devices.length < 2;
  if ($("#cal-device").options.length !== devices.length) {
    const current = $("#cal-device").value;
    $("#cal-device").innerHTML = devices
      .map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`)
      .join("");
    if (current) $("#cal-device").value = current;
  }

  const from = $("#cal-from").value;
  const days = $("#cal-days").value;
  $("#calendar").innerHTML = skeletonDays(Math.min(Number(days), 63));

  const picked = $("#cal-device").value;
  const response = await api(
    `/api/calendar?days=${days}${from ? `&from=${from}` : ""}${picked ? `&device=${encodeURIComponent(picked)}` : ""}`,
  );
  if (!fresh()) return;
  const data = response.days;

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  // Group by month. A flat run of days was wrong in a way that is obvious
  // once seen: the columns did not line up with weekdays, so a calendar
  // whose whole job is answering "which day is that?" could not be read
  // like one.
  const months = new Map();
  for (const day of data) {
    const key = day.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(day);
  }

  const cell = (day) => {
    const date = new Date(`${day.date}T12:00:00`);
    const classes = [
      "day",
      day.priority > 0 ? "special" : "",
      day.themeId ? "" : "none",
      day.date === todayKey ? "today" : "",
      [0, 6].includes(date.getDay()) ? "weekend" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const art = day.filename
      ? `<img class="chip" loading="lazy" alt="" src="/thumb/${encodeURIComponent(day.filename)}">`
      : "";

    return `
      <div class="${classes}" title="${esc(day.date)}${day.themeName ? ` — ${esc(day.themeName)}` : " — nothing scheduled"}">
        <div class="d">${date.getDate()}</div>
        ${art}
        <div class="t">${esc(day.themeName ?? "—")}</div>
      </div>`;
  };

  $("#calendar").innerHTML = [...months.entries()]
    .map(([key, daysInMonth]) => {
      const [year, month] = key.split("-").map(Number);
      // Blank cells so the first day lands under its real weekday.
      const lead = columnOf(new Date(`${daysInMonth[0].date}T12:00:00`));
      // Days where something beats the everyday rotation. Not "seasonal":
      // a Friday-night theme counts too, and calling it seasonal was wrong
      // the moment one existed.
      const scheduled = daysInMonth.filter((d) => d.priority > 0).length;

      return `
        <section class="month">
          <h3 class="month-name">
            ${MONTHS[month - 1]} ${year}
            ${scheduled > 0 ? `<span class="badge ok">${scheduled} scheduled</span>` : ""}
          </h3>
          <div class="cal">
            ${WEEKDAY_HEADS.map((d) => `<div class="wd">${d}</div>`).join("")}
            ${'<div class="pad"></div>'.repeat(lead)}
            ${daysInMonth.map(cell).join("")}
          </div>
        </section>`;
    })
    .join("");
}

$("#cal-from").addEventListener("change", renderCalendar);
$("#cal-days").addEventListener("change", renderCalendar);
$("#cal-device").addEventListener("change", renderCalendar);

// ----------------------------------------------------------------- history

async function renderHistory() {
  const fresh = ticket("history");
  $("#history").innerHTML = `<tbody>${skeletonRows(5)}</tbody>`;

  const rows = await api("/api/applies?limit=100");
  if (!fresh()) return;
  if (rows.length === 0) {
    $("#history").innerHTML = `<tbody><tr><td>${esc("Nothing has run yet.")}</td></tr></tbody>`;
    return;
  }
  $("#history").innerHTML = `
    <thead><tr><th>When</th><th>Doorbell</th><th>Outcome</th><th>Theme</th><th>Why</th></tr></thead>
    <tbody>
      ${rows
        .map(
          (r) => `
        <tr>
          <td style="white-space:nowrap">${esc(new Date(r.at).toLocaleString())}</td>
          <td>${esc(r.deviceName ?? "—")}</td>
          <td><span class="badge ${r.outcome === "failed" ? "bad" : r.outcome === "no-theme" ? "warn" : r.outcome === "unchanged" ? "mute" : "ok"}">${esc(r.outcome)}</span></td>
          <td>${esc(r.themeId ?? "—")}</td>
          <td style="color:var(--text-dim)">${esc(r.reason)}</td>
        </tr>`,
        )
        .join("")}
    </tbody>`;
}

// -------------------------------------------------------------------- gate

function gateError(message) {
  const el = $("#gate-error");
  el.textContent = message;
  el.hidden = !message;
}

function showGate(mode = "login") {
  $("#booting").hidden = true;
  $("#app").hidden = true;
  $("#gate").hidden = false;
  $("#setup-form").hidden = mode !== "setup";
  $("#login-form").hidden = mode !== "login";
  gateError("");
  $(mode === "setup" ? "#s-user" : "#l-user").focus();
}

function showApp() {
  $("#booting").hidden = true;
  $("#gate").hidden = true;
  $("#app").hidden = false;
}

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  gateError("");
  if ($("#s-pass").value !== $("#s-pass2").value) {
    gateError("Those two passwords are not the same.");
    return;
  }
  try {
    // scrypt is deliberately slow, so this is the one request where the
    // wait is the feature working rather than something being wrong.
    await busyWhile(submitter($("#setup-form")), () =>
      api("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: $("#s-user").value.trim(), password: $("#s-pass").value }),
      }),
    );
    showApp();
    await start();
    toast("Account created. You are signed in.", "ok");
  } catch (error) {
    gateError(error.message);
  }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  gateError("");
  try {
    await busyWhile(submitter($("#login-form")), () =>
      api("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: $("#l-user").value.trim(), password: $("#l-pass").value }),
      }),
    );
    $("#l-pass").value = "";
    showApp();
    await start();
  } catch (error) {
    gateError(error.message);
  }
});

// ----------------------------------------------------------------- account

$("#account").addEventListener("click", () => {
  $("#p-current").value = $("#p-next").value = $("#p-next2").value = "";
  $("#account-dialog").showModal();
});

$("#cancel-account").addEventListener("click", () => $("#account-dialog").close());

$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // Already gone as far as the server is concerned; the gate is still right.
  }
  $("#account-dialog").close();
  showGate("login");
});

$("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#p-next").value !== $("#p-next2").value) {
    toast("Those two passwords are not the same.", "bad");
    return;
  }
  try {
    await busyWhile(submitter($("#password-form")), () =>
      api("/api/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: $("#p-current").value, next: $("#p-next").value }),
      }),
    );
    $("#account-dialog").close();
    toast("Password changed. Other sessions have been signed out.", "ok");
  } catch (error) {
    toast(error.message, "bad");
  }
});

// -------------------------------------------------------------------- boot

const RENDERERS = {
  now: renderNow,
  themes: renderThemes,
  media: renderMedia,
  sounds: renderSounds,
  calendar: renderCalendar,
  history: renderHistory,
  settings: renderSettings,
};

/** Everything that needs a session. Called once the gate is passed. */
async function start() {
  const today = new Date();
  $("#cal-from").value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  try {
    await renderNow();
  } catch (error) {
    toast(error.message, "bad");
  }
  const initial = location.hash.slice(1);
  if (TABS.includes(initial) && initial !== "now") show(initial);
}

async function boot() {
  let session;
  try {
    session = await api("/api/session");
  } catch {
    // The server is unreachable or broken. A login form would be a lie.
    $("#booting").hidden = true;
    document.body.innerHTML =
      '<div class="empty-state"><strong>Doorman is not responding</strong>' +
      "The page loaded but the service behind it did not answer. Check the container.</div>";
    return;
  }

  $("#who").textContent = session.username ?? "";
  if (session.needsSetup) {
    showGate("setup");
  } else if (!session.authenticated) {
    showGate("login");
  } else {
    showApp();
    await start();
  }
}

boot();
