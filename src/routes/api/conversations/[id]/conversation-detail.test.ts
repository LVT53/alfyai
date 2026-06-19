import { error, redirect } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversation-detail/read-model", () => ({
	getConversationDetail: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	updateConversationTitle: vi.fn(),
	moveConversationToProject: vi.fn(),
	setConversationSidebarPinned: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getConversationDetail } from "$lib/server/services/conversation-detail/read-model";
import {
	moveConversationToProject,
	setConversationSidebarPinned,
} from "$lib/server/services/conversations";
import { GET, PATCH } from "./+server";
import type { RequestEvent } from "./$types";

const mockRequireAuth = vi.mocked(requireAuth);
const mockGetConversationDetail = vi.mocked(getConversationDetail);
const mockMoveConversationToProject = vi.mocked(moveConversationToProject);
const mockSetConversationSidebarPinned = vi.mocked(
	setConversationSidebarPinned,
);

function makeEvent(
	user: { id: string } | null = { id: "user-1" },
	id = "conv-1",
	url = `http://localhost/api/conversations/${id}`,
): RequestEvent {
	return {
		request: new Request(url),
		locals: { user },
		params: { id },
		url: new URL(url),
		route: { id: "/api/conversations/[id]" },
	} as unknown as RequestEvent;
}

function makePatchEvent(
	body: unknown,
	user = { id: "user-1" },
	id = "conv-1",
): RequestEvent {
	return {
		request: new Request(`http://localhost/api/conversations/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}`),
		route: { id: "/api/conversations/[id]" },
	} as unknown as RequestEvent;
}

describe("GET /api/conversations/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversationDetail.mockResolvedValue({
			conversation: {
				id: "conv-1",
				title: "Quarterly report",
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
				createdAt: 1_777_140_000,
				updatedAt: 1_777_140_001,
			},
			messages: [],
			bootstrap: false,
		});
	});

	it("returns 401 when no authenticated user is present", async () => {
		const response = await GET(makeEvent(null));
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data).toEqual({ error: "Unauthorized" });
		expect(mockGetConversationDetail).not.toHaveBeenCalled();
	});

	it("propagates authentication redirects instead of treating them as detail read failures", async () => {
		mockRequireAuth.mockImplementation(() => {
			throw { status: 302, location: "/login" };
		});

		await expect(GET(makeEvent(null))).rejects.toMatchObject({
			status: 302,
			location: "/login",
		});
		expect(mockGetConversationDetail).not.toHaveBeenCalled();
	});

	it("propagates SvelteKit HTTP errors from delegated detail loading", async () => {
		let httpError: unknown;
		try {
			error(403, "Forbidden");
		} catch (err) {
			httpError = err;
		}
		mockGetConversationDetail.mockRejectedValue(httpError);

		await expect(GET(makeEvent())).rejects.toMatchObject({
			status: 403,
			body: { message: "Forbidden" },
		});
	});

	it("propagates SvelteKit redirects from delegated detail loading", async () => {
		let redirectError: unknown;
		try {
			redirect(307, "/login");
		} catch (err) {
			redirectError = err;
		}
		mockGetConversationDetail.mockRejectedValue(redirectError);

		await expect(GET(makeEvent())).rejects.toMatchObject({
			status: 307,
			location: "/login",
		});
	});

	it("delegates full detail loading to the read model", async () => {
		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockGetConversationDetail).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			view: "full",
		});
		expect(data).toMatchObject({
			conversation: {
				id: "conv-1",
				title: "Quarterly report",
			},
			messages: [],
			bootstrap: false,
		});
	});

	it("delegates bootstrap detail loading when requested", async () => {
		mockGetConversationDetail.mockResolvedValue({
			conversation: {
				id: "conv-1",
				title: "Quarterly report",
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
				createdAt: 1_777_140_000,
				updatedAt: 1_777_140_001,
			},
			messages: [],
			attachedArtifacts: [],
			activeWorkingSet: [],
			contextStatus: null,
			contextSources: null,
			taskState: null,
			contextDebug: null,
			draft: null,
			fileProductionJobs: [],
			contextCompressionSnapshots: [],
			activeSkillSession: null,
			bootstrap: true,
		});

		const response = await GET(
			makeEvent(
				{ id: "user-1" },
				"conv-1",
				"http://localhost/api/conversations/conv-1?view=bootstrap",
			),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockGetConversationDetail).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			view: "bootstrap",
		});
		expect(data.bootstrap).toBe(true);
	});

	it("delegates first-render detail loading when requested", async () => {
		mockGetConversationDetail.mockResolvedValue({
			conversation: {
				id: "conv-1",
				title: "Quarterly report",
				projectId: null,
				sidebarPinned: false,
				sidebarSortOrder: null,
				createdAt: 1_777_140_000,
				updatedAt: 1_777_140_001,
			},
			messages: [],
			attachedArtifacts: [],
			activeWorkingSet: [],
			contextStatus: null,
			contextSources: null,
			taskState: null,
			contextDebug: null,
			draft: null,
			fileProductionJobs: [],
			contextCompressionSnapshots: [],
			activeSkillSession: null,
			bootstrap: false,
			sidecarPending: true,
		});

		const response = await GET(
			makeEvent(
				{ id: "user-1" },
				"conv-1",
				"http://localhost/api/conversations/conv-1?view=first-render",
			),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockGetConversationDetail).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			view: "first-render",
		});
		expect(data.sidecarPending).toBe(true);
	});

	it("returns 404 when the read model cannot find the conversation", async () => {
		mockGetConversationDetail.mockResolvedValue(null);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data).toEqual({ error: "Conversation not found" });
	});

	it("logs and returns 500 when detail loading fails", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const error = new Error("detail read failed");
		mockGetConversationDetail.mockRejectedValue(error);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(500);
		expect(data).toEqual({ error: "Failed to load conversation" });
		expect(errorSpy).toHaveBeenCalledWith("Error loading conversation:", error);

		errorSpy.mockRestore();
	});
});

describe("PATCH /api/conversations/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockMoveConversationToProject.mockResolvedValue({
			id: "conv-1",
			title: "Quarterly report",
			projectId: "folder-1",
			sidebarPinned: false,
			sidebarSortOrder: null,
			createdAt: 1_777_140_000,
			updatedAt: 1_777_140_001,
		});
		mockSetConversationSidebarPinned.mockResolvedValue({
			id: "conv-1",
			title: "Quarterly report",
			projectId: null,
			sidebarPinned: true,
			sidebarSortOrder: 0,
			createdAt: 1_777_140_000,
			updatedAt: 1_777_140_001,
		});
	});

	it("moves project assignment through the conversation move operation", async () => {
		const response = await PATCH(makePatchEvent({ projectId: "folder-1" }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockMoveConversationToProject).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"folder-1",
		);
		expect(data).toMatchObject({
			id: "conv-1",
			projectId: "folder-1",
		});
	});

	it("updates sidebar pin state through the conversation sidebar operation", async () => {
		const response = await PATCH(makePatchEvent({ sidebarPinned: true }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockSetConversationSidebarPinned).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			true,
		);
		expect(data).toMatchObject({
			id: "conv-1",
			sidebarPinned: true,
			sidebarSortOrder: 0,
		});
	});
});
