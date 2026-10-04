#!/usr/bin/env bash
#
# Cut a release: bump the version, tag it, push.
#
#   scripts/release.sh patch        0.1.0 -> 0.1.1   fixes only
#   scripts/release.sh minor        0.1.0 -> 0.2.0   new features
#   scripts/release.sh major        0.1.0 -> 1.0.0   breaking changes
#   scripts/release.sh 1.4.2        an explicit version
#
# The tag is what deployments pin to, so this refuses to run on a dirty tree
# or a branch other than main. A tag pointing at uncommitted work is a
# deployment that cannot be reproduced, and you only find out when you try.

set -euo pipefail
cd "$(dirname "$0")/.."

bump="${1:-}"
if [[ -z "$bump" ]]; then
  echo "usage: scripts/release.sh <major|minor|patch|X.Y.Z>" >&2
  exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" ]]; then
  echo "Releases come from main; you are on '$branch'." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash first - a tag must point at" >&2
  echo "something that can be checked out again." >&2
  git status --short >&2
  exit 1
fi

current="$(node -p "require('./package.json').version")"

if [[ "$bump" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  next="$bump"
else
  IFS=. read -r major minor patch <<<"$current"
  case "$bump" in
    major) next="$((major + 1)).0.0" ;;
    minor) next="${major}.$((minor + 1)).0" ;;
    patch) next="${major}.${minor}.$((patch + 1))" ;;
    *) echo "Unknown bump '$bump'." >&2; exit 1 ;;
  esac
fi

tag="v${next}"
if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "$tag already exists. Tags are immutable here - pick another version." >&2
  exit 1
fi

echo "Running the tests before tagging anything..."
node --test "tests/*.test.ts" >/dev/null

# node -p rather than `npm version`: npm would also create its own commit and
# tag with a format we do not control, and would fail without a lockfile.
node -e "
  const fs = require('node:fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '${next}';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Promote the Unreleased section to this version and open a fresh empty one,
# so the changelog is written as you go rather than reconstructed from the
# git log at release time, when nobody remembers which change mattered.
node -e "
  const fs = require('node:fs');
  const file = 'CHANGELOG.md';
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('## Unreleased')) {
    console.error('No \'## Unreleased\' section in CHANGELOG.md - add one.');
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    file,
    text.replace('## Unreleased', '## Unreleased\n\n## ${next} - ' + today),
  );
" 

git add package.json CHANGELOG.md
git commit -m "chore: release ${tag}"
git tag -a "$tag" -m "${tag}"

echo
echo "Tagged ${tag} (was ${current})."
echo "Push it with:   git push origin main --follow-tags"
echo "Deploy it by setting doorman_version: \"${tag}\" in the homelab repo."
