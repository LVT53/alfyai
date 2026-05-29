import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
	getConversationUserId: vi.fn(),
}));

vi.mock("$lib/server/services/file-production", () => ({
	getFileProductionIntakeConversationId: vi.fn(),
	submitFileProductionIntake: vi.fn(),
}));

vi.mock("$lib/server/auth/hooks", () => ({
	verifyFileProductionServiceAssertion: vi.fn(),
}));

import { verifyFileProductionServiceAssertion } from "$lib/server/auth/hooks";
import {
	getConversation,
	getConversationUserId,
} from "$lib/server/services/conversations";
import {
	getFileProductionIntakeConversationId,
	submitFileProductionIntake,
} from "$lib/server/services/file-production";
import { POST } from "./+server";

type ProduceRouteEvent = Parameters<typeof POST>[0];

const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockGetConversationUserId = getConversationUserId as ReturnType<
	typeof vi.fn
>;
const mockGetFileProductionIntakeConversationId =
	getFileProductionIntakeConversationId as ReturnType<typeof vi.fn>;
const mockSubmitFileProductionIntake = submitFileProductionIntake as ReturnType<
	typeof vi.fn
>;
const mockVerifyFileProductionServiceAssertion =
	verifyFileProductionServiceAssertion as ReturnType<typeof vi.fn>;

const queuedJob = {
	id: "job-1",
	conversationId: "conv-1",
	assistantMessageId: null,
	title: "CSV export",
	status: "queued",
	stage: null,
	createdAt: 1,
	updatedAt: 1,
	files: [],
	warnings: [],
	error: null,
};

function makeEvent(
	body: unknown,
	user: { id: string } | null = { id: "user-1" },
	headers: Record<string, string> = {},
) {
	return {
		request: new Request("http://localhost/api/chat/files/produce", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/chat/files/produce"),
		route: { id: "/api/chat/files/produce" },
	} as unknown as ProduceRouteEvent;
}

function makeInvalidJsonEvent(user: { id: string } | null = { id: "user-1" }) {
	return {
		request: new Request("http://localhost/api/chat/files/produce", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{",
		}),
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/chat/files/produce"),
		route: { id: "/api/chat/files/produce" },
	} as unknown as ProduceRouteEvent;
}

describe("POST /api/chat/files/produce", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetFileProductionIntakeConversationId.mockReturnValue({
			ok: true,
			conversationId: "conv-1",
		});
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			title: "Files",
			createdAt: 1,
			updatedAt: 1,
		});
		mockGetConversationUserId.mockResolvedValue("user-1");
		mockSubmitFileProductionIntake.mockResolvedValue({
			ok: true,
			status: 202,
			reused: false,
			job: queuedJob,
		});
		mockVerifyFileProductionServiceAssertion.mockReturnValue(null);
	});

	it("returns 400 for unreadable JSON without calling intake", async () => {
		const response = await POST(makeInvalidJsonEvent());
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data).toEqual({ error: "Invalid JSON body" });
		expect(mockGetFileProductionIntakeConversationId).not.toHaveBeenCalled();
		expect(mockSubmitFileProductionIntake).not.toHaveBeenCalled();
	});

	it("translates intake conversation-id parsing failures", async () => {
		mockGetFileProductionIntakeConversationId.mockReturnValueOnce({
			ok: false,
			status: 400,
			code: "missing_conversation_id",
			error: "conversationId is required",
		});

		const response = await POST(makeEvent({ requestTitle: "CSV export" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data).toEqual({ error: "conversationId is required" });
		expect(mockGetConversation).not.toHaveBeenCalled();
		expect(mockSubmitFileProductionIntake).not.toHaveBeenCalled();
	});

	it("delegates accepted signed-in requests to file-production intake", async () => {
		const body = {
			conversationId: "conv-1",
			idempotencyKey: "turn-1:file-1",
			requestTitle: "CSV export",
			sourceMode: "program",
			outputs: [{ type: "csv" }],
			program: {
				language: "python",
				sourceCode:
					'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
			},
		};

		const response = await POST(makeEvent(body));
		const data = await response.json();

		expect(response.status).toBe(202);
		expect(mockGetFileProductionIntakeConversationId).toHaveBeenCalledWith(
			body,
		);
		expect(mockGetConversation).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mockSubmitFileProductionIntake).toHaveBeenCalledWith({
			userId: "user-1",
			body,
		});
		expect(data).toEqual({
			job: queuedJob,
			reused: false,
		});
	});

	it("translates durable intake failures without route-local validation", async () => {
		const failedJob = {
			...queuedJob,
			id: "job-failed",
			title: "Broken export",
			status: "failed",
			error: {
				code: "invalid_program_language",
				message: "program.language must be python or javascript",
				retryable: false,
			},
		};
		mockSubmitFileProductionIntake.mockResolvedValueOnce({
			ok: false,
			status: 422,
			code: "invalid_program_language",
			error: "program.language must be python or javascript",
			job: failedJob,
		});

		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				idempotencyKey: "turn-1:bad-file",
				requestTitle: "Broken export",
				sourceMode: "program",
				program: {
					language: "ruby",
					sourceCode: 'puts "bad"',
				},
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(422);
		expect(data).toEqual({
			error: "program.language must be python or javascript",
			job: failedJob,
		});
	});

	it("returns 401 when neither a user nor service assertion is present", async () => {
		const response = await POST(makeEvent({ conversationId: "conv-1" }, null));
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data).toEqual({ error: "Unauthorized" });
		expect(mockSubmitFileProductionIntake).not.toHaveBeenCalled();
	});

	it("returns 404 when the signed-in user does not own the conversation", async () => {
		mockGetConversation.mockResolvedValueOnce(null);

		const response = await POST(makeEvent({ conversationId: "conv-1" }));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data).toEqual({ error: "Conversation not found" });
		expect(mockSubmitFileProductionIntake).not.toHaveBeenCalled();
	});

	it("accepts a valid conversation-scoped service assertion", async () => {
		mockVerifyFileProductionServiceAssertion.mockReturnValueOnce({
			valid: true,
			claims: {
				conversationId: "conv-1",
			},
		});
		const body = {
			conversationId: "conv-1",
			idempotencyKey: "turn-1:file-1",
			requestTitle: "CSV export",
			sourceMode: "program",
			outputs: [{ type: "csv" }],
			program: {
				language: "python",
				sourceCode:
					'from pathlib import Path\nPath("/output/data.csv").write_text("a,b\\n1,2")',
			},
		};

		const response = await POST(
			makeEvent(body, null, { authorization: "Bearer service-token" }),
		);
		const data = await response.json();

		expect(response.status).toBe(202);
		expect(mockVerifyFileProductionServiceAssertion).toHaveBeenCalledWith(
			"Bearer service-token",
		);
		expect(mockGetConversationUserId).toHaveBeenCalledWith("conv-1");
		expect(mockSubmitFileProductionIntake).toHaveBeenCalledWith({
			userId: "user-1",
			body,
		});
		expect(data).toEqual({
			job: queuedJob,
			reused: false,
		});
	});

	it("rejects service assertions scoped to another conversation", async () => {
		mockVerifyFileProductionServiceAssertion.mockReturnValueOnce({
			valid: true,
			claims: {
				conversationId: "other-conv",
			},
		});

		const response = await POST(
			makeEvent({ conversationId: "conv-1" }, null, {
				authorization: "Bearer service-token",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data).toEqual({ error: "Unauthorized" });
		expect(mockSubmitFileProductionIntake).not.toHaveBeenCalled();
	});
});
