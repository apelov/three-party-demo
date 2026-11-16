#!/bin/bash
# Packages the three-party demo of one commit as files to carry to another
# computer: a tarball that runs with no network and no git, and a git bundle
# of the branch for provenance. Nothing is pushed or copied anywhere else.
#
#   scripts/three-party/package.sh --out <directory> [--commit <revision>]
#
# The tarball is made from a clean export of the commit (git archive into a
# temporary directory, never the working tree), with the dependencies the
# demo runs on installed there from the lockfile. It holds no git directory,
# no run, no key file, no three-party/verifier directory and no native
# executable; each of those is checked below and a hit stops the script
# before a file is written. The verifier of the offline check is one Node.js
# file, three-party/src/verifier/aep-verify.mjs, and it is in the export.
#
# Written under <directory>, where <sha7> is the short sha of the commit:
#
#   three-party-demo-<sha7>.tar.gz          top-level directory three-party-demo/
#   three-party-demo-<sha7>.tar.gz.sha256
#   three-party-demo-<sha7>.bundle          git bundle of the branch at that commit
#   three-party-demo-<sha7>.bundle.sha256
#   ONE-COMMAND.txt                         the one command to run on the other computer
#
# The tarball leaves two things out of the export. three-party/stills/: pictures
# of the screens, which the demo does not need to run. And git's ignore
# files, which do nothing in a copy that has no git directory.

set -euo pipefail

say() { printf '%s\n' "$*"; }
stop() { printf 'package.sh: %s\n' "$*" >&2; exit 1; }

OUT=""
REV="HEAD"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) [ "$#" -ge 2 ] || stop "--out needs a directory"; OUT="$2"; shift 2 ;;
    --commit) [ "$#" -ge 2 ] || stop "--commit needs a revision"; REV="$2"; shift 2 ;;
    -h|--help) say "Usage: scripts/three-party/package.sh --out <directory> [--commit <revision>]"; exit 0 ;;
    *) stop "unknown argument: $1" ;;
  esac
done
[ -n "$OUT" ] || stop "give the directory the files are written to: --out <directory>"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
SHA="$(git -C "$REPO" rev-parse --verify --quiet "${REV}^{commit}")" || stop "not a commit: $REV"
SHA7="$(printf '%s' "$SHA" | cut -c1-7)"
NAME="three-party-demo"
BASE="${NAME}-${SHA7}"

# The bundle is of the branch that is checked out, and that branch is at the
# packaged commit.
BRANCH="$(git -C "$REPO" symbolic-ref --quiet --short HEAD)" || stop "the bundle is of a branch: check one out"
[ "$(git -C "$REPO" rev-parse --verify --quiet "refs/heads/${BRANCH}^{commit}")" = "$SHA" ] || stop "the branch $BRANCH is not at the commit $SHA7"

git -C "$REPO" cat-file -e "${SHA}:three-party/bin/start.mjs" 2>/dev/null || stop "the commit $SHA7 holds no three-party/bin/start.mjs"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/three-party-package.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
TREE="$STAGE/$NAME"

say "commit $SHA"
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  say "note: the working tree has changes that are not in $SHA7; the package holds the commit, not those changes"
fi

# 1. The clean export.
git -C "$REPO" archive --format=tar --prefix="$NAME/" "$SHA" | tar -x -C "$STAGE"

# 2. The dependencies the demo runs on, from the lockfile, the way every
#    install of this repository runs: no install script, no optional
#    package, and an environment of this script's own (PATH, HOME and a temp
#    directory, nothing else). The development dependency is left out.
(
  cd "$TREE"
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" npm ci --ignore-scripts --omit=optional --omit=dev --prefer-offline --no-audit --no-fund >"$STAGE/install.log" 2>&1
) || { tail -20 "$STAGE/install.log" >&2; stop "the dependencies were not installed from the lockfile"; }

# 3. What the tarball leaves out of the export.
rm -rf "$TREE/three-party/stills"
find "$TREE" -path "$TREE/node_modules" -prune -o -type f \( -name .gitignore -o -name .gitattributes \) -print0 | xargs -0 rm -f

# 4. The checks. Each count must be 0.
count_of() { wc -l | tr -d ' '; }
# A native executable of macOS, Linux or Windows, as file names it.
count_native() { xargs -0 file | { grep -c -E 'Mach-O|ELF|PE32' || true; }; }
VERIFIER_PATHS="$(cd "$TREE" && { find three-party/verifier 2>/dev/null || true; } | count_of)"
NATIVE_OUTSIDE="$(cd "$TREE" && find . -path ./node_modules -prune -o -type f -print0 | count_native)"
NATIVE_MODULES="$(cd "$TREE" && find ./node_modules -type f -print0 | count_native)"
GIT_ENTRIES="$(cd "$TREE" && find . -name .git | count_of)"
RUN_ENTRIES="$(cd "$TREE" && find three-party -maxdepth 1 \( -name runs -o -name 'runs.pins' \) | count_of)"
KEY_FILES="$(cd "$TREE" && find . -type f \( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name 'TEST-KEY.txt' \) | count_of)"
say "checks: verifier paths $VERIFIER_PATHS, native executables outside node_modules $NATIVE_OUTSIDE, native executables in node_modules $NATIVE_MODULES, git entries $GIT_ENTRIES, run directories $RUN_ENTRIES, key files $KEY_FILES"
[ "$VERIFIER_PATHS" = "0" ] || stop "the export holds three-party/verifier"
[ "$NATIVE_OUTSIDE" = "0" ] || stop "the export holds a native executable outside node_modules"
[ "$NATIVE_MODULES" = "0" ] || stop "an installed dependency holds a native executable"
[ "$GIT_ENTRIES" = "0" ] || stop "the export holds a git directory"
[ "$RUN_ENTRIES" = "0" ] || stop "the export holds a runs directory"
[ "$KEY_FILES" = "0" ] || stop "the export holds a key file"
[ -f "$TREE/three-party/bin/start.mjs" ] || stop "the export holds no three-party/bin/start.mjs"
[ -d "$TREE/node_modules/@opena2a/atx-verify" ] || stop "the dependencies are not installed in the export"

# 5. The build the packaged copy names, which has no git directory to ask.
BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'commit %s\nbuilt %s\nnode %s\n' "$SHA" "$BUILT" "$(node --version)" > "$TREE/three-party/BUILD.txt"

# 6. The tarball and its hash. COPYFILE_DISABLE keeps the macOS tar from
#    adding a metadata file beside each entry. The listing is then read as a
#    whole: no line of it may hold .git, runs, .pem, TEST-KEY.txt or the
#    verifier directory, anywhere in a path.
( cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf "$OUT/$BASE.tar.gz" "$NAME" )
LISTED="$(tar -tzf "$OUT/$BASE.tar.gz" | { grep -c -E '\.git|runs|\.pem|TEST-KEY\.txt|three-party/verifier' || true; })"
[ "$LISTED" = "0" ] || { rm -f "$OUT/$BASE.tar.gz"; stop "the tarball lists a git, runs, key or verifier entry ($LISTED lines)"; }
( cd "$OUT" && shasum -a 256 "$BASE.tar.gz" > "$BASE.tar.gz.sha256" )

# 7. The bundle of the branch, checked, and its hash.
rm -f "$OUT/$BASE.bundle"
git -C "$REPO" bundle create --quiet "$OUT/$BASE.bundle" "refs/heads/$BRANCH"
git -C "$REPO" bundle verify --quiet "$OUT/$BASE.bundle" >/dev/null 2>&1 || stop "the bundle does not verify"
( cd "$OUT" && shasum -a 256 "$BASE.bundle" > "$BASE.bundle.sha256" )

# 8. The one command, and what it needs.
printf 'tar -xzf ~/Downloads/%s.tar.gz -C ~ && cd ~/%s && npm run three-party\n' "$BASE" "$NAME" > "$OUT/ONE-COMMAND.txt"
printf 'Needs Node.js 22.12 or later, a browser, and tar and a POSIX shell for the command above; no login, no network.\n' >> "$OUT/ONE-COMMAND.txt"

say "built $BUILT with node $(node --version)"
for f in "$BASE.tar.gz" "$BASE.bundle"; do
  say "$f  $(wc -c < "$OUT/$f" | tr -d ' ') bytes  sha256 $(cut -d' ' -f1 "$OUT/$f.sha256")"
done
say "entries in the tarball: $(tar -tzf "$OUT/$BASE.tar.gz" | count_of)"
say "written to $OUT"
