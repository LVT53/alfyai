# Fix agent S · The Opus security review's findings on Delete / Regenerate

The Opus review of G2-A's server side (`rd/sec-review.md`, same folder — read it first, by finding) found no Critical or
High issue and no cross-user or incognito-content leak. Fix these, test-first. **Agent G3 runs at the same time** on
keyboard undo/redo, the editor's undo edge cases, `Tabs.svelte`, the panel list rows' accessible names (the
`chrome="row"` branch of `ArtifactCard.svelte` and many e2e selectors), the phone review bar and ticked tasks: keep your
`ArtifactCard.svelte` edits to the card's deleted/unavailable state (not the row chrome) and stay out of the others.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-secfix`, branch
  `fix/artifacts-delete-review`, e2e port **5525**, label `secfix`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/7b83c54c-f41d-4571-8b3c-4cb3539fb5b2/scratchpad/rd/secfix-report.md`
- Read first: `rd/common.md`, `rd/sec-review.md`, the hand-off of `rd/g2a-report.md`; AGENTS.md's Artifacts rules and
  rulings 51 and 53 in `docs/plans/claude-at-home-2/decisions.md` (containment; forks do not reach a parent's artifacts
  through the tools).

## Rulings (orchestrator) and what to build

1. **M1 — an item that exists but is out of reach is not "deleted".** The deleted-state projection separates "gone" from
   "exists but not reachable from this conversation" (for example the parent of a forked incognito chat). The second shows
   "Made in the original chat" / "Az eredeti beszélgetésben készült", muted, no Open, no Regenerate — containment stays
   exactly as it is. Regenerate refuses up front, before any model call, when the id still exists anywhere, with its own
   reason (`recreate.ts`). Tests: the fork case end to end (the review's probes P1, P2, P4 as real tests).
2. **L1 — Delete only acts on items this conversation made.** An item listed in a conversation it was not made in shows no
   Delete (panel header and list row); the route refuses it with a distinct reason when called with another
   conversation's id. Tests with the fork case (probe P3).
3. **L2 — honest confirm copy.** Replace "It can't be undone" with wording that is true now that Regenerate exists: "Delete
   this document? You can regenerate it from the chat." / "Törlöd ezt a dokumentumot? A beszélgetésből újra
   létrehozhatod." (per kind; where no stored source exists for that item, keep "It can't be undone"). EN and HU together.
4. **L4 — no orphan vector.** An embedding refresh that races a delete must not write a vector for a deleted subject (check
   existence in the refresh's write, or cancel the queued refresh on delete). Test the race deterministically.
5. **L5 — one Document per "Open as document".** A second press (another tab, a double click) for the same message returns
   the existing Document instead of making a second one, as long as that Document still exists; the button is disabled
   while its request runs. Test both.
Not changed (recorded): L3 (a file job's regenerate needs only the job id, like its retry/cancel/dismiss siblings) and L6
(App regeneration has no capacity limit, like the existing App regenerate route) — both are the existing pattern.

## Proof

Tests first for each; the ownership/incognito/404 suites stay green; every artifact suite at the end (`rd/common.md`
gate 4); Fallow zero new. Reply's first line: your exact model ID.
