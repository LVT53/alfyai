/**
 * Atomic retry cleanup — removes all side-effects created by a failed
 * assistant turn so the user message can be re-executed cleanly.
 *
 * Cleanup order (reverse of `persistAssistantTurnState` in finalize.ts):
 *   1. Delete task-state evidence links for the conversation's task state.
 *   2. Delete task checkpoints for the conversation's task state.
 *   3. Delete generated_output artifacts + their links + working-set refs.
 *   4. Delete the work capsule artifact for the conversation.
 *   5. Delete the assistant message. Immutable usage_events rows intentionally remain.
 *
 * Limitations:
 *   - User messages are never touched.
 *   - All deletions are idempotent.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactChunks,
	artifactLinks,
	artifacts,
	conversationTaskStates,
	conversationWorkingSetItems,
	skillNoteCheckpoints,
	skillNoteOperations,
	skillSessionMilestones,
	skillSessions,
	taskCheckpoints,
	taskStateEvidenceLinks,
} from "$lib/server/db/schema";
import { deleteMessages } from "$lib/server/services/messages";
import { deleteSemanticEmbeddingsForSubjects } from "../semantic-embeddings";

export type CleanupResult = {
	steps: CleanupStep[];
	warnings: string[];
};

export type CleanupStep = {
	label: string;
	ok: boolean;
	detail?: string;
};

export async function cleanupFailedTurn(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
}): Promise<CleanupResult> {
	const { userId, conversationId, assistantMessageId } = params;
	const steps: CleanupStep[] = [];
	const warnings: string[] = [];

	const log = (label: string, ok: boolean, detail?: string) => {
		steps.push({ label, ok, detail });
	};

	const taskStateRow = await db
		.select({ taskId: conversationTaskStates.taskId })
		.from(conversationTaskStates)
		.where(
			and(
				eq(conversationTaskStates.userId, userId),
				eq(conversationTaskStates.conversationId, conversationId),
			),
		)
		.limit(1)
		.catch(() => []);

	try {
		if (taskStateRow[0]) {
			await db
				.delete(taskStateEvidenceLinks)
				.where(
					and(
						eq(taskStateEvidenceLinks.userId, userId),
						eq(taskStateEvidenceLinks.conversationId, conversationId),
						eq(taskStateEvidenceLinks.taskId, taskStateRow[0].taskId),
					),
				)
				.run();
			log("delete evidence links", true, `taskId=${taskStateRow[0].taskId}`);
		} else {
			log("delete evidence links", true, "no task state — skipped");
		}
	} catch (error) {
		log("delete evidence links", false, String(error));
		warnings.push(`evidence-links: ${String(error)}`);
	}

	try {
		if (taskStateRow[0]) {
			await db
				.delete(taskCheckpoints)
				.where(
					and(
						eq(taskCheckpoints.userId, userId),
						eq(taskCheckpoints.conversationId, conversationId),
						eq(taskCheckpoints.taskId, taskStateRow[0].taskId),
					),
				)
				.run();
			log("delete checkpoints", true, `taskId=${taskStateRow[0].taskId}`);
		} else {
			log("delete checkpoints", true, "no task state — skipped");
		}
	} catch (error) {
		log("delete checkpoints", false, String(error));
		warnings.push(`checkpoints: ${String(error)}`);
	}

	try {
		const generatedArtifacts = await db
			.select({ id: artifacts.id })
			.from(artifacts)
			.where(
				and(
					eq(artifacts.userId, userId),
					eq(artifacts.conversationId, conversationId),
					eq(artifacts.type, "generated_output"),
				),
			);

		const idsToDelete = generatedArtifacts.map((a) => a.id);
		if (idsToDelete.length > 0) {
			await db
				.delete(artifactLinks)
				.where(
					and(
						eq(artifactLinks.userId, userId),
						eq(artifactLinks.conversationId, conversationId),
						inArray(artifactLinks.artifactId, idsToDelete),
					),
				)
				.run();

			for (const id of idsToDelete) {
				await db
					.delete(conversationWorkingSetItems)
					.where(eq(conversationWorkingSetItems.artifactId, id))
					.run();
			}

			await db
				.delete(artifacts)
				.where(
					and(
						eq(artifacts.userId, userId),
						eq(artifacts.conversationId, conversationId),
						eq(artifacts.type, "generated_output"),
					),
				)
				.run();
			log(
				"delete generated_output artifacts",
				true,
				`count=${idsToDelete.length}`,
			);
		} else {
			log("delete generated_output artifacts", true, "none found — skipped");
		}
	} catch (error) {
		log("delete generated_output artifacts", false, String(error));
		warnings.push(`generated-output: ${String(error)}`);
	}

	try {
		await db
			.delete(artifacts)
			.where(
				and(
					eq(artifacts.userId, userId),
					eq(artifacts.conversationId, conversationId),
					eq(artifacts.type, "work_capsule"),
				),
			)
			.run();
		log("delete work capsule", true);
	} catch (error) {
		log("delete work capsule", false, String(error));
		warnings.push(`work-capsule: ${String(error)}`);
	}

	try {
		await cleanupSkillSideEffects({
			userId,
			conversationId,
			assistantMessageId,
		});
		log("cleanup skill side effects", true);
	} catch (error) {
		log("cleanup skill side effects", false, String(error));
		warnings.push(`skill-side-effects: ${String(error)}`);
	}

	try {
		await deleteMessages([assistantMessageId]);
		log("delete assistant message", true, `id=${assistantMessageId}`);
	} catch (error) {
		log("delete assistant message", false, String(error));
		warnings.push(`assistant-message: ${String(error)}`);
	}

	return { steps, warnings };
}

async function cleanupSkillSideEffects(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
}) {
	const noteOperations = await db
		.select()
		.from(skillNoteOperations)
		.where(
			and(
				eq(skillNoteOperations.userId, params.userId),
				eq(skillNoteOperations.conversationId, params.conversationId),
				eq(skillNoteOperations.assistantMessageId, params.assistantMessageId),
			),
		);
	const checkpoints = await db
		.select()
		.from(skillNoteCheckpoints)
		.where(
			and(
				eq(skillNoteCheckpoints.userId, params.userId),
				eq(skillNoteCheckpoints.conversationId, params.conversationId),
				eq(skillNoteCheckpoints.assistantMessageId, params.assistantMessageId),
			),
		)
		.orderBy(desc(skillNoteCheckpoints.createdAt));
	const createdNoteArtifactIds = noteOperations
		.filter((operation) => operation.action === "create")
		.map((operation) => operation.artifactId);
	const rolledBackNoteArtifactIds = Array.from(
		new Set(checkpoints.map((checkpoint) => checkpoint.noteArtifactId)),
	);

	for (const checkpoint of checkpoints) {
		await db
			.update(artifacts)
			.set({
				contentText: checkpoint.previousBody,
				sizeBytes: Buffer.byteLength(checkpoint.previousBody, "utf8"),
				metadataJson: checkpoint.previousMetadataJson,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(artifacts.id, checkpoint.noteArtifactId),
					eq(artifacts.userId, params.userId),
					eq(artifacts.conversationId, params.conversationId),
					eq(artifacts.type, "skill_note"),
				),
			)
			.run();
	}
	if (rolledBackNoteArtifactIds.length > 0) {
		await db
			.delete(artifactChunks)
			.where(
				and(
					eq(artifactChunks.userId, params.userId),
					eq(artifactChunks.conversationId, params.conversationId),
					inArray(artifactChunks.artifactId, rolledBackNoteArtifactIds),
				),
			)
			.run();
		await deleteSemanticEmbeddingsForSubjects({
			userId: params.userId,
			subjectType: "artifact",
			subjectIds: rolledBackNoteArtifactIds,
		});
	}

	if (createdNoteArtifactIds.length > 0) {
		await db
			.delete(artifactLinks)
			.where(
				and(
					eq(artifactLinks.userId, params.userId),
					inArray(artifactLinks.artifactId, createdNoteArtifactIds),
				),
			)
			.run();
		await db
			.delete(conversationWorkingSetItems)
			.where(
				and(
					eq(conversationWorkingSetItems.userId, params.userId),
					eq(conversationWorkingSetItems.conversationId, params.conversationId),
					inArray(
						conversationWorkingSetItems.artifactId,
						createdNoteArtifactIds,
					),
				),
			)
			.run();
		await db
			.delete(artifactChunks)
			.where(
				and(
					eq(artifactChunks.userId, params.userId),
					eq(artifactChunks.conversationId, params.conversationId),
					inArray(artifactChunks.artifactId, createdNoteArtifactIds),
				),
			)
			.run();
		await deleteSemanticEmbeddingsForSubjects({
			userId: params.userId,
			subjectType: "artifact",
			subjectIds: createdNoteArtifactIds,
		});
		await db
			.delete(artifacts)
			.where(
				and(
					eq(artifacts.userId, params.userId),
					eq(artifacts.conversationId, params.conversationId),
					eq(artifacts.type, "skill_note"),
					inArray(artifacts.id, createdNoteArtifactIds),
				),
			)
			.run();
	}

	await db
		.delete(skillNoteCheckpoints)
		.where(
			and(
				eq(skillNoteCheckpoints.userId, params.userId),
				eq(skillNoteCheckpoints.conversationId, params.conversationId),
				eq(skillNoteCheckpoints.assistantMessageId, params.assistantMessageId),
			),
		)
		.run();
	await db
		.delete(skillNoteOperations)
		.where(
			and(
				eq(skillNoteOperations.userId, params.userId),
				eq(skillNoteOperations.conversationId, params.conversationId),
				eq(skillNoteOperations.assistantMessageId, params.assistantMessageId),
			),
		)
		.run();

	const milestones = await db
		.select()
		.from(skillSessionMilestones)
		.where(
			and(
				eq(skillSessionMilestones.userId, params.userId),
				eq(skillSessionMilestones.conversationId, params.conversationId),
			),
		);
	const milestonesToDelete = milestones.filter((milestone) =>
		milestoneReferencesAssistantMessage(
			milestone.messageParamsJson,
			params.assistantMessageId,
		),
	);
	const milestoneIdsToDelete = milestonesToDelete.map(
		(milestone) => milestone.id,
	);
	if (milestoneIdsToDelete.length > 0) {
		const terminalSessionIds = Array.from(
			new Set(
				milestonesToDelete
					.filter(
						(milestone) =>
							milestone.kind === "ended" || milestone.kind === "dismissed",
					)
					.map((milestone) => milestone.sessionId),
			),
		);
		await db
			.delete(skillSessionMilestones)
			.where(inArray(skillSessionMilestones.id, milestoneIdsToDelete))
			.run();
		if (terminalSessionIds.length > 0) {
			await db
				.update(skillSessions)
				.set({
					status: "active",
					endReason: null,
					endedAt: null,
					updatedAt: new Date(),
				})
				.where(inArray(skillSessions.id, terminalSessionIds))
				.run();
		}
	}
}

function milestoneReferencesAssistantMessage(
	messageParamsJson: string,
	assistantMessageId: string,
): boolean {
	try {
		const parsed = JSON.parse(messageParamsJson) as unknown;
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			"assistantMessageId" in parsed &&
			(parsed as { assistantMessageId?: unknown }).assistantMessageId ===
				assistantMessageId
		);
	} catch {
		return messageParamsJson.includes(assistantMessageId);
	}
}
