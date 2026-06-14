import { getConfig } from "$lib/server/config-store";
import type {
	KnowledgeMemoryOverviewPayload,
	KnowledgeMemoryPayload,
	KnowledgeMemorySummary,
	PersonaMemoryItem,
} from "$lib/types";
import {
	forgetAllPersonaMemories,
	forgetPersonaMemory,
	getPeerContext,
	type HonchoPersonaMemoryRecord,
	isHonchoEnabled,
	listPersonaMemories,
	rotateHonchoPeerIdentity,
} from "./honcho";
import { buildKnowledgeMemoryOverview } from "./knowledge/memory-overview";
import {
	countFocusContinuityItems,
	countTaskMemoryItems,
	forgetFocusContinuity,
	forgetTaskMemory,
	listFocusContinuityItems,
	listTaskMemoryItems,
} from "./task-state";

type KnowledgeMemoryAction =
	| {
			action: "forget_persona_memory";
			clusterId?: string;
			conclusionId?: string;
	  }
	| { action: "forget_all_persona_memory" }
	| { action: "forget_task_memory"; taskId: string }
	| { action: "forget_focus_continuity"; continuityId: string }
	| { action: "forget_project_memory"; projectId: string };

function normalizePersonaMemoryId(
	payload: Extract<KnowledgeMemoryAction, { action: "forget_persona_memory" }>,
): string | null {
	for (const candidate of [payload.conclusionId, payload.clusterId]) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function buildKnowledgeMemorySummary(
	overview: string | null,
	personaFallbackTexts: string[],
	personaCount: number,
	activeConstraintCount: number,
	currentProjectContextCount: number,
	taskCount: number,
	focusContinuityCount: number,
	overviewUnavailable = false,
): KnowledgeMemorySummary {
	const honchoEnabled = isHonchoEnabled();
	const attemptedAt = honchoEnabled ? Date.now() : null;
	const overviewContract = buildKnowledgeMemoryOverview({
		rawOverview: overview,
		personaFallbackTexts,
		durablePersonaCount: personaCount,
		honchoEnabled,
		attemptedAt,
		overviewUnavailable,
	});
	console.info("[KNOWLEDGE_MEMORY] Selected overview source", {
		source: overviewContract.overviewSource,
		status: overviewContract.overviewStatus,
		durablePersonaCount: overviewContract.durablePersonaCount,
		overviewBulletCount: overviewContract.overviewBullets.length,
		unavailable: overviewUnavailable,
	});

	return {
		personaCount,
		taskCount,
		focusContinuityCount,
		activeConstraintCount,
		currentProjectContextCount,
		...overviewContract,
	};
}

async function loadPeerContextOverview(
	userId: string,
	userDisplayName: string,
	options: { force?: boolean } = {},
): Promise<{ text: string | null; unavailable: boolean }> {
	if (!isHonchoEnabled()) {
		return { text: null, unavailable: false };
	}

	try {
		const text = await getPeerContext(userId, userDisplayName, {
			timeoutMs: getConfig().honchoPersonaContextWaitMs,
			force: options.force,
			throwOnError: true,
		});
		return { text, unavailable: false };
	} catch (error) {
		console.warn(
			"[KNOWLEDGE_MEMORY] Honcho overview temporarily unavailable:",
			error,
		);
		return { text: null, unavailable: true };
	}
}

function mapHonchoPersonaMemory(
	record: HonchoPersonaMemoryRecord,
): PersonaMemoryItem {
	return {
		id: record.id,
		canonicalText: record.content,
		rawCanonicalText: record.content,
		domain: "persona",
		memoryClass: "long_term_context",
		state: "active",
		salienceScore: 50,
		sourceCount: 1,
		conversationTitles: [],
		firstSeenAt: record.createdAt,
		lastSeenAt: record.createdAt,
		pinned: false,
		temporal: null,
		activeConstraint: false,
		topicKey: null,
		topicStatus: "active",
		supersededById: null,
		supersessionReason: null,
		members: [
			{
				id: record.id,
				content: record.content,
				scope: record.scope,
				sessionId: record.sessionId,
				conversationTitle: null,
				createdAt: record.createdAt,
			},
		],
	};
}

export async function getKnowledgeMemory(
	userId: string,
	userDisplayName: string,
): Promise<KnowledgeMemoryPayload> {
	const [peerOverview, personaRecords, taskMemories, focusContinuities] =
		await Promise.all([
			loadPeerContextOverview(userId, userDisplayName),
			listPersonaMemories(userId),
			listTaskMemoryItems(userId),
			listFocusContinuityItems(userId),
		]);
	const personaMemories = personaRecords.map(mapHonchoPersonaMemory);

	return {
		personaMemories,
		activeConstraints: [],
		currentProjectContext: [],
		taskMemories: taskMemories.map((taskMemory) => ({
			...taskMemory,
			objective: taskMemory.objective,
			checkpointSummary: taskMemory.checkpointSummary,
		})),
		focusContinuities: focusContinuities.map((continuity) => ({
			...continuity,
			name: continuity.name,
			summary: continuity.summary,
			conversationTitles: continuity.conversationTitles,
		})),
		summary: buildKnowledgeMemorySummary(
			peerOverview.text,
			personaRecords.map((record) => record.content),
			personaMemories.length,
			0,
			0,
			taskMemories.length,
			focusContinuities.length,
			peerOverview.unavailable,
		),
	};
}

export async function getKnowledgeMemoryOverview(
	userId: string,
	userDisplayName: string,
	options: { awaitLive?: boolean; force?: boolean } = {},
): Promise<KnowledgeMemoryOverviewPayload> {
	const [peerOverview, personaRecords, taskCount, focusContinuityCount] =
		await Promise.all([
			loadPeerContextOverview(userId, userDisplayName, {
				force: options.force,
			}),
			listPersonaMemories(userId),
			countTaskMemoryItems(userId),
			countFocusContinuityItems(userId),
		]);

	return {
		summary: buildKnowledgeMemorySummary(
			peerOverview.text,
			personaRecords.map((record) => record.content),
			personaRecords.length,
			0,
			0,
			taskCount,
			focusContinuityCount,
			peerOverview.unavailable,
		),
	};
}

export async function applyKnowledgeMemoryAction(
	userId: string,
	userDisplayName: string,
	payload: KnowledgeMemoryAction,
): Promise<KnowledgeMemoryPayload> {
	switch (payload.action) {
		case "forget_persona_memory": {
			const personaMemoryId = normalizePersonaMemoryId(payload);
			if (!personaMemoryId) {
				throw new Error(
					"forget_persona_memory requires a conclusionId or clusterId",
				);
			}
			await forgetPersonaMemory(userId, personaMemoryId);
			console.info(
				"[KNOWLEDGE_MEMORY] forget_persona_memory delegated to Honcho",
			);
			break;
		}
		case "forget_all_persona_memory": {
			await forgetAllPersonaMemories(userId);
			await rotateHonchoPeerIdentity(userId);
			console.info(
				"[KNOWLEDGE_MEMORY] forget_all_persona_memory delegated to Honcho and rotated peer identity",
			);
			break;
		}
		case "forget_task_memory":
			await forgetTaskMemory(userId, payload.taskId);
			break;
		case "forget_focus_continuity":
			await forgetFocusContinuity(userId, payload.continuityId);
			break;
		case "forget_project_memory":
			await forgetFocusContinuity(userId, payload.projectId);
			break;
	}

	return getKnowledgeMemory(userId, userDisplayName);
}
