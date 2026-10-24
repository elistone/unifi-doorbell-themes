/**
 * Keeping theme sounds attached to real ringtones.
 *
 * Ringtone ids are issued per console. Moving Protect to a different NVR
 * invalidates every custom id at once, and because a theme stored only the
 * id, five themes were left pointing at nothing with no record of what they
 * had wanted - the UI could say "sound missing" but not which sound.
 *
 * So themes remember the name too, and re-linking after a migration becomes
 * something the machine can do: upload the audio again under the same name,
 * and the ids get re-attached.
 */
import type { Ringtone } from "./device/private.ts";
import type { Store } from "./store/db.ts";
import type { Theme } from "./domain/types.ts";

export interface SoundStatus {
  theme: Theme;
  /** What it is pointing at now, if that still exists. */
  current: Ringtone | null;
  /** A ringtone on this console whose name is what the theme remembers. */
  candidate: Ringtone | null;
}

/** Compared case- and space-insensitively: "Elf - SANTA!" survives a retype. */
const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

export function soundStatus(themes: Theme[], ringtones: Ringtone[]): SoundStatus[] {
  const byId = new Map(ringtones.map((r) => [r.id, r]));
  const byName = new Map(ringtones.map((r) => [key(r.name), r]));

  return themes
    .filter((t) => t.sound)
    .map((theme) => ({
      theme,
      current: byId.get(theme.sound!) ?? null,
      candidate: theme.soundName ? byName.get(key(theme.soundName)) ?? null : null,
    }));
}

/** Themes whose sound id no longer resolves on this console. */
export const brokenSounds = (statuses: SoundStatus[]): SoundStatus[] =>
  statuses.filter((s) => s.current === null);

/**
 * Re-point broken themes at a ringtone of the same name, where one exists.
 *
 * Only ever touches themes whose id does NOT resolve - a theme pointing at
 * a real ringtone is left alone even if another shares its name, because
 * the id is the authoritative thing while it works.
 */
export function relinkSounds(
  store: Store,
  themes: Theme[],
  ringtones: Ringtone[],
): Array<{ themeId: string; name: string; from: string; to: string }> {
  const relinked = [];

  for (const status of brokenSounds(soundStatus(themes, ringtones))) {
    if (!status.candidate) continue;
    store.upsertTheme({
      ...status.theme,
      sound: status.candidate.id,
      soundName: status.candidate.name,
    });
    relinked.push({
      themeId: status.theme.id,
      name: status.candidate.name,
      from: status.theme.sound!,
      to: status.candidate.id,
    });
  }

  return relinked;
}
