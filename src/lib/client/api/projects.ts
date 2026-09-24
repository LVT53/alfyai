import type { Project } from "$lib/server/services/projects";
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

/**
 * Save a project's standing instructions. Returns the updated project, so the
 * caller can take `hasInstructions` from the server's own reading of the text
 * rather than guessing from what it sent (a whitespace-only save means "no
 * instructions", and that decision is the server's).
 */
export async function saveProjectInstructions(
	id: string,
	instructions: string,
): Promise<Project> {
	return requestJson<Project>(
		`/api/projects/${id}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instructions }),
		},
		"Failed to save project instructions",
	);
}

export async function saveProjectSidebarOrder(
	payload: { ids: string[] },
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
