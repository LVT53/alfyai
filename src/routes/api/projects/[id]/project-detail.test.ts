import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/projects", () => ({
	deleteProject: vi.fn(),
	getProjectInstructions: vi.fn(),
	updateProject: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	getProjectInstructions,
	updateProject,
} from "$lib/server/services/projects";
import { GET, PATCH } from "./+server";
import type { RequestEvent } from "./$types";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockUpdateProject = updateProject as ReturnType<typeof vi.fn>;
const mockGetProjectInstructions = getProjectInstructions as ReturnType<
	typeof vi.fn
>;

function makePatchEvent(body: unknown, id = "project-1"): RequestEvent {
	return {
		request: new Request(`http://localhost/api/projects/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1" } },
		params: { id },
		url: new URL(`http://localhost/api/projects/${id}`),
		route: { id: "/api/projects/[id]" },
	} as unknown as RequestEvent;
}

describe("PATCH /api/projects/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockUpdateProject.mockResolvedValue({
			id: "project-1",
			name: "Renamed",
			color: null,
			sortOrder: 0,
			createdAt: 1,
			updatedAt: 2,
		});
	});

	it("still renames projects through the existing name branch", async () => {
		const response = await PATCH(makePatchEvent({ name: " Renamed " }));

		expect(response.status).toBe(200);
		expect(mockUpdateProject).toHaveBeenCalledWith("user-1", "project-1", {
			name: "Renamed",
		});
	});

	it("does not accept project pin payloads", async () => {
		const response = await PATCH(makePatchEvent({ sidebarPinned: true }));
		const data = await response.json();

		expect(response.status).toBe(400);
		// The message widened with the contract (Slice D): PATCH now accepts
		// `instructions`, so a payload with neither field is "nothing to
		// update" rather than "a name is missing".
		expect(data.error).toBe("Nothing to update");
		expect(mockUpdateProject).not.toHaveBeenCalled();
	});
});

function makeGetEvent(
	id = "project-1",
	locals: { user?: unknown } = { user: { id: "user-1" } },
) {
	return {
		request: new Request(`http://localhost/api/projects/${id}`),
		locals,
		params: { id },
		url: new URL(`http://localhost/api/projects/${id}`),
		route: { id: "/api/projects/[id]" },
	} as unknown as RequestEvent;
}

// Slice F's `/instruction` opens the dialog with the scope it is standing in
// plus the other scope's text already saved, so the user reviews the whole
// text they are about to change. `Project` deliberately never carries that
// text, which is why the read is its own endpoint.
describe("GET /api/projects/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetProjectInstructions.mockResolvedValue({
			id: "project-1",
			name: "Trains",
			text: "Only suggest trains.",
		});
	});

	it("answers with the project's name and its instruction text", async () => {
		const response = await GET(makeGetEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({
			project: {
				id: "project-1",
				name: "Trains",
				instructions: "Only suggest trains.",
			},
		});
		// The ownership check is the read's own, not the caller's memory of
		// having made one.
		expect(mockGetProjectInstructions).toHaveBeenCalledWith(
			"user-1",
			"project-1",
		);
	});

	it("answers a project with no instructions with null, not an empty string", async () => {
		mockGetProjectInstructions.mockResolvedValue({
			id: "project-1",
			name: "Trains",
			text: null,
		});

		const data = await (await GET(makeGetEvent())).json();

		expect(data.project.instructions).toBeNull();
	});

	it("hides someone else's project behind the same 404 as a missing one", async () => {
		mockGetProjectInstructions.mockResolvedValue(null);

		const response = await GET(makeGetEvent());

		expect(response.status).toBe(404);
	});

	it("refuses a request that carries no user", async () => {
		const response = await GET(makeGetEvent("project-1", {}));

		expect(response.status).toBe(401);
		expect(mockGetProjectInstructions).not.toHaveBeenCalled();
	});
});
