import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	saveProjectSidebarOrder,
	setProjectSidebarPinned,
} from "$lib/client/api/projects";
import {
	clearProjectStore,
	createProject,
	deleteProject,
	loadProjects,
	projects,
	reconcileProjectSnapshot,
	renameProject,
	saveProjectOrder,
	toggleProjectSidebarPin,
} from "./projects";

vi.mock("$lib/client/api/projects", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/projects")>();
	return {
		...actual,
		setProjectSidebarPinned: vi.fn(),
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
		vi.mocked(setProjectSidebarPinned).mockReset();
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
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
		);

		await loadProjects();

		expect(get(projects)).toEqual([
			{ id: "proj-1", name: "Alpha", sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
	});

	it("creates a project and appends it locally", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{
					id: "proj-1",
					name: "Alpha",
					sortOrder: 0,
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
			createdAt: 1,
			updatedAt: 1,
		});
		expect(get(projects)).toEqual([
			{ id: "proj-1", name: "Alpha", sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
	});

	it("keeps locally created projects when a stale snapshot arrives", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{
					id: "proj-local",
					name: "Local",
					sortOrder: 0,
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
				createdAt: 1,
				updatedAt: 1,
			},
		]);
	});

	it("renames a project and updates the store locally", async () => {
		projects.set([
			{ id: "proj-1", name: "Alpha", sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				id: "proj-1",
				name: "Beta",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 2,
			}),
		);

		await renameProject("proj-1", "Beta");

		expect(get(projects)).toEqual([
			{ id: "proj-1", name: "Beta", sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
	});

	it("deletes a project and removes it from the store", async () => {
		projects.set([
			{ id: "proj-1", name: "Alpha", sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));

		await deleteProject("proj-1");

		expect(get(projects)).toEqual([]);
	});

	it("sorts project folders with pinned projects first", () => {
		reconcileProjectSnapshot([
			{
				id: "proj-unpinned-first",
				name: "Unpinned first",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: false,
			},
			{
				id: "proj-pinned-second",
				name: "Pinned second",
				sortOrder: 2,
				createdAt: 2,
				updatedAt: 2,
				sidebarPinned: true,
			},
			{
				id: "proj-pinned-first",
				name: "Pinned first",
				sortOrder: 1,
				createdAt: 3,
				updatedAt: 3,
				sidebarPinned: true,
			},
			{
				id: "proj-unpinned-second",
				name: "Unpinned second",
				sortOrder: 1,
				createdAt: 4,
				updatedAt: 4,
				sidebarPinned: false,
			},
		]);

		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-pinned-first",
			"proj-pinned-second",
			"proj-unpinned-first",
			"proj-unpinned-second",
		]);
	});

	it("pins a project folder optimistically at the top of pinned folders", async () => {
		projects.set([
			{
				id: "proj-pinned",
				name: "Pinned",
				sortOrder: 3,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: true,
			},
			{
				id: "proj-target",
				name: "Target",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 2,
				sidebarPinned: false,
			},
		]);
		let resolvePin:
			| ((project: {
					id: string;
					name: string;
					sortOrder: number;
					createdAt: number;
					updatedAt: number;
					sidebarPinned: boolean;
			  }) => void)
			| undefined;
		vi.mocked(setProjectSidebarPinned).mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePin = resolve;
			}),
		);

		const pin = toggleProjectSidebarPin("proj-target", true);

		expect(vi.mocked(setProjectSidebarPinned)).toHaveBeenCalledWith(
			"proj-target",
			true,
		);
		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-target",
			"proj-pinned",
		]);
		expect(get(projects)[0]).toEqual(
			expect.objectContaining({
				id: "proj-target",
				sidebarPinned: true,
				sortOrder: 2,
			}),
		);

		expect(resolvePin).toBeDefined();
		if (!resolvePin) throw new Error("Expected project pin request resolver");
		resolvePin({
			id: "proj-target",
			name: "Target",
			sortOrder: 0,
			createdAt: 2,
			updatedAt: 2,
			sidebarPinned: true,
		});
		await pin;
	});

	it("keeps a pending project pin when a stale snapshot arrives", async () => {
		projects.set([
			{
				id: "proj-pinned",
				name: "Pinned",
				sortOrder: 3,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: true,
			},
			{
				id: "proj-target",
				name: "Target",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 2,
				sidebarPinned: false,
			},
		]);
		let resolvePin:
			| ((project: {
					id: string;
					name: string;
					sortOrder: number;
					createdAt: number;
					updatedAt: number;
					sidebarPinned: boolean;
			  }) => void)
			| undefined;
		vi.mocked(setProjectSidebarPinned).mockReturnValueOnce(
			new Promise((resolve) => {
				resolvePin = resolve;
			}),
		);

		const pin = toggleProjectSidebarPin("proj-target", true);
		reconcileProjectSnapshot([
			{
				id: "proj-pinned",
				name: "Pinned",
				sortOrder: 3,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: true,
			},
			{
				id: "proj-target",
				name: "Target",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 3,
				sidebarPinned: false,
			},
		]);

		expect(get(projects)[0]).toEqual(
			expect.objectContaining({
				id: "proj-target",
				sortOrder: 2,
				sidebarPinned: true,
			}),
		);

		expect(resolvePin).toBeDefined();
		if (!resolvePin) throw new Error("Expected project pin request resolver");
		resolvePin({
			id: "proj-target",
			name: "Target",
			sortOrder: 0,
			createdAt: 2,
			updatedAt: 3,
			sidebarPinned: true,
		});
		await pin;
	});

	it("keeps a confirmed project pin when a stale list snapshot follows", async () => {
		projects.set([
			{
				id: "proj-pinned",
				name: "Pinned",
				sortOrder: 3,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: true,
			},
			{
				id: "proj-target",
				name: "Target",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 2,
				sidebarPinned: false,
			},
		]);
		vi.mocked(setProjectSidebarPinned).mockResolvedValueOnce({
			id: "proj-target",
			name: "Target",
			sortOrder: 0,
			createdAt: 2,
			updatedAt: 3,
			sidebarPinned: true,
		});

		await toggleProjectSidebarPin("proj-target", true);
		reconcileProjectSnapshot([
			{
				id: "proj-pinned",
				name: "Pinned",
				sortOrder: 3,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: true,
			},
			{
				id: "proj-target",
				name: "Target",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 4,
				sidebarPinned: false,
			},
		]);

		expect(get(projects)[0]).toEqual(
			expect.objectContaining({
				id: "proj-target",
				sortOrder: 0,
				sidebarPinned: true,
			}),
		);
	});

	it("rolls back a project pin when persistence fails", async () => {
		projects.set([
			{
				id: "proj-pinned",
				name: "Pinned",
				sortOrder: 3,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: true,
			},
			{
				id: "proj-target",
				name: "Target",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 2,
				sidebarPinned: false,
			},
		]);
		vi.mocked(setProjectSidebarPinned).mockRejectedValueOnce(
			new Error("pin failed"),
		);

		const pin = toggleProjectSidebarPin("proj-target", true);

		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-target",
			"proj-pinned",
		]);
		await expect(pin).rejects.toThrow("pin failed");
		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-pinned",
			"proj-target",
		]);
		expect(get(projects)[1]).toEqual(
			expect.objectContaining({
				id: "proj-target",
				sortOrder: 1,
				sidebarPinned: false,
			}),
		);
	});

	it("rolls back project folder reorder when persistence fails", async () => {
		projects.set([
			{
				id: "proj-pinned-a",
				name: "Pinned A",
				sortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
				sidebarPinned: true,
			},
			{
				id: "proj-pinned-b",
				name: "Pinned B",
				sortOrder: 1,
				createdAt: 2,
				updatedAt: 2,
				sidebarPinned: true,
			},
			{
				id: "proj-unpinned-a",
				name: "Unpinned A",
				sortOrder: 0,
				createdAt: 3,
				updatedAt: 3,
				sidebarPinned: false,
			},
			{
				id: "proj-unpinned-b",
				name: "Unpinned B",
				sortOrder: 1,
				createdAt: 4,
				updatedAt: 4,
				sidebarPinned: false,
			},
		]);
		vi.mocked(saveProjectSidebarOrder).mockRejectedValueOnce(
			new Error("save failed"),
		);

		const save = saveProjectOrder({
			pinnedIds: ["proj-pinned-b", "proj-pinned-a"],
			unpinnedIds: ["proj-unpinned-b", "proj-unpinned-a"],
		});

		expect(vi.mocked(saveProjectSidebarOrder)).toHaveBeenCalledWith({
			pinnedIds: ["proj-pinned-b", "proj-pinned-a"],
			unpinnedIds: ["proj-unpinned-b", "proj-unpinned-a"],
		});
		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-pinned-b",
			"proj-pinned-a",
			"proj-unpinned-b",
			"proj-unpinned-a",
		]);
		await expect(save).rejects.toThrow("save failed");
		expect(get(projects).map((project) => project.id)).toEqual([
			"proj-pinned-a",
			"proj-pinned-b",
			"proj-unpinned-a",
			"proj-unpinned-b",
		]);
	});
});
