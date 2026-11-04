import type { AskQuestionDto } from "$lib/shared/ask-user";
import { type FetchLike, requestJson } from "./http";

// "Ask me first": the questions Alfy asked in a chat. The card and its folded
// line are drawn from these rows, never from the stream, so a reload, another
// device and a restart all show the same card. Mirrors connection-writes.ts's
// requestJson pattern. The answer itself is not here: it is a turn, and goes
// through the stream transport (`questionAnswer` in `$lib/services/streaming`).

export async function fetchConversationQuestions(
	conversationId: string,
	fetchImpl?: FetchLike,
): Promise<AskQuestionDto[]> {
	const data = await requestJson<{ questions?: AskQuestionDto[] }>(
		`/api/conversations/${encodeURIComponent(conversationId)}/questions`,
		undefined,
		"Failed to load questions",
		fetchImpl,
	);
	return Array.isArray(data.questions) ? data.questions : [];
}
