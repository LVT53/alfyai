# Chat Components

## Mermaid

- `src/lib/components/chat/Mermaid.svelte` is the one place Mermaid is called, and a Mermaid source is untrusted (FX-E). A chat reply, a board's diagram block and the reader's own edit of one all draw through it, and what a model wrote in a reply may have come from a page it read. Measured against Mermaid 11.17, a source made the browser call an address before any gate ran (an `@{ img: … }` shape, which Mermaid decodes itself; an init directive or a front-matter `config:` that turns HTML labels on or carries `themeCSS`; a CSS `url()` in a class or state diagram's `classDef` or `style`, also spelt `\75rl(`; a sequence diagram's `properties A: {"icon": …}`) and showed a link in the picture (`click`, `link`, `links`). So the source goes through `shared/artifacts/mermaid-source.ts`'s `sanitizeMermaidSource` first, which removes those and keeps the rest of the diagram (it is one lazy chunk with Mermaid, not part of the chat route); Mermaid runs with `securityLevel: "strict"`, labels as SVG text and a `secure` list that keeps a directive from changing `htmlLabels`, `themeCSS` and the other keys that bring HTML, CSS or an address in; and the SVG goes through `sanitizeHtml({ svg: true })` (no `<a>`, an `href` only to `#id` or a `data:image/…`, CSS addresses scrubbed from every attribute and `<style>` with escapes undone). Do not call Mermaid from another component, do not keep a second list of what a diagram may not ask for (the board's door, `mermaidSourceProblem`, reads this one), and when a Mermaid upgrade or a new diagram feature takes an address, measure it first with a real request count (`tests/e2e/mermaid-hardening.spec.ts`) and extend the sanitizer and its tests together.

## What A Turn Made

- **What a turn made is drawn after what it said** (F16). A `create_artifact` / `edit_artifact` call reaches the browser only once the model has written the whole item, so its tool row and card always arrive late; in the rail above the text they pushed the words being read down by their own height (measured: 307 px on a Document with a checklist preview). `MessageBubble.svelte` takes those calls out of `thinkingSegmentsForDisplay` (`isArtifactToolCall`, `utils/tool-calls.ts`) and draws them in `message-deliverables` below the prose with the same `ToolActivityList` / `ToolActivityRow` / `ArtifactCard`; the rail keeps the steps. Do not put them back in the rail, and do not insert anything above the prose of a message that is streaming. `tests/e2e/artifact-card-arrival.spec.ts` holds it (the sentences' top edge does not move, frame by frame).

## Permission Cards

- A write to a connected account waits for the person, and the card is where they answer. `connections/write-card.ts` reads the stored row (the same operation and payload the executor runs on confirm, so the card cannot show one thing and do another) into `write.card`: what kind of action, the name of the thing, small lines for where and when, the text going out, and named risks. `write-card-view.ts` turns that into words in the reader's language. `write.preview`'s English sentences reach a person only for a write this version cannot read. The model is handed the preview and never the card, which is how text a tool redacted for a cloud model stays off it.
- The name leads, large, and a location goes in a much smaller line under it (owner, 2026-11-01): never a whole path, an internal action id, or a line a person cannot act on. The question sits above the name, the button says what the action does ("Send", not "Save it"), and red is for what the reader loses by it, not for what the write guard calls destructive: an edit Google can undo stays neutral.
- Asking and record are two shapes. `WriteConfirmCard.svelte` wears ArtifactCard's shell while it asks and folds into a `ToolActivityRow` once it is decided, so a settled write reads as what happened, with its details one press away (a failed or expired one opens by itself).
- `WriteConfirmSheet.svelte` is one sheet for the conversation, not one per card: a phone walks the pending writes oldest first. Do not raise a sheet from a card; three of them used to stack. It waits for the turn to end, backing out decides nothing, and each new question keeps its buttons off for a moment, so a double tap cannot answer the question behind it.
- A pending write gets its message id before the turn's terminal frame (`chat-turn/AGENTS.md`), and the page keeps only its latest read of them. A row with no message id is drawn on no message once the reply has stopped streaming.

## Composer And Message List

Important component boundaries:

- [`src/lib/components/chat/MessageInput.svelte`](MessageInput.svelte)
  - composer UI, attachments, local draft emission
  - not cross-page orchestration
- [`src/lib/components/chat/MessageArea.svelte`](MessageArea.svelte)
  - message list rendering and viewport behavior
  - generated-file reveal behavior at the bottom of the conversation scroll surface
