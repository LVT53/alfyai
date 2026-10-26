import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	moveConversationsToProject: vi.fn(),
	setConversationsSidebarPinned: vi.fn(),
}));

vi.mock("$lib/server/services/cleanup", () => ({
	deleteConversationsWithCleanup: vi.fn(),
}));

vi.mock("$lib/server/services/home-summary", () => ({
	invalidateHomeSummary: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { deleteConversationsWithCleanup } from "$lib/server/services/cleanup";
import {
	moveConversationsToProject,
	setConversationsSidebarPinned,
} from "$lib/server/services/conversations";
import { invalidateHomeSummary } from "$lib/server/services/home-summary";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockDeleteConversationsWithCleanup =
	deleteConversationsWithCleanup as ReturnType<typeof vi.fn>;
const mockMoveConversationsToProject = moveConversationsToProject as ReturnType<
	typeof vi.fn
>;
const mockSetConversationsSidebarPinned =
	setConversationsSidebarPinned as ReturnType<typeof vi.fn>;
const mockInvalidateHomeSummary = invalidateHomeSummary as ReturnType<
	typeof vi.fn
>;

type BatchEvent = Parameters<typeof POST>[0];

// `body` undefined sends a request with no body at all; anything else is sent
// as JSON.
function makeEvent(
	body?: unknown,
	options: { signedIn?: boolean } = {},
): BatchEvent {
	const signedIn = options.signedIn ?? true;
	return {
		request: new Request("http://localhost/api/conversations/batch", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		locals: signedIn
			? { user: { id: "user-1", role: "user", uiLanguage: "en" } }
			: {},
		params: {},
		url: new URL("http://localhost/api/conversations/batch"),
		route: { id: "/api/conversations/batch" },
	} as unknown as BatchEvent;
}

function ids(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `conv-${index + 1}`);
}

function expectNothingWasDone() {
	expect(mockDeleteConversationsWithCleanup).not.toHaveBeenCalled();
	expect(mockMoveConversationsToProject).not.toHaveBeenCalled();
	expect(mockSetConversationsSidebarPinned).not.toHaveBeenCalled();
	expect(mockInvalidateHomeSummary).not.toHaveBeenCalled();
}

describe("POST /api/conversations/batch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockDeleteConversationsWithCleanup.mockResolvedValue([]);
		mockMoveConversationsToProject.mockResolvedValue([]);
		mockSetConversationsSidebarPinned.mockResolvedValue([]);
	});

	describe("an invalid body", () => {
		const invalidBodies: Array<[string, unknown]> = [
			["no body", undefined],
			["a body that is not an object", ["delete"]],
			["a null body", null],
			["an unknown action", { action: "archive", ids: ["a"] }],
			["no action", { ids: ["a"] }],
			["ids missing", { action: "delete" }],
			["ids empty", { action: "delete", ids: [] }],
			["ids not an array", { action: "delete", ids: "a" }],
			["ids holding an empty string", { action: "delete", ids: ["a", ""] }],
			["ids holding blank text", { action: "delete", ids: ["a", "   "] }],
			["ids holding a number", { action: "delete", ids: ["a", 7] }],
			["ids holding null", { action: "pin", ids: ["a", null], pinned: true }],
			["51 ids", { action: "delete", ids: ids(51) }],
			["a move without a projectId", { action: "move", ids: ["a"] }],
			[
				"a move with a numeric projectId",
				{ action: "move", ids: ["a"], projectId: 7 },
			],
			[
				"a move with an empty projectId",
				{ action: "move", ids: ["a"], projectId: "" },
			],
			["a pin without pinned", { action: "pin", ids: ["a"] }],
			[
				"a pin with pinned as text",
				{ action: "pin", ids: ["a"], pinned: "yes" },
			],
		];

		it.each(invalidBodies)("answers 400 for %s", async (_name, body) => {
			const response = await POST(makeEvent(body));
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(typeof data.error).toBe("string");
			expectNothingWasDone();
		});
	});

	it("answers 401 without a signed-in user", async () => {
		const response = await POST(
			makeEvent({ action: "delete", ids: ["a"] }, { signedIn: false }),
		);

		expect(response.status).toBe(401);
		expect(mockRequireAuth).toHaveBeenCalled();
		expectNothingWasDone();
	});

	it("takes exactly 50 ids", async () => {
		const fifty = ids(50);

		const response = await POST(makeEvent({ action: "delete", ids: fifty }));

		expect(response.status).toBe(200);
		expect(mockDeleteConversationsWithCleanup).toHaveBeenCalledWith(
			"user-1",
			fifty,
		);
	});

	it("drops duplicate ids and trims the rest, keeping the first-seen order", async () => {
		const response = await POST(
			makeEvent({ action: "delete", ids: ["a", " b ", "a", "b", " a"] }),
		);

		expect(response.status).toBe(200);
		expect(mockDeleteConversationsWithCleanup).toHaveBeenCalledWith("user-1", [
			"a",
			"b",
		]);
	});

	describe("delete", () => {
		it("deletes each chat for the signed-in user and answers with the results", async () => {
			const results = [
				{ id: "a", ok: true },
				{ id: "b", ok: false, error: "not_found" },
				{ id: "c", ok: false, error: "failed" },
			];
			mockDeleteConversationsWithCleanup.mockResolvedValue(results);

			const response = await POST(
				makeEvent({ action: "delete", ids: ["a", "b", "c"] }),
			);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data).toEqual({ results });
			expect(mockDeleteConversationsWithCleanup).toHaveBeenCalledWith(
				"user-1",
				["a", "b", "c"],
			);
			expect(mockMoveConversationsToProject).not.toHaveBeenCalled();
			expect(mockSetConversationsSidebarPinned).not.toHaveBeenCalled();
		});

		// The new-chat page's Recent row is read from a summary held for 30
		// seconds, so a delete that went through has to drop it, once.
		it("drops the home summary once when any chat was deleted", async () => {
			mockDeleteConversationsWithCleanup.mockResolvedValue([
				{ id: "a", ok: true },
				{ id: "b", ok: true },
				{ id: "c", ok: false, error: "failed" },
			]);

			await POST(makeEvent({ action: "delete", ids: ["a", "b", "c"] }));

			expect(mockInvalidateHomeSummary).toHaveBeenCalledTimes(1);
			expect(mockInvalidateHomeSummary).toHaveBeenCalledWith("user-1");
		});

		it("leaves the home summary alone when no chat was deleted", async () => {
			mockDeleteConversationsWithCleanup.mockResolvedValue([
				{ id: "a", ok: false, error: "not_found" },
				{ id: "b", ok: false, error: "failed" },
			]);

			const response = await POST(
				makeEvent({ action: "delete", ids: ["a", "b"] }),
			);

			expect(response.status).toBe(200);
			expect(mockInvalidateHomeSummary).not.toHaveBeenCalled();
		});
	});

	describe("move", () => {
		it("moves the chats into the project and answers with the results", async () => {
			const results = [
				{
					id: "a",
					ok: true,
					conversation: { id: "a", projectId: "project-1" },
				},
				{ id: "b", ok: false, error: "not_found" },
			];
			mockMoveConversationsToProject.mockResolvedValue(results);

			const response = await POST(
				makeEvent({
					action: "move",
					ids: ["a", "b"],
					projectId: " project-1 ",
				}),
			);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data).toEqual({ results });
			expect(mockMoveConversationsToProject).toHaveBeenCalledWith(
				"user-1",
				["a", "b"],
				"project-1",
			);
			expect(mockDeleteConversationsWithCleanup).not.toHaveBeenCalled();
			expect(mockSetConversationsSidebarPinned).not.toHaveBeenCalled();
		});

		it("takes the chats out of any project with a null projectId", async () => {
			const results = [
				{ id: "a", ok: true, conversation: { id: "a", projectId: null } },
			];
			mockMoveConversationsToProject.mockResolvedValue(results);

			const response = await POST(
				makeEvent({ action: "move", ids: ["a"], projectId: null }),
			);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data).toEqual({ results });
			expect(mockMoveConversationsToProject).toHaveBeenCalledWith(
				"user-1",
				["a"],
				null,
			);
		});

		it("answers 404 for a project that is not the person's own", async () => {
			mockMoveConversationsToProject.mockResolvedValue(null);

			const response = await POST(
				makeEvent({ action: "move", ids: ["a"], projectId: "someone-elses" }),
			);
			const data = await response.json();

			expect(response.status).toBe(404);
			expect(data).toEqual({ error: "Project not found" });
		});
	});

	describe("pin", () => {
		it.each([
			true,
			false,
		])("sets the pin to %s for the chats and answers with the results", async (pinned) => {
			const results = [
				{
					id: "a",
					ok: true,
					conversation: { id: "a", sidebarPinned: pinned },
				},
				{ id: "b", ok: false, error: "not_found" },
			];
			mockSetConversationsSidebarPinned.mockResolvedValue(results);

			const response = await POST(
				makeEvent({ action: "pin", ids: ["a", "b"], pinned }),
			);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data).toEqual({ results });
			expect(mockSetConversationsSidebarPinned).toHaveBeenCalledWith(
				"user-1",
				["a", "b"],
				pinned,
			);
			expect(mockDeleteConversationsWithCleanup).not.toHaveBeenCalled();
			expect(mockMoveConversationsToProject).not.toHaveBeenCalled();
		});
	});

	describe("a service that throws", () => {
		it.each([
			[
				"delete",
				{ action: "delete", ids: ["a"] },
				mockDeleteConversationsWithCleanup,
			],
			[
				"move",
				{ action: "move", ids: ["a"], projectId: "project-1" },
				mockMoveConversationsToProject,
			],
			[
				"pin",
				{ action: "pin", ids: ["a"], pinned: true },
				mockSetConversationsSidebarPinned,
			],
		])("answers 500 for a %s", async (_action, body, service) => {
			service.mockRejectedValue(new Error("database is locked"));
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);

			try {
				const response = await POST(makeEvent(body));
				const data = await response.json();

				expect(response.status).toBe(500);
				expect(data).toEqual({ error: "Failed to apply batch action" });
				expect(mockInvalidateHomeSummary).not.toHaveBeenCalled();
			} finally {
				consoleError.mockRestore();
			}
		});
	});
});
