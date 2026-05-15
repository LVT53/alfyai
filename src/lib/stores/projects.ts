import { writable } from 'svelte/store';
import type { Project } from '$lib/types';
import {
	createProject as createProjectRequest,
	deleteProject as deleteProjectRequest,
	fetchProjects,
	renameProject as renameProjectRequest,
} from '$lib/client/api/projects';

export const projects = writable<Project[]>([]);

const optimisticProjectIds = new Set<string>();
let projectSnapshotUserId: string | null = null;

function sortProjects(items: Project[]): Project[] {
	return [...items].sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt - right.createdAt);
}

export function reconcileProjectSnapshot(
	items: Project[],
	options: { resetLocalState?: boolean; userId?: string | null } = {}
): void {
	const ownerChanged =
		options.userId !== undefined &&
		projectSnapshotUserId !== null &&
		projectSnapshotUserId !== options.userId;
	const shouldReset = Boolean(options.resetLocalState || ownerChanged);

	projects.update((current) => {
		if (shouldReset) {
			optimisticProjectIds.clear();
			projectSnapshotUserId = options.userId ?? null;
			return sortProjects(items);
		}

		if (options.userId !== undefined) {
			projectSnapshotUserId = options.userId;
		}

		const next = new Map(items.map((item) => [item.id, item]));
		for (const item of current) {
			if (optimisticProjectIds.has(item.id) && !next.has(item.id)) {
				next.set(item.id, item);
			}
		}

		for (const item of items) {
			optimisticProjectIds.delete(item.id);
		}

		return sortProjects(Array.from(next.values()));
	});
}

export function clearProjectStore(): void {
	optimisticProjectIds.clear();
	projectSnapshotUserId = null;
	projects.set([]);
}

export async function loadProjects(): Promise<void> {
	try {
		reconcileProjectSnapshot(await fetchProjects());
	} catch (error) {
		console.error('Error loading projects:', error);
	}
}

export async function createProject(name: string): Promise<Project> {
	const project = await createProjectRequest(name);
	optimisticProjectIds.add(project.id);
	projects.update((list) => [...list, project]);
	return project;
}

export async function renameProject(id: string, name: string): Promise<void> {
	await renameProjectRequest(id, name);
	projects.update((list) => list.map((p) => (p.id === id ? { ...p, name } : p)));
}

export async function deleteProject(id: string): Promise<void> {
	await deleteProjectRequest(id);
	optimisticProjectIds.delete(id);
	projects.update((list) => list.filter((p) => p.id !== id));
}
