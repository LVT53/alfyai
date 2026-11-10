# Working Document Selection in Hungarian (2026-11-10)

Hungarian follow-ups did not renew the workspace document's focus. The working-set age fix
could carry it into the first prompt after returning, but not into the second and third.
`Rövidítsd le ezt a dokumentumot`, `Írd át formálisabbra` and `Fordítsd le németre` now select
the open document. The existing English regexes, including their flags and boundaries, are unchanged.

## Measurement before changing code

Synthetic translation pairs only: 40 positives per gate per language, 40 shared unrelated messages
per language, and additional tempting negatives for each gate. There are also 40 document follow-ups
and 15 off-topic editing requests per language. No owner's chats, documents or memories were read.
The corpus is `src/lib/server/services/working-document-hungarian.test-helpers.ts`.

These are individual gates, not the final selection. Before counts come from `3cc95f074`;
the English column is identical after the change. The last column is the new Hungarian reading
alone; the combined focus noun gate recognizes the remaining bare `PDF` through the original English regex.

| Gate | English positive hits, before = after | Hungarian hits before | Hungarian reading after |
|---|---:|---:|---:|
| Focus noun | 40/40 | 1/40 | 39/40 |
| Action | 40/40 | 0/40 | 40/40 |
| Reference | 40/40 | 0/40 | 40/40 |
| Correction | 40/40 | 0/40 | 40/40 |
| Reset | 40/40 | 0/40 | 40/40 |
| New file | 40/40 | 3/40 | 40/40 |
| Explicit input reference | 40/40 | 0/40 | 40/40 |

| Gate | English negatives hit, before = after | Hungarian negatives before | Hungarian reading after |
|---|---:|---:|---:|
| Focus noun | 4/46 | 0/50 | 2/50 |
| Action | 3/43 | 0/48 | 1/48 |
| Reference | 2/42 | 1/45 | 0/45 |
| Correction | 2/42 | 0/44 | 0/44 |
| Reset | 0/43 | 0/47 | 0/47 |
| New file | 0/45 | 0/47 | 0/47 |
| Explicit input reference | 2/42 | 0/43 | 1/43 |

The remaining Hungarian raw hits are noun/word-stem ambiguities: `fájlrendszer`, `szerződéses`,
`szerkesztőség`, `nyitott kérdés`. The existing English reading still matches `it` inside
`bolygóit` because its ASCII word boundaries are preserved. Tests distinguish these raw hits
from complete signals instead of claiming every matched word means the open document.

## Effect on the real resolver and prompts

With one synthetic generated document open, through `resolveWorkingDocumentSelection`:

| Effect | English before = after | Hungarian before | Hungarian after |
|---|---:|---:|---:|
| On-topic follow-ups making it live focus | 19/40 | 0/40 | 19/40 |
| Off-topic messages wrongly making it focus | 0/55 | 0/55 | 1/55 |
| Correction | 40/40 | 0/40 | 40/40 |
| Reset | 40/40 | 0/40 | 40/40 |
| New-file suppression of generated carryover | 40/40 | 3/40 | 40/40 |

All **398 recorded English messages** retain their five answers (active focus, document focus,
correction, reset and new-document suppression). The golden table was recorded and committed
before implementation in `working-document-wording.test-helpers.ts`.
The final Hungarian reading adds no complete signal on 235,976 public dictionary words,
72,362 distinct English prose lines from installed package documentation, or 4,649 English UI strings.
Those scans establish the measured invariant, not a proof about every possible sentence.

The real migrated-SQLite integration test builds prompts with `buildConstructedContext`, stores
a synthetic reply and refreshes the working set after each turn. At **10 minutes, one hour and one day**:

| Turn | Before | After |
|---|---|---|
| A: `Rövidítsd le ezt a dokumentumot` | in prompt | in prompt |
| B: `És mi a helyzet a második bekezdéssel?` | missing | in prompt |
| C: `Írd át formálisabbra` | missing | in prompt |

A renews the working-set row; B reads that row and then lets it cool; C selects the document
through its own focus wording. Topic changes still release it. English integration cases remain.

## Approach and tradeoffs

- Each message gets one English reading and one Hungarian reading. Complete follow-up and
  new-file verdicts are formed within each reading, then combined. `Update ezt` cannot join an
  English action to a Hungarian reference. There is no model call or reply-language detector.
- Hungarian word lists live beside the existing English gates in `working-document-selection.ts`.
  They read the person's message and write no model-facing text; ruling 79's invariants still hold.
  The file is registered in `HUNGARIAN_BY_DESIGN` for that reason.
- Both the Hungarian message and list entries are normalized with NFD and stripped of combining
  marks. Unicode letter lookarounds with `iu` handle word starts and endings. In the prototype,
  listing only accented and unaccented spellings lost mixed-spelling examples (action 28/40,
  correction 30/40), while folding retained 40/40. Tests cover accented, unaccented, mixed and
  decomposed Unicode typing. The original text is still used everywhere else.
- A definite imperative or conditional can carry the omitted object: `Írd át formálisabbra`.
  An accusative object immediately following it, with or without an article, blocks that inference:
  `Írd át a bevezetőt`, `Foglald össze Hamlet cselekményét`. The search is bounded to three words.
  In the prototype, assuming every definite verb meant the open document hit 11/15 tempting
  off-topic requests; requiring no explicit object reduced that to 1/15. Review additionally
  covered article-free named objects; final follow-up recall is 19/40, rather than the prototype's 20/40.
- Source inflections are explicit: `forrásvíz` must not authorize using the open document as input.
  `PDF-et` alone names an output, while `ebből`, `dokumentumból` and `PDF-ből` can name an input.
- Negated resets retain continuity, and completion questions do not announce a completed task.
  Move-on questions such as `Válthatunk témát?` remain resets. Completion punctuation is scanned
  once per clause, so repeated completion cues do not repeatedly scan the same suffix.
- English collision checks drove closed endings for `generál` (folds to `general`), and exclusions
  for `Javitero` and `formazyl`. Bare `recept` is also an English dictionary word, so only its
  Hungarian inflections are added; `receptet`, `receptből` and `receptje` are covered.

## Limits and verification

These are wording gates, not a semantic classifier. `Fordítsd le franciára, hogy jó reggelt`
still wrongly treats the open document as the object (1/15 tempting examples). Questions without
an editing action and many explicit section edits still lack their own live-focus signal, as in
English; the working set covers the next turn. Broader English recall changes need a separate decision.
The message-match age term and generated-output candidate window discussed in `working-set.md`
are outside this change.

Tests: existing selection tests; English golden table; all seven Hungarian gates and typing styles;
English UI isolation; definite/indefinite forms, named objects, negation, completion questions,
source compounds and new-file inputs; carryover at three ages; existing request purity tests.

Docs checked through official web docs (Context7/Svelte MCP unavailable): Vitest Test API and
MDN `String.prototype.normalize`; the imported investigation also checked MDN Unicode properties,
word boundaries and lookbehind, and verified NFD and `iu` support on Node 22.
