import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { count, eq, inArray, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	analyticsConversations,
	sessions,
	usageEvents,
	users,
} from "$lib/server/db/schema";
import type { AdminManagedUserSummary, UserRole } from "$lib/types";
import {
	DETACHED_SHARED_CONTENT_OWNER_ID,
	eraseUserAccountAsAdmin,
} from "./privacy-controls";
import { modelPreferenceStorageForSystemDefault } from "./model-preferences";

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

async function getUserById(userId: string) {
	const [row] = await db
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row ?? null;
}

async function countAdmins(): Promise<number> {
	const rows = await db
		.select({ count: count(users.id) })
		.from(users)
		.where(eq(users.role, "admin"));
	return Number(rows[0]?.count ?? 0);
}

async function ensureNotLastAdmin(userId: string): Promise<void> {
	const user = await getUserById(userId);
	if (!user || user.role !== "admin") return;

	const adminCount = await countAdmins();
	if (adminCount <= 1) {
		throw new Error("The last admin account cannot be removed or demoted.");
	}
}

export async function listManagedUsers(): Promise<AdminManagedUserSummary[]> {
	const userRows = (await db.select().from(users)).filter(
		(row) => row.id !== DETACHED_SHARED_CONTENT_OWNER_ID,
	);

	if (userRows.length === 0) {
		return [];
	}

	const userIds = userRows.map((row) => row.id);

	const conversationRows = await db
		.select({
			userId: analyticsConversations.userId,
			conversationCount: count(analyticsConversations.id),
		})
		.from(analyticsConversations)
		.where(inArray(analyticsConversations.userId, userIds))
		.groupBy(analyticsConversations.userId);

	const analyticsRows = await db
		.select({
			userId: usageEvents.userId,
			messageCount: count(usageEvents.id),
			promptTokens: sql<number>`coalesce(sum(${usageEvents.promptTokens}), 0)`,
			cachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)`,
			cacheHitTokens: sql<number>`coalesce(sum(${usageEvents.cacheHitTokens}), 0)`,
			cacheMissTokens: sql<number>`coalesce(sum(${usageEvents.cacheMissTokens}), 0)`,
			completionTokens: sql<number>`coalesce(sum(${usageEvents.completionTokens}), 0)`,
			reasoningTokens: sql<number>`coalesce(sum(${usageEvents.reasoningTokens}), 0)`,
		})
		.from(usageEvents)
		.where(inArray(usageEvents.userId, userIds))
		.groupBy(usageEvents.userId);

	const favoriteModelRows = await db
		.select({
			userId: usageEvents.userId,
			model: usageEvents.modelId,
			messageCount: count(usageEvents.id),
		})
		.from(usageEvents)
		.where(inArray(usageEvents.userId, userIds))
		.groupBy(usageEvents.userId, usageEvents.modelId);

	const sessionRows = await db
		.select({
			userId: sessions.userId,
			activeSessionCount: count(sessions.id),
		})
		.from(sessions)
		.where(inArray(sessions.userId, userIds))
		.groupBy(sessions.userId);

	const conversationsByUser = new Map(
		conversationRows.map((row) => [
			row.userId,
			{
				conversationCount: Number(row.conversationCount ?? 0),
			},
		]),
	);
	const analyticsByUser = new Map(
		analyticsRows.map((row) => [
			row.userId,
			{
				messageCount: Number(row.messageCount ?? 0),
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

	const favoriteModelByUser = new Map<
		string,
		{ model: string; messageCount: number }
	>();
	for (const row of favoriteModelRows) {
		const current = favoriteModelByUser.get(row.userId);
		const next = {
			model: row.model,
			messageCount: Number(row.messageCount ?? 0),
		};
		if (!current || next.messageCount > current.messageCount) {
			favoriteModelByUser.set(row.userId, next);
		}
	}

	return userRows
		.map((row) => {
			const conversation = conversationsByUser.get(row.id);
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
				conversationCount: conversation?.conversationCount ?? 0,
				messageCount: analytics?.messageCount ?? 0,
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

	const existing = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);
	if (existing.length > 0) {
		throw new Error("A user with that email already exists.");
	}

	const modelPreferenceStorage = await modelPreferenceStorageForSystemDefault(
		getConfig(),
	);

	await db.insert(users).values({
		id: randomUUID(),
		email,
		name,
		passwordHash: await bcrypt.hash(password, 12),
		...modelPreferenceStorage,
		role,
		updatedAt: new Date(),
	});

	const allUsers = await listManagedUsers();
	const created = allUsers.find((user) => user.email === email);
	if (!created) {
		throw new Error("User was created but could not be reloaded.");
	}

	return created;
}

export async function updateManagedUserRole(params: {
	actorUserId: string;
	targetUserId: string;
	role: UserRole;
}): Promise<AdminManagedUserSummary> {
	if (params.actorUserId === params.targetUserId) {
		throw new Error(
			"Use your own account settings to manage your own admin access.",
		);
	}

	const target = await getUserById(params.targetUserId);
	if (!target) {
		throw new Error("User not found.");
	}

	if (target.role === params.role) {
		const allUsers = await listManagedUsers();
		const existing = allUsers.find((user) => user.id === params.targetUserId);
		if (!existing) throw new Error("User not found.");
		return existing;
	}

	if (params.role !== "admin") {
		await ensureNotLastAdmin(params.targetUserId);
	}

	await db
		.update(users)
		.set({ role: params.role, updatedAt: new Date() })
		.where(eq(users.id, params.targetUserId));

	const allUsers = await listManagedUsers();
	const updated = allUsers.find((user) => user.id === params.targetUserId);
	if (!updated) {
		throw new Error("User was updated but could not be reloaded.");
	}

	return updated;
}

export async function revokeManagedUserSessions(
	targetUserId: string,
): Promise<void> {
	const target = await getUserById(targetUserId);
	if (!target) {
		throw new Error("User not found.");
	}

	await db.delete(sessions).where(eq(sessions.userId, targetUserId));
}

export async function deleteManagedUser(params: {
	actorUserId: string;
	targetUserId: string;
}): Promise<void> {
	if (params.actorUserId === params.targetUserId) {
		throw new Error(
			"Use your own account settings to delete your own account.",
		);
	}

	const target = await getUserById(params.targetUserId);
	if (!target) {
		throw new Error("User not found.");
	}

	await ensureNotLastAdmin(params.targetUserId);
	await eraseUserAccountAsAdmin(params.targetUserId);
}
