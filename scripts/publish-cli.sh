#!/usr/bin/env bash
#
# Interactive publisher for @hellointerview/ai-coding.
# Run from the repo root: `yarn publish:cli`
#
# It is deliberately careful — nothing irreversible happens without an explicit,
# typed confirmation, and npm versions are immutable so it refuses to clobber one.
# Steps: check npm auth -> require a clean packages/cli tree -> pick the version ->
# build -> show exactly what ships -> confirm -> npm publish (prompts for your 2FA OTP).
set -euo pipefail

PKG="@hellointerview/ai-coding"
CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CLI_DIR"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
err()  { printf '\033[31m%s\033[0m\n' "$1" >&2; }

PUBLISHED_OK="no"
BUMPED="no"
CURRENT="$(node -p "require('./package.json').version")"

# If we bumped package.json but never published (user aborted, build failed), undo the bump
# so the tree is left exactly as we found it.
cleanup() {
  if [ "$PUBLISHED_OK" != "yes" ] && [ "$BUMPED" = "yes" ]; then
    git checkout -- package.json 2>/dev/null || true
    echo "Reverted the version bump (nothing was published)."
  fi
}
trap cleanup EXIT

# 1. npm auth
if ! npm whoami >/dev/null 2>&1; then
  err "Not logged in to npm. Run 'npm login' (as a member of the @hellointerview org) and retry."
  exit 1
fi
bold "npm account: $(npm whoami)"

# 2. clean working tree for the CLI (a published version should map to a commit)
if [ -n "$(git status --porcelain -- "$CLI_DIR")" ]; then
  err "packages/cli has uncommitted changes. Commit them first so the published version matches a commit:"
  git status --short -- "$CLI_DIR" >&2
  exit 1
fi

# 3. version state
PUBLISHED="$(npm view "$PKG" version 2>/dev/null || true)"
echo
bold "Package: $PKG"
echo "  package.json: $CURRENT"
if [ -z "$PUBLISHED" ]; then
  echo "  on npm:       (not published — this will be the FIRST release)"
else
  echo "  on npm:       $PUBLISHED (latest)"
fi

# 4. choose the version
echo
echo "Version for this release:"
if [ -z "$PUBLISHED" ]; then
  echo "  1) publish $CURRENT as-is        (recommended for the first release)"
else
  echo "  1) keep $CURRENT"
fi
echo "  2) patch    (bug fixes)"
echo "  3) minor    (new, backward-compatible)"
echo "  4) major    (breaking change)"
echo "  5) enter an explicit version"
read -rp "Choose [1-5] (default 1): " VCHOICE
VCHOICE="${VCHOICE:-1}"

NEW_VERSION="$CURRENT"
case "$VCHOICE" in
  1) ;;
  2) NEW_VERSION="$(npm version patch --no-git-tag-version)"; NEW_VERSION="${NEW_VERSION#v}"; BUMPED="yes" ;;
  3) NEW_VERSION="$(npm version minor --no-git-tag-version)"; NEW_VERSION="${NEW_VERSION#v}"; BUMPED="yes" ;;
  4) NEW_VERSION="$(npm version major --no-git-tag-version)"; NEW_VERSION="${NEW_VERSION#v}"; BUMPED="yes" ;;
  5) read -rp "New version (x.y.z): " NEW_VERSION
     npm version "$NEW_VERSION" --no-git-tag-version >/dev/null; BUMPED="yes" ;;
  *) err "Invalid choice."; exit 1 ;;
esac

# npm versions are immutable — never try to clobber one that already exists.
if npm view "$PKG@$NEW_VERSION" version >/dev/null 2>&1; then
  err "$PKG@$NEW_VERSION is already on npm. Pick a different version."
  exit 1
fi

# 5. fresh build + show exactly what will ship
echo
bold "Building a clean bundle…"
yarn install --immutable
yarn build

echo
bold "Tarball contents:"
npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' || true
FILE_COUNT="$(npm pack --dry-run --json 2>/dev/null | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(a[0].files.length));')"
if [ "$FILE_COUNT" != "4" ]; then
  err "Expected exactly 4 files (LICENSE, README.md, dist/cli.js, package.json), got $FILE_COUNT."
  err "Check the 'files' field in package.json — refusing to publish."
  exit 1
fi

# 6. explicit, typed confirmation
echo
bold "About to publish $PKG@$NEW_VERSION to the PUBLIC npm registry."
if [ "$BUMPED" = "yes" ]; then
  echo "  package.json was bumped $CURRENT -> $NEW_VERSION (commit this after publishing)."
fi
read -rp "Type the version ($NEW_VERSION) to confirm, or anything else to abort: " CONFIRM
if [ "$CONFIRM" != "$NEW_VERSION" ]; then
  err "Confirmation did not match. Aborting — nothing was published."
  exit 1
fi

# 7. publish (npm prompts for your 2FA OTP here if enabled). access is also set in publishConfig.
npm publish --access public
PUBLISHED_OK="yes"

echo
bold "Published $PKG@$NEW_VERSION ✓"
echo "Verify from a clean dir:  npx $PKG@$NEW_VERSION --help"
if [ "$BUMPED" = "yes" ]; then
  echo "Now commit the version bump: git commit -am \"release: $PKG@$NEW_VERSION\" (then open a PR)."
fi
