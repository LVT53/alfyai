import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	skillNoteCheckpoints,
	skillNoteOperations,
	skillSessions,
} from "$lib/server/db/schema";
import type { SkillControlOperation } from "$lib/types";
import {
	getMutableSkillNoteArtifact,
	insertSkillNoteArtifactRecord,
	refreshSkillNoteArtifact,
	updateSkillNoteArtifactRecord,
} from "../knowledge";
import { recordSkillNoteFailureMilestone } from "./sessions";

const MAX_NOTE_OPERATIONS_PER_TURN = 8;
const MAX_OPERATION_BODY_LENGTH = 20_000;
const MAX_FINAL_NOTE_BODY_LENGTH = 50_000;
const MAX_CHECKPOINTS_PER_NOTE = 20;

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

function assertBodyLimit(body: string, operation: SkillNoteOperation) {
	if (body.length <= MAX_OPERATION_BODY_LENGTH) return;
	throw new SkillNoteOperationError(
		operation.action === "append"
			? "note_append_too_large"
			: "note_operation_body_too_large",
		"Skill note operation body is too large.",
		413,
	);
}

function assertFinalBodyLimit(body: string) {
	if (body.length > MAX_FINAL_NOTE_BODY_LENGTH) {
		throw new SkillNoteOperationError(
			"note_final_body_too_large",
			"Skill note body would exceed the maximum size.",
			413,
		);
	}
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

async function applyCreateOperation(params: {
	userId: string;
	conversationId: string;
	session: typeof skillSessions.$inferSelect;
	assistantMessageId: string;
	operation: SkillNoteOperation;
}): Promise<AppliedSkillNoteOperation> {
	const title = cleanTitle(params.operation.title);
	const body = cleanText(params.operation.body, "body");
	assertBodyLimit(body, params.operation);
	assertFinalBodyLimit(body);
	const artifactId = randomUUID();
	const now = new Date();
	const metadata = buildSkillNoteMetadata({
		session: params.session,
		assistantMessageId: params.assistantMessageId,
		operation: params.operation,
	});

	db.transaction((tx) => {
		insertSkillNoteArtifactRecord(tx, {
			artifactId,
			userId: params.userId,
			conversationId: params.conversationId,
			title,
			body,
			metadata,
			now,
		});
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

	await refreshSkillNoteArtifact(artifactId);

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
	const artifact = await getMutableSkillNoteArtifact(params);
	if (!artifact) {
		throw new SkillNoteOperationError(
			"invalid_note_target",
			"Skill note operations can only mutate Skill Notes.",
			403,
		);
	}
	return artifact;
}

async function applyUpdateOperation(params: {
	userId: string;
	conversationId: string;
	session: typeof skillSessions.$inferSelect;
	assistantMessageId: string;
	operation: Extract<SkillNoteOperation, { action: "replace" | "append" }>;
}): Promise<AppliedSkillNoteOperation> {
	const body = cleanText(params.operation.body, "body");
	assertBodyLimit(body, params.operation);
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
	assertFinalBodyLimit(nextBody);
	const previousMetadata = target.metadata;
	const nextMetadata = buildSkillNoteMetadata({
		session: params.session,
		assistantMessageId: params.assistantMessageId,
		operation: params.operation,
		previousMetadata,
	});
	const now = new Date();
	const existingCheckpoint = await db
		.select({ id: skillNoteCheckpoints.id })
		.from(skillNoteCheckpoints)
		.where(
			and(
				eq(skillNoteCheckpoints.noteArtifactId, target.id),
				eq(skillNoteCheckpoints.assistantMessageId, params.assistantMessageId),
			),
		)
		.get();

	db.transaction((tx) => {
		if (!existingCheckpoint) {
			tx.insert(skillNoteCheckpoints)
				.values({
					id: randomUUID(),
					noteArtifactId: target.id,
					sessionId: params.session.id,
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: params.assistantMessageId,
					operationId: params.operation.operationId,
					previousBody,
					previousMetadataJson: previousMetadata
						? JSON.stringify(previousMetadata)
						: null,
				})
				.run();
		}
		updateSkillNoteArtifactRecord(tx, {
			artifactId: target.id,
			name: target.name,
			body: nextBody,
			metadata: nextMetadata,
			now,
		});
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

	await pruneSkillNoteCheckpoints(target.id);
	await refreshSkillNoteArtifact(target.id);

	return {
		operationId: params.operation.operationId,
		action: params.operation.action,
		artifactId: target.id,
		idempotent: false,
	};
}

async function pruneSkillNoteCheckpoints(noteArtifactId: string) {
	const rows = await db
		.select({ id: skillNoteCheckpoints.id })
		.from(skillNoteCheckpoints)
		.where(eq(skillNoteCheckpoints.noteArtifactId, noteArtifactId))
		.orderBy(desc(skillNoteCheckpoints.createdAt));
	const excessIds = rows.slice(MAX_CHECKPOINTS_PER_NOTE).map((row) => row.id);
	if (excessIds.length === 0) return;
	await db
		.delete(skillNoteCheckpoints)
		.where(inArray(skillNoteCheckpoints.id, excessIds));
}

function failureFromError(
	operation: SkillNoteOperation,
	error: unknown,
): FailedSkillNoteOperation {
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

function validateEnvelopeOperationBodies(
	operations: SkillNoteOperation[],
): FailedSkillNoteOperation | null {
	for (const operation of operations) {
		try {
			const body = cleanText(operation.body, "body");
			assertBodyLimit(body, operation);
		} catch (error) {
			return failureFromError(operation, error);
		}
	}
	return null;
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

	if (params.operations.length > MAX_NOTE_OPERATIONS_PER_TURN) {
		return {
			applied,
			failures: [
				{
					operationId: params.operations[0]?.operationId ?? "unknown",
					action: params.operations[0]?.action ?? "create",
					code: "too_many_note_operations",
					message: "Too many skill note operations in one turn.",
				},
			],
		};
	}

	const bodyLimitFailure = validateEnvelopeOperationBodies(params.operations);
	if (bodyLimitFailure) {
		return {
			applied,
			failures: [bodyLimitFailure],
		};
	}

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
		(operation): operation is SkillNoteOperation =>
			operation.kind === "note_intent",
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
