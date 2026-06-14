import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge", () => ({
	deleteKnowledgeArtifactsByAction: vi.fn(),
}));

vi.mock("$lib/server/services/cleanup", () => ({
	resetKnowledgeBaseState: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { resetKnowledgeBaseState } from "$lib/server/services/cleanup";
import { deleteKnowledgeArtifactsByAction } from "$lib/server/services/knowledge";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockDeleteKnowledgeArtifactsByAction =
	deleteKnowledgeArtifactsByAction as ReturnType<typeof vi.fn>;
const mockResetKnowledgeBaseState = resetKnowledgeBaseState as ReturnType<
	typeof vi.fn
>;
type KnowledgeActionsEvent = Parameters<typeof POST>[0];

function makeEvent(body: unknown): KnowledgeActionsEvent {
	return {
		request: new Request("http://localhost/api/knowledge/actions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1", displayName: "Test User" } },
		params: {},
		url: new URL("http://localhost/api/knowledge/actions"),
		route: { id: "/api/knowledge/actions" },
	} as KnowledgeActionsEvent;
}

describe("POST /api/knowledge/actions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("bulk-forgets all documents", async () => {
		mockDeleteKnowledgeArtifactsByAction.mockResolvedValue({
			deletedArtifactIds: ["doc-1", "doc-2"],
		});

		const response = await POST(makeEvent({ action: "forget_all_documents" }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.deletedArtifactIds).toEqual(["doc-1", "doc-2"]);
		expect(mockDeleteKnowledgeArtifactsByAction).toHaveBeenCalledWith(
			"user-1",
			"forget_all_documents",
		);
	});

	it("bulk-forgets generated results", async () => {
		mockDeleteKnowledgeArtifactsByAction.mockResolvedValue({
			deletedArtifactIds: ["result-1"],
		});

		const response = await POST(makeEvent({ action: "forget_all_results" }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.deletedArtifactIds).toEqual(["result-1"]);
		expect(mockDeleteKnowledgeArtifactsByAction).toHaveBeenCalledWith(
			"user-1",
			"forget_all_results",
		);
	});

	it("bulk-forgets workflows", async () => {
		mockDeleteKnowledgeArtifactsByAction.mockResolvedValue({
			deletedArtifactIds: ["workflow-1"],
		});

		const response = await POST(makeEvent({ action: "forget_all_workflows" }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.deletedArtifactIds).toEqual(["workflow-1"]);
		expect(mockDeleteKnowledgeArtifactsByAction).toHaveBeenCalledWith(
			"user-1",
			"forget_all_workflows",
		);
	});

	it("resets all KB memory and artifacts without deleting conversations", async () => {
		mockResetKnowledgeBaseState.mockResolvedValue({
			deletedArtifactIds: ["doc-1", "result-1"],
		});

		const response = await POST(makeEvent({ action: "forget_everything" }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.deletedArtifactIds).toEqual(["doc-1", "result-1"]);
		expect(mockResetKnowledgeBaseState).toHaveBeenCalledWith("user-1");
	});

	it("rejects invalid action payloads", async () => {
		const response = await POST(makeEvent({ action: "wipe_it_all" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/invalid knowledge action payload/i);
	});
});
