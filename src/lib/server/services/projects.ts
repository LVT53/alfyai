import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, projects } from "$lib/server/db/schema";
import type { Project } from "$lib/types";

type SaveProjectSidebarOrderInput = {
	ids?: string[];
};

function toProject(row: typeof projects.$inferSelect): Project {
	return {
		id: row.id,
		name: row.name,
		color: row.color,
		sortOrder: row.sortOrder,
		createdAt: row.createdAt.getTime() / 1000,
		updatedAt: row.updatedAt.getTime() / 1000,
	};
}

function sortProjectList(items: Project[]): Project[] {
	return items.sort((a, b) => {
		return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt;
	});
}

export async function listProjects(userId: string): Promise<Project[]> {
	const rows = await db
		.select()
		.from(projects)
		.where(eq(projects.userId, userId));
	return sortProjectList(rows.map(toProject));
}

export async function createProject(
	userId: string,
	name: string,
): Promise<Project> {
	const id = randomUUID();
	const [row] = await db
		.insert(projects)
		.values({ id, userId, name })
		.returning();
	return toProject(row);
}

export async function getProject(
	userId: string,
	projectId: string,
): Promise<Project | null> {
	const row = await db
		.select()
		.from(projects)
		.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
		.get();
	return row ? toProject(row) : null;
}

export async function updateProject(
	userId: string,
	projectId: string,
	updates: { name?: string },
): Promise<Project | null> {
	const [row] = await db
		.update(projects)
		.set({ ...updates, updatedAt: new Date() })
		.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
		.returning();
	return row ? toProject(row) : null;
}

export async function saveProjectSidebarOrder(
	userId: string,
	input: SaveProjectSidebarOrderInput,
): Promise<void> {
	const ids = input.ids ?? [];
	if (ids.length === 0) return;
	if (new Set(ids).size !== ids.length) {
		throw new Error("sidebar order ids must not contain duplicates");
	}

	await validateProjectSidebarOrderIds(userId, ids);

	db.transaction((tx) => {
		for (const [index, projectId] of ids.entries()) {
			tx.update(projects)
				.set({ sortOrder: index, updatedAt: new Date() })
				.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
				.run();
		}
	});
}

async function validateProjectSidebarOrderIds(
	userId: string,
	ids: string[],
): Promise<void> {
	if (ids.length === 0) return;
	const rows = await db
		.select({
			id: projects.id,
		})
		.from(projects)
		.where(and(eq(projects.userId, userId), inArray(projects.id, ids)));

	if (rows.length !== ids.length) {
		throw new Error("ids must contain only owned projects");
	}
}

export async function getConversationProjectLabel(
	userId: string,
	conversationId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ name: projects.name })
		.from(conversations)
		.innerJoin(projects, eq(conversations.projectId, projects.id))
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
				eq(projects.userId, userId),
			),
		)
		.limit(1);

	return row?.name ?? null;
}

export async function getConversationProjectId(
	userId: string,
	conversationId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ id: projects.id })
		.from(conversations)
		.innerJoin(projects, eq(conversations.projectId, projects.id))
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
				eq(projects.userId, userId),
			),
		)
		.limit(1);

	return row?.id ?? null;
}

export async function deleteProject(
	userId: string,
	projectId: string,
): Promise<boolean> {
	return db.transaction((tx) => {
		const result = tx
			.delete(projects)
			.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
			.run();
		if (result.changes === 0) {
			return false;
		}

		tx.update(conversations)
			.set({ projectId: null })
			.where(
				and(
					eq(conversations.projectId, projectId),
					eq(conversations.userId, userId),
				),
			)
			.run();

		return true;
	});
}
