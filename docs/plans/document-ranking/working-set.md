# The working set and the age of a document (2026-11-10)

Whether `rankWorkingSetCandidates` (`src/lib/server/services/working-set.ts`) lost documents the person was working with, because
`scoreCandidate` passed the age of the file in **seconds** to `computeDecayScore`, the mistake that had cancelled the embedder in the
document search (`README.md`, "What was wrong"). It did, on the turn after the one that names the document. The signals that say "the
person is working with this document" no longer go through an age factor; the weakest reason to keep a document, a match with the
message, still does, on purpose (below).

## What was wrong

`scoreCandidate` summed the turn's signals (attached this turn 100, active document focus 92, recent correction 62, recently refined
family 58, current generated document 54, plus 15 for each word of the message found in the document, at most 60) and then ran the sum
through `computeDecayScore`: `sum * exp(-0.011 * age_s) + 0.35 * words found`, the age being `now - artifact.updatedAt`, the time the
FILE was last written. A document is kept when its score reaches 20. One signal alone stops reaching it after:

| signal | weight | falls under 20 after |
|---|---|---|
| attached this turn | 100 | 146 s |
| active document focus | 92 | 139 s |
| recent correction | 62 | 103 s |
| recently refined family | 58 | 97 s |
| current generated document | 54 | 90 s |
| focus and 4 words found | 152 | about 190 s |

The focus signal on a document written an hour ago scored 5.8e-16; a day, exactly 0, and a score of 0 writes no new row
(`refreshConversationWorkingSet` skips `candidate.score <= 0` when it would insert). Only a message with 58 words found in the document
could keep an old one (`0.35 * 58` is the one term the decay does not scale).

## Where the loss showed

`refreshConversationWorkingSet` runs where a turn ends and stores each document `active` or `cooling`; the next turn's
`selectWorkingSetArtifactsForPrompt` reads only the `active` rows. So the age at the END of a turn decides what the NEXT prompt carries.
One route covers a document the turn itself names: Working Document Selection makes it `preferredArtifactId`,
`findRelevantKnowledgeArtifacts` loads it by id, and `prepareTaskContext` protects it. That one-turn route is gated by wording in the
message ("this document", "make it shorter": `working-document-selection.ts`), so the turn after it, whose message does not name the
document, had only the working set.

Real functions, a real migrated SQLite file, synthetic text, the clock faked (a throwaway probe made these tables; the tests below keep
the cases that matter). A generated document D in a conversation, written at t0 and
refreshed while fresh, the person back after 10 minutes, an hour or a day with D open in the workspace, three turns 30 s apart. Is D's
text in the prompt `buildConstructedContext` builds?

| age of D | A "Please make this document shorter" | B "And what about the second paragraph?" | C "Now make it more formal" |
|---|---|---|---|
| 0 s | in | in | in |
| 10 min, 1 h, 1 day, before | in (carried from the fresh refresh) | **missing** (`cooling`) | in (the one-turn route) |
| 10 min, 1 h, 1 day, after | in | in | in |

Straight through the two functions the work asked about, D the active focus, "Please make this document shorter": at 3 minutes the row was
`cooling` (12.7), at an hour `cooling` (5.8e-16), at a day there was no row, and `selectWorkingSetArtifactsForPrompt` returned nothing for
the next turn. After: `active`, 92, selected, at every age.

## Intent

- Before 2026-04-18 `scoreCandidate` had no time term at all (`0b099a009^`). The decay arrived in `0b099a009` ("rebuild
  buildConstructedContext ..."), the commit that made the same call in `documents.ts`; its one test checks that a document 30 days old
  ranks under a new one, not that it is dropped. `artifact-decay.test.ts` tests the function in seconds, on its own.
- ADR-0004, item 7: "Persist active Context Sources across turns until a clear topic shift, reset, exclusion, or task boundary change."
  A rule about the topic, not about a clock. The test is called "carries broad active document sets across turns".
- `context.test.ts` was given `updatedAt: Date.now()` on two working-set fixtures on 2026-05-29 (`55c57f262`), a month after the decay,
  while the shared fixture is dated 2026-04-01. Those two tests expect the document to come out `active`, which a document of April
  could not under the decay: circumstantial, but the tests needed a fresh file to stay green.
- No document says the working set is meant to hold only what was written a moment ago.

Verdict: a bug, the same unit mistake, and the one-turn route does not make it harmless.

## What changed

- `scoreCandidate` adds the five signals without an age factor. A score is no longer a function of `Date.now()` except through the match
  term.
- `rankWorkingSetCandidates` breaks equal scores by `updatedAt`, newest first, then by id. The decay used to do that by accident; with
  exact ties among documents attached together, which of them the limits (64 in all, 48 documents, 16 outputs) keep is now the newest.
- The message match keeps exactly its old formula, `computeDecayScore` on the match boost alone. It is the weakest reason there is: three
  letters of the message found anywhere in the text, so "the" and "and" match nearly every reply of a chat. A first version dropped the
  age from the whole sum, and in a 20-turn chat, one reply stored per turn, the next prompt held 16 active rows and **18 of the 20 old
  replies** (2.9 kB against 0.4 kB; the lease review the chat started with was still missing). Aged as before it holds 1 active row and 2
  of the 20 replies in the prompt, as it did.

What changes for a chat turn: a document the turn names, corrects, refines or works on as the current generated document is still in
the next turn's prompt when that message does not name it, whenever the file was last written. Before, it was only if the file was written
within about two minutes of the turn's end. Nothing else moves: a document no signal points to is carried one more turn and then leaves
the set; the cut of 20 and the limits are as they were.

## Not changed, and noticed

- The match term's age is still in seconds. It is what keeps a chat's own old replies out; what a message match should keep, and
  `scoreMatch` counting "the" as a hit, is a change of its own and wants its own measurement.
- The wording that makes an open document the turn's focus is English only (`DOCUMENT_FOCUS_RE`, `DOCUMENT_ACTION_RE`,
  `DOCUMENT_REFERENCE_RE`, the correction and reset phrases). With D open, 3 of 10 English follow-ups written for the probe made it the
  live focus and 0 of 8 Hungarian ones (an illustration, not a sample of real messages). In the Hungarian run D is in the prompt for the first turn back (carried from the refresh while it was fresh)
  and missing from the second and third, at every age, fresh included: no Hungarian message made it the focus, so nothing renewed it.
  This fix does not touch that.
- Read from the code, not measured: `refreshConversationWorkingSet` looks at the 8 most recently updated generated outputs of the
  conversation, and every reply is stored as one, so after a few replies a produced document is no longer among them for the
  "current generated" and "recently refined" signals. The active-focus signal does not depend on that list.

## Verification

`working-set.test.ts` (the five signals at an hour, a day and a month; nothing pointing at a document; newest first on equal signals and
at the limit; a match alone keeps a fresh document and not an old one) and `tests/integration/working-set-carryover.test.ts` (the
refresh and the next turn's selection; the next prompt through `buildConstructedContext`; a document is let go once the conversation moves
on; a 12-turn chat does not pile its replies). Sixteen of them fail on the old code and the two that guard the match term pass on it.
Deliberate breakages: no tie-break fails the two tie tests; the match term without its age fails the unit guard and the long-chat guard.
