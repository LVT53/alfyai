import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
	clearProjectStore,
	createProject,
	deleteProject,
	loadProjects,
	projects,
	reconcileProjectSnapshot,
	renameProject,
} from './projects';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { 'Content-Type': 'application/json' },
		...init,
	});
}

describe('projects store', () => {
	beforeEach(() => {
		clearProjectStore();
		vi.restoreAllMocks();
		vi.stubGlobal('fetch', vi.fn());
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('loads projects from the API', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({
				projects: [{ id: 'proj-1', name: 'Alpha', sortOrder: 0, createdAt: 1, updatedAt: 1 }],
			})
		);

		await loadProjects();

		expect(get(projects)).toEqual([
			{ id: 'proj-1', name: 'Alpha', sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
	});

	it('creates a project and appends it locally', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{ id: 'proj-1', name: 'Alpha', sortOrder: 0, createdAt: 1, updatedAt: 1 },
				{ status: 201 }
			)
		);

		await expect(createProject('Alpha')).resolves.toEqual({
			id: 'proj-1',
			name: 'Alpha',
			sortOrder: 0,
			createdAt: 1,
			updatedAt: 1,
		});
		expect(get(projects)).toEqual([
			{ id: 'proj-1', name: 'Alpha', sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
	});

	it('keeps locally created projects when a stale snapshot arrives', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse(
				{ id: 'proj-local', name: 'Local', sortOrder: 0, createdAt: 1, updatedAt: 1 },
				{ status: 201 }
			)
		);

		await createProject('Local');
		reconcileProjectSnapshot([]);

		expect(get(projects)).toEqual([
			{ id: 'proj-local', name: 'Local', sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
	});

	it('renames a project and updates the store locally', async () => {
		projects.set([{ id: 'proj-1', name: 'Alpha', sortOrder: 0, createdAt: 1, updatedAt: 1 }]);
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonResponse({ id: 'proj-1', name: 'Beta', sortOrder: 0, createdAt: 1, updatedAt: 2 })
		);

		await renameProject('proj-1', 'Beta');

		expect(get(projects)).toEqual([
			{ id: 'proj-1', name: 'Beta', sortOrder: 0, createdAt: 1, updatedAt: 1 },
		]);
	});

	it('deletes a project and removes it from the store', async () => {
		projects.set([{ id: 'proj-1', name: 'Alpha', sortOrder: 0, createdAt: 1, updatedAt: 1 }]);
		vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ success: true }));

		await deleteProject('proj-1');

		expect(get(projects)).toEqual([]);
	});
});
