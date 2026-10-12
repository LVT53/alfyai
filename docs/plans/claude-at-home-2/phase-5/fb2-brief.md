# FB-2 — Alfy's tools and words: Alfy changes what you asked it to change (F2, F10, F20, F22, the App brief)

Part of the friction build (`phase-5/build-plan.md`, ruling 77). Read `phase-5/common.md` and the two files it names
first, then `phase-5/fa-report.md` §1 and the paragraphs for **F2, F10, F20, F22** in §2, ruling 77's F2 and F10, and
rulings 23, 52, 58 and 62 in `decisions.md`. LV's note (`phase-5/lv-report.md`): an App's first version stores the
model's own HTML as its "brief" ("Alfy made the app: <!DOCTYPE html>…"): the create tool text says "Apps: the HTML
document" while `create.ts` treats `body` as the brief and the generator gets that HTML as its whole prompt.

- Branch / worktree: `fix/friction-tools` in `.claude/worktrees/art-fb2`, from `feat/artifacts`. Ports 5420–5429; your
  real-model tunnel uses local port 30409 (`ssh -N -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none
  -L 30409:192.168.1.96:30000 alfyroot`, model `qwen3-6-27b`, in the same command as its user; never read
  `~/.config/opencode/opencode.json`).
- Report: `<scratchpad>/p5/fb2-report.md`. Beside you: FB-1 (files and downloads; `DownloadSheet.svelte`,
  `client/downloads.ts`, the export routes, `MessageArea.svelte`, Knowledge, `ProjectFilesDialog.svelte`). Owns: see the
  build plan's row for FB-2; nothing else.

## What to fix

1. **F2 (ruling 77).** A chat request to change an open App changes that App in place: `edit_artifact` on an App runs
   the same rebuild the panel's "Módosítás…" runs (instruction → generate → verify → the contract audit), lands as one
   new Alfy version that History shows as a rebuild, and the open panel shows the new version. The tool text stops
   telling the model Apps are not edited here (it quotes that rule in its thinking today). Ruling 62: the schema the
   model sees is the validator's own, and the description's example is parsed by a test. Ruling 58: the rebuild's audit
   is the one that already guards the panel's path; say in the report exactly which function runs it for this path.
2. **F10 (ruling 77).** "Írj nekem egy dokumentumot …" with no file format makes the in-app Document; `produce_file`
   only for a named format or a download; two identical `produce_file` calls in one turn make one job.
3. **The App brief.** An App's create call carries a brief (what the App is for) separately from its HTML, or the
   summary is built from something that is not the document; the generator never receives the model's HTML as its
   prompt. Old rows stay readable.
4. **F20.** "Megnyitás dokumentumként" titles the Document at a word or sentence end, near 60 characters, never mid-word.
5. **F22.** No ids and no English in a Hungarian turn's rows: the read row names the item ("Elolvasva: Bécsi hétvége –
   tábla"), and a status line never carries an id, a field name or an English phrase. Status lines are written by the
   short-local-text path (AGENTS.md: `chat-turn/short-local-text.ts` is the one cleanup; take any new phrase it should
   catch from real model output, in a test, in both directions).

The tool texts are in the cached prompt prefix: the frozen snapshots move in the same commit, with the measured before
and after (ruling 23); `CATALOGUE_TOKEN_CEILING` only if the measure says so.

## Tests and gates

Unit tests for every tool-text and handler change (red first); a real-input Playwright test for F2's in-place change
through the fake provider (the open panel shows the new version, no second App in the list) and for F20. **A real-model
check through your tunnel**, bounded (about 12 turns): in Hungarian and English, "change this App" on an open App edits
it in place (no second App), "write me a document about …" makes the in-app Document, "make me a PDF about …" makes a
file, and no status line or tool row carries an id or English in the Hungarian turns. Put the turns and their outcomes in
your report. `scripts/gates.sh agent <out-dir> --port 5420 --workers 4` with every spec you add or change plus
`artifact-app.spec.ts`, `artifact-chat-card.spec.ts`, `chat.spec.ts`, `streaming.spec.ts`.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, the real-model outcomes, the App
edit path's audit for the Opus look, concerns.
