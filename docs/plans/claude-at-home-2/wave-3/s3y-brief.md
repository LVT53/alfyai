# Small agent S3-Y · three known fixes before the Canvas review

Three small fixes found by earlier Wave 3 agents. None touches the board's components.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-s3y`, branch
  `fix/artifacts-w3-small` (from `feat/artifacts`), e2e port **5520**, label `s3y`.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/s3y-report.md`
- **Agent S3-R1 runs at the same time**: `src/lib/components/artifacts/canvas/**`, `artifact-bodies.ts`,
  `DocumentWorkspace.svelte` (an "open this item" callback), a new listing route and service. Stay out of those.

## Read first

`wave-3/common.md`; `s3z-report.md` (its step 1 and concern (a)); `s3c-report.md` §"Open questions and concerns" item 3;
`s4v-report.md`'s concern (4). Rulings 23, 33, 51, **62**.

## 1 · Each chat remembers its own panel

S3-Z made the stored panel record whose it is, but it is still **one** record per tab: after visiting chat B, returning to
chat A no longer restores A's panel. Keep a small per-conversation map in `src/lib/client/document-workspace-state.ts`
(bounded — e.g. the last 20 conversations, oldest dropped), with every rule S3-Z's tests pin unchanged: a chat restores
its own panel; library/search opens may follow; **an incognito chat's panel is never restored in another chat and is
removed on leaving**. Tests first (A → B → A restores A's; the bound; the incognito rules still hold; an old single-record
value in `sessionStorage` is read or dropped cleanly).

## 2 · The edit tool says a block keeps its kind

`edit_artifact`'s Canvas rule does not say that `update_node` cannot change a block's kind (it is refused
`kind_mismatch`; the fix is `remove_node` + `add_node`), so the model spends a call learning it — on the tool path and
on the `@Alfy` comment path, which reuses the same text. Add the shortest clause that says it to `kind-prose.ts`'s canvas
rule (EN and HU, natural Hungarian), and check the refusal text for `kind_mismatch` names the fix. Re-measure the
catalogue (ruling 62/23: raise `CATALOGUE_TOKEN_CEILING` by exactly the measured cost plus the existing margin, numbers in
the commit message) and update both frozen snapshots in the same commit.

## 3 · The App verifier counts its tokens

S4-V noticed that the App verifier records 0 prompt and 0 completion tokens, so the App's cost line under-reports the
verification call. Find where `services/artifacts/app/verify.ts` (and its re-verification) maps the provider's usage,
fix it test-first, and check the cost the card shows for a verified App includes it.

## Proof

No screenshots needed. Full gates once at the end.
