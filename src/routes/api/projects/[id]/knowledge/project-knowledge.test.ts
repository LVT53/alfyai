import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/projects", () => ({
	getProject: vi.fn(),
}));

vi.mock("$lib/server/services/knowledge", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/services/knowledge")>();
	return {
		...actual,
		linkProjectKnowledge: vi.fn(),
		listProjectKnowledge: vi.fn(),
		unlinkProjectKnowledge: vi.fn(),
	};
});

import { requireAuth } from "$lib/server/auth/hooks";
import {
	linkProjectKnowledge,
	listProjectKnowledge,
	ProjectKnowledgeError,
	unlinkProjectKnowledge,
} from "$lib/server/services/knowledge";
import { getProject } from "$lib/server/services/projects";
import { GET, POST } from "./+server";
import type { RequestEvent } from "./$types";
import { DELETE } from "./[artifactId]/+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetProject = getProject as ReturnType<typeof vi.fn>;
const mockListProjectKnowledge = listProjectKnowledge as ReturnType<
	typeof vi.fn
>;
const mockLinkProjectKnowledge = linkProjectKnowledge as ReturnType<
	typeof vi.fn
>;
const mockUnlinkProjectKnowledge = unlinkProjectKnowledge as ReturnType<
	typeof vi.fn
>;

const FILE_ROW = {
	artifactId: "artifact-railjet",
	name: "Railjet tickets.pdf",
	mimeType: "application/pdf",
	type: "source_document" as const,
	sizeBytes: 240_000,
	linkedAt: 1_800_000_000,
	summary: "Two tickets, Budapest to Vienna.",
};

function buildEvent(params: Record<string, string>, body?: unknown) {
	return {
		request: new Request(
			"http://localhost/api/projects/trip-project/knowledge",
			{
				method: body === undefined ? "GET" : "POST",
				headers: { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		),
		locals: { user: { id: "owner-user" } },
		params,
		url: new URL("http://localhost/api/projects/trip-project/knowledge"),
		route: { id: "/api/projects/[id]/knowledge" },
	};
}

function makeEvent(
	params: Record<string, string>,
	body?: unknown,
): RequestEvent {
	return buildEvent(params, body) as unknown as RequestEvent;
}

/**
 * The DELETE route lives one directory down, so its `RequestEvent` carries an
 * extra `artifactId` param and is a different type. Same object, cast once.
 */
function makeDeleteEvent(
	params: Record<string, string>,
): Parameters<typeof DELETE>[0] {
	return buildEvent(params) as unknown as Parameters<typeof DELETE>[0];
}

describe("GET /api/projects/[id]/knowledge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetProject.mockResolvedValue({
			id: "trip-project",
			name: "Vienna trip",
		});
		mockListProjectKnowledge.mockResolvedValue([FILE_ROW]);
	});

	it("returns the project's linked files", async () => {
		const response = await GET(makeEvent({ id: "trip-project" }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.files).toEqual([FILE_ROW]);
		expect(mockListProjectKnowledge).toHaveBeenCalledWith({
			userId: "owner-user",
			projectId: "trip-project",
		});
	});

	it("answers 401 without a signed-in user", async () => {
		const event = makeEvent({ id: "trip-project" });
		(event.locals as { user: unknown }).user = null;

		const response = await GET(event);

		expect(response.status).toBe(401);
		expect(mockGetProject).not.toHaveBeenCalled();
	});

	it("404s for a project that is not the caller's and reads no files", async () => {
		mockGetProject.mockResolvedValue(null);

		const response = await GET(makeEvent({ id: "other-project" }));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBeTruthy();
		expect(mockListProjectKnowledge).not.toHaveBeenCalled();
	});
});

describe("POST /api/projects/[id]/knowledge", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetProject.mockResolvedValue({
			id: "trip-project",
			name: "Vienna trip",
		});
		mockLinkProjectKnowledge.mockResolvedValue([FILE_ROW]);
	});

	it("links the given documents and answers with the project's files", async () => {
		const response = await POST(
			makeEvent({ id: "trip-project" }, { artifactIds: ["artifact-railjet"] }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockLinkProjectKnowledge).toHaveBeenCalledWith({
			userId: "owner-user",
			projectId: "trip-project",
			artifactIds: ["artifact-railjet"],
		});
		expect(data.files).toEqual([FILE_ROW]);
	});

	it("rejects an empty document list before touching the service", async () => {
		const response = await POST(
			makeEvent({ id: "trip-project" }, { artifactIds: [] }),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBeTruthy();
		expect(mockLinkProjectKnowledge).not.toHaveBeenCalled();
	});

	it("rejects a malformed document list before touching the service", async () => {
		for (const body of [
			{},
			{ artifactIds: "artifact-railjet" },
			{ artifactIds: [12] },
			{ artifactIds: ["  "] },
		]) {
			const response = await POST(makeEvent({ id: "trip-project" }, body));
			expect(response.status).toBe(400);
		}
		expect(mockLinkProjectKnowledge).not.toHaveBeenCalled();
	});

	it("maps a not-owned artifact to its own status and code", async () => {
		mockLinkProjectKnowledge.mockRejectedValue(
			new ProjectKnowledgeError(
				"Artifact not found",
				404,
				"artifact_not_owned",
			),
		);

		const response = await POST(
			makeEvent({ id: "trip-project" }, { artifactIds: ["their-file"] }),
		);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.code).toBe("artifact_not_owned");
	});

	it("maps another user's project to a 404", async () => {
		mockLinkProjectKnowledge.mockRejectedValue(
			new ProjectKnowledgeError("Project not found", 404, "project_not_found"),
		);

		const response = await POST(
			makeEvent({ id: "other-project" }, { artifactIds: ["artifact-railjet"] }),
		);

		expect(response.status).toBe(404);
	});
});

describe("DELETE /api/projects/[id]/knowledge/[artifactId]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockUnlinkProjectKnowledge.mockResolvedValue(true);
	});

	it("unlinks the document and reports success", async () => {
		const response = await DELETE(
			makeDeleteEvent({ id: "trip-project", artifactId: "artifact-railjet" }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({ success: true });
		expect(mockUnlinkProjectKnowledge).toHaveBeenCalledWith({
			userId: "owner-user",
			projectId: "trip-project",
			artifactId: "artifact-railjet",
		});
	});

	it("stays a success for a document that was not linked", async () => {
		mockUnlinkProjectKnowledge.mockResolvedValue(false);

		const response = await DELETE(
			makeDeleteEvent({ id: "trip-project", artifactId: "artifact-hotel" }),
		);
		const data = await response.json();

		// The caller asked for the link to be gone and it is gone: asking twice
		// is not an error.
		expect(response.status).toBe(200);
		expect(data).toEqual({ success: true });
	});

	it("maps another user's project to a 404", async () => {
		mockUnlinkProjectKnowledge.mockRejectedValue(
			new ProjectKnowledgeError("Project not found", 404, "project_not_found"),
		);

		const response = await DELETE(
			makeDeleteEvent({ id: "other-project", artifactId: "artifact-railjet" }),
		);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.code).toBe("project_not_found");
	});

	it("answers 401 without a signed-in user", async () => {
		const event = makeDeleteEvent({
			id: "trip-project",
			artifactId: "artifact-railjet",
		});
		(event.locals as { user: unknown }).user = null;

		const response = await DELETE(event);

		expect(response.status).toBe(401);
		expect(mockUnlinkProjectKnowledge).not.toHaveBeenCalled();
	});
});
