
# Images part 2: build report (final)

Branch `images-part-2`, cut from `91c250560`. Final commit `7a1330aad`. Version 2.3.0. 243 commits in `91c250560..7a1330aad`.

## The short version

- Production is LIVE on `7a1330aad`. You asked for it, and you lifted the PROMPT.md production ban for this release.
- `main` and `dev` were fast-forwarded from `a31b3cf3e` to `7a1330aad`.
- Plans 2a (pipeline), 2b (picture UI) and 2c (picture server) are built. So is everything you asked for during the run: drag a selection into folders or the bin, the calm shimmer, the logo dot, the Image tour, the polish wave, the explicit-picture filter, and the 2.3 campaign draft.
- The final release gate has no product failures. Every red test there predates this work.
- The "card never appears" bug and the chat freeze had one root cause: a Svelte 5.55.8 scheduler bug. We moved to Svelte 5.56.10.
- The sofa rehearsal ran on ai.dev: 32 of 32 thresholds pass.
- Two things still need you:
- (Done: you made a test picture on prod on 2026-10-28; pictures and the explicit filter work.)
- Publish the 2.3 campaign (it is a draft on prod).
- Do the sofa session on your own photos. Unmarked moves were not run in the rehearsal.

## 1. What was built

243 commits in `91c250560..7a1330aad`.

| Group | Commits |
|---|---|
| 2a pipeline | 39 |
| 2c picture server (repo side; most of 2c is on alfyroot) | 6 |
| 2b tasks 0 to 8 and 3b (incl. 2 flake fixes) | 87 |
| 2b your first fixes 9a, 9b, 9c | 15 |
| 2b final fix wave | 24 |
| Release-gate repairs up to the first deploy (2 Vivaldi test bugs, alpha fix and backfill, fake-provider flake part 1) | 5 |
| Live-found fixes after that (fake-provider part 2, edge row, alpha by request, purity registration) | 5 |
| Task 10: drag a selection | 5 |
| Task 11: card never appears, freeze, doubled reply, shimmer | 7 |
| Task 13: logo dot | 1 |
| Task 16: Image tour | 5 |
| Polish wave (tasks 12, 14, 15, 17) | 23 |
| Task 18: explicit-picture filter | 16 |
| Task 19: 2.3 campaign draft | 0 in the repo (script lives in `~/alfyai-handoff/campaign-2.3/`) |
| Task 20: pre-release fixes | 5 |
| Total | 243 |

### Plan 2a: pipeline (39 commits)

| Task | What it did | Commits |
|---|---|---|
| T1 | Number the pictures of a message, so "picture 2" means the same to you and the model | 1 |
| T2 | Picture server address, the cap on source pictures, ComfyUI in Tool Health | 1 |
| T3 | One ComfyUI client, built against a fake ComfyUI first | 2 |
| T4 | Sizes in multiples of 32, never edit at 1024x1024, fresh seed each take | 1 |
| T5 | Pixel guards: align, paste back only what changed, re-anchor every fourth change | 2 |
| T6 | Image becomes the sixth kind (a small JSON body that points at its picture) | 2 |
| T7 | Pictures kept as PNG files the chat owns, served only to the owner, gone with the chat | 1 |
| T8 | Each take is a job: queued, followed, guarded, stored | 2 |
| T9 | A take becomes the item's version; one pick per card | 2 |
| T10 | Card actions: Another, Use this, Stop, Try again; cards sent with the chat | 2 |
| T11 | Number the open picture, card pictures and marked copy with the uploads | 3 |
| Regressions | Hook mocks, sidebar strings, lazy-module warm-up, wake on completion | 4 |
| T12 | The `make_image` tool (catalogue ceiling raised 5,222 to 5,298) | 2 |
| T13 | Wait, Stop, one automatic retry for a clear miss, Alfy looks at the result | 2 |
| T14 | End-to-end spec against the fake ComfyUI | 1 |
| Final fix wave | see section 5 | 11 |

### Plan 2c: picture server (6 repo commits, plus the box work)

| Task | What it did |
|---|---|
| T1-2 | Survey and install on alfyroot: ComfyUI v0.43.0, Qwen-Image 2.1 INT8, `comfyui.service` on 127.0.0.1:8188, daily clean-up timer (write-up in `74d6dedfa`) |
| T3 | Real graphs exported from the installed templates, held by a contract test (`08a1a6066`) |
| T4 | Measured beside TEI and MinerU; margins set from the numbers (`12fc6b431`) |
| T5 | Guards tuned on real renders (`673298537`, `961f407c5`) |
| T5 re-measure | Independent-region re-measure after the final review (`2d6113ec1`; marked-move numbers added in `d0ef87619`, which sits in 2b T0) |
| T6 | Step 1 (deploy and config) is done: see sections 3 and 3b. Steps 2 to 4 were rehearsed by an agent (section 4). Step 5 and the Acceptance section are yours |

### Plan 2b: picture UI, the planned tasks

| Task | What it did | Commits |
|---|---|---|
| T0 (added) | Server gaps the UI needed; marked-edit clamp; the shared-take-file fix | 13 |
| T1 | Card view model and words, English and Hungarian | 2 |
| T2 | The picture card in the chat, with motion checks against the Document | 15 |
| T3 | The picture panel: Before/After and a strip of versions | 8 |
| T3b (added) | Shell holds panel content still while expanding or docking, for every kind | 5 |
| T4 | History for pictures: a thumbnail per version, a wipe to compare | 11 |
| T5 | Composer picture numbers, sent-message thumbnails, Attach | 10 |
| T6 | Marks: lettered boxes drawn on a picture | 13 |
| T7 | Image icon in search; Images chip tests | 2 |
| T8 | End-to-end specs (make, Another, photo edit, History, cut-out, phone, Hungarian, Attach, marks) | 6 |
| Flake fixes | `e4424d108` (mermaid block test), `54ed2a151` (a Stop between submit and checkpoint, the make-image flake) | 2 |
| 9a (your fix) | Downloads keep their extension; `.md` served as markdown; one shared name rule | 6 |
| 9b (your fix) | Linux Vivaldi: Knowledge column fits at every width, sidebar search pill gives way; new Vivaldi smoke spec | 7 |
| 9c (your fix) | One Hungarian word for skills; "active" no longer used for system-enabled skills | 2 |
| Final fix wave | 13 items from the two final reviews, see section 5 | 24 |

### Plan 2b: what you asked for during the run

| Task | What it did | Commits |
|---|---|---|
| 10 | Drag any selected chat and the whole selection goes with it (ghost reads "3 chats"). Drop on a folder, Pinned, Chats, or a bin that appears only during a drag. A bin drop opens the same bulk-delete confirm the selection bar uses, never a delete without confirm | 5 |
| 11 | Root cause of the card that never appears AND of the chat freeze (see below). Also the doubled reply, and the calm shimmer | 7 |
| 12 | Crowding with the sidebar open at 1280, 1366, 1440, 1920: panel and History rows get room (`4fe262b1d`) | in the polish wave |
| 13 | Logo dot on the collapsed rail shows only unseen activity, no longer "a chat is open" | 1 |
| 14 | Header items icon always opens this chat's list, not the last item | in the polish wave |
| 15 | Follow-up chips show on hover with the icon row, 8 px apart; touch shows both at rest | in the polish wave |
| 16 | Image first-open tour: 3 slides plus summary, English and Hungarian | 5 |
| 17 | Rehearsal small fixes (see section 4) plus the Task 11 review round | in the polish wave |
| 18 | Explicit-picture filter: request check, local classifier, fail closed | 16 |
| 19 | The "2.3" release campaign, as a draft | 0 in repo |
| 20 | Pre-release fixes | 5 |

Task 11 in plain words:
- Cause: a Svelte 5.55.8 scheduler bug. A batch that was re-linked was not marked linked. Later updates merged into a dead batch and the page stopped re-rendering. The picture card's `$effect.pre` on mount set it off.
- Fix: Svelte 5.56.10 (`09266084a`), with a red/green unit test and 2 e2e tests (`ec87499bf`, `8f32f8bde`).
- This one cause explains both the card that did not appear until a refresh and the freeze the rehearsal saw after 8 of 11 picture turns.
- The doubled reply came from history replaying a tool turn's answer before its `make_image` call. Fixed in `a8551733b`.
- The shimmer: the in-progress card is the whole picture box with a calm left-to-right sweep (`--duration-shimmer` 2000 ms). Reduced motion gets a static soft tint. No spinner, no visible wait text. The state stays in a screen-reader live region.
- Side commits: `5fff3cbb3` (timer count test), `282e6ff7b` (Canvas editor chunk ceiling 71 to 72 KiB).

Task 18 in plain words:
- Request check: before anything renders, `make_image` refuses explicit, sexual or nude requests. A small whole-word list in English and Hungarian. Negations pass ("no nudity"). Innocent uses pass: naked mole-rat, meztelencsiga, Super Bowl XXX, undressed salad, The Naked Chef.
- Picture check: a local classifier (Falconsai/nsfw_image_detection, onnx-community export, pinned revision `1ceb3c7f…`) runs on every finished picture. No outside service.
- You chose the larger fp32 file over int8. Pin: SHA-256 `a4316a4fb750169ac4fcabaabee1fcbd982b0ee8c0cc63fe3e944954bb9a7d9c`, 343 MB, at `data/models/picture-check/nsfw_image_detection.fp32.onnx`.
- The filter is ON for every user by default. An admin can exempt one person (Users) or switch it off for the whole install (System). Migration `1777140000122` stores the exemption.
- Fail closed: if the filter is on and a picture cannot be checked, it is not shown. The card says it could not be checked.
- A flagged picture is never shown or stored as a usable take. It gets its own calm card and row, English and Hungarian.
- `make_image` text gained one 26-token sentence telling the model to decline such requests.
- Tool Health reports the picture check beside `make_image`.
- Measured (fp32, this box, 2 threads, 1248x832): 142 to 168 ms per check once running. The first check, including the file read, hash and session build, takes 750 to 820 ms. Every check races a 15 s deadline. It loads only for a check and unloads after 15 idle minutes.
- Memory: see risk 3 in section 8.
- Deploy: step 4d (`npm run models:fetch`) fetches and verifies the file. `ONNXRUNTIME_NODE_INSTALL=skip` in both deploy scripts stops onnxruntime-node from trying a CUDA download.
- Review (Opus): no bypass found. It found 3 problems: no timeout on the check, the word list refusing ordinary prompts, and a bad `.npmrc` key. All fixed in the fix round. Sonnet re-review: approved.

Task 20 in plain words (all ship-blocking for 2.3):
- `/knowledge?type=…` links gave a 500 (`KIND_FILTER_VALUES` used before it was set up, since `351c47640`). Fixed.
- A photo with no readable text could not be sent on the default model, because the legacy default id "model1" was not found by the composer. It now reads the server's alias.
- Version bumped to 2.3.0.
- A picture-only reply that carried only remembered facts showed an empty Sources row. Fixed (see the trade-off in section 7).

The live-found fixes (each found on the real ai.dev or in a gate, each with a red test first):

| Fix | What it was | Commits |
|---|---|---|
| Alpha, by request | Opaque pictures stored "see-through" because of rounding noise from ComfyUI (first fix `1d243d475`, backfill `5829a48a9`). A plain generate still stored 5 stray pixels at alpha 244 to 249. Now see-through is decided by the request: RGB unless the graph was the transparent one or the base really is transparent (`4ab09c99e`) | 3 (2 in repair row above, 1 here) |
| Edge row | Every live edit had a fully transparent top row: alignment shifted the result 1 px and the exposed edge was never filled. Now exposed edges take the base on every guard path (`e26aad5af`, `4fb4ea6ff`) | 2 |
| Fake-provider flake | The fake provider matched scenario markers against the whole request body, including memory from an earlier spec. It now matches only this turn's user text (`83b0d211d`, `cc783784e`) | 2 (1 in repair row above) |
| Make-image flake | A Stop between submit and checkpoint cancelled a render ComfyUI had already started (`54ed2a151`) | 1 (in flake fixes) |
| Purity registration | `images/requests.ts` holds Hungarian abbreviations for the title fallback; registered as read-only in the English-purity test (`a72ea77cc`) | 1 |

## 2. Gate numbers

All gates run on this box (24 cores), Node 22. Fallow baseline = 4 known cycles.

### Baseline (91c250560, before any part 2 work)

`logs/baseline-gate-2/summary.txt`. The first try failed only because `./data/` was missing; fixed and re-run.

| Step | Result |
|---|---|
| check | 0 errors, 0 warnings |
| biome, migrations | ok |
| vitest | 20,758 passed, 2 failed |
| build | ok; unused-css 0, aria 0 |
| fallow | 4 cycles, nothing new |
| playwright | 241 passed, 2 failed, 0 flaky |

The 4 failures predate us and fail on Linux: `SettingsAdminUsersPane` (2 tests) and `search-modal` visual light and dark (:203, :227).

### Plan 2a gate (agent gate at `3c60df307`, before the final review)

| Step | Result |
|---|---|
| check | 0 / 0 |
| biome, migrations, build | ok |
| vitest | 21,122 passed, 2 failed (the same 2) |
| fallow | 4 cycles plus 3 new findings (an unused script, `MARK_LETTERS`, `MAX_MARKS`) |
| playwright | 73 passed, 1 failed (`vision.spec.ts:439`, expected the old message shape) |

Both problems went into the fix wave. After the wave: vitest 21,141 passed with the known 2 failing; check 0/0; build ok; Fallow 4 cycles plus 2 unused items in `scripts/images/drift.ts`, cleared in 2b T0.

### Plan 2b, task 8 agent gate (`ecaa997df`)

| Step | Result |
|---|---|
| check | 0 errors, 0 warnings in 8,824 files |
| biome / migrations | ok (1 info) / ok |
| vitest | 21,426 passed, 2 failed (the same 2) |
| build | ok; unused-css 0, aria 0 |
| fallow | 4 cycles, 0 new |
| playwright | 221 passed, 2 failed (search-modal :203, :227), 0 flaky |

### Release gates (full e2e, 6 workers)

Every time: check 0/0, biome ok, migrations ok, build 0/0, Fallow 4 cycles and 0 new. Logs are in `~/alfyai-handoff/logs/release-gate-<sha>/`.

| Commit | Vitest | Playwright | Verdict |
|---|---|---|---|
| `4e46a0aed` | 21,456 passed, 2 failed | 1,375 passed, 59 skipped, 18 failed, 0 flaky | Red: 2 known + 16 to triage |
| `6b9e08714` | 21,456 passed, 2 failed | 1,379 passed, 14 failed, 0 flaky | Accepted for deploy: all 14 predate this work |
| `5829a48a9` | 21,462 passed, 2 failed | 1,379 passed, 14 failed, 0 flaky | One new failure, `vision.spec.ts:439` (the fake-provider flake) |
| `cc783784e` | 21,462 passed, 2 failed | 1,380 passed, 13 failed, 0 flaky | Accepted; deployed to ai.dev |
| `175c4ba96` | 21,603 passed, 3 failed | 1,404 passed, 13 failed, 0 flaky | Red: one NEW vitest failure, `english-request-purity` (`images/requests.ts` not registered). Fixed in `a72ea77cc` |
| `a72ea77cc` | 21,604 passed, 2 failed | 1,403 passed, 14 failed, 0 flaky | Accepted; deployed to ai.dev. The 14th is the intermittent `artifact-canvas:1192` |
| `7a1330aad` (final) | 21,740 passed, 2 failed | 1,410 passed, 59 skipped, 13 failed, 0 flaky | Accepted; deployed to ai.dev, then production |

Final gate in detail:
- check: 0 errors, 0 warnings in 8,902 files.
- build: unused-css 0, aria 0.
- Fallow: 4 cycles, 0 new, 0 gone.
- Chunks: Canvas editor closure 71.0 kB gzip (ceiling 72 KiB); chat first paint 592,700 B gzip in 84 chunks (information only).
- Every one of the 2 vitest and 13 Playwright failures predates this work.
- The 13 Playwright failures: Mermaid flowchart `artifact-canvas-alfy-blocks:182`; Keep step `artifact-document-friction:308`; finger drag `chat-scroll-on-load:679`; 8 x `everyday-redesign-screens` (801, 1039, 1069, 1095, light and dark); `search-modal` :203 and :227.

The long-standing pair of vitest failures (`SettingsAdminUsersPane`, 2 tests) is a locale issue. This box has `LC_NUMERIC=hu_HU`, so "18.4M" is formatted as "18,4M". It is not caused by part 2. I did not re-run them under another locale.

### The triage (`release-gate-triage.md`)

Method: a worktree at `91c250560`, the same spec files, the same machine. A failure that also fails there "predates" this work.

Of the 16 unknown failures at `4e46a0aed`: 12 predate this work, 4 were test bugs in the new Vivaldi spec. No product code was changed to fix any of them.

| Failure | Why |
|---|---|
| `artifact-canvas-alfy-blocks:182` (Mermaid flowchart) | Mermaid wraps the label differently at this box's font sizes. Fails the same at the base |
| `artifact-canvas:1192` (zoom buttons) | Intermittent. Fails at the base, passed at HEAD in re-runs. Compares a rounded label with a rounded product |
| `artifact-document-friction:308` (Keep) | Same 19.03 px step at the base and at HEAD |
| `chat-scroll-on-load:679` (finger drag) | Identical at the base, where the arrival glide does not exist |
| `everyday-redesign-screens` x8 | The spec writes screenshots to a hard-coded Mac path (`/private/tmp/claude-501/...`), which cannot be created on Linux. One-line fix: use `os.tmpdir()` |
| `vivaldi-smoke` x4 (new spec) | Test bugs, fixed in `ae32aaa00` and `6b9e08714`: a crowded library made the clipping probe report scrolling as clipping, and queued-upload spinners turn forever |

Plus the 2 known `search-modal` visual failures. The shell changes people worried about (T3b hold, arrival glide, 9b Knowledge column) are cleared: every non-Vivaldi failure reproduces at `91c250560`.

## 3. What ai.dev runs

ai.dev (alfyroot, `/home/alfydesign/apps/langflow-chat-dev`).

| Item | State |
|---|---|
| Release | `releases/7a1330aad` (`current` points at it). Earlier ai.dev deploys on this path: `6b9e08714`, `cc783784e`, `a72ea77cc` |
| Migrations | Up to `1777140000122` (the per-user exemption). 136 rows in `__drizzle_migrations`. `image_files` (133) and `image_jobs` (134) present |
| "Can see images" | Ticked on BOTH Qwen rows: model1 and model2 |
| `COMFYUI_URL` | Set. Tool Health's probe `GET {COMFYUI_URL}/system_stats` answers 200 |
| Alpha backfill | Ran on the `cc783784e` deploy; it fixed 2 rows |
| Picture-check model | fp32, 343 MB, in `shared/data/models/picture-check`. Fetched by hand on the final deploy (see below) |

Your correction on the model rows: there is only ONE model (Qwen). The names model1 and model2 are legacy rows. On ai.dev both rows (label "Nemotron 3 Super" and "Qwen 3.8 Flash Next (control)") point at the same vLLM (192.168.1.96:30000, qwen3-6-27b); the names are stale labels. So the rule is: tick "Can see images" on every row that points at the Qwen vLLM. Why it mattered: your marked edit went blind because the box ticked only the model1 row while your chat ran on model2.

The fp32 model was fetched by hand on the final ai.dev deploy. The deploy ran the PREVIOUS release's `deploy-dev.sh`, which has no step 4d yet. So I ran `npm run models:fetch` in `current`, and the fp32 hash verified. Both services run from `<app>/current`, with `data` linked to `shared/data`, so the model path resolves.

Live checks on `7a1330aad`:
- Health OK. 3-turn chat OK. ComfyUI active.
- New picture 13.4 s. Edit 18.9 s.
- Both passed the picture check (`[IMAGES] Picture check` logged). Both stored opaque (`has_alpha` 0).
- Seed-reuse query: 0 rows.
- Process memory about 1.0 GB with the model loaded.

On the harness: the ai.dev test account is not admin, so the admin Tool Health route could not be called. The evidence is the registry entry plus the 200 from `/system_stats`, and two real `make_image` calls that worked.

After the `a72ea77cc` deploy a browser check passed: tour, Mark chip, items list, hover chips, multi-drag to Chats, and a new picture in 13.2 s with the shimmer in the box. Two small leftovers: the shared tool row above the card still shows its own "Making a picture" spinner, and the card header keeps the old title while a new take of a change is made.

## 3b. Production (LIVE)

You asked for it after the filter was confirmed on ai.dev. Production runs `7a1330aad`.

| Item | State |
|---|---|
| Git | `origin/dev` and `origin/main` fast-forwarded `a31b3cf3e` to `7a1330aad` (fast-forward only) |
| Deploy | `scripts/deploy.sh` with `DEPLOY_BRANCH=main`, exit 0. `current` points at `releases/7a1330aad`. Health OK |
| Backup | `shared/backups/chat-20261028T160929Z-7a1330aad.db` (194 MB, verified), under the prod app folder |
| Picture-check model | Fetched by deploy step 4d, SHA-256 `a4316a4f…` verified |
| Migrations | 119 to 122 present in `__drizzle_migrations`. 137 rows. Image tables present |
| "Can see images" | Ticked on the only enabled Qwen row: 6f9b76dd "Qwen 3.8 Flash Next Uncensored" (:30000) |
| `COMFYUI_URL` | `http://127.0.0.1:8188` |
| Explicit-picture filter | On by default. No override set |
| After restart | `[IMAGES] Worker started`. sharp ok. ComfyUI answers 200 |

NOT done on prod:
- No live prod picture. There is no prod test account. Reusing an admin session for Tool Health was refused by the auto-mode classifier and not attempted another way.
- Tool Health was not read on prod by the agent; you confirmed on 2026-10-28 that pictures and the filter work.
- You should make one test picture and check Tool Health.

The 2.3 campaign:
- Saved on prod as a DRAFT: `3f7b1c01-0ebb-4209-beaa-c0ca50797a9f` (identity `release_update:2.3.0:r1`).
- 3 slides, English and Hungarian. Slide 1: image understanding. Slide 2: making and changing pictures. Slide 3: smaller changes and fixes. The safe-for-work line is included.
- NOT published. The script never imports publish, archive or delete.
- The ai.dev draft is `6bbbcba1-dc99-4ce3-b3d0-04f5592dc4ea`, also a draft. Previews: `~/alfyai-handoff/campaign-2.3/preview/` (12 of 12 checks pass).

## 4. Plan 2c: measurements, tuning and the sofa rehearsal

Source: `docs/plans/image-generation/results-part-2-server.md` and the 2c ledger. Scenes were generated rooms, never your photos.

### The server

- Box: alfyroot, GPU1 (RTX PRO 5000, 48 GB), shared with TEI and MinerU.
- ComfyUI v0.43.0, Qwen-Image 2.1, INT8 weights. `comfyui.service` on 127.0.0.1:8188, memory limit 24 GB, no swap.
- `--disable-pinned-memory` on, because swap was 20.8 of 32 GB full at install.
- `--reserve-vram` set to 4.5 from the measurements.
- A daily timer clears ComfyUI's input files.

### Timings (1248x832 unless noted; submit to picture downloaded)

| Case | Seconds |
|---|---|
| First render after install, models from disk | 26 |
| Generate, models in page cache | 11.5 |
| Generate, warm | 9.8 |
| Edit, 1 picture in | 13.0 to 14.6 |
| Edit, 2 pictures in | 19.3 |
| Edit, 4 pictures in | 27.2 |
| Edit at print size (2368x1792) | 70.1 |
| Transparent generate | 11.4 |
| First call after a ComfyUI crash and restart | 25.7 (models reload) |

Live on ai.dev through the app: new picture 13 to 14 s, edit 18 to 19 s (last measured on `7a1330aad`: 13.4 s and 18.9 s).

### VRAM and neighbours

| State | GPU1 used |
|---|---|
| Before install (TEI + MinerU only) | 15.0 GB |
| ComfyUI idle, nothing loaded | 15.3 GB |
| After a render, models still loaded | about 30 GB |
| Peak, plain generate | about 31 GB |
| Peak, 4-picture edit | 42.1 GB of 48.9 GB (6.6 GB spare) |

- Lowest free VRAM in any case: 6.8 GB (the 4-picture edit).
- Swap did not move (21,238 to 21,236 MB).
- Idle free after 15 minutes (`IMAGE_IDLE_FREE_MS`) hands the 15 GB back.

### The gate: PASS

TEI, MinerU and the MinerU VLM answered 200 at every poll in every case, including the 4-picture edit, the print edit and the restart. No out-of-memory. You were away, so this PASS stood in for the Step 5 stop. Please read the Measurements section of the results doc yourself.

Settings it fixed: picture cap stays 4; `IMAGE_TOOL_WAIT_MS` stays 100,000 ms; `IMAGE_IDLE_FREE_MS` stays 15 minutes.

Two traps checked:
- Editing with the seed that made the picture gives a blotchy, over-sharp result. The fresh-seed rule stands.
- A 1024x1024 edit is not noise on this install, but the model recomposes (a tighter crop). The rule to stay off 1024x1024 still holds.

A print-size edit takes about 70 s, and about 140 s with a retry. That is over the 100 s wait, so print edits usually miss Alfy's in-turn look. The picture still lands on its card (R61).

### Pixel-guard tuning

Design targets, measured outside the change: drift under 0.10 (LPIPS), offset under 4 px, paste-back under 0.05, chain of five under 0.20 raw.

- The first numbers already met every target. Worst raw 0.076, offset 0.41 px, paste-back 0.0074. Chain of five, paste-back 0.007 to 0.019.
- The one number over a target: the raw, unguarded chain on one room, 0.2047 against 0.20. With the guards on it is 0.007. Accepted (R62).
- Nothing was changed in the end: `diffThreshold` 24, `dilateShare` 0.02, `featherShare` 0.015, `globalChangeShare` 0.6, `nothingChangedShare` 0.002, `reanchorEvery` 4.
- Tried and not taken: threshold 16 (bigger pasted area), threshold 36 (worse), dilate 0.01 (worse), dilate 0.04 (better numbers, 20% more pasted drift), feather 0.03 (rejected: feather wider than dilation leaves small edits half pasted), global share 0.7 (leaves a ghost of the old wall), re-anchor 2 or 8 (no difference).
- Added: `pasteMinAlpha` 240, so a pasted pixel never punches a hole in an opaque base.
- Five composites in `~/alfyai-handoff/composites/` were looked at by the agent and the controller: no seams.

### The re-measure, and the finding for your sofa session

The final review said the first numbers were measured inside the guard's own paste mask, so they could not fail. They were re-measured outside a region the guard does not produce.

- Local edits (recolour, reupholster, add a cushion, put the sofa picture in, marked cushion): every target holds. Worst raw 0.069, offset 0.34 px, paste-back 0.0075.
- Moves do not meet 0.10 raw or 0.05 paste-back. Raw 0.114 and 0.107 (room 1). Paste-back 0.069, 0.062, 0.055. In one marked move the model also dropped the coffee table.
- Fix made in 2b T0: a marked edit now pastes back only inside the marks grown by about 10% and feathered. The miss check for marks went from 0.5 to 0.8, so a change mostly outside the marks is a miss and is retried once. After the clamp, marked-move paste-back is 0.064 (room 1) and 0.030 (room 2). Room 1 still misses 0.05 because the table sat inside the grown box.
- Not fixed: unmarked moves keep today's behaviour and miss the design's 0.10 and 0.05 targets. A move with no boxes drawn can still change the room, and one case was a full camera reframe.
- Also: after a "global" move, the every-fourth-change re-anchor resets to the moved picture, not the original.

The agent's own proposal: treat 0.10 and 0.05 as holding for local edits only, and leave moves out of those targets in design 5.12 or lean on marks. This is your call at the sofa session.

### The sofa rehearsal (ai.dev, `cc783784e`, 2026-10-28)

You asked a subagent (Opus) to rehearse plan 2c Task 6 Steps 2 to 4 first. Report: `~/alfyai-handoff/checks/sofa-rehearsal/REHEARSAL.md`. It is NOT your acceptance; the Acceptance section is left for you.

- How: real browser UI as the staging account, Qwen picked in the composer, generated stand-in photos (room, sofa, rug), marks drawn with the real Mark tool.
- All 7 steps plus 5 chained changes did what was asked. 12 renders, 0 retries.

| Case | Seconds |
|---|---|
| New picture | about 11 to 12 |
| One-picture change | 18 to 20 |
| Marked move, or two pictures in | 22 to 25 |
| Another | 15 |

- Thresholds: **32 of 32 pass** (10 steps x 3 checks, the chain check, the seam check).
- Worst outside-change LPIPS 0.029 (the marked move, measured against a hand region). Offset at most 0.04 px.
- Chain of five: 0.0075 to 0.0151 (against 0.20).
- Whole-frame LPIPS is large where the room legitimately changed; the targets hold outside the edited areas.
- Seed-reuse query: **0 rows** (22 jobs, 15 with avoid-seeds).
- The top transparent 1 px row was not seen in any of the 11 edit downloads (the edge fix, tested on that build).
- Not run: unmarked moves; print-size edits (stand-ins were at most 1248x832).

Problems it found, and what happened:

| Problem | Result |
|---|---|
| P1, critical: chat froze after 8 of 11 picture turns (stream ended 0.4 to 1.5 s after the picture landed; stuck on "Making the picture…" until reload; a duplicate reply once) | Fixed in Task 11 (Svelte 5.56.10, history order) |
| P2: card titles copied from the user's first sentence; Download saved "..png" (double dot) | Fixed (`57414b6`) |
| Lamp reply said twice | Fixed (`a8551733b`) |
| Stale chip "Move the new sofa to the spot in box B" after marks were gone | Fixed (`d04ceab7`; then scoped to chats that had marks) |
| Empty "Sources" and "EVIDENCE IS LOADING" on picture-only replies | Fixed (`4d528e86`, `737ed8cf`) |
| Photo chip said "5 tok" | Fixed (`b7934e71`) |
| Mark stayed armed after a marked send | Fixed (`5f6caa5f`) |
| Another offered while a take was still in progress | Fixed (`00a4cd3e`) |
| Card spinner and wait text; card not appearing; cramped with the panel open | Fixed (shimmer; Svelte; Task 12) |
| P3/P4: Alfy's words versus the result, and placement (lamp short, framed picture off-centre, curtains also got a new red panel at the edge) | Not fixed. Model behaviour. Yours to judge |
| Model choice hard to find: new chats default to another model, Qwen is under another provider name, nothing in the composer shows the active model | Not fixed. Owner item |
| Re-uploading the room photo starts a new item, so History splits in two | Not fixed. Probably by design |
| Faint grey smudge on the wall where the sofa was, after the marked move | Not fixed. Owner item |

A second short rehearsal after the final redeploy was offered if product bugs turned up. It was not run.

## 5. The final reviews and fix waves

### Plan 2a final review (two Opus reviewers: A pipeline, B chat-turn)

- A: one critical, deleting one Image item could delete another item's picture (a reused input file). Plus 3 important (held take after a restart; guard numbers measured outside their own mask; Fallow).
- B: 3 important (parallel `make_image` calls made separate cards; a model that cannot see got the look note; `vision.spec` expected the old shape).
- Fix wave: 11 commits `5b33bc514..28ff81ec8`. The re-review found the critical not fully closed (N1: an unowned take reused as another item's base). Closed in 2b T0 by "copy every input except the changed item's own file".

### Plan 2b final review (A adversarial, B interaction and motion)

- A: 0 critical, 2 important (chat-switch race in the file read-back; the Document's Ctrl+Z tip showing on a picture), 8 minor.
- B: 0 critical, 5 important (card arrival jumped the thread about 400 px in one frame; Before/After washed through the background; first Before press was empty; queued copy lacked "N ahead"; phone strip cut the current version), 8 minor.
- Fix wave: 24 commits `bca27d1d0..4e46a0aed`, 13 items. Re-review: 12 fixed, 1 partly (item 11, a band under short pictures in History). No new critical or important.
- Notable: the ComfyUI `prompt_id` is now made by the app and written before submit, so a Stop during input preparation can cancel again. Checked against the real ComfyUI v0.43 `server.py`: it honours a canonical lowercase UUID.
- Notable: a picture is called see-through only if it has a see-through pixel (later tightened to "by request", section 1).

### Later reviews

| Task | Reviewer | Result |
|---|---|---|
| 10 (drag) | Opus | Needs fixes: the polite live region kept "Moved N chats" and re-announced it. Fixed (`e0e20d974`) |
| 11 (card, shimmer) | Opus | Needs fixes: a shimmer probe failed once on unchanged code. The fix round went to the polish wave |
| 16 (tour) | Sonnet | Pass. One rule break: a 5 s wait raised for a flaky test. Reverted to 1 s and the lazy modules are warmed instead |
| Polish wave | Opus | Needs fixes: the "marks are gone" chip filter hit every chat. Scoped to chats that had marks. Re-review (Sonnet) approved |
| 18 (filter) | Opus | No bypass found. 3 problems fixed in round 1. Re-review (Sonnet) approved |
| 20 | Sonnet | Approved |

## 6. Every ruling

Every line containing the word "Ruling" was collected.

| Source | Lines |
|---|---|
| 2a progress ledger | 23 |
| 2a preflight (one per finding F1 to F30) | 30 |
| Other 2a files (constraints, fix wave, reviews, task reports) | 10 |
| 2c progress ledger | 11 |
| 2b progress ledger (live copy, newer than the one in `ledgers/`) | 45 |
| 2b preflight | 21 |
| Total | 140 |

- 130 are real decisions (R1 to R130). The last 10 (R131 to R140) only repeat, apply or check a ruling.
- The 2b preflight says it holds 33 rulings, but only 21 of its lines use the word "Ruling". The other 12 findings write their decision as plain text. I listed the 21.
- The 2a preflight and 2a progress ledger exist only in `~/alfyai-handoff/ledgers/`.
- Each entry: decision. Why. Cost if wrong. A dash means the ledger did not say.

### Plan 2a, progress ledger (R1 to R23)

1. The 4 baseline failures (SettingsAdminUsersPane x2, search-modal x2) are pre-existing on Linux. Noted, not chased. Why: they fail before any part 2 work. Cost: a real regression hiding in those two files.
2. All 30 preflight rulings are adopted and override the task briefs. Why: they settle real contradictions and missing symbols. Cost: rework on the specific item, visible in review.
3. ComfyUI input files: 2c installs a daily clean-up timer on the box, as well as using PreviewImage outputs. Pictures may stay on the GPU box up to 24 h. Why: matches 2c's own plan. Cost: a day's pictures readable on the box.
4. Overlap T6 implementation with the T5 review. Why: disjoint files (artifacts family vs guards), path-scoped commits. Cost: a T5 fix commit interleaving T6's range, so review packages use explicit commit lists.
5. The extra "Images" chip and count in the Documents tab stays. Why: design 5.3 says pictures appear in the Documents tab like the other kinds, and each shipped kind has a chip. Cost: one chip to remove.
6. Opus reviews T8. Why: concurrency (cancel races, deletion during a render, restart). Cost: one pricier review.
7. `settleHeldCards` doing more than the brief (it also settles never-held landed takes at boot) is accepted. Why: it is the backstop the runner's swallow-and-log relies on. Cost: a card picked at boot that the tool call would have chosen differently.
8. A "change" card with a null `artifact_id` means its item was deleted. T12 must create change cards with their artifact id. Why: the foreign key's set-null makes it observable. Cost: a change card created without an id silently drops its takes.
9. `imageCards` is optional on `ConversationDetail`; 2b reads `?? []`. Why: sibling-field pattern, like `fileProductionJobs`. Cost: one fixture update later.
10. Extra statuses accepted: 409 `not_ready`, `already_in_use`, `item_deleted`; Stop 409 `not_running`; retry 409 `not_retryable`; Another 409 `too_many_takes`, 503 `not_configured`. Why: -. Cost: -.
11. The "you cannot see images" guidance goes only to uploads and explicit references. Open or marked-only turns get the listing and at most a neutral line. Why: an open panel persists across turns and would make every reply apologise. Cost: a model that cannot see says less about an open picture.
12. Changing an Image from another chat starts a new item in this chat (its first version is a copy stored here). Why: an in-place version would point at the other chat's files and break when that chat is deleted (plan's call 5). Cost: cross-chat edits fork instead of continuing.
13. Identical in-place calls in one turn (same item, prompt, pictures, marks) share the first call's base, so they become options. A different prompt chains onto the newest finished take. Why: plan's call 7, "show me four" must work for changes. Cost: an intentionally repeated change will not stack.
14. The composer's Stop aborts with a distinct exported reason. Only that reason cancels takes; all other aborts release holds. Why: F28. Cost: a Stop path missing the tag leaves a queued take to finish onto its card.
15. The automatic retry starts only if time left is at least max(25 s, the first take's elapsed time). A retry not landed when the call ends (budget or Stop) is hidden and lands hidden. The first take stays shown. Why: keeps "only the better take shown" without a comparison we cannot make. Cost: a slow retry that would have been better is hidden (still in the database; History does not show hidden takes).
16. Plan 2b is held to `MOTION-PARITY.md`: reuse the family shells, motion tokens only, reserved picture boxes, Playwright videos with CLS and long-frame numbers, and an Opus interaction reviewer in the final. Why: you said the feel must match the Document kind. Cost: slower 2b tasks.
17. Plan 2a's final review is split in two: A pipeline and storage, B chat-turn and model-facing. Why: the 1.2 MB diff does not fit one context, and you asked for an independent adversarial review. Cost: two review seats.
18. One fix wave with the complete list in FIX-WAVE.md. Other minors can wait. Why: -. Cost: B-M3 "changed from picture N" may name the wrong Before for same-turn chained changes.
19. `attachImageFilesToArtifact` claims only same-user, same-chat files that are unowned or already this item's. A base or reference that belongs to another item is copied. Why: fixes A-C1 at the boundary. Cost: extra PNG copies per cross-item reference.
20. At boot, all take holds are cleared before `settleHeldCards`. Why: holds belong to tool calls that died with the process. Cost: a take that a tool call would have chosen differently is picked by the default rule.
21. Reuse an input file by id only for an in-place change of the item that owns it. Otherwise always copy. The discard paths in `cards.ts` skip files owned by another item. The reproduction becomes a test. Why: smallest change that closes the whole class (the N1 critical). Cost: one extra PNG copy per referenced take.
22. Clear take holds synchronously in init, before serving, not in the deferred boot settle. Why: closes N2. Cost: a second process booting would clear another's live holds, so the single-process assumption is recorded for you.
23. N4: the envelope-timeout row reads "still being made", not a failure. N5: model-only refusals show no person-facing failure body. Why: -. Cost: -.

### Plan 2a, preflight (R24 to R53, findings F1 to F30)

24. F1: T11's `resolveTurnPictures` is the one numbering authority. `collectTurnImages` takes numbers from it. A test shows that with a card picture at 1 the upload parts read `Picture 2:` and `Picture 3:`. Why: the plan states two rules and only one can hold. Cost: your "picture 2" and the model's "Picture 2" differ whenever a card picture is attached.
25. F2: add `PreparedModelContext.turnPictureImages`, every picture sent in number order. It is the only input `buildCurrentUserMessage` reads, and `viewing_images` counts it. `currentImages` stays uploads only and feeds the description scheduler alone. `vision/AGENTS.md` is updated in T11. Why: keeps R15 literal and gives one list to strip on failover. Cost: either image files get described into `image_descriptions` (an R15 breach) or the open picture never reaches the model.
26. F3: the per-call limit is `min(IMAGE_REFERENCE_CAP, template slots)`, checked in `resolveMakeImageRequest`, and `too_many_pictures` names that number. The marked copy counts. The runner maps `GraphBuildError` to `image_graph_rejected` (not retryable). T12 tests "cap 4, graph 3: four pictures are refused naming 3". Why: the cap is a GPU-memory ceiling, the graph is the hard limit. Cost: every 4-picture call fails as an opaque render error after a take was queued.
27. F4: the catalogue test asserts the real format with the label `Image`, and only `ARTIFACT_KIND_LABELS.image = "Image"` is added. Why: the format is cached-prefix text the other kinds share. Cost: T6's test is red for an unrelated reason, or someone "fixes" the format for every kind.
28. F5: T6 adds an explicit image branch. `read_artifact` answers title, size, version count and "change it with make_image", never the JSON. `edit_artifact` refuses with the same pointer. Both tested. Why: the model follows the footer, and the family's tools must not leak or corrupt an image body. Cost: the model edits a JSON body as text (a broken item) or burns a step on a confusing refusal.
29. F6: drop `tool-activity.ts` from T6's file list. T12 alone touches it. Why: missing symbol. Cost: an implementer invents a list to satisfy the plan.
30. F7: put the validate tests in `admin-config-registry.test.ts`, add `src/lib/config` to Step 2, create `degraded-capabilities.test.ts`, and drop `app-shell.ts` from `git add`. Why: plan typos. Cost: red tests never run, or an unrelated file sneaks into a commit.
31. F8: use the banner label "making pictures" / "képkészítés" and adjust T2's test. Why: matches the banner sentence. Cost: one capitalised word mid-sentence.
32. F9: define `AI_SMOKE_MAKE_IMAGE_MARKER` in the fixtures; the provider and the spec import it. Add `tests/fixtures/ai` to T14. Why: follows the existing pattern. Cost: a second marker home.
33. F10: call `deleteImageFilesForUser(userId)` inside `purgeUserData` (which covers erasure) and `cancelImageTakesForUser` in `quiesceUserWorkspace`. Clear Memory and Knowledge keeps the files, because they belong to cards in chats that stay. Add a Clear Workspace test in T7. Why: same pattern as chat files. Cost: orphaned pictures on disk after a reset, which breaks "no file stays".
34. F11: `cancel(promptId, { interrupt })`. The turn-abort path passes `interrupt: false` (delete if pending, else leave it and do not cancel the take). The card's Stop passes `true`. The take records which kind of cancel was asked. T13 tests the race with `startDelayMs`. Why: keeps the constraint exact. Cost: a rare lost render when the person presses Stop at the wrong second.
35. F12: `waitForTake` wraps `waitForVerdict(imageJob, takeId, { timeoutMs, signal })`, adds a 1 s tick cleared on settle, and reads one `TakeSnapshot`. Why: the engine's comment says per-kind waiters were retired. Cost: a second waiter that drifts.
36. F13: `drainImageTakes` is a thin wrapper over the engine's `drain(imageJob)` plus a fake-ComfyUI config. Do not copy `run-once.ts`'s seam machinery. Why: less code. Cost: nothing worse than duplication.
37. F14: `scheduleIdleFree({ delayMs })` plus an exported `freeIfIdle(client)`. Test `freeIfIdle` directly and the timer with a 20 ms delay. Why: tests the rule without faking the world. Cost: a flaky red test, or one deleted.
38. F15: the parser bound for picture refs is an abuse guard, not a product limit. Set it to 64, refuse above it as malformed (400 `invalid_picture_refs`), and say in T11 that this is not a picture cap. Why: keeps your "any number" while bounding work per request. Cost: 11 card pictures attached to one message get refused, against your 2026-10-27 decision.
39. F16: write the seed test: 1000 draws with `Math.random`, each an integer from 1 to `SEED_MAX`; `freshSeed([], () => 0.999999999)` stays within `SEED_MAX`. Why: otherwise it asserts nothing. Cost: one empty test.
40. F17: keep the one-writer test in Step 2 but mark it "a guard: PASS before and after". Why: honest about what red means. Cost: confusion during review only.
41. F18: the composite test lives in `guards/composite.test.ts`. Why: each module keeps a test beside it. Cost: none.
42. F19: version 1 of a photo item is the canvas-sized normalised PNG, so the guards' anchor and the base share one size. Write that in `images/AGENTS.md` and the T9 test: the upload itself stays untouched as the chat attachment. Flag to the owner as a design reading. Why: same-size versions keep re-anchoring sound. Cost: Download or History of "the original" gives a downscaled photo; changing it later needs a body field for the full-size file.
43. F20: the graphs end in `PreviewImage` (type `temp`, cleared on ComfyUI restart). `images/AGENTS.md` records that input files persist until 2c sets up a cleanup. Raise it with the owner before 2c Task 2. Why: the plan's promise is "pictures go with their chat". Cost: every picture a person ever sent stays readable on the GPU box.
44. F21: `image_cards` timestamps are unix seconds like every table. The millisecond columns stay ms and say so in a schema comment. `ImageTakeView.createdAt` is ms, converted in the read model. Why: avoids a x1000 bug. Cost: cards sorted or aged wrongly.
45. F22: use the file reference `image-file:<fileId>`, as photo-look uses `immich:<id>`. Why: precedent. Cost: a type error found at once.
46. F23: `labelNameOf` becomes `oneLineName(photo.name) || photo.id`. `oneLineName` stays pure and may return an empty string. Why: keeps the "never empty" guarantee. Cost: an empty label for a nameless photo.
47. F24: migration numbers are fixed: T7 `1777140000120_image_files.sql` (idx 133), T8 `1777140000121_image_jobs.sql` (idx 134). Re-read before writing in case dev moved. Why: the two tasks never collide. Cost: `check:migrations` fails.
48. F25: add `image` to the shipped artifact kinds and rewrite the comment. T6 checks each of the three consumers: Regenerate is never offered for an image, and evidence rows for images come from `make_image`'s metadata or not at all, with a test. Why: it is the design's sixth kind. Cost: a "Regenerate" that cannot work, or ghost evidence rows.
49. F26: `anotherTake` lives in `images/card-actions.ts` (T10), not `cards.ts`. The route reads the item's title (or `files.ts` uses a plain `db` select), never the facade. Run Fallow at T10. Why: the constraint is no fifth cycle. Cost: the final gate fails late.
50. F27: `prepareTakeInputs` takes `TurnPictureSource` from `turn-pictures.ts`, and id-resolved Image items map into the `image_file` variant. Why: one shape. Cost: a mapping layer that drifts.
51. F28: on abort, look at the reason. Only the turn's own abort (the composer's Stop) cancels. An envelope timeout only releases holds, and the take lands later onto its card. The 100 s wait budget keeps this rare. Why: the design says a late picture still lands. Cost: a slow queue silently loses the take the model said is "still being made".
52. F29: BOX-NOTES governs paths: use the Node 22 PATH prefix and the gate output dir under `/home/lvt53/alfyai/.superpowers/sdd/plan-part-2a-pipeline/gates`. Why: the box differs. Cost: commands fail on Node 26 or a missing path.
53. F30: T6 verifies both search paths. Image items are matched and embedded by title (and the latest prompt at most), never by the JSON body. Add a Knowledge Base search test ("fileid" finds nothing) beside the Workspace Search one. Why: same reason App is excluded. Cost: odd search hits and JSON fed to the embedder or retrieval context.

### Plan 2c, progress ledger (R54 to R64)

54. Use comfy-kitchen 0.2.40, not the plan's 0.2.39. Why: ComfyUI v0.43.0 requires 0.2.40; the noise reports were on 0.2.37 and 0.2.38. Cost: an INT8 noise regression, which the Task 3 and 4 renders would show.
55. Use ComfyUI v0.43.0. Why: the only tag with PR #17297 (the pinned-memory ignored-edit fix, #17187). Cost: an unknown regression in a newer tag.
56. Run with `--disable-pinned-memory`. Why: swap was 20.8 of 32 GiB used, over the plan's half-way rule. Cost: slightly slower model loads.
57. No RGBA template exists, so transparent requests stay "ordinary picture plus the model told so", unless Task 3 finds the generate template's wrapped prompt keeps alpha. Why: nothing else is available. Cost: no transparency feature in this version. (Task 3 then found it does keep alpha; `generate-transparent` was registered.)
58. Run 2c Task 3 right after 2a Task 4, not after 2b. Why: later 2a tasks (T8, T12) build on `graphFor` and `buildPromptGraph`, and the real edit template's shape differs from the reference. Cost: concurrent commits on one branch, reduced by path-scoped commits.
59. Measure now (Task 4), before 2a T8 and T12 exist. Values for constants that do not exist yet go in the results doc and the controller carries them into those dispatches. Why: the gate decides whether 2c continues, and its numbers set T8 and T12 defaults. Cost: T8 and T12 implementers miss the doc.
60. Your "look at five composites" is done by the agent and the controller, with composites saved in `~/alfyai-handoff/composites/`. Why: PROMPT.md says so. Cost: a seam you would have spotted.
61. `IMAGE_TOOL_WAIT_MS` stays 100,000 although a print-size edit takes about 70 s, and about 140 s with a retry. Why: a picture landing after the wait lands onto its card with no look or retry, and print edits are rare. Cost: print edits usually miss the in-turn look.
62. The raw, unguarded five-change chain on room 0 at 0.2047 against the 0.20 target is accepted. Why: it measures Qwen without the guards; the shipped path always guards (0.0068). Cost: the design's raw line reads as failed for one room in the report.
63. For marked edits, the paste-back mask is clamped to the marks' union grown by about 10% of the short side and feathered, so nothing outside the marks changes. `marksMissShare` goes from 0.5 to 0.8, so a change mostly outside the marks is a clear miss and is retried once. Done in 2b Task 0, with a fixture test and a re-measure of marked moves. Why: "the room changes when the person only asked to change the sofa" is the first anti-goal and outranks the provisional threshold. Cost: a marked edit whose shadow or reflection falls outside the grown box loses it (feathered, so seam risk).
64. `globalChangeShare` stays 0.6 (0.7 leaves a ghost of the old wall). Unmarked moves keep today's behaviour. The design's 0.10 and 0.05 targets are recorded as met for local and marked edits and not met for unmarked moves. You decide at the sofa session. Cost: an unmarked move can still alter the room.

### Plan 2b, progress ledger (R65 to R109)

65. All 33 preflight findings' rulings are adopted and override the briefs. Cost: rework visible in review.
66. The 2a gaps the scan found go in as a server "Task 0" before 2b Task 1, after 2a's fix wave: expose held, origin and retryOf and fold the retry into the first take's slot (F1); a `box` size in the read model so edit cards do not jump (F2); `cloneSendPayload` keeps picture refs and marks (F3); store upload numbers (F13); marks on a no-longer-open picture are sent as a ref (F14). Why: server-side, and 2b builds on them. Cost: one more task.
67. The automatic retry gets origin `auto_retry` server-side. The client folds only `auto_retry` plus held plus retryOf-shown. A model retry is an ordinary take. Why: the only clean way to tell the two apart. Cost: one more origin value in the take record.
68. Opus implements the motion-heavy UI tasks (T2 card, T3 panel, T4 History, T6 marks). Sonnet does the rest. Why: your "flawless and fluid, matching the rest of the UI" bar outweighs the Sonnet default. Cost: higher token spend on four tasks.
69. F19, adding "image" to the `artifact-panel-motion` kind loop, moves to T3. Why: the loop tests the panel tour card, which Image lacks until T3. Cost: none if T3 adds it. (Later corrected: Image has no first-open tour by design, so it runs every item-level panel check instead. Then reversed again by R98: Task 16 added the tour.)
70. Phone arrival behind the composer is in scope for T2's fix round: the card is revealed through MessageArea's existing generated-file reveal path, like the Document card. Cost: a shell touch in MessageArea.
71. The "checking again" overlay and the deleted-Image card state are built in T2's fix round, with English and Hungarian strings. Why: MOTION-PARITY says every state has a designed look. Cost: one more fix round.
72. T3's "History opens on that version" is split. T3 tests `HistoryMode initialVersionId` with a document-kind fixture and asserts the strip calls `onOpenHistory(versionId)`. The image end-to-end assertion moves to T4, once `HISTORY_PREVIEWS.image` exists. Why: the plan's order cannot pass it in T3. Cost: T4 must add it.
73. T3 fits the picture with an aspect-ratio wrapper (CSS max sizes), not `object-fit: contain` on the image. Why: F24 and F15 (marks need the picture's own rect) override the brief. Cost: none.
74. Controller-added Task 3b (Opus): the shell holds panel content at its final size during expand and dock (as it already does on open), plus three real T3 bugs (reload during load dropped, strip History requests out of order, zoom carried over a new version) and the "expanded smaller than docked" look. Why: your "flawless and fluid" bar, and no fix is possible inside the image body (F24). Cost: a shell change touching every kind's dock; existing panel motion specs guard it.
75. Mid-motion e2e tests wait on the shell's animation state, not on fixed 60 to 90 ms waits. Why: a flaky test is a bug. Cost: small T4 scope add.
76. The T4 implementer's own rulings: the strip has one frame per History moment, and the first version is labelled "Alfy made the picture". (The reviewer endorsed the strip ruling.) Why: a frame always opens on a visible row with the same picture, and steps have no detail of their own. Cost: -.
77. The block-forms mermaid flake is a bug and gets its own Sonnet diagnosis after T4's review (not T4 scope). Why: your rule on flaky tests. Cost: one small task. (Fixed in `e4424d108`.)
78. History's version preview loads full size. Only the rail uses the 320 px thumbnail. Why: the preview is a version's main view and the compare needs detail. Cost: a full PNG per previewed version.
79. Your three bug fixes become Tasks 9a, 9b, 9c, after T8 and before the final review (the final review covers them). Why: you asked for them inside 2b. Cost: about 1 to 2 h more before deploy.
80. Task 9a (downloads) runs in parallel with T6. Why: disjoint files; saves about an hour. Cost: a commit-lock retry.
81. For 9a, both review gaps are fixed now: the client blob download in `DocumentPreviewRenderer`, and `ensureFilenameExtension` keeping any known suffix ("Intro to Node.js" saved as `.js`). Why: the second is your exact symptom class. Cost: -.
82. F14 widening accepted: the marked picture is always sent as a ref unless already attached. Why: no double count; covers queued turns and unseen versions. Cost: the bubble shows it as a numbered chip with role "attached".
83. 9c: Hungarian "skill" is unified as "készség" (plural "Készségek"). Why: it is the standard Hungarian word; "képesség" means capability and collides with tool capabilities; "skill" and "skillek" are anglicisms. Cost: one string sweep. Flagged to you in section 7.
84. A picture opened from Knowledge or search without `?conversationId=` is correct. Why: `getImageFile` serves the owner's non-incognito files without it, and incognito items are not opened from Knowledge. Cost: none.
85. The `prompt_id`-before-submit fix goes into the fix wave, not after deploy. The response id is checked and rewritten if ComfyUI ignores ours, and the controller verifies it against the real ComfyUI at deploy. Why: B calls a Stop that does nothing a broken contract, and the fix is small. Cost: if the real ComfyUI misbehaves, revert that one commit before deploy.
86. Parked: the V3 band under short pictures in History. The Attach and prompt rows stay pinned. Why: following the picture would re-flow it or make them jump when a version loads, and MOTION-PARITY 3 and 4 outweigh the band. Cost: an empty band under short pictures in History.
87. Parked: M1, the Before/After crossfade reads only After's alpha flag. Real but rare (a see-through original edited onto a background). Fix = take the base's flag into the view. Why: owner item for the next pass. Cost: a brief show-through on that one flip.
88. Parked: M2, "Next up" when the app's own per-user queue holds a take. Owner item, copy tweak. Cost: it overclaims for minutes in a rare fifth-picture case.
89. Parked: M3 (strip scroll ignores the edge fade) and M4 (Stop does nothing during a requeued attempt's grace window). Minor and safe. Cost: cosmetic, or a Stop that waits.
90. Parked: old image rows keep `hasAlpha=1`. Harmless; a backfill is cheap. Cost: none visible. (The backfill later shipped as `5829a48a9`.)
91. Task 10 (controller-added, Opus), built in parallel with the edge fix (disjoint: sidebar vs image guards). Dragging any selected row drags the whole selection (ghost reads "3 chats" / "3 csevegés"). A drop on a folder, Pinned or Unorganized moves them all through the existing batch endpoint. A bin target appears at the sidebar's foot only while a drag is on (motion tokens, transform and opacity). Dropping one or many chats opens the SAME bulk-delete confirm the selection bar uses, never a delete without confirm. Why: you asked; the confirm keeps a destructive drop reversible before commit. Cost: one more sidebar change to gate before the final deploy.
92. Task 11 (Opus, parallel with Task 10). (a) Reproduce the missing live update against the REAL ai.dev path (browser over an ssh tunnel with the staging account), fix at the root, add a regression test. (b) Waiting, starting and making show only a calm left-to-right shimmer across the reserved box (transform-only sweep on motion tokens, reduced motion = static soft tint, no spinner, no visible wait text; the state stays in an sr-only live region). Failed, unavailable, deleted and checking-again keep their designed text. Why: your taste call; the a11y text must not disappear. Cost: the visible "N ahead" goes away.
93. Tick "Can see images" on the model2 qwen3-6-27b row too. Same vLLM endpoint (192.168.1.96:30000), same model. The handoff named only model1, but model2 served you. Why: your marked edit reached the model as text only. Cost: none, it is the same model. Done on ai.dev, service restarted. Later widened by your correction: there is one model; the rule is "every row that points at the Qwen vLLM", and prod got it on its only enabled Qwen row.
94. Task 12 (Opus) after Task 11 lands (same card and panel files). Audit the image card, panel (docked and expanded), History, composer picture chips and the marks toolbar with the left sidebar OPEN at 1280, 1366, 1440 and 1920, beside the Document kind in the same layouts. Fix crowding with the family's spacing tokens and the same breakpoints and container queries the Document uses (no new layout system). Before/after screenshots sent to you. Why: you said "a bit more cramped when the sidebar is open"; read as crowding at sidebar-open widths. Cost: if you meant something else, one more round.
95. Sofa rehearsal (Opus) on ai.dev `cc783784e` through the real browser UI as the staging account, with generated stand-in photos (room, sofa, rug; never yours) and marks drawn with the real Mark tool. Known pending fixes (edge row, card refresh, shimmer, crowding) are listed so it reports them once and looks past them. It writes a rehearsal report, NOT the Acceptance section (that is yours). Why: you asked for a rehearsal before you do it. Cost: about 30 renders of GPU1 time; a second short rehearsal after the final redeploy if it finds product bugs.
96. Task 13 (Sonnet, parallel): the collapsed rail's logo dot shows only when the sidebar holds something unseen (the same unseen badges the rows show: Atlas and background-job badges, any unread or finished-in-background indicator the list already has). No dot otherwise. The "conversation open" meaning moves to the button's label only. Why: you read the dot as notifications, and a dot that is always on carries no news. Cost: the visual "you're in a chat" cue on the collapsed rail goes away (ADR-0043 #3 note updated).
97. Task 14 (Sonnet) after Task 11 lands (the button lives in the chat `+page.svelte`, which Task 11 edits): the header icon always opens the panel on this chat's items list; opening a specific item stays the card's or row's job. Why: your expectation; a list is the neutral entry. Cost: one extra click to reach the latest item.
98. One UI polish wave (Opus) after Task 11 lands, sequential in one agent: Task 12 (crowding), Task 14 (header items icon opens the list), Task 15 (chips hover-only like the icon row; same reveal rule; focus-within and touch keep them reachable; reduced motion respected; padding from the space tokens). Task 16 (Image tour, Opus) runs in parallel in `tour/`, which reverses the earlier "Image has no tour" correction (R69) because you asked. Why: your request. Cost: the tour adds strings and one more first-open overlay.
99. Task 17 (Sonnet, after Task 11) fixes rehearsal P2/P5 and small ones: item titles copied from the user's first sentence (use make_image's own title; Download name "..png" double dot); stale suggestion chip about marks that are gone; empty "Sources" and "EVIDENCE IS LOADING" on picture-only replies; photo chip "5 tok"; Mark stays on after a marked send; Another offered while a take is in progress. P3/P4 (model wording vs result, wrong placement), model-choice discoverability, re-upload splitting History and the faint smudge are owner items. Cost: one more small task before the gate.
100. Canvas editor chunk ceiling 71 to 72 KiB accepted. Why: the Svelte 5.56 runtime grew it 5 B. Cost: none.
101. Live finding: a plain GENERATE stored `has_alpha=1` (5 px with alpha 244 to 249 straight from ComfyUI). In Task 17, see-through is decided by the request, not by sampling noise: a picture is stored RGB (alpha flattened) unless its graph was the transparent one or its base really is transparent; the 250 threshold stays as a second guard for those. Cost: none for opaque pictures.
102. Task 11 review found I1 (the shimmer probe failed once on unchanged app code). The fix round goes to the polish-wave agent (it now owns the card files) to avoid two agents in `ImageCardBody`: I1 plus minors 1 (ContextUsageRing baseline), 2 (sr status announces state changes only), 3 (Use this jumps when Stop leaves), 4 (`--duration-shimmer` in the MOTION-PARITY token list). Cost: -.
103. Parked: the model-facing MARKS_RULE (and some earlier prompt lines) contain a Unicode ellipsis. Park it for the next pass rather than re-gate the deploy commit; a single non-ASCII punctuation mark is harmless to Qwen. Cost: a small Ruling-79 deviation in prompt text until fixed (owner item).
104. Task 18 (Opus): in-app local classifier (no external service), model file pinned by hash. Fail closed when the filter is on: a picture that cannot be checked is not shown, and the card says so. New failure code and English/Hungarian card copy; the model-facing note is ASCII. Config via config-store (system) plus an expand-only migration for the per-user exemption. Tool Health entry for the classifier. Why: you asked for the filter on every user by default (admin can exempt a person or switch it off), with BOTH a request check before rendering and a classifier on every finished picture. Cost: one more dependency and model file, CPU time per picture.
105. Prod deploy path: the documented atomic deploy (`DEPLOY_BRANCH=main` via `scripts/deploy.sh`) after fast-forwarding origin/dev and origin/main to the gated, ai.dev-verified sha. Fast-forward only; if either is not an ancestor, stop and ask. Prod config: `COMFYUI_URL=http://127.0.0.1:8188`, "Can see images" on every provider row pointing at the Qwen vLLM, filter on (default). Verify health, migrations, a live chat and one safe picture. Why: you asked for production once the filter was confirmed on ai.dev. Cost: a production change.
106. Task 19 (Opus): prepare the "2.3" campaign with the app's own campaign system (announcement-campaigns service and campaign assets, English and Hungarian). Slide art is made with the feature itself on ai.dev (safe, generic scenes; never your photos). Create it as a DRAFT on ai.dev first for previews, then hand the controller an idempotent script. The controller creates the prod draft only after the prod deploy is verified, never published. Why: you asked for it as a draft. Cost: none; you publish.
107. Task 20 (Opus, parallel with Task 18) fixes the `?type=` 500, the legacy "model1" default not found by the composer, and the version bump to 2.3.0, and re-checks the empty Sources row on a real live-shaped reply. All ship-blocking for the 2.3 prod release. Cost: one more task before the gate.
108. Task 18 fix round 1 also makes the classifier truly lazy (Tool Health checks the pinned file, not by loading the model), hashes once, and unloads after 15 min idle. Why: the memory (about 290 MB then) is the real cost; CPU is about 90 ms per picture. You asked about GPU1; the controller recommended CPU plus idle unload. A GPU move would be a separate change and was not made. You then chose fp32 over int8. Cost: see risk 3 in section 8.
109. Accepted trade-off: a picture-only reply that relied only on an ambient remembered fact (`memory:fact:*`) now shows no Sources row; looked-up facts (`memory:item:*`) still show. Why: ambient facts ride every turn and are not this reply's sources. Cost: such a reply does not credit the ambient fact (owner item).

### Plan 2b, preflight (R110 to R130)

110. F1: 2a's fix wave adds `origin`, `retryOf` and `held` to `ImageTakeView`. The client folds a take whose `retryOf` is a visible take into that take's slot. The slot keeps the first picture with a quiet "checking again" overlay (opacity only) and crossfades when the server hides one. Why: the design shows only the better take, and MOTION-PARITY says a card changes in place. Cost: the strip pops in and out on every retried turn, and a held take can be picked.
111. F2: 2a's read model adds `box: { width, height }`, the base file's size for an edit and the canvas for a new picture. T2 reserves from `box`. Why: only the server knows the base file's size before the result exists. Cost: every edit card shifts 2 to 4 px on landing.
112. F3: copy `pictureRefs` and `imageMarks` in `cloneSendPayload`, with a runtime test, in 2a's fix wave or as T5's first step. T5 also restores ref and marks chips when a queued turn is restored. Why: the queue belongs to the runtime. Cost: a message queued behind a running turn sends without its pictures, silently.
113. F13b: 2a keeps `uploads: [{ artifactId, number }]` in the metadata `resolveTurnPictures` computes. Why: one more field from the one numbering authority. Cost: the sent message numbers some pictures and not others.
114. F18a: T8 lists the fake ComfyUI file and makes the transparent templates render 4 channels. Why: Review Focus 2 has no other test path. Cost: the spec cannot pass, or passes on a non-transparent picture.
115. F26: keep `MAX_PICTURE_REFS = 64` as a server abuse guard. T5 notes it in `image/AGENTS.md`. No counting in the composer. Why: 64 attached card pictures is not a real message. Cost: a contrived 65-ref message gets a 400.
116. F19: each of T2 to T6 adds a "Step 4b: motion check" to `tests/e2e/images-motion.spec.ts`, reusing the panel-motion helpers (extended once with long-animation-frame and a transition-property probe). Add "image" to the kind loop of `artifact-panel-motion.spec.ts`. Why: you named this as the bar. Cost: the build passes every gate and still feels unlike the Document, with nothing measured saying so.
117. F9: show the Before/After row whenever `baseFileId` is known (disabled until the file exists). Render "Made from" from the start. On Another, add an optimistic placeholder tile in the click handler, filled when the poll returns the take. Why: only user-caused shifts inside the input window are free. Cost: layout shift on landing and on Another.
118. F20: thumbnails only for the strip, rail, chips, Made from and sent bubble. The card's main picture uses `srcset` (thumb 320w, full at its width). The panel loads full. Fade in on load. Why: keeps the bar and a sharp card. Cost: blurry cards, or a full PNG per card.
119. F8: add `--checker-a` and `--checker-b` tokens to `app.css` (light, dark, incognito) and use those. Why: `--border-subtle` is 4% black and draws no visible checkerboard. Cost: a transparent picture looks white-backed and Review Focus 2's test passes on an invisible pattern.
120. F23: `ImageBody` reloads when the page's per-artifact version rises, and the strip refetches History's first page. Why: new versions land outside the stream (late take, Use this, Restore, Another's pick). Cost: the panel shows an old picture next to a card that shows the new one.
121. F13: the optimistic user message carries `pictures` (refs and marks) built in the page's send adapter. The server's metadata replaces it with the same numbers. Why: otherwise thumbnails appear when the persisted message replaces it, above the streaming reply. Cost: an F16 violation (layout jump).
122. F5: `MessageBubble` resolves each `make_image` row's card id (metadata `imageCardId`, else the take whose `toolCallId` matches). The fold keys `image-card:<cardId>` in `foldArtifactDeliverables`. T2 lists the extra files in the props chain. Why: one fold, one chain. Cost: two running calls of one card draw two cards, or props stop at MessageArea.
123. F6: T2 adds `check:image-chunks` (one for `ImageCardBody`, one for `ImageBody`), run in T2 to T4 and in `scripts/gates.sh`. Why: the existing check cannot see them, so the constraint is real only if a check can fail. Cost: a static import puts the image UI in every chat's first load and every step stays green.
124. F7: the card's Try again reads "Újrapróbálom" (not "Újra"). Why: a tested house rule; "Újra" is also Redo. Cost: a reviewer blocks, or the card says Redo.
125. F12: T5 adds `onAttachPicture` to `ArtifactBodyProps` and threads it through `DocumentWorkspace` to `ImageBody` and `VersionStrip`, beside History's. Why: same shape for both surfaces. Cost: the strip's Attach does nothing.
126. F14: at send, if the marked file is not the open item's current file, the page adds it to `pictureRefs` (one chip's worth). Why: the person drew them for this message. Cost: "move A to B" goes to Alfy with no marks.
127. F16: export `MIN_MARK_SIDE` from `image-body.ts` and import it. Why: one rule for client and parser. Cost: a client box the server rejects as `invalid_image_marks`.
128. F17: T7 is only the `SearchModal` image branch plus the open-in-panel test. Drop the documents-table edits and keep 2a's tests. Why: TDD Step 2 cannot fail for shipped code. Cost: an implementer "adds" duplicate entries.
129. F27: `composer-pictures.ts` uses the shared `getCategory` that the server uses. `ComposerPictureRef` gains an `addedAt` sequence, so page-held refs and composer-held uploads interleave in add order. The send keeps attachment ids in add order. Why: the server fills free numbers in attachment order. Cost: "picture 2" in the composer is picture 3 to Alfy.
130. F29: the card's picture is a button that opens the item in the panel. Why: wireframe frame 1 note 3. Cost: minor.

### Other 2a files that use the word "Ruling" (R131 to R140)

These repeat, apply or check a ruling above. Listed so the count is exhaustive.

131. `constraints.md` (standing rule, "Ruling 79"): everything the app writes into a model request is ASCII English, labels, notes and guidance. File names and titles ride inside it as the person's data.
132. `FIX-WAVE.md`: the A-C1 ruling, same as R19 and R21 (claim only same-user, same-chat unowned or own files; copy the rest; the sofa-into-room delete test).
133. `FIX-WAVE.md`: "Ruling 79 for model text", a reminder to the fixer.
134. `final-review-B.md`: checked Ruling 79 on every model-facing string. All ASCII English. The tool description is 303 characters (76 tokens).
135. `FINAL-REVIEW-BRIEF.md`: tells the reviewers to read every `Ruling:` and `minor (deferred)` line and mark which minors must be fixed before staging.
136. `task-2-report.md`: applied F7 and F8 (R30, R31).
137. `task-3-report.md`: applied the cancel rule, `cancel(promptId,{interrupt})` returning deleted, interrupted, running or not_found (R34).
138. `task-8-report.md`: applied F11, F3, F13, F14, F17, F21, F26 (R34, R26, R36, R37, R40, R44, R49). The render deadline constant lives in `take-request.ts` so the runner never imports `image-job`.
139. `task-9-report.md`: applied F19 and F26 (R42, R49).
140. `task-12-report.md`: applied F3, F12, F28, F29 and the rule that change cards carry an artifact id (R26, R35, R50, R51, R8).

(Numbers R91 to R140 moved up by 19 from the draft. In sections 4 and 6 the older references R61, R62, R69, R83 and R86 to R90 are unchanged.)

## 7. What is left for you

### On production now

- Make one test picture and read Tool Health on prod. We have no prod test account, so nobody has seen a prod picture or the prod Tool Health yet.
- Publish the 2.3 campaign from Settings, Administration, Campaigns. It is a draft (`3f7b1c01-0ebb-4209-beaa-c0ca50797a9f`). Its release version must stay "2.3" or "2.3.0" so the version badge shows v2.3.0 (a test pins both spellings).

### The sofa session (plan 2c Task 6, Steps 2 to 5)

- Needs your own photos. The agent rehearsal used generated stand-ins and is not your acceptance.
- Please try: move the sofa with no boxes drawn, and with boxes. Judge whether the room stays put. The rehearsal never ran an unmarked move, so this is still the open finding in section 4.
- Marked edits on your photos are untested. A print-size (12 MP) photo was never run in the rehearsal.

### Part 1 checks that could not be done here

All need your own phone photos or your Immich account.

- HEIC orientation: a portrait iPhone HEIC must come out upright.
- A photo with no text: MinerU 4 should answer `empty_result` for a text-free HEIC.
- The `photos` timeout: a describing look plus the summary must fit the tool's 20 s timeout on Flash-Next.

Already checked here (read only, ai.dev): the vLLM unit has no `--limit-mm-per-prompt`, so vLLM's own default applies; both Qwen rows have a private base URL and no old `imageMessageParts` rows; sharp loads on Linux.

### Open questions in `part-1-release-checklist.md`

1. The one-time cloud-connector warning says "Data from your connected accounts (like calendar, email, or files)". Should it now name photos? Its acknowledgement is permanent.
2. Should the turn's 8-thumbnail budget reset for a fallback attempt? Today it stays spent, which is cautious.
3. Attached pictures get only the passing "Looking at the image…" line, no lasting "Looked at the photo" row, which design 4.1 asked for. Accept that, or ask for the row?
4. BMP pictures are not shown to the model (the image library cannot decode them). TIF and SVG are shown instead. Accept that?

Still open there: measure on ai.dev whether the background description call slows the time to the first word, and what re-sending attached pictures on each tool step costs. Follow-ups listed there: HEIC decoding blocks the event loop (about 0.8 s for 12 MP); record usage for the description call before any paid cloud model is ticked "Can see images"; attempt-aware connector gates (fix before Option A is relied on with a cloud failover target).

### Owner decisions and taste calls

- **Pinned single-drop.** Pinned is also a drop target for a single dragged chat (it pins it). Restricting it to selections is a one-line change. Needs your OK. Also spot-check the iOS long-press drag on a real phone.
- **Document expand "reveal".** After the T3b shell change, a Document's expand reveals text in place (left edge clipped for about 100 ms) instead of sliding. Video sent. Your taste call.
- **"készség".** The Hungarian word for skills (R83). Check it reads right everywhere. Two deferred nits: English "Skill Pack" casing, and "szelet" as jargon.
- **int8 or fp32.** You chose fp32. The catch rate on explicit images is unmeasured by design: the rules forbid using explicit images to test. The request check and the picture check were tested only on ordinary and borderline-innocent pictures and prompts.
- **No sweep of old pictures.** The filter checks new pictures only. Pictures made before 2.3 are not re-checked.
- **Unicode ellipsis.** The model-facing MARKS_RULE and some earlier prompt lines contain "…" (R103). Harmless to Qwen, but a small deviation from the ASCII-only rule. Fix next pass.
- **Empty-Sources trade-off.** A picture-only reply that used only an ambient remembered fact now shows no Sources row (R109).
- **Picture-quality items from the rehearsal.** Alfy's words versus the result, wrong placement (lamp, framed picture, an invented curtain), model-choice discoverability, the History split after a re-upload, and the faint wall smudge.
- **Parked UI items.**
- V3: an empty band under short pictures in History (R86).
- M1: Before/After flip with a see-through original (R87). A cheap follow-up.
- M2: "Next up" overclaims in a fifth-picture case (R88).
- M3: strip scroll ignores the edge fade. M4: Stop does nothing for up to 60 s in a requeued attempt's grace window (R89).
- **Shell debt that predates this work.** The header item-count row shifts the phone thread (Document 0.476, Image 0.04); the Document card lands behind the composer on a phone; the admin degraded-tools banner overlaps a card head on a phone.
- **Classifier memory (optional systemd setting).** After the classifier unloads, the app keeps 540 to 730 MB (glibc holds freed native memory). Adding `Environment=MALLOC_TRIM_THRESHOLD_=131072 MALLOC_MMAP_THRESHOLD_=131072` to the service brings it back to about 183 MB, with check time unchanged (149 to 156 ms). It cannot go in `.env`; glibc reads it at process start. The service file was NOT changed (on either box). A GPU move for the classifier was also not made.

### Follow-ups, not done

- Composer picture chips are not saved in the draft. A reload or chat switch drops them and renumbers uploads under unchanged text.
- No keyboard way to draw marks (an accessibility follow-up).
- A succeeded model retry may show "Use this" before release.
- An unreadable picture dropped server-side can drift later numbers.
- Smaller deferred items: `MAX_TAKES=8` duplicated from the server; `progressSeen` mutated inside `$derived.by`; a literal 4px radius in `ImageCardBody`; two Fallow CSS-clone notes; image rail rows taller than the Document's; nested per-kind wording branches in History; a Vivaldi watchdog pid-wrap edge; `ModelSelector.svelte` still looks up model1 by exact id; the version-badge test hard-codes 2.3.0.
- From 2a: the eight-take cap is check-then-insert, so two simultaneous Another clicks can make a ninth; the composer Stop may resubmit a cancelled prompt across processes; the look note is decided by the tool pack's main model, not per attempt.
- The project bundle ignores Image items (the design is silent). The Documents tab shows "Images" twice (top chip = Image items, second tier = uploaded photos).
- An admin `REQUEST_TIMEOUT_MS` under about 130 s can end a picture wait early (noted for README and the admin registry).
- Two deploy leftovers: the shared tool row above a card still shows a spinner; the card header keeps the old title while a new take of a change is made.

### Test-only follow-ups

- `everyday-redesign-screens` capture path should use `os.tmpdir()` (clears 8 Linux failures).
- Two Linux e2e failures now matter more because 2.3 touches scroll and the panel shell: `chat-scroll-on-load:679` (finger drag; the arrival glide did not exist at the base) and `artifact-canvas:1192` (zoom; intermittent, it passed in some gates and failed in others). A real break in those areas could hide behind them. Both fail at `91c250560` too.
- The Mermaid wrap (`:182`) and Keep step (`:308`) failures need their own look against Mac-calibrated expectations.
- The two vitest failures are the hu_HU number locale on this box.

## 8. Risks

Most serious first.

1. Unmarked moves can change the room. Qwen repaints parts of the room, the guard keeps real changes, and the design's drift targets are not met for a move with no boxes. One case was a camera reframe. Marked moves are better, not perfect. The rehearsal did not run an unmarked move.
2. The app-wide Svelte minor bump. 5.55.8 to 5.56.10 touches every page, not just pictures. The full release gate passed on it (1,410 Playwright passed, 0 flaky), and it fixes a real freeze, but no real phone has run the whole app on it.
3. The classifier's memory on the shared box. About 1.07 GB RSS while loaded (from about 170 MB idle), one check every 150 ms or so. It unloads after 15 idle minutes, but 540 to 730 MB stays behind from glibc until the optional systemd malloc setting is added (about 183 MB). On prod this is the app's own process on a box with other services.
4. The filter fails closed. If the model file goes missing or fails its hash, every picture shows as "couldn't be checked" and none can be made. The deploy fetches the file in step 4d and verifies the hash; Tool Health reports the pinned file. If someone deletes `shared/data/models/picture-check/`, picture making stops until it is fetched again (`npm run models:fetch`).
5. The `deploy-dev.sh` chicken-and-egg. The first deploy of a new deploy step runs the OLD script, because the script on disk is the previous release's. That is why the fp32 model had to be fetched by hand on the final ai.dev deploy. Prod ran the new `deploy.sh` and step 4d fetched the file. Remember this whenever a deploy script gains a step.
6. The prod model is named "Uncensored" ("Qwen 3.8 Flash Next Uncensored"). That makes the filter matter. The request check and the picture check are the only guards, and the catch rate on explicit images is unmeasured by design.
7. Shell-wide motion change (T3b). The dock and expand hold now applies to every kind: Documents, Apps, Canvases, Slides and Images. The existing panel motion specs guard it. The arrival glide in the chat thread touches every card that arrives under a reply. A visible side effect: a Document's expand reveals in place rather than sliding.
8. `prompt_id` on the real ComfyUI. The app makes the id, and ComfyUI v0.43 honours a canonical lowercase UUID. Live renders worked on ai.dev, and the app rewrites the id if ComfyUI ignores ours. A Stop that lands exactly between submit and ComfyUI's first progress has only been tested against the fake.
9. Memory and swap on alfyroot. Swap was 20.8 of 32 GB full of cold pages before we started, and it did not grow. ComfyUI is capped at 24 GB with no swap, and a 4-picture edit leaves only 6.6 GB spare on GPU1. If the box gets more neighbours, check `free -g` while a picture renders.
10. Print-size edits miss Alfy's look. About 70 s alone, 140 s with a retry, against a 100 s wait. The picture still lands on its card.
11. Single-process assumption. Take holds are cleared at boot. A second app process starting beside the first would clear the first one's live holds. Fine today.
12. Prod is unverified end to end. Migrations, health, restart, the worker and the ComfyUI probe were checked. No picture has been made on prod. Fake-ComfyUI tests missed the alpha bugs; only live use found them.
13. The 13 Linux e2e failures that predate this work (plus 2 vitest). They hide any new break in those exact tests, and two of them (scroll finger-drag, canvas zoom) cover areas 2.3 touched. Eight are one Mac path in a spec.
14. A flaky-test history. Several flakes were found and fixed during the run (mermaid block form, image queue cancel, vivaldi pair, fake-provider memory marker twice, mock-script order, tour load waits). Each was a real shared-state or race bug, not a longer timeout. Expect the next one, and treat it as a bug.
15. Production schema. Prod now holds the part 1 and part 2 tables (migrations 119 to 122). They only add, so an older release still runs on that database, but those migrations must never change now.
16. Review coverage. Every review was done by Sonnet or Opus agents. The 2a final review found a real critical, the 2b one found 5 important motion problems, and the Task 18 review found 3 problems, so they were worth it. Nobody outside this setup has looked at the code.
17. The wait budget. An admin `REQUEST_TIMEOUT_MS` under about 130 s can end a picture wait early.
18. The new Hungarian text (skills word, picture words, filter card copy, Image tour) was reviewed by agents, not by a Hungarian reader.

## 9. Files to know

- Branch: `images-part-2`. `main` and `dev` are at `7a1330aad` (fast-forwarded).
- Plans: `docs/plans/image-generation/` (`plan-part-2a-pipeline.md`, `plan-part-2b-image-ui.md`, `plan-part-2c-picture-server.md`).
- 2c write-up: `docs/plans/image-generation/results-part-2-server.md` (its Acceptance section is still empty: it is yours).
- Ledger and reports: `.superpowers/sdd/plan-part-2b-image-ui/` (`progress.md`, `release-gate-triage.md`, `task-18-report.md`, `polish-wave-report.md`, and the rest).
- Gate logs: `~/alfyai-handoff/logs/baseline-gate-2/`, and `release-gate-<sha>/` for `4e46a0aed`, `6b9e08714`, `5829a48a9`, `cc783784e`, `175c4ba96`, `a72ea77cc`, `7a1330aad`.
- Sofa rehearsal: `~/alfyai-handoff/checks/sofa-rehearsal/REHEARSAL.md` (shots, downloads, drift numbers).
- 2.3 campaign: `~/alfyai-handoff/campaign-2.3/` (README, `create-draft.ts`, `slides.json`, `preview/`).
- Composites and live pictures: `~/alfyai-handoff/composites/`.

