import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, messages, projects } from "$lib/server/db/schema";
import { normalizeInstructionText } from "$lib/shared/instructions";

// Relocated out of the former src/lib/types.ts god-module
// (architecture-deepening T1); this type carries no behavior change, only
// a new home next to the project service that owns Project CRUD.
export interface Project {
	id: string;
	name: string;
	color?: string | null;
	sortOrder: number;
	createdAt: number; // Unix timestamp
	updatedAt: number; // Unix timestamp
	/**
	 * Whether the project carries standing instructions. The text itself is
	 * never part of a list payload: the sidebar, the shell and the home row
	 * all hand this record to the browser, and one screen's worth of project
	 * guidance must not ride along to every surface that lists a project.
	 */
	hasInstructions: boolean;
}

export interface ProjectPageChat {
	id: string;
	title: string;
	updatedAt: number; // Unix timestamp
	messageCount: number;
}

export interface ProjectPageData {
	project: {
		id: string;
		name: string;
		instructions: string | null;
		hasInstructions: boolean;
	};
	chats: ProjectPageChat[];
	/** Total chats on the project, even when `chats` was capped by `limit`. */
	chatCount: number;
	/** Newest chat activity, or null for a project with no chats yet. */
	lastActivityAt: number | null;
}

export interface RecentlyActiveProject {
	id: string;
	name: string;
	color: string | null;
	chatCount: number;
	lastActivityAt: number; // Unix timestamp
	hasInstructions: boolean;
}

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
		hasInstructions: Boolean(row.instructions?.trim()),
	};
}

/**
 * "This conversation has been used at least once."
 *
 * A conversation row exists the moment the landing page prepares a draft, so
 * a recency-only read would put a chat the user never sent anything into at
 * the top of a brand-new project. The project page and the home row must
 * agree on what a chat is, so they share this one predicate rather than each
 * spelling out their own `EXISTS`.
 */
function conversationHasMessages() {
	return sql`EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.conversationId} = ${conversations.id})`;
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

/** One project's instructions, with the name that labels them. */
export interface ProjectInstructions {
	id: string;
	name: string;
	/** Trimmed text, or null when the project carries none. */
	text: string | null;
}

/**
 * The project's own instructions, read by the one caller that may legitimately
 * hold them: prompt assembly and the data archive.
 *
 * `Project` deliberately never carries the text — the sidebar, the shell and
 * the home row all hand that record to the browser — so a caller that needs it
 * comes here, and the ownership check is this read's own rather than the
 * caller's memory of having made one. Returns null for a project that is not
 * the user's, which makes "somebody else's" indistinguishable from "missing".
 */
export async function getProjectInstructions(
	userId: string,
	projectId: string,
): Promise<ProjectInstructions | null> {
	const row = await db
		.select({
			id: projects.id,
			name: projects.name,
			instructions: projects.instructions,
		})
		.from(projects)
		.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
		.get();
	if (!row) return null;

	return {
		id: row.id,
		name: row.name,
		text: normalizeInstructionText(row.instructions ?? ""),
	};
}

export interface UpdateProjectInput {
	name?: string;
	/**
	 * Standing guidance for the project. `null` and whitespace-only both mean
	 * "no instructions" — normalised here so every caller, not just the PATCH
	 * route, lands on the same stored state.
	 */
	instructions?: string | null;
}

export async function updateProject(
	userId: string,
	projectId: string,
	updates: UpdateProjectInput,
): Promise<Project | null> {
	const patch: {
		name?: string;
		instructions?: string | null;
		updatedAt: Date;
	} = { updatedAt: new Date() };
	if (updates.name !== undefined) patch.name = updates.name;
	if (updates.instructions !== undefined) {
		patch.instructions = normalizeInstructionText(updates.instructions ?? "");
	}

	const [row] = await db
		.update(projects)
		.set(patch)
		.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
		.returning();
	return row ? toProject(row) : null;
}

/**
 * Everything the project page renders in one read: the project itself
 * (instructions included — this is the one surface allowed to see the text),
 * its most recent chats, and the totals behind them.
 *
 * Returns null for a project that does not exist *or* belongs to somebody
 * else; the two cases are deliberately indistinguishable to the caller.
 */
export async function getProjectPageData(params: {
	userId: string;
	projectId: string;
	limit: number;
}): Promise<ProjectPageData | null> {
	const { userId, projectId, limit } = params;
	const row = await db
		.select()
		.from(projects)
		.where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
		.get();
	if (!row) return null;

	const [totals] = await db
		.select({
			chatCount: sql<number>`count(*)`,
			lastActivityAt: sql<number | null>`max(${conversations.updatedAt})`,
		})
		.from(conversations)
		.where(
			and(
				eq(conversations.projectId, projectId),
				eq(conversations.userId, userId),
				conversationHasMessages(),
			),
		);

	const chatRows = await db
		.select({
			id: conversations.id,
			title: conversations.title,
			updatedAt: conversations.updatedAt,
			messageCount: sql<number>`count(${messages.id})`,
		})
		.from(conversations)
		// The join is this list's form of the "a chat has carried a message"
		// rule above: an untouched draft has no messages to join to, so it
		// drops out of the page without a second `EXISTS`.
		.innerJoin(messages, eq(messages.conversationId, conversations.id))
		.where(
			and(
				eq(conversations.projectId, projectId),
				eq(conversations.userId, userId),
			),
		)
		.groupBy(conversations.id)
		.orderBy(desc(conversations.updatedAt), asc(conversations.id))
		.limit(limit);

	return {
		project: {
			id: row.id,
			name: row.name,
			instructions: row.instructions ?? null,
			hasInstructions: Boolean(row.instructions?.trim()),
		},
		chats: chatRows.map((chat) => ({
			id: chat.id,
			title: chat.title,
			// Plain seconds: the `max()`/subquery aggregates above are raw SQL
			// too, and a mixed shape would make the page format dates twice.
			updatedAt: Math.floor(chat.updatedAt.getTime() / 1000),
			messageCount: chat.messageCount,
		})),
		chatCount: totals?.chatCount ?? 0,
		lastActivityAt: totals?.lastActivityAt ?? null,
	};
}

/**
 * The projects worth putting in front of the user right now: those with at
 * least one chat that has carried a message, newest activity first.
 *
 * A project with no chats gets no card — an empty folder is not "recently
 * active", and listing it would push a real project off the row.
 */
export async function listRecentlyActiveProjects(params: {
	userId: string;
	limit: number;
}): Promise<RecentlyActiveProject[]> {
	const { userId, limit } = params;
	if (limit <= 0) return [];

	const rows = await db
		.select({
			id: projects.id,
			name: projects.name,
			color: projects.color,
			instructions: projects.instructions,
			chatCount: sql<number>`count(*)`,
			lastActivityAt: sql<number>`max(${conversations.updatedAt})`,
		})
		.from(projects)
		.innerJoin(
			conversations,
			and(
				eq(conversations.projectId, projects.id),
				eq(conversations.userId, projects.userId),
			),
		)
		.where(and(eq(projects.userId, userId), conversationHasMessages()))
		.groupBy(projects.id)
		.orderBy(desc(sql`max(${conversations.updatedAt})`), asc(projects.id))
		.limit(limit);

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		color: row.color,
		chatCount: row.chatCount,
		lastActivityAt: row.lastActivityAt,
		hasInstructions: Boolean(row.instructions?.trim()),
	}));
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
