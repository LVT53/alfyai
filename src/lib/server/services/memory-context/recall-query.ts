import { normalizeWhitespace } from "$lib/server/utils/text";
import { DEFAULT_CONVERSATION_TITLE } from "$lib/shared/conversation-title";

/**
 * The fixed search that keeps a core of the person's basics in every chat's
 * memory section, beside the search for what their message is about.
 */
export const CORE_MEMORY_QUERY =
	"Relevant user preferences, constraints and current context";

/** A message of at most this many words borrows the chat's title. */
const SHORT_MESSAGE_WORDS = 4;
const MAX_QUERY_CHARS = 500;
const HEAD_CHARS = 300;
const TAIL_CHARS = 200;

/**
 * What memory is searched with for the person's message: their own words,
 * whitespace folded. A short follow-up ("yes, do that") says little alone, so
 * it borrows the chat's title when the chat has one. A long message keeps its
 * start and end, cut by characters so none is split. Null when nothing is
 * left to search with.
 */
export function messageRecallQuery(
	message: string,
	title?: string | null,
): string | null {
	const words = normalizeWhitespace(message);
	const chatTitle = normalizeWhitespace(title);
	const titleCounts =
		chatTitle !== "" && chatTitle !== DEFAULT_CONVERSATION_TITLE;
	const wordCount = words === "" ? 0 : words.split(" ").length;
	const query =
		titleCounts && wordCount <= SHORT_MESSAGE_WORDS
			? words
				? `${chatTitle}: ${words}`
				: chatTitle
			: words;
	if (!query) return null;
	const chars = Array.from(query);
	if (chars.length <= MAX_QUERY_CHARS) return query;
	return `${chars.slice(0, HEAD_CHARS).join("")} ... ${chars.slice(-TAIL_CHARS).join("")}`;
}
