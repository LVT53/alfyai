# Canvas agent S3-X · posters, PNG export, and the performance budget (Slice 3 T7 + T8's perf half)

The board is complete in the panel (S3-B…S3-R2; read their hand-offs). You make it **leave the panel honestly** — a PNG
of the board that shows App, map, photo and live-web blocks as their posters (never an empty box), downloadable from the
header — and you **hold the performance line**: the structural budgets, the timing ceiling, and the editor's initial chunk
back under 65 kB gzip.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3x`, branch
  `feat/artifacts-s3-export` (from `feat/artifacts` after S3-R2's merge), e2e port **5530**, label `s3x`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3x-report.md`;
  screenshots `…/scratchpad/w3/shots/s3x/`.
- The orchestrator names any parallel agent when you start.

## Read first

`wave-3/common.md`; the hand-offs of `s3r2-report.md`, `s3r1-report.md`, `s3a-report.md`, `s3c-report.md` (an export
leaves out the pins and the catcher), `s3f-report.md` (marks store `var(--ink-*)`, so a colour probe must read a
theme-stable value; the chunk numbers), `s3b-report.md` (the chunk guard). Rulings 9 and **16** (CI asserts structural
budgets and a **loose** timing ceiling — average frame **under 33 ms**, which overrides the spec's 40 — and the fps
figure is printed and recorded, never asserted), 42, 49, 51, 18 (a produced file stays `generated_output`).
`slice-3.md` by range: 1024–1062 (posters and PNG export), 1063–1095 (the perf budget), 1879–1938 (T7's poster/export
tests), 1939–2001 (T8). You add `html-to-image@1.11.11` back (S3-F removed it until it was used): replace your
`node_modules` symlink with your own `npm ci`, then `npm install --save-exact html-to-image@1.11.11`, and commit that
alone.

## Step 1 · Posters

`_lib/poster.ts`: blocks that a `foreignObject` clone cannot reproduce (App, map, photo, live web — the registry's poster
policy) get a poster PNG captured from the node's own element (spec's timing: once after first mount with data,
debounced; again after the data changes; once more before an export that finds one missing), stored through the existing
generated-file path (never a new store; a thin route only if one is needed — `requireApiUser`, ownership scope, PNG only
→ 415 otherwise, a size cap), and referenced from the node's data as `PosterRef`. A failed capture never blocks a save;
the node says `posterFailed` once. The map block's poster says its basemap is not live.

## Step 2 · PNG export and Download

`_lib/export-png.ts` in the spec's order (bounds, clamp 800×600…2400×1800, camera saved and **restored in a `finally`**,
posters mounted and **unmounted in a `finally`**, pins and catcher left out), `POST /api/artifacts/[id]/exports/png`
(`requireApiUser`, ownership + `?conversationId=`, PNG data only → 415, size cap → 413, `{ ok: true, fileId, width,
height }`), the export stored as a produced file linked to the board (ruling 18: `generated_output`, so it shows as a File
in the chat card and the library). The panel header's **Download** for a Canvas offers the PNG (not the raw board JSON it
gives today); missing posters are named in one notice and drawn as a legible placeholder card. Tests: T7's list
(1889–1904), the camera and posters restored after a throwing capture, another user's board → 404.

## Step 3 · The budgets

- `tests/e2e/artifact-canvas-perf.spec.ts`: the spec's structural table (board JSON ≤ 512 kB for the 150-note +
  200-stroke fixture, node/annotation counts, pad coverage ≥ 95 %, stroke commit < 8 ms, the timing ceiling **avg < 33 ms**)
  asserted; the average/p95 frame time and fps **printed**, not asserted, and copied into your report.
- The chunk guard: the editor's initial chunk **≤ 65 kB gzip** measured like-for-like (S3-C and S3-A report two
  readings — settle on one honest measure, the one that includes what first paint loads, and say why), the chat route
  without an artifact open unchanged within 2 kB, Chart.js and MapLibre not in the editor's static closure. Get the
  editor under the line by loading on demand what first paint does not need (the drawing layer until a drawing tool is
  chosen or the board has marks, the export on click, …), with the guard enforcing it.

## Proof

Screenshots you look at yourself: an exported PNG with an App and a map poster and a chart (open the PNG itself), the
header's Download, the missing-poster notice; Hungarian. The perf numbers in the report. Full gates once at the end.
