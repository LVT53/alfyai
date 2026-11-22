# Native operations implementation checkpoint — 2026-11-18

This is a checkpoint, **not full replacement acceptance or deployment approval**. Only synthetic accounts/content were used. Production configuration was read through the existing read-only local-model bridge; no real chat was ingested, account migrated, service restarted or production admin setting changed.

## Implemented boundaries

- Exact upstream engine checkout `9fb28dbd724dc1ce4da7cb4c49008e601db76c5f`, Docker/Compose definition and observed authenticated engine/extension/schema identity endpoint. Production app factory verifies capability identity before native operations and refuses redirects. Direct unbound client construction exists for transport unit tests, not account routing.
- Default supported native TenantExtension verifies versioned HMAC credentials for app-generated opaque UUID schemas and calls native migration hooks. Automatic new-tenant provisioning replaces a manual per-account map. Static extension remains explicitly selected compatibility only. Paired mode-0600 secret generation refuses overwrite. Existing binding hashes retain old key versions during rotation; no silent credential rebinding.
- Supported native HTTP extension inference transport. No extra process, queue, scheduler, semantic processing or raw-prompt logging. Native hard ceiling6 plus gateway background total6, including curation configured through the same private endpoint. Daytime1; explicit idle6 only with authenticated fresh healthy inactive app signal. Excess calls429; native/app existing bounded delivery policies handle failure.
- Shared plain/stream request lifetime leases in existing SQLite, content-free and per-process failure cooldown. Tracking failure logs one content-free warning per failed attempt and does not stop chat. Partial failure invisible to the serving process can weaken immediate downshift; hard background6 still holds. Foreground/model auxiliary calls outside the proxy are not counted. Existing admitted work may finish at6 after foreground begins.
- Runtime secret/env fields, setup/rotation/restore caveats, ADR-0071 and engineering-map supersessions. Legacy storage is retained; no destructive schema/data removal.

## Verified evidence

1. Python tests: **8/8** for paired provisioning, malformed/forged tenant credentials, concurrent first provisioning, key rotation and admission limits/downshift. `HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx HINDSIGHT_API_RERANKER_PROVIDER=flashrank /tmp/alfyai-hindsight-eval/venv/bin/python -m unittest discover -s deploy/hindsight -p 'test_*.py'`.
2. App focused tests: **13/13**, native transport/config binding and actual migrated SQLite activity leases, multiple DB connections, idempotent release, tracking writer failure allowing caller progress. Logs `/tmp/alfyai-native-focused.log`, tracking red→green logs `/tmp/alfyai-activity-{red,green}.log`.
3. Actual pinned native isolation: `native-acceptance/isolation.cjs`, result `isolation-results.json`. Two authenticated tenants used the **same bank ID**, retained different EN/HU facts, listed isolated facts; B could not patch A's fact; B deletion preserved A; forged auth was rejected. Native configure/retain/consolidate/list/delete used actual service. This is transport/native isolation, not full app lifecycle coverage. The script deletes both banks in finally; empty synthetic schemas remain.
4. Actual local-model admission: `native-acceptance/admission.cjs`, `admission-results.json`. Six concurrent attempts: day1accepted/5rejected; explicit idle6accepted; foreground1accepted/5rejected; unavailable activity1accepted/5rejected. Peak6, final active0, completed9, rejected15. Rerun after healthy/fresh signal requirement. Activity signal is synthetic; this does **not** prove actual foreground latency or all-process lifecycle integration.
5. **Actual app integration smoke**: `native-live.integration.test.ts`, explicitly enabled by `HINDSIGHT_NATIVE_ACCEPTANCE=1`. Actual migrated app DB + actual job engine + production native factory delivered two EN/HU source revisions, retained/consolidated natively, published through app list and recalled from native. Both jobs succeeded; published/recall output independently asserted purple kayak and Hungarian cat name, with expected values never sent as grading instructions. Output `native-acceptance/integrated-source-results.json`, raw synthetic model request/response trace `model-calls.jsonl`; log `/tmp/alfyai-native-integrated.log`. Rerun after isolated native restart passed in9.86s. Each run deletes its synthetic bank in finally.
6. Focused Biome check clean. `npm run check` completed with zero errors/warnings, log `/tmp/alfyai-native-check.log`. Root owns final full gates, build and e2e; none are implied by this checkpoint.

The opt-in integration test overrides config to an isolated local endpoint; it does not mock native responses, extraction, job delivery or publication. Ordinary full unit gates skip it intentionally, so the recorded opt-in command is required for native claims. No overall score, 2x precision or full correction lifecycle is claimed here.

## Remaining acceptance / review gates

- Fresh security/operations judge of extensions, routing, secret lifecycle, request leases and deployment definition; fix findings before calling this complete.
- Integrated correction/removal/replay/dependency lifecycle and EN/HU semantic/adversarial benchmark after curation/dependency review. Test public app action/recall contracts, not standalone helper logic; gold expectations never enter model context.
- Actual foreground chat overlap/latency and in-flight6→foreground downshift, sustained background/native fan-out (including curation), outage/late response/restart recovery through app jobs. Current bursts prove transport counts only.
- Explicit wrong-key methods matrix (read/retain/patch/list/delete), invalid schema/discovery boundaries, rotation with persisted app bindings and held/late work; current tests cover only parts.
- Bigger-bank publication/SQLite concurrent writer latency (not just row count).
- Container build/run and deployment-equivalent matched app/native backup/restore. Compose is prepared, not actually built/deployed. Base images/transitive Python deps not digest/lock pinned; exact engine source is pinned. Preserve tested image digest before eventual deployment.
- Route-level internal activity auth and lifecycle error/stream detach coverage; hooks added through shared lifetimes, not duplicate send/stream routes.
- Final migrations/full static/e2e gates by root; no user migration or deployment.

## Scratch handoff (leave running for next acceptance worker)

- Native API127.0.0.1:18890, PID43249 at checkpoint, tool session88450. Start script `native-acceptance/start.py`; log `/tmp/alfyai-native-acceptance-api.log`.
- Synthetic read-only local-model bridge127.0.0.1:18891, PID20345 at checkpoint, session44887. Script `native-acceptance/proxy.cjs`; log `/tmp/alfyai-native-acceptance-proxy.log`.
- Port18892 is free: admission harness creates/closes its synthetic activity server there. Native missing signal therefore defaults1.
- Scratch native checkout/venv/pg0/cache under `/tmp/alfyai-hindsight-eval`. Test-only credentials are in start/harness files; actual upstream credentials are neither printed nor copied into these docs. `model-calls.jsonl` contains synthetic prompts/results only, including startup verification calls from an earlier corrected startup recursion; it is not a clean benchmark denominator.
- All successful isolation/app-smoke banks cleaned; canonical empty synthetic schemas remain. Stop only these owned listener PIDs after subsequent acceptance; no production service. Root requested services remain available rather than cleanup at this checkpoint.
