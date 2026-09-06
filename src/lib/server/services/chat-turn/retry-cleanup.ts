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

import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	artifactLinks,
	artifacts,
	conversationTaskStates,
	conversationWorkingSetItems,
	taskCheckpoints,
	taskStateEvidenceLinks,
} from "$lib/server/db/schema";
import { deleteMessages } from "$lib/server/services/messages";

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
		await deleteMessages([assistantMessageId]);
		log("delete assistant message", true, `id=${assistantMessageId}`);
	} catch (error) {
		log("delete assistant message", false, String(error));
		warnings.push(`assistant-message: ${String(error)}`);
	}

	return { steps, warnings };
}
