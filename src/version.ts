/**
 * The running version, read from package.json so there is exactly one place
 * to change it.
 *
 * A duplicated version constant always ends up disagreeing with the tag it
 * claims to be, and the disagreement is invisible until someone is trying to
 * work out which build is actually deployed. package.json is the thing
 * `npm version` edits and the release script tags from, so it wins.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
