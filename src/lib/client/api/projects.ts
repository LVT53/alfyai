import type { ProjectKnowledgeItem } from "$lib/server/services/knowledge";
import type { Project } from "$lib/server/services/projects";
import { _unwrapList } from "./_utils";
import { requestJson, requestVoid } from "./http";

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

/**
 * The library documents a project knows about.
 *
 * Every one of these is an ordinary library document: linking copies nothing,
 * and both mutating calls answer with the project's full list so the caller
 * renders what the server has rather than what it hoped it sent.
 */
export async function fetchProjectFiles(
	projectId: string,
): Promise<ProjectKnowledgeItem[]> {
	const payload = await requestJson<{ files?: ProjectKnowledgeItem[] }>(
		`/api/projects/${projectId}/knowledge`,
		undefined,
		"Failed to load project files",
	);
	return _unwrapList<ProjectKnowledgeItem>(payload, "files");
}

export async function linkProjectFiles(
	projectId: string,
	artifactIds: string[],
): Promise<ProjectKnowledgeItem[]> {
	const payload = await requestJson<{ files?: ProjectKnowledgeItem[] }>(
		`/api/projects/${projectId}/knowledge`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ artifactIds }),
		},
		"Failed to add files to the project",
	);
	return _unwrapList<ProjectKnowledgeItem>(payload, "files");
}

/** Removes the link, never the file. The document stays in the library. */
export async function unlinkProjectFile(
	projectId: string,
	artifactId: string,
): Promise<void> {
	await requestVoid(
		`/api/projects/${projectId}/knowledge/${encodeURIComponent(artifactId)}`,
		{ method: "DELETE" },
		"Failed to remove the file from the project",
	);
}
