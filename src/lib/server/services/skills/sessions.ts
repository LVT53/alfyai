import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	conversations,
	skillSessionMilestones,
	skillSessions,
} from "$lib/server/db/schema";
import type {
	PendingSkillSelection,
	SkillControlOperation,
	SkillSession,
	SkillSessionInternal,
	SkillSessionMilestone,
	SkillSessionMilestoneKind,
} from "$lib/types";
import { getAvailableSkillDefinition } from "./user-skills";

export class SkillSessionError extends Error {
	constructor(
		public code: string,
		message: string,
		public status = 400,
	) {
		super(message);
		this.name = "SkillSessionError";
	}
}

function assertSessionsEnabled() {
	if (!getConfig().composerCommandRegistryEnabled) {
		throw new SkillSessionError(
			"skill_sessions_disabled",
			"Skill sessions are disabled.",
			403,
		);
	}
}

function toUnixSeconds(value: Date | null): number | null {
	return value ? Math.floor(value.getTime() / 1000) : null;
}

function parseStringArray(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function parseObject(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function toMilestone(
	row: typeof skillSessionMilestones.$inferSelect,
): SkillSessionMilestone {
	return {
		id: row.id,
		sessionId: row.sessionId,
		userId: row.userId,
		conversationId: row.conversationId,
		kind: row.kind as SkillSessionMilestoneKind,
		messageKey: row.messageKey,
		messageParams: parseObject(row.messageParamsJson),
		createdAt: toUnixSeconds(row.createdAt) ?? 0,
	};
}

function toSession(
	row: typeof skillSessions.$inferSelect,
	milestones: SkillSessionMilestone[],
): SkillSessionInternal {
	return {
		id: row.id,
		userId: row.userId,
		conversationId: row.conversationId,
		skillId: row.skillId,
		skillOwnership: row.skillOwnership as "user" | "system",
		status: row.status as SkillSession["status"],
		pauseReason: row.pauseReason,
		endReason: row.endReason,
		skillDisplayName: row.skillDisplayName,
		skillDescription: row.skillDescription,
		skillInstructions: row.skillInstructions,
		activationExamples: parseStringArray(row.activationExamplesJson),
		durationPolicy: row.durationPolicy as SkillSession["durationPolicy"],
		questionPolicy: row.questionPolicy as SkillSession["questionPolicy"],
		notesPolicy: row.notesPolicy as SkillSession["notesPolicy"],
		sourceScope: row.sourceScope as SkillSession["sourceScope"],
		skillVersion: row.skillVersion,
		startedFrom: row.startedFrom as "pending_skill",
		startedAt: toUnixSeconds(row.startedAt) ?? 0,
		updatedAt: toUnixSeconds(row.updatedAt) ?? 0,
		pausedAt: toUnixSeconds(row.pausedAt),
		endedAt: toUnixSeconds(row.endedAt),
		milestones,
	};
}

export function serializePublicSkillSession(
	session: SkillSessionInternal | null,
): SkillSession | null {
	if (!session) return null;
	const { skillInstructions: _skillInstructions, ...publicSession } = session;
	return publicSession;
}

async function assertConversationOwner(userId: string, conversationId: string) {
	const row = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(
			and(
				eq(conversations.id, conversationId),
				eq(conversations.userId, userId),
			),
		)
		.get();

	if (!row) {
		throw new SkillSessionError(
			"conversation_not_found",
			"Conversation not found.",
			404,
		);
	}
}

async function listMilestones(sessionIds: string[]) {
	if (sessionIds.length === 0)
		return new Map<string, SkillSessionMilestone[]>();
	const rows = await db
		.select()
		.from(skillSessionMilestones)
		.where(inArray(skillSessionMilestones.sessionId, sessionIds))
		.orderBy(asc(skillSessionMilestones.createdAt));

	const grouped = new Map<string, SkillSessionMilestone[]>();
	for (const row of rows) {
		const milestone = toMilestone(row);
		grouped.set(row.sessionId, [
			...(grouped.get(row.sessionId) ?? []),
			milestone,
		]);
	}
	return grouped;
}

async function hydrateSession(
	row: typeof skillSessions.$inferSelect,
): Promise<SkillSessionInternal> {
	const milestones = await listMilestones([row.id]);
	return toSession(row, milestones.get(row.id) ?? []);
}

async function getCurrentSessionRow(userId: string, conversationId: string) {
	return db
		.select()
		.from(skillSessions)
		.where(
			and(
				eq(skillSessions.userId, userId),
				eq(skillSessions.conversationId, conversationId),
				inArray(skillSessions.status, ["active", "paused"]),
			),
		)
		.orderBy(desc(skillSessions.updatedAt))
		.get();
}

async function appendMilestone(
	session: Pick<
		typeof skillSessions.$inferSelect,
		"id" | "userId" | "conversationId" | "skillDisplayName"
	>,
	kind: SkillSessionMilestoneKind,
	messageKey: string,
	messageParams?: Record<string, unknown>,
) {
	await db.insert(skillSessionMilestones).values({
		id: randomUUID(),
		sessionId: session.id,
		userId: session.userId,
		conversationId: session.conversationId,
		kind,
		messageKey,
		messageParamsJson: JSON.stringify({
			skillDisplayName: session.skillDisplayName,
			...(messageParams ?? {}),
		}),
	});
}

export async function startSkillSession(
	userId: string,
	conversationId: string,
	pendingSkill: PendingSkillSelection,
): Promise<SkillSessionInternal> {
	assertSessionsEnabled();
	await assertConversationOwner(userId, conversationId);

	const existing = await getCurrentSessionRow(userId, conversationId);
	if (existing?.status === "active") {
		if (
			existing.skillId !== pendingSkill.id ||
			existing.skillOwnership !== pendingSkill.ownership
		) {
			throw new SkillSessionError(
				"active_skill_session_conflict",
				"Another skill session is already active.",
				409,
			);
		}
		return hydrateSession(existing);
	}

	const skill = await getAvailableSkillDefinition(userId, pendingSkill);
	if (!skill) {
		throw new SkillSessionError(
			"skill_unavailable",
			"Selected skill is no longer available.",
			409,
		);
	}

	const sessionId = randomUUID();
	db.transaction((tx) => {
		tx.insert(skillSessions)
			.values({
				id: sessionId,
				userId,
				conversationId,
				skillId: skill.id,
				skillOwnership: skill.ownership,
				status: "active",
				skillDisplayName: skill.displayName,
				skillDescription: skill.description,
				skillInstructions: skill.instructions,
				activationExamplesJson: JSON.stringify(skill.activationExamples),
				durationPolicy: skill.durationPolicy,
				questionPolicy: skill.questionPolicy,
				notesPolicy: skill.notesPolicy,
				sourceScope: skill.sourceScope,
				skillVersion: skill.version,
				startedFrom: "pending_skill",
			})
			.run();
		tx.insert(skillSessionMilestones)
			.values({
				id: randomUUID(),
				sessionId,
				userId,
				conversationId,
				kind: "started",
				messageKey: "skillSessions.milestones.started",
				messageParamsJson: JSON.stringify({
					skillDisplayName: skill.displayName,
				}),
			})
			.run();
	});

	const row = await db
		.select()
		.from(skillSessions)
		.where(eq(skillSessions.id, sessionId))
		.get();
	if (!row) {
		throw new SkillSessionError(
			"session_create_failed",
			"Failed to create skill session.",
			500,
		);
	}
	return hydrateSession(row);
}

export async function getActiveSkillSession(
	userId: string,
	conversationId: string,
): Promise<SkillSessionInternal | null> {
	await assertConversationOwner(userId, conversationId);
	const row = await getCurrentSessionRow(userId, conversationId);
	if (!row) return null;

	if (row.status === "active") {
		const skill = await getAvailableSkillDefinition(userId, {
			id: row.skillId,
			ownership: row.skillOwnership as "user" | "system",
		});
		if (!skill) {
			const [paused] = await db
				.update(skillSessions)
				.set({
					status: "paused",
					pauseReason: "unavailable",
					pausedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(skillSessions.id, row.id))
				.returning();
			if (paused) {
				await appendMilestone(
					paused,
					"unavailable",
					"skillSessions.milestones.unavailable",
				);
				return hydrateSession(paused);
			}
		}
	}

	return hydrateSession(row);
}

export async function pauseSkillSession(
	userId: string,
	conversationId: string,
	reason = "user_paused",
): Promise<SkillSessionInternal | null> {
	assertSessionsEnabled();
	await assertConversationOwner(userId, conversationId);
	const row = await getCurrentSessionRow(userId, conversationId);
	if (!row) return null;
	if (row.status === "paused") return hydrateSession(row);

	const [paused] = await db
		.update(skillSessions)
		.set({
			status: "paused",
			pauseReason: reason,
			pausedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(skillSessions.id, row.id))
		.returning();
	if (!paused) return null;
	await appendMilestone(paused, "paused", "skillSessions.milestones.paused");
	return hydrateSession(paused);
}

export async function endSkillSession(
	userId: string,
	conversationId: string,
	reason: "ended" | "dismissed" = "ended",
): Promise<SkillSessionInternal | null> {
	assertSessionsEnabled();
	await assertConversationOwner(userId, conversationId);
	const row = await getCurrentSessionRow(userId, conversationId);
	if (!row) return null;

	const [ended] = await db
		.update(skillSessions)
		.set({
			status: "ended",
			endReason: reason,
			endedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(skillSessions.id, row.id))
		.returning();
	if (!ended) return null;

	await appendMilestone(
		ended,
		reason === "dismissed" ? "dismissed" : "ended",
		reason === "dismissed"
			? "skillSessions.milestones.dismissed"
			: "skillSessions.milestones.ended",
	);
	return hydrateSession(ended);
}

function hasAppliedOperation(
	milestones: SkillSessionMilestone[],
	operationId: string,
): boolean {
	return milestones.some(
		(milestone) => milestone.messageParams.envelopeOperationId === operationId,
	);
}

export async function applySkillControlOperations(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	operations: SkillControlOperation[];
}): Promise<SkillSessionInternal | null> {
	assertSessionsEnabled();
	await assertConversationOwner(params.userId, params.conversationId);
	const row = await getCurrentSessionRow(params.userId, params.conversationId);
	if (!row) return null;

	let current = await hydrateSession(row);
	for (const operation of params.operations) {
		if (hasAppliedOperation(current.milestones, operation.operationId)) {
			continue;
		}

		if (operation.kind !== "session_transition") {
			continue;
		}

		const messageParams = {
			envelopeOperationId: operation.operationId,
			assistantMessageId: params.assistantMessageId,
		};

		if (operation.transition === "awaiting_user") {
			await appendMilestone(
				row,
				"awaiting_user",
				"skillSessions.milestones.awaitingUser",
				messageParams,
			);
		} else if (operation.transition === "failed_note") {
			await appendMilestone(
				row,
				"failed_note",
				"skillSessions.milestones.failedNote",
				messageParams,
			);
		} else if (
			operation.transition === "finished" ||
			operation.transition === "dismissed"
		) {
			const [ended] = await db
				.update(skillSessions)
				.set({
					status: "ended",
					endReason:
						operation.transition === "dismissed" ? "dismissed" : "ended",
					endedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(skillSessions.id, row.id))
				.returning();
			if (!ended) return current;
			await appendMilestone(
				ended,
				operation.transition === "dismissed" ? "dismissed" : "ended",
				operation.transition === "dismissed"
					? "skillSessions.milestones.dismissed"
					: "skillSessions.milestones.ended",
				messageParams,
			);
			return hydrateSession(ended);
		}

		current = await hydrateSession(row);
	}

	return current;
}

export async function recordSkillNoteFailureMilestone(params: {
	userId: string;
	conversationId: string;
	sessionId: string;
	assistantMessageId: string;
	operationId: string;
	errorCode: string;
	errorMessage: string;
}): Promise<SkillSessionInternal | null> {
	assertSessionsEnabled();
	await assertConversationOwner(params.userId, params.conversationId);
	const row = await db
		.select()
		.from(skillSessions)
		.where(
			and(
				eq(skillSessions.id, params.sessionId),
				eq(skillSessions.userId, params.userId),
				eq(skillSessions.conversationId, params.conversationId),
			),
		)
		.get();
	if (!row) return null;

	const current = await hydrateSession(row);
	if (hasAppliedOperation(current.milestones, params.operationId)) {
		return current;
	}

	await appendMilestone(
		row,
		"failed_note",
		"skillSessions.milestones.failedNote",
		{
			envelopeOperationId: params.operationId,
			assistantMessageId: params.assistantMessageId,
			errorCode: params.errorCode,
			errorMessage: params.errorMessage,
		},
	);
	return hydrateSession(row);
}
