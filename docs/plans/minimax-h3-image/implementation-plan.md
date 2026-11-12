# MiniMax-H3-Image 4 MP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (or `superpowers:executing-plans`) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repository's delivery contract is the `alfyai-orchestrated-delivery` skill.

**Goal:** Make MiniMax-H3-Image a first-class 4 MP picture model in AlfyAI behind a live Admin “Picture model” switch, with Qwen-Image-2.1's existing 1 MP / 4 MP print / transparent path left exactly as it is, and with no H3 transparency, no 8/16 MP options, and no automatic Qwen transparent routing.

**Architecture:** Keep the Qwen ComfyUI 0.43 service on `127.0.0.1:8188` untouched. Add a separate ComfyUI 0.44 service on `127.0.0.1:8189` for H3 (NVFP4, 6 steps, 4 MP). The app selects one global `IMAGE_MODEL` (`h3` or `qwen`) in Admin; each take records the model it was enqueued with, so switching the global model only affects new takes. H3 gets its own 4 MP templates/canvas and prompt framing; Qwen keeps its 1 MP/4 MP-print templates/canvas and transparent route unchanged.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, TypeScript, Drizzle/SQLite, Vitest, Playwright, ComfyUI (Python, systemd), `sharp`, existing image job engine.

**Spec:** [assessment.md](./assessment.md) plus the A/B contact sheets `samples/ab-t2i.jpg`, `samples/ab-edits.jpg`, `samples/ab-variety.jpg`. The owner's decisions: H3 at 4 MP; MinerU 0.2; no GPU0; no w4a8; no 8/16 MP; no transparent route to Qwen; a live Admin fallback switch; Qwen serving unchanged.

## Global Constraints

- **H3 is 4 MP only.** No 8 MP, no 16 MP, no `print` enlargement. H3's `print` flag is accepted but has no effect; the H3 canvas is 4 MP.
- **Qwen is unchanged in serving.** `comfyui.service` stays 0.43 on 8188, `--reserve-vram 4.5`, `MemoryMax=24G`, same model files, 30 steps, 1 MP, 4 MP print, transparent, `COMFYUI_URL`. Do not edit the Qwen unit, model files, templates, canvas, or Qwen path behavior.
- **H3 is a separate service.** `comfyui-h3.service` at ComfyUI 0.44 (`ede4e5fe8d`), `comfy-kitchen 0.2.41`, templates 0.11.103, H3 NVFP4/TE/VAE, GPU1, `127.0.0.1:8189`, `MemoryMax=32G`, `MemorySwapMax=0`, `--reserve-vram 2`, `--disable-pinned-memory`.
- **MinerU stays 0.2.** The H3 4 MP fit was tested against MinerU 0.2; do not change it in this plan.
- **No transparent route to Qwen.** H3 transparent requests are refused with a clear tool message; the person switches the Admin “Picture model” to Qwen for transparent. No per-action auto-routing.
- **Admin fallback switch.** `IMAGE_MODEL` is global and live; the Qwen and H3 URLs are separate (`COMFYUI_URL`, `COMFYUI_H3_URL`). In-flight takes keep the model stored in their request.
- **H3 4 MP at 0.2 is a knife-edge fit.** No 8 MP edits, no extra concurrent 4 MP H3 plus another model; the H3 service and Qwen service are one-at-a-time on the GPU.
- **Cross-model free is mandatory.** H3 4 MP peaks at 48.2–48.3 GB while Qwen loaded uses about 35 GB. Before a take uses the selected model, the app must `POST /free {unload_models:true, free_memory:true}` to the **other** configured service, not only rely on the idle timer. The first H3-after-Qwen take OOMs otherwise. The selected service is not freed.
- **File-production cap.** The live admin config is already 50 MB/image and 400 MB total; verify it, do not enlarge options beyond 4 MP.
- **No GPU0, no w4a8.** Do not touch the 6000 or install another format.
- **Qwen regression is mandatory.** The Qwen 1 MP/4 MP-print/transparent tests and real smoke must pass unchanged.
- **No push, deploy, or live app switch without the owner's explicit go.** The H3 service may be prepared on the box; production `IMAGE_MODEL=h3` waits for staging and the owner.
- **The worktree is shared and already dirty.** `AGENTS.md` is modified and many docs/images/artifacts are untracked from earlier work. Do not revert, overwrite, or commit those; stage only the files a task owns. The branch is `dev` (ahead 5 / behind 314); never push.

## Review Focus

These are the five failure modes most likely to bite; each has a test in the owning task.

1. **Admin switch while takes are in flight.** A take enqueued under H3 must finish under H3 even if the admin switches to Qwen, and vice versa. The new take uses the new model. No stuck card, no wrong `/free`. **The pre-take cross-model free must run before the selected service loads its models** — otherwise the first H3-after-Qwen take OOMs at 4 MP.
2. **H3 transparent request.** It must be refused before a card/take, with a message that tells the person to switch the Admin picture model to Qwen. Qwen transparent must remain exactly as before. No silent H3 `graphFor` fallback.
3. **H3 `print` / 8–16 MP.** The H3 path must never build an 8/16 MP canvas or expose it; `print` is a no-op at 4 MP. Qwen's 4 MP print is unchanged.
4. **Qwen path unchanged.** 1 MP canvases, 30 steps, `COMFYUI_URL`, 0.43 service, 4 MP print, transparent, and Qwen tests must show no drift.
5. **H3 4 MP edit mechanics.** `<Picture 1>` framing, the 10 image slots, marks/boxed behavior, the guard, 4 MP files, and the MinerU 0.2 memory margin. The H3 boxed edit worked; the chained removal is accepted by the owner but the guard/retry must still run.

---

## Slices

| # | Outcome | Owner | Write scope | Verification |
|---|---|---|---|---|
| 1 | Admin “Picture model” switch + H3 URL; Qwen path untouched | worker-b | env/config-store/admin registry/admin route/settings page/pages.ts/i18n/README/.env/tests | focused Vitest + settings component tests |
| 2 | H3 4 MP templates, canvas, model-on-take, runner, client, tool | worker-a | `src/lib/server/services/images/**` (H3 parts), `make-image.ts`, image AGENTS, tests | focused Vitest/contract tests |
| 3 | Permanent H3 0.44 service; Qwen service untouched | worker-c | the box: `/etc/systemd/system/comfyui-h3.service`, H3 worktree/venv/models, H3 clean; no app code | systemd/health + real H3/Qwen smoke on the box |
| 4 | e2e and real smoke coverage for the switch/H3/Qwen | worker-d | `tests/e2e/images*`, `settings-admin.spec.ts`, `images-helpers.ts`, fake where needed | focused Playwright + real box |
| 5 | Impartial final review | judge | no writes | full gate + box checklist, PASS/FAIL |
| 6 | Integration, final gate, rollout | orchestrator | merge/review only | `scripts/gates.sh agent ...` |

Dependencies: 1 and 2 are parallel after the interfaces below are fixed; 3 is parallel; 4 starts after 1–3; 5 starts after 4 and the orchestrator's review.

---

## Interfaces (fixed before dispatch)

```ts
// src/lib/server/config-store.ts
export type ImageModel = "qwen" | "h3";
export function getImageModel(): ImageModel;
export function getComfyuiH3Url(): string;
export function getComfyuiUrlForModel(model: ImageModel): string;
export function isImageMakingConfigured(
  config: Pick<RuntimeConfig, "imageModel" | "comfyuiUrl" | "comfyuiH3Url">,
): boolean;
```

- `RuntimeConfig` gains `imageModel: ImageModel` and `comfyuiH3Url: string`.
- `env.ts` gains `imageModel: ImageModel` from `IMAGE_MODEL` (default `"qwen"`; only `h3`/`qwen` accepted) and `comfyuiH3Url` from `COMFYUI_H3_URL` (trimmed; default `""`).
- `ADMIN_CONFIG_KEYS` and the admin registry gain `IMAGE_MODEL` (`select` of `h3`,`qwen`) and `COMFYUI_H3_URL` (`url`), both `effect: "live"`.
- `getConfig()` stays the runtime authority; `isImageMakingConfigured` checks only the selected model's URL.
- `TakeRequest` gains `model: ImageModel`; old v1 rows without it parse as `"qwen"`; an invalid value makes the row unreadable (null), not a silent default.
- `graphFor(model, mode, transparent)`, `canvasForNewPicture(size, print, model)`, `canvasForEdit(base, print, model)`, `createConfiguredComfyClient(model)`.
- `IMAGE_MODEL=h3` uses `COMFYUI_H3_URL`; `IMAGE_MODEL=qwen` uses `COMFYUI_URL`.
- `createConfiguredComfyClient(model)` is the only client factory; `idle-free` frees both configured services.

---

## Task 1 — Admin/config model switch (worker-b)

**Files:**
- Modify: `src/lib/server/env.ts`, `src/lib/server/config-store.ts`, `src/lib/config/admin-config-registry.ts`, `src/routes/api/admin/config/+server.ts` (only if the existing key flow needs it), `src/routes/(app)/settings/_components/system/pages.ts`, `src/routes/(app)/settings/_components/system/IntegrationsPage.svelte`, `src/lib/i18n/settings.ts`, `README.md`, `.env.example`
- Test: `src/lib/server/env.test.ts`, `src/lib/server/config-store.image-making.test.ts`, `src/lib/config/admin-config-registry.test.ts`, `src/routes/(app)/settings/_components/system/IntegrationsPage.pictures.test.ts`

**Interfaces:** Consumes nothing from the images slice. Produces the `ImageModel` type, `getImageModel`, `getComfyuiH3Url`, `getComfyuiUrlForModel`, `isImageMakingConfigured`, the two admin keys, and the Admin selector.

- [ ] **Step 1: Write the failing config tests.** Add:
  - `env.test.ts`: `IMAGE_MODEL` defaults to `qwen`; `IMAGE_MODEL=h3` parses; an unknown value falls back to `qwen`; `COMFYUI_H3_URL` is trimmed.
  - `config-store.image-making.test.ts`: `isImageMakingConfigured` is false when the selected model's URL is empty; true for H3 only when `COMFYUI_H3_URL` is set; `IMAGE_MODEL` override applies live; `getResolvedAdminConfigValues` includes both new keys.
  - `admin-config-registry.test.ts`: `IMAGE_MODEL` accepts `h3`/`qwen`, rejects `h4`; `COMFYUI_H3_URL` accepts `http://127.0.0.1:8189`, rejects a bare word.
- [ ] **Step 2: Run them to see red.** `npx vitest run src/lib/server/env.test.ts src/lib/server/config-store.image-making.test.ts src/lib/config/admin-config-registry.test.ts` — expected failures on the missing keys/helpers.
- [ ] **Step 3: Implement the config/admin path.**
  - `env.ts`: parse `IMAGE_MODEL`/`COMFYUI_H3_URL`; add the `RuntimeConfig` fields; keep `COMFYUI_URL` exactly as is.
  - `config-store.ts`: `ImageModel`, the keys, appliers, `getResolvedAdminConfigValues`, `getImageModel`, `getComfyuiH3Url`, `getComfyuiUrlForModel`, `isImageMakingConfigured` (selected URL only).
  - `admin-config-registry.ts`: `IMAGE_MODEL` select (`h3`,`qwen`), `COMFYUI_H3_URL` url, both live.
  - `pages.ts`: add both keys to the integrations page.
  - `IntegrationsPage.svelte`: a “Picture model” select and an “H3 picture server” field beside the existing Qwen “Picture server”; the Qwen field and behavior stay as is.
  - `i18n/settings.ts`: EN/HU labels/meanings for both keys; no unused keys.
  - `README.md`/`.env.example`: document `IMAGE_MODEL`, `COMFYUI_H3_URL`, the H3 4 MP / no 8-16 / no H3 transparent behavior, and the Qwen fallback.
- [ ] **Step 4: Add the settings component test.** In `IntegrationsPage.pictures.test.ts`: render with `IMAGE_MODEL: "h3"`, `COMFYUI_H3_URL: "http://h3:8189"`, `COMFYUI_URL: "http://comfy:8188"`; assert the select shows H3, the H3 URL field is present, selecting Qwen calls `setValue("IMAGE_MODEL", "qwen")`, and the Qwen URL remains. Run it red, implement the control, run green.
- [ ] **Step 5: Run focused tests.** `npx vitest run src/lib/server/env.test.ts src/lib/server/config-store.image-making.test.ts src/lib/config/admin-config-registry.test.ts "src/routes/(app)/settings/_components/system/IntegrationsPage.pictures.test.ts"` — all pass; `npx biome check` on the touched files.
- [ ] **Step 6: Commit.** `feat(settings): add live picture model switch and H3 server URL`.

**Exclusions:** Do not touch `comfyui.service`, Qwen model files, H3 service, image templates/canvas/runner, or the e2e suite.

---

## Task 2 — H3 4 MP templates and canvas (worker-a, part 1)

**Files:**
- Create: `src/lib/server/services/images/comfyui/graphs/h3-image-generate.api.json`, `.../h3-image-edit.api.json`
- Modify: `src/lib/server/services/images/comfyui/templates.ts`, `src/lib/server/services/images/canvas.ts`
- Test: `src/lib/server/services/images/comfyui/templates.test.ts`, `templates.contract.test.ts`, `canvas.test.ts` (exists; extend it)

**Interfaces:** `graphFor(model, mode, transparent)`, model-keyed template maps, `GraphTemplate.steps`/`cfg`, `canvasForNewPicture(size, print, model)`, `canvasForEdit(base, print, model)`, `ImageModel` from Task 1.

- [ ] **Step 1: Write failing template tests.**
  - H3 generate: node `MiniMaxH3ImageConditioning`, `ConditioningZeroOut`, 6-step `KSampler`, CFG 1, `PreviewImage`; no transparent graph.
  - H3 edit: 10 `LoadImage` slots wired to `images.image_1..10`; `image_1` is the base; the prompt wrapper adds `<Picture 1> `.
  - H3 `generate-transparent`/`edit-transparent` are absent; `graphFor("h3", mode, true)` returns null.
  - Qwen tests unchanged: 30 steps, CFG 1, 10 slots, `TextEncodeQwenImage21`, 1 MP/4 MP print; the existing assertions must still pass; Qwen keeps its four graph names and transparent wrap.
  - H3 6/1 is read from the template, not a global `QWEN_STEPS`.
- [ ] **Step 2: Write failing canvas tests.**
  - H3 landscape 2496×1664, portrait 1664×2496, square 2048², wide 2720×1536, tall 1536×2720; `print` does not change H3.
  - Qwen landscape 1248×832, portrait 832×1248, square 1056², wide 1376×768, tall 768×1376; Qwen `print` doubles to 4 MP exactly as today.
  - H3 `canvasForEdit` keeps the base aspect at 4 MP; Qwen keeps 1 MP, 4 MP print.
  - H3 `MAX_SIDE` 6272; Qwen remains 2752.
- [ ] **Step 3: Run to see red.** `npx vitest run src/lib/server/services/images/comfyui/templates.test.ts src/lib/server/services/images/comfyui/templates.contract.test.ts src/lib/server/services/images/canvas.test.ts`.
- [ ] **Step 4: Implement.**
  - Add the two H3 API graphs with the exact H3 node set: `UNETLoader` (`minimax_h3_image_pruned_nvfp4.safetensors`), `CLIPLoader` (`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`, type `minimax`), `VAELoader` (`minimax_h3_image_vae_fp16.safetensors`), `MiniMaxH3ImageConditioning`, `ConditioningZeroOut`, `KSampler` (6, cfg 1, euler/simple), `VAEDecode`, `PreviewImage`; edit adds 10 `LoadImage` nodes.
  - `templates.ts`: add `steps: number` and `cfg: number` to `GraphTemplate`; add a model-keyed template map (e.g. `GRAPH_TEMPLATES_BY_MODEL`) holding Qwen's existing four names and H3's `generate`/`edit` only; set Qwen 30/1 and H3 6/1; add H3 edit `wrapPrompt: (prompt) => \`<Picture 1> ${prompt}\``; keep the Qwen transparent wrap untouched; `graphFor(model, mode, transparent)` returns null for H3 + transparent; `buildPromptGraph` writes `template.steps`/`template.cfg` instead of the Qwen globals. Qwen's graph selection and behavior must remain identical.
  - `canvas.ts`: model-aware canvases and `MAX_SIDE`; H3 ignores `print`; Qwen behavior unchanged.
- [ ] **Step 5: Run green.** The same Vitest command; then `npx biome check` on the touched files.
- [ ] **Step 6: Commit.** `feat(images): add H3 4 MP templates and model-aware canvas`.

**Exclusions:** Do not touch the runner/client/tool/admin/Qwen service.

---

## Task 3 — H3 4 MP take, runner, client and tool (worker-a, part 2)

**Files:**
- Modify: `src/lib/server/services/images/take-request.ts`, `requests.ts`, `comfy-client.ts`, `idle-free.ts`, `image-runner.ts`, `src/lib/server/services/normal-chat-tools/make-image.ts`, `src/lib/server/services/images/AGENTS.md`
- Test: `take-request.test.ts`, `requests.test.ts`, `image-runner.test.ts`, `comfy-client.test.ts` (new if absent), `idle-free.test.ts` (new if absent), `normal-chat-tools/make-image.test.ts`

**Interfaces:** Consumes Task 1's `ImageModel`/`getImageModel`/`getComfyuiUrlForModel`; Task 2's `graphFor`/canvas. Produces `TakeRequest.model`, the H3/Qwen client, the H3 4 MP runner, the H3 transparent refusal, the H3 print no-op, and the H3 `<Picture 1>` framing.

- [ ] **Step 1: Write failing take/request tests.**
  - `take-request`: `model: "h3"` round-trips; old v1 rows without `model` parse as `"qwen"`; `model: "h4"` returns null.
  - `requests`: H3 generate/edit produce 4 MP canvases, `model: "h3"`, the H3 graph, and `<Picture 1>` on edits; H3 `transparent: true` returns the clear refusal and no plan; H3 `print: true` stays 4 MP; Qwen requests produce the existing 1 MP/4 MP-print/transparent behavior.
  - `image-runner`: uses `request.model`'s graph/client; H3 stores `mayBeSeeThrough: false`; Qwen transparent behavior unchanged; H3 4 MP does not add 8/16.
  - `make-image`: H3 transparent refusal message; H3 print no-op; Qwen transparent still succeeds; the tool description says H3 is 4 MP and has no transparent, and Qwen is the fallback for transparent.
  - `comfy-client`: `createConfiguredComfyClient("h3")` uses `COMFYUI_H3_URL`; `"qwen"` uses `COMFYUI_URL`; empty selected URL returns null.
  - `idle-free`: frees both configured services, not only the selected one.
- [ ] **Step 2: Run to see red.** `npx vitest run src/lib/server/services/images/take-request.test.ts src/lib/server/services/images/requests.test.ts src/lib/server/services/images/image-runner.test.ts src/lib/server/services/images/comfy-client.test.ts src/lib/server/services/images/idle-free.test.ts src/lib/server/services/normal-chat-tools/make-image.test.ts`.
- [ ] **Step 3: Implement.**
  - `TakeRequest.model`, parse/defaults; every construction site sets the current `getImageModel()`.
  - `planTake`: H3 transparent refusal before a card/take; H3 print no-op; H3 `<Picture 1>` for edits; the H3 graph selection.
  - `image-runner`: `createConfiguredComfyClient(request.model)`, `graphFor(request.model, ...)`, `mayBeSeeThrough` only for Qwen transparent; the H3 4 MP results; no Qwen path change.
  - `comfy-client`: the model-aware factory and the URL selection.
  - `idle-free`: both configured services; the current timer and no-live-take/queue checks stay.
  - `make-image`: the H3 transparent refusal and print description; no automatic Qwen route.
  - `images/AGENTS.md`: document the second URL, the model-on-take, H3 4 MP/no transparency/no 8-16, and the Qwen-unchanged rule.
- [ ] **Step 4: Run green.** The same Vitest command; `npx biome check` on the touched files.
- [ ] **Step 5: Commit.** `feat(images): run H3 4 MP takes and keep Qwen untouched`.

**Exclusions:** Do not change Qwen's 1 MP/4 MP-print/transparent templates, canvas, service, or tests; do not add 8/16 MP; do not auto-route H3 transparent.

---

## Task 4 — Permanent H3 0.44 service, Qwen untouched (worker-c)

**Files (box, not repo):**
- Create: `/etc/systemd/system/comfyui-h3.service`, `/etc/systemd/system/comfyui-h3-clean.service`, `/etc/systemd/system/comfyui-h3-clean.timer`
- Reuse/verify: `/home/alfyws/opt/comfyui-h3` (0.44 worktree), `/home/alfyws/venvs/comfyui-h3`, `/home/alfyws/opt/comfyui-h3/models/hf-minimax-h3-image` (NVFP4 DiT, NVFP4 TE, VAE; hashes checked)
- Do not touch: `comfyui.service` (Qwen 0.43/8188), Qwen model files, Qwen `COMFYUI_URL`.

**Interfaces:** Produces the H3 service on `127.0.0.1:8189` and the operational facts for the Admin `COMFYUI_H3_URL`.

- [ ] **Step 1: Write the unit and clean timer.** `comfyui-h3.service`: `User=alfyws`, `WorkingDirectory=/home/alfyws/opt/comfyui-h3`, `Environment=CUDA_VISIBLE_DEVICES=1`, `HF_HUB_OFFLINE=1`, `PYTHONUNBUFFERED=1`, `MemoryMax=32G`, `MemorySwapMax=0`, `ExecStart=/home/alfyws/venvs/comfyui-h3/bin/python main.py --listen 127.0.0.1 --port 8189 --disable-auto-launch --reserve-vram 2 --disable-pinned-memory`, `Restart=on-failure`, `RestartSec=5`. `comfyui-h3-clean.service`/`.timer` mirror the existing ComfyUI clean behavior for the H3 `input`/`output`/`temp` dirs.
- [ ] **Step 2: Prove the H3 service and Qwen service can both be up idle.** `systemctl start comfyui-h3`; `curl :8189/system_stats` (0.44.0, H3 node present, 32 GiB cgroup); `curl :8188/system_stats` (Qwen 0.43 unchanged); `nvidia-smi` idle.
- [ ] **Step 3: Real smoke, sequential only.** With MinerU at 0.2:
  - H3 4 MP t2i, H3 4 MP boxed edit, and a 4 MP edit: complete; record time/VRAM; no OOM.
  - Qwen 1 MP generate, Qwen 4 MP print, and Qwen transparent: complete exactly as before.
  - Switch the Admin `IMAGE_MODEL` to each and repeat one request; confirm the new request uses the selected service/URL.
- [ ] **Step 4: Stop the transient trial units.** `comfyui-h3-tests`, `comfyui-h3-chain`, `comfyui-h3-warm` are inactive; remove/reset them; the permanent unit owns 8189.
- [ ] **Step 5: Report.** The unit contents, `systemctl is-active`, both `/system_stats`, the H3/Qwen smoke results, and confirmation the Qwen unit/model files were not edited.

**Exclusions:** No Qwen unit/model/template change; no 8/16 MP; no app `IMAGE_MODEL` production switch yet.

---

## Task 5 — e2e and real smoke coverage (worker-d)

**Files:**
- Modify: `tests/e2e/images-helpers.ts`, `tests/e2e/images-pipeline.spec.ts`, `tests/e2e/images.spec.ts`, `tests/e2e/images-history.spec.ts`, `tests/e2e/images-viewer.spec.ts`, `tests/e2e/images-picture-filter.spec.ts`, `tests/e2e/settings-admin.spec.ts`
- Reuse: `src/lib/server/services/images/comfyui/testing/fake-comfyui.ts`

**Interfaces:** Consumes Tasks 1–3; the fake ComfyUI is model-agnostic.

- [ ] **Step 1: Extend the e2e helpers** to set `IMAGE_MODEL` and `COMFYUI_H3_URL` as well as `COMFYUI_URL`; reset both after each spec (`clearAdminConfig`); the fake stays the single server.
- [ ] **Step 2: Add the admin switch spec.** `settings-admin.spec.ts`: the Pictures section shows the model select and both URLs; switching to Qwen/H3 persists; a malformed model is rejected by the API; the effective config reflects it.
- [ ] **Step 3: Add the H3 image spec.** `images-pipeline.spec.ts` (or a new `images-h3.spec.ts`): H3 selected, 4 MP request, the H3 graph hits the fake, the card/History/Download show 4 MP, the boxed edit path, the H3 `print` is 4 MP, no 8/16. The fake's dimensions assert 4 MP.
- [ ] **Step 4: Add the H3 transparent refusal spec.** H3 selected + `transparent` = the tool refusal; no card/take; the message names the Admin Qwen fallback. Switch to Qwen + transparent = succeeds.
- [ ] **Step 5: Qwen regression.** With `IMAGE_MODEL=qwen`: 1 MP generate, 4 MP print, transparent, the Qwen graph/assets, and the existing image tests pass unchanged.
- [ ] **Step 6: Run focused e2e.** `scripts/gates.sh agent "$TMPDIR/alfyai-gates-e2e" --port 4610 tests/e2e/images-pipeline.spec.ts tests/e2e/images.spec.ts tests/e2e/images-history.spec.ts tests/e2e/images-viewer.spec.ts tests/e2e/images-picture-filter.spec.ts tests/e2e/settings-admin.spec.ts` (or the repo's normal e2e run once, after the orchestrator's static gates).
- [ ] **Step 7: Commit.** `test(images): cover H3 4 MP, the model switch and Qwen regression`.

**Exclusions:** Do not change app behavior to make a test pass; do not add 8/16 tests; no live deploy.

---

## Task 6 — Impartial judge (fresh sub-agent, no implementation role)

The judge must be started with `subagent` (not `subagent_fork`), with no worker context, and must not edit. The judge reads this plan, the diff, and the test outputs, then runs the checks itself.

- [ ] **Review the diff, not the worker reports.** Every changed file has a reason; no unrelated changes; no Qwen serving/model/template/canvas changes; no 8/16; no transparent auto-route.
- [ ] **Check the Admin switch.** The Pictures section has the model selector and both URLs; the switch is live; the API validates; the effective config; the H3/Qwen URL selection.
- [ ] **Check H3 4 MP behavior.** Generate, edit, boxed, another/retry at 4 MP; `<Picture 1>`; 6 steps/CFG 1; 10 slots; the guard; 4 MP files; the H3 print no-op; no 8/16.
- [ ] **Check H3 transparent.** Refused under H3 before a card/take, with the Admin Qwen fallback; no auto-route; Qwen transparent still works under Qwen.
- [ ] **Check Qwen unchanged.** 1 MP, 4 MP print, 30 steps, `COMFYUI_URL`, 0.43/8188, transparent, the Qwen tests and real smoke.
- [ ] **Check the box.** `comfyui-h3` 0.44/8189 active; Qwen 0.43/8188 untouched; MinerU 0.2 healthy; H3 4 MP no OOM; Qwen 1 MP/4 MP print/transparent; both services idle; the app health; the file cap 50/400.
- [ ] **Run the final gate.** `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 4610 <the specs>`; then the real-box smoke; report PASS/FAIL with the exact commands/results and any residual risk. No writes, no push, no deploy.

---

## Task 7 — Orchestrator integration and rollout

- [ ] Review every worker diff; send back specific findings; do not accept unreviewed diffs.
- [ ] Resolve the interface integration: `ImageModel`/`getImageModel`/`getComfyuiUrlForModel`/`graphFor`/canvas/`createConfiguredComfyClient`/`TakeRequest.model`.
- [ ] Run the full gate once: `scripts/gates.sh agent "$TMPDIR/alfyai-gates" --port 4610 tests/e2e/images-pipeline.spec.ts tests/e2e/images.spec.ts tests/e2e/images-history.spec.ts tests/e2e/images-viewer.spec.ts tests/e2e/images-picture-filter.spec.ts tests/e2e/settings-admin.spec.ts`.
- [ ] Deploy to staging; set `IMAGE_MODEL=h3`; verify H3 4 MP, the Admin switch to Qwen, Qwen transparent, Qwen 1 MP/4 MP print, the H3 service, MinerU 0.2, the app health, the file cap, the 50 MB path.
- [ ] Production only on the owner's explicit go; the Qwen service stays; the rollback is `IMAGE_MODEL=qwen`; the H3 service stays and is not changed by the switch.
- [ ] Final report: what changed, the slices/workers, the gate command/result, the real-box evidence, the residual risks (H3 4 MP at 0.2, the accepted edit behavior, H3 text, the community NVFP4), and the rollback.

---

## Risks

- **H3 4 MP at MinerU 0.2** is a knife-edge fit. No 8/16, no 4 MP H3 plus another loaded model; the H3 service is sequential.
- **H3 edit behavior** is accepted by the owner; the app's guard/retry still applies; the chained-removal case is not a test blocker.
- **H3 text typography** is weaker in the A/B; the app prompt should ask for a full caption; no 8/16 to compensate.
- **H3 NVFP4** is a community quant; the hashes are pinned; do not replace the official w4a8 (the owner ruled it out).
- **H3 0.44** is newer than the Qwen 0.43 service; the two-service split avoids upgrading Qwen, but the H3 service is a new unit to monitor.
- **Admin switch mid-take** is handled by `TakeRequest.model`; the e2e test pins it.
- **Qwen regression** is the main release gate; the Qwen service must remain untouched.

---

## Appendix A — Worker prompts

All workers get the repo root as cwd and the `alfyai-orchestrated-delivery` contract: "You are not alone in the codebase. Do not revert or overwrite edits made by others. Adjust to concurrent changes. Use TDD; report the red-green-refactor loop. Do not push, deploy, change admin settings, delete data, or run destructive git commands. Do not print credentials."

### worker-b (Task 1)

```
Goal: Add the live Admin "Picture model" switch (H3/Qwen) and COMFYUI_H3_URL without changing Qwen serving.
Owned write scope: src/lib/server/env.ts, src/lib/server/config-store.ts, src/lib/config/admin-config-registry.ts, src/routes/api/admin/config/+server.ts, src/routes/(app)/settings/_components/system/pages.ts, src/routes/(app)/settings/_components/system/IntegrationsPage.svelte, src/lib/i18n/settings.ts, README.md, .env.example, and the tests named in Task 1.
Do not change: comfyui.service, Qwen model files, image templates/canvas/runner, H3 service, e2e.
Acceptance: IMAGE_MODEL=h3|qwen live; COMFYUI_H3_URL; the Pictures UI shows both; EN/HU; Qwen URL unchanged; the selected URL drives isImageMakingConfigured; full focused tests pass.
Verification: the Task 1 Vitest command; npx biome check on touched files.
Final report: changed paths, behavior, TDD evidence, verification, blockers.
```

### worker-a (Tasks 2–3)

```
Goal: Integrate H3-Image 4 MP into the image service: H3 templates, 4 MP canvas, model-on-take, runner/client, tool refusal/extensions; Qwen behavior unchanged.
Owned write scope: src/lib/server/services/images/comfyui/templates.ts, the H3 graph JSONs, src/lib/server/services/images/canvas.ts, take-request.ts, requests.ts, comfy-client.ts, idle-free.ts, image-runner.ts, src/lib/server/services/images/AGENTS.md, src/lib/server/services/normal-chat-tools/make-image.ts, and the tests named in Tasks 2–3.
Do not change: env/config-store/admin/settings (worker-b), the H3 service/box (worker-c), e2e (worker-d), Qwen service/model/templates/canvas/1 MP/4 MP print/transparent.
Acceptance: H3 4 MP generate/edit/boxed/another/retry; 6 steps/CFG 1; <Picture 1>; 10 slots; H3 print no-op; H3 transparent refused with the Admin Qwen fallback; no 8/16; Qwen untouched; focused tests pass.
Verification: the Task 2–3 Vitest commands; npx biome check on touched files.
Final report: changed paths, behavior, TDD evidence, verification, blockers.
```

### worker-c (Task 4)

```
Goal: Make the H3 0.44 service permanent on the box; leave Qwen serving untouched.
Owned write scope: the box only: /etc/systemd/system/comfyui-h3.service, comfyui-h3-clean.service/.timer; verify/reuse /home/alfyws/opt/comfyui-h3, /home/alfyws/venvs/comfyui-h3, the H3 model files. No repo edits.
Do not change: comfyui.service (Qwen 0.43/8188), Qwen model files, MinerU 0.2, GPU0.
Acceptance: comfyui-h3 active on 127.0.0.1:8189 with the H3 node and 32 G cgroup; Qwen 0.43/8188 still active; both /system_stats; H3 4 MP t2i/boxed/edit complete; Qwen 1 MP/4 MP print/transparent complete; no OOM; transient trial units stopped.
Verification: systemctl, /system_stats, the sequential H3/Qwen smoke, nvidia-smi.
Final report: unit contents, active states, stats, smoke times, Qwen untouched evidence, blockers.
```

### worker-d (Task 5)

```
Goal: Add e2e/real smoke coverage for the Admin switch, H3 4 MP, H3 transparent refusal, and Qwen regression.
Owned write scope: tests/e2e/images-helpers.ts, tests/e2e/images-pipeline.spec.ts, tests/e2e/images.spec.ts, tests/e2e/images-history.spec.ts, tests/e2e/images-viewer.spec.ts, tests/e2e/images-picture-filter.spec.ts, tests/e2e/settings-admin.spec.ts; the fake only if it cannot express the H3 graph.
Do not change: app behavior, Qwen serving, 8/16, the transparent auto-route.
Acceptance: the switch persists; H3 4 MP graph/card/history/download; H3 print 4 MP; no 8/16; H3 transparent refused; Qwen 1 MP/4 MP print/transparent pass; focused e2e green.
Verification: the Task 5 gate command; the real-box smoke after it.
Final report: changed specs, behavior, TDD evidence, verification, blockers.
```

## Appendix B — Judge prompt

```
You are the impartial judge for the H3 4 MP integration. You did not implement it. Do not edit, push, deploy, or change admin settings.
Read docs/plans/minimax-h3-image/implementation-plan.md and the diff. Review the code, not the worker reports.
Run the full gate: scripts/gates.sh agent "$TMPDIR/alfyai-gates-judge" --port 4610 tests/e2e/images-pipeline.spec.ts tests/e2e/images.spec.ts tests/e2e/images-history.spec.ts tests/e2e/images-viewer.spec.ts tests/e2e/images-picture-filter.spec.ts tests/e2e/settings-admin.spec.ts.
Then verify on the box, sequentially: H3 4 MP t2i/edit/boxed; Qwen 1 MP/4 MP print/transparent; the Admin switch both ways; H3 transparent refusal; no 8/16; MinerU 0.2; the file cap 50/400; the Qwen service/model/templates/canvas unchanged; the H3 service 0.44/8189; app health.
Report PASS or FAIL with the exact commands/results and any residual risk. A green test that does not exercise the H3/Qwen real service is not a pass for the real smoke.
```

---

## Plan self-review

- **Constraints covered:** H3 4 MP only; no 8/16; no transparent route to Qwen; the Admin fallback switch; Qwen serving/model/templates/canvas/1 MP/4 MP print/transparent untouched; H3 0.44/8189 separate; MinerU 0.2; file cap 50/400; no GPU0; no w4a8.
- **Current-code fit:** `GraphTemplate` has no `steps`/`cfg` today, so Task 2 adds them; the Qwen 30/1 values stay. `TakeRequest.v: 1` has no `model` today, so Task 3 adds it with old-row `qwen` default. `COMFYUI_URL`/`isImageMakingConfigured` are today's single-URL path, so Task 1 adds the selected-URL rule. `canvas.test.ts` already exists, so Task 2 extends it. `comfy-client.test.ts` and `idle-free.test.ts` do not exist, so Task 3 creates them.
- **No hidden Qwen change:** the Qwen four graph names, 1 MP canvas, 4 MP print, transparent wrap, 0.43 service, 8188 URL, and Qwen tests are explicitly unchanged in Tasks 1–5; the judge checks the service and model files on the box.
- **The shared worktree:** the plan says which files each slice owns; the orchestrator stages only those. `AGENTS.md` is already modified and many docs/images are untracked; they are not part of this change.
- **The only intentional default:** `IMAGE_MODEL` defaults to `qwen` in env so an install without H3 keeps today's behavior; staging/production selects `h3` through Admin/`.env` after the service is healthy, and the owner's go is required. This is the fallback switch, not an automatic route.

