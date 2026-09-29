# Polish agent G3 · Keyboard undo/redo, the editor's undo edge cases, tabs ARIA and targets, named list rows

The owner: "I'd like keyboard controls support added for undo and redo actions", plus the items left for later that the
owner asked to finish now (two of them were follow-up chips: the Undo empty-block bug and the tab strip's ARIA). Every
other polish agent is merged before you; you run alone.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-g3`, branch
  `polish/artifacts-keys-and-edges`, e2e port **5520**, label `g3`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/g3-report.md`
- Screenshots: `…/scratchpad/rd/shots/g3/` (same scratchpad as the report).
- Read first: `rd/common.md`; the hand-off sections of `rd/rd4b-report.md` (the change pill, `undoAlfyChange`, Redo),
  `rd/fxb-report.md` and `rd/fxc-report.md` (tabs), `rd/fxd-report.md` (why named list rows were left: ~10 suites'
  selectors), and `rd/g1a-report.md`, `rd/g1b-report.md`, `rd/g2a-report.md`, `rd/g2b-report.md`.

## Items

1. **Keyboard undo/redo.** First find out what works today: in the Document editor, do Mod-Z, Mod-Shift-Z and Ctrl-Y undo
   and redo the user's own edits (Chromium on macOS and on Linux/Windows key mappings)? Is anything in the app swallowing
   them (a global key handler, focus outside the editor after a toolbar click)? Make them work wherever the editor has
   focus and right after the toolbar's Undo/Redo buttons are used, show the shortcut in those buttons' tooltips and
   accessible names (localized), and make the change pill's Undo/Redo reachable and operable by keyboard with a documented
   shortcut if one fits without clashing with the editor's history. Alfy's changes stay governed by Keep/Undo (they are
   not part of the user's text history). State exactly what you found and changed.
2. **`undoAlfyChange` collapses an existing block whose previous text is legitimately empty** (follow-up chip; rd4b #5):
   tell an inserted block from an existing empty one. Test-first.
3. **Redo after Undo loses the extra blocks of a multi-block insert** (rd4b #1): Redo restores every inserted block.
   Test-first.
4. **Tabs:** the `⋯`/`+` buttons move out of `role="tablist"` (follow-up chip; keep fix B's unclipped menu and every
   keyboard behaviour), and on phones the tabs, `⋯` and `+` reach 44 px (review 233–238).
5. **Named panel-list rows:** each row's accessible name says what it is (title, kind, time), and the ~10 suites that
   select rows by their old name are updated in the same change (review 276–279's first half).
6. Confirm the third follow-up chip (the count-button dot follows the persisted review state) is covered by a test; if
   not, add one.

## Proof

Tests first for 1–5 (keyboard with Playwright's `ControlOrMeta` where it fits). Every artifact suite at the end
(`rd/common.md` gate 4). Screenshots in Hungarian, looked at yourself: the tab strip on a phone; the toolbar tooltip with
the shortcut.
