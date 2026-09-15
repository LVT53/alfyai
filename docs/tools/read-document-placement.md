# Where a `read_document` tool would fit

Status: memo, 2026-09-15. No code. Written alongside the tool-description pass
in `src/lib/server/services/normal-chat-tools/index.ts`.

## The question

Should AlfyAI's chat model get a `read_document` tool that pulls page-anchored
passages, with citations, out of the user's own indexed documents?

## What exists today

There is no document-retrieval **tool**. The model has nineteen tools and not
one of them reads the Knowledge Library.

- `files` reads *connected cloud storage* — Nextcloud, OneDrive. Different
  substrate, different content, no index, no chunks.
- `read_generated_file` reads only what **this conversation produced**.
- `fetch_url` reads the public web.
- `memory_context` reads Honcho persona/project/history memory. ADR-0024 is
  explicit that uploaded document bodies are **not** synced into persona
  memory by default.

Uploaded-document passages reach the model as **pushed context**, not as a
pull. `chat-turn/context-selection.ts` calls
`findRelevantKnowledgeArtifacts` (`knowledge/context.ts`), which runs hybrid
lexical + semantic + rerank retrieval over `normalized_document` and
`generated_output` artifacts, then `getPromptArtifactSnippets`
(`task-state/artifacts.ts`) picks query-relevant chunks per artifact and
renders them into the prompt sections `Current Attachments`,
`Attached Sources`, `Conversation Files` and `Retrieved Evidence`.

Two numbers matter for everything below: the per-artifact defaults are
**2 chunks** and **1,400 characters**. That is the real gap. A document is
found, one passage lands in context, it is cut off mid-argument, and the model
has no way to say "more of that one, please". Today it either answers from the
truncated fragment or tells the user it cannot see the rest.

Two constraints also matter:

- **ADR-0002 / ADR-0018.** Context Selection is the *sole* authority on what
  becomes prompt context, at what inclusion level, within what budget. A tool
  that returns document text is a candidate supplier feeding that authority,
  never a second door into the packet.
- **`artifact_chunks` has no page column.** It carries `artifact_id`,
  `chunk_index`, `content_text`, `token_estimate`. Page information exists only
  at the artifact level (`pageCount`) and as a `DocumentOutlineEntry[]` whose
  anchor is a **character `offset`**, not a page. "Page-anchored passages with
  citations" is therefore not a tool-shaped problem at all — it is an ingest
  problem, and no tool can invent the anchor.

## What the tool would do

Given a document the model can already name or identify, return the passages
from that document that answer a specific question, with enough anchoring for
the model to cite them honestly.

It would **not** be a search tool. Search already happens, once per turn,
inside Context Selection, over the whole eligible corpus, with a reranker. A
second search path would duplicate that policy in a place that cannot see the
budget, and would let the model re-run retrieval the turn has already run.

## Triggers

Call it only when one of these is true:

1. The user **names a document** — "in the AlmaLinux runbook", "the lease PDF",
   "my Q3 deck" — and the name matches an entry the turn's `Conversation Files`
   registry already lists.
2. The user asks **"what does my X say about Y"** where X is one of their
   documents rather than a topic.
3. A knowledge hit is **already in context** and the user asks for more of it:
   "what else does it say", "quote the whole clause", "read further", or the
   visible passage is plainly truncated and the answer needs what follows.

Case 3 is the one that justifies the tool at all. Cases 1 and 2 mostly resolve
without it, because naming a document is exactly the signal that already makes
Context Selection retrieve it.

## Non-triggers

These are the clauses that would have to be in the description, because on an
8B-class model the negative case is the part that works:

- **Not when the passage is already in context.** If `Retrieved Evidence` or
  `Current Attachments` already quotes the answer, answer from it. This is the
  single most likely failure mode and the description must say so first.
- **Not for connected cloud storage** — that is `files`. A PDF sitting in
  Nextcloud that was never uploaded to the Knowledge Library is not an indexed
  document and `read_document` cannot see it.
- **Not for a file produced in this conversation** — that is
  `read_generated_file`, which returns the file's *current* full text and is
  the only correct input to a `produce_file` patch.
- **Not for a web page** — that is `fetch_url`.
- **Not for preferences, goals or past conversations** — that is
  `memory_context`.
- **Not to find out which documents exist.** The `Conversation Files` block
  already lists them; there is no listing action.
- **Not on a document id the model did not receive.** No id, no call.

## What it returns

Per hit, and nothing more:

- `passage` — the chunk text, capped.
- `documentId` and `documentName` — so the citation names a real artifact.
- `anchor` — today, honestly, a section title and character offset from the
  document's outline plus the chunk index. `page` only once ingest records a
  page for each chunk; until then the field should be **absent**, not guessed.
  A wrong page number is worse than no page number, because it reads as
  precision.
- `confidence` — the existing `rerankScore` / `semanticScore`, so the model can
  hedge instead of asserting on a weak match.
- `hasMore` — whether the document continues past the returned passages.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Context bloat: passages are large and land on top of what Context Selection already pushed | Hard result cap (3 passages, ~1,200 chars each). The returned text must be **deducted from the same budget** Context Selection owns, not added beside it. |
| Called on every turn, because "check the documents" always looks reasonable | Register the tool only when the conversation actually has an indexed document — the same capability-gate pattern the connector tools use. A user with no documents never sees it, so it cannot be called reflexively. |
| Called again for something already answered in this turn | Per-turn cache keyed on document id + query, reusing `tool-result-cache.ts`. A repeat call returns the same payload without re-retrieving. |
| Wrong document — the model picks a plausible-sounding name that is not the user's | Require a `documentId` the model received from a prior context block or search hit. Accept a bare name only on an exact, unambiguous match against the `Conversation Files` registry; on two matches, ask the user. Never fuzzy-match. |
| Fabricated page citations | Omit `page` until ingest supplies it. The description must say the tool returns a section anchor, not a page, so the model does not narrate one. |
| A second retrieval policy drifting from the one in Context Selection | The tool calls the *same* `findRelevantKnowledgeArtifacts` / `getPromptArtifactSnippets` path with a document filter, rather than its own query path. |
| Another ~180 tokens of description on every single turn, for every user | Counted against the catalogue budget the new tests enforce. At today's numbers (3,927 est. en / 6,249 est. hu) there is room, but it is not free. |

## Recommendation

**Fold it into the existing knowledge retrieval as an explicit "read more from
this document" continuation. Do not build a general document-search tool.**

Five reasons, in order of weight:

1. The gap is continuation, not discovery. Retrieval already finds the right
   document; it truncates at 2 chunks / 1,400 chars and the model cannot ask
   for the rest. A continuation tool closes exactly that gap and nothing else.
2. A search tool would duplicate a policy that ADR-0002 assigns to Context
   Selection alone, in a place that cannot see the turn's budget.
3. The headline feature — page-anchored citations — is blocked on ingest, not
   on tools. `artifact_chunks` has no page. Ship the anchor work first, or ship
   the tool honestly returning section anchors and add `page` later.
4. The owner's complaint is tool confusion. A continuation tool that requires a
   document id from a prior hit has a trigger the model cannot misread; a
   general "search my documents" tool overlaps `files`, `memory_context` and
   the pushed context at once, and would make the confusion worse.
5. Scoping it this way makes it capability-gated and cheap: invisible to users
   with no documents, and small enough to describe in one paragraph.

If it is built, name it `read_document`, gate registration on the conversation
having at least one indexed document, require a `documentId` plus a `query`,
cap it at three passages, cache per turn, and write the description to the same
template as the rest of the catalogue — purpose, triggers, the non-triggers
above naming `files` / `read_generated_file` / `fetch_url` / `memory_context`
by name, what it returns, and the fact that it reads the same index the turn's
context block already came from.
