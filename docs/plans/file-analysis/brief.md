# File analysis: the starting brief

Status: not started beyond this brief and the approved mockup (2026-11-10). It is first in the owner's current order. The clock-and-timezone change (branch `claude/jovial-bartik-de5d4c`, see `docs/plans/codex-handoff-2026-11-10/HANDOFF.md` 4.1) runs beside it and is a soft dependency: relative dates, and month and day boundaries in the person's zone.

## What to build

Alfy runs Python (pandas, matplotlib) on the actual spreadsheet or data file a person uploads, inside the offline sandbox, and answers with the numbers plus charts and cleaned files as cards in the chat.

ADR-0064 goal 3 (`docs/adr/0064-claude-at-home-means-workspaces-documents-and-richer-inputs.md`): uploaded CSV and XLSX files go into the offline sandbox read-only, the sandbox image gains pandas and matplotlib, charts and cleaned files come back as file cards, and the no-network security model stays. The owner picked this project on 2026-10-14. A session started that day went idle and left no code, plan or branch.

## What the owner approved (2026-11-10)

The mockup `docs/plans/file-analysis/mockup-v1.html` (example data, AlfyAI's real tokens; open it in a browser). The owner said it "looks very good". It shows:

1. A user message with an attached `Household budget 2026.xlsx` chip and the question "Which categories grew the most since January? Make me a chart."
2. The live activity rows while Alfy works: "Read … 3 sheets, 1,284 rows", "Cleaned the data: 14 dates fixed, 9 duplicate rows merged", "Calculating the change per category…".
3. The finished turn: a collapsed "Worked for 14 s · 4 steps" row; a short answer with the numbers; a chart card with an inline preview (Open, Download); a file row for the cleaned workbook with "Your original file is untouched."; a "Show how this was calculated" row (the Python); two follow-up chips.
4. A strip: upload, private read-only copy, offline sandbox, cards in the chat.

Guesses in it that the owner has not ruled on: automatic cleaning, the "Show how this was calculated" row, the follow-up chips, and the inline chart preview. Today a produced file draws only as a row (name, size, Open, Download) in `src/lib/components/chat/FileProductionCard.svelte`, so the preview is new UI; the cheap version is the row alone.

## What exists today (checked 2026-11-10)

- `src/lib/server/sandbox/python-version.ts:40`: `SANDBOX_PYTHON_PACKAGES` is only openpyxl, xlsxwriter, python-docx and python-pptx. Deploy installs them into a site-packages folder mounted read-only at `/workspace/python-packages` (`scripts/deploy-lib.sh`).
- `src/lib/server/sandbox/config.ts` binds only those packages (Python) and node_modules (JavaScript) into the container, so no upload ever reaches it. The container has no network, runs as UID 1000 on a read-only root with capabilities dropped, has a 50 MB tmpfs `/workspace` (`config.ts:371`), a 60 s timeout, 1 GB of memory and 100 processes. Outputs are collected in memory and never written to the host disk. Read `src/lib/server/sandbox/AGENTS.md`: its anti-patterns are binding, and any new mount needs a security argument written down.
- `run_python` (`src/lib/server/services/normal-chat-tools/run-python.ts`) is a scratch tool for arithmetic and quick parsing of text the user gave. `produce_file` (`normal-chat-tools/produce-file.ts`, `src/lib/server/services/file-production/`, read its `AGENTS.md`) produces files as durable job-backed cards.
- No input-file mechanism exists for sandbox programs.

## To settle with the owner

One question at a time, with a mockup for every UI/UX answer.

- Which file types: CSV, TSV, XLSX, XLS, ODS, JSON. Google Sheets arrives as XLSX or CSV. Tables inside PDFs are already read by MinerU; do they belong here?
- Size and row limits against the 50 MB scratch space and 1 GB of memory.
- Hungarian data: semicolon-separated CSV, decimal commas, `2026. 11. 10.` dates, Windows-1250 or UTF-8 text. Charts with Hungarian accents (a font that has them).
- Where the upload enters: `run_python`, `produce_file`'s program mode, or a new mode. How the model names an upload (a path under a new read-only location, never an address).
- The private per-run copy: per-user isolation, path traversal, symlinks, deletion after the run. An untested lead: send the bytes into the container through the Docker archive API (into its tmpfs) instead of bind-mounting a host copy; that keeps "nothing touches the host disk".
- Which packages to add (pandas, numpy, matplotlib; xlrd for XLS and odfpy for ODS if wanted) and what they cost the deploy.
- Whether the original is ever modified (the mockup says never).
- How the numbers are checked: show the code, maybe a self-check pass. The repo's measured rule from the Apps work is that quiet content errors ship unless facts are verified.
- What a failed, unreadable or too-large file looks like.
- Incognito chats and memory: spreadsheet contents must not leak into profile memory by accident (read `src/lib/server/services/memory-profile/AGENTS.md`).
- The inline chart preview versus the file row alone.

## Hard constraints

- Every label, error, empty state and aria string in English and short natural Hungarian. Few choices in the UX. Self-hostable.
- The model-facing tool catalogue is held by a token tripwire (`CATALOGUE_TOKEN_CEILING = 5518` in `src/lib/server/services/normal-chat-tools/index.test.ts`). Prefer widening `run_python` and `produce_file` text over a new tool, and pay for every added word by cutting words elsewhere or by a measured raise the owner approves.
- Everything the app writes into a model request is English (`src/lib/server/services/chat-turn/AGENTS.md`, ruling 79).
- An address is never fetched because the model wrote it (ADR-0068).
- Runtime config goes through `src/lib/server/config-store.ts`.
- Read the root `AGENTS.md` and each folder's `AGENTS.md` before changing code there, and do the docs check for any framework surface.

## Process

1. First message to the owner: they may skip the questions and have you draft the design from this brief; then one open question about a real moment (the last spreadsheet or export someone at home wished Alfy could read).
2. Write `docs/plans/file-analysis/design.md`. Have a fresh reviewer read it as the builder, and settle their questions (most yourself, the owner's only where the answer changes what gets built).
3. Write the plan. Build in two waves in small tasks, each by a fresh implementer then a fresh reviewer, with the strongest model on the sandbox mount and the final whole-branch review. The owner's Claude weekly limit resets on 2026-11-16 09:00 UTC; that is context only if work moves back to Claude.
4. Work in a worktree cut from `origin/dev`, Node 22. Finish with an independent review pass and `scripts/gates.sh agent <out-dir> --port <base> <the specs for what you changed>`.
5. Commit locally in small commits. Push nothing and deploy nothing without the owner's word.
