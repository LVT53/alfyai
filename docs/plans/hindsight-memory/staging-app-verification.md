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

Stage scope acceptance failed on the generated-answer retrieval path. Local commit `d6fc53eb0` keeps saved answers within their original conversation for automatic evidence retrieval by native, preparing and previously cut-over accounts. Focused regressions reproduced exposure at the reranker and in reused prompt construction before the fix. The focused run passed 209 tests after the change. It also checked that the working set retains same-chat results, explicit attachments still reach the prompt, and never-enrolled legacy accounts retain their existing behavior. The staging build and exact candidate replay still need to include the fix.

### Integrated candidate gates

The requested tool-row branch merged at `11e129463`. The merged tool preserves fail-closed Memory controls and reports a lookup failure through `memory_unavailable` client metadata. It keeps the inert model payload and distinguishes a confirmed pause through `memory_off`. The merge passed 299 focused tests.

The full release run on `66c42d8a8096ccee78a62e72493e3e83d68643d8` passed the static checks, migrations, build, artifact chunks and Fallow. Playwright passed 1,726 tests, skipped 77 existing cases and recorded zero failures or flaky results. The gate exited unsuccessfully because one legacy Knowledge unit fixture did not represent the new Memory-account policy seam. Its original relevance assertions were unchanged in the test-only correction at `7a575210d109a693795fd97834185b4ab2df9d8f`. The full unit rerun on that commit passed 29,111 tests and skipped three existing cases. Type checking returned zero errors and zero warnings. The runtime is identical at both commits.

Local gate receipts are in `/tmp/alfyai-memory-integrated-release-gate` and `/tmp/alfyai-memory-integrated-unit-closure`. The first receipt retains the initial unit failure and full browser run. The exact candidate archive for isolated GPU app verification has Git tree `4c4976a2466f815fe1d82298cbf179b3ee346775` and SHA-256 `2a29c74d42f25f6dd63207214202b71aae307628131da17aec0cf1eb02364d31`.

### GPU staging status

The GPU app uses a separate path under `/home/alfydesign/apps/alfyai-memory-gpu-stage-7a575210`, a fresh synthetic SQLite database, an app bind on the dedicated bridge at `172.30.43.1:13003`, and its own Hindsight at `127.0.0.1:18894`. The original staging rehearsal keeps its existing endpoint and bank bindings. Automatic approval review initially rejected the transfers. The owner then explicitly authorized the exact tracked archive and synthetic helpers to this staging path. The remote archive SHA-256 matched, locked installation succeeded, and the production build completed.

The app ran as `alfydesign` in the private staging unit. Its startup probe found two synthetic accounts, zero native accounts or jobs, and zero configuration overrides or enabled database providers. The environment resolved both the Flash Next foreground model and the Hindsight admission curation model as `qwen3-6-27b`. Protected credentials stayed in root-owned environment files. The app accepted both browser logins and denied unauthenticated Memory and admission calls. The native container verified the authenticated app callback. The guarded CLI enrolled only the two synthetic accounts, leaving automatic enrollment off and worker concurrency at one.

| Check | Observed result |
| --- | --- |
| EN and HU retain, publish, search and source links | Passed. Both browser detail views and the API returned the exact authorized user-message source and opened the matching message. [English UI](staging-app-evidence/gpu-memory-en.png) · [Hungarian UI](staging-app-evidence/gpu-memory-hu.png) |
| Project and account scope | Passed in the browser, the actual model answer and the full model request bodies. Two durable answer artifacts in the source project contained the marker. The same-project request and answer used it. All three other-project requests and continuations kept the personal marker and omitted the project marker. The other account's three requests and continuations omitted both. [Wire](staging-app-evidence/gpu-scope-wire.json) · [Browser result](staging-app-evidence/gpu-scope-runtime.json) · [Artifact origins](staging-app-evidence/gpu-scope-artifacts.json) |
| English Edit | Failed. The first edit terminated with internal `memory_edit_rejected` and revoked its retained draft. A second edit changed only the name in the saved sentence. Native raw facts held the replacement and the independent colour, while the native displayed observations lacked the replacement. The final verifier rejected the candidate, then the three attempts exhausted and cleanup remained pending. The app still showed the original name and independent colour. [Job and publication evidence](staging-app-evidence/gpu-curation-en.json) |
| Hungarian full Remove | Exclusion acknowledged and the selected name disappeared. Cleanup failed with `memory_dependency_check_rejected`. A read-only follow-up found that both displayed rows cited one combined raw fact. The job's empty replacement invalidated that entire fact, also removing the separate coat observation. [Job evidence](staging-app-evidence/gpu-curation-hu-off.json) · [Public view](staging-app-evidence/gpu-hu-removal-public.json) |
| Hungarian learning pause | Passed. The paused turn stayed in its chat and produced no Memory source revision or delivery job. After learning was re-enabled, the canary remained absent from every model-request part, the fresh reply and the Memory list. [Job evidence](staging-app-evidence/gpu-curation-hu-off.json) · [Wire](staging-app-evidence/gpu-off-wire.json) |

The temporary request-capture relay was stopped and the isolated foreground endpoint restored. The curation failures block the full GPU application qualification. Partial edit, optional-history decline, reset, durable erasure and the matched old and new backup restore remain open. The app checks used supported environment-backed providers and leave database-backed provider registration outside this run.
