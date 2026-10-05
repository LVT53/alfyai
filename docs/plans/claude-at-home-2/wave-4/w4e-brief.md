# Agent W4-E · Slice 5b T4: what a turn made appears in the message's Sources panel

Rulings 6 and 7: an artifact a turn made or changed appears as an evidence row in the message's **Sources panel**
(`MessageEvidenceDetails.svelte`, opened from the Info popover's counts), labelled with its kind; no new popover row.
This touches the evidence/sources surface, so an Opus reviewer will read your diff: keep it small and explicit.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-w4e`, branch
  `feat/artifacts-s5b-evidence` (from `feat/artifacts`), e2e port **5430**, label `w4e`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/w4e-report.md`;
  screenshots `…/scratchpad/w4/shots/w4e/`.
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); rulings 6, 7, 18, 20, 22,
  51, 69 in `decisions.md`; in `slice-5.md`, by range: 479–572 (the evidence contract), 616–635 (i18n), 999–1057 (T4).
  Its line numbers predate Waves 2–3: re-anchor by symbol (`EvidenceSourceType`, `GROUP_LABELS`, `GROUP_ORDER`,
  `buildAssistantEvidenceSummary`, `persistAssistantEvidence`, `isDocument()`, the type-icon `switch`).

**Ruling (orchestrator) on scope:** build what has a surface — the widening and the "Made in this chat" group. **Do not
build `getArtifactSources` or the `artifacts.sources.*` strings**: the approved redesign has no place in the panel that
lists an item's sources, an unused export is a Fallow finding, and the turn's web sources already show in the same
Sources panel. (Recorded as an owner follow-up; cost if wrong: one read-model function and a panel row later.)

## Steps

1. **Red tests, then the server.** From T4's list, the cases about the group (one group per turn, only when the turn
   made or changed something; a made item never in the document group; `sourceType: "artifact"`, `status: "reference"`;
   the kind in metadata, never the body; stored summaries without the group still read), plus: an item the turn made
   **and then deleted** in the same turn, an incognito turn (its rows stay on its own message; nothing reaches another
   chat), a produced file stays where it is today (ruling 18: a file is not re-typed). `"artifact"` joins
   `EvidenceSourceType` with its `GROUP_LABELS` / `GROUP_ORDER` rows (after `document`, before `tool`);
   `turnArtifacts` is derived in `finalize-steps.ts` from the turn's completed `create_artifact` / `edit_artifact` calls
   and passed into the same evidence write. Never Slides (ruling 69). Re-run the containment suite; any new artifact
   read goes through the facade's ownership scope, with **no** new `ALLOWED_WITHOUT_SCOPE` entry.
2. **The row.** In `MessageEvidenceDetails.svelte`: an artifact row is a button that opens the item in the panel (widen
   the `isDocument()` gate; reuse the existing open path into the shared workspace — the same one a chat card uses, so
   a deleted item shows the deleted state the card would), the kind's own icon (`kind-icons.ts`; the icon `switch` has a
   `default`, so add the case by hand) and the kind word (`artifacts.type.*`), the group heading
   `artifacts.evidence.madeInThisChat` (EN + HU). Component tests from T4's list, and one Playwright case driven by real
   clicks, red first: a turn that makes a Document → open the message's Sources → the row shows "Dokumentum" with its
   icon → clicking it opens the panel on that Document (use the e2e fake provider the artifact suites already use).

Then the full gates once (Wave 3 rules' list, every artifact suite, plus `tests/e2e/live-evidence-metadata.spec.ts` if
it runs offline). Screenshots you look at yourself: the Sources panel with the new group, HU at 1440×900 and 390×844,
light and dark.

**Runs beside you:** named by the orchestrator at dispatch; you share at most `src/lib/i18n/artifacts.ts` (append your
keys in your own block) and the containment suite (append one `describe`).
