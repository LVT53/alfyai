# FB-5 — rows, headers and the phone: one header per item, rows you can tell apart, Back that closes (F7, F9, F21, F26, F28, F29)

Part of the friction build (`phase-5/build-plan.md`, ruling 77); FB-3's shell work is merged into your base. Read
`phase-5/common.md` and the two files it names first, then `phase-5/fa-report.md` §1 and the paragraphs for **F7, F9
(the panel's rows), F21, F26 (the count button), F28 (the phone crumb, the landing's project card), F29** in §2, ruling
77's F7, and FB-3's report hand-off (`<scratchpad>/p5/fb3-report.md`). Screenshots: `<scratchpad>/p5/fa-shots/`
(`F09*`, `F21*`, `F26*`).

- Branch / worktree: `fix/friction-rows` in `.claude/worktrees/art-fb5`, from `feat/artifacts`. Ports 5400–5409.
- Report: `<scratchpad>/p5/fb5-report.md`. Owns: the build plan's FB-5 row (`DocumentWorkspace.svelte`'s rows, list,
  headers and history entries; `ArtifactPanelHeader.svelte`; `ArtifactCard.svelte`'s meta; the landing's project card).

## Step 0 — a regression on your base (do it first, commit it alone)

`npm run check` reports 3 errors on `feat/artifacts`: `scripts/eval-artifact-contracts/suites/canvas-tools.ts` and its
`.test.ts` lack `instruction` in the edit tool's input type (FB-2's `701898bf` added `instruction` to `edit_artifact`;
`phase-5/fb2-report.md`). Make the eval's types match the tool's real input (the schema the tool advertises, ruling 62),
with `npm run check` at 0 errors and the eval's tests green.

## What to fix

1. **F7 (ruling 77).** Opening the panel or an item adds one history entry; Back closes the top layer (item → list →
   panel) before it leaves the chat, on phones and desktops; a forward/back round trip lands where it started; the
   existing Escape and outside-press rules (AGENTS.md: one press closes the layer that is on top) still hold.
2. **F21.** A File has one header wherever it is opened from (the chat card's "előnézete" opens the same header as the
   list: crumb, title, kind), not the older "AKTÍV DOKUMENTUM" branch.
3. **F9 (the panel's rows).** Items with the same name are told apart: a file row shows its extension and size, a
   same-name item shows its time (no version number, ruling 76); Knowledge and search follow if they use the same row.
4. **F26 (the count button).** FB-3 already made the count button bring back the item the panel was closed on (its
   report's hand-off): verify it on the phone too and leave it, or finish what it left.
5. **F29.** A Regenerate shows its progress where the item is listed too, not only on the card's button.
6. **F28.** The phone crumb fits on one line ("EZ A BESZÉLGETÉS" without wrapping, or a shorter phone form); the
   landing's project card does not truncate its meta to "1 csevegés · aktív: …" without a way to read it.

## Tests and gates

Red first, real input: F7 at 390 with touch and at 1440 (Back closes the item, then the list, then the panel, then
leaves), F21 (both ways in show the same header), F9, F26, F29. Screenshots you look at yourself, at most 6, in
`<scratchpad>/p5/fb5-shots/`. `scripts/gates.sh agent <out-dir> --port 5400 --workers 4` with your specs plus
`artifacts-panel*.spec.ts`, `artifact-panel-*.spec.ts`, `artifact-chat-card.spec.ts`, `artifact-delete.spec.ts`,
`project-panel-over-dialog.spec.ts`, `home-projects.spec.ts`.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, concerns.
