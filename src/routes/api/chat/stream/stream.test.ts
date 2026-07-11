import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkStreamCapacity: vi.fn(),
	getConfig: vi.fn(),
	requireAuth: vi.fn(),
	parseChatTurnRequest: vi.fn(),
	admitChatTurnStream: vi.fn(),
	prepareAdmittedChatTurn: vi.fn(),
	preflightChatTurn: vi.fn(),
	runChatStreamOrchestrator: vi.fn(),
	startStartedResetGenerationFact: vi.fn(),
	getCurrentMemoryResetGeneration: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: mocks.requireAuth,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mocks.getConfig,
}));

vi.mock("$lib/server/services/chat-turn/active-streams", () => ({
	checkStreamCapacity: mocks.checkStreamCapacity,
}));

vi.mock("$lib/server/services/chat-turn/request", () => ({
	parseChatTurnRequest: mocks.parseChatTurnRequest,
}));

vi.mock("$lib/server/services/chat-turn/preflight", () => ({
	admitChatTurnStream: mocks.admitChatTurnStream,
	prepareAdmittedChatTurn: mocks.prepareAdmittedChatTurn,
	preflightChatTurn: mocks.preflightChatTurn,
}));

vi.mock("$lib/server/services/chat-turn/stream-orchestrator", () => ({
	runChatStreamOrchestrator: mocks.runChatStreamOrchestrator,
	startStartedResetGenerationFact: mocks.startStartedResetGenerationFact,
}));

vi.mock("$lib/server/services/memory-profile/reset-generation", () => ({
	getCurrentMemoryResetGeneration: mocks.getCurrentMemoryResetGeneration,
}));

import { checkStreamCapacity } from "$lib/server/services/chat-turn/active-streams";
import {
	admitChatTurnStream,
	prepareAdmittedChatTurn,
} from "$lib/server/services/chat-turn/preflight";
import { parseChatTurnRequest } from "$lib/server/services/chat-turn/request";
import { runChatStreamOrchestrator } from "$lib/server/services/chat-turn/stream-orchestrator";
import type { ChatTurnPreparationResult } from "$lib/server/services/chat-turn/types";
import { SERVER_STREAM_TIMELINE_MARKS } from "$lib/services/stream-timeline";
import { POST } from "./+server";

type StreamPostEvent = Parameters<typeof POST>[0];

const runtimeConfig = {
	concurrentStreamLimit: 100,
	perUserStreamLimit: 10,
	requestTimeoutMs: 60_000,
	model1: { displayName: "Model 1" },
	model2: { displayName: "Model 2" },
};

const parsedRequest = {
	conversationId: "conv-1",
	normalizedMessage: "Hello",
	streamId: "stream-1",
	reconnectToStreamId: undefined,
	modelId: "model1",
	modelDisplayName: "Model 1",
	providerDisplayName: undefined,
	attachmentIds: [],
	linkedSources: [],
	pendingSkill: null,
	activeDocumentArtifactId: undefined,
	personalityProfileId: undefined,
	reasoningDepth: "auto",
	thinkingMode: "auto",
	forceWebSearch: false,
	skipPersistUserMessage: false,
	attachmentTraceId: undefined,
	atlasMode: false,
	atlasProfile: null,
	atlasAction: "create",
	parentAtlasId: null,
	clientAtlasTurnId: null,
};

const preflightedTurn = {
	...parsedRequest,
	depthMetadata: {
		requested: "auto",
		appliedProfile: "standard",
		fallback: false,
		modelId: "model1",
		modelDisplayName: "Model 1",
	},
	skillPromptContext: null,
};

const admittedTurn = parsedRequest;

function makeEvent(
	body: unknown,
	user: {
		id: string;
		displayName?: string | null;
		email?: string | null;
	} | null = {
		id: "user-1",
		displayName: "Test User",
		email: "test@example.com",
	},
	signal?: AbortSignal,
): StreamPostEvent {
	return {
		request: new Request("http://localhost/api/chat/stream", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		}),
		locals: {
			user,
		},
		params: {},
		url: new URL("http://localhost/api/chat/stream"),
		route: { id: "/api/chat/stream" },
	} as StreamPostEvent;
}

function makeStreamResponse() {
	return new Response(": adapter smoke\n\ndata: [DONE]\n\n", {
		headers: {
			"Content-Type": "text/event-stream",
			"X-Vercel-AI-UI-Message-Stream": "v1",
		},
	});
}

async function expectResolvedWithoutWaiting<T>(
	promise: Promise<T>,
): Promise<T> {
	const timedOut = Symbol("timedOut");
	const result = await Promise.race([
		promise,
		new Promise<typeof timedOut>((resolve) => {
			setTimeout(() => resolve(timedOut), 0);
		}),
	]);
	if (result === timedOut) {
		throw new Error("POST did not return before the deferred fact settled");
	}
	return result as T;
}

function ignoreDeferredPreparation(
	promise: Promise<unknown> | null,
): Promise<unknown> {
	return promise?.catch(() => undefined) ?? Promise.resolve();
}

describe("POST /api/chat/stream route adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue(runtimeConfig);
		mocks.requireAuth.mockReturnValue(undefined);
		mocks.parseChatTurnRequest.mockResolvedValue({
			ok: true,
			value: parsedRequest,
		});
		mocks.checkStreamCapacity.mockReturnValue({ allowed: true });
		mocks.admitChatTurnStream.mockResolvedValue({
			ok: true,
			value: admittedTurn,
		});
		mocks.prepareAdmittedChatTurn.mockResolvedValue({
			ok: true,
			value: preflightedTurn,
		});
		mocks.preflightChatTurn.mockResolvedValue({
			ok: true,
			value: preflightedTurn,
		});
		mocks.startStartedResetGenerationFact.mockReturnValue(Promise.resolve(0));
		mocks.getCurrentMemoryResetGeneration.mockResolvedValue(0);
		mocks.runChatStreamOrchestrator.mockReturnValue(makeStreamResponse());
	});

	it("returns the orchestrator SSE response and delegates the admitted turn", async () => {
		const abortController = new AbortController();
		const event = makeEvent(
			{
				message: " Hello ",
				conversationId: "conv-1",
				streamId: "stream-1",
			},
			{
				id: "user-1",
				displayName: "Test User",
				email: "test@example.com",
			},
			abortController.signal,
		);

		const response = await POST(event);
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		expect(response.headers.get("X-Vercel-AI-UI-Message-Stream")).toBe("v1");
		expect(body).toContain("data: [DONE]");
		expect(parseChatTurnRequest).toHaveBeenCalledWith(
			event.request,
			runtimeConfig,
			"stream",
		);
		expect(checkStreamCapacity).toHaveBeenCalledWith("user-1");
		expect(admitChatTurnStream).toHaveBeenCalledWith({
			userId: "user-1",
			request: parsedRequest,
		});
		expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).toHaveBeenCalledWith(
			expect.objectContaining({
				user: {
					id: "user-1",
					displayName: "Test User",
					email: "test@example.com",
				},
				turn: admittedTurn,
				upstreamMessage: "Hello",
				downstreamAbortSignal: event.request.signal,
				isReconnect: false,
				startedResetGeneration: expect.any(Promise),
				prepareTurn: expect.any(Function),
				routePhaseTimings: expect.objectContaining({
					[SERVER_STREAM_TIMELINE_MARKS.ROUTE_PARSE]: expect.any(Number),
					[SERVER_STREAM_TIMELINE_MARKS.CAPACITY]: expect.any(Number),
					[SERVER_STREAM_TIMELINE_MARKS.ADMISSION]: expect.any(Number),
				}),
			}),
		);
		expect(
			mocks.runChatStreamOrchestrator.mock.calls[0][0].routePhaseTimings,
		).not.toHaveProperty("preflight");
		const delegatedOptions = mocks.runChatStreamOrchestrator.mock.calls[0][0];
		await delegatedOptions.prepareTurn();
		expect(prepareAdmittedChatTurn).toHaveBeenCalledWith({
			userId: "user-1",
			admittedTurn,
		});
	});

	it("delegates the stream response without awaiting deferred turn preparation", async () => {
		let resolvePreparation!: (value: ChatTurnPreparationResult) => void;
		const deferredPreparation = new Promise<ChatTurnPreparationResult>(
			(resolve) => {
				resolvePreparation = resolve;
			},
		);
		let preparationSettled = false;
		void deferredPreparation.then(() => {
			preparationSettled = true;
		});
		let startedPreparation: Promise<unknown> | null = null;
		mocks.prepareAdmittedChatTurn.mockReturnValueOnce(deferredPreparation);
		mocks.runChatStreamOrchestrator.mockImplementationOnce((options) => {
			startedPreparation = options.prepareTurn();
			return makeStreamResponse();
		});

		const postPromise = Promise.resolve(
			POST(makeEvent({ message: "Hello", conversationId: "conv-1" })),
		);
		try {
			const response = await expectResolvedWithoutWaiting(postPromise);

			expect(response.status).toBe(200);
			expect(preparationSettled).toBe(false);
			expect(startedPreparation).toBe(deferredPreparation);
			expect(admitChatTurnStream).toHaveBeenCalledWith({
				userId: "user-1",
				request: parsedRequest,
			});
			expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
		} finally {
			resolvePreparation({
				ok: true,
				value: preflightedTurn,
			} as ChatTurnPreparationResult);
			await Promise.all([
				postPromise.catch(() => undefined),
				ignoreDeferredPreparation(startedPreparation),
			]);
		}
	});

	it("delegates the stream response without waiting for Memory Reset Generation", async () => {
		let resolveGeneration!: (value: number) => void;
		const deferredGeneration = new Promise<number>((resolve) => {
			resolveGeneration = resolve;
		});
		mocks.getCurrentMemoryResetGeneration.mockReturnValueOnce(
			deferredGeneration,
		);
		let startedBeforeOrchestration = false;
		mocks.startStartedResetGenerationFact.mockImplementationOnce(() => {
			startedBeforeOrchestration = true;
			return deferredGeneration;
		});
		mocks.runChatStreamOrchestrator.mockImplementationOnce((options) => {
			expect(startedBeforeOrchestration).toBe(true);
			expect(options.startedResetGeneration).toBe(deferredGeneration);
			return makeStreamResponse();
		});

		const postPromise = Promise.resolve(
			POST(makeEvent({ message: "Hello", conversationId: "conv-1" })),
		);
		try {
			const response = await expectResolvedWithoutWaiting(postPromise);

			expect(response.status).toBe(200);
			expect(mocks.startStartedResetGenerationFact).toHaveBeenCalledWith(
				"user-1",
			);
			expect(mocks.getCurrentMemoryResetGeneration).not.toHaveBeenCalled();
			expect(runChatStreamOrchestrator).toHaveBeenCalledWith(
				expect.objectContaining({
					startedResetGeneration: deferredGeneration,
				}),
			);
		} finally {
			resolveGeneration(0);
			await postPromise.catch(() => undefined);
		}
	});

	it("propagates auth failures before parsing the request", async () => {
		const redirect = { status: 302, location: "/login" };
		mocks.requireAuth.mockImplementationOnce(() => {
			throw redirect;
		});

		await expect(
			POST(makeEvent({ message: "Hello", conversationId: "conv-1" })),
		).rejects.toBe(redirect);

		expect(parseChatTurnRequest).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("fails closed when auth succeeds without a user in locals", async () => {
		await expect(
			POST(makeEvent({ message: "Hello", conversationId: "conv-1" }, null)),
		).rejects.toThrow("Authenticated user missing after auth check");

		expect(parseChatTurnRequest).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("returns parse errors as JSON and skips stream setup", async () => {
		mocks.parseChatTurnRequest.mockResolvedValueOnce({
			ok: false,
			error: {
				status: 400,
				error: "Message must be a non-empty string",
			},
		});

		const response = await POST(
			makeEvent({ message: "", conversationId: "conv-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(data).toEqual({
			status: 400,
			error: "Message must be a non-empty string",
		});
		expect(checkStreamCapacity).not.toHaveBeenCalled();
		expect(admitChatTurnStream).not.toHaveBeenCalled();
		expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("rejects Atlas turns before capacity, admission, or stream orchestration", async () => {
		mocks.parseChatTurnRequest.mockResolvedValueOnce({
			ok: true,
			value: {
				...parsedRequest,
				atlasMode: true,
				atlasProfile: "overview",
				clientAtlasTurnId: "atlas-client-1",
			},
		});

		const response = await POST(
			makeEvent({
				message: "Research the current market",
				conversationId: "conv-1",
				atlasMode: true,
				atlasProfile: "overview",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(data).toEqual({
			status: 400,
			error: "Atlas turns must be started through /api/chat/send.",
			code: "ATLAS_STREAM_UNSUPPORTED",
		});
		expect(checkStreamCapacity).not.toHaveBeenCalled();
		expect(admitChatTurnStream).not.toHaveBeenCalled();
		expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("returns capacity errors before admission for new streams", async () => {
		mocks.checkStreamCapacity.mockReturnValueOnce({
			allowed: false,
			reason: "global",
			retryAfterSeconds: 12,
			currentGlobalCount: 100,
			currentUserCount: 2,
		});

		const response = await POST(
			makeEvent({ message: "Hello", conversationId: "conv-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("12");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(data).toMatchObject({
			error: "Server at capacity. Please try again later.",
			code: "CAPACITY_EXCEEDED",
			reason: "global",
			retryAfter: 12,
		});
		expect(admitChatTurnStream).not.toHaveBeenCalled();
		expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("skips capacity checks for reconnects and marks the delegation as reconnect", async () => {
		const reconnectRequest = {
			...parsedRequest,
			streamId: "orphan-stream",
			reconnectToStreamId: "orphan-stream",
			normalizedMessage: "",
		};
		mocks.parseChatTurnRequest.mockResolvedValueOnce({
			ok: true,
			value: reconnectRequest,
		});
		mocks.admitChatTurnStream.mockResolvedValueOnce({
			ok: true,
			value: reconnectRequest,
		});

		const response = await POST(
			makeEvent({
				reconnectToStreamId: "orphan-stream",
				conversationId: "conv-1",
			}),
		);

		expect(response.status).toBe(200);
		expect(checkStreamCapacity).not.toHaveBeenCalled();
		expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: reconnectRequest,
				upstreamMessage: "",
				isReconnect: true,
				prepareTurn: expect.any(Function),
				routePhaseTimings: expect.objectContaining({
					[SERVER_STREAM_TIMELINE_MARKS.ROUTE_PARSE]: expect.any(Number),
					[SERVER_STREAM_TIMELINE_MARKS.CAPACITY]: expect.any(Number),
					[SERVER_STREAM_TIMELINE_MARKS.ADMISSION]: expect.any(Number),
				}),
			}),
		);
		expect(
			mocks.runChatStreamOrchestrator.mock.calls[0][0].routePhaseTimings,
		).not.toHaveProperty("preflight");
	});

	it("returns admission errors as JSON and skips orchestration", async () => {
		mocks.admitChatTurnStream.mockResolvedValueOnce({
			ok: false,
			error: {
				status: 404,
				error: "Conversation not found",
			},
		});

		const response = await POST(
			makeEvent({ message: "Hello", conversationId: "missing-conv" }),
		);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data).toEqual({
			status: 404,
			error: "Conversation not found",
		});
		expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
		expect(prepareAdmittedChatTurn).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});
});
