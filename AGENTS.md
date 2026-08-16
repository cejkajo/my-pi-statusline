# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- `index.ts` is the package entry point; it composes `statusline.ts` and `usage-limits.ts`.
- Pi 0.84 owns the fullscreen editor/status/widget/footer dock. Use documented `setFooter`, `setEditorComponent`, and component lifecycle APIs; never patch TUI render methods, terminal dimensions/writes, or `ReadonlyFooterDataProvider`.
- `@earendil-works/*` peer packages are not installed in this repo, so anything covered by `test/` must import only dependency-free modules; runtime helpers that need `pi-tui` live in `extension-status.ts`.
- Run `npm run check`, `npm test`, and `npm run test:e2e`. The E2E command requires Pi 0.84.0 and tmux and covers regular/fullscreen resizing and shutdown.
- Preserve the unlicensed source provenance recorded in `NOTICE.md` when changing package metadata or redistributing the code.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
