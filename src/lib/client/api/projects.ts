import type { Project } from "$lib/types";
import { _unwrapList } from "./_utils";
import { requestJson } from "./http";

export async function fetchProjects(): Promise<Project[]> {
	const payload = await requestJson<{ projects?: Project[] }>(
		"/api/projects",
		undefined,
		"Failed to load projects",
	);
	return _unwrapList<Project>(payload, "projects");
}

export async function createProject(name: string): Promise<Project> {
	return requestJson<Project>(
		"/api/projects",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		},
		"Failed to create project",
	);
}

export async function renameProject(
	id: string,
	name: string,
): Promise<Project> {
	return requestJson<Project>(
		`/api/projects/${id}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		},
		"Failed to rename project",
	);
}

export async function setProjectSidebarPinned(
	id: string,
	sidebarPinned: boolean,
	fetchImpl: typeof fetch = fetch,
): Promise<Project> {
	return requestJson<Project>(
		`/api/projects/${id}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sidebarPinned }),
		},
		"Failed to update project pin",
		fetchImpl,
	);
}

export async function saveProjectSidebarOrder(
	payload: { pinnedIds?: string[]; unpinnedIds?: string[] },
	fetchImpl: typeof fetch = fetch,
): Promise<Project[]> {
	const result = await requestJson<{ projects?: Project[] }>(
		"/api/projects/sidebar-order",
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
		"Failed to save project order",
		fetchImpl,
	);
	return _unwrapList<Project>(result, "projects");
}

export async function deleteProject(id: string): Promise<void> {
	await requestJson<{ success?: boolean }>(
		`/api/projects/${id}`,
		{
			method: "DELETE",
		},
		"Failed to delete project",
	);
}
