#!/usr/bin/env bash
# Builds dist/ into a detached release commit and tags it, so consumers can
# `npm i github:SnaxxTech/paddle-kit#vX.Y.Z` without a build step, while main stays dist-free.
set -euo pipefail
version="${1:?usage: scripts/release.sh 0.1.0}"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
start="$(git rev-parse --abbrev-ref HEAD)"
npx tsc --noEmit
npx vitest run
npm run build
npm run check:edge
git checkout --detach
git add -f dist
git commit -m "release v${version}"
git tag "v${version}"
git checkout "$start"
echo "Tagged v${version}. Push is a separate, owner-approved step: git push origin v${version}"
