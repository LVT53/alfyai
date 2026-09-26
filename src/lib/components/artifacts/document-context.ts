/**
 * The panel's own conversation id, made reachable to a body without widening
 * `ArtifactBodyProps` (Slice 0's fixed flat-prop contract — Review Focus #10
 * warns explicitly against drifting it, and every later type's body depends
 * on it staying exactly `{ artifactId, kind, title, body, onDirtyChange?,
 * onBodyChange? }`).
 *
 * A Document's own `fetchArtifact`/`saveArtifactBody` calls need the serving
 * conversation id to widen the ownership scope by exactly one conversation —
 * otherwise an incognito conversation's own Document 404s even for its
 * creator, opened from inside that same chat (the same class of bug Slice 0's
 * review fixed for the artifact detail route itself). `DocumentWorkspace.svelte`
 * provides it via Svelte context (a getter, not a plain value, so the body
 * always reads the CURRENT active document's conversation id rather than a
 * snapshot from whenever the context was set) instead of a second prop
 * channel.
 */
export const DOCUMENT_CONVERSATION_ID_CONTEXT = Symbol(
	"document-conversation-id",
);

export type DocumentConversationIdGetter = () => string | null;
