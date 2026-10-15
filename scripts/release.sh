#!/usr/bin/env bash
# Builds dist/ into a detached release commit and tags it, so consumers can
# `npm i github:SnaxxTech/paddle-kit#vX.Y.Z` without a build step, while main stays dist-free.
set -euo pipefail
version="${1:?usage: scripts/release.sh 0.1.0}"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
start="$(git rev-parse --abbrev-ref HEAD)"
[ "$start" != HEAD ] || { echo "refusing: detached HEAD, check out a branch first"; exit 1; }
if git rev-parse -q --verify "refs/tags/v${version}" >/dev/null; then
  echo "tag v${version} already exists"; exit 1
fi
if [[ "$version" != *-dryrun ]]; then
  pkg="$(node -p "require('./package.json').version")"
  [ "$version" = "$pkg" ] || { echo "version ${version} does not match package.json ${pkg}"; exit 1; }
fi
npx tsc --noEmit
npx vitest run
npm run build
npm run check:edge
git checkout --detach
# From here on, any failure unstages dist and returns to the starting branch.
trap 'git reset -q; git checkout -q "$start"' ERR
git add -f dist
git commit -m "release v${version}"
git tag "v${version}"
git checkout -q "$start"
trap - ERR
echo "Tagged v${version}. Push is a separate, owner-approved step: git push origin v${version}"
