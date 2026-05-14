import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "$lib/server/db";
import {
	artifacts,
	skillNoteCheckpoints,
	skillNoteOperations,
	skillSessions,
} from "$lib/server/db/schema";
import { getConfig } from "$lib/server/config-store";
import { parseJsonRecord } from "$lib/server/utils/json";
import { syncArtifactChunks } from "$lib/server/services/task-state/chunk-sync";
import { queueArtifactSemanticEmbeddingRefresh } from "$lib/server/services/semantic-embedding-refresh";
import type { Artifact, SkillControlOperation } from "$lib/types";
import { guessSummary, mapArtifact } from "../knowledge/store";
import { recordSkillNoteFailureMilestone } from "./sessions";

const CHECKPOINT_BODY_LIMIT = 50_000;

export interface AppliedSkillNoteOperation {
	operationId: string;
	action: "create" | "replace" | "append";
	artifactId: string;
	idempotent: boolean;
}

export interface FailedSkillNoteOperation {
	operationId: string;
	action: "create" | "replace" | "append";
	code: string;
	message: string;
}

export interface ApplySkillNoteOperationsResult {
	applied: AppliedSkillNoteOperation[];
	failures: FailedSkillNoteOperation[];
}

export class SkillNoteOperationError extends Error {
	constructor(
		public code: string,
		message: string,
		public status = 400,
	) {
		super(message);
		this.name = "SkillNoteOperationError";
	}
}

type SkillNoteOperation = Extract<
	SkillControlOperation,
	{ kind: "note_intent" }
>;

function assertNotesEnabled() {
	if (!getConfig().composerCommandRegistryEnabled) {
		throw new SkillNoteOperationError(
			"skill_notes_disabled",
			"Skill notes are disabled.",
			403,
		);
	}
}

function cleanText(value: string | undefined, field: string): string {
	const trimmed = value?.trim() ?? "";
	if (!trimmed) {
		throw new SkillNoteOperationError(
			"invalid_note_operation",
			`Skill note ${field} is required.`,
			400,
		);
	}
	return trimmed;
}

function cleanTitle(value: string | undefined): string {
	return cleanText(value, "title").slice(0, 160);
}

async function getSessionForNoteOperation(params: {
	userId: string;
	conversationId: string;
	sessionId: string;
}) {
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

	if (!row) {
		throw new SkillNoteOperationError(
			"skill_session_not_found",
			"Active skill session not found.",
			404,
		);
	}
	if (row.status !== "active") {
		throw new SkillNoteOperationError(
			"skill_session_not_active",
			"Skill note operations require an active skill session.",
			409,
		);
	}
	if (row.notesPolicy !== "create_private_notes") {
		throw new SkillNoteOperationError(
			"skill_notes_not_allowed",
			"This skill is not allowed to write notes.",
			403,
		);
	}
	return row;
}

async function getExistingOperation(params: {
	sessionId: string;
	assistantMessageId: string;
	operationId: string;
}): Promise<AppliedSkillNoteOperation | null> {
	const row = await db
		.select()
		.from(skillNoteOperations)
		.where(
			and(
				eq(skillNoteOperations.sessionId, params.sessionId),
				eq(skillNoteOperations.assistantMessageId, params.assistantMessageId),
				eq(skillNoteOperations.operationId, params.operationId),
			),
		)
		.get();
	if (!row) return null;
	return {
		operationId: row.operationId,
		action: row.action as AppliedSkillNoteOperation["action"],
		artifactId: row.artifactId,
		idempotent: true,
	};
}

function buildSkillNoteMetadata(params: {
	session: typeof skillSessions.$inferSelect;
	assistantMessageId: string;
	operation: SkillNoteOperation;
	previousMetadata?: Record<string, unknown> | null;
}) {
	const previous = params.previousMetadata ?? {};
	return {
		...previous,
		source: "skill_note",
		retrievalAuthority: "low",
		skillSessionId: params.session.id,
		skillId: params.session.skillId,
		skillOwnership: params.session.skillOwnership,
		skillDisplayName: params.session.skillDisplayName,
		createdByAssistantMessageId:
			previous.createdByAssistantMessageId ?? params.assistantMessageId,
		lastAssistantMessageId: params.assistantMessageId,
		lastOperationId: params.operation.operationId,
		lastOperationAction: params.operation.action,
		updatedBy: "skill_control",
	};
}

async function syncNoteArtifact(artifact: Artifact) {
	await syncArtifactChunks({
		artifactId: artifact.id,
		userId: artifact.userId,
		conversationId: artifact.conversationId,
		contentText: artifact.contentText,
	});
	queueArtifactSemanticEmbeddingRefresh(artifact);
}

async function applyCreateOperation(params: {
	userId: string;
	conversationId: string;
	session: typeof skillSessions.$inferSelect;
	assistantMessageId: string;
	operation: SkillNoteOperation;
}): Promise<AppliedSkillNoteOperation> {
	const title = cleanTitle(params.operation.title);
	const body = cleanText(params.operation.body, "body");
	const artifactId = randomUUID();
	const now = new Date();
	const metadata = buildSkillNoteMetadata({
		session: params.session,
		assistantMessageId: params.assistantMessageId,
		operation: params.operation,
	});

	db.transaction((tx) => {
		tx.insert(artifacts)
			.values({
				id: artifactId,
				userId: params.userId,
				conversationId: params.conversationId,
				type: "skill_note",
				retrievalClass: "durable",
				name: title,
				mimeType: "text/markdown",
				extension: "md",
				sizeBytes: Buffer.byteLength(body, "utf8"),
				contentText: body,
				summary: guessSummary(body, title),
				metadataJson: JSON.stringify(metadata),
				updatedAt: now,
			})
			.run();
		tx.insert(skillNoteOperations)
			.values({
				id: randomUUID(),
				sessionId: params.session.id,
				userId: params.userId,
				conversationId: params.conversationId,
				assistantMessageId: params.assistantMessageId,
				operationId: params.operation.operationId,
				action: params.operation.action,
				artifactId,
			})
			.run();
	});

	const row = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).get();
	if (row) {
		await syncNoteArtifact(mapArtifact(row));
	}

	return {
		operationId: params.operation.operationId,
		action: params.operation.action,
		artifactId,
		idempotent: false,
	};
}

async function getMutableSkillNoteTarget(params: {
	userId: string;
	conversationId: string;
	artifactId: string;
}) {
	const row = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, params.artifactId),
				eq(artifacts.userId, params.userId),
				eq(artifacts.conversationId, params.conversationId),
			),
		)
		.get();

	if (!row || row.type !== "skill_note") {
		throw new SkillNoteOperationError(
			"invalid_note_target",
			"Skill note operations can only mutate Skill Notes.",
			403,
		);
	}
	return row;
}

async function applyUpdateOperation(params: {
	userId: string;
	conversationId: string;
	session: typeof skillSessions.$inferSelect;
	assistantMessageId: string;
	operation: Extract<SkillNoteOperation, { action: "replace" | "append" }>;
}): Promise<AppliedSkillNoteOperation> {
	const body = cleanText(params.operation.body, "body");
	const target = await getMutableSkillNoteTarget({
		userId: params.userId,
		conversationId: params.conversationId,
		artifactId: params.operation.targetArtifactId,
	});
	const previousBody = target.contentText ?? "";
	const nextBody =
		params.operation.action === "replace"
			? body
			: [previousBody.trim(), body].filter(Boolean).join("\n\n");
	const previousMetadata = parseJsonRecord(target.metadataJson ?? null);
	const nextMetadata = buildSkillNoteMetadata({
		session: params.session,
		assistantMessageId: params.assistantMessageId,
		operation: params.operation,
		previousMetadata,
	});
	const now = new Date();

	db.transaction((tx) => {
		if (params.operation.action === "replace") {
			tx.insert(skillNoteCheckpoints)
				.values({
					id: randomUUID(),
					noteArtifactId: target.id,
					sessionId: params.session.id,
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: params.assistantMessageId,
					operationId: params.operation.operationId,
					previousBody: previousBody.slice(0, CHECKPOINT_BODY_LIMIT),
					previousMetadataJson: target.metadataJson,
				})
				.run();
		}
		tx.update(artifacts)
			.set({
				contentText: nextBody,
				sizeBytes: Buffer.byteLength(nextBody, "utf8"),
				summary: guessSummary(nextBody, target.name),
				metadataJson: JSON.stringify(nextMetadata),
				updatedAt: now,
			})
			.where(eq(artifacts.id, target.id))
			.run();
		tx.insert(skillNoteOperations)
			.values({
				id: randomUUID(),
				sessionId: params.session.id,
				userId: params.userId,
				conversationId: params.conversationId,
				assistantMessageId: params.assistantMessageId,
				operationId: params.operation.operationId,
				action: params.operation.action,
				artifactId: target.id,
			})
			.run();
	});

	const row = await db.select().from(artifacts).where(eq(artifacts.id, target.id)).get();
	if (row) {
		await syncNoteArtifact(mapArtifact(row));
	}

	return {
		operationId: params.operation.operationId,
		action: params.operation.action,
		artifactId: target.id,
		idempotent: false,
	};
}

function failureFromError(operation: SkillNoteOperation, error: unknown): FailedSkillNoteOperation {
	if (error instanceof SkillNoteOperationError) {
		return {
			operationId: operation.operationId,
			action: operation.action,
			code: error.code,
			message: error.message,
		};
	}
	return {
		operationId: operation.operationId,
		action: operation.action,
		code: "skill_note_operation_failed",
		message: error instanceof Error ? error.message : String(error),
	};
}

export async function applySkillNoteOperations(params: {
	userId: string;
	conversationId: string;
	sessionId: string;
	assistantMessageId: string;
	operations: SkillNoteOperation[];
}): Promise<ApplySkillNoteOperationsResult> {
	assertNotesEnabled();
	const session = await getSessionForNoteOperation(params);
	const applied: AppliedSkillNoteOperation[] = [];
	const failures: FailedSkillNoteOperation[] = [];

	for (const operation of params.operations) {
		const existing = await getExistingOperation({
			sessionId: params.sessionId,
			assistantMessageId: params.assistantMessageId,
			operationId: operation.operationId,
		});
		if (existing) {
			applied.push(existing);
			continue;
		}

		try {
			if (operation.action === "create") {
				applied.push(
					await applyCreateOperation({
						userId: params.userId,
						conversationId: params.conversationId,
						session,
						assistantMessageId: params.assistantMessageId,
						operation,
					}),
				);
				continue;
			}
			applied.push(
				await applyUpdateOperation({
					userId: params.userId,
					conversationId: params.conversationId,
					session,
					assistantMessageId: params.assistantMessageId,
					operation,
				}),
			);
		} catch (error) {
			failures.push(failureFromError(operation, error));
		}
	}

	return { applied, failures };
}

export async function commitSkillNoteOperationsAfterAssistantMessage(params: {
	userId: string;
	conversationId: string;
	sessionId: string | null | undefined;
	assistantMessageId: string;
	operations: SkillControlOperation[];
}): Promise<ApplySkillNoteOperationsResult | null> {
	const noteOperations = params.operations.filter(
		(operation): operation is SkillNoteOperation => operation.kind === "note_intent",
	);
	if (noteOperations.length === 0) return null;
	if (!params.sessionId) {
		const failures = noteOperations.map((operation) => ({
			operationId: operation.operationId,
			action: operation.action,
			code: "skill_session_not_found",
			message: "Skill note operation did not have an active skill session.",
		}));
		return { applied: [], failures };
	}

	const result = await applySkillNoteOperations({
		userId: params.userId,
		conversationId: params.conversationId,
		sessionId: params.sessionId,
		assistantMessageId: params.assistantMessageId,
		operations: noteOperations,
	});

	for (const failure of result.failures) {
		await recordSkillNoteFailureMilestone({
			userId: params.userId,
			conversationId: params.conversationId,
			sessionId: params.sessionId,
			assistantMessageId: params.assistantMessageId,
			operationId: failure.operationId,
			errorCode: failure.code,
			errorMessage: failure.message,
		}).catch((error) => {
			console.warn("[SKILL_NOTES] Failed to record note failure milestone", {
				conversationId: params.conversationId,
				assistantMessageId: params.assistantMessageId,
				operationId: failure.operationId,
				error,
			});
		});
	}

	return result;
}
