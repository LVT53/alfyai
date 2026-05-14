import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	verifyFileProductionServiceAssertion: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		query: {
			conversations: {
				findFirst: vi.fn(),
			},
		},
	},
}));

vi.mock("$lib/server/services/project-context", () => ({
	getProjectContext: vi.fn(),
}));

import { verifyFileProductionServiceAssertion } from "$lib/server/auth/hooks";
import { db } from "$lib/server/db";
import { getProjectContext } from "$lib/server/services/project-context";
import { POST } from "./+server";

const mockVerifyFileProductionServiceAssertion =
	verifyFileProductionServiceAssertion as ReturnType<typeof vi.fn>;
const mockFindConversation = db.query.conversations.findFirst as ReturnType<
	typeof vi.fn
>;
const mockGetProjectContext = getProjectContext as ReturnType<typeof vi.fn>;

type ProjectContextEvent = Parameters<typeof POST>[0];

function makeEvent(
	body: unknown,
	user: { id: string; email?: string } | null = {
		id: "user-1",
		email: "test@example.com",
	},
	authorization?: string,
) {
	return {
		request: new Request("http://localhost/api/tools/project-context", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(authorization ? { Authorization: authorization } : {}),
			},
			body: JSON.stringify(body),
		}),
		locals: { user },
		params: {},
		url: new URL("http://localhost/api/tools/project-context"),
		route: { id: "/api/tools/project-context" },
	} as unknown as ProjectContextEvent;
}

describe("POST /api/tools/project-context", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindConversation.mockResolvedValue({ id: "conv-1", userId: "user-1" });
		mockVerifyFileProductionServiceAssertion.mockReturnValue({
			valid: true,
			claims: {
				conversationId: "conv-1",
				userId: "user-1",
				exp: Date.now() + 60_000,
			},
		});
		mockGetProjectContext.mockResolvedValue({
			success: true,
			mode: "summary",
			hasProjectContext: true,
			source: "project_folder",
			project: {
				id: "project-1",
				name: "Launch Plan",
				authority: "project_folder",
			},
			siblings: [],
			omittedSiblingCount: 0,
			evidenceCandidates: [],
			audit: {
				conversationId: "conv-1",
				scope: "conversation",
				requestedMaxSiblings: null,
				appliedMaxSiblings: 5,
				includeEvidenceCandidates: true,
			},
		});
	});

	it("returns project context for an authenticated conversation-scoped request", async () => {
		const response = await POST(
			makeEvent({
				conversationId: "conv-1",
				mode: "summary",
				query: "pricing",
				maxSiblings: 3,
				includeEvidenceCandidates: false,
			}),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.project.name).toBe("Launch Plan");
		expect(mockGetProjectContext).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			mode: "summary",
			query: "pricing",
			maxSiblings: 3,
			includeEvidenceCandidates: false,
		});
	});

	it("accepts a valid signed service assertion scoped to the same conversation", async () => {
		const response = await POST(
			makeEvent(
				{ conversationId: "conv-1", mode: "summary" },
				null,
				"Bearer signed",
			),
		);

		expect(response.status).toBe(200);
		expect(mockVerifyFileProductionServiceAssertion).toHaveBeenCalledWith(
			"Bearer signed",
		);
		expect(mockGetProjectContext).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
			}),
		);
	});

	it("rejects missing or invalid service authentication", async () => {
		const missing = await POST(
			makeEvent({ conversationId: "conv-1" }, null),
		);
		expect(missing.status).toBe(401);

		mockVerifyFileProductionServiceAssertion.mockReturnValueOnce({
			valid: false,
			reason: "invalid_signature",
		});
		const invalid = await POST(
			makeEvent({ conversationId: "conv-1" }, null, "Bearer bad"),
		);
		expect(invalid.status).toBe(401);
	});

	it("rejects service assertions for a different conversation", async () => {
		mockVerifyFileProductionServiceAssertion.mockReturnValueOnce({
			valid: true,
			claims: {
				conversationId: "conv-other",
				userId: "user-1",
				exp: Date.now() + 60_000,
			},
		});

		const response = await POST(
			makeEvent({ conversationId: "conv-1" }, null, "Bearer wrong-conv"),
		);

		expect(response.status).toBe(401);
		expect(mockGetProjectContext).not.toHaveBeenCalled();
	});

	it("rejects unsupported detail mode without calling the service", async () => {
		const response = await POST(
			makeEvent({ conversationId: "conv-1", mode: "detail" }),
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error).toMatch(/Only summary mode/);
		expect(mockGetProjectContext).not.toHaveBeenCalled();
	});
});
