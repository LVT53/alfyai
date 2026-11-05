import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	prepareAskResumeTurn: vi.fn(),
	runChatStreamOrchestrator: vi.fn(),
	getCurrentMemoryResetGeneration: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mocks.getConfig,
}));

// What the resume is built from, and the turn it runs, are the retry route's
// seams too (its test mocks them the same way); the store and the claim are the
// real ones, over rows of the test database, wrapped so a test can see whether
// the route claimed or gave a claim back.
vi.mock("$lib/server/services/chat-turn/ask-resume", () => ({
	prepareAskResumeTurn: mocks.prepareAskResumeTurn,
}));

vi.mock("$lib/server/services/chat-turn/stream-orchestrator", () => ({
	runChatStreamOrchestrator: mocks.runChatStreamOrchestrator,
}));

vi.mock("$lib/server/services/memory-profile/reset-generation", () => ({
	getCurrentMemoryResetGeneration: mocks.getCurrentMemoryResetGeneration,
}));

vi.mock(
	"$lib/server/services/chat-turn/ask-questions",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("$lib/server/services/chat-turn/ask-questions")
			>();
		return {
			...actual,
			claimAskQuestion: vi.fn(actual.claimAskQuestion),
			releaseAskQuestion: vi.fn(actual.releaseAskQuestion),
		};
	},
);

import { db } from "$lib/server/db";
import { askQuestions } from "$lib/server/db/schema";
import { setDraining } from "$lib/server/services/chat-turn/active-streams";
import {
	claimAskQuestion,
	releaseAskQuestion,
} from "$lib/server/services/chat-turn/ask-questions";
import {
	removeSeededAskUser,
	type SeededAskQuestion,
	seedWaitingAskQuestion,
} from "$lib/server/services/chat-turn/ask-questions.test-helpers";
import type { AskAnswer } from "$lib/shared/ask-user";
import { POST } from "./+server";

type AnswerEvent = Parameters<typeof POST>[0];

const PICK_RED: AskAnswer = {
	kind: "answered",
	answers: [{ picked: [0], ownWords: null }],
};
const PICK_BLUE: AskAnswer = {
	kind: "answered",
	answers: [{ picked: [1], ownWords: null }],
};

const validBody = {
	answer: PICK_RED,
	streamId: "stream-1",
	model: "model1",
	reasoningDepth: "auto",
};

const ROOM_FOR_STREAMS = {
	concurrentStreamLimit: 100,
	perUserStreamLimit: 10,
	maxMessageLength: 10000,
};

/** A person at their stream limit, as the winner's running resume leaves them (the default limit is one). */
function atTheStreamLimit() {
	mocks.getConfig.mockReturnValue({
		...ROOM_FOR_STREAMS,
		perUserStreamLimit: 0,
	});
}

function makeEvent(
	seeded: Pick<SeededAskQuestion, "userId" | "conversationId" | "questionId">,
	body: unknown,
	options: { user?: { id: string }; signal?: AbortSignal } = {},
): AnswerEvent {
	const url = `http://localhost/api/conversations/${seeded.conversationId}/questions/${seeded.questionId}/answer`;
	return {
		request: new Request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
			signal: options.signal,
		}),
		locals: {
			user: {
				id: seeded.userId,
				email: "user@example.com",
				displayName: "User",
				uiLanguage: "hu",
				...options.user,
			},
		},
		params: {
			id: seeded.conversationId,
			questionId: seeded.questionId,
		},
		url: new URL(url),
		route: {
			id: "/api/conversations/[id]/questions/[questionId]/answer",
		},
	} as AnswerEvent;
}

function rowOf(questionId: string) {
	const row = db
		.select()
		.from(askQuestions)
		.where(eq(askQuestions.id, questionId))
		.get();
	if (!row) throw new Error(`no ask_questions row ${questionId}`);
	return row;
}

const answerOf = (questionId: string): unknown =>
	JSON.parse(rowOf(questionId).answerJson ?? "null");

/** What the preparation hands the orchestrator: the claim it was given goes with it, as the real one passes it on. */
function preparedFor(p: { claimed: { id: string }; claim: string }) {
	return {
		ok: true,
		value: {
			orchestratorInput: {
				turn: { conversationId: "conv", turnOrigin: "ask_resume" },
				upstreamMessage: "the person's message",
				isReconnect: false,
				pendingSkillInstructions: undefined,
				resume: { questionId: p.claimed.id, claim: p.claim },
			},
		},
	};
}

// The refusal `prepareAskResumeTurn` gives a reply that no longer has the shape a
// resume starts from.
const preparationRefusal = {
	ok: false,
	error: {
		status: 409,
		error: "The question can no longer be answered",
		code: "QUESTION_NOT_WAITING",
		responseShape: "json",
	},
};

describe("POST /api/conversations/[id]/questions/[questionId]/answer", () => {
	const seededUsers: string[] = [];
	let seeded: SeededAskQuestion;

	beforeEach(async () => {
		// Reset, not just clear: a one-time answer a test queued must not outlive it.
		vi.resetAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.getConfig.mockReturnValue(ROOM_FOR_STREAMS);
		mocks.getCurrentMemoryResetGeneration.mockResolvedValue(0);
		mocks.prepareAskResumeTurn.mockImplementation(async (p) => preparedFor(p));
		mocks.runChatStreamOrchestrator.mockImplementation(
			() => new Response("resume stream"),
		);
		seeded = await seedWaitingAskQuestion();
		seededUsers.push(seeded.userId);
	});

	afterEach(async () => {
		setDraining(false);
		vi.restoreAllMocks();
		for (const userId of seededUsers.splice(0)) {
			await removeSeededAskUser(userId);
		}
	});

	it("answers the capacity refusal and claims nothing while the server drains", async () => {
		setDraining(true);

		const response = await POST(makeEvent(seeded, validBody));

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("10");
		expect(await response.json()).toEqual({
			error: "Server at capacity. Please try again later.",
			code: "CAPACITY_EXCEEDED",
			reason: "draining",
			retryAfter: 10,
		});
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(rowOf(seeded.questionId)).toMatchObject({
			status: "waiting",
			answerJson: null,
		});
		expect(mocks.prepareAskResumeTurn).not.toHaveBeenCalled();
		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("answers 400 for a body that is not a JSON object, and claims nothing", async () => {
		for (const body of ["not json", "null", "[]", '"words"', "7"]) {
			const response = await POST(makeEvent(seeded, body));

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: "The request body must be a JSON object",
				code: "INVALID_BODY",
			});
		}
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(rowOf(seeded.questionId).status).toBe("waiting");
	});

	// Without a stream id the orchestrator skips the arbiter, the stream's
	// registration and the sweep of the chat's stale questions, so a resume could
	// run beside another turn.
	it("answers 400 without a stream id, and claims nothing", async () => {
		for (const streamId of [undefined, "", "   ", 7, null]) {
			const response = await POST(
				makeEvent(seeded, { ...validBody, streamId }),
			);

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: "streamId is required",
				code: "STREAM_ID_REQUIRED",
			});
		}
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(rowOf(seeded.questionId).status).toBe("waiting");
		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("answers 404 for a question the person does not have, and claims nothing", async () => {
		const stranger = await seedWaitingAskQuestion();
		seededUsers.push(stranger.userId);

		const unknownQuestion = await POST(
			makeEvent({ ...seeded, questionId: "no-such-question" }, validBody),
		);
		// the same ids, asked by someone whose chat it is not
		const otherPerson = await POST(
			makeEvent(seeded, validBody, { user: { id: stranger.userId } }),
		);

		for (const response of [unknownQuestion, otherPerson]) {
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				error: "Question not found",
				code: "QUESTION_NOT_FOUND",
			});
		}
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(rowOf(seeded.questionId).status).toBe("waiting");
	});

	it("answers 400 INVALID_ANSWER for an answer that does not fit, and claims nothing", async () => {
		const answersThatDoNotFit: unknown[] = [
			{ kind: "answered", answers: [{ picked: [5], ownWords: null }] }, // no such option
			{ kind: "answered", answers: [{ picked: [0, 1], ownWords: null }] }, // one question takes one pick
			{ kind: "answered", answers: [{ picked: [0], ownWords: "and this" }] }, // picks and words
			{ kind: "answered", answers: [] }, // one entry per question
			{ kind: "maybe" },
			"Red",
			undefined,
		];

		for (const answer of answersThatDoNotFit) {
			const response = await POST(makeEvent(seeded, { ...validBody, answer }));

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: "The answer does not fit the question",
				code: "INVALID_ANSWER",
			});
		}
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(rowOf(seeded.questionId)).toMatchObject({
			status: "waiting",
			answerJson: null,
		});
		expect(mocks.prepareAskResumeTurn).not.toHaveBeenCalled();
	});

	it("answers 409 for a question whose words cannot be read, and claims nothing", async () => {
		db.update(askQuestions)
			.set({ questionsJson: "not json" })
			.where(eq(askQuestions.id, seeded.questionId))
			.run();

		const response = await POST(makeEvent(seeded, validBody));

		// the claim's own answer for a row that shows no card
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "The question has already been answered",
			code: "QUESTION_ALREADY_ANSWERED",
		});
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("answers 409 QUESTION_ALREADY_ANSWERED to the second of two answers", async () => {
		const first = await POST(makeEvent(seeded, validBody));
		const second = await POST(
			makeEvent(seeded, {
				...validBody,
				answer: PICK_BLUE,
				streamId: "stream-2",
			}),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(409);
		expect(await second.json()).toEqual({
			error: "The question has already been answered",
			code: "QUESTION_ALREADY_ANSWERED",
		});
		// The row says `answering` under the first answer's live resume, so the second
		// answer is told so before the gate and never reaches the claim.
		expect(claimAskQuestion).toHaveBeenCalledTimes(1);
		expect(mocks.prepareAskResumeTurn).toHaveBeenCalledTimes(1);
		expect(mocks.runChatStreamOrchestrator).toHaveBeenCalledTimes(1);
		expect(answerOf(seeded.questionId)).toEqual(PICK_RED);
		expect(releaseAskQuestion).not.toHaveBeenCalled();
	});

	// The winner's resume holds the one stream a person may run, and the gate counts
	// it. An answer from another tab used to meet the gate first and be told to wait
	// for room, to be told in the end what the claim would have told it at once.
	it("answers 409 to a question that is already taken before it asks whether the person has room for a turn", async () => {
		const first = await POST(makeEvent(seeded, validBody));
		expect(first.status).toBe(200);
		const lateAnswer = () =>
			POST(
				makeEvent(seeded, {
					...validBody,
					answer: PICK_BLUE,
					streamId: "stream-2",
				}),
			);

		// at the person's stream limit (the first answer's resume is the stream)
		atTheStreamLimit();
		const atTheLimit = await lateAnswer();
		// and while the server drains for an update
		mocks.getConfig.mockReturnValue(ROOM_FOR_STREAMS);
		setDraining(true);
		const whileDraining = await lateAnswer();

		for (const response of [atTheLimit, whileDraining]) {
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				error: "The question has already been answered",
				code: "QUESTION_ALREADY_ANSWERED",
			});
		}
		// one claim, one resume, the first answer's
		expect(claimAskQuestion).toHaveBeenCalledTimes(1);
		expect(mocks.prepareAskResumeTurn).toHaveBeenCalledTimes(1);
		expect(mocks.runChatStreamOrchestrator).toHaveBeenCalledTimes(1);
		expect(answerOf(seeded.questionId)).toEqual(PICK_RED);
		expect(releaseAskQuestion).not.toHaveBeenCalled();
	});

	it("answers 409 to a question that was answered or closed, whatever room the person has for a turn", async () => {
		atTheStreamLimit();
		for (const status of ["answered", "closed"] as const) {
			db.update(askQuestions)
				.set({ status, answerJson: JSON.stringify(PICK_RED) })
				.where(eq(askQuestions.id, seeded.questionId))
				.run();

			const response = await POST(makeEvent(seeded, validBody));

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				error: "The question has already been answered",
				code: "QUESTION_ALREADY_ANSWERED",
			});
		}
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("still turns a question that is not taken away at the gate when the person has no room for a turn", async () => {
		atTheStreamLimit();

		const response = await POST(makeEvent(seeded, validBody));

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "CAPACITY_EXCEEDED",
			reason: "user_limit",
		});
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(rowOf(seeded.questionId)).toMatchObject({
			status: "waiting",
			answerJson: null,
		});
	});

	it("takes one answer and runs one resume when two devices answer at the same moment", async () => {
		const [first, second] = await Promise.all([
			POST(makeEvent(seeded, validBody)),
			POST(
				makeEvent(seeded, {
					...validBody,
					answer: PICK_BLUE,
					streamId: "stream-2",
				}),
			),
		]);

		expect([first.status, second.status].sort()).toEqual([200, 409]);
		const won = first.status === 200;
		expect(claimAskQuestion).toHaveBeenCalledTimes(2);
		expect(mocks.prepareAskResumeTurn).toHaveBeenCalledTimes(1);
		expect(mocks.runChatStreamOrchestrator).toHaveBeenCalledTimes(1);
		expect(answerOf(seeded.questionId)).toEqual(won ? PICK_RED : PICK_BLUE);
		expect(releaseAskQuestion).not.toHaveBeenCalled();
	});

	// A restart leaves `answering` rows with no resume behind them. The route must
	// not refuse on the row's status alone: a row that says answering while no
	// resume of this process runs it is not taken, and the claim is what releases it.
	it("lets a question a restart left answering reach the claim", async () => {
		db.update(askQuestions)
			.set({ status: "answering", answerJson: JSON.stringify(PICK_BLUE) })
			.where(eq(askQuestions.id, seeded.questionId))
			.run();

		const response = await POST(makeEvent(seeded, validBody));

		expect(response.status).toBe(200);
		expect(claimAskQuestion).toHaveBeenCalledTimes(1);
		expect(answerOf(seeded.questionId)).toEqual(PICK_RED);
		expect(mocks.runChatStreamOrchestrator).toHaveBeenCalledTimes(1);
	});

	it("sends a question a restart left answering on to the gate, as it always went", async () => {
		db.update(askQuestions)
			.set({ status: "answering", answerJson: JSON.stringify(PICK_BLUE) })
			.where(eq(askQuestions.id, seeded.questionId))
			.run();
		atTheStreamLimit();

		const response = await POST(makeEvent(seeded, validBody));

		// not taken, so not answered 409: it meets the gate, and the row is left as it was
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ reason: "user_limit" });
		expect(claimAskQuestion).not.toHaveBeenCalled();
		expect(rowOf(seeded.questionId).status).toBe("answering");
		expect(answerOf(seeded.questionId)).toEqual(PICK_BLUE);
	});

	it("gives the claim back when the resume cannot be prepared", async () => {
		mocks.prepareAskResumeTurn.mockResolvedValueOnce(preparationRefusal);

		const response = await POST(makeEvent(seeded, validBody));

		// answered as the retry route answers its refusals: a code, no errorKey. The
		// claim was given back, which is not the code of a claim that was lost
		// (QUESTION_ALREADY_ANSWERED): the page tells the two apart by it.
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "The question can no longer be answered",
			code: "QUESTION_NOT_WAITING",
		});
		const { claim } = mocks.prepareAskResumeTurn.mock.calls[0][0];
		expect(releaseAskQuestion).toHaveBeenCalledTimes(1);
		expect(releaseAskQuestion).toHaveBeenCalledWith({
			userId: seeded.userId,
			questionId: seeded.questionId,
			claim,
		});
		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
		// back to waiting with the answer on it, so its card comes back with it
		expect(rowOf(seeded.questionId).status).toBe("waiting");
		expect(answerOf(seeded.questionId)).toEqual(PICK_RED);
	});

	it("answers a refusal of the preparation that is stream-shaped as the retry route does, and gives the claim back", async () => {
		mocks.prepareAskResumeTurn.mockResolvedValueOnce({
			ok: false,
			error: {
				status: 422,
				error: "Attachment is not ready",
				code: "attachment_not_ready",
				attachmentIds: ["attachment-1"],
				responseShape: "stream-json",
			},
		});

		const response = await POST(makeEvent(seeded, validBody));

		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			status: 422,
			error: "Attachment is not ready",
			code: "attachment_not_ready",
			attachmentIds: ["attachment-1"],
		});
		expect(releaseAskQuestion).toHaveBeenCalledTimes(1);
		expect(rowOf(seeded.questionId).status).toBe("waiting");
		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("gives the claim back when the preparation throws", async () => {
		mocks.prepareAskResumeTurn.mockRejectedValueOnce(
			new Error("the stored turn could not be read"),
		);

		const response = await POST(makeEvent(seeded, validBody));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "The answer could not be carried on. Try again.",
			code: "ANSWER_FAILED",
		});
		expect(releaseAskQuestion).toHaveBeenCalledTimes(1);
		expect(rowOf(seeded.questionId).status).toBe("waiting");
		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalled();
	});

	it("gives the claim back when the orchestrator throws before it streams", async () => {
		mocks.runChatStreamOrchestrator.mockImplementationOnce(() => {
			throw new Error("the connector gate could not be built");
		});

		const response = await POST(makeEvent(seeded, validBody));

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "The answer could not be carried on. Try again.",
			code: "ANSWER_FAILED",
		});
		const { claim } = mocks.prepareAskResumeTurn.mock.calls[0][0];
		expect(releaseAskQuestion).toHaveBeenCalledWith({
			userId: seeded.userId,
			questionId: seeded.questionId,
			claim,
		});
		expect(rowOf(seeded.questionId).status).toBe("waiting");
		expect(answerOf(seeded.questionId)).toEqual(PICK_RED);
	});

	it("answers the error itself when giving the claim back fails too", async () => {
		mocks.runChatStreamOrchestrator.mockImplementationOnce(() => {
			throw new Error("the connector gate could not be built");
		});
		vi.mocked(releaseAskQuestion).mockRejectedValueOnce(
			new Error("the store is down"),
		);

		const response = await POST(makeEvent(seeded, validBody));

		expect(response.status).toBe(500);
		expect((await response.json()).code).toBe("ANSWER_FAILED");
		expect(console.warn).toHaveBeenCalled();
	});

	it("streams the resume of a good answer", async () => {
		const controller = new AbortController();
		const event = makeEvent(
			seeded,
			{
				// the words are trimmed and nothing beyond the shape is kept
				answer: {
					kind: "answered",
					answers: [{ picked: [], ownWords: "  Teal, please  ", extra: "x" }],
				},
				streamId: "stream-1",
				model: "model1",
				reasoningDepth: "deep",
				personalityProfileId: "personality-1",
				enabledConnectionCapabilities: ["files.read"],
				activeDocumentArtifactId: "document-1",
			},
			{ signal: controller.signal },
		);

		const response = await POST(event);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("resume stream");
		const tidyAnswer: AskAnswer = {
			kind: "answered",
			answers: [{ picked: [], ownWords: "Teal, please" }],
		};
		// the claim is made with the answer as it was read, not as it was sent
		expect(claimAskQuestion).toHaveBeenCalledWith({
			userId: seeded.userId,
			conversationId: seeded.conversationId,
			questionId: seeded.questionId,
			answer: tidyAnswer,
		});
		expect(answerOf(seeded.questionId)).toEqual(tidyAnswer);

		expect(mocks.prepareAskResumeTurn).toHaveBeenCalledWith({
			userId: seeded.userId,
			runtimeConfig: mocks.getConfig(),
			conversationId: seeded.conversationId,
			claimed: expect.objectContaining({
				id: seeded.questionId,
				status: "answering",
			}),
			claim: expect.any(String),
			body: expect.objectContaining({
				streamId: "stream-1",
				model: "model1",
				reasoningDepth: "deep",
				personalityProfileId: "personality-1",
				enabledConnectionCapabilities: ["files.read"],
				activeDocumentArtifactId: "document-1",
			}),
		});

		// the prepared input goes to the orchestrator as it is: no appendix, no
		// deferred preparation of its own
		const { orchestratorInput } = (
			await mocks.prepareAskResumeTurn.mock.results[0].value
		).value;
		expect(mocks.runChatStreamOrchestrator).toHaveBeenCalledTimes(1);
		const options = mocks.runChatStreamOrchestrator.mock.calls[0][0];
		expect(options).toEqual({
			user: {
				id: seeded.userId,
				displayName: "User",
				email: "user@example.com",
				uiLanguage: "hu",
			},
			...orchestratorInput,
			downstreamAbortSignal: expect.any(AbortSignal),
			requestStartTime: expect.any(Number),
			startedResetGeneration: 0,
		});
		expect(options.downstreamAbortSignal).toBe(event.request.signal);
		expect(options).not.toHaveProperty("systemPromptAppendix");
		expect(options).not.toHaveProperty("prepareTurn");
		expect(options.resume).toBe(orchestratorInput.resume);
		expect(mocks.getCurrentMemoryResetGeneration).toHaveBeenCalledWith(
			seeded.userId,
		);

		// From the moment the stream exists the orchestrator holds the claim, so the
		// route gives nothing back. The claim the preparation was given is the live
		// one: the holder, here the test, can give it back.
		expect(releaseAskQuestion).not.toHaveBeenCalled();
		expect(rowOf(seeded.questionId).status).toBe("answering");
		const holderGivesItBack = await releaseAskQuestion({
			userId: seeded.userId,
			questionId: seeded.questionId,
			claim: orchestratorInput.resume.claim,
		});
		expect(holderGivesItBack).toBe(true);
		expect(rowOf(seeded.questionId).status).toBe("waiting");
	});
});
