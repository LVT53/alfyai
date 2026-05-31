# Deepen Generated File Serving

Generated File Serving is the server-side boundary that turns an authenticated generated chat-file identity into validated bytes plus mode-specific response headers. The boundary lives in `src/lib/server/services/generated-file-serving.ts` and is consumed by chat preview/download routes and by Working Document generated-output source chat-file serving.

The service owns generated-file lookup, conversation-owner fallback for legacy files, eligibility checks for assigned files and succeeded job-linked unassigned files, allowed generated-file type checks, stored-byte reads, `validateGeneratedOutputFile(...)`, preview content-type selection, download content-type selection, `Content-Disposition`, cache policy, and generated HTML/SVG preview hardening headers such as CSP, `nosniff`, and referrer policy. Routes and Working Document file serving may authenticate, select ids, pass a display filename, and translate the service result into HTTP responses, but they should not duplicate generated-file byte validation or header policy.

File Production and Generated File Storage still produce and store generated files. Generated File Serving does not create jobs, render documents, persist outputs, update produced-file links, or decide generated-document source lifecycle. It serves only generated-file bytes that have already been stored and are eligible for user-facing preview or download.

Working Document Identity and server-side Working Document file serving still decide which artifact or generated-output `sourceChatFileId` is eligible for a Working Document preview or download. When the eligible bytes are a generated chat file, Working Document serving delegates to Generated File Serving and may pass the artifact name as `displayFilename`; stored Knowledge files and text-only degraded previews stay inside the Working Document serving boundary.

Preview Runtime remains client-side. It fetches served preview bytes, classifies file type for browser rendering, and composes PDF, Office/OpenDocument, text, Markdown, CSV, HTML, code, and image adapters. It does not own authorization, generated-file ownership fallback, byte validation, or server security headers.

**Implementation Status, 2026-05-31:** implemented. `src/routes/api/chat/files/[id]/preview/+server.ts` and `src/routes/api/chat/files/[id]/download/+server.ts` now authenticate and delegate to `resolveGeneratedFileServing(...)`. `src/lib/server/services/knowledge/store/working-document-file-serving.ts` delegates generated-output `sourceChatFileId` serving to the same boundary with `displayFilename`. Focused verification passed with `npm run test:unit -- src/lib/server/services/generated-file-serving.test.ts 'src/routes/api/chat/files/[id]/preview/preview.test.ts' 'src/routes/api/chat/files/[id]/download/download.test.ts' src/lib/server/services/knowledge/store/working-document-file-serving.test.ts` covering 4 files and 33 tests.

**Considered Options**

- Keep preview/download validation and headers duplicated in chat routes and Working Document serving.
- Move generated-file serving rules into File Production storage.
- Move generated-file serving decisions into Preview Runtime.
- Add a focused Generated File Serving server module used by all generated chat-file serving adapters.

We chose the focused server module because File Production already owns creation/storage, Working Document Identity owns artifact/source identity, and Preview Runtime owns browser rendering. Generated-file direct serving has its own repeated security and compatibility rules, so localizing them prevents route and workspace drift without expanding adjacent boundaries.
