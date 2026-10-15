# Bundled PPT Master

`ppt-master-6.7.0.tar.gz` contains the complete PPT Master 6.7.0 skill from
`https://github.com/hugohe3/ppt-master`, distributed under the MIT license
(Copyright (c) 2025-2026 Hugo He). The original `LICENSE`, sponsor files,
workflow integrity gates, scripts, references, and templates are retained.
Only Python bytecode caches and local `.env` files are excluded.

Archive SHA-256: `191a1a3e5e3a106a6d24aa35a63d31179d386eb51bd78de853ecb5a5969b93ae`.

This archive pins the skill independently of developer-only checkouts and
network access. `build/lib/mobiusPptMaster.ts` expands it into
`<output>/vs/workbench/contrib/continue/mobius/skills/ppt-master/` during both
Gulp and esbuild builds. The installed runtime loads the entry file from this
application resource directory, never from the presentation workspace.

To update the bundle, obtain the complete official skill, verify its
`scripts/attribution_guard.py`, create a tar.gz whose entries start with
`ppt-master/`, and update the archive filename in the staging helper.
Preserve all attribution and integrity files. After staging, run the guard
again from the expanded skill directory.
