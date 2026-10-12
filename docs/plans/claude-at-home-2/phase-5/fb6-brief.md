# FB-6 — the Document and comments: Alfy is visibly at work, and nothing waits or jumps (F6, F13, F14, F18, F24, F28)

Part of the friction build (`phase-5/build-plan.md`, ruling 77). Read `phase-5/common.md` and the two files it names
first, then `phase-5/fa-report.md` §1 and the paragraphs for **F6, F13, F14, F18 (the Document part), F24 (the
Document part), F28 (the Document's "+")** in §2, and AGENTS.md's Document paragraphs (the keyboard, the change pill
inside the editor's DOM, one body per open item). Screenshots: `<scratchpad>/p5/fa-shots/` (`F06*`, `F13*`, `F14*`).

- Branch / worktree: `fix/friction-document` in `.claude/worktrees/art-fb6`, from `feat/artifacts`. Ports 5440–5449.
- Report: `<scratchpad>/p5/fb6-report.md`. Beside you: FB-3 (the panel shell, `DocumentWorkspace.svelte`) and FB-4 (the
  board). Owns: the build plan's FB-6 row (`components/artifacts/document/**` except `DownloadSheet.svelte`,
  `ReviewBar.svelte`, the comment components).

## What to fix

1. **F6.** From the first edit tool call of a turn that edits the open Document, the panel shows a quiet "Alfy dolgozik
   a dokumentumon…" state (the Canvas has one: "Alfy dolgozik a táblán: …"; reuse its vocabulary and the existing
   `alfy-activity` / `AlfyWriting` parts rather than a second mechanism) until the change lands; the change lands when
   it is saved, and the state never sticks after a failed or stopped turn.
2. **F14.** Pressing "Alfy megkérdezése" closes the composer at once, shows the reader's comment and a pending "Alfy
   válaszol…" row in the thread until the reply arrives; a second press cannot send twice.
3. **F13 (phone).** A pending change's review bar is one row on a phone (count, ‹ ›, Keep, Undo), 44 px targets kept.
4. **F18 (Document).** Keep does not make the text jump (the struck text leaves without moving what is below by 28 px in
   one frame: animate it or keep its space until the motion ends; reduced motion: instant is fine).
5. **F24 (Document).** The comments column does not take its width when there are no comments: a quiet affordance until
   the first comment, then the column (the redesign's header toggle stays).
6. **F28 (Document).** The "+" that adds a tab has a visible label or a place that says what it does (aria "Fül
   hozzáadása" today, floating alone top right).

New strings in your own block of `src/lib/i18n/artifacts.ts`, EN and HU in the same commit.

## Tests and gates

Red first, real input: F6 through the fake provider (the state appears before the change lands, and is gone after a
stopped turn), F14 (the composer closes on the press; the pending row; a double press sends once), F13 at 390 with
touch, F18 (no layout shift on Keep), F24 (no column on a Document without comments). Screenshots you look at yourself,
at most 6, in `<scratchpad>/p5/fb6-shots/`. `scripts/gates.sh agent <out-dir> --port 5440 --workers 4` with your specs
plus `artifact-document*.spec.ts`, `artifact-history.spec.ts`.

Final reply at most 12 lines: status, **your model ID**, commit range, gate summary, concerns.
