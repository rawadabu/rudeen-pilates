#!/bin/bash
# Puts the local commits on GitHub (rawadabu/rudeen-pilates, branch main).
#
# Why not `git push`: this local repo has no remote and its history is not
# GitHub's (the old local commits carry another e-mail address). So the new
# local commits are replayed, one by one and with the same messages, on top of
# a fresh clone of GitHub, under the noreply identity, and pushed fast-forward.
# Never force. app/.env.example is left out, as it always was.
#
#   scripts/push-to-github.sh          shows what would be pushed, pushes nothing
#   scripts/push-to-github.sh --push   does it (only with the owner's go-ahead)
set -euo pipefail
LOCAL="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="https://github.com/rawadabu/rudeen-pilates.git"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
tree() { git -C "$1" ls-tree -r "$2" | grep -v -e $'\tapp/.env.example$' -e $'\tREADME.md$' | awk '{print $3, $4}' | sort -k2; }

[ -z "$(git -C "$LOCAL" status --porcelain)" ] || { echo "Local repo has uncommitted changes: commit first."; exit 1; }
GIT_TERMINAL_PROMPT=0 git clone -q "$REMOTE" "$WORK/gh"
git -C "$WORK/gh" config user.name rawadabu
git -C "$WORK/gh" config user.email 73743660+rawadabu@users.noreply.github.com

# the newest local commit whose files are exactly what GitHub has now
BASE=""
for c in $(git -C "$LOCAL" rev-list HEAD); do
  if diff -q <(tree "$LOCAL" "$c") <(tree "$WORK/gh" HEAD) >/dev/null; then BASE="$c"; break; fi
done
[ -n "$BASE" ] || { echo "No local commit matches what is on GitHub. Stop and look by hand."; exit 1; }
COMMITS="$(git -C "$LOCAL" rev-list --reverse "$BASE..HEAD")"
echo "GitHub main:  $(git -C "$WORK/gh" log -1 --format='%h %s' | cut -c1-90)"
echo "matches local $(git -C "$LOCAL" log -1 --format='%h' "$BASE")"
[ -n "$COMMITS" ] || { echo "Nothing to push: GitHub is up to date."; exit 0; }

for c in $COMMITS; do
  git -C "$LOCAL" archive "$c" -- . ':(exclude)app/.env.example' | tar -x -C "$WORK/gh"
  # files deleted in that commit
  git -C "$LOCAL" diff --name-only --diff-filter=D "$c^" "$c" | while read -r f; do rm -f "$WORK/gh/$f"; done
  git -C "$WORK/gh" add -A
  git -C "$LOCAL" log -1 --format=%B "$c" > "$WORK/msg"
  git -C "$WORK/gh" commit -q -F "$WORK/msg"
  echo "  + $(git -C "$WORK/gh" log -1 --format='%h %s' | cut -c1-100)"
done
echo "--- files changed:"; git -C "$WORK/gh" diff --stat origin/main HEAD | tail -25

FAIL=0
[ "$(grep -c 'REPLACE_ME_' "$WORK/gh/supabase/functions/push/index.ts")" = "2" ] || { echo "STOP: the push function no longer carries its two key placeholders (real keys in the repo copy?)"; FAIL=1; }
git -C "$WORK/gh" diff --name-only origin/main HEAD | grep -qiE '(^|/)\.env|\.p8$|\.p12$|service-account' && { echo "STOP: an env or key file is in the push"; FAIL=1; }
git -C "$WORK/gh" diff origin/main HEAD | grep -E '^\+' | grep -qiE 'sb_secret_|BEGIN PRIVATE KEY|service_role[^_ ]' && { echo "STOP: something that looks like a secret is in the push"; FAIL=1; }
diff -q <(tree "$LOCAL" HEAD) <(tree "$WORK/gh" HEAD) >/dev/null || { echo "STOP: the result differs from the local files"; FAIL=1; }
[ "$FAIL" = 0 ] || exit 1
echo "checks passed: placeholders in place, no env/key files, no secrets, same files as local"

if [ "${1:-}" = "--push" ]; then
  git -C "$WORK/gh" push origin HEAD:main 2>&1 | tail -2
  git -C "$WORK/gh" fetch -q origin
  echo "GitHub main is now $(git -C "$WORK/gh" rev-parse --short origin/main)"
else
  echo "Dry run: nothing was pushed. Run again with --push after the owner says so."
fi
