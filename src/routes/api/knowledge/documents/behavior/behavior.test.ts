import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge/store", () => ({
	getArtifactsForUser: vi.fn(),
}));

vi.mock("$lib/server/services/memory-events", () => ({
	recordMemoryEvent: vi.fn(),
}));

vi.mock("$lib/server/services/document-resolution", () => ({
	getDocumentBehaviorKey: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getDocumentBehaviorKey } from "$lib/server/services/document-resolution";
import { getArtifactsForUser } from "$lib/server/services/knowledge/store";
import { recordMemoryEvent } from "$lib/server/services/memory-events";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetArtifactsForUser = getArtifactsForUser as ReturnType<typeof vi.fn>;
const mockRecordMemoryEvent = recordMemoryEvent as ReturnType<typeof vi.fn>;
const mockGetDocumentBehaviorKey = getDocumentBehaviorKey as ReturnType<
	typeof vi.fn
>;
type DocumentBehaviorEvent = Parameters<typeof POST>[0];

function makeEvent(
	body: unknown,
	user = { id: "user-1", email: "test@example.com" },
): DocumentBehaviorEvent {
	return {
		request: new Request("http://localhost/api/knowledge/documents/behavior", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user },
		url: new URL("http://localhost/api/knowledge/documents/behavior"),
		route: { id: "/api/knowledge/documents/behavior" },
	} as DocumentBehaviorEvent;
}

describe("POST /api/knowledge/documents/behavior", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetDocumentBehaviorKey.mockReturnValue("family-brief");
	});

	it("returns 401 for unauthorized requests", async () => {
		mockRequireAuth.mockImplementation(() => {
			throw new Error("Unauthorized");
		});

		const response = await POST(
			makeEvent({ action: "workspace_opened", artifactId: "artifact-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data.error).toMatch(/unauthorized/i);
	});

	it("returns 400 when the payload is invalid", async () => {
		const response = await POST(makeEvent({ artifactId: "artifact-1" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/invalid document behavior payload/i);
	});

	it("returns 404 when the artifact is not found", async () => {
		mockGetArtifactsForUser.mockResolvedValue([]);

		const response = await POST(
			makeEvent({ action: "workspace_opened", artifactId: "artifact-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toMatch(/artifact not found/i);
	});

	it("records a deduplicated document-opened memory event", async () => {
		mockGetArtifactsForUser.mockResolvedValue([
			{
				id: "artifact-1",
				type: "generated_output",
				conversationId: "conv-1",
				metadata: { documentFamilyId: "family-brief" },
			},
		]);

		const response = await POST(
			makeEvent({ action: "workspace_opened", artifactId: "artifact-1" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ success: true });
		expect(mockGetArtifactsForUser).toHaveBeenCalledWith("user-1", [
			"artifact-1",
		]);
		expect(mockGetDocumentBehaviorKey).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "artifact-1",
			}),
		);
		expect(mockRecordMemoryEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				domain: "document",
				eventType: "document_opened",
				subjectId: "family-brief",
				relatedId: "artifact-1",
				conversationId: "conv-1",
				payload: {
					action: "workspace_opened",
					artifactType: "generated_output",
				},
			}),
		);
		expect(
			(
				mockRecordMemoryEvent.mock.calls[0]?.[0] as
					| { eventKey?: string }
					| undefined
			)?.eventKey,
		).toMatch(/^document_opened:family-brief:\d+$/);
	});
});
