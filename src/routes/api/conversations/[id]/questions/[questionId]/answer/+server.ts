import { createJsonResponse } from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	claimAskQuestion,
	createPreparationErrorResponse,
	getAskQuestion,
	isAskQuestionTaken,
	prepareAskResumeTurn,
	refuseTurnWhenOverCapacity,
	releaseAskQuestion,
	runChatStreamOrchestrator,
} from "$lib/server/services/chat-turn";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile/reset-generation";
import {
	type AskQuestion,
	checkAskAnswer,
	parseAskQuestions,
} from "$lib/shared/ask-user";
import type { RequestHandler } from "./$types";

function refusal(status: number, error: string, code: string): Response {
	return createJsonResponse({ error, code }, status);
}

const questionAlreadyAnswered = () =>
	refusal(
		409,
		"The question has already been answered",
		"QUESTION_ALREADY_ANSWERED",
	);

/** The body as an object; null for anything else, which is not a request this route reads. */
async function readJsonObject(
	request: Request,
): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = await request.json();
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** The questions a stored row holds; null when they cannot be read, as the list cannot read them either. */
function readQuestions(questionsJson: string): AskQuestion[] | null {
	try {
		return parseAskQuestions(JSON.parse(questionsJson));
	} catch {
		return null;
	}
}

// POST /api/conversations/[id]/questions/[questionId]/answer: the person's answer
// to a question Alfy asked ("Ask me first"). It claims the question, so one answer
// wins across devices and double taps, and streams the resume: the same reply,
// carried on from the answer. Refusals are JSON with a `code` that the page
// localizes by.
//
// The first thing it does is tell an answer that has nothing left to win so: a
// question that is already taken (answered, closed, or answering under a resume this
// process runs) answers 409 before anything else, the stream gate included. The
// winner's resume holds the one stream a person may run, so an answer from another
// tab that met the gate first would be told to wait for room to lose a claim it can
// never win. The check only answers early what the claim would answer anyway, and it
// never goes by the row's status alone: a restart leaves `answering` rows that no
// resume stands behind, and those go on to the gate and the claim (`isAskQuestionTaken`
// reads the store's own record of the resumes that run).
//
// Every other check that can be made without the claim is made next, so the claim is
// the last step before the preparation. A won claim must end in one release or one
// settle: from the claim until the orchestrator has returned its stream, every way
// out here gives it back with its token (the preparation's refusal and its throw, the
// orchestrator's throw); from then on the orchestrator holds it.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const { id: conversationId, questionId } = event.params;
	const requestStartTime = Date.now();

	if (
		await isAskQuestionTaken({
			userId: user.id,
			conversationId,
			questionId,
		})
	) {
		return questionAlreadyAnswered();
	}

	// An answer starts a turn, so it meets the gate a new message meets.
	const refused = refuseTurnWhenOverCapacity(user.id, "CHAT_ASK_ANSWER");
	if (refused) return refused;
	const runtimeConfig = getConfig();

	const body = await readJsonObject(event.request);
	if (body === null) {
		return refusal(
			400,
			"The request body must be a JSON object",
			"INVALID_BODY",
		);
	}
	// Without a stream id the orchestrator skips the arbiter, the stream's
	// registration and the sweep of the chat's stale questions, so the resume could
	// run beside another turn.
	if (typeof body.streamId !== "string" || body.streamId.trim() === "") {
		return refusal(400, "streamId is required", "STREAM_ID_REQUIRED");
	}

	// Never a refusal on the row's own status alone: a restart leaves `answering` rows
	// that nothing stands behind, and only the claim, and the store's record of the
	// resumes that run (which `isAskQuestionTaken` read at the top), can tell those
	// from an answer that is on its way.
	const question = await getAskQuestion({
		userId: user.id,
		conversationId,
		questionId,
	});
	if (!question) {
		return refusal(404, "Question not found", "QUESTION_NOT_FOUND");
	}
	const questions = readQuestions(question.questionsJson);
	// A question that cannot be read shows no card; the claim answers that as lost.
	if (questions === null) return questionAlreadyAnswered();
	const checked = checkAskAnswer(questions, body.answer);
	if (!checked.ok) {
		return refusal(
			400,
			"The answer does not fit the question",
			"INVALID_ANSWER",
		);
	}

	const startedResetGeneration = await getCurrentMemoryResetGeneration(user.id);

	// The claim is made with the answer as `checkAskAnswer` read it.
	const claimed = await claimAskQuestion({
		userId: user.id,
		conversationId,
		questionId,
		answer: checked.answer,
	});
	if (!claimed.ok) {
		return claimed.reason === "not_found"
			? refusal(404, "Question not found", "QUESTION_NOT_FOUND")
			: questionAlreadyAnswered();
	}
	const { row, claim } = claimed;

	const giveTheClaimBack = async (): Promise<void> => {
		try {
			await releaseAskQuestion({ userId: user.id, questionId, claim });
		} catch (error) {
			// A store that is down must not hide how the answer ended.
			console.warn("[CHAT_ASK_ANSWER] Could not give a question back", {
				conversationId,
				questionId,
				error,
			});
		}
	};

	try {
		const prepared = await prepareAskResumeTurn({
			userId: user.id,
			runtimeConfig,
			conversationId,
			claimed: row,
			claim,
			body,
		});
		if (!prepared.ok) {
			await giveTheClaimBack();
			// answered as the retry route answers its own refusals
			return createPreparationErrorResponse(prepared.error);
		}
		return runChatStreamOrchestrator({
			user: {
				id: user.id,
				displayName: user.displayName,
				email: user.email,
				uiLanguage: user.uiLanguage,
			},
			...prepared.value.orchestratorInput,
			downstreamAbortSignal: event.request.signal,
			requestStartTime,
			startedResetGeneration,
		});
	} catch (error) {
		await giveTheClaimBack();
		console.error("[CHAT_ASK_ANSWER] The answer could not be carried on", {
			conversationId,
			questionId,
			error,
		});
		return refusal(
			500,
			"The answer could not be carried on. Try again.",
			"ANSWER_FAILED",
		);
	}
};
