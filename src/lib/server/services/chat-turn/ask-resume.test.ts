import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	NOW,
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";
import type { AskAnswer, AskQuestion } from "$lib/shared/ask-user";

// The reply's rows and its questions are real rows in an in-memory database, so
// that the walk from the asking row back to the person's message, and the words
// of the answers of the whole reply, are read from the store as it stores them.
// What the turn is built from (the request parser and the preflight, the skills,
// the pictures, the uploads) is not this module's: it is mocked at the seams the
// retry's tests mock, which is where the resume rebuilds the person's message.
let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const {
	capturedSyntheticBodies,
	mockHasLocalDistillEnabled,
	mockKeepReadable,
} = vi.hoisted(() => ({
	capturedSyntheticBodies: [] as Array<Record<string, unknown>>,
	mockHasLocalDistillEnabled: vi.fn(),
	mockKeepReadable: vi.fn(),
}));

vi.mock("$lib/server/services/connections/locality", () => ({
	hasLocalDistillEnabled: mockHasLocalDistillEnabled,
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(async () => ({ id: "conv-1" })),
}));
// The resume closes a question it can never carry on by rewriting the ask call of
// the row that asked (`updateAssistantToolCallResult`), and reads a reply's
// segments by their links (`walkReplySegments`), so both are the real ones, over
// the same rows; everything else of the messages service is not this module's.
vi.mock("$lib/server/services/messages", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/messages")>();
	return {
		deleteMessages: vi.fn(async () => undefined),
		updateAssistantToolCallResult: actual.updateAssistantToolCallResult,
		walkReplySegments: actual.walkReplySegments,
	};
});
vi.mock("$lib/server/services/knowledge", () => ({
	listMessageAttachments: vi.fn(async () => new Map()),
}));
vi.mock("$lib/server/services/conversation-forks", () => ({
	listChildForksBySourceMessages: vi.fn(async () => ({})),
}));
vi.mock("$lib/server/services/message-sequences", () => ({
	repairConversationMessageSequences: vi.fn(),
}));
vi.mock("$lib/server/services/images/turn-pictures", () => ({
	keepReadableRecordedPictures: mockKeepReadable,
}));
vi.mock("./retry-cleanup", () => ({ cleanupFailedTurn: vi.fn() }));

vi.mock("./request", async () => {
	const actual = await vi.importActual<typeof import("./request")>("./request");
	return {
		parsePendingSkill: actual.parsePendingSkill,
		parseChatTurnRequest: vi.fn(async (request: Request) => {
			const body = await request.json();
			capturedSyntheticBodies.push(body);
			return {
				ok: true,
				value: {
					conversationId: body.conversationId,
					normalizedMessage: body.message,
					streamId: body.streamId,
					modelDisplayName: "Model 1",
					modelId: body.model ?? "model1",
					attachmentIds: Array.isArray(body.attachmentIds)
						? body.attachmentIds
						: [],
					linkedSources: [],
					pendingSkill: body.pendingSkill ?? null,
					reasoningDepth: body.reasoningDepth ?? "auto",
					thinkingMode: "auto",
					forceWebSearch: body.forceWebSearch === true,
					enabledConnectionCapabilities: body.enabledConnectionCapabilities,
					activeDocumentArtifactId: body.activeDocumentArtifactId,
					personalityProfileId: body.personalityProfileId,
					skipPersistUserMessage: body.skipPersistUserMessage === true,
					turnOrigin: "send",
				},
			};
		}),
	};
});

vi.mock("./preflight", () => ({
	preflightChatTurn: vi.fn(
		async ({ request }: { request: { reasoningDepth: string } }) => ({
			ok: true,
			value: {
				...request,
				appliedSkill: null,
				depthMetadata: {
					requested: request.reasoningDepth,
					appliedProfile: "standard",
					fallback: false,
				},
			},
		}),
	),
	resolveAppliedSkill: vi.fn(async () => ({
		ok: false,
		error: { status: 409, error: "gone", code: "pending_skill_unavailable" },
	})),
}));

import { listMessageAttachments } from "$lib/server/services/knowledge";
import {
	claimAskQuestion,
	listConversationAskQuestions,
	recordAskQuestion,
	releaseAskQuestion,
	settleAskQuestion,
	stampAskQuestion,
} from "./ask-questions";
import { findWaitingQuestionRefusal, prepareAskResumeTurn } from "./ask-resume";
import { preflightChatTurn } from "./preflight";

const USER = "user-1";
const CHAT = "conv-1";

const config = { maxMessageLength: 10_000 } as RuntimeConfig;

const COLOUR: AskQuestion[] = [
	{
		question: "Which colour?",
		options: [{ label: "White", recommended: true }, { label: "Grey" }],
	},
];
const FINISH: AskQuestion[] = [
	{
		question: "Which finish?",
		options: [{ label: "Matt", recommended: true }, { label: "Gloss" }],
	},
	{
		question: "Anything else we should know?",
		options: [{ label: "No" }, { label: "Yes", recommended: true }],
	},
];

// Own words with an address in them: the person typed it, so it is theirs.
const OWN_WORDS_1 = "Warm and quiet, see https://example.com/palette";
const OWN_WORDS_2 = "Satin, please";

function toolCall(
	callId: string,
	name: string,
	extra: Record<string, unknown> = {},
) {
	return {
		type: "tool_call",
		callId,
		name,
		input: {},
		status: "done",
		...extra,
	};
}

const FETCH_CALL = toolCall("pre-1", "fetch_url", {
	input: { urls: ["https://example.com/a"] },
	outputSummary: "Fetched 1 page.",
	candidates: [
		{
			id: "src-a",
			title: "Page A",
			url: "https://example.com/a",
			sourceType: "web",
		},
	],
});
const SEARCH_CALL = toolCall("call-search", "research_web", {
	input: { query: "wall colours" },
	outputSummary: "Found 1 source.",
	candidates: [
		{
			id: "src-b",
			title: "Page B",
			url: "https://example.com/b",
			sourceType: "web",
		},
	],
});
const ASK_CALL_1 = toolCall("call-ask-1", "ask_user", {
	input: { questions: COLOUR },
	outputSummary: "Asked the user; the reply paused for the answer.",
	metadata: { paused: true, questionId: "question-1" },
});
const CALENDAR_CALL = toolCall("call-cal", "calendar", {
	input: { action: "list_events" },
	outputSummary: "Found 1 event.",
});
const ASK_CALL_2 = toolCall("call-ask-2", "ask_user", {
	input: { questions: FINISH },
	outputSummary: "Asked the user; the reply paused for the answer.",
	metadata: { paused: true, questionId: "question-2" },
});

const PAUSE = { status: "waiting_for_user", note: "Asked. The reply pauses." };

function step(
	text: string | null,
	callId: string,
	toolName: string,
	input: unknown,
	result: unknown,
): ModelMessage[] {
	return [
		{
			role: "assistant",
			content: [
				...(text ? [{ type: "text" as const, text }] : []),
				{
					type: "tool-call",
					toolCallId: callId,
					toolName,
					input: input as never,
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: callId,
					toolName,
					output: { type: "json", value: result as never },
				},
			],
		},
	];
}

const FETCHED = step(
	null,
	"pre-1",
	"fetch_url",
	{ urls: ["https://example.com/a"] },
	{ page: "the whole page" },
);
const SEARCHED = step(
	"Let me look first.",
	"call-search",
	"research_web",
	{ query: "wall colours" },
	{ sources: ["the whole result"] },
);
const CALENDAR_READ = step(
	null,
	"call-cal",
	"calendar",
	{ action: "list_events" },
	{ events: ["Dentist with Dr. Kovacs"] },
);

const ROW_FETCH = {
	toolCallId: "pre-1",
	toolName: "fetch_url",
	localDistilled: false,
	digest: { ok: true, summary: "Fetched 1 page." },
};
const ROW_SEARCH = {
	toolCallId: "call-search",
	toolName: "research_web",
	localDistilled: false,
	digest: { ok: true, summary: "Found 1 source." },
};
const ROW_CAL = {
	toolCallId: "call-cal",
	toolName: "calendar",
	localDistilled: false,
	digest: { ok: true, summary: "Found 1 event." },
};

const ANSWER_1_RECORD = {
	status: "answered",
	answers: [{ question: "Which colour?", ownWords: OWN_WORDS_1 }],
	note: "The user answered.",
};

type Rows = {
	/** the first row of the reply and the one that asked, in order */
	segments: Array<{
		id: string;
		content: string;
		metadata?: Record<string, unknown>;
		toolCalls?: unknown[];
	}>;
};

/**
 * The reply's rows after `earlierExchanges` exchanges of the chat that came
 * before it (a user message and its reply each), so the person's message is not
 * the first row.
 */
function seedMessages(
	{ segments }: Rows,
	userMetadata: unknown = null,
	earlierExchanges = 0,
) {
	const before = Array.from({ length: earlierExchanges }, (_, index) =>
		(["user", "assistant"] as const).map((role, half) => ({
			id: `${role}-before-${index}`,
			conversationId: CHAT,
			messageSequence: index * 2 + half + 1,
			role,
			content: `An earlier ${role} message ${index}`,
			createdAt: NOW,
		})),
	).flat();
	const offset = earlierExchanges * 2;
	memory.db
		.insert(schema.messages)
		.values([
			...before,
			{
				id: "user-m",
				conversationId: CHAT,
				messageSequence: offset + 1,
				role: "user",
				content: "Plan my living room",
				metadataJson: userMetadata ? JSON.stringify(userMetadata) : null,
				createdAt: NOW,
			},
			...segments.map((segment, index) => ({
				id: segment.id,
				conversationId: CHAT,
				messageSequence: offset + index + 2,
				role: "assistant" as const,
				content: segment.content,
				metadataJson: segment.metadata
					? JSON.stringify(segment.metadata)
					: null,
				toolCalls: segment.toolCalls ? JSON.stringify(segment.toolCalls) : null,
				createdAt: NOW,
			})),
		])
		.run();
}

/** A question the reply asked and the store holds as the asking segment's finalize left it. */
async function stamped(p: {
	messageId: string;
	toolCallId: string;
	questions: AskQuestion[];
	messages: ModelMessage[];
	results: unknown[];
}) {
	const { id } = await recordAskQuestion({
		userId: USER,
		conversationId: CHAT,
		toolCallId: p.toolCallId,
		questions: p.questions,
	});
	await stampAskQuestion({
		userId: USER,
		questionId: id,
		assistantMessageId: p.messageId,
		capture: { v: 1, messages: p.messages, results: p.results as never },
	});
	pointAskCallAt(p.messageId, p.toolCallId, id);
	return id;
}

/**
 * The ask call of the asking row names its question in its metadata, as the tool
 * records it; the rows are seeded before the question exists, so the call is
 * pointed at it here (a row with no timeline, or no such call, is left alone).
 */
function pointAskCallAt(messageId: string, callId: string, questionId: string) {
	const row = memory.db
		.select({ toolCalls: schema.messages.toolCalls })
		.from(schema.messages)
		.where(eq(schema.messages.id, messageId))
		.get();
	if (!row?.toolCalls) return;
	const timeline = JSON.parse(row.toolCalls) as Array<{
		callId?: string;
		metadata?: Record<string, unknown>;
	}>;
	for (const call of timeline) {
		if (call.callId === callId) {
			call.metadata = { ...call.metadata, questionId };
		}
	}
	memory.db
		.update(schema.messages)
		.set({ toolCalls: JSON.stringify(timeline) })
		.where(eq(schema.messages.id, messageId))
		.run();
}

function questionRow(questionId: string) {
	const row = memory.db
		.select()
		.from(schema.askQuestions)
		.where(eq(schema.askQuestions.id, questionId))
		.get();
	if (!row) throw new Error(`no ask_questions row ${questionId}`);
	return row;
}

/** What the asking row's stored timeline says its call returned. */
function askCallSummary(messageId: string, callId: string): string | undefined {
	const row = memory.db
		.select({ toolCalls: schema.messages.toolCalls })
		.from(schema.messages)
		.where(eq(schema.messages.id, messageId))
		.get();
	const timeline = JSON.parse(row?.toolCalls ?? "[]") as Array<{
		callId?: string;
		outputSummary?: string;
	}>;
	return timeline.find((call) => call.callId === callId)?.outputSummary;
}

async function claim(questionId: string, answer: AskAnswer) {
	const claimed = await claimAskQuestion({
		userId: USER,
		conversationId: CHAT,
		questionId,
		answer,
	});
	if (!claimed.ok) throw new Error(`claim lost: ${claimed.reason}`);
	return claimed;
}

/** A reply of one segment that asked once. */
async function oneSegmentReply(
	answer: AskAnswer = pick(0),
	userMetadata: unknown = null,
) {
	seedMessages(
		{
			segments: [
				{
					id: "asst-1",
					content: "Let me look first.",
					metadata: { userIntent: { webSearch: true } },
					toolCalls: [FETCH_CALL, SEARCH_CALL, ASK_CALL_1],
				},
			],
		},
		userMetadata,
	);
	const id = await stamped({
		messageId: "asst-1",
		toolCallId: "call-ask-1",
		questions: COLOUR,
		messages: [
			...FETCHED,
			...SEARCHED,
			...step(
				"Which colour?",
				"call-ask-1",
				"ask_user",
				{ questions: COLOUR },
				PAUSE,
			),
		],
		results: [ROW_FETCH, ROW_SEARCH],
	});
	return claim(id, answer);
}

/** A reply of two segments: the first asked, was answered in the person's own words, and the second asked again. */
async function twoSegmentReply(answer: AskAnswer, earlierExchanges = 0) {
	seedMessages(
		{
			segments: [
				{
					id: "asst-1",
					content: "Let me look first.",
					metadata: { userIntent: { webSearch: true } },
					toolCalls: [FETCH_CALL, SEARCH_CALL, ASK_CALL_1],
				},
				{
					id: "asst-2",
					content: "Thanks. One more thing.",
					metadata: { continuesMessageId: "asst-1" },
					toolCalls: [CALENDAR_CALL, ASK_CALL_2],
				},
			],
		},
		null,
		earlierExchanges,
	);
	const first = await stamped({
		messageId: "asst-1",
		toolCallId: "call-ask-1",
		questions: COLOUR,
		messages: [
			...FETCHED,
			...SEARCHED,
			...step(
				"Which colour?",
				"call-ask-1",
				"ask_user",
				{ questions: COLOUR },
				PAUSE,
			),
		],
		results: [ROW_FETCH, ROW_SEARCH],
	});
	const firstClaim = await claim(first, {
		kind: "answered",
		answers: [{ picked: [], ownWords: OWN_WORDS_1 }],
	});
	await settleAskQuestion({
		userId: USER,
		questionId: first,
		claim: firstClaim.claim,
	});
	const second = await stamped({
		messageId: "asst-2",
		toolCallId: "call-ask-2",
		questions: FINISH,
		messages: [
			...FETCHED,
			...SEARCHED,
			...step(
				"Which colour?",
				"call-ask-1",
				"ask_user",
				{ questions: COLOUR },
				ANSWER_1_RECORD,
			),
			...CALENDAR_READ,
			...step(
				"Thanks. One more thing.",
				"call-ask-2",
				"ask_user",
				{ questions: FINISH },
				PAUSE,
			),
		],
		results: [ROW_FETCH, ROW_SEARCH, ROW_CAL],
	});
	return claim(second, answer);
}

function pick(index: number): AskAnswer {
	return { kind: "answered", answers: [{ picked: [index], ownWords: null }] };
}

const SECOND_ANSWER: AskAnswer = {
	kind: "answered",
	answers: [
		{ picked: [0], ownWords: null },
		{ picked: [], ownWords: OWN_WORDS_2 },
	],
};

function resultOutput(messages: ModelMessage[], toolCallId: string): unknown {
	for (const message of messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (part.type === "tool-result" && part.toolCallId === toolCallId) {
				return part.output;
			}
		}
	}
	return undefined;
}

async function prepare(
	claimed: Awaited<ReturnType<typeof claim>>,
	body: Record<string, unknown> = { streamId: "stream-answer" },
) {
	return prepareAskResumeTurn({
		userId: USER,
		runtimeConfig: config,
		conversationId: CHAT,
		claimed: claimed.row,
		claim: claimed.claim,
		body,
	});
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, USER);
	seedConversation(memory, { id: CHAT, userId: USER });
	capturedSyntheticBodies.length = 0;
	mockHasLocalDistillEnabled.mockReset();
	mockHasLocalDistillEnabled.mockResolvedValue(false);
	mockKeepReadable.mockReset();
	mockKeepReadable.mockImplementation(
		async (params: { refs: unknown[]; marks: unknown }) => ({
			pictureRefs: params.refs,
			imageMarks: params.marks,
		}),
	);
	vi.mocked(preflightChatTurn).mockClear();
});

describe("prepareAskResumeTurn", () => {
	it("resumes a claimed question on the person's message, without saving it again, as ask_resume", async () => {
		const claimed = await oneSegmentReply(pick(1));

		const result = await prepare(claimed);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { turn, upstreamMessage, isReconnect, resume } =
			result.value.orchestratorInput;
		// the person's own message, as stored, and not saved a second time
		expect(turn.normalizedMessage).toBe("Plan my living room");
		expect(upstreamMessage).toBe("Plan my living room");
		expect(turn.skipPersistUserMessage).toBe(true);
		expect(capturedSyntheticBodies[0]).toMatchObject({
			message: "Plan my living room",
			conversationId: CHAT,
			skipPersistUserMessage: true,
		});
		// not a regenerate, and not a reconnect; a regenerate's appendix is not here
		expect(turn.turnOrigin).toBe("ask_resume");
		expect(isReconnect).toBe(false);
		expect(result.value.orchestratorInput).not.toHaveProperty(
			"systemPromptAppendix",
		);
		// the claim goes through as it was won, and names the row and the call
		expect(resume).toMatchObject({
			depthOverride: false,
			questionId: claimed.row.id,
			claim: claimed.claim,
			askedMessageId: "asst-1",
			askToolCallId: "call-ask-1",
			userMessageId: "user-m",
			answerDigest: {
				outputSummary: "The user picked: Grey",
				resultDigest: expect.stringContaining("Which colour?: Grey"),
			},
		});
		// the model is handed the answer where the pause was, the rest in full
		expect(resultOutput(resume?.continuation ?? [], "call-ask-1")).toEqual({
			type: "json",
			value: {
				status: "answered",
				answers: [{ question: "Which colour?", picked: ["Grey"] }],
				note: expect.stringContaining("The user answered."),
			},
		});
		expect(resultOutput(resume?.continuation ?? [], "call-search")).toEqual({
			type: "json",
			value: { sources: ["the whole result"] },
		});
		expect(resume?.capturedResults.map((row) => row.toolCallId)).toEqual([
			"pre-1",
			"call-search",
		]);
	});

	it("names the message that began the reply as the end of the history: not the row that asked, and not an earlier message", async () => {
		// The run's history ends before the id this names (`historyBeforeMessageId`,
		// with no web prefetch: the orchestrator test "runs a resume with its
		// continuation..." holds both on the model run), and the history cut keeps
		// the whole history when the id is missing. So the id has to be the person's
		// message of this reply: the user row right before its first segment, in a
		// chat that has earlier messages, and for a reply of several segments.
		const claimed = await twoSegmentReply(SECOND_ANSWER, 2);

		const result = await prepare(claimed);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { resume } = result.value.orchestratorInput;
		expect(resume?.userMessageId).toBe("user-m");
		expect(resume?.askedMessageId).toBe("asst-2");
		// what is sent after the history is the person's own message as stored
		expect(result.value.orchestratorInput.turn.normalizedMessage).toBe(
			"Plan my living room",
		);
	});

	it("carries the reply's earlier tool calls, the captured results and the person's own words", async () => {
		const claimed = await twoSegmentReply(SECOND_ANSWER);

		const result = await prepare(claimed);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { resume } = result.value.orchestratorInput;
		// every call stored on the reply's segments, in the order they ran
		expect(resume?.priorSegmentToolCalls.map((call) => call.callId)).toEqual([
			"pre-1",
			"call-search",
			"call-ask-1",
			"call-cal",
			"call-ask-2",
		]);
		expect(resume?.priorSegmentToolCalls[1]).toEqual({
			callId: "call-search",
			name: "research_web",
			input: { query: "wall colours" },
			status: "done",
			outputSummary: "Found 1 source.",
			candidates: [
				{
					id: "src-b",
					title: "Page B",
					url: "https://example.com/b",
					sourceType: "web",
				},
			],
		});
		// what the capture kept of the tool results
		expect(resume?.capturedResults.map((row) => row.toolCallId)).toEqual([
			"pre-1",
			"call-search",
			"call-cal",
		]);
		// the words the person typed, this answer's and the earlier one's, and no label
		// or question: those are the model's
		expect(resume?.userTexts).toEqual([OWN_WORDS_1, OWN_WORDS_2]);
		// the first segment's ask keeps its answer in the continuation; the second
		// is answered now
		expect(resultOutput(resume?.continuation ?? [], "call-ask-1")).toEqual({
			type: "json",
			value: ANSWER_1_RECORD,
		});
		expect(
			resultOutput(resume?.continuation ?? [], "call-ask-2"),
		).toMatchObject({
			type: "json",
			value: {
				status: "answered",
				answers: [
					{ question: "Which finish?", picked: ["Matt"] },
					{ question: "Anything else we should know?", ownWords: OWN_WORDS_2 },
				],
			},
		});
	});

	it("keeps an option's label and a question out of the person's words", async () => {
		const claimed = await twoSegmentReply({
			kind: "answered",
			answers: [
				{ picked: [1], ownWords: null },
				{ picked: [0], ownWords: null },
			],
		});

		const result = await prepare(claimed);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// only the first segment's own words: this answer picked from the model's labels
		expect(result.value.orchestratorInput.resume?.userTexts).toEqual([
			OWN_WORDS_1,
		]);
	});

	it("reads the person's choices from the reply's first segment, and the message's own record", async () => {
		const claimed = await twoSegmentReply(SECOND_ANSWER);

		const result = await prepare(claimed);

		expect(result.ok).toBe(true);
		// the web search was chosen for the turn that began the reply, and recorded on
		// its first row; the row that asked has no record of it
		expect(capturedSyntheticBodies[0]?.forceWebSearch).toBe(true);
		expect(mockKeepReadable).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER, conversationId: CHAT }),
		);
	});

	it("rebuilds the person's message with its uploads, pictures and marks, as a regenerate does", async () => {
		const boxes = [{ letter: "A", x: 0.1, y: 0.1, w: 0.4, h: 0.4 }];
		vi.mocked(listMessageAttachments).mockResolvedValue(
			new Map([["user-m", [{ artifactId: "upload-1" }]]]) as never,
		);
		const claimed = await oneSegmentReply(pick(0), {
			pictures: {
				refs: [{ imageFileId: "file-1", number: 2, name: "Rug" }],
				open: null,
				marks: {
					imageFileId: "file-1",
					markedFileId: "file-9",
					letters: ["A"],
					boxes,
				},
			},
		});

		const result = await prepare(claimed);

		expect(result.ok).toBe(true);
		// read off the person's message (not the row that asked), and judged for what
		// they can still read
		expect(mockKeepReadable).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER,
				conversationId: CHAT,
				attachmentIds: ["upload-1"],
				refs: [{ imageFileId: "file-1", number: 2 }],
			}),
		);
		expect(capturedSyntheticBodies[0]).toMatchObject({
			attachmentIds: ["upload-1"],
			pictureRefs: [{ imageFileId: "file-1", number: 2 }],
			imageMarks: { imageFileId: "file-1", marks: boxes },
		});
	});

	it("runs on the model, depth, personality, capabilities and document the answer was sent with", async () => {
		const claimed = await oneSegmentReply();

		const result = await prepare(claimed, {
			streamId: "stream-answer",
			model: "model2",
			reasoningDepth: "thorough",
			personalityProfileId: "personality-1",
			enabledConnectionCapabilities: ["calendar"],
			activeDocumentArtifactId: "doc-1",
		});

		expect(
			result.ok && result.value.orchestratorInput.resume?.depthOverride,
		).toBe(true);
		expect(capturedSyntheticBodies[0]).toMatchObject({
			streamId: "stream-answer",
			model: "model2",
			reasoningDepth: "thorough",
			personalityProfileId: "personality-1",
			enabledConnectionCapabilities: ["calendar"],
			activeDocumentArtifactId: "doc-1",
			skipPersistUserMessage: true,
		});
	});

	it("asks for the person's local-only connector setting once", async () => {
		mockHasLocalDistillEnabled.mockResolvedValue(true);
		const claimed = await twoSegmentReply(SECOND_ANSWER);

		const result = await prepare(claimed);

		expect(mockHasLocalDistillEnabled).toHaveBeenCalledTimes(1);
		expect(mockHasLocalDistillEnabled).toHaveBeenCalledWith(USER);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.orchestratorInput.resume?.keepConnectorDataLocal).toBe(
			true,
		);
	});

	it("answers the preflight's refusal in the shape the stream route's refusals have", async () => {
		const claimed = await oneSegmentReply();
		vi.mocked(preflightChatTurn).mockResolvedValueOnce({
			ok: false,
			error: { status: 400, error: "Message is too long" },
		} as never);

		const result = await prepare(claimed);

		expect(result).toEqual({
			ok: false,
			error: {
				status: 400,
				error: "Message is too long",
				responseShape: "stream-json",
			},
		});
	});

	// A refusal that can pass on a later try (an attachment not ready, a picture
	// the person can no longer read, a message that is too long once the limit is
	// raised) closes nothing: the route gives the claim back and the card comes
	// back with the answer on it.
	it("leaves a question whose refusal can pass claimed and open, for the caller to give back with the answer kept", async () => {
		const claimed = await oneSegmentReply(pick(1));
		vi.mocked(preflightChatTurn).mockResolvedValueOnce({
			ok: false,
			error: { status: 422, error: "Attachment is not ready" },
		} as never);

		const result = await prepare(claimed);

		expect(result.ok).toBe(false);
		// nothing was closed: the question is still the claim's, the capture is
		// there, and the call that asked still says the reply paused
		expect(questionRow(claimed.row.id)).toMatchObject({
			status: "answering",
			resumeJson: expect.any(String),
		});
		expect(askCallSummary("asst-1", "call-ask-1")).toBe(
			"Asked the user; the reply paused for the answer.",
		);
		// the caller's give-back brings the card back with the answer on it, and the
		// chat stays closed to new messages until it is answered
		expect(
			await releaseAskQuestion({
				userId: USER,
				questionId: claimed.row.id,
				claim: claimed.claim,
			}),
		).toBe(true);
		expect(questionRow(claimed.row.id)).toMatchObject({
			status: "waiting",
			answerJson: JSON.stringify(pick(1)),
		});
		expect(
			await findWaitingQuestionRefusal({ userId: USER, conversationId: CHAT }),
		).toMatchObject({ code: "QUESTION_WAITING" });
	});

	// Every cause below is permanent for the question's row: the reply it belongs to
	// can never have the shape a resume starts from, and an answer would fail the
	// same way each time. Giving the claim back would leave a card that cannot be
	// answered or closed (the X goes through the same resume), in a chat that
	// refuses new messages, Retry and edits while a question waits: so the question
	// is closed for good instead (Ruling 46).
	describe("closes the question for good when it can never be carried on", () => {
		const NOT_WAITING = {
			ok: false,
			error: {
				status: 409,
				error: expect.any(String),
				code: "QUESTION_NOT_WAITING",
				responseShape: "json",
			},
		};

		/** What a question that can never be resumed leaves behind, and what the chat does afterwards. */
		async function expectClosedForGood(
			claimed: Awaited<ReturnType<typeof claim>>,
			asking: { messageId: string; callId: string },
		) {
			// nothing to answer and nothing kept to resume from
			const row = questionRow(claimed.row.id);
			expect(row).toMatchObject({ status: "discarded", resumeJson: null });
			expect(row.settledAt).toBeInstanceOf(Date);
			// the card is gone, and the chat takes messages again
			const listed = await listConversationAskQuestions({
				userId: USER,
				conversationId: CHAT,
			});
			expect(listed.map((question) => question.id)).not.toContain(
				claimed.row.id,
			);
			expect(
				await findWaitingQuestionRefusal({
					userId: USER,
					conversationId: CHAT,
				}),
			).toBeNull();
			// the won claim was spent by the close, so the caller's give-back after the
			// refusal brings nothing back
			expect(
				await releaseAskQuestion({
					userId: USER,
					questionId: claimed.row.id,
					claim: claimed.claim,
				}),
			).toBe(false);
			expect(questionRow(claimed.row.id).status).toBe("discarded");
			// and a later turn reads that the reply ended, as for a reply saved without
			// its pause
			expect(askCallSummary(asking.messageId, asking.callId)).toBe(
				"The reply ended before the user answered.",
			);
			// a second answer finds nothing to claim
			expect(
				await claimAskQuestion({
					userId: USER,
					conversationId: CHAT,
					questionId: claimed.row.id,
					answer: pick(1),
				}),
			).toEqual({ ok: false, reason: "not_waiting" });
		}

		it("cannot find the person's message: no user row right before the reply", async () => {
			// the reply is the conversation's first row
			memory.db
				.insert(schema.messages)
				.values({
					id: "asst-1",
					conversationId: CHAT,
					messageSequence: 1,
					role: "assistant",
					content: "Which colour?",
					toolCalls: JSON.stringify([ASK_CALL_1]),
					createdAt: NOW,
				})
				.run();
			const id = await stamped({
				messageId: "asst-1",
				toolCallId: "call-ask-1",
				questions: COLOUR,
				messages: step(
					"Which colour?",
					"call-ask-1",
					"ask_user",
					{ questions: COLOUR },
					PAUSE,
				),
				results: [],
			});
			const claimed = await claim(id, pick(0));

			const result = await prepare(claimed);

			expect(result).toEqual(NOT_WAITING);
			expect(capturedSyntheticBodies).toHaveLength(0);
			await expectClosedForGood(claimed, {
				messageId: "asst-1",
				callId: "call-ask-1",
			});
		});

		it("finds an assistant row, not the person's message, before the first segment", async () => {
			memory.db
				.insert(schema.messages)
				.values([
					{
						id: "user-m",
						conversationId: CHAT,
						messageSequence: 1,
						role: "user",
						content: "Plan my living room",
						createdAt: NOW,
					},
					{
						id: "asst-0",
						conversationId: CHAT,
						messageSequence: 2,
						role: "assistant",
						content: "An unrelated reply.",
						createdAt: NOW,
					},
					{
						id: "asst-1",
						conversationId: CHAT,
						messageSequence: 3,
						role: "assistant",
						content: "Which colour?",
						toolCalls: JSON.stringify([ASK_CALL_1]),
						createdAt: NOW,
					},
				])
				.run();
			const id = await stamped({
				messageId: "asst-1",
				toolCallId: "call-ask-1",
				questions: COLOUR,
				messages: step(
					"Which colour?",
					"call-ask-1",
					"ask_user",
					{ questions: COLOUR },
					PAUSE,
				),
				results: [],
			});
			const claimed = await claim(id, pick(0));

			expect(await prepare(claimed)).toEqual(NOT_WAITING);
			await expectClosedForGood(claimed, {
				messageId: "asst-1",
				callId: "call-ask-1",
			});
		});

		it("finds that the row a segment continues is gone", async () => {
			seedMessages({
				segments: [
					{
						id: "asst-2",
						content: "Thanks. One more thing.",
						metadata: { continuesMessageId: "asst-gone" },
						toolCalls: [ASK_CALL_2],
					},
				],
			});
			const id = await stamped({
				messageId: "asst-2",
				toolCallId: "call-ask-2",
				questions: COLOUR,
				messages: step(
					"Which colour?",
					"call-ask-2",
					"ask_user",
					{ questions: COLOUR },
					PAUSE,
				),
				results: [],
			});
			const claimed = await claim(id, pick(0));

			expect(await prepare(claimed)).toEqual(NOT_WAITING);
			await expectClosedForGood(claimed, {
				messageId: "asst-2",
				callId: "call-ask-2",
			});
		});

		it("does not walk a loop of continuations for ever", async () => {
			seedMessages({
				segments: [
					{
						id: "asst-1",
						content: "a",
						metadata: { continuesMessageId: "asst-2" },
					},
					{
						id: "asst-2",
						content: "b",
						metadata: { continuesMessageId: "asst-1" },
						toolCalls: [ASK_CALL_2],
					},
				],
			});
			const id = await stamped({
				messageId: "asst-2",
				toolCallId: "call-ask-2",
				questions: COLOUR,
				messages: step(
					"Which colour?",
					"call-ask-2",
					"ask_user",
					{ questions: COLOUR },
					PAUSE,
				),
				results: [],
			});
			const claimed = await claim(id, pick(0));

			expect(await prepare(claimed)).toEqual(NOT_WAITING);
			await expectClosedForGood(claimed, {
				messageId: "asst-2",
				callId: "call-ask-2",
			});
		});

		it("finds that the capture holds no result of the ask to answer", async () => {
			seedMessages({
				segments: [
					{
						id: "asst-1",
						content: "Let me look first.",
						toolCalls: [ASK_CALL_1],
					},
				],
			});
			// the capture stops before the step that asked was captured
			const id = await stamped({
				messageId: "asst-1",
				toolCallId: "call-ask-1",
				questions: COLOUR,
				messages: SEARCHED,
				results: [ROW_SEARCH],
			});
			const claimed = await claim(id, pick(0));

			expect(await prepare(claimed)).toEqual(NOT_WAITING);
			await expectClosedForGood(claimed, {
				messageId: "asst-1",
				callId: "call-ask-1",
			});
		});

		it("finds that the capture cannot be read", async () => {
			seedMessages({
				segments: [
					{
						id: "asst-1",
						content: "Let me look first.",
						toolCalls: [ASK_CALL_1],
					},
				],
			});
			const id = await stamped({
				messageId: "asst-1",
				toolCallId: "call-ask-1",
				questions: COLOUR,
				messages: SEARCHED,
				results: [ROW_SEARCH],
			});
			memory.db
				.update(schema.askQuestions)
				.set({ resumeJson: "{not json" })
				.where(eq(schema.askQuestions.id, id))
				.run();
			const claimed = await claim(id, pick(0));

			expect(await prepare(claimed)).toEqual(NOT_WAITING);
			await expectClosedForGood(claimed, {
				messageId: "asst-1",
				callId: "call-ask-1",
			});
		});

		it("closes a later segment's question, and leaves the earlier answered one and its call as they were", async () => {
			// the second segment's capture lost the ask's result (as the claim read it)
			const whole = await twoSegmentReply(SECOND_ANSWER);
			const claimed = {
				...whole,
				row: {
					...whole.row,
					resumeJson: JSON.stringify({ v: 1, messages: SEARCHED, results: [] }),
				},
			};
			const earlier = (
				await listConversationAskQuestions({
					userId: USER,
					conversationId: CHAT,
				})
			).find((question) => question.status === "answered");

			expect(await prepare(claimed)).toEqual(NOT_WAITING);
			await expectClosedForGood(claimed, {
				messageId: "asst-2",
				callId: "call-ask-2",
			});
			// the first segment's question stays answered, and its call is as it was
			expect(earlier).toBeDefined();
			expect(questionRow(earlier?.id ?? "").status).toBe("answered");
			expect(askCallSummary("asst-1", "call-ask-1")).toBe(
				"Asked the user; the reply paused for the answer.",
			);
		});

		it("does not close a question that is not this person's chat's: it is not the resume's to end", async () => {
			const claimed = await oneSegmentReply(pick(0));

			const result = await prepareAskResumeTurn({
				userId: "someone-else",
				runtimeConfig: config,
				conversationId: CHAT,
				claimed: claimed.row,
				claim: claimed.claim,
				body: { streamId: "stream-answer" },
			});

			expect(result).toEqual(NOT_WAITING);
			expect(questionRow(claimed.row.id).status).toBe("answering");
			expect(askCallSummary("asst-1", "call-ask-1")).toBe(
				"Asked the user; the reply paused for the answer.",
			);
		});
	});
});

describe("findWaitingQuestionRefusal", () => {
	const REFUSAL = {
		status: 409,
		error: expect.any(String),
		code: "QUESTION_WAITING",
	};

	it("refuses with QUESTION_WAITING while a stamped question waits or answers", async () => {
		seedMessages({
			segments: [{ id: "asst-1", content: "Which colour?" }],
		});
		const id = await stamped({
			messageId: "asst-1",
			toolCallId: "call-ask-1",
			questions: COLOUR,
			messages: step(
				"Which colour?",
				"call-ask-1",
				"ask_user",
				{ questions: COLOUR },
				PAUSE,
			),
			results: [],
		});

		// waiting
		expect(
			await findWaitingQuestionRefusal({ userId: USER, conversationId: CHAT }),
		).toEqual(REFUSAL);

		// answering: the reply is on its way
		const claimed = await claim(id, pick(0));
		expect(
			await findWaitingQuestionRefusal({ userId: USER, conversationId: CHAT }),
		).toEqual(REFUSAL);

		// answered: the chat takes messages again
		await settleAskQuestion({
			userId: USER,
			questionId: id,
			claim: claimed.claim,
		});
		expect(
			await findWaitingQuestionRefusal({ userId: USER, conversationId: CHAT }),
		).toBeNull();
	});

	it("refuses nothing in a chat with no question, or only one the reply never saved", async () => {
		expect(
			await findWaitingQuestionRefusal({ userId: USER, conversationId: CHAT }),
		).toBeNull();

		await recordAskQuestion({
			userId: USER,
			conversationId: CHAT,
			toolCallId: "call-ask-1",
			questions: COLOUR,
		});
		expect(
			await findWaitingQuestionRefusal({ userId: USER, conversationId: CHAT }),
		).toBeNull();
	});
});
