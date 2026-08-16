import { writable } from "svelte/store";
import {
	createProject as createProjectRequest,
	deleteProject as deleteProjectRequest,
	fetchProjects,
	renameProject as renameProjectRequest,
	saveProjectSidebarOrder,
} from "$lib/client/api/projects";
import type { Project } from "$lib/server/services/projects";

export const projects = writable<Project[]>([]);

const optimisticProjectIds = new Set<string>();
const localProjectSortOrders = new Map<string, number>();
let projectSnapshotUserId: string | null = null;

function sortProjects(items: Project[]): Project[] {
	return [...items].sort(
		(left, right) =>
			left.sortOrder - right.sortOrder || left.createdAt - right.createdAt,
	);
}

function projectSortOrderMatches(project: Project, sortOrder: number): boolean {
	return project.sortOrder === sortOrder;
}

function applyProjectSortOrder(project: Project, sortOrder: number): Project {
	return {
		...project,
		sortOrder,
	};
}

function applyProjectMutationResults(items: Project[]): void {
	if (items.length === 0) return;
	const incomingById = new Map(items.map((item) => [item.id, item]));
	projects.update((list) => {
		const seenIds = new Set<string>();
		const merged = list.map((project) => {
			const incoming = incomingById.get(project.id);
			if (!incoming) return project;
			seenIds.add(project.id);
			return { ...project, ...incoming };
		});

		for (const item of items) {
			if (!seenIds.has(item.id)) merged.push(item);
		}

		return sortProjects(merged);
	});
}

export function reconcileProjectSnapshot(
	items: Project[],
	options: { resetLocalState?: boolean; userId?: string | null } = {},
): void {
	const ownerChanged =
		options.userId !== undefined &&
		projectSnapshotUserId !== null &&
		projectSnapshotUserId !== options.userId;
	const shouldReset = Boolean(options.resetLocalState || ownerChanged);

	projects.update((current) => {
		if (shouldReset) {
			optimisticProjectIds.clear();
			localProjectSortOrders.clear();
			projectSnapshotUserId = options.userId ?? null;
			return sortProjects(items);
		}

		if (options.userId !== undefined) {
			projectSnapshotUserId = options.userId;
		}

		const mergedItems = items.map((item) => {
			const localSortOrder = localProjectSortOrders.get(item.id);
			if (localSortOrder === undefined) return item;
			if (projectSortOrderMatches(item, localSortOrder)) {
				localProjectSortOrders.delete(item.id);
				return item;
			}
			return applyProjectSortOrder(item, localSortOrder);
		});

		const next = new Map(mergedItems.map((item) => [item.id, item]));
		for (const item of current) {
			if (optimisticProjectIds.has(item.id) && !next.has(item.id)) {
				next.set(item.id, item);
			}
		}

		for (const item of mergedItems) {
			optimisticProjectIds.delete(item.id);
		}

		return sortProjects(Array.from(next.values()));
	});
}

export function clearProjectStore(): void {
	optimisticProjectIds.clear();
	localProjectSortOrders.clear();
	projectSnapshotUserId = null;
	projects.set([]);
}

export async function loadProjects(): Promise<void> {
	try {
		reconcileProjectSnapshot(await fetchProjects());
	} catch (error) {
		console.error("Error loading projects:", error);
	}
}

export async function createProject(name: string): Promise<Project> {
	const project = await createProjectRequest(name);
	optimisticProjectIds.add(project.id);
	projects.update((list) => sortProjects([...list, project]));
	return project;
}

export async function renameProject(id: string, name: string): Promise<void> {
	await renameProjectRequest(id, name);
	projects.update((list) =>
		list.map((p) => (p.id === id ? { ...p, name } : p)),
	);
}

export async function saveProjectOrder(payload: {
	ids: string[];
}): Promise<void> {
	const order = new Map(payload.ids.map((id, index) => [id, index]));
	let previousItems: Project[] = [];
	const previousSortOrders = new Map<
		string,
		{ hadState: boolean; sortOrder?: number }
	>();
	const optimisticSortOrders = new Map<string, number>();

	projects.update((list) => {
		previousItems = list;
		for (const id of payload.ids) {
			previousSortOrders.set(id, {
				hadState: localProjectSortOrders.has(id),
				sortOrder: localProjectSortOrders.get(id),
			});
		}

		const next = list.map((project) => {
			const nextSortOrder = order.get(project.id);
			if (nextSortOrder === undefined) return project;
			optimisticSortOrders.set(project.id, nextSortOrder);
			localProjectSortOrders.set(project.id, nextSortOrder);
			return applyProjectSortOrder(project, nextSortOrder);
		});

		return sortProjects(next);
	});

	try {
		const updatedProjects = await saveProjectSidebarOrder(payload);
		if (Array.isArray(updatedProjects)) {
			applyProjectMutationResults(updatedProjects);
		}
	} catch (error) {
		for (const [id, sortOrder] of optimisticSortOrders) {
			if (localProjectSortOrders.get(id) !== sortOrder) continue;
			const previous = previousSortOrders.get(id);
			if (previous?.hadState && previous.sortOrder !== undefined) {
				localProjectSortOrders.set(id, previous.sortOrder);
			} else {
				localProjectSortOrders.delete(id);
			}
		}
		projects.set(previousItems);
		throw error;
	}
}

export async function deleteProject(id: string): Promise<void> {
	await deleteProjectRequest(id);
	optimisticProjectIds.delete(id);
	localProjectSortOrders.delete(id);
	projects.update((list) => list.filter((p) => p.id !== id));
}
