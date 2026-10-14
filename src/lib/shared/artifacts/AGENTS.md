# Shared Artifact Modules

- [`src/lib/shared/artifacts/kinds.ts`](kinds.ts) — the `ArtifactKind` union (browser-safe, no runtime imports). [`src/lib/shared/artifacts/anchor.ts`](anchor.ts) — the one shared comment-anchor type, appended to per type.

## Rules In Other Files

- The board's modules (`canvas*.ts`, `board-*.ts`, `ops.ts`, `block-urls.ts`, `chat-blocks.ts`, `comments.ts`, `live-web.ts`, `node-size.ts`, `mermaid-size.ts`, `poster-file.ts`): `src/lib/components/artifacts/canvas/AGENTS.md`.
- `mermaid-source.ts`, the one Mermaid sanitizer: `src/lib/components/chat/AGENTS.md`.
- `history.ts`, `version-summaries.ts`, `artifact-calls.ts`, `app-*.ts`: `src/lib/server/services/artifacts/AGENTS.md` and `src/lib/components/artifacts/history/AGENTS.md`. `tours.ts`: `src/lib/components/artifacts/tour/AGENTS.md`.
