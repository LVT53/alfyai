import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	createConversation: vi.fn(),
	listConversations: vi.fn(),
}));

vi.mock("$lib/server/services/projects", () => ({
	getProject: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	createConversation,
	listConversations,
} from "$lib/server/services/conversations";
import { getProject } from "$lib/server/services/projects";
import { type GET, POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCreateConversation = createConversation as ReturnType<typeof vi.fn>;
const mockListConversations = listConversations as ReturnType<typeof vi.fn>;
const mockGetProject = getProject as ReturnType<typeof vi.fn>;

function makeEvent(body?: unknown) {
	return {
		request: new Request("http://localhost/api/conversations", {
			method: body === undefined ? "GET" : "POST",
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: { user: { id: "owner-user", role: "user", uiLanguage: "en" } },
		params: {},
		url: new URL("http://localhost/api/conversations"),
		route: { id: "/api/conversations" },
	} as Parameters<typeof GET>[0] & Parameters<typeof POST>[0];
}

describe("/api/conversations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockListConversations.mockResolvedValue([]);
		mockGetProject.mockResolvedValue({
			id: "project-1",
			name: "Project",
		});
		mockCreateConversation.mockResolvedValue({
			id: "conv-1",
			title: "New Conversation",
			projectId: "project-1",
			createdAt: 1,
			updatedAt: 1,
		});
	});

	it("creates a conversation inside an owned project folder", async () => {
		const response = await POST(makeEvent({ projectId: "project-1" }));
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data).toMatchObject({ id: "conv-1", projectId: "project-1" });
		expect(mockGetProject).toHaveBeenCalledWith("owner-user", "project-1");
		expect(mockCreateConversation).toHaveBeenCalledWith(
			"owner-user",
			undefined,
			{
				projectId: "project-1",
			},
		);
	});

	it("rejects unknown project folders before creating a conversation", async () => {
		mockGetProject.mockResolvedValue(null);

		const response = await POST(makeEvent({ projectId: "missing-project" }));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBe("Project not found");
		expect(mockCreateConversation).not.toHaveBeenCalled();
	});

	it("rejects invalid project ids", async () => {
		const response = await POST(makeEvent({ projectId: 12 }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe("projectId must be a string or null");
		expect(mockGetProject).not.toHaveBeenCalled();
		expect(mockCreateConversation).not.toHaveBeenCalled();
	});
});
