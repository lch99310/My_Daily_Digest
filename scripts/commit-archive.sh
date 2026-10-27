#!/usr/bin/env bash
# Commit today's archive/<stream>/ additions back to the branch the workflow
# ran on. Three digests push within two hours of each other, so a rejected push
# rebases and retries; they touch different files and never conflict.
set -euo pipefail

stream="$1"
branch="${GITHUB_REF_NAME:?}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if [ ! -d "archive/${stream}" ]; then
  echo "No archive/${stream} written this run."
  exit 0
fi
git add "archive/${stream}"
if git diff --cached --quiet; then
  echo "No new ${stream} cards to archive."
  exit 0
fi
git commit -m "archive: ${stream} $(TZ=Australia/Sydney date +%F)"

for attempt in 1 2 3 4; do
  if git pull --rebase origin "$branch" && git push origin "HEAD:${branch}"; then
    echo "Archive committed."
    exit 0
  fi
  sleep $((attempt * 5))
done
echo "Failed to push archive after 4 attempts." >&2
exit 1
