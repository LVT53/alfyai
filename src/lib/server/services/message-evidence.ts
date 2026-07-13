import { RERANK_CONFIDENCE_MIN } from "$lib/server/utils/constants";
import { clipText } from "$lib/server/utils/text";
import type {
	ArtifactSummary,
	ContextDebugState,
	ConversationContextStatus,
	EvidenceChannel,
	EvidenceSourceType,
	MessageEvidenceGroup,
	MessageEvidenceItem,
	MessageEvidenceSummary,
	TaskState,
	ToolCallEntry,
	ToolEvidenceCandidate,
} from "$lib/types";
import type { LegacyContextTraceSectionInput } from "./chat-turn/context-trace";
import { resolveArtifactFamilyKeys } from "./evidence-family";
import { getArtifactsForUser } from "./knowledge";
import { canUseTeiReranker, rerankItems } from "./tei-reranker";

const GROUP_LABELS: Record<EvidenceSourceType, string> = {
	web: "Web Search",
	document: "Retrieved Documents",
	memory: "Memory",
	tool: "Tool Outputs",
};

const GROUP_ORDER: Record<EvidenceSourceType, number> = {
	web: 0,
	document: 1,
	tool: 2,
	memory: 3,
};

const MAX_SELECTED_MEMORY_TOOL_CANDIDATES = 3;

function memoryContextMetadata(
	tool: ToolCallEntry,
): Record<string, string | number | boolean | null> | undefined {
	if (
		tool.name !== "memory_context" ||
		tool.status !== "done" ||
		(tool.sourceType !== "memory" && tool.sourceType != null)
	) {
		return undefined;
	}
	return tool.metadata;
}

function collectStringValues(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function toolSelectedMemoryIds(tool: ToolCallEntry): Set<string> {
	const selectedValues = [
		...collectStringValues(tool.input.selectedCandidateId),
		...collectStringValues(tool.input.selectedCandidateIds),
		...collectStringValues(tool.input.selectedConversationId),
		...collectStringValues(tool.input.historyConversationId),
		...collectStringValues(tool.input.siblingConversationId),
		...collectStringValues(tool.metadata?.selectedCandidateId),
	];
	return new Set(selectedValues);
}

function candidateMatchesSelectedMemoryId(
	candidate: ToolEvidenceCandidate,
	selectedIds: Set<string>,
): boolean {
	if (selectedIds.size === 0) return false;
	for (const selectedId of selectedIds) {
		if (
			candidate.id === selectedId ||
			candidate.id.endsWith(`:${selectedId}`)
		) {
			return true;
		}
	}
	return false;
}

function personaMemoryItemId(candidate: ToolEvidenceCandidate): string | null {
	const metadataItemId = candidate.metadata?.memoryItemId;
	if (typeof metadataItemId === "string" && metadataItemId.trim()) {
		return metadataItemId.trim();
	}
	if (candidate.id.startsWith("memory-fact:")) {
		return candidate.id.slice("memory-fact:".length) || null;
	}
	return null;
}

function isPersonaMemoryCandidate(candidate: ToolEvidenceCandidate): boolean {
	// Persona-mode facts and the persona summary are ambient, always-material
	// context: they are injected into every persona turn rather than explicitly
	// picked, so they must reach the evidence group without a selected flag.
	return (
		personaMemoryItemId(candidate) !== null ||
		candidate.id.startsWith("memory-context:summary:")
	);
}

function isSelectedMemoryCandidate(
	candidate: ToolEvidenceCandidate,
	tool: ToolCallEntry,
): boolean {
	const metadata = candidate.metadata;
	return (
		isPersonaMemoryCandidate(candidate) ||
		candidate.selected === true ||
		candidate.material === true ||
		candidate.status === "selected" ||
		metadata?.selected === true ||
		metadata?.material === true ||
		metadata?.status === "selected" ||
		candidateMatchesSelectedMemoryId(candidate, toolSelectedMemoryIds(tool))
	);
}

function sanitizeUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		return new URL(value).toString();
	} catch {
		return null;
	}
}

function uniqueByCanonicalId<T extends { canonicalId?: string; id: string }>(
	items: T[],
): T[] {
	return Array.from(
		new Map(items.map((item) => [item.canonicalId ?? item.id, item])).values(),
	);
}

function canonicalKeyForCandidate(
	sourceType: EvidenceSourceType,
	candidate: { id: string; title: string; url?: string | null },
): string {
	const sanitizedUrl = sanitizeUrl(candidate.url);
	if (sanitizedUrl) return `${sourceType}:url:${sanitizedUrl}`;
	return `${sourceType}:item:${candidate.id || candidate.title.toLowerCase()}`;
}

function mergeChannels(
	left: EvidenceChannel[] | undefined,
	right: EvidenceChannel[] | undefined,
): EvidenceChannel[] {
	return Array.from(new Set([...(left ?? []), ...(right ?? [])]));
}

function buildAmbientPersonaFactItems(
	contextTraceSections: LegacyContextTraceSectionInput[] | undefined,
): MessageEvidenceItem[] {
	const items: MessageEvidenceItem[] = [];
	const seen = new Set<string>();
	for (const section of contextTraceSections ?? []) {
		if (
			section.name !== "Baseline Memory Profile" ||
			section.source !== "memory" ||
			section.inclusionLevel === "omitted"
		) {
			continue;
		}
		const itemIds = section.itemIds ?? [];
		const itemTitles = section.itemTitles ?? [];
		for (let index = 0; index < itemIds.length; index += 1) {
			const itemId = itemIds[index]?.trim();
			if (!itemId || seen.has(itemId)) continue;
			seen.add(itemId);
			const title = itemTitles[index]?.trim() || "Remembered detail";
			items.push({
				id: `memory-fact:${itemId}`,
				canonicalId: `memory:fact:${itemId}`,
				title,
				sourceType: "memory",
				status: "reference",
				description: "Durable memory recalled for this turn.",
				channels: ["memory"],
				metadata: { memoryItemId: itemId },
			});
		}
	}
	return items;
}

function buildMemoryGroup(params: {
	contextStatus: ConversationContextStatus | null | undefined;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	toolCalls?: ToolCallEntry[];
}): MessageEvidenceGroup | null {
	const items: MessageEvidenceItem[] = [];
	const contextStatus = params.contextStatus;

	// Per-fact persona memory injected ambiently this turn (Baseline Memory
	// Profile). Each fact becomes a tappable evidence item carrying its
	// memoryItemId so the UI can offer correct/don't-use/retire affordances.
	const personaFactItems = buildAmbientPersonaFactItems(
		params.contextTraceSections,
	);
	const hasPersonaFacts = personaFactItems.length > 0;

	if (contextStatus?.taskStateApplied) {
		items.push({
			id: "task-state",
			title: "Task state",
			sourceType: "memory",
			status: "reference",
			description:
				"Structured objective, constraints, decisions, and next steps carried into this turn.",
		});
	}

	if ((contextStatus?.recentTurnCount ?? 0) > 0) {
		items.push({
			id: "recent-turns",
			title: `Recent turns (${contextStatus?.recentTurnCount ?? 0})`,
			sourceType: "memory",
			status: "reference",
			description: "Recent dialogue used for continuity.",
		});
	}

	// Prefer the per-fact persona items when the ambient persona layer supplied
	// them: one mental model, no duplicate "Session memory" chip. Fall back to
	// the aggregate item when persona mode returned no facts this turn.
	if (hasPersonaFacts) {
		items.push(...personaFactItems);
	} else if (contextStatus?.layersUsed.includes("session")) {
		items.push({
			id: "session-memory",
			title: "Session memory",
			sourceType: "memory",
			status: "reference",
			description: contextStatus.summary
				? clipText(contextStatus.summary, 180)
				: "Session summary and recalled context were included.",
		});
	}

	if (contextStatus?.layersUsed.includes("capsule")) {
		items.push({
			id: "workflow-memory",
			title: "Prior workflows",
			sourceType: "memory",
			status: "reference",
			description: "Relevant workflow capsules were included for continuity.",
		});
	}

	for (const section of params.contextTraceSections ?? []) {
		if (
			section.name !== "Project Folder Sibling Context" ||
			section.source !== "memory" ||
			section.inclusionLevel === "omitted"
		) {
			continue;
		}
		const itemId = section.itemIds?.[0];
		const itemTitle = section.itemTitles?.[0];
		if (!itemId || !itemTitle) continue;
		items.push({
			id: itemId,
			canonicalId: `memory:${itemId}`,
			title: itemTitle,
			sourceType: "memory",
			status: "reference",
			description: "Promoted from the same Project Folder for this query.",
			reason: section.signalReasons?.join(", ") || null,
			channels: ["memory"],
		});
	}

	const memoryToolCandidates = uniqueByCanonicalId(
		(params.toolCalls ?? []).flatMap((tool) =>
			tool.status === "done"
				? (tool.candidates ?? [])
						.filter((candidate) => candidate.sourceType === "memory")
						.filter((candidate) => isSelectedMemoryCandidate(candidate, tool))
						.map((candidate) => {
							const memoryItemId = personaMemoryItemId(candidate);
							const baseMetadata = memoryContextMetadata(tool);
							// Preserve the per-fact memoryItemId so the UI can offer
							// tap-to-correct/retire on the exact memory item.
							const metadata = memoryItemId
								? { ...(baseMetadata ?? {}), memoryItemId }
								: baseMetadata;
							return {
								id: candidate.id,
								canonicalId: canonicalKeyForCandidate("memory", candidate),
								title: candidate.title,
								sourceType: "memory" as const,
								status: "reference" as const,
								description: candidate.snippet
									? clipText(candidate.snippet, 180)
									: null,
								url: sanitizeUrl(candidate.url),
								channels: ["memory"] as EvidenceChannel[],
								metadata,
							};
						})
				: [],
		),
	).slice(0, MAX_SELECTED_MEMORY_TOOL_CANDIDATES);
	items.push(...memoryToolCandidates);

	if (items.length === 0) return null;

	return {
		sourceType: "memory",
		label: GROUP_LABELS.memory,
		reranked: false,
		items,
	};
}

async function buildArtifactGroups(params: {
	userId?: string;
	contextDebug: ContextDebugState | null | undefined;
	currentAttachments: ArtifactSummary[] | undefined;
}): Promise<MessageEvidenceGroup[]> {
	const selectedEvidence = params.contextDebug?.selectedEvidence ?? [];
	const currentAttachments = params.currentAttachments ?? [];
	if (selectedEvidence.length === 0 && currentAttachments.length === 0)
		return [];

	const artifactIds = Array.from(
		new Set([
			...selectedEvidence.map((evidence) => evidence.artifactId),
			...currentAttachments.map((artifact) => artifact.id),
		]),
	);
	const artifactRows =
		params.userId && artifactIds.length > 0
			? await getArtifactsForUser(params.userId, artifactIds).catch(() => [])
			: [];
	const artifactMap = new Map(
		artifactRows.map((artifact) => [artifact.id, artifact]),
	);
	const familyKeys =
		params.userId && artifactRows.length > 0
			? await resolveArtifactFamilyKeys(params.userId, artifactRows).catch(
					() => new Map<string, string>(),
				)
			: new Map<string, string>();

	const grouped = new Map<
		EvidenceSourceType,
		Map<string, MessageEvidenceItem>
	>();

	const upsertItem = (item: MessageEvidenceItem) => {
		const byCanonical =
			grouped.get(item.sourceType) ?? new Map<string, MessageEvidenceItem>();
		const canonicalId = item.canonicalId ?? item.id;
		const existing = byCanonical.get(canonicalId);
		if (!existing) {
			byCanonical.set(canonicalId, item);
			grouped.set(item.sourceType, byCanonical);
			return;
		}

		byCanonical.set(canonicalId, {
			...existing,
			id: existing.id,
			title:
				existing.title.length >= item.title.length
					? existing.title
					: item.title,
			status:
				existing.status === "selected" || item.status === "selected"
					? "selected"
					: existing.status === "reference" || item.status === "reference"
						? "reference"
						: "rejected",
			description: existing.description ?? item.description ?? null,
			artifactId: existing.artifactId ?? item.artifactId ?? null,
			confidence:
				Math.max(existing.confidence ?? 0, item.confidence ?? 0) || undefined,
			reason: existing.reason ?? item.reason ?? null,
			currentTurnAttachment: Boolean(
				existing.currentTurnAttachment && item.currentTurnAttachment,
			),
			channels: mergeChannels(existing.channels, item.channels),
		});
	};

	for (const attachment of currentAttachments) {
		const artifact = artifactMap.get(attachment.id);
		const canonicalId =
			familyKeys.get(attachment.id) ?? `document:${attachment.id}`;
		const channels: EvidenceChannel[] = ["attached"];
		upsertItem({
			id: attachment.id,
			canonicalId,
			title: attachment.name,
			sourceType: "document",
			status: "selected",
			artifactId: attachment.id,
			description: attachment.summary
				? `Included automatically for this turn. ${clipText(attachment.summary, 180)}`
				: "Included automatically for this turn.",
			currentTurnAttachment: true,
			channels,
		});
		if (artifact && !familyKeys.has(artifact.id)) {
			familyKeys.set(artifact.id, canonicalId);
		}
	}

	for (const evidence of selectedEvidence) {
		const artifact = artifactMap.get(evidence.artifactId);
		const canonicalId =
			artifact && params.userId
				? (familyKeys.get(evidence.artifactId) ??
					`${evidence.sourceType}:${evidence.artifactId}`)
				: `${evidence.sourceType}:${evidence.artifactId}`;
		const baseChannels: EvidenceChannel[] =
			evidence.sourceType === "document"
				? ["retrieved"]
				: evidence.sourceType === "tool"
					? ["tool"]
					: evidence.sourceType === "web"
						? ["web"]
						: ["memory"];
		upsertItem({
			id: evidence.artifactId,
			canonicalId,
			title: evidence.name,
			sourceType: evidence.sourceType,
			status: "selected",
			artifactId: evidence.artifactId,
			confidence: evidence.confidence,
			reason: evidence.reason,
			description: evidence.reason,
			currentTurnAttachment: false,
			channels: baseChannels,
		});
	}

	return Array.from(grouped.entries())
		.map(([sourceType, items]) => ({
			sourceType,
			label: GROUP_LABELS[sourceType],
			reranked: params.contextDebug?.routingStage === "evidence_rerank",
			confidence: params.contextDebug?.routingConfidence,
			items: Array.from(items.values())
				.map((item) => ({
					...item,
					currentTurnAttachment:
						item.currentTurnAttachment === true &&
						(item.channels?.length ?? 0) === 1,
				}))
				.sort(
					(a, b) =>
						(b.confidence ?? 0) - (a.confidence ?? 0) ||
						a.title.localeCompare(b.title),
				),
		}))
		.filter((group) => group.items.length > 0);
}

function getToolCallSourceType(tool: ToolCallEntry): EvidenceSourceType {
	if (tool.sourceType) return tool.sourceType;
	const toolName = tool.name.toLowerCase();
	if (toolName.includes("search") || toolName.includes("fetch_url")) {
		return "web";
	}
	return "tool";
}

async function buildRerankedToolGroup(params: {
	sourceType: EvidenceSourceType;
	message: string;
	taskState: TaskState | null;
	toolCalls: ToolCallEntry[];
}): Promise<MessageEvidenceGroup | null> {
	const candidateItems = uniqueByCanonicalId(
		params.toolCalls.flatMap((tool) =>
			(tool.candidates ?? [])
				.filter((candidate) => candidate.sourceType === params.sourceType)
				.map((candidate) => ({
					id: candidate.id,
					canonicalId: canonicalKeyForCandidate(params.sourceType, candidate),
					title: candidate.title,
					sourceType: params.sourceType,
					status: "reference" as const,
					description: candidate.snippet ?? null,
					url: sanitizeUrl(candidate.url),
					channels: [
						params.sourceType === "web" ? "web" : "tool",
					] as EvidenceChannel[],
				})),
		),
	);

	const referenceItems =
		candidateItems.length === 0
			? params.toolCalls
					.filter((tool) => getToolCallSourceType(tool) === params.sourceType)
					.map((tool, index) => ({
						id: `${tool.name}-${index}`,
						canonicalId: `${params.sourceType}:tool:${tool.name}-${index}`,
						title: tool.name,
						sourceType: params.sourceType,
						status: "reference" as const,
						description: tool.outputSummary
							? clipText(tool.outputSummary, 180)
							: null,
						channels: [
							params.sourceType === "web" ? "web" : "tool",
						] as EvidenceChannel[],
					}))
			: [];

	if (candidateItems.length === 0 && referenceItems.length === 0) {
		return null;
	}

	if (candidateItems.length <= 1) {
		return {
			sourceType: params.sourceType,
			label: GROUP_LABELS[params.sourceType],
			reranked: false,
			items:
				candidateItems.length > 0
					? candidateItems.map((item) => ({ ...item, status: "selected" }))
					: referenceItems,
		};
	}

	// Adaptive selection: web search often returns 10–20 results; keeping only 3
	// discards too much signal before the reranker even runs.
	const defaultKeepCount = Math.min(
		candidateItems.length,
		Math.max(3, Math.ceil(candidateItems.length / 2)),
	);
	let selectedIds = new Set(
		candidateItems.slice(0, defaultKeepCount).map((item) => item.id),
	);
	let confidence = 0;
	let reranked = false;

	if (canUseTeiReranker()) {
		try {
			// Build a clean rerank query without meta-text prefixes that can
			// confuse semantic similarity (e.g. "User message:" is not part of
			// the user intent).
			const rerankQueryParts: string[] = [];
			if (params.taskState?.objective?.trim()) {
				rerankQueryParts.push(params.taskState.objective.trim());
			}
			if (params.message?.trim()) {
				rerankQueryParts.push(params.message.trim());
			}
			const rerankQuery = rerankQueryParts.join("\n\n");

			const rerankedResponse = await rerankItems({
				query: rerankQuery,
				items: candidateItems,
				getText: (candidate) =>
					[
						candidate.title,
						candidate.description ?? null,
						candidate.url ?? null,
					]
						.filter((value): value is string => Boolean(value))
						.join("\n"),
				maxTexts: Math.min(16, candidateItems.length),
			});

			if (rerankedResponse && rerankedResponse.items.length > 0) {
				// Web-search results are inherently diverse; demanding 64 %
				// absolute confidence often discards good relative rankings.
				// Use a lower floor for web evidence so the reranker’s ordering
				// is trusted when it produces any meaningful spread.
				const confidenceFloor =
					params.sourceType === "web" ? 40 : RERANK_CONFIDENCE_MIN;
				if (rerankedResponse.confidence >= confidenceFloor) {
					const rerankKeepCount = Math.min(
						rerankedResponse.items.length,
						Math.max(3, Math.ceil(rerankedResponse.items.length / 2)),
					);
					const nextSelectedIds = new Set(
						rerankedResponse.items
							.slice(0, rerankKeepCount)
							.map(({ item }) => item.id),
					);
					if (nextSelectedIds.size > 0) {
						selectedIds = nextSelectedIds;
						confidence = Math.round(rerankedResponse.confidence);
						reranked = true;
					}
				}
			}
		} catch (error) {
			console.error("[MESSAGE_EVIDENCE] Tool reranker failed:", error);
		}
	}

	const items = candidateItems
		.map((candidate) => ({
			...candidate,
			status: selectedIds.has(candidate.id)
				? ("selected" as const)
				: ("rejected" as const),
			confidence: selectedIds.has(candidate.id)
				? confidence || undefined
				: undefined,
		}))
		.sort((a, b) => {
			if (a.status !== b.status) return a.status === "selected" ? -1 : 1;
			if ((b.confidence ?? 0) !== (a.confidence ?? 0))
				return (b.confidence ?? 0) - (a.confidence ?? 0);
			return a.title.localeCompare(b.title);
		});

	return {
		sourceType: params.sourceType,
		label: GROUP_LABELS[params.sourceType],
		reranked,
		confidence: reranked ? confidence : undefined,
		items,
	};
}

export async function buildAssistantEvidenceSummary(params: {
	userId?: string;
	message: string;
	taskState: TaskState | null;
	contextStatus?: ConversationContextStatus | null;
	contextDebug?: ContextDebugState | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	toolCalls?: ToolCallEntry[];
	currentAttachments?: ArtifactSummary[];
}): Promise<MessageEvidenceSummary | null> {
	const toolCalls = params.toolCalls ?? [];
	const completedToolCalls = toolCalls.filter((tool) => tool.status === "done");
	const groups = [
		...(await buildArtifactGroups({
			userId: params.userId,
			contextDebug: params.contextDebug,
			currentAttachments: params.currentAttachments,
		})),
		buildMemoryGroup({
			contextStatus: params.contextStatus,
			contextTraceSections: params.contextTraceSections,
			toolCalls: completedToolCalls,
		}),
		await buildRerankedToolGroup({
			sourceType: "web",
			message: params.message,
			taskState: params.taskState,
			toolCalls: completedToolCalls,
		}),
		await buildRerankedToolGroup({
			sourceType: "tool",
			message: params.message,
			taskState: params.taskState,
			toolCalls: completedToolCalls,
		}),
	].filter(
		(group): group is MessageEvidenceGroup =>
			group !== null && group.items.length > 0,
	);

	if (groups.length === 0) return null;

	groups.sort(
		(a, b) =>
			GROUP_ORDER[a.sourceType] - GROUP_ORDER[b.sourceType] ||
			a.label.localeCompare(b.label),
	);

	return {
		structuredWebSearch: groups.some((group) => group.sourceType === "web"),
		groups,
	};
}
