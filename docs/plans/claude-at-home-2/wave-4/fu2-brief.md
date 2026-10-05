# Agent FU-2 · focus-trap pass three: three dialogs with no trap, `ModelForm`'s Escape, the flaky admin test

The owner (2026-10-05) pulled FT-2's open items into the final round. Focus-trap passes one and two are merged; the
shared utility and its nesting pattern are in `src/lib/utils/focus-trap.ts`, `DialogShell.svelte`'s dialog stack
(`registerDialog`, `isTopmostDialog`, `hasOpenDialog`) and FT-2's hand-off.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fu2`, branch
  `fix/focus-trap-pass-three` (from `feat/artifacts`), e2e port **5470**, label `fu2`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/fu2-report.md`.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); FT-2's report
  `docs/plans/claude-at-home-2/wave-3/ft2-report.md` lines 40–70 (its items 2–4, the pattern, the hand-off).

## Steps

1. **`ModelForm`'s Escape first (a real bug).** One Escape in the model-icon crop dialog cancels the crop **and** closes
   `ModelForm` with its unsaved edits, because `ModelForm` closes on any window Escape. Red first with real keys in
   Playwright (open a model's form, change a field, open the icon crop, press Escape once: the crop closes, the form and
   its edit stay; a second Escape closes the form), then the gate through the dialog stack.
2. **A trap for the three `aria-modal` dialogs that have none** — `chat/ImageLightbox.svelte` (keep its arrows and scroll
   lock), `chat/ModelSelectionGuideModal.svelte`, `settings/_components/ModelForm.svelte` — onto the shared utility with the
   nesting pattern (first focus, Tab and Shift+Tab stay inside, Escape closes the topmost only, focus returns to what
   opened it). Pin today's behaviour first, then one Playwright case per dialog driven by the keyboard alone. Then drop
   `ConversationJumpRail`'s now-redundant `onTab` override (and the option, if nothing else uses it) with its tests green,
   and fix the stale doc comment on `FocusTrapOptions.isTopmost` FT-2 names.
3. **The flaky `tests/e2e/settings-admin.spec.ts:411`.** Two `confirm-delete` buttons exist during a fade-out. Find
   whether the test targets too early or the UI keeps a dead dialog's button live (a button that is leaving must not
   take a click): fix the cause, not the symptom, and run the spec 10× in a row green.

Then the full gates once (Wave 3 rules' list; Playwright adds `settings-admin.spec.ts`, `settings-admin-system.spec.ts`,
`admin-users-campaigns.spec.ts` and any spec that opens the lightbox or the model guide).

**Runs beside you:** TR-D1 (tours' reader side) and W4-B (the project bundle, the doc fixes). You touch no `artifacts/**`
file, no `i18n/artifacts.ts` and no project/knowledge file.
