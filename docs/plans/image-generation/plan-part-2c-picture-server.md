# Images Part 2c: The Picture Server and Acceptance Implementation Plan

> **Draft, 2026-10-27.** The owner's answers to the plan's own calls in [`plan-part-2-images.md`](./plan-part-2-images.md) are folded in, except call 5 (pictures and chat deletion), which waits on one more answer.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real ComfyUI with Qwen-Image 2.1 runs on GPU1 of `alfyroot` beside TEI and MinerU, the app talks to it with graphs exported from its own templates, the first measurements decide the server's margins, the pixel guards are tuned on real renders, and the owner accepts part 2 on ai.dev with the sofa session.

**Architecture:** An agent works over ssh and the owner approves every command before it runs (owner, 2026-10-26). ComfyUI gets its own venv and a systemd unit listening on `127.0.0.1:8188`, shared by ai.dev and production. Three small scripts in `scripts/images/` drive the server through plan 2a's own client and guards, from the Mac, through an ssh tunnel; LPIPS is computed offline. Every result goes into one tracked document.

**Tech Stack:** NVIDIA driver 580 or newer, Python 3.12 or newer, torch 2.14.1+cu130, ComfyUI pinned to a commit at or after v0.41.3, comfy-kitchen 0.2.39, Qwen-Image 2.1 (Comfy-Org's INT8-ConvRot DiT, the INT8 or W4A8 Qwen3-VL-8B encoder, the bf16 VAE), systemd; on the Mac, Node 22 for the scripts and a throwaway Python venv for `lpips` 0.1.4.

**Spec:** `docs/plans/image-generation/design.md` sections 5.1 and 5.12, and the comparison report (the Claude memory note `alfyai-image-model-comparison-2026-10-26.md`: its serving section and pins). The index, the shared Global Constraints and the plan's own calls are in [`plan-part-2-images.md`](./plan-part-2-images.md).

## Global Constraints

The shared list in `plan-part-2-images.md` applies to every task. This plan adds:

- **Every command on the box is shown to the owner and runs only after the owner approves it, one at a time.** That covers reads too (memory: read-only production queries need the owner's go since 2026-10-23). The agent never batches commands into a script the owner has not read, never uses `sudo` without saying why, and stops on any surprise.
- ssh needs Tailscale up; the host alias is `alfyroot`. Write each command literally.
- ComfyUI listens on `127.0.0.1` only; nothing opens a port to the network. Its inputs and outputs (the family's photos among them) are deleted from its folders daily (Task 2).
- No change to TEI, MinerU, vLLM, the driver or the apps' own configuration in this plan, except setting `COMFYUI_URL` on ai.dev in Task 6. A driver older than 580 stops the plan for an owner decision.
- The owner's own photos never enter the repository, a commit, a fixture or a log. The results document holds numbers and the owner's words, nothing else from them.
- Nothing is deployed, pushed or merged without the owner's explicit request; production gets `COMFYUI_URL` only on the owner's word after Task 6.
- All results, versions, hashes and decisions go into `docs/plans/image-generation/results-part-2-server.md` as they happen.

## Review Focus

1. **TEI and MinerU keep answering while a picture renders at its peak** (no out-of-memory on GPU1). Checked in Task 4.
2. **ComfyUI crashing mid-render**: systemd restarts it and the app's take fails or resumes cleanly. Checked in Task 4.
3. **Host memory pressure** (the 32 GiB swap was full in October) and ComfyUI's pinned-memory race that silently ignored edit prompts (issue #17187): whether `--disable-pinned-memory` is needed. Checked in Tasks 1 and 4.
4. **A square photo is never edited at exactly 1024x1024, and a 4 MP edit fits.** Checked in Task 4.
5. **No take reuses its input's seed** on ai.dev. Checked in Task 6.

---

## File structure

Created:
- `docs/plans/image-generation/results-part-2-server.md`: the survey, the install record, the measurements, the tuning and the acceptance.
- `src/lib/server/services/images/comfyui/graphs/qwen-image-2.1-generate.api.json`, `qwen-image-2.1-edit.api.json` (and `-transparent` variants if the server has them); `src/lib/server/services/images/comfyui/templates.contract.test.ts`.
- `scripts/images/try-render.ts`, `scripts/images/measure.ts`, `scripts/images/drift.ts`, `scripts/images/lpips.py`, with tests for the TypeScript parts' pure functions.
- `src/lib/server/services/images/guards/__fixtures__/` (small pictures from generated scenes only) and `guards/tuned.test.ts`.

Modified: `src/lib/server/services/images/comfyui/templates.ts` (the real graphs, their slot maps, the installed file names; the reference graphs removed), `images/guards/thresholds.ts` (Task 5), and at most the defaults of `IMAGE_REFERENCE_CAP`, `IMAGE_TOOL_WAIT_MS` and `IMAGE_IDLE_FREE_MS` (Task 4, each with its measured reason in a comment).

---

### Task 1: Survey the box

Read-only; each command approved by the owner.

**Files:**
- Create: `docs/plans/image-generation/results-part-2-server.md` (sections: Survey, Install, Graphs, Measurements, Tuning, Acceptance)

- [ ] **Step 1: The cards, the driver and who uses GPU1**

Run: `ssh alfyroot 'nvidia-smi --query-gpu=index,pci.bus_id,name,driver_version,memory.total,memory.used,memory.free --format=csv'`
Expected: driver 580 or newer; the RTX PRO 5000 (48 GB) listed with about 33 GiB free. A driver older than 580 stops the plan.

Run: `ssh alfyroot 'nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_memory --format=csv'`
Expected: the TEI and MinerU processes on GPU1's bus id, with their memory.

- [ ] **Step 2: Host memory, disk, Python, the port and the services**

Run, one at a time: `ssh alfyroot 'free -g; swapon --show'`; `ssh alfyroot 'df -h /home/alfyws'`; `ssh alfyroot 'ls /usr/bin/python3*; python3 --version'`; `ssh alfyroot 'ss -ltnp | grep -E ":8188 " || echo port 8188 free'`; `ssh alfyroot 'systemctl list-units --type=service --no-pager | grep -Ei "vllm|mineru|tei|comfy"'`; `ssh alfyroot 'systemctl cat mineru4.service'`; `ssh alfyroot 'id alfyws; ls /home/alfyws/venvs /home/alfyws/opt'`
Expected: at least 40 GB free disk; Python 3.12 or newer; port 8188 free; the unit pattern and user the GPU services use.

- [ ] **Step 3: Write the Survey section and the decisions it makes**

Record the numbers, then decide and write down: GPU1's index under `CUDA_DEVICE_ORDER=PCI_BUS_ID`; the Python to use; the user (`alfyws` unless the survey says otherwise) and the paths (`/home/alfyws/venvs/comfyui`, `/home/alfyws/opt/comfyui`); the unit's `MemoryMax` (half the host memory not held by the resident services, capped at 24G, with `MemorySwapMax=0`, the memory note's no-swap pattern); the encoder (INT8 when GPU1 has at least 26 GiB free, else W4A8); whether to start with `--disable-pinned-memory` (yes when swap use is above half).

- [ ] **Step 4: Commit**

```bash
git add docs/plans/image-generation/results-part-2-server.md
git commit -m "Record what GPU1 and the box have room for before installing the picture server"
```

### Task 2: Install ComfyUI and the weights

Each command approved by the owner, in this order. Record each version, hash and answer in the Install section.

- [ ] **Step 1: The venv and torch**

Run: `ssh alfyroot 'python3.12 -m venv /home/alfyws/venvs/comfyui'` (the Python from Task 1), then `ssh alfyroot '/home/alfyws/venvs/comfyui/bin/pip install --upgrade pip'`, then `ssh alfyroot '/home/alfyws/venvs/comfyui/bin/pip install torch==2.14.1 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130'`
Then: `ssh alfyroot 'CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=<gpu1> /home/alfyws/venvs/comfyui/bin/python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0))"'`
Expected: `2.14.1+cu130 13.0 NVIDIA RTX PRO 5000 …`.

- [ ] **Step 2: ComfyUI at a pinned commit**

Run: `ssh alfyroot 'git clone https://github.com/Comfy-Org/ComfyUI.git /home/alfyws/opt/comfyui'`, then `ssh alfyroot 'git -C /home/alfyws/opt/comfyui tag --list "v0.4*" --sort=-v:refname | head -10'`. Choose the newest tag at or after v0.41.3 whose release notes do not report an open regression for INT8-ConvRot on SM120 (issue #17098) or ignored edit prompts (#17187); write down why. Then `ssh alfyroot 'git -C /home/alfyws/opt/comfyui checkout <tag> && git -C /home/alfyws/opt/comfyui rev-parse HEAD'`.
Expected: the commit hash, recorded.

- [ ] **Step 3: Its requirements, comfy-kitchen, no xformers**

Run: `ssh alfyroot '/home/alfyws/venvs/comfyui/bin/pip install -r /home/alfyws/opt/comfyui/requirements.txt'`, then `ssh alfyroot '/home/alfyws/venvs/comfyui/bin/pip show torch comfy-kitchen xformers'`
Expected: torch still 2.14.1+cu130 (if the requirements moved it, put it back with Step 1's command); comfy-kitchen 0.2.39 (install `comfy-kitchen==0.2.39` if it differs and the pinned ComfyUI accepts it); xformers not installed. Then `ssh alfyroot '/home/alfyws/venvs/comfyui/bin/pip freeze'` and record it.

- [ ] **Step 4: The weights**

Run: `ssh alfyroot '/home/alfyws/venvs/comfyui/bin/pip install "huggingface_hub[cli]"'`, then list the repository: `ssh alfyroot '/home/alfyws/venvs/comfyui/bin/python -c "from huggingface_hub import list_repo_files; print(chr(10).join(list_repo_files(\"Comfy-Org/Qwen-Image-2.1\")))"'`. Pick `qwen_image_2.1_int8_convrot.safetensors`, the encoder chosen in Task 1 and the bf16 VAE; download each with `ssh alfyroot '/home/alfyws/venvs/comfyui/bin/hf download Comfy-Org/Qwen-Image-2.1 <path in repo> --local-dir /home/alfyws/opt/comfyui/models/hf-qwen-image-2.1'` and link it into `models/diffusion_models/`, `models/text_encoders/` and `models/vae/` (`ln -s`). Then `ssh alfyroot 'sha256sum /home/alfyws/opt/comfyui/models/hf-qwen-image-2.1/<each file>'`.
Expected: about 16 GiB in all; three names and hashes recorded.

- [ ] **Step 5: The unit**

Show the owner the file, then write it with `sudo tee /etc/systemd/system/comfyui.service`:

```ini
[Unit]
Description=ComfyUI picture server (Qwen-Image 2.1) on GPU1, for ai.dev and production
After=network-online.target

[Service]
User=alfyws
WorkingDirectory=/home/alfyws/opt/comfyui
Environment=CUDA_DEVICE_ORDER=PCI_BUS_ID
Environment=CUDA_VISIBLE_DEVICES=<gpu1>
ExecStart=/home/alfyws/venvs/comfyui/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --reserve-vram 4
Restart=on-failure
RestartSec=5
MemoryMax=<from Task 1>
MemorySwapMax=0

[Install]
WantedBy=multi-user.target
```

`--reserve-vram 4` is provisional (Task 4 sets it); add `--disable-pinned-memory` when Task 1 said so. Dynamic VRAM stays on (no flag turns it off). Then `ssh alfyroot 'sudo systemctl daemon-reload && sudo systemctl enable --now comfyui.service'`, `ssh alfyroot 'systemctl status comfyui.service --no-pager'`, `ssh alfyroot 'curl -s http://127.0.0.1:8188/system_stats'`.
Expected: active (running); `system_stats` names one CUDA device with about 48 GiB total.

- [ ] **Step 6: Delete old inputs and outputs every day**

A `comfyui-clean.service` (oneshot, `User=alfyws`, `ExecStart=/usr/bin/find /home/alfyws/opt/comfyui/input /home/alfyws/opt/comfyui/output -type f -mmin +1440 -delete`) and a `comfyui-clean.timer` (`OnCalendar=daily`, `Persistent=true`), shown to the owner, written with `sudo tee`, then `ssh alfyroot 'sudo systemctl daemon-reload && sudo systemctl enable --now comfyui-clean.timer && systemctl list-timers comfyui-clean.timer --no-pager'`.
Expected: the timer listed with its next run. (Plan's call: ComfyUI keeps every uploaded picture otherwise; the app keeps its own copies.)

- [ ] **Step 7: The neighbours are fine**

Run: `ssh alfyroot 'nvidia-smi --query-gpu=index,memory.used,memory.free --format=csv'` and the TEI and MinerU health checks the survey found (e.g. `ssh alfyroot 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8002/health'`).
Expected: both answer 200; ComfyUI's idle footprint recorded.

- [ ] **Step 8: Commit the record**

```bash
git add docs/plans/image-generation/results-part-2-server.md
git commit -m "Record the picture server install: versions, hashes, the unit and the daily clean-up"
```

### Task 3: The real graphs

**Files:**
- Create: `images/comfyui/graphs/qwen-image-2.1-generate.api.json`, `qwen-image-2.1-edit.api.json` (and `-transparent` variants when the server has a Qwen-Image 2.1 RGBA template), `images/comfyui/templates.contract.test.ts`, `scripts/images/try-render.ts`
- Modify: `images/comfyui/templates.ts` (register the real graphs and their slot maps, record the installed file names in its header; remove the reference graphs and their test entries)

**Interfaces:**
- Consumes: `createComfyUiClient` (plan 2a Task 3), `GraphTemplate`, `buildPromptGraph`, `QWEN_STEPS`, `QWEN_CFG` (plan 2a Task 4).
- Produces: `GRAPH_TEMPLATES.generate`, `GRAPH_TEMPLATES.edit` (and the transparent ones when they exist) from the installed server.

- [ ] **Step 1: Find the templates**

Run: `ssh alfyroot 'ls /home/alfyws/venvs/comfyui/lib/python3*/site-packages/ | grep -i workflow_templates'` and then list that package's `templates/` folder filtered by `qwen`.
Expected: the Qwen-Image 2.1 text-to-image and edit templates (and any RGBA one).

- [ ] **Step 2: Export them in API format**

Open a tunnel from the Mac (`ssh -N -L 8188:127.0.0.1:8188 alfyroot`, owner-approved, run in the background), open `http://127.0.0.1:8188` (the built-in browser pane with the owner watching, or the owner's own browser), load each template, set the model, encoder and VAE to the installed file names, and export with "Export (API)". Save the files under the names above.

- [ ] **Step 3: Write the slot maps and the contract test**

For each graph, find in the JSON: the prompt input of the positive text-encode node, the sampler's `seed`, `steps` and `cfg`, the latent size node's `width` and `height` (generate), each `LoadImage` node and the encoder input it feeds (edit), and the save node. `templates.contract.test.ts`: every slot names an existing node and input; each image slot's encoder input is the link `[<load node>, 0]`; the output node is `SaveImage`; `buildPromptGraph` writes 40 steps and CFG 1; the edit graph has at least 4 image slots (the default cap). If the official edit template has fewer image slots than the cap, extend it the template's own way (one more `LoadImage` into the next encoder input) and say so in the results.

- [ ] **Step 4: One real render each way**

`scripts/images/try-render.ts <generate|edit> <out.png> [input.png]`: builds the graph with the app's code, uploads, submits and follows through `http://127.0.0.1:8188` (the tunnel), and writes the picture. Run a generate ("a cosy living room with a grey linen sofa against the left wall, evening light"), then an edit of that result ("make the sofa dark green, keep everything else exactly as it is").
Expected: two plausible pictures at 1248x832; the edit's room unchanged to the eye. Record the times.

- [ ] **Step 5: Run the tests and check**

Run: `npx vitest run src/lib/server/services/images` then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/services/images/comfyui scripts/images docs/plans/image-generation/results-part-2-server.md
git commit -m "Use graphs exported from the installed ComfyUI's own Qwen-Image 2.1 templates, held by a contract test"
```

### Task 4: First measurements (a gate before tuning)

**Files:**
- Create: `scripts/images/measure.ts`, `scripts/images/measure.test.ts` (the peak parser and the case table)
- Modify: `results-part-2-server.md`; possibly the defaults of `IMAGE_REFERENCE_CAP` (`src/lib/server/env.ts`), `IMAGE_TOOL_WAIT_MS` (`normal-chat-tools/make-image.ts`) and `IMAGE_IDLE_FREE_MS` (`images/idle-free.ts`), and the unit's `--reserve-vram`

**Interfaces:**
- Produces: `parseNvidiaSmiSamples(text: string, gpuIndex: number): number[]` (MiB) and `MEASURE_CASES: ReadonlyArray<{ id: string; mode: "generate" | "edit"; inputs: number; canvas: CanvasSize; runs: number; note?: string }>` in `measure.ts`.

- [ ] **Step 1: Write the failing test** (`measure.test.ts`): `parseNvidiaSmiSamples("0, 1200\n1, 30500\n1, 31877\n", 1)` is `[30500, 31877]`; `MEASURE_CASES` holds the cases below with the canvases plan 2a's `canvasForEdit` gives.

- [ ] **Step 2: Run it, implement, run it again**

Run: `npx vitest run scripts/images/measure.test.ts` before and after; FAIL, then PASS. The script samples GPU1 with a background `ssh alfyroot 'nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits -lms 500'` while each case runs through the tunnel, and checks the TEI and MinerU health URLs after each.

- [ ] **Step 3: Run the cases** (the owner approves the run and the background sampler)

Cases, each with fresh seeds: a cold generate at 1248x832 after `POST /free`, then three warm; an edit of one picture at 1184x896, three runs; edits of two and of four pictures; one edit at 2368x1760; one deliberate exact 1024x1024 edit (expect noise: it confirms the rule); one edit with the seed that made its input (expect a broken picture: it confirms the rule); a transparent generate if Task 3 found an RGBA graph. Then a crash: start an edit and run `ssh alfyroot 'sudo systemctl restart comfyui.service'` in the middle; the client's next submit must work after the restart (Review Focus 2).
Expected: a table in the Measurements section: case, cold or warm, seconds from submit to picture, peak MiB on GPU1, TEI and MinerU answering (Review Focus 1); the two traps confirmed (Review Focus 4).

- [ ] **Step 4: Decide, and write each decision with its number**

- `--reserve-vram`: GPU1's total minus the others' peak minus the four-picture peak, less a 2 GiB margin; edit the unit and restart it (owner-approved).
- `IMAGE_REFERENCE_CAP`'s default: stays 4 when the four-picture edit fits that margin, else the largest count that fits.
- `IMAGE_TOOL_WAIT_MS`: stays 100 000 when a warm one-picture edit plus one retry takes under 60 s.
- `IMAGE_IDLE_FREE_MS`: stays 15 minutes unless the cold start is under 10 s (then 5 minutes) or the neighbours need the memory sooner.
- `--disable-pinned-memory`: on when any run returned its input unchanged under memory pressure (Review Focus 3).
- The optional NVFP4 and Turbo trials: only if the owner asks.

- [ ] **Step 5: Stop for the owner**

The owner reads the Measurements section and says go before Task 5 (the design's gate).

- [ ] **Step 6: Commit**

```bash
git add scripts/images docs/plans/image-generation/results-part-2-server.md src/lib/server/env.ts src/lib/server/services/normal-chat-tools/make-image.ts src/lib/server/services/images/idle-free.ts
git commit -m "Measure the picture server beside TEI and MinerU and set its margins from the numbers"
```

### Task 5: Tune the pixel guards on real renders

**Files:**
- Create: `scripts/images/drift.ts`, `scripts/images/drift.test.ts`, `scripts/images/lpips.py`, `src/lib/server/services/images/guards/__fixtures__/` (pictures of generated scenes only, at most 320 px), `images/guards/tuned.test.ts`
- Modify: `images/guards/thresholds.ts`, `results-part-2-server.md`

**Interfaces:**
- Produces: `drift.ts <scenes dir> <out dir> [--mask-only]` runs the sofa sequence's edits through the app's graphs and `guardEdit`, once with paste-back and once raw, and writes each result, its mask and a JSON line of measures; `lpips.py <before.png> <after.png> <mask.png>` prints `{"lpips_outside": …, "offset_px": …}`.

- [ ] **Step 1: The LPIPS venv** (on the Mac, owner-approved: it downloads torch and lpips from PyPI)

Run: `python3 -m venv <scratchpad>/lpips-venv`, then `<scratchpad>/lpips-venv/bin/pip install torch lpips==0.1.4 pillow numpy`, with `<scratchpad>` written out as the session's literal scratchpad path (the venv is throwaway and stays out of the repository).
Expected: `<scratchpad>/lpips-venv/bin/python -c "import lpips"` succeeds.

- [ ] **Step 2: Write `drift.test.ts`** (the sequence and the measure line's shape), run it to fail, implement `drift.ts` and `lpips.py`, run it to pass.

Run: `npx vitest run scripts/images/drift.test.ts`

- [ ] **Step 3: Measure**

Scenes: three living rooms generated in Task 4, and, only if the owner chooses to, their own photos copied into a scratch folder that never enters the repository. The sequence: recolour the sofa, reupholster it, add a cushion inside a box, move the sofa to a box, put a sofa picture into the room, then five chained changes. Record per edit, raw and with paste-back: LPIPS outside the change mask, the offset in pixels; after the five chained changes, LPIPS against the original.

- [ ] **Step 4: Tune `GUARD` until the design's numbers hold**

Targets (design 5.12): raw outside the edited area at most 0.10 and an offset at most 4 px; after five chained changes at most 0.20 against the original; with paste-back at most 0.05 with no visible seam (the owner looks at five composites). Move `diffThreshold`, `dilateShare`, `featherShare`, `globalChangeShare`, `nothingChangedShare` and `reanchorEvery` one at a time and record each move with its numbers. A target the guards cannot reach is written down with the closest numbers, for the owner.

- [ ] **Step 5: Hold the tuned values with real pictures**

Save small pairs from the generated scenes (never the owner's photos) into `__fixtures__/`. `tuned.test.ts`: on a recolour pair, every pixel outside the dilated change equals the base's; on a "nothing changed" pair the miss is `nothing_changed`; on a global restyle pair `global` is true.

Run: `npx vitest run src/lib/server/services/images/guards` then `npm run check`.
Expected: PASS; 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add scripts/images src/lib/server/services/images/guards docs/plans/image-generation/results-part-2-server.md
git commit -m "Tune the pixel guards on real Qwen renders to the design's drift numbers"
```

### Task 6: ai.dev and the sofa session

Only when the owner asks for the ai.dev deploy.

- [ ] **Step 1: Deploy and configure ai.dev**

Deploy the branch's exact commit to ai.dev the way the deploy notes say (push an explicit SHA; the scripts' "migrations are up to date" line is not evidence: check the two new tables exist). In ai.dev's admin System screen, set Picture server to `http://127.0.0.1:8188`; Tool Health shows `make_image` healthy.

- [ ] **Step 2: The sofa session** (the owner drives, the agent records)

On the owner's own photos of a room, a sofa and a rug (design 5.12): a new picture; a recolour; new upholstery; a cushion added in a marked box; the sofa moved to a marked spot; the sofa put into the real room photo; then five more chained changes. For each step record: did it do what was asked, what the card and Alfy said, seconds, whether a retry happened.

- [ ] **Step 3: Measure the drift**

Download each version (the card's Download), recompute its change mask with `scripts/images/drift.ts --mask-only`, and run `lpips.py` against the version it started from and, after the five chained changes, against the original photo.
Expected: the design's thresholds (outside the edited area at most 0.10 and at most 4 px; at most 0.20 after five chained changes; at most 0.05 with paste-back and no visible seam).

- [ ] **Step 4: No take reused its input's seed** (owner-approved read-only query on ai.dev's database)

Run the query: `SELECT id FROM image_jobs WHERE EXISTS (SELECT 1 FROM json_each(json_extract(request_json, '$.avoidSeeds')) WHERE value = image_jobs.seed);`
Expected: no rows (Review Focus 5).

- [ ] **Step 5: Write the Acceptance section, commit, and stop**

Pass or fail for each of the design's three "Done when" lines, with the numbers. Production gets `COMFYUI_URL` only when the owner says so.

```bash
git add docs/plans/image-generation/results-part-2-server.md
git commit -m "Record the sofa session on ai.dev against the design's drift thresholds"
```
