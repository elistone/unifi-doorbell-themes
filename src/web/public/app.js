/**
 * Doorman UI.
 *
 * Plain modules, no framework and no build step - the same rule the server
 * follows. Everything here is fetch, template strings and one render
 * function per tab. Styling is Tailwind classes, compiled ahead of time into
 * the committed style.css (see ../tailwind.css): a class written here only
 * exists once `npm run css` has seen it.
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

const TOAST_ICONS = {
  ok: '<path d="m3.5 8.4 3 3 6-6.4"/>',
  bad: '<path d="M8 4v5M8 11.6v.2"/>',
  "": '<path d="M8 7.2V12M8 4.4v.2"/>',
};

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "bad" ? "alert" : "status");
  el.innerHTML = `<span class="ti"><svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${TOAST_ICONS[kind] ?? TOAST_ICONS[""]}</svg></span><span></span>`;
  el.lastElementChild.textContent = message;
  $("#toasts").append(el);
  // Slides out rather than vanishing; click to dismiss early.
  const leave = () => {
    if (el.classList.contains("leaving")) return;
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  el.addEventListener("click", leave);
  setTimeout(leave, kind === "bad" ? 9000 : 4500);
}

/**
 * Ask something in the page's own dialog, instead of confirm() and prompt().
 *
 * Resolves with the answer, or null if cancelled: true for a plain
 * confirmation, the text for `input`, `{ choice, text }` with `choices`.
 * `onChoice` lets the text follow the choice - picking a camera fills in
 * its name.
 */
function ask({ title, body = "", ok = "OK", danger = false, input = null, choices = null, onChoice = null, icon: glyph = "info" }) {
  const dialog = $("#ask-dialog");
  $("#ask-title").textContent = title;
  $("#ask-body").textContent = body;
  $("#ask-body").hidden = !body;
  $("#ask-icon").innerHTML = icon(glyph);
  $("#ask-icon").className = `grid size-8 place-items-center rounded-xl ${danger ? "bg-bad-bg text-bad" : "bg-accent-soft text-accent"}`;
  $("#ask-ok").textContent = ok;
  $("#ask-ok").className = `btn ${danger ? "danger solid" : "primary"}`;

  $("#ask-input-field").hidden = !input;
  $("#ask-input").required = Boolean(input);
  if (input) {
    $("#ask-input-label").textContent = input.label ?? "";
    $("#ask-input").value = input.value ?? "";
  }

  $("#ask-choices").hidden = !choices;
  $("#ask-choices").innerHTML = (choices ?? [])
    .map(
      (c, i) => `<label class="choice">
        <input type="radio" name="ask-choice" value="${i}" ${i === 0 ? "checked" : ""}>
        <span class="min-w-0"><span class="block truncate text-sm font-semibold">${esc(c.label)}</span>${c.hint ? `<span class="block text-xs text-dim">${esc(c.hint)}</span>` : ""}</span>
      </label>`,
    )
    .join("");
  const picked = () => choices?.[Number($("#ask-choices input:checked")?.value ?? 0)];
  if (choices && onChoice) {
    $("#ask-input").value = onChoice(picked()) ?? "";
    $("#ask-choices").onchange = () => ($("#ask-input").value = onChoice(picked()) ?? "");
  }

  return new Promise((resolve) => {
    let answer = null;
    $("#ask-form").onsubmit = (event) => {
      event.preventDefault();
      const text = $("#ask-input").value.trim();
      if (input && !text) return;
      answer = choices ? { choice: picked(), text } : input ? text : true;
      dialog.close();
    };
    $("#ask-cancel").onclick = () => dialog.close();
    dialog.addEventListener("close", () => resolve(answer), { once: true });
    dialog.showModal();
    if (input) {
      $("#ask-input").focus();
      $("#ask-input").select();
    } else {
      // The safe button, so a stray Enter does not delete anything.
      (danger ? $("#ask-cancel") : $("#ask-ok")).focus();
    }
  });
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
  // Anything that changes something makes every saved answer suspect - a
  // deleted sound must not be shown again from the cache a moment later.
  if ((options.method ?? "GET") !== "GET") forgetCache();
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
    // What was saved for the last session is not for whoever signs in next.
    forgetCache();
    showGate();
    throw new Error("Your session ended. Sign in again.");
  }
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  return body;
}

/**
 * Each tab's last answers, shown straight away and checked in the background.
 *
 * Moving between tabs, or opening one in a new browser tab, used to fetch
 * everything again behind a skeleton - though nothing had usually changed.
 * Now the last answer is drawn at once (from memory, or from localStorage
 * after a reload) and the server is asked again behind it; only if the
 * answer differs is the tab drawn again. The server answers an unchanged
 * list with an empty 304, so the check is cheap as well as invisible.
 *
 * Never trusted on its own: every saved answer is re-asked whenever it is
 * shown, and any change made here (anything but a GET) forgets them all.
 */
const CACHE_STORE = "doorman:answers:v1";
const cache = new Map();
/** Bumped by forgetCache, so a check already in flight cannot save a stale answer. */
let cacheGeneration = 0;
const checking = new Set();
/** Long enough that drawing a tab from a fresh answer does not ask again at once. */
const RECHECK_AFTER_MS = 2000;

try {
  for (const [path, entry] of JSON.parse(localStorage.getItem(CACHE_STORE) ?? "[]")) cache.set(path, { ...entry, at: 0 });
} catch {
  // Private window, blocked storage, or an old format: start empty.
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_STORE, JSON.stringify([...cache]));
  } catch {
    // Full or blocked. The in-memory copy still serves this page.
  }
}

function forgetCache() {
  cacheGeneration++;
  cache.clear();
  try {
    localStorage.removeItem(CACHE_STORE);
  } catch {
    // Nothing to do.
  }
}

function remember(path, data) {
  const text = JSON.stringify(data);
  const changed = cache.get(path)?.text !== text;
  cache.set(path, { text, at: Date.now() });
  if (changed) saveCache();
  return changed;
}

/**
 * GET `path` for drawing `tab`: the saved answer if there is one, checked
 * behind the scenes, or a real request if there is not. A copy every time,
 * so a renderer changing what it was given cannot change the cache.
 */
async function load(path, tab) {
  const hit = cache.get(path);
  if (!hit) {
    const generation = cacheGeneration;
    const data = await api(path);
    if (generation === cacheGeneration) remember(path, data);
    return data;
  }
  if (Date.now() - hit.at > RECHECK_AFTER_MS) recheck(path, tab);
  return JSON.parse(hit.text);
}

function recheck(path, tab) {
  if (checking.has(path)) return;
  checking.add(path);
  const generation = cacheGeneration;
  api(path)
    .then((data) => {
      if (generation !== cacheGeneration) return;
      // Drawn again only when something actually changed, and only if that
      // tab is still the one on screen; any other picks it up next time.
      if (remember(path, data) && currentTab === tab) RENDERERS[tab]?.();
    })
    .catch(() => {
      // The saved answer is already on screen; a failed check changes nothing.
    })
    .finally(() => checking.delete(path));
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

/**
 * Line icons, as strings so they can go straight into a template.
 *
 * Inline rather than a sprite or a font: there are a dozen of them, they
 * inherit `currentColor` so one copy works on every background, and the
 * alternative is a network request for something smaller than its own
 * HTTP headers.
 */
const ICONS = {
  add: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  upload: '<path d="M8 10.8V2.4M4.6 5.8 8 2.4l3.4 3.4"/><path d="M2.6 10.6v2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-2"/>',
  play: '<path d="M4.4 2.8 12.6 8l-8.2 5.2V2.8Z"/>',
  eye: '<path d="M1.3 8S3.9 3.4 8 3.4 14.7 8 14.7 8 12.1 12.6 8 12.6 1.3 8 1.3 8Z"/><circle cx="8" cy="8" r="1.9"/>',
  trash: '<path d="M2.6 4.2h10.8M6 4.2V2.9a.9.9 0 0 1 .9-.9h2.2a.9.9 0 0 1 .9.9v1.3M12 4.2v8.9a.9.9 0 0 1-.9.9H4.9a.9.9 0 0 1-.9-.9V4.2"/>',
  edit: '<path d="M11.1 2.2a1.6 1.6 0 0 1 2.3 2.3L5.1 12.8l-3.1.8.8-3.1Z"/>',
  bell: '<path d="M8 1.9a4.2 4.2 0 0 0-4.2 4.2c0 2.4-.6 3.8-1 4.6a.5.5 0 0 0 .4.8h9.6a.5.5 0 0 0 .4-.8c-.4-.8-1-2.2-1-4.6A4.2 4.2 0 0 0 8 1.9Z"/><path d="M6.5 13.2a1.6 1.6 0 0 0 3 0"/>',
  shrink: '<path d="M6.4 9.6 2.4 13.6M6.4 13.6v-4h-4M9.6 6.4l4-4M9.6 2.4v4h4"/>',
  power: '<path d="M8 2.4v5.2"/><path d="M11.6 4.3a5 5 0 1 1-7.2 0"/>',
  crop: '<path d="M4.4 1.6v9.9h9.9M1.6 4.4h9.9v9.9"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.9M8 5v.2"/>',
  alert: '<path d="M7.1 2.6a1 1 0 0 1 1.8 0l5.4 9.6a1 1 0 0 1-.9 1.5H2.6a1 1 0 0 1-.9-1.5Z"/><path d="M8 6.4v3M8 11.3v.2"/>',
  check: '<path d="m3.5 8.4 3 3 6-6.4"/>',
  layers: '<rect x="1.8" y="2.8" width="8" height="8" rx="1.4"/><path d="M12.2 5.2h1.4a.6.6 0 0 1 .6.6v7a.6.6 0 0 1-.6.6h-7a.6.6 0 0 1-.6-.6v-1.4"/>',
  image: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><circle cx="5.6" cy="6.4" r="1.1"/><path d="m2.4 11.4 3.1-2.8 2.6 2.3 2.4-2 3.1 2.7"/>',
  sound: '<path d="M8.6 2.6 5 5.6H2.6v4.8H5l3.6 3V2.6Z"/><path d="M11.4 5.9a3.4 3.4 0 0 1 0 4.2M13.3 4a6 6 0 0 1 0 8"/>',
  calendar: '<rect x="2" y="3.2" width="12" height="10.8" rx="1.4"/><path d="M2 6.6h12M5.4 1.8v2.4M10.6 1.8v2.4"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/>',
  activity: '<path d="M1.6 8h2.8l1.8-4.6 3.4 9.2 1.8-4.6h3"/>',
  spark: '<path d="M8 1.8v3M8 11.2v3M1.8 8h3M11.2 8h3M3.6 3.6l2 2M10.4 10.4l2 2M12.4 3.6l-2 2M5.6 10.4l-2 2"/>',
  search: '<circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.4 3.4"/>',
};

/** Three bouncing bars, shown on a Listen button while its sound plays. */
const EQ = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>';

const icon = (name) => `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;

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

const skLines = (n = 2) =>
  Array.from({ length: n }, (_, i) => `<div class="sk sk-line" style="width:${[90, 60, 75, 45, 80][i % 5]}%"></div>`).join("");

/** Card-shaped rows, for lists of themes, doorbells and sounds. */
const skeletonRows = (n) =>
  Array.from(
    { length: n },
    () =>
      `<div class="card flex items-center gap-4 !p-4"><div class="sk size-16 shrink-0 !rounded-xl"></div><div class="flex-1">${skLines(2)}</div></div>`,
  ).join("");

const skeletonTiles = (n) =>
  Array.from(
    { length: n },
    () => `<div class="card flush"><div class="sk aspect-square !rounded-none"></div><div class="p-3">${skLines(2)}</div></div>`,
  ).join("");

// Wrapped in the same month/grid shell the real calendar uses, or the
// placeholder is a flat column that collapses into a grid when data lands.
const skeletonDays = (n) =>
  `<section class="month"><div class="sk mb-3 h-4 w-36"></div>
    <div class="cal">${Array.from({ length: n }, () => '<div class="sk min-h-[96px] !rounded-xl max-sm:min-h-[74px]"></div>').join("")}</div>
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

/**
 * Each tab's address and the name in the browser's title bar. Real paths,
 * so a tab can be bookmarked, opened in a new browser tab, and reached with
 * Back and Forward; the server answers every one of them with this page.
 */
const PAGES = {
  now: { path: "/", title: "Dashboard" },
  themes: { path: "/themes", title: "Themes" },
  media: { path: "/images", title: "Images" },
  sounds: { path: "/sounds", title: "Sounds" },
  calendar: { path: "/calendar", title: "Calendar" },
  history: { path: "/history", title: "History" },
  settings: { path: "/settings", title: "Settings" },
};

const tabAt = (pathname) => TABS.find((t) => PAGES[t].path === pathname) ?? "now";

/**
 * Show a tab. `push` adds a history entry; going Back or Forward passes
 * false, because the browser has already moved and a push would wipe out
 * the entries ahead.
 */
let currentTab = "now";

function show(tab, { push = true } = {}) {
  if (!TABS.includes(tab)) return;
  const moved = currentTab !== tab;
  currentTab = tab;
  for (const name of TABS) {
    const section = $(`#tab-${name}`);
    section.hidden = name !== tab;
    // Replayed on each arrival: removing and re-adding the class restarts it.
    if (name === tab && moved) {
      section.classList.remove("enter");
      void section.offsetWidth;
      section.classList.add("enter");
    }
  }
  for (const link of $$("nav [data-tab]")) {
    if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  placeNavPill();
  document.title = `${PAGES[tab].title} · Doorman`;
  if (push && location.pathname !== PAGES[tab].path) history.pushState(null, "", PAGES[tab].path);

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

// [data-tab] rather than everything in the nav: the account button lives
// there too, and without the filter clicking it called show(undefined),
// which hid every section and left a blank page behind the dialog.
//
// These are links, so a middle click, Cmd/Ctrl-click or Shift-click is left
// to the browser and opens the tab somewhere new; only a plain click is
// handled here, without reloading the page.
//
// Delegated, because tab links live outside the nav too - the brand, and
// the "Full calendar" and "All" links on the dashboard.
document.addEventListener("click", (event) => {
  const link = event.target.closest?.("a[data-tab]");
  if (!link) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  show(link.dataset.tab);
});

window.addEventListener("popstate", () => show(tabAt(location.pathname), { push: false }));

/**
 * The highlight behind the current tab, which slides from one to the next
 * rather than jumping. Measured, so it fits the link whether the nav is a
 * column (wide screens) or a row (narrow ones).
 */
function placeNavPill() {
  const pill = $("#nav-pill");
  const link = $(`nav [data-tab="${currentTab}"]`);
  if (!pill || !link || !link.offsetWidth) return;
  pill.style.width = `${link.offsetWidth}px`;
  pill.style.height = `${link.offsetHeight}px`;
  pill.style.transform = `translate(${link.offsetLeft}px, ${link.offsetTop}px)`;
  link.scrollIntoView({ block: "nearest", inline: "nearest" });
}
new ResizeObserver(placeNavPill).observe($("#nav"));

/**
 * Collapse the sidebar to its icons, or open it again. Remembered per
 * browser, and set before first paint by the snippet in index.html.
 */
const SIDEBAR_KEY = "doorman-sidebar";

function setSidebar(collapsed) {
  if (collapsed) document.documentElement.dataset.sidebar = "collapsed";
  else delete document.documentElement.dataset.sidebar;
  const button = $("#collapse-side");
  const label = collapsed ? "Expand the sidebar" : "Collapse the sidebar";
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", label);
  button.title = `${label} ( [ )`;
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_KEY, "collapsed");
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    // Still collapses for this visit.
  }
}

const sidebarCollapsed = () => document.documentElement.dataset.sidebar === "collapsed";
setSidebar(sidebarCollapsed());
$("#collapse-side").addEventListener("click", () => setSidebar(!sidebarCollapsed()));

// With only icons showing, each tab's name is its tooltip.
for (const link of $$(".nav-link")) link.title = link.querySelector("span").textContent;

// 1-7 to jump between tabs, as numbered in the sidebar - except while
// typing, or with a dialog open.
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || $("#app").hidden) return;
  if (event.target.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
  if (event.key === "[") return setSidebar(!sidebarCollapsed());
  const tab = TABS[Number(event.key) - 1];
  if (tab) show(tab);
});

// -------------------------------------------------------------- Now panel

/** "3 min ago", "yesterday", "12 Nov" - for when something last happened. */
function ago(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 172800) return "yesterday";
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** What an apply's outcome is called, and the colour it is drawn in. */
const OUTCOMES = {
  applied: { label: "changed", badge: "ok", mark: "--mark-good" },
  unchanged: { label: "unchanged", badge: "mute", mark: "--mark-neutral" },
  "no-theme": { label: "no theme", badge: "warn", mark: "--mark-warning" },
  failed: { label: "failed", badge: "bad", mark: "--mark-critical" },
  "dry-run": { label: "preview", badge: "accent", mark: "--mark-neutral" },
};
const outcomeOf = (outcome) => OUTCOMES[outcome] ?? { label: outcome, badge: "mute", mark: "--mark-neutral" };

/**
 * Numbers that count up to their value as they arrive. Only from what was
 * on screen before, so a background refresh that changes nothing is still.
 */
function countUp(root) {
  for (const el of root.querySelectorAll("[data-count]")) {
    const target = Number(el.dataset.count);
    const from = Number(el.dataset.from ?? 0);
    if (from === target || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = target;
      continue;
    }
    const began = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - began) / 700);
      el.textContent = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

async function renderNow() {
  const fresh = ticket("now");
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  $("#now-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  if (!state) {
    $("#now-panel").innerHTML = `<div class="card grid gap-6 md:grid-cols-[220px_1fr]">
      <div class="sk aspect-square !rounded-[22px]"></div><div class="pt-2">${skLines(5)}</div></div>`;
  }

  state = await load("/api/state", "now");
  if (!fresh()) return;

  $("#now-greeting").innerHTML = `${greeting}${state.username ? `, <span class="text-gradient">${esc(state.username)}</span>` : ""}`;
  showIdentity();

  $("#now-panel").innerHTML =
    state.doorbells.length === 0
      ? `<div class="card">${emptyState(
          "No doorbell configured",
          "Add one in Settings and Doorman will start scheduling it.",
          "bell",
        )}</div>`
      : state.doorbells.map(doorbellCard).join("");

  // Per-doorbell apply, wired after render.
  $$("[data-apply-device]").forEach((b) =>
    b.addEventListener("click", (e) =>
      withBusy(e.currentTarget, async () => {
        const { results } = await api(
          `/api/apply?device=${encodeURIComponent(b.dataset.applyDevice)}`,
          { method: "POST" },
        );
        reportApplies(results);
        await renderNow();
      }),
    ),
  );

  // The rest of the dashboard, each part on its own so a slow or failing
  // one (the sound list needs Protect) does not hold up the others.
  const parts = [renderNowStats, renderNowActivity, renderNowUpcoming, renderNowRecent];
  await Promise.all(parts.map((part) => part(fresh).catch(() => {})));
}

/** One doorbell: what it is showing, what it will show, and why. */
function doorbellCard(d) {
  const image = d.showing.filename
    ? `<img src="/media/${encodeURIComponent(d.showing.filename)}" alt="What the doorbell is showing">`
    : `<div class="grid size-full place-items-center p-4 text-center text-[13px] text-faint">${d.showing.assetName ? "Showing something not in this library" : "Nothing set"}</div>`;

  const sound = !state.soundEnabled
    ? `<span class="badge mute">no admin credentials</span>`
    : d.ringtone.dangling
      ? `<span class="badge bad">points at a ring sound that no longer exists</span>`
      : esc(d.ringtone.name ?? "—");

  const last = d.last;
  const outcome = last
    ? `<span class="badge ${outcomeOf(last.outcome).badge}">${esc(outcomeOf(last.outcome).label)}</span>
       <span class="text-xs font-normal text-faint" title="${esc(new Date(last.at).toLocaleString())}">${esc(ago(last.at))}</span>`
    : `<span class="badge mute">never run</span>`;

  const fact = (glyph, label, value, extra = "") => `
    <div class="min-w-0 rounded-xl bg-surface-2/70 p-3 ${extra}">
      <div class="mb-1 flex items-center gap-1.5 text-xs font-semibold text-faint">${icon(glyph)}${label}</div>
      <div class="flex flex-wrap items-center gap-2 text-sm font-semibold [overflow-wrap:anywhere]">${value}</div>
    </div>`;

  return `
    <div class="card enter relative grid gap-6 overflow-hidden md:grid-cols-[220px_minmax(0,1fr)]">
      <div class="bg-brand pointer-events-none absolute -right-20 -top-24 size-64 rounded-full opacity-10 blur-3xl"></div>
      <div>
        <div class="screen">${image}</div>
      </div>
      <div class="relative flex min-w-0 flex-col">
        <div class="row mb-4">
          <span class="live ${d.enabled ? "" : "off"}"></span>
          <strong class="text-lg tracking-tight">${esc(d.name)}</strong>
          ${d.enabled ? `<span class="badge ok">live</span>` : `<span class="badge mute">disabled</span>`}
          <div class="spacer"></div>
          <button class="btn small" data-apply-device="${esc(d.id)}">${icon("play")}Apply now</button>
        </div>
        <div class="text-xs font-semibold uppercase tracking-wider text-faint">Today's theme</div>
        <div class="mt-1 text-3xl font-bold tracking-tight ${d.today.themeName ? "text-gradient" : "text-faint"}">${esc(d.today.themeName ?? "None eligible")}</div>
        <div class="mt-1.5 font-mono text-xs text-dim">${esc(d.today.reason)}</div>
        <div class="mt-5 grid gap-2.5 sm:grid-cols-2">
          ${fact("image", "Image", esc(d.showing.filename ?? d.showing.assetName ?? "nothing"))}
          ${fact("sound", "Ring sound", sound)}
          ${fact("clock", "Last run", outcome)}
          ${fact("layers", "Themes", `${d.themeCount} eligible here`)}
        </div>
      </div>
    </div>`;
}

/** The four numbers across the top. */
async function renderNowStats(fresh) {
  const box = $("#now-stats");
  if (!box.children.length) box.innerHTML = Array.from({ length: 4 }, () => `<div class="stat"><div class="sk h-3 w-24"></div><div class="sk mt-3 h-8 w-16"></div></div>`).join("");

  const [themeList, stats] = await Promise.all([load("/api/themes", "now"), load("/api/stats?days=30", "now")]);
  await loadSounds("now");
  if (!fresh()) return;

  const enabled = themeList.filter((t) => t.enabled).length;
  const special = themeList.filter((t) => t.enabled && t.priority > 0).length;
  const imagesUsed = new Set(themeList.map((t) => t.filename).filter(Boolean)).size;
  const totals = stats.days.reduce(
    (sum, d) => ({ changed: sum.changed + d.changed, runs: sum.runs + d.changed + d.unchanged + d.noTheme + d.failed, failed: sum.failed + d.failed }),
    { changed: 0, runs: 0, failed: 0 },
  );
  const okRate = totals.runs ? Math.round(((totals.runs - totals.failed) / totals.runs) * 100) : null;
  const slots = sounds.ringtones.length;

  // Carry the old numbers over, so they count from there rather than zero.
  const before = Object.fromEntries([...box.querySelectorAll("[data-count]")].map((el) => [el.dataset.key, el.textContent]));
  const tile = (key, glyph, label, value, foot, extra = "") => `
    <div class="stat">
      <div class="label">${icon(glyph)}${label}</div>
      <div class="value">${value === null ? "—" : `<span data-key="${key}" data-count="${value}" data-from="${Number(before[key] ?? 0)}">${Number(before[key] ?? 0)}</span>`}</div>
      <div class="foot">${foot}</div>
      ${extra}
    </div>`;

  box.innerHTML = [
    tile("themes", "layers", "Themes enabled", enabled, `${themeList.length} in all · ${special} beat the rotation`),
    tile("images", "image", "Images", state.counts.media, `${imagesUsed} used by a theme`),
    sounds.unavailable
      ? tile("sounds", "sound", "Ring sounds", null, "Needs Protect admin credentials")
      : tile(
          "sounds",
          "sound",
          "Ring sounds",
          (sounds.library ?? []).length,
          `${slots} of ${sounds.limit} doorbell slots used`,
          `<div class="meter" title="${slots} of ${sounds.limit} slots">${Array.from({ length: sounds.limit }, (_, i) => `<i class="${i < slots ? "on" : ""}"></i>`).join("")}</div>`,
        ),
    tile(
      "changes",
      "activity",
      "Changes, 30 days",
      totals.changed,
      okRate === null ? "Nothing has run yet" : `${totals.runs} runs · ${okRate}% without a failure`,
    ),
  ].join("");
  countUp(box);
}

/** Stacked columns, one per day: what each run did. */
async function renderNowActivity(fresh) {
  const box = $("#now-activity");
  if (!box.children.length) box.innerHTML = `<div class="sk h-44 w-full"></div>`;
  const stats = await load("/api/stats?days=30", "now");
  if (!fresh()) return;

  const series = [
    { key: "changed", ...OUTCOMES.applied },
    { key: "unchanged", ...OUTCOMES.unchanged },
    { key: "noTheme", ...OUTCOMES["no-theme"] },
    { key: "failed", ...OUTCOMES.failed },
  ];
  $("#now-legend").innerHTML = series
    .map((s) => `<span class="flex items-center gap-1.5"><i class="legend-key" style="background:var(${s.mark})"></i>${s.label}</span>`)
    .join("");

  const total = (d) => d.changed + d.unchanged + d.noTheme + d.failed;
  const max = Math.max(1, ...stats.days.map(total));
  if (stats.days.every((d) => total(d) === 0)) {
    box.innerHTML = emptyState("Nothing has run yet", "Each daily change shows up here.", "activity");
    return;
  }

  const label = (date, opts) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, opts);
  const columns = stats.days
    .map((d, i) => {
      const segments = series
        .filter((s) => d[s.key] > 0)
        .map((s, j, shown) => {
          const top = j === shown.length - 1;
          return `<div class="chart-bar w-full ${top ? "rounded-t" : ""}" style="--i:${i};height:${(d[s.key] / max) * 100}%;background:var(${s.mark});${j > 0 ? "margin-bottom:2px" : ""}"></div>`;
        })
        .join("");
      return `<div class="chart-col group relative flex h-full flex-1 cursor-default justify-center" data-day="${i}">
          <div class="chart-hit absolute inset-x-0 -bottom-1 top-0 rounded-md transition-colors"></div>
          <div class="relative flex h-full w-full max-w-6 flex-col-reverse">${segments}</div>
        </div>`;
    })
    .join("");

  box.innerHTML = `
    <div class="relative mt-6">
      <div class="absolute inset-x-0 top-0 border-t border-line"></div>
      <span class="absolute -top-5 right-0 text-[10.5px] tabular-nums text-faint">${max} run${max === 1 ? "" : "s"}</span>
      <div class="flex h-40 items-end gap-[2px] border-b border-line-strong pt-px" id="activity-cols">${columns}</div>
      <div class="mt-1.5 flex justify-between text-[11px] text-faint">
        <span>${label(stats.days[0].date, { day: "numeric", month: "short" })}</span>
        <span>${label(stats.days[Math.floor(stats.days.length / 2)].date, { day: "numeric", month: "short" })}</span>
        <span>Today</span>
      </div>
      <div class="pointer-events-none absolute z-10 hidden min-w-36 rounded-xl border border-line bg-surface p-2.5 text-xs shadow-lift" id="activity-tip"></div>
    </div>`;

  // One tooltip, moved to whichever day is under the pointer.
  const tip = $("#activity-tip");
  const cols = $("#activity-cols");
  cols.addEventListener("pointerover", (event) => {
    const col = event.target.closest("[data-day]");
    if (!col) return;
    const d = stats.days[Number(col.dataset.day)];
    tip.innerHTML =
      `<div class="mb-1.5 font-semibold">${label(d.date, { weekday: "short", day: "numeric", month: "short" })}</div>` +
      (total(d) === 0
        ? `<div class="text-faint">No runs</div>`
        : series
            .filter((s) => d[s.key] > 0)
            .map((s) => `<div class="flex items-center gap-2"><i class="legend-key" style="background:var(${s.mark})"></i>${s.label}<span class="ml-auto pl-3 font-semibold tabular-nums">${d[s.key]}</span></div>`)
            .join(""));
    tip.hidden = false;
    tip.classList.remove("hidden");
    const x = col.offsetLeft + col.offsetWidth / 2;
    tip.style.left = `${clamp(x - tip.offsetWidth / 2, 0, cols.offsetWidth - tip.offsetWidth)}px`;
    tip.style.bottom = "calc(100% - 8px)";
  });
  cols.addEventListener("pointerleave", () => tip.classList.add("hidden"));

  // Most shown, from the same numbers.
  const themeList = await load("/api/themes", "now");
  if (!fresh()) return;
  const top = stats.themes.slice(0, 5);
  const most = Math.max(1, ...top.map((t) => t.count));
  $("#now-top").innerHTML = top.length
    ? `<div class="stagger grid gap-4">${top
        .map((t, i) => {
          const file = themeList.find((x) => x.id === t.themeId)?.filename;
          return `<div class="flex items-center gap-3">
            ${file ? `<img class="size-10 shrink-0 rounded-lg object-cover" loading="lazy" alt="" src="/thumb/${encodeURIComponent(file)}">` : `<div class="size-10 shrink-0 rounded-lg bg-surface-2"></div>`}
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2 text-sm"><span class="truncate font-semibold">${esc(t.name)}</span><span class="ml-auto shrink-0 text-xs tabular-nums text-dim">${t.count} run${t.count === 1 ? "" : "s"}</span></div>
              <div class="mt-1.5 h-2 rounded-full bg-surface-2"><div class="hbar" style="--i:${i};width:${(t.count / most) * 100}%"></div></div>
            </div>
          </div>`;
        })
        .join("")}</div>`
    : emptyState("Nothing yet", "Themes appear here once they have been on the doorbell.", "layers");
}

/** The next fortnight, as a strip of days. */
async function renderNowUpcoming(fresh) {
  const box = $("#now-upcoming");
  if (!box.children.length) box.innerHTML = Array.from({ length: 7 }, () => `<div class="sk h-36 w-28 shrink-0 !rounded-2xl"></div>`).join("");
  const device = state.doorbells[0]?.id;
  const { days } = await load(`/api/calendar?days=14${device ? `&device=${encodeURIComponent(device)}` : ""}`, "now");
  if (!fresh()) return;
  box.innerHTML = days
    .map((d, i) => {
      const date = new Date(`${d.date}T12:00:00`);
      const changes = i > 0 && d.themeId !== days[i - 1].themeId;
      return `<div class="enter flex w-28 shrink-0 flex-col items-center gap-2 rounded-2xl border p-2.5 text-center transition-transform duration-200 hover:-translate-y-1
          ${i === 0 ? "border-accent bg-accent-soft" : d.priority > 0 ? "border-accent/50 bg-surface" : "border-line bg-surface"}" style="animation-delay:${i * 30}ms"
          title="${esc(d.date)}${d.themeName ? ` — ${esc(d.themeName)}` : ""}">
        <div class="text-[11px] font-semibold uppercase tracking-wider ${i === 0 ? "text-accent" : "text-faint"}">${i === 0 ? "Today" : date.toLocaleDateString(undefined, { weekday: "short" })} <span class="tabular-nums">${date.getDate()}</span></div>
        ${d.filename ? `<img class="size-16 rounded-xl object-cover" loading="lazy" alt="" src="/thumb/${encodeURIComponent(d.filename)}">` : `<div class="size-16 rounded-xl bg-surface-2"></div>`}
        <div class="line-clamp-2 text-[11.5px] font-medium leading-tight ${d.themeId ? "" : "text-faint"}">${esc(d.themeName ?? "—")}</div>
        ${changes ? `<span class="badge accent plain !px-1.5 !text-[10px]">changes</span>` : ""}
      </div>`;
    })
    .join("");
}

/** The last few runs, newest first. */
async function renderNowRecent(fresh) {
  const box = $("#now-recent");
  if (!box.children.length) box.innerHTML = skLines(5);
  const [rows, themeList] = await Promise.all([load("/api/applies?limit=6", "now"), load("/api/themes", "now")]);
  if (!fresh()) return;
  const nameOf = themeNamer(themeList);
  box.innerHTML = rows.length
    ? `<ol class="stagger grid gap-3.5">${rows
        .map((r) => {
          const o = outcomeOf(r.outcome);
          return `<li class="flex gap-3">
            <span class="feed-dot" style="background:var(${o.mark})"></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-sm"><span class="truncate font-semibold">${esc(nameOf(r.themeId))}</span><span class="badge ${o.badge} ml-auto shrink-0">${esc(o.label)}</span></div>
              <div class="truncate text-xs text-faint" title="${esc(r.reason)}">${esc(r.deviceName ?? "")}${r.deviceName ? " · " : ""}${esc(ago(r.at))}</div>
            </div>
          </li>`;
        })
        .join("")}</ol>`
    : emptyState("No runs yet", "The first daily change appears here.", "clock");
}

/** A theme's name from its id, which is what the history records; the id if it has since gone. */
const themeNamer = (list) => {
  const names = new Map(list.map((t) => [t.id, t.name]));
  return (id) => (id ? names.get(id) ?? id : "No theme");
};

/** The signed-in name and what Doorman is connected to, in the sidebar. */
function showIdentity() {
  $("#version").textContent = `v${state.version}`;
  if (state.username) {
    for (const id of ["#who", "#who-side"]) $(id).textContent = state.username;
    for (const id of ["#avatar", "#avatar-big"]) $(id).textContent = state.username.slice(0, 1);
  }
  $("#status-title").textContent = state.protectVersion ? "Connected" : "Protect unreachable";
  $("#status-live").className = `live ${state.protectVersion ? "" : "off"}`;
  $("#status-lines").innerHTML = [
    state.protectVersion ? `UniFi Protect ${esc(state.protectVersion)}` : null,
    `${state.counts.devices} doorbell${state.counts.devices === 1 ? "" : "s"}`,
    state.soundEnabled ? "Ring sounds on" : "Ring sounds off — no admin login",
  ]
    .filter(Boolean)
    .map((line) => `<div>${line}</div>`)
    .join("");
}

/** Summarise an apply that may have covered several doorbells. */
function reportApplies(results) {
  for (const r of results) {
    // A ring sound that failed leaves the outcome "unchanged" or "applied",
    // because the image is fine - so it has to be said first, and in red,
    // or a green toast reads as success.
    const soundFailed = r.sound === "failed";
    toast(
      `${r.deviceName ? `${r.deviceName}: ` : ""}${soundFailed ? "ring sound NOT set; image " : ""}${r.outcome} — ${r.reason}`,
      r.outcome === "failed" || soundFailed ? "bad" : "ok",
    );
  }
}

const emptyState = (title, body, glyph = "spark") =>
  `<div class="empty-state enter"><div class="art">${icon(glyph)}</div><strong>${esc(title)}</strong>${esc(body)}</div>`;

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
  withBusy(e.currentTarget, async () => {
    const { results } = await api("/api/apply", { method: "POST" });
    reportApplies(results);
    await renderNow();
  }),
);

$("#dry-run").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
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

  const [list, settings] = await Promise.all([load("/api/devices", "settings"), load("/api/settings", "settings")]);
  await loadSounds("settings");
  if (!fresh()) return;
  devices = list;
  const themeList = await load("/api/themes", "settings");

  $("#devices-list").innerHTML =
    devices.length === 0
      ? emptyState("No doorbells yet", "Add one and Doorman will start scheduling it.")
      : devices
          .map((d) => {
            const scoped = themeList.filter((t) => t.devices.includes(d.id)).length;
            const all = themeList.filter((t) => t.devices.length === 0).length;
            return `
            <div class="enter flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-surface-2/50 p-4 ${d.enabled ? "" : "opacity-60"}">
              <div class="grid size-12 shrink-0 place-items-center rounded-2xl ${d.enabled ? "bg-brand text-white" : "bg-surface-3 text-dim"}">${icon("bell")}</div>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 font-semibold">
                  ${esc(d.name)}
                  ${d.enabled ? `<span class="badge ok">live</span>` : `<span class="badge mute">disabled</span>`}
                </div>
                <div class="truncate font-mono text-xs text-faint">${esc(d.id)}</div>
                <div class="mt-0.5 text-[13px] text-dim">${all + scoped} themes apply here${scoped > 0 ? ` (${scoped} only here)` : ""}</div>
              </div>
              <div class="row">
                <label class="switch" title="${d.enabled ? "Disable" : "Enable"}"><input type="checkbox" data-toggle-device="${esc(d.id)}" ${d.enabled ? "checked" : ""} aria-label="Enabled"></label>
                <button class="btn small" data-rename="${esc(d.id)}">${icon("edit")}Rename</button>
                <button class="btn small danger icon" data-remove-device="${esc(d.id)}" title="Remove" aria-label="Remove">${icon("trash")}</button>
              </div>
            </div>`;
          })
          .join("");

  for (const radio of $$('#selection input[name="selection"]')) radio.checked = radio.value === settings.selection;

  $("#roll-hour").innerHTML = Array.from({ length: 24 }, (_, h) => {
    const label = `${String(h).padStart(2, "0")}:00`;
    return `<option value="${h}" ${h === settings.rollHour.value ? "selected" : ""}>${label}</option>`;
  }).join("");

  $("#default-ringtone").innerHTML =
    `<option value="">None — leave whatever is set</option>` + soundOptions(settings.defaultRingtone.value);

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
  await renderNotifications();
}

function wireDeviceButtons() {
  $$("[data-rename]").forEach((b) =>
    b.addEventListener("click", async () => {
      const device = devices.find((d) => d.id === b.dataset.rename);
      const name = await ask({
        title: "Rename doorbell",
        input: { label: "Name", value: device.name },
        ok: "Rename",
        icon: "edit",
      });
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
    b.addEventListener("change", async () => {
      const device = devices.find((d) => d.id === b.dataset.toggleDevice);
      b.disabled = true;
      try {
        await api("/api/devices", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...device, enabled: !device.enabled }),
        });
        // A disabled doorbell keeps its themes and history; it is just
        // skipped by the scheduler.
        toast(`${device.name} ${device.enabled ? "disabled" : "enabled"}.`, "ok");
      } catch (error) {
        toast(error.message, "bad");
      }
      await renderSettings();
    }),
  );

  $$("[data-remove-device]").forEach((b) =>
    b.addEventListener("click", async () => {
      const device = devices.find((d) => d.id === b.dataset.removeDevice);
      const sure = await ask({
        title: `Remove ${device.name}?`,
        body: "Its themes and history are kept. Any theme that applies only to this doorbell is disabled rather than spread to the others.",
        ok: "Remove",
        danger: true,
        icon: "trash",
      });
      if (!sure) return;
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
  withBusy(e.currentTarget, async () => {
    const found = await api("/api/devices/discover");
    if (found.length === 0) {
      toast("No other camera on the controller can display a welcome image.", "bad");
      return;
    }
    // The list is short: it leaves out doorbells already added.
    const answer = await ask({
      title: "Add a doorbell",
      body: "Cameras on the controller that can show a welcome image.",
      choices: found.map((c) => ({ label: c.name, hint: c.type, camera: c })),
      onChoice: (c) => c.camera.name,
      input: { label: "Call it" },
      ok: "Add doorbell",
      icon: "bell",
    });
    if (!answer) return;

    await api("/api/devices", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: answer.choice.camera.id, name: answer.text, enabled: true }),
    });
    toast(`Added ${answer.text}.`, "ok");
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

// ------------------------------------------------------- notifications

let notify = null;

async function saveNotify(patch, note) {
  try {
    notify = await api("/api/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // Where this page lives, so messages can link back to it.
      body: JSON.stringify({ ...patch, baseUrl: location.origin }),
    });
    if (note) toast(note, "ok");
    drawNotifications();
    return true;
  } catch (error) {
    toast(error.message, "bad");
    return false;
  }
}

async function renderNotifications() {
  notify = await load("/api/notifications", "settings");
  drawNotifications();
}

function drawNotifications() {
  const t = notify.telegram;
  const ready = t.tokenSet && t.chatId;
  $("#tg-enabled").checked = t.enabled;
  $("#tg-status").className = `badge ${t.enabled && ready ? "ok" : t.enabled ? "warn" : "mute"}`;
  $("#tg-status").textContent = t.enabled && ready ? "on" : t.enabled ? "needs setting up" : "off";
  $("#tg-body").classList.toggle("opacity-60", !t.enabled);

  // The token never comes back; say whether there is one instead.
  $("#tg-token").value = "";
  $("#tg-token").placeholder = t.tokenSet ? "•••••••• saved — paste a new one to replace it" : "123456:ABC-DEF…";
  $("#tg-token-hint").textContent =
    t.tokenSource === "environment" ? "— from the deployment's configuration" : t.tokenSet ? "— saved" : "";
  if (document.activeElement !== $("#tg-chat")) $("#tg-chat").value = t.chatId ?? "";
  $("#tg-chat-hint").textContent = t.chatSource === "environment" ? "— from the deployment's configuration" : "";
  $("#tg-test").disabled = !ready;

  $("#tg-events").innerHTML = notify.kinds
    .map(
      (k) => `
      <label class="choice !py-2.5">
        <input type="checkbox" data-alert="${esc(k.key)}" ${t.events[k.key] ? "checked" : ""} class="size-4 accent-[var(--accent)]">
        <span class="min-w-0"><span class="block text-sm font-semibold">${esc(k.label)}</span><span class="block text-[12.5px] text-dim">${esc(k.description)}</span></span>
      </label>`,
    )
    .join("");
}

$("#tg-enabled").addEventListener("change", async (e) => {
  const on = e.target.checked;
  if (!(await saveNotify({ enabled: on }, on ? "Telegram notifications are on." : "Telegram notifications are off."))) {
    e.target.checked = !on;
  }
});

$("#tg-events").addEventListener("change", (e) => {
  const key = e.target.dataset.alert;
  if (!key) return;
  const label = notify.kinds.find((k) => k.key === key)?.label ?? key;
  void saveNotify({ events: { [key]: e.target.checked } }, `${label}: ${e.target.checked ? "on" : "off"}.`);
});

$("#tg-form").addEventListener("submit", (e) => {
  e.preventDefault();
  withBusy($("#tg-save"), async () => {
    const patch = { chatId: $("#tg-chat").value.trim() };
    if ($("#tg-token").value.trim()) patch.token = $("#tg-token").value.trim();
    // Filling it in is a clear sign of wanting it on.
    if (!notify.telegram.enabled && (patch.token || notify.telegram.tokenSet) && patch.chatId) patch.enabled = true;
    await saveNotify(patch, "Saved.");
  });
});

$("#tg-find").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
    const { chats } = await api("/api/notifications/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: $("#tg-token").value.trim() || undefined }),
    });
    const box = $("#tg-chats");
    if (!chats.length) {
      box.hidden = false;
      box.innerHTML = `<div class="rounded-xl bg-surface-2 p-3 text-[13px] text-dim">No chats yet. Send your bot a message in Telegram, then try again.</div>`;
      return;
    }
    if (chats.length === 1) {
      $("#tg-chat").value = chats[0].id;
      box.hidden = true;
      toast(`Found ${chats[0].name}. Press Save to use it.`, "ok");
      return;
    }
    box.hidden = false;
    box.innerHTML = chats
      .map(
        (c) => `<button type="button" class="choice text-left" data-chat="${esc(c.id)}">
          <span class="min-w-0"><span class="block text-sm font-semibold">${esc(c.name)}</span><span class="block font-mono text-xs text-faint">${esc(c.type)} · ${esc(c.id)}</span></span>
        </button>`,
      )
      .join("");
  }),
);

$("#tg-chats").addEventListener("click", (e) => {
  const pick = e.target.closest("[data-chat]");
  if (!pick) return;
  $("#tg-chat").value = pick.dataset.chat;
  $("#tg-chats").hidden = true;
  toast("Chat chosen. Press Save to use it.", "ok");
});

$("#tg-test").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
    await api("/api/notifications/test", { method: "POST" });
    toast("Sent — check Telegram.", "ok");
  }),
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
  // The waveform is a canvas, drawn in the colours of the moment.
  if (!$("#sound-edit").hidden) drawWave();
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Not worth telling anyone about - the toggle still worked for this view.
  }
});

// ------------------------------------------------------------------ themes

/** What the Themes tab is narrowed to: some text, and all / enabled / disabled. */
const themeView = { text: "", filter: "all" };

async function renderThemes() {
  const fresh = ticket("themes");
  if (!themes.length) $("#themes-list").innerHTML = skeletonRows(4);

  [themes, media, devices] = await Promise.all([
    load("/api/themes", "themes"),
    load("/api/media", "themes"),
    load("/api/devices", "themes"),
  ]);
  await loadSounds("themes");
  if (!fresh()) return;
  drawThemes();
}

function drawThemes() {
  if (themes.length === 0) {
    $("#themes-list").innerHTML = `<div class="card md:col-span-2 2xl:col-span-3">${emptyState(
      "No themes yet",
      "Without one the scheduler leaves the doorbell alone. Start with New theme.",
      "layers",
    )}</div>`;
    return;
  }

  const text = themeView.text.toLowerCase();
  const sorted = [...themes]
    .filter((t) => themeView.filter === "all" || (themeView.filter === "on") === t.enabled)
    .filter((t) => !text || `${t.name} ${t.id} ${t.filename ?? ""}`.toLowerCase().includes(text))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  if (sorted.length === 0) {
    $("#themes-list").innerHTML = `<div class="card md:col-span-2 2xl:col-span-3">${emptyState("No matches", "Nothing fits that search or filter.", "search")}</div>`;
    return;
  }

  $("#themes-list").innerHTML = sorted
    .map((theme, i) => {
      const sound = (sounds.library ?? []).find((l) => l.ref === theme.sound) ?? sounds.ringtones.find((r) => r.id === theme.sound);
      const thumb = theme.filename
        ? `<img class="size-full object-cover" loading="lazy" alt="" src="/thumb/${encodeURIComponent(theme.filename)}"
                data-animate="/media/${encodeURIComponent(theme.filename)}">`
        : `<div class="grid size-full place-items-center text-[11px] text-bad">missing</div>`;
      const soundLine = sound
        ? esc(sound.name)
        : theme.soundMissing
          ? `<span class="text-bad">missing${theme.soundName ? `: ${esc(theme.soundName)}` : ""}</span>`
          : theme.sound
            ? esc(theme.soundName ?? "sound set")
            : `<span class="text-faint">default sound</span>`;
      const where =
        devices.length > 1
          ? theme.devices.length === 0
            ? "all doorbells"
            : theme.devices.map((id) => devices.find((d) => d.id === id)?.name ?? id).join(", ")
          : null;
      return `
      <div class="tile enter !flex-row gap-4 p-4 ${theme.enabled ? "" : "opacity-60"}" style="animation-delay:${Math.min(i, 12) * 35}ms">
        <div class="size-20 shrink-0 overflow-hidden rounded-xl bg-surface-2">${thumb}</div>
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <div class="truncate font-semibold">${esc(theme.name)}</div>
              <div class="flex flex-wrap gap-1.5 pt-1">
                ${theme.priority > 0 ? `<span class="badge accent">priority ${theme.priority}</span>` : ""}
                ${theme.missing ? `<span class="badge bad">image missing</span>` : ""}
                ${theme.refused ? `<span class="badge bad" title="Protect could not process its image, so the scheduler skips it. See Images.">set aside</span>` : ""}
              </div>
            </div>
            <label class="switch" title="${theme.enabled ? "Enabled" : "Disabled"}"><input type="checkbox" data-toggle-theme="${esc(theme.id)}" ${theme.enabled ? "checked" : ""} aria-label="Enabled"></label>
          </div>
          <div class="flex flex-wrap gap-1">${theme.rules.map((r) => `<span class="chip">${icon("calendar")}${esc(describeRule(r))}</span>`).join("")}</div>
          <div class="flex items-center gap-1.5 text-xs text-dim">${icon("sound")}<span class="truncate">${soundLine}</span></div>
          ${where ? `<div class="flex items-center gap-1.5 text-xs text-dim">${icon("bell")}<span class="truncate">${esc(where)}</span></div>` : ""}
          <div class="mt-auto flex justify-end pt-1">
            <button class="btn small" data-edit="${esc(theme.id)}">${icon("edit")}Edit</button>
          </div>
        </div>
      </div>`;
    })
    .join("");

  $$("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openTheme(themes.find((t) => t.id === b.dataset.edit))),
  );

  // Straight from the card, without opening the editor.
  $$("[data-toggle-theme]").forEach((input) =>
    input.addEventListener("change", async () => {
      const theme = themes.find((t) => t.id === input.dataset.toggleTheme);
      input.disabled = true;
      try {
        await api("/api/themes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: theme.id,
            name: theme.name,
            image: theme.image,
            devices: theme.devices,
            sound: theme.sound,
            priority: theme.priority,
            enabled: input.checked,
            rules: theme.rules,
          }),
        });
        toast(`${theme.name} ${input.checked ? "enabled" : "disabled"}.`, "ok");
      } catch (error) {
        toast(error.message, "bad");
      }
      await renderThemes();
    }),
  );
}

$("#themes-search").addEventListener("input", (e) => {
  themeView.text = e.target.value.trim();
  drawThemes();
});

/** A strip of filter buttons: press one, the others let go, `onPick` redraws. */
function segmented(selector, onPick) {
  $(selector).addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    for (const b of $(selector).querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b === button));
    onPick(button.dataset.filter);
  });
}

segmented("#themes-filter", (filter) => {
  themeView.filter = filter;
  drawThemes();
});

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
    <div class="row end mt-3">
      <button type="button" class="btn small danger r-del">${icon("trash")}Remove window</button>
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

  $("#f-sound").innerHTML = `<option value="">Default ring sound</option>` + soundOptions(theme?.sound);
  previewThemeImage();

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

/** The chosen image, large, beside the form - a filename says little. */
function previewThemeImage() {
  const file = $("#f-image").value;
  $("#f-image-preview").innerHTML = file
    ? `<img class="enter" alt="" src="/media/${encodeURIComponent(file)}">`
    : `<div class="grid size-full place-items-center text-xs text-faint">No image</div>`;
}
$("#f-image").addEventListener("change", previewThemeImage);

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
  // Deliberately asked: it is destructive, instant and not undoable.
  const sure = await ask({
    title: `Delete ${editing.name}?`,
    body: "The theme goes for good. The GIF and sound stay in the library.",
    ok: "Delete theme",
    danger: true,
    icon: "trash",
  });
  if (!sure) return;
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

const mediaView = { text: "", filter: "all" };

async function renderMedia() {
  const fresh = ticket("media");
  // The slowest tab by far - ffprobe decodes every frame of every GIF to
  // count them. Tiles the right shape keep the layout from jumping.
  if (!media.length) $("#media-grid").innerHTML = skeletonTiles(10);

  media = await load("/api/media", "media");
  if (!fresh()) return;
  drawMedia();
}

function drawMedia() {
  const total = media.length;
  const text = mediaView.text.toLowerCase();
  const shown = media
    .filter((m) =>
      mediaView.filter === "used" ? m.inUse
      : mediaView.filter === "unused" ? !m.inUse
      : mediaView.filter === "problem" ? m.verdict !== "safe" || m.refused
      : true,
    )
    .filter((m) => !text || m.filename.toLowerCase().includes(text));
  $("#media-count").textContent = total ? `${shown.length === total ? total : `${shown.length} of ${total}`} images` : "";

  if (total === 0) {
    $("#media-grid").innerHTML = `<div class="card col-span-full">${emptyState("No images yet", "Upload a GIF, or use Find a GIF to search for one.", "image")}</div>`;
    return;
  }
  if (shown.length === 0) {
    $("#media-grid").innerHTML = `<div class="card col-span-full">${emptyState("No matches", "Nothing fits that search or filter.", "search")}</div>`;
    return;
  }

  $("#media-grid").innerHTML = shown
    .map((m, i) => {
      const [kind, label] = VERDICT[m.verdict] ?? ["mute", "unreadable"];
      return `
      <div class="tile enter" style="animation-delay:${Math.min(i, 16) * 25}ms">
        <div class="thumb">
          <img loading="lazy" alt="" src="/thumb/${encodeURIComponent(m.filename)}"
               data-animate="/media/${encodeURIComponent(m.filename)}">
          <span class="play" aria-hidden="true">▶ GIF</span>
          ${m.inUse ? `<span class="badge ok absolute left-2 top-2 shadow-soft">in use</span>` : ""}
        </div>
        <div class="flex flex-1 flex-col gap-2 p-3">
          <div class="truncate text-[13px] font-semibold" title="${esc(m.filename)}">${esc(m.filename)}</div>
          <div class="facts">
            ${m.refused
              ? `<span class="badge bad" title="Protect could not process it, so the scheduler skips it">Protect refused</span>`
              : `<span class="badge ${kind}">${esc(label)}</span>`}
            ${m.frames ? `<span>${m.frames} frames</span>` : ""}
            <span>${kb(m.bytes)}</span>
          </div>
          ${m.refused
            ? `<div class="text-[11.5px] text-dim">Protect would not take it on ${esc(new Date(m.refused.at).toLocaleDateString())}, so themes using it are skipped. Shrink makes a copy with fewer frames.</div>`
            : m.verdict && m.verdict !== "safe" ? `<div class="text-[11.5px] text-dim">${esc(m.advice ?? "")}</div>` : ""}
          <div class="mt-auto flex flex-wrap gap-1.5 pt-1">
            ${m.verdict === "likely-fails" || m.refused ? `<button class="btn small" data-fit="${esc(m.filename)}">${icon("shrink")}Shrink</button>` : ""}
            ${m.refused ? `<button class="btn small" data-unrefuse="${esc(m.filename)}" title="Let the scheduler try uploading it again">Try again</button>` : ""}
            <button class="btn small" data-crop="${esc(m.filename)}" title="Crop and trim into a new copy">${icon("crop")}Crop</button>
            <div class="spacer"></div>
            <button class="btn small danger icon" data-del-media="${esc(m.filename)}" aria-label="Delete" ${m.inUse ? "disabled title='Used by a theme'" : "title='Delete'"}>${icon("trash")}</button>
          </div>
        </div>
      </div>`;
    })
    .join("");

  $$("[data-fit]").forEach((b) =>
    b.addEventListener("click", (e) =>
      withBusy(e.currentTarget, async () => {
        const result = await api(`/api/media/fit?filename=${encodeURIComponent(b.dataset.fit)}`, {
          method: "POST",
        });
        toast(`Wrote ${result.to} — the original is untouched.`, "ok");
        await renderMedia();
      }),
    ),
  );

  $$("[data-crop]").forEach((b) =>
    b.addEventListener("click", (e) =>
      withBusy(e.currentTarget, () => cropFromLibrary(b.dataset.crop)),
    ),
  );

  $$("[data-unrefuse]").forEach((b) =>
    b.addEventListener("click", (e) =>
      withBusy(e.currentTarget, async () => {
        await api(`/api/media/refused?filename=${encodeURIComponent(b.dataset.unrefuse)}`, { method: "DELETE" });
        toast("It is back in the rotation. If Protect refuses it again, it is set aside again.", "ok");
        await renderMedia();
      }),
    ),
  );

  $$("[data-del-media]").forEach((b) =>
    b.addEventListener("click", async () => {
      const sure = await ask({
        title: `Delete ${b.dataset.delMedia}?`,
        body: "It is removed from the library for good.",
        ok: "Delete",
        danger: true,
        icon: "trash",
      });
      if (!sure) return;
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

$("#media-search").addEventListener("input", (e) => {
  mediaView.text = e.target.value.trim();
  drawMedia();
});
segmented("#media-filter", (filter) => {
  mediaView.filter = filter;
  drawMedia();
});

async function uploadGif(file) {
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
  }
}

$("#upload-gif").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  await uploadGif(file);
  event.target.value = "";
});

// ------------------------------------------------------------------ sounds

/**
 * Every sound a theme or the default can name, for a <select>.
 *
 * Library sounds first: they are the ones that can always be put on the
 * doorbell. The controller group leaves out Doorman's own uploads, which
 * are the library sounds again - choosing one there by its ringtone id
 * would tie the theme to a copy the cache is allowed to remove.
 */
function soundOptions(selected) {
  const option = (value, label) =>
    `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(label)}</option>`;
  const library = (sounds.library ?? []).map((l) => option(l.ref, l.name)).join("");
  const onDoorbell = sounds.ringtones
    .filter((r) => !r.managed)
    .map((r) => option(r.id, r.isDefault ? `${r.name} (stock)` : r.name))
    .join("");
  return (
    (library ? `<optgroup label="Library">${library}</optgroup>` : "") +
    (onDoorbell ? `<optgroup label="Only on the doorbell">${onDoorbell}</optgroup>` : "")
  );
}

async function loadSounds(tab = "sounds") {
  try {
    sounds = await load("/api/ringtones", tab);
  } catch {
    // 503 when no admin credentials are configured. Images still work, which
    // is the whole reason the sound half is optional.
    sounds = { ringtones: [], limit: 12, unavailable: true };
  }
}

async function renderSounds() {
  const fresh = ticket("sounds");
  if (!$("#sounds-list").children.length) $("#sounds-list").innerHTML = `<div class="grid gap-3">${skeletonRows(4)}</div>`;

  await loadSounds();
  if (!fresh()) return;
  // Nowhere to put a sound without admin credentials.
  $("#find-sound").hidden = Boolean(sounds.unavailable);
  if (sounds.unavailable) {
    $("#sounds-list").innerHTML = `<div class="card">${emptyState(
      "Ring sounds are unavailable",
      "They need PROTECT_ADMIN_USER and PROTECT_ADMIN_PASS. Welcome images work without them.",
      "sound",
    )}</div>`;
    return;
  }

  const rows = sounds.ringtones
    .map(
      (r) => `
      <tr>
        <td><div class="flex flex-wrap items-center gap-2"><strong class="font-semibold">${esc(r.name)}</strong>
          ${r.isDefault ? `<span class="badge mute">stock</span>` : ""}
          ${r.managed ? `<span class="badge accent" title="Doorman may remove this to make room, and put it back when a theme needs it">from the library</span>` : ""}
          ${
            r.noCopy
              ? `<span class="badge warn" title="Protect cannot hand this sound back, so Doorman never removes it and it holds a slot for good. Add the original file to the library under the name &quot;${esc(r.name)}&quot; and Doorman will manage it.">no copy in the library</span>`
              : ""
          }
          ${r.inUse ? `<span class="badge ok">in use</span>` : ""}</div></td>
        <td class="mono max-md:hidden">${esc(r.id)}</td>
        <td class="text-right whitespace-nowrap">
          ${r.noCopy ? `<button class="btn small" data-replace-sound="${esc(r.id)}" data-name="${esc(r.name)}" title="Find this sound again and keep it in the library">${icon("add")}Replace…</button>` : ""}
          ${r.isDefault ? "" : `<button class="btn small danger icon" data-del-sound="${esc(r.id)}" data-name="${esc(r.name)}" data-managed="${r.managed ? "1" : ""}" title="${r.managed ? "Remove from the doorbell" : "Delete"}" aria-label="Delete">${icon("trash")}</button>`}
        </td>
      </tr>`,
    )
    .join("");

  // A migration invalidates every custom ringtone id at once, so this is
  // worth surfacing where the sounds are rather than only on each theme.
  let broken = [];
  try {
    broken = await load("/api/sounds/broken", "sounds");
  } catch {
    // No admin credentials; the list above already explains that.
  }
  const repairable = broken.filter((b) => b.canRelinkTo).length;

  const full = sounds.ringtones.length >= sounds.limit;
  // Doorman's own copies can be removed and brought back; nothing else can.
  const canMakeRoom = sounds.ringtones.some((r) => r.managed);
  const noCopy = sounds.ringtones.filter((r) => r.noCopy);

  const libraryRows = (sounds.library ?? [])
    .map(
      (l, i) => `
      <div data-lib-row class="enter flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 first:border-t-0" style="animation-delay:${Math.min(i, 12) * 25}ms">
        <button class="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border-0 text-white shadow-soft transition-transform hover:scale-105 active:scale-95 bg-brand"
                data-listen-lib="${esc(l.hash)}" aria-label="Listen to ${esc(l.name)}">${icon("play")}</button>
        <div class="lib-name min-w-0 flex-1">
          <div class="truncate font-semibold">${esc(l.name)}</div>
          <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-faint">
            ${
              l.onDoorbell
                ? `<span class="badge ok">on the doorbell</span>`
                : `<span class="badge mute" title="Uploaded automatically when a theme needs it">uploaded when needed</span>`
            }
            ${l.inUse ? `<span class="badge accent">in use</span>` : ""}
            <span>${kb(l.bytes)}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${l.onDoorbell ? "" : `<button class="btn small" data-upload-lib="${esc(l.hash)}" title="Put it on the doorbell now, making room if needed">${icon("upload")}Put on doorbell</button>`}
          <button class="btn small" data-rename-lib="${esc(l.hash)}" data-name="${esc(l.name)}">${icon("edit")}Rename</button>
          <button class="btn small danger icon" data-del-lib="${esc(l.hash)}" data-name="${esc(l.name)}" aria-label="Delete" ${l.inUse ? "disabled title='Used by a theme or the default'" : "title='Delete'"}>${icon("trash")}</button>
        </div>
      </div>`,
    )
    .join("");
  const slots = sounds.ringtones.length;
  $("#sounds-list").innerHTML = `
    ${
      broken.length === 0
        ? ""
        : `<div class="notice enter">
             <strong>${broken.length} theme${broken.length === 1 ? "" : "s"} point at a ring sound this console does not have.</strong>
             Ringtone ids are issued per console, so migrating Protect breaks them all at once.
             <ul>${broken
               .map(
                 (b) =>
                   `<li>${esc(b.themeName)} wanted <strong>${esc(b.wants ?? "an unknown sound")}</strong>${
                     b.canRelinkTo ? ` — <span class="text-ok">found, ready to re-link</span>` : ""
                   }</li>`,
               )
               .join("")}</ul>
             ${
               repairable > 0
                 ? `<button class="btn primary small" id="relink-sounds">Re-link ${repairable} sound${repairable === 1 ? "" : "s"}</button>`
                 : `<p class="sub mt-2">Upload the audio again under the same name and this becomes a single click.</p>`
             }
           </div>`
    }
    <div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div class="card flush">
        <div class="px-5 pb-3 pt-5">
          <div class="card-title">${icon("sound")}Library <span class="badge mute plain">${(sounds.library ?? []).length}</span></div>
          <div class="card-sub">Kept by Doorman. A theme can use any of these, however many there are — each goes on the doorbell when a theme needs it.</div>
        </div>
        <div class="border-t border-line">${
          libraryRows || emptyState("The library is empty", "Use Find a sound or Upload sound to add one.", "sound")
        }</div>
      </div>

      <div class="card flush">
        <div class="px-5 pb-4 pt-5">
          <div class="card-title">${icon("bell")}On the doorbell</div>
          <div class="mt-3 flex items-baseline gap-2"><span class="text-3xl font-bold tabular-nums">${slots}</span><span class="text-sm text-dim">of ${sounds.limit} slots used</span></div>
          <div class="meter">${Array.from({ length: sounds.limit }, (_, i) => `<i class="${i < slots ? "on" : ""}"></i>`).join("")}</div>
          <p class="sub mt-3 !text-[13px]">
            ${
              noCopy.length > 0
                ? `${noCopy.length} ${noCopy.length === 1 ? "sound has" : "sounds have"} no copy in the library, so Doorman
                   will never remove ${noCopy.length === 1 ? "it" : "them"} to make room. Add the original
                   file${noCopy.length === 1 ? "" : "s"} to the library under the same name and Doorman takes
                   ${noCopy.length === 1 ? "it" : "them"} over. `
                : ""
            }
            ${
              full
                ? canMakeRoom
                  ? "Full, but Doorman will remove one of its library sounds to make room when it needs to."
                  : `<strong class="text-bad">Full, and nothing here is one Doorman can remove and put back.</strong>`
                : ""
            }
          </p>
        </div>
        <table>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  // One player for the whole tab, shared with the import dialog's.
  $$("[data-listen-lib]").forEach((b) =>
    b.addEventListener("click", () => {
      const same = listening === b;
      stopListening();
      if (same) return;
      listener.src = `/library-sound/${encodeURIComponent(b.dataset.listenLib)}`;
      listener.play().catch((error) => toast(error.message, "bad"));
      listening = b;
      b.innerHTML = EQ;
    }),
  );

  $$("[data-upload-lib]").forEach((b) =>
    b.addEventListener("click", (e) =>
      withBusy(e.currentTarget, async () => {
        const result = await api(`/api/sounds/library/upload?hash=${encodeURIComponent(b.dataset.uploadLib)}`, {
          method: "POST",
        });
        toast(
          result.evicted.length > 0
            ? `On the doorbell. Removed ${result.evicted.join(", ")} to make room - it is still in the library.`
            : "On the doorbell.",
          "ok",
        );
        await renderSounds();
      }),
    ),
  );

  // Rename in place: the name cell becomes a field. Enter saves, Escape
  // puts it back.
  $$("[data-rename-lib]").forEach((b) =>
    b.addEventListener("click", () => {
      const cell = b.closest("[data-lib-row]").querySelector(".lib-name");
      cell.innerHTML = `<form class="search-row">
          <input type="text" maxlength="60" value="${esc(b.dataset.name)}" aria-label="New name">
          <button type="submit" class="btn small primary">Save</button>
        </form>`;
      const form = cell.querySelector("form");
      const input = form.querySelector("input");
      input.focus();
      input.select();
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          renderSounds();
        }
      });
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name || name === b.dataset.name) return renderSounds();
        withBusy(submitter(form), async () => {
          const renamed = await api("/api/sounds/library", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hash: b.dataset.renameLib, name }),
          });
          toast(`Renamed to ${renamed.name}.`, "ok");
          await renderSounds();
        });
      });
    }),
  );

  $$("[data-replace-sound]").forEach((b) =>
    b.addEventListener("click", () => openFindSound({ id: b.dataset.replaceSound, name: b.dataset.name })),
  );

  $$("[data-del-lib]").forEach((b) =>
    b.addEventListener("click", async () => {
      const sure = await ask({
        title: `Delete ${b.dataset.name}?`,
        body: "It is removed from the library, and from the doorbell too.",
        ok: "Delete",
        danger: true,
        icon: "trash",
      });
      if (!sure) return;
      try {
        const result = await api(`/api/sounds/library?hash=${encodeURIComponent(b.dataset.delLib)}`, {
          method: "DELETE",
        });
        toast(
          result.fromDoorbell === "kept"
            ? `Deleted. It is still on the doorbell because a doorbell is playing it.`
            : "Deleted.",
          "ok",
        );
        await renderSounds();
      } catch (error) {
        toast(error.message, "bad");
      }
    }),
  );

  $("#relink-sounds")?.addEventListener("click", (e) =>
    withBusy(e.currentTarget, async () => {
      const { relinked } = await api("/api/sounds/relink", { method: "POST" });
      toast(
        relinked.length === 0
          ? "Nothing matched by name."
          : `Re-linked ${relinked.map((r) => r.name).join(", ")}.`,
        "ok",
      );
      await renderSounds();
    }),
  );

  $$("[data-del-sound]").forEach((b) =>
    b.addEventListener("click", async () => {
      const sure = await ask({
        title: b.dataset.managed ? `Remove ${b.dataset.name} from the doorbell?` : `Delete ${b.dataset.name}?`,
        body: b.dataset.managed
          ? "It stays in the library and goes back on when a theme needs it."
          : "This is the only copy - it cannot be undone.",
        ok: b.dataset.managed ? "Remove" : "Delete for good",
        danger: true,
        icon: "trash",
      });
      if (!sure) return;
      try {
        await api(`/api/ringtones?id=${encodeURIComponent(b.dataset.delSound)}`, { method: "DELETE" });
        toast(b.dataset.managed ? "Removed from the doorbell - still in the library." : "Deleted.", "ok");
        await renderSounds();
      } catch (error) {
        toast(error.message, "bad");
      }
    }),
  );
}

// An uploaded file goes through the same trim editor as a found one, and
// into the library, rather than straight onto the doorbell.
async function uploadSound(file) {
  sound.replaces = null;
  const form = new FormData();
  form.append("file", file);
  try {
    const staged = await api("/api/staging/upload?kind=audio", { method: "POST", body: form });
    showStagedSound(staged, file.name);
    soundView("edit");
    $("#sound-back").hidden = true; // nothing was searched, so nothing to go back to
    $("#sound-dialog").showModal();
    $("#wave-play-sel").focus(); // showModal moves focus itself
  } catch (error) {
    toast(error.message, "bad");
  }
}

$("#upload-sound").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  await uploadSound(file);
  event.target.value = "";
});

/**
 * Drop a file anywhere on Images or Sounds to upload it - the same as the
 * Upload button, without the file picker.
 */
{
  const DROPS = {
    media: { accepts: (f) => f.type === "image/gif", upload: uploadGif, what: "a GIF" },
    sounds: { accepts: (f) => f.type.startsWith("audio/"), upload: uploadSound, what: "a sound" },
  };
  let depth = 0;
  const target = () => (document.querySelector("dialog[open]") ? null : DROPS[currentTab]);
  const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

  document.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event) || !target()) return;
    depth++;
    $("#drop-what").textContent = target().what;
    $("#drop").hidden = false;
  });
  document.addEventListener("dragleave", () => {
    if (depth > 0 && --depth === 0) $("#drop").hidden = true;
  });
  document.addEventListener("dragover", (event) => {
    if (carriesFiles(event) && target()) event.preventDefault();
  });
  document.addEventListener("drop", (event) => {
    depth = 0;
    $("#drop").hidden = true;
    const drop = target();
    if (!drop || !carriesFiles(event)) return;
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (!drop.accepts(file)) {
      toast(`That is not ${drop.what}.`, "bad");
      return;
    }
    drop.upload(file);
  });
}

// --------------------------------------------------------------- importing
//
// Find something, then crop or trim it, then keep it - without the round
// trip through another site, an image editor and the upload button. Each
// dialog has two views, so Back returns to the search results intact.

const secs = (n) => `${Number(n).toFixed(1)}s`;
const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);
const postJson = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** A filename from a title: lower case, hyphens, nothing a filesystem minds. */
const slug = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "imported";

/** The last path segment of a link, as a name to start from. */
function nameFromLink(link) {
  try {
    return decodeURIComponent(new URL(link).pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- GIFs

const gif = { query: "", next: null, staged: null, crop: null, rendered: null, fromLibrary: false };

function gifView(view) {
  $("#gif-find").hidden = view !== "find";
  $("#gif-edit").hidden = view !== "edit";
  // Arriving from a library tile there is no search to go back to.
  $("#gif-back").hidden = view !== "edit" || gif.fromLibrary;
  $("#gif-keep").hidden = view !== "edit";
  $("#gif-dialog-title").textContent = view === "edit" ? "Crop and trim" : "Find a GIF";
}

$("#find-gif").addEventListener("click", () => {
  // Unknown until the Now tab has loaded; offer search and let the server
  // say if there is no key, rather than hiding it on a guess.
  const searchable = state?.importing?.gifSearch !== false;
  $("#gif-search-form").hidden = !searchable;
  $("#gif-search-off").hidden = searchable;
  gif.fromLibrary = false;
  gifView("find");
  $("#gif-dialog").showModal();
  (searchable ? $("#gif-q") : $("#gif-link")).focus();
});

$("#gif-close").addEventListener("click", () => $("#gif-dialog").close());
$("#gif-back").addEventListener("click", () => gifView("find"));

async function searchGifs(append) {
  const offset = append ? gif.next : 0;
  const page = await api(`/api/search/gifs?q=${encodeURIComponent(gif.query)}&offset=${offset}`);
  gif.next = page.next;
  const tiles = page.results
    .map(
      (r) => `<button type="button" class="result-tile" data-link="${esc(r.url)}" data-title="${esc(r.title)}" title="${esc(r.title)}">
        <img loading="lazy" alt="${esc(r.title)}" src="${esc(r.previewUrl)}">
      </button>`,
    )
    .join("");
  if (append) $("#gif-results").insertAdjacentHTML("beforeend", tiles);
  else $("#gif-results").innerHTML = tiles || `<p class="sub">Nothing found for “${esc(gif.query)}”.</p>`;
  $("#gif-more").hidden = page.next === null;
}

$("#gif-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  gif.query = $("#gif-q").value.trim();
  if (gif.query) withBusy(submitter(event.target), () => searchGifs(false));
});

$("#gif-more").addEventListener("click", (e) => withBusy(e.currentTarget, () => searchGifs(true)));

// Delegated, because results are appended page by page.
$("#gif-results").addEventListener("click", (event) => {
  const tile = event.target.closest("[data-link]");
  if (tile) withBusy(tile, () => stageGif({ link: tile.dataset.link }, tile.dataset.title));
});

$("#gif-link-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const link = $("#gif-link").value.trim();
  if (link) withBusy(submitter(event.target), () => stageGif({ link }, nameFromLink(link)));
});

async function cropFromLibrary(filename) {
  gif.fromLibrary = true;
  await stageGif({ filename }, `${filename.replace(/\.gif$/i, "")}-square`);
  $("#gif-dialog").showModal();
}

async function stageGif(request, suggestedName) {
  const staged = await postJson("/api/staging", { ...request, kind: "gif" });
  gif.staged = staged;
  gif.crop = { ...staged.crop };
  gif.rendered = null;

  // Giphy names everything "giphy.gif"; that is not a name, it is a host.
  const name = slug(suggestedName);
  $("#gif-name").value = `${name === "giphy" ? "imported" : name}.gif`;
  $("#gif-result").hidden = true;

  const animated = staged.durationSeconds > 0 && staged.frames > 1;
  for (const id of ["#gif-start", "#gif-end"]) {
    $(id).closest("label").hidden = !animated;
    $(id).max = staged.durationSeconds.toFixed(2);
  }
  $("#gif-start").value = 0;
  $("#gif-end").value = staged.durationSeconds;
  updateGifTrim();

  $("#crop-img").src = `/staging/${encodeURIComponent(staged.id)}`;
  gifView("edit");
}

/** Anything that changes the result means the preview no longer shows it. */
function invalidateGif() {
  gif.rendered = null;
  $("#gif-result").hidden = true;
}

function updateGifTrim(moved) {
  const st = gif.staged;
  if (!st) return;
  const start = $("#gif-start");
  const end = $("#gif-end");
  // Keep the handles a tenth of a second apart and the right way round,
  // pushing whichever one was not just moved.
  if (Number(end.value) - Number(start.value) < 0.1) {
    if (moved === start) start.value = Math.max(0, Number(end.value) - 0.1);
    else end.value = Math.min(st.durationSeconds, Number(start.value) + 0.1);
  }

  $("#gif-start-label").textContent = `— ${secs(start.value)}`;
  $("#gif-end-label").textContent = `— ${secs(end.value)} of ${secs(st.durationSeconds)}`;

  if (!(st.durationSeconds > 0 && st.frames > 1)) {
    $("#gif-estimate").textContent = "A still image - it will be cropped and scaled to the screen.";
    return;
  }
  const length = Number(end.value) - Number(start.value);
  const frames = Math.round((length * st.frames) / st.durationSeconds);
  $("#gif-estimate").textContent =
    frames > st.safeFrames
      ? `${secs(length)}, about ${frames} frames. Each frame will be held a little longer to bring it to ${st.safeFrames}, which always fits.`
      : `${secs(length)}, about ${frames} frames. That always fits.`;
}

for (const id of ["#gif-start", "#gif-end"]) {
  $(id).addEventListener("input", (e) => {
    updateGifTrim(e.target);
    invalidateGif();
  });
}

function drawCrop() {
  const img = $("#crop-img");
  if (!gif.staged || !img.clientWidth) return;
  const scale = img.clientWidth / gif.staged.width;
  const box = $("#crop-box");
  box.style.left = `${gif.crop.x * scale}px`;
  box.style.top = `${gif.crop.y * scale}px`;
  box.style.width = box.style.height = `${gif.crop.size * scale}px`;
}

$("#crop-img").addEventListener("load", drawCrop);
// The image resizes with the dialog, and the box has to follow it.
new ResizeObserver(drawCrop).observe($("#crop-img"));

/**
 * Drag the square to move it, its corner to resize it. Pointer events and
 * capture, so it works the same with a mouse, a finger or a pen, and keeps
 * tracking when the pointer leaves the box mid-drag.
 */
let cropDrag = null;
const cropBox = $("#crop-box");

cropBox.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  cropDrag = {
    mode: event.target.id === "crop-handle" ? "resize" : "move",
    x: event.clientX,
    y: event.clientY,
    from: { ...gif.crop },
    scale: $("#crop-img").clientWidth / gif.staged.width,
  };
  cropBox.setPointerCapture(event.pointerId);
});

cropBox.addEventListener("pointermove", (event) => {
  if (!cropDrag) return;
  const dx = (event.clientX - cropDrag.x) / cropDrag.scale;
  const dy = (event.clientY - cropDrag.y) / cropDrag.scale;
  const { width, height } = gif.staged;
  const from = cropDrag.from;

  if (cropDrag.mode === "move") {
    gif.crop = {
      size: from.size,
      x: clamp(from.x + dx, 0, width - from.size),
      y: clamp(from.y + dy, 0, height - from.size),
    };
  } else {
    // Square, so one number: whichever way the corner moved further.
    const room = Math.min(width - from.x, height - from.y);
    gif.crop = { ...from, size: clamp(from.size + Math.max(dx, dy), 24, room) };
  }
  drawCrop();
  invalidateGif();
});

for (const type of ["pointerup", "pointercancel"]) {
  cropBox.addEventListener(type, () => (cropDrag = null));
}

async function renderGifPreview() {
  const result = await postJson("/api/media/render", {
    id: gif.staged.id,
    crop: gif.crop,
    start: Number($("#gif-start").value),
    end: Number($("#gif-end").value),
  });
  gif.rendered = result;
  const [kind, label] = VERDICT[result.verdict] ?? ["mute", "unreadable"];
  $("#gif-result-img").src = `/staging/${encodeURIComponent(result.id)}`;
  $("#gif-result-facts").innerHTML =
    `<span class="badge ${kind}">${esc(label)}</span><span>${result.frames} frames</span><span>${kb(result.bytes)}</span>`;
  $("#gif-result").hidden = false;
  return result;
}

$("#gif-preview").addEventListener("click", (e) => withBusy(e.currentTarget, renderGifPreview));

// Saving without previewing first renders on the way, rather than making
// Preview a compulsory extra click.
$("#gif-keep").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
    const rendered = gif.rendered ?? (await renderGifPreview());
    const result = await postJson("/api/media/keep", {
      id: rendered.id,
      filename: $("#gif-name").value.trim(),
    });
    toast(
      result.duplicateOf ? `Already in the library as ${result.duplicateOf}.` : `Added ${result.filename}.`,
      "ok",
    );
    $("#gif-dialog").close();
    await renderMedia();
  }),
);

// --------------------------------------------------------------- sounds

const sound = { query: "", next: null, staged: null, rendered: null, replaces: null };

/** One player for every Listen button, so two never talk over each other. */
const listener = new Audio();
let listening = null;

function stopListening() {
  listener.pause();
  if (listening) listening.innerHTML = icon("play");
  listening = null;
}
listener.addEventListener("ended", stopListening);

function soundView(view) {
  $("#sound-find").hidden = view !== "find";
  $("#sound-edit").hidden = view !== "edit";
  $("#sound-back").hidden = view !== "edit";
  $("#sound-keep").hidden = view !== "edit";
  $("#sound-preview").hidden = view !== "edit";
  // Otherwise focus is left on whatever the dialog picked - More options, as
  // it happens, where the next Space opens it instead of playing.
  if (view === "edit") $("#wave-play-sel").focus();
  $("#sound-dialog-title").textContent =
    view === "edit" ? "Trim the sound" : sound.replaces ? `Replace "${sound.replaces.name}"` : "Find a sound";
}

/**
 * Open Find a sound. With `replaces`, it is finding again a sound that is
 * only on the doorbell: the search starts with its name, the result is
 * saved under that name, and saving moves its themes across and retires
 * the old copy.
 */
function openFindSound(replaces = null) {
  sound.replaces = replaces;
  const searchable = state?.importing?.soundSearch !== false;
  $("#sound-search-form").hidden = !searchable;
  $("#sound-search-off").hidden = searchable;
  $("#sound-video-hint").textContent = state?.importing?.videoLinks
    ? "YouTube and other video links work too - the audio is pulled out for you to trim."
    : "";
  $("#sound-dialog-title").textContent = replaces ? `Replace "${replaces.name}"` : "Find a sound";
  soundView("find");
  $("#sound-dialog").showModal();
  if (replaces && searchable) {
    $("#sound-q").value = replaces.name;
    sound.query = replaces.name;
    withBusy(submitter($("#sound-search-form")), () => searchSounds(false));
  }
  (searchable ? $("#sound-q") : $("#sound-link")).focus();
}

$("#find-sound").addEventListener("click", () => openFindSound());

$("#sound-close").addEventListener("click", () => $("#sound-dialog").close());
$("#sound-back").addEventListener("click", () => {
  stopWave();
  soundView("find");
});

// Nothing should keep playing behind a closed dialog.
$("#sound-dialog").addEventListener("close", () => {
  stopListening();
  stopWave();
  $("#sound-result-audio").pause();
});

async function searchSounds(append) {
  const pageNumber = append ? sound.next : 1;
  const page = await api(`/api/search/sounds?q=${encodeURIComponent(sound.query)}&page=${pageNumber}`);
  sound.next = page.next;
  const rows = page.results
    .map(
      (r) => `<div class="sound-row">
        <button type="button" class="btn small" data-listen="${esc(r.previewUrl)}" aria-label="Listen to ${esc(r.name)}">${icon("play")}</button>
        <div class="grow">
          <div class="fname">${esc(r.name)}</div>
          <div class="facts">
            <span>${secs(r.durationSeconds)}</span>
            <span class="badge mute" title="Licence">${esc(r.licence)}</span>
            <a href="${esc(r.pageUrl)}" target="_blank" rel="noopener noreferrer">by ${esc(r.author)}</a>
          </div>
        </div>
        <button type="button" class="btn small primary" data-use="${esc(r.previewUrl)}" data-name="${esc(r.name)}">Use</button>
      </div>`,
    )
    .join("");
  if (append) $("#sound-results").insertAdjacentHTML("beforeend", rows);
  else $("#sound-results").innerHTML = rows || `<p class="sub">Nothing found for “${esc(sound.query)}”.</p>`;
  $("#sound-more").hidden = page.next === null;
}

$("#sound-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sound.query = $("#sound-q").value.trim();
  if (sound.query) withBusy(submitter(event.target), () => searchSounds(false));
});

$("#sound-more").addEventListener("click", (e) => withBusy(e.currentTarget, () => searchSounds(true)));

$("#sound-results").addEventListener("click", (event) => {
  const listen = event.target.closest("[data-listen]");
  if (listen) {
    const same = listening === listen;
    stopListening();
    if (same) return;
    listener.src = listen.dataset.listen;
    listener.play().catch((error) => toast(error.message, "bad"));
    listening = listen;
    listen.innerHTML = EQ;
    return;
  }
  const use = event.target.closest("[data-use]");
  if (use) {
    stopListening();
    withBusy(use, () => stageSound({ link: use.dataset.use }, use.dataset.name));
  }
});

$("#sound-link-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const link = $("#sound-link").value.trim();
  if (link) withBusy(submitter(event.target), () => stageSound({ link }, nameFromLink(link)));
});

async function stageSound(request, suggestedName) {
  showStagedSound(await postJson("/api/staging", { ...request, kind: "audio" }), suggestedName);
  soundView("edit");
}

/**
 * The waveform editor.
 *
 * The Start/End/Fade number fields are the one source of truth. Dragging a
 * handle writes to them, typing in them moves the handles, and the render
 * reads them - so the picture and the request sent can never disagree.
 *
 * `view` is the stretch of the sound on screen, in seconds: all of it until
 * someone zooms. Zoomed in, the server decodes just that stretch again
 * (`detail`), because the overview's thousand slices across a long song are
 * too coarse to see where a word starts.
 */
const wave = {
  peaks: null,
  duration: 0,
  cursor: 0,
  stopAt: null,
  frame: 0,
  view: { from: 0, to: 0 },
  detail: null,
  detailTimer: 0,
  gain: 1,
};

/** The narrowest the view gets: a quarter of a second fills the width. */
const MIN_SPAN = 0.25;

const selection = () => ({ start: Number($("#sound-start").value) || 0, end: Number($("#sound-end").value) || 0 });
const fades = () => ({
  in: clamp(Number($("#sound-fade-in").value) || 0, 0, 5),
  out: clamp(Number($("#sound-fade-out").value) || 0, 0, 5),
});
const span = () => wave.view.to - wave.view.from;
const zoomed = () => span() < wave.duration - 1e-6;

function showStagedSound(staged, suggestedName) {
  sound.staged = staged;
  sound.rendered = null;

  $("#sound-source").src = `/staging/${encodeURIComponent(staged.id)}`;
  $("#sound-source").controls = false;
  for (const id of ["#sound-start", "#sound-end"]) $(id).max = staged.durationSeconds.toFixed(2);
  $("#sound-start").value = 0;
  $("#sound-end").value = staged.durationSeconds.toFixed(2);
  $("#sound-fade-in").value = 0;
  $("#sound-fade-out").value = 0;
  // A replacement keeps the name of what it replaces, so the doorbell and
  // every theme carry on calling it the same thing.
  $("#sound-name").value = String(sound.replaces?.name ?? suggestedName ?? "")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .trim()
    .slice(0, 60);
  $("#sound-result").hidden = true;

  wave.peaks = null;
  wave.detail = null;
  wave.gain = 1;
  wave.duration = staged.durationSeconds;
  wave.cursor = 0;
  wave.view = { from: 0, to: staged.durationSeconds };
  $("#wave").hidden = false;
  $("#wave-msg").hidden = false;
  updateSoundLength();
  drawWave();
  loadPeaks(staged.id);
}

async function loadPeaks(id) {
  try {
    const { peaks } = await api(`/api/staging/peaks?id=${encodeURIComponent(id)}&buckets=2000`);
    if (sound.staged?.id !== id) return; // another sound was opened meanwhile
    wave.peaks = peaks;
    // Drawn to the loudest moment rather than to full scale, so a quiet
    // recording still shows its shape - and the gaps between words, which
    // are where a cut wants to go. Capped, or near-silence would become
    // a wall of hiss.
    const loudest = peaks.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    wave.gain = loudest > 0 ? Math.min(0.95 / loudest, 8) : 1;
    $("#wave-msg").hidden = true;
  } catch {
    if (sound.staged?.id !== id) return;
    // No picture, but still a way to listen, and the fields to trim with.
    $("#wave").hidden = true;
    $("#sound-source").controls = true;
  }
  drawWave();
}

/**
 * Fetch real detail for what is on screen, a moment after the view stops
 * changing. Half a view extra each side, so a small scroll stays sharp.
 */
function scheduleDetail() {
  clearTimeout(wave.detailTimer);
  if (!zoomed() || !sound.staged) {
    wave.detail = null;
    return;
  }
  const d = wave.detail;
  if (d && d.from <= wave.view.from && d.to >= wave.view.to && d.to - d.from <= span() * 3) return;

  wave.detailTimer = setTimeout(async () => {
    const id = sound.staged?.id;
    const from = Math.max(0, wave.view.from - span() / 2);
    const to = Math.min(wave.duration, wave.view.to + span() / 2);
    const buckets = clamp(Math.round($("#wave-canvas").clientWidth * 2 * ((to - from) / span())), 200, 4000);
    try {
      const { peaks } = await api(
        `/api/staging/peaks?id=${encodeURIComponent(id)}&buckets=${buckets}&start=${from.toFixed(3)}&end=${to.toFixed(3)}`,
      );
      if (sound.staged?.id !== id) return;
      wave.detail = { from, to, peaks };
      drawWave();
    } catch {
      // The overview, stretched, is still a usable picture.
    }
  }, 150);
}

/** Show `from`..`to`, kept inside the sound and no narrower than MIN_SPAN. */
function setView(from, to) {
  const width = clamp(to - from, Math.min(MIN_SPAN, wave.duration), wave.duration);
  const start = clamp(from, 0, wave.duration - width);
  wave.view = { from: start, to: start + width };
  scheduleDetail();
  drawWave();
}

/** Zoom by `factor` (under 1 is in), keeping the moment `around` where it is. */
function zoomBy(factor, around) {
  const { from } = wave.view;
  const at = around ?? (wave.cursor >= from && wave.cursor <= wave.view.to ? wave.cursor : from + span() / 2);
  const width = clamp(span() * factor, Math.min(MIN_SPAN, wave.duration), wave.duration);
  const left = at - (at - from) * (width / span());
  setView(left, left + width);
}

/** The quietest and loudest sample between two moments, from the sharpest data there is. */
function peakBetween(t0, t1) {
  const d = wave.detail;
  const src =
    d && t0 >= d.from && t1 <= d.to ? d : wave.peaks ? { from: 0, to: wave.duration, peaks: wave.peaks } : null;
  if (!src) return null;
  const n = src.peaks.length / 2;
  const len = src.to - src.from;
  const b0 = clamp(Math.floor(((t0 - src.from) / len) * n), 0, n - 1);
  const b1 = clamp(Math.ceil(((t1 - src.from) / len) * n), b0 + 1, n);
  let lo = 0;
  let hi = 0;
  for (let b = b0; b < b1; b++) {
    lo = Math.min(lo, src.peaks[b * 2]);
    hi = Math.max(hi, src.peaks[b * 2 + 1]);
  }
  return [lo, hi];
}

/** How loud a moment in the clip ends up, 0..1, once the fades apply. */
function envelope(t, start, end, f) {
  let gain = 1;
  if (f.in > 0 && t < start + f.in) gain = Math.min(gain, (t - start) / f.in);
  if (f.out > 0 && t > end - f.out) gain = Math.min(gain, (end - t) / f.out);
  return clamp(gain, 0, 1);
}

/** A canvas sized for the screen it is on, cleared, with its CSS size. */
function prepare(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Tick spacing that leaves room for a label every 70px or so. */
function tickStep(seconds, width) {
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((step) => seconds / step <= width / 70) ?? 600;
}

function drawWave() {
  const box = $("#wave");
  const { start, end } = selection();
  $("#wave-cursor-label").textContent = secs(wave.cursor);
  if (box.hidden || !wave.duration) return;
  const { from, to } = wave.view;
  const width0 = to - from;

  // Handles are positioned in percent, so they are right even before the
  // canvas has a size to draw at. Off screen when zoomed past them.
  for (const [id, t] of [["#wave-start", start], ["#wave-end", end]]) {
    const handle = $(id);
    handle.hidden = t < from - 1e-6 || t > to + 1e-6;
    const at = (t - from) / width0;
    handle.style.left = `${at * 100}%`;
    // The time tab leans inwards at the ends, rather than hanging off them.
    const label = handle.querySelector(".wave-time");
    label.textContent = `${t.toFixed(2)}s`;
    label.style.transform = `translateX(${at < 0.06 ? "-12%" : at > 0.94 ? "-88%" : "-50%"})`;
    handle.setAttribute("aria-valuemin", "0");
    handle.setAttribute("aria-valuemax", wave.duration.toFixed(2));
    handle.setAttribute("aria-valuenow", t.toFixed(2));
    handle.setAttribute("aria-valuetext", secs(t));
  }

  // Read from the theme each time, so a light/dark switch is picked up.
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const faint = css.getPropertyValue("--text-faint").trim();
  const text = css.getPropertyValue("--text").trim();
  const f = fades();

  const main = prepare($("#wave-canvas"));
  if (main) {
    const { ctx, width, height } = main;
    const mid = height / 2;
    const perPx = width0 / width;

    if (wave.peaks) {
      for (let x = 0; x < width; x++) {
        const t = from + x * perPx;
        const peak = peakBetween(t, t + perPx);
        if (!peak) break;
        const [lo, hi] = peak;
        const bar = (scale) => {
          const top = mid - Math.min(1, hi * wave.gain) * mid * scale;
          const bottom = mid - Math.max(-1, lo * wave.gain) * mid * scale;
          ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
        };
        if (t < start || t > end) {
          // Cut away: still visible, so you can see what you are leaving out.
          ctx.globalAlpha = 0.45;
          ctx.fillStyle = faint;
          bar(1);
          continue;
        }
        // Kept: the full wave faintly, and what survives the fades solidly,
        // so a fade reads as the shape it will give the sound.
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.25;
        bar(1);
        ctx.globalAlpha = 1;
        bar(envelope(t, start, end, f));
      }
      ctx.globalAlpha = 1;
    }

    // A time ruler along the bottom, so a zoomed view says where it is.
    const step = tickStep(width0, width);
    ctx.fillStyle = faint;
    ctx.font = `10px ${css.getPropertyValue("--mono")}`;
    for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
      const x = Math.round(((t - from) / width0) * width);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x, height - 6, 1, 6);
      ctx.globalAlpha = 0.9;
      ctx.fillText(`${Number(t.toFixed(2))}s`, x + 3, height - 3);
    }
    ctx.globalAlpha = 1;

    // The cursor: where "From" starts, and where Here takes its time.
    if (wave.cursor >= from && wave.cursor <= to) {
      ctx.fillStyle = text;
      ctx.fillRect(Math.round(((wave.cursor - from) / width0) * width), 0, 1.5, height);
    }
  }

  drawOverview(accent, faint, start, end);
}

/** The whole sound, small, with the zoomed-in stretch boxed. Only shown zoomed. */
function drawOverview(accent, faint, start, end) {
  $("#wave-overview").hidden = !zoomed();
  if (!zoomed()) return;
  const view = $("#wave-view");
  view.style.left = `${(wave.view.from / wave.duration) * 100}%`;
  view.style.width = `${(span() / wave.duration) * 100}%`;

  const mini = prepare($("#wave-overview-canvas"));
  if (!mini || !wave.peaks) return;
  const { ctx, width, height } = mini;
  const mid = height / 2;
  const perPx = wave.duration / width;
  const n = wave.peaks.length / 2;
  for (let x = 0; x < width; x++) {
    const t = x * perPx;
    const b0 = Math.floor((t / wave.duration) * n);
    const b1 = Math.max(b0 + 1, Math.ceil(((t + perPx) / wave.duration) * n));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < b1 && b < n; b++) {
      lo = Math.min(lo, wave.peaks[b * 2]);
      hi = Math.max(hi, wave.peaks[b * 2 + 1]);
    }
    ctx.fillStyle = t >= start && t <= end ? accent : faint;
    ctx.globalAlpha = t >= start && t <= end ? 0.8 : 0.4;
    const top = mid - Math.min(1, hi * wave.gain) * mid;
    ctx.fillRect(x, top, 1, Math.max(1, mid - Math.max(-1, lo * wave.gain) * mid - top));
  }
  ctx.globalAlpha = 1;
}

new ResizeObserver(() => {
  drawWave();
  scheduleDetail();
}).observe($("#wave"));

/** Seconds at a point across the waveform, in whatever is on screen. */
function timeAt(clientX) {
  const rect = $("#wave").getBoundingClientRect();
  return wave.view.from + clamp((clientX - rect.left) / rect.width, 0, 1) * span();
}

/** Move one end of the selection, keeping them a tenth of a second apart. */
function setEdge(which, t) {
  const { start, end } = selection();
  if (which === "start") $("#sound-start").value = clamp(t, 0, end - 0.1).toFixed(2);
  else $("#sound-end").value = clamp(t, start + 0.1, wave.duration).toFixed(2);
  updateSoundLength();
  invalidateSound();
  drawWave();
}

for (const [id, which] of [["#wave-start", "start"], ["#wave-end", "end"]]) {
  const handle = $(id);
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    // Not a click on the waveform behind it, which would start playback.
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "1";
    handle.focus();
  });
  handle.addEventListener("pointermove", (event) => {
    if (handle.dataset.dragging) setEdge(which, timeAt(event.clientX));
  });
  for (const type of ["pointerup", "pointercancel"]) {
    handle.addEventListener(type, () => delete handle.dataset.dragging);
  }
  // Finer the further in you are: a tenth of a second across a whole song,
  // a hundredth when zoomed to a word. Shift moves ten times as far.
  handle.addEventListener("keydown", (event) => {
    const fine = span() > 20 ? 0.1 : span() > 4 ? 0.05 : 0.01;
    const step = event.shiftKey ? fine * 10 : fine;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    event.preventDefault();
    setEdge(which, selection()[which] + delta);
  });
}

// Ctrl/Cmd + scroll (and a trackpad pinch, which arrives as one) zooms
// around the pointer; scrolling sideways moves along. Plain vertical
// scrolling is left alone so the dialog still scrolls.
$("#wave").addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomBy(Math.exp(clamp(event.deltaY, -50, 50) * 0.01), timeAt(event.clientX));
      return;
    }
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (!sideways || !zoomed()) return;
    event.preventDefault();
    const shift = (sideways / $("#wave").clientWidth) * span();
    setView(wave.view.from + shift, wave.view.to + shift);
  },
  { passive: false },
);

$("#wave-zoom-in").addEventListener("click", () => zoomBy(0.5));
$("#wave-zoom-out").addEventListener("click", () => zoomBy(2));
$("#wave-zoom-fit").addEventListener("click", () => setView(0, wave.duration));
$("#wave-zoom-sel").addEventListener("click", () => {
  const { start, end } = selection();
  const pad = (end - start) * 0.08;
  setView(start - pad, end + pad);
});

// The overview: press anywhere to centre the view there, or drag the box.
{
  const overview = $("#wave-overview");
  let grab = null;
  const timeOnOverview = (clientX) => {
    const rect = overview.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * wave.duration;
  };
  overview.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    overview.setPointerCapture(event.pointerId);
    const t = timeOnOverview(event.clientX);
    // Inside the box, hold it where it was grabbed; outside, centre on it.
    grab = t >= wave.view.from && t <= wave.view.to ? t - wave.view.from : span() / 2;
    setView(t - grab, t - grab + span());
  });
  overview.addEventListener("pointermove", (event) => {
    if (grab === null) return;
    const t = timeOnOverview(event.clientX);
    setView(t - grab, t - grab + span());
  });
  for (const type of ["pointerup", "pointercancel"]) overview.addEventListener(type, () => (grab = null));
}

/**
 * Play from a moment, stopping at `stopAt` if given. Driven by animation
 * frames rather than timeupdate, which fires only a few times a second -
 * too coarse to stop on a cut or to move the cursor smoothly.
 */
async function playFrom(t, stopAt) {
  const audio = $("#sound-source");
  stopListening();
  $("#sound-result-audio").pause();
  cancelAnimationFrame(wave.frame);
  wave.cursor = t;
  wave.stopAt = stopAt;
  // A seek before the browser knows how long the file is can be ignored,
  // and playback then starts from zero.
  if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
    await new Promise((resolve) => audio.addEventListener("loadedmetadata", resolve, { once: true }));
  }
  audio.currentTime = t;
  audio.play().catch((error) => toast(error.message, "bad"));
  const step = () => {
    if (audio.paused) return drawWave();
    if (wave.stopAt !== null && audio.currentTime >= wave.stopAt) {
      audio.pause();
      wave.cursor = wave.stopAt;
      return drawWave();
    }
    wave.cursor = audio.currentTime;
    // Zoomed in, the view turns the page as playback runs off its edge.
    if (zoomed() && (wave.cursor > wave.view.to || wave.cursor < wave.view.from)) {
      setView(wave.cursor - span() * 0.05, wave.cursor + span() * 0.95);
    } else {
      drawWave();
    }
    wave.frame = requestAnimationFrame(step);
  };
  wave.frame = requestAnimationFrame(step);
}

function stopWave() {
  $("#sound-source").pause();
  cancelAnimationFrame(wave.frame);
  drawWave();
}

/** Up to the end of the selection when starting inside it; to the end otherwise. */
const playFromHere = (t) => playFrom(t, t < selection().end ? selection().end : null);
const playSelection = () => playFrom(selection().start, selection().end);

$("#wave").addEventListener("pointerdown", (event) => {
  if (event.target.closest(".wave-handle")) return;
  playFromHere(timeAt(event.clientX));
});
$("#wave-play-sel").addEventListener("click", playSelection);
$("#wave-play-cursor").addEventListener("click", () => playFromHere(wave.cursor));
$("#wave-stop").addEventListener("click", stopWave);

// Space plays the selection, or stops - except while typing in a field.
$("#sound-dialog").addEventListener("keydown", (event) => {
  if (event.key !== " " || $("#sound-edit").hidden) return;
  if (event.target.closest("input, textarea, select, button, summary")) return;
  event.preventDefault();
  if ($("#sound-source").paused) playSelection();
  else stopWave();
});

// With no waveform, the native controls are how you listen; keep the
// cursor following them so Here still means "where I paused".
$("#sound-source").addEventListener("timeupdate", () => {
  if (!$("#sound-source").controls) return;
  wave.cursor = $("#sound-source").currentTime;
  $("#wave-cursor-label").textContent = secs(wave.cursor);
});

function invalidateSound() {
  sound.rendered = null;
  $("#sound-result").hidden = true;
  $("#sound-result-audio").pause();
}

function updateSoundLength() {
  const length = Number($("#sound-end").value) - Number($("#sound-start").value);
  $("#sound-length").textContent =
    length <= 0
      ? "The end is before the start."
      : `${secs(length)} of ${secs(sound.staged.durationSeconds)}.` +
        (length > 10 ? " That is long for a doorbell - most ring sounds are a few seconds." : "");
}

for (const id of ["#sound-start", "#sound-end", "#sound-fade-in", "#sound-fade-out"]) {
  $(id).addEventListener("input", () => {
    updateSoundLength();
    invalidateSound();
    drawWave();
  });
}
$("#sound-normalise").addEventListener("change", invalidateSound);

// Click the waveform where it should start, press Here.
for (const [button, which] of [["#sound-mark-start", "start"], ["#sound-mark-end", "end"]]) {
  $(button).addEventListener("click", () => setEdge(which, wave.cursor));
}

async function renderSoundPreview() {
  const result = await postJson("/api/ringtones/render", {
    id: sound.staged.id,
    start: Number($("#sound-start").value),
    end: Number($("#sound-end").value),
    normalise: $("#sound-normalise").checked,
    fadeIn: fades().in,
    fadeOut: fades().out,
  });
  sound.rendered = result;
  $("#sound-result-audio").src = `/staging/${encodeURIComponent(result.id)}`;
  $("#sound-result-facts").innerHTML = `<span>${secs(result.durationSeconds)}</span><span>${kb(result.bytes)} MP3</span>`;
  $("#sound-result").hidden = false;
  return result;
}

// Renders exactly what will be saved and plays it. The player for it sits
// under More options; this button is the usual way to hear it.
$("#sound-preview").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
    stopWave();
    if (!sound.rendered) await renderSoundPreview();
    $("#sound-result-audio").currentTime = 0;
    $("#sound-result-audio").play().catch(() => {});
  }),
);

$("#sound-keep").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
    const name = $("#sound-name").value.trim();
    if (!name) throw new Error("Give the sound a name.");
    const rendered = sound.rendered ?? (await renderSoundPreview());
    const result = await postJson("/api/sounds/library", {
      id: rendered.id,
      name,
      upload: $("#sound-upload-now").checked,
      replaces: sound.replaces?.id,
    });
    const evicted = result.onDoorbell?.evicted ?? [];
    toast(
      (result.duplicate ? `Already in the library as ${result.name}.` : `Added ${result.name} to the library.`) +
        (result.replaced === "removed" ? " The old copy is gone from the doorbell, and its themes use this one now." : "") +
        (result.replaced === "linked" ? " Its themes use this one now; the old copy stays on the doorbell while it is playing." : "") +
        (result.adopted?.length ? ` Linked to "${result.adopted.join('", "')}" already on the doorbell - Doorman manages it now.` : "") +
        (result.onDoorbell ? " It is on the doorbell now." : "") +
        (evicted.length > 0 ? ` Removed ${evicted.join(", ")} to make room - still in the library.` : ""),
      "ok",
    );
    $("#sound-dialog").close();
    await renderSounds();
  }),
);

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
  if (devices.length === 0) devices = await load("/api/devices", "calendar");
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
  if (!$("#calendar").children.length) $("#calendar").innerHTML = skeletonDays(Math.min(Number(days), 63));

  const picked = $("#cal-device").value;
  const response = await load(
    `/api/calendar?days=${days}${from ? `&from=${from}` : ""}${picked ? `&device=${encodeURIComponent(picked)}` : ""}`,
    "calendar",
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
      ? `<img class="chip-img" loading="lazy" alt="" src="/thumb/${encodeURIComponent(day.filename)}">`
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
        <section class="month enter">
          <h3 class="month-name">
            ${MONTHS[month - 1]} ${year}
            ${scheduled > 0 ? `<span class="badge accent">${scheduled} special day${scheduled === 1 ? "" : "s"}</span>` : ""}
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

let historyRows = [];
let historyFilter = "all";
let historyName = (id) => id ?? "No theme";

async function renderHistory() {
  const fresh = ticket("history");
  if (!historyRows.length) $("#history").innerHTML = `<div class="grid gap-3">${skeletonRows(5)}</div>`;

  let themeList;
  [historyRows, themeList] = await Promise.all([load("/api/applies?limit=100", "history"), load("/api/themes", "history")]);
  if (!fresh()) return;
  historyName = themeNamer(themeList);
  drawHistory();
}

/** A timeline, grouped by day, newest first. */
function drawHistory() {
  const rows = historyRows.filter((r) =>
    historyFilter === "all" ? true
    : historyFilter === "problem" ? r.outcome === "failed" || r.outcome === "no-theme"
    : r.outcome === historyFilter,
  );
  if (rows.length === 0) {
    $("#history").innerHTML = `<div class="card">${
      historyRows.length ? emptyState("Nothing here", "No runs match that filter.", "search") : emptyState("Nothing has run yet", "Every apply shows up here, with why.", "clock")
    }</div>`;
    return;
  }

  const days = new Map();
  for (const r of rows) {
    const key = new Date(r.at).toDateString();
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(r);
  }
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  $("#history").innerHTML = [...days.entries()]
    .map(
      ([key, entries]) => `
      <section class="enter mb-6">
        <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">${
          key === today ? "Today" : key === yesterday ? "Yesterday" : new Date(key).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
        }</h3>
        <ol class="card flush">
          ${entries
            .map((r) => {
              const o = outcomeOf(r.outcome);
              return `<li class="relative flex gap-4 border-t border-line px-5 py-3.5 first:border-t-0">
                <span class="mt-1.5 grid size-3 shrink-0 place-items-center rounded-full" style="background:color-mix(in srgb,var(${o.mark}) 25%,transparent)"><span class="size-1.5 rounded-full" style="background:var(${o.mark})"></span></span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold">${esc(historyName(r.themeId))}</span>
                    <span class="badge ${o.badge}">${esc(o.label)}</span>
                    ${r.deviceName ? `<span class="chip">${icon("bell")}${esc(r.deviceName)}</span>` : ""}
                    <span class="ml-auto text-xs tabular-nums text-faint" title="${esc(new Date(r.at).toLocaleString())}">${esc(new Date(r.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }))}</span>
                  </div>
                  <div class="mt-1 text-[13px] text-dim [overflow-wrap:anywhere]">${esc(r.reason)}</div>
                </div>
              </li>`;
            })
            .join("")}
        </ol>
      </section>`,
    )
    .join("");
}

segmented("#history-filter", (filter) => {
  historyFilter = filter;
  drawHistory();
});

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
  requestAnimationFrame(placeNavPill);
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
  // Links and bookmarks from before tabs had paths used #fragments.
  const legacy = location.hash.slice(1);
  if (TABS.includes(legacy)) history.replaceState(null, "", PAGES[legacy].path);

  const initial = tabAt(location.pathname);
  document.title = `${PAGES[initial].title} · Doorman`;
  if (initial !== "now") show(initial, { push: false });
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

  for (const id of ["#who", "#who-side"]) $(id).textContent = session.username ?? "";
  for (const id of ["#avatar", "#avatar-big"]) $(id).textContent = (session.username ?? "?").slice(0, 1);
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
