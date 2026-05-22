import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, projects } from "$lib/server/db/schema";
import type { Project } from "$lib/types";

type SaveProjectSidebarOrderInput = {
	pinnedIds?: string[];
	unpinnedIds?: string[];
};

function toProject(row: typeof projects.$inferSelect): Project {
	return {
		id: row.id,
		name: row.name,
		color: row.color,
		sidebarPinned: row.sidebarPinned,
		sortOrder: row.sortOrder,
		createdAt: row.createdAt.getTime() / 1000,
		updatedAt: row.updatedAt.getTime() / 1000,
	};
}

function sortProjectList(items: Project[]): Project[] {
	return items.sort((a, b) => {
		if (a.sidebarPinned !== b.sidebarPinned) {
			return a.sidebarPinned ? -1 : 1;
		}
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

export async function setProjectSidebarPinned(
	userId: string,
	projectId: string,
	sidebarPinned: boolean,
): Promise<Project | null> {
	if (!sidebarPinned) {
		const [row] = await db
			.update(projects)
			.set({ sidebarPinned: false, updatedAt: new Date() })
			.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
			.returning();
		return row ? toProject(row) : null;
	}

	const [currentTop] = await db
		.select({ sortOrder: projects.sortOrder })
		.from(projects)
		.where(and(eq(projects.userId, userId), eq(projects.sidebarPinned, true)))
		.orderBy(asc(projects.sortOrder))
		.limit(1);
	const nextSortOrder = (currentTop?.sortOrder ?? 1) - 1;
	const [row] = await db
		.update(projects)
		.set({
			sidebarPinned: true,
			sortOrder: nextSortOrder,
			updatedAt: new Date(),
		})
		.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
		.returning();
	return row ? toProject(row) : null;
}

export async function saveProjectSidebarOrder(
	userId: string,
	input: SaveProjectSidebarOrderInput,
): Promise<void> {
	const pinnedIds = input.pinnedIds ?? [];
	const unpinnedIds = input.unpinnedIds ?? [];
	const allIds = [...pinnedIds, ...unpinnedIds];
	if (allIds.length === 0) return;
	if (new Set(allIds).size !== allIds.length) {
		throw new Error("sidebar order ids must not contain duplicates");
	}

	await validateProjectSidebarOrderGroup(userId, pinnedIds, true, "pinnedIds");
	await validateProjectSidebarOrderGroup(
		userId,
		unpinnedIds,
		false,
		"unpinnedIds",
	);

	db.transaction((tx) => {
		for (const [index, projectId] of pinnedIds.entries()) {
			tx.update(projects)
				.set({ sortOrder: index, updatedAt: new Date() })
				.where(
					and(
						eq(projects.id, projectId),
						eq(projects.userId, userId),
						eq(projects.sidebarPinned, true),
					),
				)
				.run();
		}
		for (const [index, projectId] of unpinnedIds.entries()) {
			tx.update(projects)
				.set({ sortOrder: index, updatedAt: new Date() })
				.where(
					and(
						eq(projects.id, projectId),
						eq(projects.userId, userId),
						eq(projects.sidebarPinned, false),
					),
				)
				.run();
		}
	});
}

async function validateProjectSidebarOrderGroup(
	userId: string,
	ids: string[],
	expectedPinned: boolean,
	fieldName: "pinnedIds" | "unpinnedIds",
): Promise<void> {
	if (ids.length === 0) return;
	const rows = await db
		.select({
			id: projects.id,
			sidebarPinned: projects.sidebarPinned,
		})
		.from(projects)
		.where(and(eq(projects.userId, userId), inArray(projects.id, ids)));

	if (
		rows.length !== ids.length ||
		rows.some((row) => row.sidebarPinned !== expectedPinned)
	) {
		throw new Error(
			`${fieldName} must contain only owned ${expectedPinned ? "pinned" : "unpinned"} projects`,
		);
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
