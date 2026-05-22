import { writable } from "svelte/store";
import {
	createProject as createProjectRequest,
	deleteProject as deleteProjectRequest,
	fetchProjects,
	renameProject as renameProjectRequest,
	saveProjectSidebarOrder,
	setProjectSidebarPinned,
} from "$lib/client/api/projects";
import type { Project } from "$lib/types";

export const projects = writable<Project[]>([]);

type SidebarProject = Project & { sidebarPinned?: boolean };

const optimisticProjectIds = new Set<string>();
const localProjectSidebarStates = new Map<
	string,
	{ sidebarPinned: boolean; sortOrder: number }
>();
let projectSnapshotUserId: string | null = null;

function isProjectSidebarPinned(project: Project): boolean {
	return (project as SidebarProject).sidebarPinned === true;
}

function sortProjects(items: Project[]): Project[] {
	return [...items].sort((left, right) => {
		const leftPinned = isProjectSidebarPinned(left);
		const rightPinned = isProjectSidebarPinned(right);
		if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
		return left.sortOrder - right.sortOrder || left.createdAt - right.createdAt;
	});
}

function getProjectSidebarState(project: Project): {
	sidebarPinned: boolean;
	sortOrder: number;
} {
	return {
		sidebarPinned: isProjectSidebarPinned(project),
		sortOrder: project.sortOrder,
	};
}

function projectSidebarStateMatches(
	project: Project,
	state: { sidebarPinned: boolean; sortOrder: number },
): boolean {
	return (
		isProjectSidebarPinned(project) === state.sidebarPinned &&
		project.sortOrder === state.sortOrder
	);
}

function applyProjectSidebarState(
	project: Project,
	state: { sidebarPinned: boolean; sortOrder: number },
): Project {
	return {
		...project,
		sidebarPinned: state.sidebarPinned,
		sortOrder: state.sortOrder,
	};
}

function nextTopProjectSortOrder(
	items: Project[],
	sidebarPinned: boolean,
): number {
	const orders = items
		.filter((project) => isProjectSidebarPinned(project) === sidebarPinned)
		.map((project) => project.sortOrder);
	if (orders.length === 0) return 0;
	return Math.min(...orders) - 1;
}

function applyProjectMutationResult(project: Project): void {
	projects.update((list) =>
		sortProjects(
			list.map((item) =>
				item.id === project.id ? { ...item, ...project } : item,
			),
		),
	);
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
			localProjectSidebarStates.clear();
			projectSnapshotUserId = options.userId ?? null;
			return sortProjects(items);
		}

		if (options.userId !== undefined) {
			projectSnapshotUserId = options.userId;
		}

		const mergedItems = items.map((item) => {
			const localSidebarState = localProjectSidebarStates.get(item.id);
			if (!localSidebarState) return item;
			if (projectSidebarStateMatches(item, localSidebarState)) {
				localProjectSidebarStates.delete(item.id);
				return item;
			}
			return applyProjectSidebarState(item, localSidebarState);
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
	localProjectSidebarStates.clear();
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
	projects.update((list) => [...list, project]);
	return project;
}

export async function renameProject(id: string, name: string): Promise<void> {
	await renameProjectRequest(id, name);
	projects.update((list) =>
		list.map((p) => (p.id === id ? { ...p, name } : p)),
	);
}

export async function toggleProjectSidebarPin(
	id: string,
	sidebarPinned?: boolean,
): Promise<void> {
	let previousProject: Project | null = null;
	let previousSidebarState:
		| { sidebarPinned: boolean; sortOrder: number }
		| undefined;
	let hadPreviousSidebarState = false;
	let nextPinned = Boolean(sidebarPinned);
	let optimisticSidebarState:
		| { sidebarPinned: boolean; sortOrder: number }
		| undefined;

	projects.update((list) => {
		const current = list.find((project) => project.id === id);
		if (!current) return list;
		previousProject = current;
		hadPreviousSidebarState = localProjectSidebarStates.has(id);
		previousSidebarState = localProjectSidebarStates.get(id);
		nextPinned = sidebarPinned ?? !isProjectSidebarPinned(current);
		const nextSidebarState = {
			sidebarPinned: nextPinned,
			sortOrder: nextTopProjectSortOrder(list, nextPinned),
		};
		optimisticSidebarState = nextSidebarState;
		localProjectSidebarStates.set(id, nextSidebarState);
		return sortProjects(
			list.map((project) =>
				project.id === id
					? applyProjectSidebarState(project, nextSidebarState)
					: project,
			),
		);
	});

	try {
		const project = await setProjectSidebarPinned(id, nextPinned);
		localProjectSidebarStates.set(id, getProjectSidebarState(project));
		applyProjectMutationResult(project);
	} catch (error) {
		if (
			optimisticSidebarState &&
			localProjectSidebarStates.get(id) === optimisticSidebarState
		) {
			if (hadPreviousSidebarState && previousSidebarState) {
				localProjectSidebarStates.set(id, previousSidebarState);
			} else {
				localProjectSidebarStates.delete(id);
			}
		}
		if (previousProject) {
			projects.update((list) =>
				sortProjects(
					list.map((project) =>
						project.id === id ? previousProject : project,
					),
				),
			);
		}
		throw error;
	}
}

export async function saveProjectOrder(payload: {
	pinnedIds?: string[];
	unpinnedIds?: string[];
}): Promise<void> {
	const pinnedIds = payload.pinnedIds ?? [];
	const unpinnedIds = payload.unpinnedIds ?? [];
	const pinnedOrder = new Map(pinnedIds.map((id, index) => [id, index]));
	const unpinnedOrder = new Map(unpinnedIds.map((id, index) => [id, index]));
	let previousItems: Project[] = [];
	const previousSidebarStates = new Map<
		string,
		{ hadState: boolean; state?: { sidebarPinned: boolean; sortOrder: number } }
	>();
	const optimisticSidebarStates = new Map<
		string,
		{ sidebarPinned: boolean; sortOrder: number }
	>();

	projects.update((list) => {
		previousItems = list;
		for (const id of [...pinnedIds, ...unpinnedIds]) {
			previousSidebarStates.set(id, {
				hadState: localProjectSidebarStates.has(id),
				state: localProjectSidebarStates.get(id),
			});
		}

		const next = list.map((project) => {
			const pinnedIndex = pinnedOrder.get(project.id);
			const unpinnedIndex = unpinnedOrder.get(project.id);
			if (pinnedIndex === undefined && unpinnedIndex === undefined) {
				return project;
			}
			const nextSidebarState =
				pinnedIndex !== undefined
					? { sidebarPinned: true, sortOrder: pinnedIndex }
					: { sidebarPinned: false, sortOrder: unpinnedIndex ?? 0 };
			optimisticSidebarStates.set(project.id, nextSidebarState);
			localProjectSidebarStates.set(project.id, nextSidebarState);
			return applyProjectSidebarState(project, nextSidebarState);
		});

		return sortProjects(next);
	});

	try {
		const updatedProjects = await saveProjectSidebarOrder(payload);
		if (Array.isArray(updatedProjects)) {
			applyProjectMutationResults(updatedProjects);
		}
	} catch (error) {
		for (const [id, state] of optimisticSidebarStates) {
			if (localProjectSidebarStates.get(id) !== state) continue;
			const previous = previousSidebarStates.get(id);
			if (previous?.hadState && previous.state) {
				localProjectSidebarStates.set(id, previous.state);
			} else {
				localProjectSidebarStates.delete(id);
			}
		}
		projects.set(previousItems);
		throw error;
	}
}

export async function deleteProject(id: string): Promise<void> {
	await deleteProjectRequest(id);
	optimisticProjectIds.delete(id);
	localProjectSidebarStates.delete(id);
	projects.update((list) => list.filter((p) => p.id !== id));
}
