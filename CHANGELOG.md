# Changelog

Release notes for `mcp-server-sdlc` live on the **GitHub Releases** page, generated
from merged PR titles at tag time (`gh release create --generate-notes`):

> https://github.com/Wave-Engineering/mcp-server-sdlc/releases

## Policy (#459)

The in-repo changelog is **retired as of v2.1.0**. The release workflow is
tag-triggered and never read this file, so its `## Unreleased` section drifted across
several shipped tags (v2.0.0–v2.0.3) while still claiming `v1.0.2` was the latest cut —
a false picture of release state. Rather than hand-maintain a second, drift-prone
source of truth, releases are now described solely by the auto-generated GitHub notes.

The binary self-reports its build tag at startup (`version`, injected from
`git describe --tags` — see `index.ts` / `scripts/ci/build.sh`), and #447's
deploy-freshness guard warns when a running binary is behind the latest release.
Together those answer "what's running?" without a checked-in changelog.

## Recovering pre-v2.1.0 hand-written history

Earlier releases carried hand-written notes here, including the `wave_init` /
`wave_finalize` breaking-change migration guidance (#362, #363) and the v1.0.0–v1.0.2
runtime-registry fix story. That prose is preserved in this file's git history:

```sh
git log -p -- CHANGELOG.md
```
