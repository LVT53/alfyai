import type {
	Artifact,
	ConversationContextStatus,
	MemoryLayer,
	WorkCapsule,
} from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";

export type PromptContextSection = {
	title: string;
	body: string;
	layer?: MemoryLayer;
	protected?: boolean;
	llmCompactible?: boolean;
};

export type PromptContextSectionSelection = {
	title: string;
	body: string;
	layer?: MemoryLayer;
	protected: boolean;
	trimmed: boolean;
	inclusionLevel: "full" | "trimmed" | "omitted";
	estimatedTokens: number;
};

type HistoricalSectionReranker = (params: {
	query: string;
	candidates: PromptContextSection[];
}) => Promise<{
	selectedTitles: string[];
	confidence: number;
} | null>;

export function truncateToTokenBudget(text: string, maxTokens: number): string {
	if (estimateTokenCount(text) <= maxTokens) return text;
	if (maxTokens <= 0) return "";

	const suffix = "\n...[truncated]";
	const suffixTokens = estimateTokenCount(suffix);
	const contentBudget = Math.max(0, maxTokens - suffixTokens);
	if (contentBudget <= 0) return "[truncated]";

	let low = 0;
	let high = text.length;
	let best = "";

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = text.slice(0, mid).trim();
		const candidateTokens = estimateTokenCount(candidate);
		if (candidateTokens <= contentBudget) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return best ? `${best}${suffix}` : "[truncated]";
}

export function buildContextSection(title: string, body: string): string {
	const trimmed = body.trim();
	return trimmed ? `## ${title}\n${trimmed}` : "";
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
	return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

export function serializeRoleMessages<T>(
	messages: T[],
	resolveRole: (message: T) => "user" | "assistant",
	resolveContent: (message: T) => string,
	limit = messages.length,
): string {
	return messages
		.slice(-limit)
		.map(
			(message) =>
				`${resolveRole(message).toUpperCase()}: ${resolveContent(message).trim()}`,
		)
		.join("\n\n");
}

export type BudgetedRoleTurnContext = {
	body: string;
	includedTurnCount: number;
	omittedTurnCount: number;
	trimmed: boolean;
	estimatedTokens: number;
};

export function serializeBudgetedRoleTurns<T>(params: {
	turns: Array<{ messages: T[] }>;
	resolveRole: (message: T) => "user" | "assistant";
	resolveContent: (message: T) => string;
	maxTokens: number;
}): BudgetedRoleTurnContext {
	if (params.turns.length === 0) {
		return {
			body: "",
			includedTurnCount: 0,
			omittedTurnCount: params.turns.length,
			trimmed: false,
			estimatedTokens: 0,
		};
	}

	const serializedTurns = params.turns.map((turn) =>
		serializeRoleMessages(
			turn.messages,
			params.resolveRole,
			params.resolveContent,
			turn.messages.length,
		),
	);
	const body = serializedTurns.join("\n\n");
	return {
		body,
		includedTurnCount: params.turns.length,
		omittedTurnCount: 0,
		trimmed: false,
		estimatedTokens: estimateTokenCount(body),
	};
}

export function selectRecentRoleTurns<T>(
	messages: T[],
	resolveRole: (message: T) => "user" | "assistant",
	limit: number,
): Array<{ messages: T[] }> {
	const turns: Array<{ messages: T[] }> = [];
	let currentTurn: T[] = [];

	for (const message of messages) {
		const role = resolveRole(message);
		if (role === "user") {
			if (currentTurn.length > 0) {
				turns.push({ messages: currentTurn });
			}
			currentTurn = [message];
			continue;
		}

		if (currentTurn.length === 0) {
			currentTurn = [message];
		} else {
			currentTurn.push(message);
		}
	}

	if (currentTurn.length > 0) {
		turns.push({ messages: currentTurn });
	}

	return turns.slice(-limit);
}

export function selectPromptSessionTurns<T>(params: {
	turns: T[];
	message: string;
	resolveContent: (turn: T) => string;
	scoreTurn: (message: string, turnContent: string) => number;
	recentTurnCount?: number;
	matchThreshold?: number;
}): T[] {
	void params.message;
	void params.resolveContent;
	void params.scoreTurn;
	void params.recentTurnCount;
	void params.matchThreshold;
	return params.turns;
}

export function serializePeerContext(peerContext: {
	representation: string | null;
	peerCard: string[] | null;
}): string {
	const parts: string[] = [];
	if (peerContext.representation?.trim()) {
		parts.push(peerContext.representation.trim());
	}
	if (peerContext.peerCard?.length) {
		parts.push(`Peer card:\n- ${peerContext.peerCard.join("\n- ")}`);
	}
	return parts.join("\n\n");
}

export function serializeWorkCapsules(capsules: WorkCapsule[]): string {
	return capsules
		.map((capsule) => {
			const lines = [
				`Workflow: ${capsule.artifact.name}`,
				capsule.taskSummary ? `Task: ${capsule.taskSummary}` : null,
				capsule.workflowSummary ? `Summary: ${capsule.workflowSummary}` : null,
				capsule.keyConclusions.length > 0
					? `Key conclusions: ${capsule.keyConclusions.join(" ")}`
					: null,
				capsule.reusablePatterns.length > 0
					? `Reusable patterns: ${capsule.reusablePatterns.join(" ")}`
					: null,
			].filter((line): line is string => Boolean(line));
			return lines.join("\n");
		})
		.join("\n\n");
}

export function serializeArtifacts(params: {
	artifacts: Artifact[];
	label: string;
	snippets?: Map<string, string>;
	excerptTokenBudget?: number;
}): string {
	const snippets = params.snippets ?? new Map<string, string>();
	const excerptTokenBudget = params.excerptTokenBudget ?? 1200;

	return params.artifacts
		.map((artifact) => {
			const excerptSource =
				snippets.get(artifact.id) ??
				artifact.contentText ??
				artifact.summary ??
				artifact.name;
			return `${params.label}: ${artifact.name}\n${truncateToTokenBudget(
				excerptSource,
				excerptTokenBudget,
			)}`;
		})
		.join("\n\n");
}

export type BudgetedAttachmentContextMode = "excerpt" | "task";

export type BudgetedAttachmentContextItem = {
	id: string;
	title: string;
	inclusionLevel: BudgetedAttachmentContextMode | "omitted";
	estimatedTokens: number;
	trimmed: boolean;
};

export type BudgetedAttachmentContext = {
	body: string;
	mode: BudgetedAttachmentContextMode;
	estimatedTokens: number;
	items: BudgetedAttachmentContextItem[];
};

const ATTACHMENT_TASK_ACTION_RE =
	/\b(summarize|summarise|summary|review|analyze|analyse|rewrite|revise|edit|extract|compare|translate|convert|format)\b|(?:összefoglal[\p{L}]*|foglal[\p{L}]*\s+össze|összegez[\p{L}]*|elemez[\p{L}]*|ellenőriz[\p{L}]*|ellenoriz[\p{L}]*|nézd\s+át|nezd\s+at|javíts[\p{L}]*|javits[\p{L}]*|írd\s+át|ird\s+at|szerkeszd|fordíts[\p{L}]*|fordits[\p{L}]*|hasonlíts[\p{L}]*|hasonlits[\p{L}]*|alakíts[\p{L}]*\s+át|alakits[\p{L}]*\s+at|exportál[\p{L}]*|exportal[\p{L}]*|készíts[\p{L}]*|keszits[\p{L}]*|mit\s+mond|mi\s+szerepel|mi\s+van\s+benne)/iu;
const ATTACHMENT_TASK_REFERENCE_RE =
	/\b(attachment|attached|file|document|doc|pdf|this|these|it|them)\b|(?:dokumentum[\p{L}]*|doksi[\p{L}]*|fájl[\p{L}]*|fajl[\p{L}]*|csatolmány[\p{L}]*|csatolmany[\p{L}]*|melléklet[\p{L}]*|melleklet[\p{L}]*|forrás[\p{L}]*|forras[\p{L}]*|ez|ezt|ebből|ebbol|abban|benne)/iu;

export function selectAttachmentContextMode(params: {
	message: string;
	attachmentCount: number;
}): BudgetedAttachmentContextMode {
	if (params.attachmentCount === 0) return "excerpt";
	return ATTACHMENT_TASK_ACTION_RE.test(params.message) &&
		ATTACHMENT_TASK_REFERENCE_RE.test(params.message)
		? "task"
		: "excerpt";
}

export function serializeBudgetedAttachments(params: {
	artifacts: Artifact[];
	snippets?: Map<string, string>;
	message: string;
	totalBudget: number;
	taskPerAttachmentBudget?: number;
	excerptPerAttachmentBudget?: number;
}): BudgetedAttachmentContext {
	const snippets = params.snippets ?? new Map<string, string>();
	const mode = selectAttachmentContextMode({
		message: params.message,
		attachmentCount: params.artifacts.length,
	});
	const perAttachmentBudget = Math.max(
		80,
		Math.floor(params.totalBudget / Math.max(1, params.artifacts.length)),
	);
	const modeBudget =
		mode === "task"
			? (params.taskPerAttachmentBudget ?? 2400)
			: (params.excerptPerAttachmentBudget ?? 600);
	let remainingBudget = params.totalBudget;
	const parts: string[] = [];
	const items: BudgetedAttachmentContextItem[] = [];

	for (const artifact of params.artifacts) {
		if (remainingBudget <= 0) {
			items.push({
				id: artifact.id,
				title: artifact.name,
				inclusionLevel: "omitted",
				estimatedTokens: 0,
				trimmed: false,
			});
			continue;
		}

		const itemBudget = Math.min(
			modeBudget,
			perAttachmentBudget,
			remainingBudget,
		);
		const header = [
			`Attachment: ${artifact.name}`,
			`Context mode: ${mode === "task" ? "Task Context" : "Excerpt Context"}`,
		].join("\n");
		const headerTokens = estimateTokenCount(header);
		const contentBudget = Math.max(0, itemBudget - headerTokens);
		const source =
			snippets.get(artifact.id) ??
			artifact.contentText ??
			artifact.summary ??
			artifact.name;
		const excerpt = truncateToTokenBudget(source, contentBudget);
		const itemText = `${header}\n${excerpt}`;
		const estimatedTokens = estimateTokenCount(itemText);

		if (estimatedTokens > remainingBudget) {
			items.push({
				id: artifact.id,
				title: artifact.name,
				inclusionLevel: "omitted",
				estimatedTokens: 0,
				trimmed: false,
			});
			continue;
		}

		parts.push(itemText);
		remainingBudget -= estimatedTokens;
		items.push({
			id: artifact.id,
			title: artifact.name,
			inclusionLevel: mode,
			estimatedTokens,
			trimmed: estimateTokenCount(source) > estimateTokenCount(excerpt),
		});
	}

	const body = parts.join("\n\n");
	return {
		body,
		mode,
		estimatedTokens: estimateTokenCount(body),
		items,
	};
}

export function extractSerializedAttachmentBody(serialized: string): string {
	return serialized
		.split("\n")
		.filter((line) => !line.startsWith("Attachment: "))
		.join("\n")
		.trim();
}

export function serializeWorkingSetArtifacts(params: {
	artifacts: Artifact[];
	snippets?: Map<string, string>;
	totalBudget: number;
	documentBudget: number;
	outputBudget: number;
}): string {
	const snippets = params.snippets ?? new Map<string, string>();
	const parts: string[] = [];
	const selected: Array<{
		partIndex: number;
		header: string;
		excerptSource: string;
		excerptBudget: number;
	}> = [];

	for (const artifact of params.artifacts) {
		const excerptSource =
			snippets.get(artifact.id) ??
			artifact.contentText ??
			artifact.summary ??
			artifact.name;
		const perArtifactBudget =
			artifact.type === "generated_output"
				? params.outputBudget
				: params.documentBudget;
		const kind = artifact.type === "generated_output" ? "Result" : "Document";
		const header = `${kind}: ${artifact.name}`;
		const candidateParts = [...parts, header];

		if (estimateTokenCount(candidateParts.join("\n\n")) > params.totalBudget) {
			continue;
		}

		parts.push(header);
		selected.push({
			partIndex: parts.length - 1,
			header,
			excerptSource,
			excerptBudget: perArtifactBudget,
		});
	}

	if (selected.length === 0) return "";

	const headerTokens = estimateTokenCount(parts.join("\n\n"));
	const contentBudget = Math.max(0, params.totalBudget - headerTokens);
	const fairShareBudget = Math.floor(contentBudget / selected.length);
	let remainderBudget = contentBudget % selected.length;

	for (const item of selected) {
		const itemBudget = Math.min(
			item.excerptBudget,
			fairShareBudget + (remainderBudget > 0 ? 1 : 0),
		);
		if (remainderBudget > 0) remainderBudget -= 1;
		if (itemBudget <= 0) continue;

		const excerpt = truncateToTokenBudget(item.excerptSource, itemBudget);
		if (!excerpt || estimateTokenCount(excerpt) > itemBudget) continue;

		parts[item.partIndex] = `${item.header}\n${excerpt}`;
	}

	return parts.join("\n\n");
}

export async function rerankHistoricalSections(params: {
	message: string;
	taskObjective?: string | null;
	sections: PromptContextSection[];
	enabled: boolean;
	rerankSections: HistoricalSectionReranker;
	logPrefix?: string;
}): Promise<PromptContextSection[]> {
	if (!params.enabled) return params.sections;

	const candidateSections = params.sections.filter(
		(section) =>
			!section.protected &&
			section.llmCompactible &&
			(section.layer === "session" || section.layer === "capsule") &&
			section.body.trim(),
	);

	if (candidateSections.length <= 2) {
		return params.sections;
	}

	try {
		const reranked = await params.rerankSections({
			query: [
				params.taskObjective ? `Current task: ${params.taskObjective}` : null,
				`User message: ${params.message}`,
			]
				.filter((value): value is string => Boolean(value))
				.join("\n\n"),
			candidates: candidateSections,
		});

		if (
			!(
				reranked &&
				typeof reranked.confidence === "number" &&
				reranked.confidence >= 64
			)
		) {
			return params.sections;
		}

		const selectedTitles = new Set(
			(Array.isArray(reranked.selectedTitles)
				? reranked.selectedTitles
				: []
			).filter((value): value is string => typeof value === "string"),
		);
		if (selectedTitles.size === 0) {
			return params.sections;
		}

		return params.sections.filter(
			(section) =>
				section.protected ||
				!candidateSections.includes(section) ||
				selectedTitles.has(section.title),
		);
	} catch (error) {
		console.error(
			`${params.logPrefix ?? "[CONTEXT]"} Historical section reranker failed:`,
			error,
		);
		return params.sections;
	}
}

export function compactContextSections(params: {
	intro: string;
	message: string;
	sections: PromptContextSection[];
	targetTokens: number;
	initialCompactionMode?: ConversationContextStatus["compactionMode"];
}): {
	inputValue: string;
	compactionApplied: boolean;
	compactionMode: ConversationContextStatus["compactionMode"];
	layersUsed: MemoryLayer[];
	estimatedTokens: number;
	sectionSelections: PromptContextSectionSelection[];
} {
	const bodyParts: string[] = [];
	const sectionSelections: PromptContextSectionSelection[] = [];
	const layersUsed = new Set<MemoryLayer>();
	let compactionApplied = false;
	let compactionMode = params.initialCompactionMode ?? "none";
	const userMessageSection = buildContextSection(
		"Current User Message",
		params.message,
	);

	function estimateWithSection(sectionText?: string): number {
		return estimateTokenCount(
			[params.intro, ...bodyParts, sectionText, userMessageSection]
				.filter((value): value is string => Boolean(value))
				.join("\n\n"),
		);
	}

	for (const section of params.sections) {
		const candidate = buildContextSection(section.title, section.body);
		if (!candidate) continue;
		const candidateTokens = estimateTokenCount(candidate);
		const nextTotal = estimateWithSection(candidate);
		if (nextTotal <= params.targetTokens || section.protected) {
			bodyParts.push(candidate);
			sectionSelections.push({
				title: section.title,
				body: section.body,
				layer: section.layer,
				protected: section.protected ?? false,
				trimmed: false,
				inclusionLevel: "full",
				estimatedTokens: candidateTokens,
			});
			if (section.layer) layersUsed.add(section.layer);
			continue;
		}

		sectionSelections.push({
			title: section.title,
			body: "",
			layer: section.layer,
			protected: false,
			trimmed: false,
			inclusionLevel: "omitted",
			estimatedTokens: 0,
		});
		compactionApplied = true;
		if (compactionMode === "none") compactionMode = "deterministic";
	}

	const inputValue = [params.intro, ...bodyParts, userMessageSection].join(
		"\n\n",
	);

	return {
		inputValue,
		compactionApplied,
		compactionMode,
		layersUsed: Array.from(layersUsed),
		estimatedTokens: estimateTokenCount(inputValue),
		sectionSelections,
	};
}
