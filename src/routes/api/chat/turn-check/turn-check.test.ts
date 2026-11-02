import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireAuth: vi.fn(),
	getConfig: vi.fn(),
	parseChatTurnRequest: vi.fn(),
	checkChatTurn: vi.fn(),
	runChatStreamOrchestrator: vi.fn(),
	preflightChatTurn: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: mocks.requireAuth,
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mocks.getConfig,
}));

vi.mock("$lib/server/services/chat-turn/request", () => ({
	parseChatTurnRequest: mocks.parseChatTurnRequest,
}));

vi.mock("$lib/server/services/chat-turn/preflight", () => ({
	checkChatTurn: mocks.checkChatTurn,
	preflightChatTurn: mocks.preflightChatTurn,
}));

vi.mock("$lib/server/services/chat-turn/stream-orchestrator", () => ({
	runChatStreamOrchestrator: mocks.runChatStreamOrchestrator,
}));

import { POST } from "./+server";

type CheckEvent = Parameters<typeof POST>[0];

const parsedRequest = {
	conversationId: "conv-1",
	normalizedMessage: "Edited words",
	modelId: "model1",
	attachmentIds: ["attachment-1"],
	pictureRefs: [],
	imageMarks: null,
	turnOrigin: "edit_resend",
};

function makeEvent(
	body: unknown,
	user: { id: string } | null = { id: "user-1" },
	signal?: AbortSignal,
): CheckEvent {
	return {
		request: new Request("http://localhost/api/chat/turn-check", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		}),
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/chat/turn-check"),
		route: { id: "/api/chat/turn-check" },
	} as CheckEvent;
}

describe("POST /api/chat/turn-check", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue({ maxMessageLength: 10_000 });
		mocks.parseChatTurnRequest.mockResolvedValue({
			ok: true,
			value: parsedRequest,
		});
		mocks.checkChatTurn.mockResolvedValue({ ok: true });
	});

	it("says ok for a turn the gate takes, having parsed the body the resend sends", async () => {
		const event = makeEvent({
			conversationId: "conv-1",
			message: "Edited words",
			attachmentIds: ["attachment-1"],
			isEditResend: true,
		});

		const response = await POST(event);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(mocks.requireAuth).toHaveBeenCalledWith(event);
		// The same parser as the stream route's, so the same body is read the same way.
		expect(mocks.parseChatTurnRequest).toHaveBeenCalledWith(
			event.request,
			{ maxMessageLength: 10_000 },
			"stream",
		);
		expect(mocks.checkChatTurn).toHaveBeenCalledWith({
			userId: "user-1",
			request: parsedRequest,
			signal: event.request.signal,
		});
	});

	it("refuses in the shape the turn's own refusal has, status and body", async () => {
		const refusal = {
			status: 422,
			error: "Photo.png does not contain enough readable text.",
			code: "attachment_not_ready",
			attachmentIds: ["attachment-1"],
			attachmentReadiness: [
				{
					artifactId: "attachment-1",
					name: "Photo.png",
					reason: "not_text_readable",
				},
			],
		};
		mocks.checkChatTurn.mockResolvedValue({ ok: false, error: refusal });

		const response = await POST(makeEvent({ conversationId: "conv-1" }));

		expect(response.status).toBe(422);
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(await response.json()).toEqual(refusal);
	});

	it("refuses a body the stream would refuse, without asking the gate", async () => {
		mocks.parseChatTurnRequest.mockResolvedValue({
			ok: false,
			error: { status: 400, error: "Message must be a non-empty string" },
		});

		const response = await POST(makeEvent({ conversationId: "conv-1" }));

		expect(response.status).toBe(400);
		// The stream route's own body for it, status field and all.
		expect(await response.json()).toEqual({
			status: 400,
			error: "Message must be a non-empty string",
		});
		expect(mocks.checkChatTurn).not.toHaveBeenCalled();
	});

	it("answers 401 to nobody, and starts no turn whatever it is asked", async () => {
		const response = await POST(makeEvent({ conversationId: "conv-1" }, null));

		expect(response.status).toBe(401);
		expect(mocks.parseChatTurnRequest).not.toHaveBeenCalled();
		expect(mocks.checkChatTurn).not.toHaveBeenCalled();
		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
		expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
	});

	it("never runs a turn: it only asks the gate", async () => {
		await POST(makeEvent({ conversationId: "conv-1", message: "Edited" }));

		expect(mocks.runChatStreamOrchestrator).not.toHaveBeenCalled();
		expect(mocks.preflightChatTurn).not.toHaveBeenCalled();
	});
});
