import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	checkStreamCapacity: vi.fn(),
	getConfig: vi.fn(),
	requireAuth: vi.fn(),
	parseChatTurnRequest: vi.fn(),
	preflightChatTurn: vi.fn(),
	runChatStreamOrchestrator: vi.fn(),
	getCurrentMemoryResetGeneration: vi.fn(),
	buildSkillSystemPromptAppendix: vi.fn(),
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
	preflightChatTurn: mocks.preflightChatTurn,
}));

vi.mock("$lib/server/services/chat-turn/stream-orchestrator", () => ({
	runChatStreamOrchestrator: mocks.runChatStreamOrchestrator,
}));

vi.mock("$lib/server/services/memory-profile", () => ({
	getCurrentMemoryResetGeneration: mocks.getCurrentMemoryResetGeneration,
}));

vi.mock("$lib/server/services/skills/prompt-context", () => ({
	buildSkillSystemPromptAppendix: mocks.buildSkillSystemPromptAppendix,
}));

import { checkStreamCapacity } from "$lib/server/services/chat-turn/active-streams";
import { preflightChatTurn } from "$lib/server/services/chat-turn/preflight";
import { parseChatTurnRequest } from "$lib/server/services/chat-turn/request";
import { runChatStreamOrchestrator } from "$lib/server/services/chat-turn/stream-orchestrator";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";
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
	deepResearchDepth: undefined,
	reasoningDepth: "auto",
	thinkingMode: "auto",
	forceWebSearch: false,
	skipPersistUserMessage: false,
	attachmentTraceId: undefined,
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
		mocks.preflightChatTurn.mockResolvedValue({
			ok: true,
			value: preflightedTurn,
		});
		mocks.getCurrentMemoryResetGeneration.mockResolvedValue(0);
		mocks.buildSkillSystemPromptAppendix.mockReturnValue(undefined);
		mocks.runChatStreamOrchestrator.mockReturnValue(makeStreamResponse());
	});

	it("returns the orchestrator SSE response and delegates the preflighted turn", async () => {
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
		expect(preflightChatTurn).toHaveBeenCalledWith({
			userId: "user-1",
			request: parsedRequest,
		});
		expect(buildSkillSystemPromptAppendix).toHaveBeenCalledWith(
			preflightedTurn.skillPromptContext,
		);
		expect(runChatStreamOrchestrator).toHaveBeenCalledWith(
			expect.objectContaining({
				user: {
					id: "user-1",
					displayName: "Test User",
					email: "test@example.com",
				},
				turn: preflightedTurn,
				upstreamMessage: "Hello",
				downstreamAbortSignal: event.request.signal,
				isReconnect: false,
				startedResetGeneration: 0,
				systemPromptAppendix: undefined,
				routePhaseTimings: expect.objectContaining({
					route_parse: expect.any(Number),
					capacity: expect.any(Number),
					preflight: expect.any(Number),
				}),
			}),
		);
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
		expect(preflightChatTurn).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("returns capacity errors before preflight for new streams", async () => {
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
		expect(preflightChatTurn).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});

	it("skips capacity checks for reconnects and marks the delegation as reconnect", async () => {
		const reconnectRequest = {
			...parsedRequest,
			streamId: "orphan-stream",
			reconnectToStreamId: "orphan-stream",
			normalizedMessage: "",
		};
		const reconnectTurn = {
			...preflightedTurn,
			...reconnectRequest,
			skillPromptContext: null,
		};
		mocks.parseChatTurnRequest.mockResolvedValueOnce({
			ok: true,
			value: reconnectRequest,
		});
		mocks.preflightChatTurn.mockResolvedValueOnce({
			ok: true,
			value: reconnectTurn,
		});

		const response = await POST(
			makeEvent({
				reconnectToStreamId: "orphan-stream",
				conversationId: "conv-1",
			}),
		);

		expect(response.status).toBe(200);
		expect(checkStreamCapacity).not.toHaveBeenCalled();
		expect(runChatStreamOrchestrator).toHaveBeenCalledWith(
			expect.objectContaining({
				turn: reconnectTurn,
				upstreamMessage: "",
				isReconnect: true,
				routePhaseTimings: expect.objectContaining({
					route_parse: expect.any(Number),
					capacity: expect.any(Number),
					preflight: expect.any(Number),
				}),
			}),
		);
	});

	it("returns preflight errors as JSON and skips orchestration", async () => {
		mocks.preflightChatTurn.mockResolvedValueOnce({
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
		expect(runChatStreamOrchestrator).not.toHaveBeenCalled();
	});
});
