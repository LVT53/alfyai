# Artifacts are a family of five types behind one card and one panel

Accepted (2026-09-24). Design: [`docs/plans/claude-at-home-2-artifacts-spec.md`](../plans/claude-at-home-2-artifacts-spec.md).
Evidence: [`docs/plans/claude-at-home-2-prototype-findings.md`](../plans/claude-at-home-2-prototype-findings.md).

AlfyAI had two kinds of AI-made thing: a message, and a rendered file. The owner's "Claude at home" goal
asked for what Claude calls artifacts — things that live beside the conversation, keep their own state, and
that the user and Alfy both change over time. Three throwaway prototypes (App generation, Document
editing, Canvas on Svelte Flow) found all of it feasible, so the decision is a **family of five types** —
Document, App, Canvas, Slides, File — behind **one card and one panel**, rather than the single "Living
Document" type [ADR-0065](0065-living-documents-are-edited-in-place.md) originally described.

The load-bearing parts (the spec holds the detail):

- One card in the conversation and one panel beside it serve every type; the chat's existing block
  components (chart, checklist, map, CSV table, image, live web) are reused **inside** a Canvas or Document
  instead of being reimplemented.
- **Single user, permanently.** No sharing, no permissions, no real-time co-editing. This removes the
  hardest part of Claude's equivalent and is a decision, not a deferral.
- Editing in place stands as ADR-0065 recorded it, widened from documents to all types. Block ids persist
  with the document; comments are one shared layer across types; the model's edits are block-addressed
  patches carrying the hash it last read, **refused** when the user changed that block since.
- Apps are generated **with thinking off**, and their facts are verified before the card appears; the App
  contract forbids agentic behaviour. Both are measured failures from the prototype, not preferences.
- Artifacts are reachable from the chat header (a count button that opens the panel on its list), the
  Knowledge Base Documents tab, a project's bundle, and Workspace Search. Each type shows a three-slide
  tour the first time it is opened.
- File stays exactly what `produce_file` makes today; it becomes the File type rather than a separate card.

## Considered options

- **One "living document" type only** — rejected: the owner's review of the mockups made clear the ambition
  was the whole artifact family, and Canvas, Slides and Apps are not documents.
- **A new artifact store beside `artifacts`** — rejected: the existing backbone plus three small tables
  (versions, comments, per-app key-value storage) carries it without a parallel document subsystem.
- **Sharing and collaboration** — rejected outright by the owner.

## Consequences

- **ADR-0065 is amended** (not superseded): Living Documents are the **Document** type of the artifact
  family, and its editing-in-place rules apply to artifacts generally.
- **ADR-0064's item 2 is widened** from living documents to the artifact family.
- The Knowledge Library rules in AGENTS.md keep applying to uploaded and generated files. Artifacts remain
  the one in-place-edited kind, as ADR-0065 recorded.
- **A model-contract evaluation harness becomes a gate.** Only the App contract has been tested against the
  real model; document patches, canvas diffs and slides were canned in the prototypes. If the model proves
  weak at one of them, the design for that type changes (Alfy proposes, the user approves) rather than the
  evidence being argued away.
- **"Artifact" is never shown in the UI.** The interface says Document, App, Canvas, Slides — Hungarian:
  Dokumentum, Alkalmazás, Tábla, Diasor. The word stays an engineering term.
