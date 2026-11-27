import { normalizeWhitespace } from "$lib/server/utils/text";
import { isUntitledConversationTitle } from "$lib/shared/conversation-title";
import { foldForSearch } from "$lib/shared/workspace-search-text";
import { tokenizeQuery } from "./query";

/**
 * The fixed search that keeps a core of the person's basics in every chat's
 * memory section, beside the search for what their message is about.
 */
export const CORE_MEMORY_QUERY =
	"Relevant user preferences, constraints and current context";

/** A message of at most this many words borrows the chat's title. */
const SHORT_MESSAGE_WORDS = 4;
/** A query of more code points than this keeps only its start and its end. */
const MAX_QUERY_CHARS = 500;
const HEAD_CHARS = 300;
const TAIL_CHARS = 200;
/** How far either side of a cut the segmenter reads to find the character there. */
const CUT_NEIGHBOURHOOD = 64;

const characters = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * The span of the character that holds the code unit at `at`: what a reader
 * sees as one, such as a joined emoji or a letter with its accent written
 * apart. Read from a window around `at`, so a very long text costs no more
 * than a short one.
 */
function characterAt(text: string, at: number): { start: number; end: number } {
	const from = Math.max(0, at - CUT_NEIGHBOURHOOD);
	const found = characters
		.segment(text.slice(from, at + CUT_NEIGHBOURHOOD))
		.containing(at - from);
	// `at` is inside the window, so a character is always found; the fallback
	// reads the cut as a boundary rather than failing a turn.
	return found
		? {
				start: from + found.index,
				end: from + found.index + found.segment.length,
			}
		: { start: at, end: at };
}

/**
 * A query of more than `MAX_QUERY_CHARS` code points keeps its first
 * `HEAD_CHARS` and its last `TAIL_CHARS`. A character a cut would split is
 * left out of its piece, so none is cut in two. Only the start, the end and
 * the neighbourhood of each cut are read.
 */
function clipQuery(query: string): string {
	// A code point takes at least one code unit: a short text needs no counting.
	if (query.length <= MAX_QUERY_CHARS) return query;
	let headEnd = 0;
	let points = 0;
	for (let at = 0; at < query.length && points <= MAX_QUERY_CHARS; points++) {
		if (points === HEAD_CHARS) headEnd = at;
		at += (query.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
	}
	if (points <= MAX_QUERY_CHARS) return query;
	let tailStart = query.length;
	for (let kept = 0; kept < TAIL_CHARS; kept++)
		tailStart -= (query.codePointAt(tailStart - 2) ?? 0) > 0xffff ? 2 : 1;
	const head = characterAt(query, headEnd);
	const tail = characterAt(query, tailStart);
	return `${query.slice(0, head.start)} ... ${query.slice(tail.start === tailStart ? tailStart : tail.end)}`;
}

/**
 * What memory is searched with for the person's message: their own words,
 * whitespace folded. A short follow-up ("yes, do that") says little alone, so
 * it borrows the chat's title when the chat has one. A long message keeps its
 * first 300 and last 200 code points, and a character the cut would split (a
 * joined emoji, a letter with its accent written apart) stays out of that
 * piece. Null when nothing is left to search with.
 */
export function messageRecallQuery(
	message: string,
	title?: string | null,
): string | null {
	const words = normalizeWhitespace(message);
	const chatTitle = normalizeWhitespace(title);
	const titleCounts = !isUntitledConversationTitle(chatTitle);
	const wordCount = words === "" ? 0 : words.split(" ").length;
	const query =
		titleCounts && wordCount <= SHORT_MESSAGE_WORDS
			? words
				? `${chatTitle}: ${words}`
				: chatTitle
			: words;
	return query ? clipQuery(query) : null;
}

// The history tokenizer already removes question and function words. These
// remaining words ask for the profile itself or point back to the prior turn;
// on their own they give the message search no topic to lead with.
const PROFILE_QUERY_WORDS = new Set(
	[
		"what why whom whose everything anything something nothing else more again overall generally general summary summarize summarise overview profile memory memories personal information details facts life myself person background identity story describe brief briefly so far all yourself recall remind learned learnt told mentioned shared previously already know knows any other about one ones first second third then now give show provide quick past previous chat chats conversation conversations discussed recently right yes ok okay sure",
		"mit miert mire mik milyen ki kik rolunk rolam vele velem kapcsolatban kapcsolatosan magam magamrol szemelyes eletem eletemrol szemelyemrol tudod tudsz ossze foglalj foglald osszefoglalot osszefoglalnad emlekeid emlek emlekek emlekszel emlekezel emlekeztess altalaban altalanossagban mindent mindazt eddig meg mast is mondani meselj tobbet helyzet masodik harmadik elso azzal errol arrol beszelgettunk beszeltunk amit amire neked es elmondani ossze tudnad foglalni jegyeztel meg rendben korabban beszelgetesek beszelgeteseinkbol",
	]
		.join(" ")
		.split(" "),
);

const RECALL_QUESTION_START =
	/^(?:(?:hey|please|hi|kerlek|szia)[\s,]+)*(?:what|where|which|who|when|why|how|whose|am|is|are|was|were|have|has|did|do|does|could|can|would|should|will|remind me|tell me|summari[sz]e|mi|mit|mire|mik|milyen|melyik|melyek|miert|mikor|merre|hogyan|hogy|hol|hova|hany|mennyi|ki|kik|kivel|emlekszel|tudod|meselj|mondd|mondj|emlekeztess)\b/u;

/** Use the original message: a borrowed conversation title does not turn a
 * generic follow-up into a new question about a specific subject. */
export function shouldPrioritizeRecallMatches(rawMessage: string): boolean {
	const message = normalizeWhitespace(rawMessage);
	if (!message || message.length > MAX_QUERY_CHARS) return false;
	const folded = foldForSearch(message);
	if (!RECALL_QUESTION_START.test(folded) && !folded.endsWith("?"))
		return false;
	return tokenizeQuery(message).some(
		(term) => !PROFILE_QUERY_WORDS.has(foldForSearch(term)),
	);
}
