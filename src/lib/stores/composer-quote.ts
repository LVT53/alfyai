// "Long-document comfort" (owner-approved mockup, 2026-09-06): a document's
// outline can be shown anywhere an attachment chip is shown — including
// under an already-sent user message (MessageBubble), far from the
// composer (MessageInput). Clicking an outline row there still needs to
// quote the section into the *current* composer, so this tiny store
// carries that one request across the component boundary without prop
// drilling MessageBubble -> MessageArea -> the page -> MessageInput.
//
// MessageInput.svelte is the sole consumer: it watches this store and,
// on each new (non-null) value, splices the quote into the textarea at the
// cursor and clears the store back to null. AttachmentOutline instances
// that live inside the composer's own pending-attachment list don't need
// this — they call their `onQuote` callback directly.
import { writable } from "svelte/store";

export interface ComposerQuoteRequest {
	text: string;
	// Monotonically distinct per request so requesting the exact same quote
	// text twice in a row is still observed as a fresh request.
	nonce: number;
}

export const composerQuoteRequest = writable<ComposerQuoteRequest | null>(null);

export function requestComposerQuote(text: string): void {
	composerQuoteRequest.set({ text, nonce: Date.now() + Math.random() });
}

export function clearComposerQuoteRequest(): void {
	composerQuoteRequest.set(null);
}
