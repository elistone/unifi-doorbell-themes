/**
 * Create and inspect themes and doorbells from the command line.
 *
 *   node src/cli/themes.ts list
 *   node src/cli/themes.ts ringtones
 *   node src/cli/themes.ts devices
 *   node src/cli/themes.ts devices add 6489eedb0237c203e400ce18 "Front door"
 *   node src/cli/themes.ts devices rename "Front door" "Porch"
 *   node src/cli/themes.ts devices remove "Porch"
 *   node src/cli/themes.ts add --id xmas --name Christmas \
 *        --image Elf_santa.gif --sound 6933fcd40050f903e46e1a88 \
 *        --priority 10 --dates 12-01..12-26 --doorbells "Front door"
 *   node src/cli/themes.ts remove xmas
 *
 * Rules:
 *   --dates MM-DD..MM-DD    wraps, so 12-20..01-05 is valid
 *   --weekdays 0,5,6        0 is Sunday
 *   --time HH:MM..HH:MM     wraps, so 22:00..06:00 is valid
 *   (none given)            always eligible
 *
 * Scope:
 *   --doorbells "Front,Back"   names or ids, comma separated
 *   (omitted)                  every doorbell
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashBytes } from "../apply.ts";
import { PrivateApi } from "../device/private.ts";
import { Protect } from "../device/protect.ts";
import { Store } from "../store/db.ts";
import type { Device, Rule } from "../domain/types.ts";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const store = new Store(process.env.DOORMAN_DB ?? "data/doorman.sqlite");
const mediaDir = process.env.DOORMAN_MEDIA ?? "media";

/**
 * Find a doorbell by name or id, case-insensitively.
 *
 * Names because that is what a person has in their head, ids because that
 * is what a script has. Ambiguous names are rejected rather than guessed:
 * silently scoping a theme to the wrong door is the kind of mistake nobody
 * notices until the wrong GIF is on the wrong door.
 */
function findDevice(needle: string): Device {
  const devices = store.devices();
  const exactId = devices.find((d) => d.id === needle);
  if (exactId) return exactId;

  const byName = devices.filter((d) => d.name.toLowerCase() === needle.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    console.error(`"${needle}" matches ${byName.length} doorbells. Use the id instead.`);
    process.exit(1);
  }

  console.error(`No doorbell called "${needle}".`);
  if (devices.length > 0) {
    console.error(`Known: ${devices.map((d) => `${d.name} (${d.id})`).join(", ")}`);
  } else {
    console.error("None are configured. Add one with: themes.ts devices add <camera-id> <name>");
  }
  process.exit(1);
}

const deviceNames = new Map(store.devices().map((d) => [d.id, d.name]));
const describeScope = (ids: string[]): string =>
  ids.length === 0
    ? "all doorbells"
    : ids.map((id) => deviceNames.get(id) ?? `${id} (removed)`).join(", ");

switch (command) {
  case "list": {
    const themes = store.themes();
    if (themes.length === 0) {
      console.log("No themes yet. Without one the scheduler leaves the doorbell alone.");
      break;
    }
    const several = store.devices().length > 1;
    for (const t of themes.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))) {
      const when = t.rules.map(describeRule).join(" OR ") || "never (no rules)";
      console.log(
        `${t.enabled ? " " : "-"} ${t.id.padEnd(22)} p${String(t.priority).padEnd(3)} ${when}`,
      );
      console.log(
        `    image ${t.image.slice(0, 12)}…${t.sound ? `  sound ${t.sound}` : "  (no sound)"}` +
          // Only worth the line when there is more than one doorbell to
          // choose between.
          (several ? `\n    on    ${describeScope(t.devices)}` : ""),
      );
    }
    break;
  }

  case "devices": {
    const action = args[1];

    if (!action || action === "list") {
      const devices = store.devices();
      if (devices.length === 0) {
        console.log("No doorbells configured.");
        console.log("Add one with:  themes.ts devices add <camera-id> <name>");
        console.log("Find the id with:  node src/cli/probe.ts");
        break;
      }
      for (const d of devices) {
        const scoped = store.themes().filter((t) => t.devices.includes(d.id)).length;
        const everywhere = store.themes().filter((t) => t.devices.length === 0).length;
        console.log(`${d.enabled ? " " : "-"} ${d.name}`);
        console.log(`    ${d.id}`);
        const total = everywhere + scoped;
        console.log(
          `    ${total} theme${total === 1 ? " applies" : "s apply"}` +
            `${scoped > 0 ? `, ${scoped} only here` : ""}` +
            `${d.enabled ? "" : "  (disabled - the scheduler skips it)"}`,
        );
      }
      break;
    }

    if (action === "add") {
      const [, , id, ...rest] = args;
      const name = rest.join(" ").trim();
      if (!id || !name) {
        console.error('devices add needs an id and a name: devices add <camera-id> "Front door"');
        process.exit(1);
      }
      if (store.device(id)) {
        console.error(`${id} is already configured as "${store.device(id)!.name}".`);
        process.exit(1);
      }

      // Check the controller actually has it, when we can reach one. A typo
      // here otherwise becomes a doorbell that silently fails every roll.
      const host = process.env.PROTECT_HOST;
      const apiKey = process.env.PROTECT_API_KEY;
      if (host && apiKey) {
        const protect = new Protect({
          host,
          apiKey,
          insecureTls: process.env.PROTECT_INSECURE_TLS !== "false",
        });
        const cameras = await protect.displayCapableCameras().catch(() => []);
        if (cameras.length > 0 && !cameras.some((c) => c.id === id)) {
          console.error(`Protect has no image-capable camera with id ${id}.`);
          console.error("Run `node src/cli/probe.ts` to list the ones it does have.");
          process.exit(1);
        }
      }

      store.upsertDevice({ id, name, enabled: true, position: store.devices().length });
      console.log(`Added "${name}" (${id}).`);
      console.log(
        `${store.themes().filter((t) => t.devices.length === 0).length} existing themes apply to it,` +
          " because a theme with no doorbells listed applies to all of them.",
      );
      break;
    }

    if (action === "rename") {
      const device = findDevice(args[2] ?? "");
      const name = args.slice(3).join(" ").trim();
      if (!name) {
        console.error('rename needs a new name: devices rename "Front door" "Porch"');
        process.exit(1);
      }
      store.upsertDevice({ ...device, name });
      console.log(`"${device.name}" is now "${name}".`);
      break;
    }

    if (action === "enable" || action === "disable") {
      const device = findDevice(args[2] ?? "");
      store.upsertDevice({ ...device, enabled: action === "enable" });
      console.log(`${device.name} ${action}d.`);
      break;
    }

    if (action === "remove") {
      const device = findDevice(args[2] ?? "");
      const orphaned = store.themes().filter(
        (t) => t.devices.length === 1 && t.devices[0] === device.id,
      );
      store.deleteDevice(device.id);
      console.log(`Removed "${device.name}".`);
      if (orphaned.length > 0) {
        // Disabled rather than left scoped to nothing, because "no
        // doorbells" means "all doorbells" - see Store.deleteDevice.
        console.log(
          `Disabled ${orphaned.length} theme${orphaned.length === 1 ? "" : "s"} that applied only to it:` +
            ` ${orphaned.map((t) => t.id).join(", ")}`,
        );
      }
      break;
    }

    console.error("devices: list, add, rename, enable, disable, remove");
    process.exit(1);
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

    // Omitted means every doorbell, matching the UI and the stored default.
    const doorbells = flag("doorbells");
    const devices = doorbells
      ? doorbells.split(",").map((n) => findDevice(n.trim()).id)
      : [];

    store.upsertTheme({
      id,
      name: flag("name") ?? id,
      image: hash,
      sound: flag("sound"),
      priority: Number(flag("priority") ?? 0),
      enabled: true,
      rules: [rule],
      devices,
    });
    console.log(
      `${id}: ${image}${flag("sound") ? " + sound" : ""}, ${describeRule(rule)}` +
        `, on ${describeScope(devices)}`,
    );
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
    console.error("Commands: list, add, remove, devices, ringtones");
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
