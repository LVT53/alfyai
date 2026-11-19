# Isolated staging verification of Memory

19 November 2026. The application candidate was `eb1bc237cf9fd409bcd80407c138365fa1a4a329` with product code at `afe75236a`. Staging used only fresh synthetic accounts and data. The original staging and production services were healthy at `0ecf205f3` before this work. The original staging database had six accounts, five outside the known test harness, so the candidate used its own SQLite database. The release archive ran in a private staging directory with a loopback SSH tunnel to the Docker bridge. The test used no public routing, Git push or deployment to either existing service.

| Artifact | SHA-256 |
| --- | --- |
| Candidate package lock | `d74c2220a208a58a49329bae38b9aadf098ddee63bb712ca3544cdf44aeb6068` |
| Candidate migration journal | `27f3eade48bae4750314fdaf2065f5d644a0e42c05adae22451d69f7e8c522cb` |
| Staging build entry | `d97eebf5b30e7b7336be3c43121a32291d5ce2b13ae31900b9e06bc8c5dd424f` |
| Deployed-schema migration journal | `9794b3f41b0da3c238636a1dc73378b25c63c66e3609dd05d2b93918da1a9890` |

The host ran Node 22.23.4. Both archives installed with `npm ci` using their respective package locks. The candidate built with `npm run build`. The foreground model was the authenticated private Flash Next alias `qwen3-6-27b`. The same alias backed the native admission gateway. These results use the native ONNX embedder and FlashRank reranker baseline.

## Deployed-schema upgrade

The rehearsal created a fresh SQLite database by running `npm run db:prepare` under an archive of `0ecf205f360cf2d04c47c2e7658ea587788245e0`. It inserted one synthetic account, two history messages including an incognito message, and one user-authored legacy item. The SQLite backup command copied this database to a second isolated file. The candidate's `npm run db:prepare` brought that copy from 148 to 150 migration rows. Integrity check returned `ok` and the foreign-key check returned no rows. The clone kept one account, two messages and one authored item. It had zero native accounts and zero native jobs.

The candidate's read-only backfill inspection classified one message as uncertain and one as excluded, and found one authored action. In a second inspection of the upgraded fixture, adding one dated message in a recorded off interval raised exclusions from one to two while leaving the uncertain and authored counts unchanged. The old schema could not record this interval, so the known-off case was added to the upgraded clone. Neither rehearsal touched an existing staging database.

## Application checks

Before startup the actual application configuration showed Memory worker off, new native accounts off, restore hold off, the private native endpoint, and the curation gateway model. The app database had two `@test.invalid` accounts, no overrides, and no pending native jobs. Both accounts signed in through Chromium and loaded Memory under legacy authority. The unauthenticated list and internal admission endpoints returned HTTP 401.

After native readiness, the isolated app restarted with the native worker enabled, leaving automatic new-account enrollment off. For each synthetic account, the guarded migration CLI ran `prepare`, `verify` and `cutover`. Two provision jobs succeeded and both accounts reached Hindsight authority.

Three source jobs succeeded after two personal chats and one project chat. The English and Hungarian statements appeared in both the Memory list API and Chromium. Their detail views quoted the exact stored user messages and linked to the matching message IDs. The links opened the expected conversations and showed the exact text. Search found the English memory, the second account did not see the first account's memories, and a cross-account project list request was denied. The project fact appeared only in its own project Memory list. A new chat in that project recalled both the personal and project facts.

## Cross-project chat result

A newly created chat in another project repeated the first project's synthetic workbench canary when asked the same question immediately after the authorized project chat. It also recalled the home scope's synthetic kayak. This is an end-to-end scope acceptance failure. The publication and native recall evidence narrowed the diagnosis. Follow-up wire capture is in progress.

The repeated other-project turn sent the canary to the model in the `Retrieved Evidence` section. It came from two generated answer artifacts owned by the source project and the first cross-project answer that had already repeated it. The wire capture also showed the earlier same-project reply in the ordinary sibling context section. There was no canary in the `Remembered information` section. The original negative reply had no persisted tool calls, and the exact original request was not captured. The repeated request conclusively reproduced an application-level bypass.

A read-only replay of the deployed `recallMemory` function with the exact original chat IDs admitted the project canary only for its own project. The later replay of `findRelevantKnowledgeArtifacts` independently selected both cross-project generated outputs for the original negative chat. The selector applies the current project as a ranking boost. It permits matching results from other conversations owned by the person. Normal Chat materializes its answers as generated outputs, allowing an unauthorized answer to be retrieved again.

A second probe added a new canary directly to another project Memory bank without a source chat. The model saw and returned it in that project. It was absent from the prompts and answers in another project before and after the authorized turn, in a personal chat and in the second account. Negative `memory_context` tool outputs also omitted it. This narrower probe qualified the native bank boundary and did not establish that generated answer artifacts are safe.

The diagnosis temporarily routed the isolated foreground provider through a loopback-only trace relay targeting its original private endpoint. Only the synthetic app's requests were captured in owner-only files, without headers or credentials. The app was restored to its original endpoint, the relay listener stopped, and the original staging and production services remained healthy at `0ecf205f3`. [Wire summary](staging-app-evidence/scope-wire-summary.json) · [Synthetic canary controls](staging-app-evidence/scope-recheck.json) · [English UI](staging-app-evidence/memory-en.png) · [Hungarian UI](staging-app-evidence/memory-hu.png)

## Remaining acceptance

Stage scope acceptance failed on the generated-answer retrieval path. Local commit `d6fc53eb0` keeps saved answers out of automatic cross-chat evidence for native, preparing and previously cut-over accounts. Focused regressions reproduced exposure at the reranker and in reused prompt construction before the fix. The focused run passed 209 tests after the change. It also checked that the working set retains same-chat results, explicit attachments still reach the prompt, and never-enrolled legacy accounts retain their existing behavior. The staging build and exact candidate replay still need to include the fix.

Mixed edit and partial removal, optional-history decline, reset, durable erasure and matched backup restore remain to be verified against the eventual staging build and native provider configuration.
