import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveProjectSidebarOrder } from "$lib/client/api/projects";
import {
	clearProjectStore,
	createProject,
	deleteProject,
	loadProjects,
	projects,
	reconcileProjectSnapshot,
	renameProject,
	saveProjectOrder,
} from "./projects";

vi.mock("$lib/client/api/projects", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/projects")>();
	return {
		...actual,
		saveProjectSidebarOrder: vi.fn(),
	};
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("projects store", () => {
	beforeEach(() => {
		clearProjectStore();
		vi.restoreAllMocks();
		vi.mocked(saveProjectSidebarOrder).mockReset();
		vi.stubGlobal("fetch", vi.fn());
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("loads projects from the API", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				projects: [
					{
						id: "proj-1",
						name: "Alpha",
						sortOrder: 0,
						hasInstructions: false,
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
		);

		await loadProjects();

		expect(get(projects)).toEqual([
			{
				id: "proj-1",
				name: "Alpha",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
	});

	it("creates a project and appends it locally", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{
					id: "proj-1",
					name: "Alpha",
					sortOrder: 0,
					hasInstructions: false,
					createdAt: 1,
					updatedAt: 1,
				},
				{ status: 201 },
			),
		);

		await expect(createProject("Alpha")).resolves.toEqual({
			id: "proj-1",
			name: "Alpha",
			sortOrder: 0,
			hasInstructions: false,
			createdAt: 1,
			updatedAt: 1,
		});
		expect(get(projects)).toEqual([
			{
				id: "proj-1",
				name: "Alpha",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
	});

	it("keeps locally created projects when a stale snapshot arrives", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{
					id: "proj-local",
					name: "Local",
					sortOrder: 0,
					hasInstructions: false,
					createdAt: 1,
					updatedAt: 1,
				},
				{ status: 201 },
			),
		);

		await createProject("Local");
		reconcileProjectSnapshot([]);

		expect(get(projects)).toEqual([
			{
				id: "proj-local",
				name: "Local",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
	});

	it("renames a project and updates the store locally", async () => {
		projects.set([
			{
				id: "proj-1",
				name: "Alpha",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				id: "proj-1",
				name: "Beta",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 2,
			}),
		);

		await renameProject("proj-1", "Beta");

		expect(get(projects)).toEqual([
			{
				id: "proj-1",
				name: "Beta",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
	});

	it("deletes a project and removes it from the store", async () => {
		projects.set([
			{
				id: "proj-1",
				name: "Alpha",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));

		await deleteProject("proj-1");

		expect(get(projects)).toEqual([]);
	});

	it("sorts project folders by persisted order", () => {
		reconcileProjectSnapshot([
			{
				id: "proj-second",
				name: "Second",
				sortOrder: 1,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "proj-first",
				name: "First",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 2,
				updatedAt: 2,
			},
		]);

		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-first",
			"proj-second",
		]);
	});

	it("keeps a pending project reorder when a stale snapshot arrives", async () => {
		projects.set([
			{
				id: "proj-a",
				name: "A",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "proj-b",
				name: "B",
				sortOrder: 1,
				hasInstructions: false,
				createdAt: 2,
				updatedAt: 2,
			},
		]);
		let resolveSave:
			| ((
					projects: Array<{
						id: string;
						name: string;
						sortOrder: number;
						hasInstructions: boolean;
						createdAt: number;
						updatedAt: number;
					}>,
			  ) => void)
			| undefined;
		vi.mocked(saveProjectSidebarOrder).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveSave = resolve;
			}),
		);

		const save = saveProjectOrder({ ids: ["proj-b", "proj-a"] });
		reconcileProjectSnapshot([
			{
				id: "proj-a",
				name: "A",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 3,
			},
			{
				id: "proj-b",
				name: "B",
				sortOrder: 1,
				hasInstructions: false,
				createdAt: 2,
				updatedAt: 4,
			},
		]);

		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-b",
			"proj-a",
		]);

		expect(resolveSave).toBeDefined();
		if (!resolveSave)
			throw new Error("Expected project order request resolver");
		resolveSave([
			{
				id: "proj-b",
				name: "B",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 2,
				updatedAt: 4,
			},
			{
				id: "proj-a",
				name: "A",
				sortOrder: 1,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 3,
			},
		]);
		await save;
	});

	it("rolls back project folder reorder when persistence fails", async () => {
		projects.set([
			{
				id: "proj-a",
				name: "A",
				sortOrder: 0,
				hasInstructions: false,
				createdAt: 1,
				updatedAt: 1,
			},
			{
				id: "proj-b",
				name: "B",
				sortOrder: 1,
				hasInstructions: false,
				createdAt: 2,
				updatedAt: 2,
			},
		]);
		vi.mocked(saveProjectSidebarOrder).mockRejectedValueOnce(
			new Error("save failed"),
		);

		const save = saveProjectOrder({ ids: ["proj-b", "proj-a"] });

		expect(vi.mocked(saveProjectSidebarOrder)).toHaveBeenCalledWith({
			ids: ["proj-b", "proj-a"],
		});
		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-b",
			"proj-a",
		]);
		await expect(save).rejects.toThrow("save failed");
		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-a",
			"proj-b",
		]);
	});
});
