import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import {
	type QueryExecutor,
	queryExecutor,
} from "$lib/server/db/query-executor";
import {
	conversations,
	messageAnalytics,
	messages,
	sessions,
	usageEvents,
	users,
} from "$lib/server/db/schema";
import type { UserRole } from "$lib/server/services/auth-types";
import { modelPreferenceStorageForSystemDefault } from "./model-preferences";
import {
	DETACHED_SHARED_CONTENT_OWNER_ID,
	eraseUserAccountAsAdmin,
} from "./privacy-controls";

export interface CreateManagedUserInput {
	email: string;
	password: string;
	name?: string | null;
	role?: UserRole;
}

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function normalizeName(name: string | null | undefined): string | null {
	if (typeof name !== "string") return null;
	const trimmed = name.trim();
	return trimmed ? trimmed : null;
}

async function getUserById(executor: QueryExecutor, userId: string) {
	const [row] = await executor.run("userAdmin.getUserById", (db) =>
		db.select().from(users).where(eq(users.id, userId)).limit(1),
	);
	return row ?? null;
}

async function countAdmins(executor: QueryExecutor): Promise<number> {
	const rows = await executor.run("userAdmin.countAdmins", (db) =>
		db
			.select({ count: count(users.id) })
			.from(users)
			.where(eq(users.role, "admin")),
	);
	return Number(rows[0]?.count ?? 0);
}

async function ensureNotLastAdmin(
	executor: QueryExecutor,
	userId: string,
): Promise<void> {
	const user = await getUserById(executor, userId);
	if (user?.role !== "admin") return;

	const adminCount = await countAdmins(executor);
	if (adminCount <= 1) {
		throw new Error("The last admin account cannot be removed or demoted.");
	}
}

export async function listManagedUsers(
	executor: QueryExecutor = queryExecutor,
): Promise<AdminManagedUserSummary[]> {
	const userRows = (
		await executor.run("userAdmin.listUsers", (db) => db.select().from(users))
	).filter((row) => row.id !== DETACHED_SHARED_CONTENT_OWNER_ID);

	if (userRows.length === 0) {
		return [];
	}

	const userIds = userRows.map((row) => row.id);

	// "Messages" and "Conversations" on this screen are about what a PERSON
	// did, so they count user-authored rows in `messages` (attributed through
	// conversations.user_id, which is where a message's owner lives) and the
	// conversations carrying at least one of them. They deliberately do NOT
	// count usage_events: that table holds one row per billed model call,
	// background calls included, which is the right grain for the token and
	// cost columns below and the wrong grain for these two. Incognito
	// conversations stay out, matching the usage side, which never records
	// them at all.
	const activityRows = await executor.run(
		"userAdmin.userMessageCountsByUser",
		(db) =>
			db
				.select({
					userId: conversations.userId,
					messageCount: count(messages.id),
					conversationCount: sql<number>`count(distinct ${messages.conversationId})`,
				})
				.from(messages)
				.innerJoin(conversations, eq(messages.conversationId, conversations.id))
				.where(
					and(
						eq(messages.role, "user"),
						eq(conversations.memoryIncognito, false),
						inArray(conversations.userId, userIds),
					),
				)
				.groupBy(conversations.userId),
	);

	// Tokens ARE about cost, so they stay wholesale over usage_events.
	const analyticsRows = await executor.run(
		"userAdmin.usageTotalsByUser",
		(db) =>
			db
				.select({
					userId: usageEvents.userId,
					modelCalls: count(usageEvents.id),
					promptTokens: sql<number>`coalesce(sum(${usageEvents.promptTokens}), 0)`,
					cachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)`,
					cacheHitTokens: sql<number>`coalesce(sum(${usageEvents.cacheHitTokens}), 0)`,
					cacheMissTokens: sql<number>`coalesce(sum(${usageEvents.cacheMissTokens}), 0)`,
					completionTokens: sql<number>`coalesce(sum(${usageEvents.completionTokens}), 0)`,
					reasoningTokens: sql<number>`coalesce(sum(${usageEvents.reasoningTokens}), 0)`,
				})
				.from(usageEvents)
				.where(inArray(usageEvents.userId, userIds))
				.groupBy(usageEvents.userId),
	);

	// The favourite model is the one that ANSWERS the person most often, not
	// the one with the most usage_events rows — background calls (the
	// thought-step classifier above all) outnumber answering calls, so a
	// wholesale ranking would crown the control model for every account.
	// message_analytics is written only on the foreground turn path, so
	// joining it is exactly the "this call answered a persisted assistant
	// message" test. A user whose rows predate that table falls back to the
	// wholesale ranking rather than showing no favourite at all.
	const favoriteModelRows = await executor.run(
		"userAdmin.favoriteModelByUser",
		(db) =>
			db
				.select({
					userId: usageEvents.userId,
					model: usageEvents.modelId,
					callCount: count(usageEvents.id),
					answeringCallCount: sql<number>`sum(case when ${messageAnalytics.messageId} is null then 0 else 1 end)`,
				})
				.from(usageEvents)
				.leftJoin(
					messageAnalytics,
					eq(messageAnalytics.messageId, usageEvents.messageId),
				)
				.where(inArray(usageEvents.userId, userIds))
				.groupBy(usageEvents.userId, usageEvents.modelId),
	);

	const sessionRows = await executor.run(
		"userAdmin.activeSessionCountsByUser",
		(db) =>
			db
				.select({
					userId: sessions.userId,
					activeSessionCount: count(sessions.id),
				})
				.from(sessions)
				.where(inArray(sessions.userId, userIds))
				.groupBy(sessions.userId),
	);

	const activityByUser = new Map(
		activityRows.map((row) => [
			row.userId,
			{
				messageCount: Number(row.messageCount ?? 0),
				conversationCount: Number(row.conversationCount ?? 0),
			},
		]),
	);
	const analyticsByUser = new Map(
		analyticsRows.map((row) => [
			row.userId,
			{
				modelCalls: Number(row.modelCalls ?? 0),
				promptTokens: Number(row.promptTokens ?? 0),
				cachedInputTokens: Number(row.cachedInputTokens ?? 0),
				cacheHitTokens: Number(row.cacheHitTokens ?? 0),
				cacheMissTokens: Number(row.cacheMissTokens ?? 0),
				completionTokens: Number(row.completionTokens ?? 0),
				reasoningTokens: Number(row.reasoningTokens ?? 0),
			},
		]),
	);
	const sessionsByUser = new Map(
		sessionRows.map((row) => [row.userId, Number(row.activeSessionCount ?? 0)]),
	);

	const answeringCallsByUser = new Map<string, number>();
	for (const row of favoriteModelRows) {
		answeringCallsByUser.set(
			row.userId,
			(answeringCallsByUser.get(row.userId) ?? 0) +
				Number(row.answeringCallCount ?? 0),
		);
	}
	const favoriteModelByUser = new Map<
		string,
		{ model: string; votes: number }
	>();
	for (const row of favoriteModelRows) {
		const hasAnswers = (answeringCallsByUser.get(row.userId) ?? 0) > 0;
		const votes = hasAnswers
			? Number(row.answeringCallCount ?? 0)
			: Number(row.callCount ?? 0);
		if (votes <= 0) continue;
		const current = favoriteModelByUser.get(row.userId);
		if (!current || votes > current.votes) {
			favoriteModelByUser.set(row.userId, { model: row.model, votes });
		}
	}

	return userRows
		.map((row) => {
			const activity = activityByUser.get(row.id);
			const analytics = analyticsByUser.get(row.id);
			const promptTokens = analytics?.promptTokens ?? 0;
			const cachedInputTokens = analytics?.cachedInputTokens ?? 0;
			const cacheHitTokens = analytics?.cacheHitTokens ?? 0;
			const cacheMissTokens = analytics?.cacheMissTokens ?? 0;
			const completionTokens = analytics?.completionTokens ?? 0;
			const reasoningTokens = analytics?.reasoningTokens ?? 0;
			return {
				id: row.id,
				email: row.email,
				name: row.name ?? null,
				role: (row.role ?? "user") as UserRole,
				createdAt: Number(row.createdAt),
				updatedAt: Number(row.updatedAt),
				conversationCount: activity?.conversationCount ?? 0,
				messageCount: activity?.messageCount ?? 0,
				modelCalls: analytics?.modelCalls ?? 0,
				promptTokens,
				cachedInputTokens,
				cacheHitTokens,
				cacheMissTokens,
				completionTokens,
				reasoningTokens,
				totalTokenCount:
					promptTokens +
					cachedInputTokens +
					cacheHitTokens +
					cacheMissTokens +
					completionTokens +
					reasoningTokens,
				favoriteModel: favoriteModelByUser.get(row.id)?.model ?? null,
				activeSessionCount: sessionsByUser.get(row.id) ?? 0,
				lastActiveAt: row.lastSeenAt
					? Number(row.lastSeenAt)
					: Number(row.createdAt),
			} satisfies AdminManagedUserSummary;
		})
		.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

export async function createManagedUser(
	input: CreateManagedUserInput,
	executor: QueryExecutor = queryExecutor,
): Promise<AdminManagedUserSummary> {
	const email = normalizeEmail(input.email);
	const password = input.password;
	const role = input.role === "admin" ? "admin" : "user";
	const name = normalizeName(input.name);

	if (!email?.includes("@")) {
		throw new Error("A valid email address is required.");
	}
	if (password.length < 8) {
		throw new Error("Password must be at least 8 characters.");
	}

	const existing = await executor.run("userAdmin.findByEmail", (db) =>
		db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, email))
			.limit(1),
	);
	if (existing.length > 0) {
		throw new Error("A user with that email already exists.");
	}

	const modelPreferenceStorage = await modelPreferenceStorageForSystemDefault(
		getConfig(),
	);
	const passwordHash = await bcrypt.hash(password, 12);

	await executor.run("userAdmin.insertUser", (db) =>
		db.insert(users).values({
			id: randomUUID(),
			email,
			name,
			passwordHash,
			...modelPreferenceStorage,
			role,
			updatedAt: new Date(),
		}),
	);

	const allUsers = await listManagedUsers(executor);
	const created = allUsers.find((user) => user.email === email);
	if (!created) {
		throw new Error("User was created but could not be reloaded.");
	}

	return created;
}

export async function updateManagedUserRole(
	params: {
		actorUserId: string;
		targetUserId: string;
		role: UserRole;
	},
	executor: QueryExecutor = queryExecutor,
): Promise<AdminManagedUserSummary> {
	if (params.actorUserId === params.targetUserId) {
		throw new Error(
			"Use your own account settings to manage your own admin access.",
		);
	}

	const target = await getUserById(executor, params.targetUserId);
	if (!target) {
		throw new Error("User not found.");
	}

	if (target.role === params.role) {
		const allUsers = await listManagedUsers(executor);
		const existing = allUsers.find((user) => user.id === params.targetUserId);
		if (!existing) throw new Error("User not found.");
		return existing;
	}

	if (params.role !== "admin") {
		await ensureNotLastAdmin(executor, params.targetUserId);
	}

	await executor.run("userAdmin.updateRole", (db) =>
		db
			.update(users)
			.set({ role: params.role, updatedAt: new Date() })
			.where(eq(users.id, params.targetUserId)),
	);

	const allUsers = await listManagedUsers(executor);
	const updated = allUsers.find((user) => user.id === params.targetUserId);
	if (!updated) {
		throw new Error("User was updated but could not be reloaded.");
	}

	return updated;
}

export async function revokeManagedUserSessions(
	targetUserId: string,
	executor: QueryExecutor = queryExecutor,
): Promise<void> {
	const target = await getUserById(executor, targetUserId);
	if (!target) {
		throw new Error("User not found.");
	}

	await executor.run("userAdmin.revokeSessions", (db) =>
		db.delete(sessions).where(eq(sessions.userId, targetUserId)),
	);
}

export async function deleteManagedUser(
	params: {
		actorUserId: string;
		targetUserId: string;
	},
	executor: QueryExecutor = queryExecutor,
): Promise<void> {
	if (params.actorUserId === params.targetUserId) {
		throw new Error(
			"Use your own account settings to delete your own account.",
		);
	}

	const target = await getUserById(executor, params.targetUserId);
	if (!target) {
		throw new Error("User not found.");
	}

	await ensureNotLastAdmin(executor, params.targetUserId);
	await eraseUserAccountAsAdmin(params.targetUserId);
}

// Relocated out of the former src/lib/types.ts god-module
// (architecture-deepening T1); this type carries no behavior change, only
// a new home next to the admin user-management service that produces it.
export interface AdminManagedUserSummary {
	id: string;
	email: string;
	name: string | null;
	role: UserRole;
	createdAt: number;
	updatedAt: number;
	/** Conversations carrying at least one user-authored message. */
	conversationCount: number;
	/** Messages the person wrote (`messages` rows with role = 'user'). */
	messageCount: number;
	/** Billed model calls booked against the person, background calls
	 *  included. About cost, not about what they wrote. */
	modelCalls: number;
	promptTokens: number;
	cachedInputTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	totalTokenCount: number;
	favoriteModel: string | null;
	activeSessionCount: number;
	lastActiveAt: number | null;
}
