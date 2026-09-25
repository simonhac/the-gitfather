#!/usr/bin/env bash
# Fetch the real wrangler.jsonc from the private repo that holds it (gitignored here: it maps the opaque
# client ids to real orgs, repos and buckets). Override the source with GITFATHER_CONFIG_REPO / _PATH / _REF.
set -euo pipefail
cd "$(dirname "$0")/.."

repo="${GITFATHER_CONFIG_REPO:-simonhac/infra}"
path="${GITFATHER_CONFIG_PATH:-cloudflare/gitfather-scheduler/wrangler.jsonc}"
ref="${GITFATHER_CONFIG_REF:-}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
gh api -H "Accept: application/vnd.github.raw" "repos/$repo/contents/$path${ref:+?ref=$ref}" > "$tmp"

if [[ -f wrangler.jsonc ]] && ! diff -u wrangler.jsonc "$tmp"; then
  echo "wrangler.jsonc differs from $repo/$path (diff above); left untouched. Remove it and re-run to replace." >&2
  exit 1
fi
mv "$tmp" wrangler.jsonc
trap - EXIT
echo "wrangler.jsonc ← $repo/$path${ref:+@$ref}. Before deploying, diff it against the live Worker (README → Deploy)."
