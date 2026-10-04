/**
 * Create and inspect themes, until there is a UI.
 *
 *   node src/cli/themes.ts list
 *   node src/cli/themes.ts ringtones
 *   node src/cli/themes.ts add --id xmas --name Christmas \
 *        --image Elf_santa.gif --sound 6933fcd40050f903e46e1a88 \
 *        --priority 10 --dates 12-01..12-26
 *   node src/cli/themes.ts remove xmas
 *
 * Rules:
 *   --dates MM-DD..MM-DD    wraps, so 12-20..01-05 is valid
 *   --weekdays 0,5,6        0 is Sunday
 *   --time HH:MM..HH:MM     wraps, so 22:00..06:00 is valid
 *   (none given)            always eligible
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBytes } from "../apply.ts";
import { PrivateApi } from "../device/private.ts";
import { Store } from "../store/db.ts";
import type { Rule } from "../domain/types.ts";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const store = new Store(process.env.DOORMAN_DB ?? "data/doorman.sqlite");
const mediaDir = process.env.DOORMAN_MEDIA ?? "media";

switch (command) {
  case "list": {
    const themes = store.themes();
    if (themes.length === 0) {
      console.log("No themes yet. Without one the scheduler leaves the doorbell alone.");
      break;
    }
    for (const t of themes.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
      const when = t.rules.map(describeRule).join(" OR ") || "never (no rules)";
      console.log(
        `${t.enabled ? " " : "-"} ${t.id.padEnd(22)} p${String(t.priority).padEnd(3)} ${when}`,
      );
      console.log(`    image ${t.image.slice(0, 12)}…${t.sound ? `  sound ${t.sound}` : "  (no sound)"}`);
    }
    break;
  }

  case "ringtones": {
    // Needs admin credentials, because ringtones live on the private API.
    const user = process.env.PROTECT_ADMIN_USER;
    const pass = process.env.PROTECT_ADMIN_PASS;
    if (!user || !pass || !process.env.PROTECT_HOST) {
      console.error("Needs PROTECT_HOST, PROTECT_ADMIN_USER and PROTECT_ADMIN_PASS.");
      process.exit(1);
    }
    if (process.env.PROTECT_INSECURE_TLS !== "false") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const api = new PrivateApi({ host: process.env.PROTECT_HOST, username: user, password: pass });
    for (const r of await api.ringtones()) {
      console.log(`  ${r.id}  ${r.name}${r.isDefault ? "  (stock)" : ""}`);
    }
    break;
  }

  case "add": {
    const id = flag("id");
    const image = flag("image");
    if (!id || !image) {
      console.error("add needs --id and --image");
      process.exit(1);
    }

    // Hash the bytes, not the name. Renaming a GIF must not orphan its theme,
    // and two copies under different names must not become two assets.
    let hash: string;
    try {
      hash = hashBytes(new Uint8Array(await readFile(join(mediaDir, image))));
    } catch {
      console.error(`${image} is not in ${mediaDir}/`);
      process.exit(1);
    }

    const rule: Rule = {};
    const dates = flag("dates");
    if (dates) {
      const [from, to] = dates.split("..");
      if (!from || !to) { console.error("--dates wants MM-DD..MM-DD"); process.exit(1); }
      rule.dateWindow = { from, to };
    }
    const weekdays = flag("weekdays");
    if (weekdays) rule.weekdays = weekdays.split(",").map(Number);
    const time = flag("time");
    if (time) {
      const [from, to] = time.split("..");
      if (!from || !to) { console.error("--time wants HH:MM..HH:MM"); process.exit(1); }
      rule.timeOfDay = { from, to };
    }

    store.upsertTheme({
      id,
      name: flag("name") ?? id,
      image: hash,
      sound: flag("sound"),
      priority: Number(flag("priority") ?? 0),
      enabled: true,
      rules: [rule],
    });
    console.log(`${id}: ${image}${flag("sound") ? " + sound" : ""}, ${describeRule(rule)}`);
    break;
  }

  case "remove": {
    const id = args[1];
    if (!id) { console.error("remove needs a theme id"); process.exit(1); }
    store.deleteTheme(id);
    console.log(`removed ${id}`);
    break;
  }

  default:
    console.error("Commands: list, add, remove, ringtones");
    process.exit(1);
}

store.close();

function describeRule(rule: Rule): string {
  const parts: string[] = [];
  if (rule.dateWindow) parts.push(`${rule.dateWindow.from} to ${rule.dateWindow.to}`);
  if (rule.weekdays) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    parts.push(rule.weekdays.map((d) => names[d] ?? d).join("/"));
  }
  if (rule.timeOfDay) parts.push(`${rule.timeOfDay.from}-${rule.timeOfDay.to}`);
  return parts.join(", ") || "always";
}
