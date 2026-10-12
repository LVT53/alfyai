/**
 * The page a turn's context step read for the user before the model ran.
 *
 * When a message carries a link, the server reads that page itself and hands the
 * model a finished `fetch_url` exchange (normal-chat-context.ts). The model then
 * sees that page's links the same way it sees a `fetch_url` result, but the
 * exchange never goes through the tool set the turn builds afterwards, so the
 * turn's provenance (`turn.ts`) cannot observe it. The context step notes the
 * addresses here instead, per conversation, and the turn's provenance reads them
 * back. In memory only, short-lived, and bounded: a turn lasts minutes.
 */
import { provenanceKey } from "$lib/shared/url-provenance";

/** How long a note stays: longer than any turn, short enough to be forgotten. */
export const PREFETCH_NOTE_TTL_MS = 30 * 60 * 1000;
/** How many conversations' notes are kept at once; the oldest goes first. */
export const PREFETCH_NOTE_MAX_CONVERSATIONS = 256;
/** How many addresses one conversation's note keeps. */
export const PREFETCH_NOTE_MAX_KEYS = 5_000;

interface PrefetchNote {
	at: number;
	keys: Set<string>;
}

const notes = new Map<string, PrefetchNote>();

function noteKey(userId: string, conversationId: string): string {
	return `${userId}\u0000${conversationId}`;
}

/** Remembers addresses the model was handed with the turn's prefetched page. */
export function recordPrefetchAddresses(
	userId: string,
	conversationId: string,
	urls: Iterable<unknown>,
): void {
	if (!userId || !conversationId) return;
	const key = noteKey(userId, conversationId);
	const existing = notes.get(key);
	const note: PrefetchNote = existing ?? { at: Date.now(), keys: new Set() };
	for (const url of urls) {
		if (note.keys.size >= PREFETCH_NOTE_MAX_KEYS) break;
		const addressKey = provenanceKey(url);
		if (addressKey) note.keys.add(addressKey);
	}
	note.at = Date.now();
	// Newest last, so the first key is the oldest note.
	notes.delete(key);
	notes.set(key, note);
	while (notes.size > PREFETCH_NOTE_MAX_CONVERSATIONS) {
		const oldest = notes.keys().next();
		if (oldest.done) break;
		notes.delete(oldest.value);
	}
}

/** The addresses noted for this conversation's turn(s), or null when none (or all too old). */
export function prefetchAddressKeys(
	userId: string,
	conversationId: string,
): ReadonlySet<string> | null {
	const key = noteKey(userId, conversationId);
	const note = notes.get(key);
	if (!note) return null;
	if (Date.now() - note.at > PREFETCH_NOTE_TTL_MS) {
		notes.delete(key);
		return null;
	}
	return note.keys;
}

/** Forgets every note. Tests only. */
export function resetPrefetchNotesForTests(): void {
	notes.clear();
}
