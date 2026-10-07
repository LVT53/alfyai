# Fix round after RV-F (the Opus final review) · three agents, three disjoint clusters

RV-F reviewed `feat/artifacts` at `ce62e412`: **ready after fixes**, 0 Critical, 3 Important, 11 Minor
(`docs/plans/claude-at-home-2/wave-4/rvf-review.md`). **Read your cluster's findings in it in full** (with their
reproductions and file:line), and its "Fix plan". Each agent takes ONE cluster below; the three run at the same time on
disjoint files.

- Common: `wave-4/common.md` (+ the Wave 3 rules it points to). Red first with real input for anything a person sees
  (Playwright: pointer, keyboard, touch), a test that fails on the unfixed tree for anything else. Full gates once at the
  end (Wave 3 rules' list; Playwright with every artifact suite and the specs your cluster touches). Reports to
  `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/fx-<a|b|c>-report.md`,
  screenshots beside them in `…/w4/shots/fx-<a|b|c>/`.
- **The chat route's size budget has ~55 B of headroom.** Do not move `--chat-baseline` yourself: measure your growth
  against your base (build both) and report the two numbers; the orchestrator records the move (ruling 68's notes).

## FX-A · I-1: Alfy's board edit never overwrites the reader's newer words, even when their save coalesced

Worktree `.claude/worktrees/art-fxa4`, branch `fix/artifacts-w4-stale-read` (from `feat/artifacts`), port **5400**.
Files: `normal-chat-tools/artifact-tools/read.ts`, `edit.ts`, `canvas-model.ts` and their tests (ruling 67; FU-1's
`readBody` on the `@Alfy` path is the precedent). The red test is RV-F's probe: a reader's save that coalesces into the
version the model read (ruling 47), then the model's edit — refused as `stale` for the changed block, the rest applies.
Keep the board body the turn read (moved forward by the turn's own landed edits) and pass it as `readBody`, with
`readVersionId` as the fallback. Prove the tool path on the real tool envelope, not a mock of it.

## FX-B · I-2, I-3, M-6, M-11: the panel over a project's Files dialog; the tours' reader; the dialog's footer

Worktree `.claude/worktrees/art-fxb4`, branch `fix/artifacts-w4-project-panel` (from `feat/artifacts`), port **5410**.
Files: `projects/[projectId]/_components/ProjectFilesDialog.svelte`, the project `+page.svelte`, `DocumentWorkspace.svelte`
(the dialog-stack hook only), `client/session-boundary.ts`, `client/api/artifact-tours.ts`, `i18n/projects.ts`, a new e2e
spec. Red first in Playwright with real keys: an item opened from the Files dialog keeps Tab inside the panel, and one
Escape closes only the topmost layer; the panel joins the one dialog stack (FT-2/FU-2's pattern) while it sits over a
dialog. Then: the panel's tour reader is named (`currentUser`) wherever the panel is hosted, and logout drops the tours'
page-load cache (an in-tab sign-out → another user's first open shows their own tour, red first). M-6: the footer promises
removal only when a removable row exists. M-11: the "EZ A BESZÉLGETÉS" crumb does not show where the panel has no list.

## FX-C · M-1, M-2, M-3, M-7: the Sources rows tell the truth; one list of shipped kinds; the card's meta line

Worktree `.claude/worktrees/art-fxc4`, branch `fix/artifacts-w4-sources` (from `feat/artifacts`), port **5420**.
Files: `chat/MessageEvidenceDetails.svelte`, the chat `+page.svelte` (prop threading only), `shared/artifacts/kinds.ts`,
`chat-turn/finalize-steps.ts`, `i18n/artifacts.ts`, the chat card's meta line (`ArtifactCard.svelte`, CSS only). M-1: a
deleted item's "Made in this chat" row shows the deleted state through the same `DeletedArtifacts` prop the cards use
(red first, real clicks: delete from Knowledge, the row says so and does not pretend to open). M-2: a fork's copied Sources
say the item was made in the original chat (the card's own wording). M-3: one browser-safe `SHIPPED_ARTIFACT_KINDS` in
`kinds.ts`; the tours' list derives from or is checked against it, and the evidence guard reads it. M-7: "1 fül" never
wraps apart in the card's meta line ("Dokumentum · 1 fül · v1").

## FX-B2 · FX-B's three loose ends (after FX-B merged)

Worktree `.claude/worktrees/art-fxb5`, branch `fix/artifacts-w4-panel-layer` (from `feat/artifacts`), port **5470**. Read
FX-B's report (`wave-4/fx-b-report.md`, its concerns) first. (1) A click on the ~20 px ring around the expanded panel over
the Files dialog closes the panel AND the dialog: a pointer outside the panel but over the dialog closes only the topmost
layer, the same rule as Escape (red first, a real click). (2) The panel is an `aside` sitting over an `aria-modal` dialog,
so a screen reader may hide it: while it sits over a dialog it is the modal layer to assistive tech (its role/`aria-modal`,
or the dialog behind made `inert`) — pick the one that matches the app's dialog stack and test it (roles/`aria-hidden`
asserted in Playwright). (3) Destroying the dialog while the panel is registered (browser Back with both open) must not
leave the body scroll lock on (red first: Back, then the page scrolls). Files: `DocumentWorkspace.svelte` (the `overDialog`
paths only), `ProjectFilesDialog.svelte`, the dialog-stack module, FX-B's spec.

## FX-D · the in-chat card at a docked panel's narrow chat column

Worktree `.claude/worktrees/art-fxd4`, branch `fix/artifacts-card-narrow` (from `feat/artifacts`), port **5480**. FX-C found
(screenshot `…/w4/shots/fx-c/08-concern-docked-card-1100-light-hu.png`): with the panel docked, the chat column is ~340 px at
a 1100 px window and the card (`components/artifacts/ArtifactCard.svelte`, `chrome="full"`) breaks its meta line into four
("Dokumentum / · 1 fül / · / v1") while "Megnyitva a panelen ›" is drawn over it; below ~1280 px it is already crushed. The
card must adapt to **its own** width (a CSS container query on the card, not the viewport): when narrow, the action
(Megnyitás / Megnyitva a panelen / Újragenerálás) takes its own row under the title, the meta line stays one line
(ellipsis before it wraps), nothing overlaps, and every kind and state (deleted, out of reach, review badge, File rows
through `chrome="body"`) still reads. Red first: Playwright at 1100×800 and 1280×800 with the panel docked, asserting no
overlap of the action with the meta line (bounding boxes) and the meta line's height of one line; screenshots at 1100, 1280,
1440 and 390, light and dark. CSS mostly; no new strings.

## FX-E · the chat's Mermaid renders no image URL and no link a model wrote (security, pre-existing)

Worktree `.claude/worktrees/art-fxe4`, branch `fix/mermaid-hardening` (from `feat/artifacts`), port **5500**. CV-A found
(`wave-4/cv-a-report.md`, concern 1) that the chat's own `Mermaid.svelte` fetches an `img:` URL while rendering a diagram and
keeps `click … href` links, so a model-written diagram in a reply (prompt-injected through a web page, say) can make the
reader's browser call any address or show a disguised link. CV-A refuses those constructs for a diagram Alfy writes on a
board. Make **one** sanitizer (beside CV-A's rule, shared, browser-safe) that every Mermaid render goes through — chat
replies, the board's diagram blocks, the reader's own edit (CV-B's form) — removing or refusing image/icon shapes, `click`
lines, `%%{ }%%` init directives, `href`/URLs, and confirm Mermaid runs with `securityLevel: "strict"` and its output is
sanitized. Red first: unit tests per construct (in both directions: an ordinary flowchart, sequence, class, state, ER, Gantt
and pie still render), and a Playwright case where a reply with such a diagram makes **no** outbound request
(`page.route` counting requests) and shows no link. Files: `components/chat/Mermaid.svelte`, the shared rule module CV-A made,
its tests.
