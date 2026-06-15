import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactChunks } from "$lib/server/db/schema";
import { scoreMatch } from "$lib/server/services/working-set";
import { RERANK_CONFIDENCE_MIN } from "$lib/server/utils/constants";
import { clipText } from "$lib/server/utils/text";
import type { Artifact, ArtifactChunk, TaskState } from "$lib/types";
import { canUseTeiReranker, rerankItems } from "../tei-reranker";
import {
	canUseContextSummarizer,
	requestContextSummarizer,
} from "./control-model";
import { mapArtifactChunk } from "./mappers";

/** Maximum characters for full content retrieval to prevent unbounded content */
const FULL_CONTENT_MAX_CHARS = 100_000;
const CHUNK_RERANK_MAX_CANDIDATES = 48;
const FULL_CONTENT_TRUNCATION_NOTICE_CHARS = 20;

export { syncArtifactChunks } from "./chunk-sync";

type RankedChunkEntry = {
	chunk: ArtifactChunk;
	score: number;
};

type ArtifactSnippetBudget = {
	perArtifactCharBudget: number;
	remainingTotalCharBudget: number | null;
};

type ArtifactQueryContext = {
	query: string;
	queryHasTerms: boolean;
	perArtifactLimit: number;
	perArtifactCharBudget: number;
};

type ChunksByArtifactId = Map<string, ArtifactChunk[]>;

export function formatTaskStateForPrompt(taskState: TaskState): string {
	const sections = [
		`Objective: ${taskState.objective}`,
		taskState.constraints.length > 0
			? `Constraints:\n- ${taskState.constraints.join("\n-")}`
			: null,
		taskState.factsToPreserve.length > 0
			? `Facts to preserve:\n- ${taskState.factsToPreserve.join("\n-")}`
			: null,
		taskState.decisions.length > 0
			? `Decisions:\n- ${taskState.decisions.join("\n-")}`
			: null,
		taskState.openQuestions.length > 0
			? `Open questions:\n- ${taskState.openQuestions.join("\n-")}`
			: null,
		taskState.nextSteps.length > 0
			? `Next steps:\n- ${taskState.nextSteps.join("\n-")}`
			: null,
	].filter((value): value is string => Boolean(value));

	return sections.join("\n\n");
}

export async function listArtifactChunksForArtifacts(
	userId: string,
	artifactIds: string[],
): Promise<ArtifactChunk[]> {
	if (artifactIds.length === 0) return [];
	const rows = await db
		.select()
		.from(artifactChunks)
		.where(
			and(
				eq(artifactChunks.userId, userId),
				inArray(artifactChunks.artifactId, artifactIds),
			),
		)
		.orderBy(artifactChunks.chunkIndex);

	return rows.map(mapArtifactChunk);
}

/**
 * Retrieves full artifact content directly, bypassing chunk selection.
 * Returns contentText truncated to maxChars (default FULL_CONTENT_MAX_CHARS).
 * Appends truncation notice if content exceeds the limit.
 */
export async function getFullArtifactContent(
	artifactId: string,
	maxChars: number = FULL_CONTENT_MAX_CHARS,
): Promise<string | null> {
	const { artifacts } = await import("$lib/server/db/schema");
	const row = await db
		.select({ contentText: artifacts.contentText })
		.from(artifacts)
		.where(eq(artifacts.id, artifactId))
		.limit(1)
		.get();

	if (!row?.contentText) return null;

	if (row.contentText.length <= maxChars) {
		return row.contentText;
	}

	return `${row.contentText.slice(0, maxChars).trim()}\n...[truncated]`;
}

export async function getPromptArtifactSnippets(params: {
	userId: string;
	artifacts: Artifact[];
	query: string;
	perArtifactLimit?: number;
	perArtifactCharBudget?: number;
	totalCharBudget?: number;
	useFullContent?: boolean;
}): Promise<Map<string, string>> {
	const budgets = createSnippetBudgets({
		perArtifactCharBudget: params.perArtifactCharBudget,
		totalCharBudget: params.totalCharBudget,
	});
	const queryContext = buildArtifactQueryContext({
		query: params.query,
		perArtifactLimit: params.perArtifactLimit,
		perArtifactCharBudget: params.perArtifactCharBudget,
	});

	const chunkRows = await listArtifactChunksForArtifacts(
		params.userId,
		params.artifacts.map((artifact) => artifact.id),
	);
	const chunksByArtifactId = indexChunksByArtifactId(chunkRows);
	const snippets = new Map<string, string>();

	for (const artifact of params.artifacts) {
		if (budgets.remainingTotalCharBudget === 0) {
			snippets.set(artifact.id, "");
			continue;
		}

		const chunks = chunksByArtifactId.get(artifact.id) ?? [];
		const snippet = await resolveArtifactSnippet({
			artifact,
			queryContext,
			useFullContent: params.useFullContent,
			chunks,
		});
		setSnippetWithBudget({
			artifactId: artifact.id,
			text: snippet,
			perArtifactCharBudget: budgets.perArtifactCharBudget,
			remainingTotalCharBudget: budgets,
			snippets,
		});
	}

	return snippets;
}

function createSnippetBudgets(params: {
	perArtifactCharBudget?: number;
	totalCharBudget?: number;
}): ArtifactSnippetBudget {
	return {
		perArtifactCharBudget: params.perArtifactCharBudget ?? 1400,
		remainingTotalCharBudget:
			typeof params.totalCharBudget === "number" &&
			Number.isFinite(params.totalCharBudget)
				? Math.max(0, Math.floor(params.totalCharBudget))
				: null,
	};
}

function buildArtifactQueryContext(params: {
	query: string;
	perArtifactLimit?: number;
	perArtifactCharBudget?: number;
}): ArtifactQueryContext {
	const normalizedQuery = params.query.trim();
	return {
		query: normalizedQuery,
		queryHasTerms: normalizedQuery.length > 0,
		perArtifactLimit: params.perArtifactLimit ?? 2,
		perArtifactCharBudget: params.perArtifactCharBudget ?? 1400,
	};
}

function indexChunksByArtifactId(rows: ArtifactChunk[]): ChunksByArtifactId {
	const chunksByArtifactId = new Map<string, ArtifactChunk[]>();
	for (const chunk of rows) {
		const list = chunksByArtifactId.get(chunk.artifactId) ?? [];
		list.push(chunk);
		chunksByArtifactId.set(chunk.artifactId, list);
	}
	return chunksByArtifactId;
}

function setSnippetWithBudget(args: {
	artifactId: string;
	text: string;
	perArtifactCharBudget: number;
	remainingTotalCharBudget: ArtifactSnippetBudget;
	snippets: Map<string, string>;
}) {
	const availableBudget =
		args.remainingTotalCharBudget.remainingTotalCharBudget === null
			? args.perArtifactCharBudget
			: Math.min(
					args.perArtifactCharBudget,
					args.remainingTotalCharBudget.remainingTotalCharBudget,
				);
	const snippet =
		availableBudget > 0 ? clipText(args.text, availableBudget) : "";
	args.snippets.set(args.artifactId, snippet);
	if (args.remainingTotalCharBudget.remainingTotalCharBudget !== null) {
		args.remainingTotalCharBudget.remainingTotalCharBudget = Math.max(
			0,
			args.remainingTotalCharBudget.remainingTotalCharBudget - snippet.length,
		);
	}
}

async function resolveArtifactSnippet(args: {
	artifact: Artifact;
	queryContext: ArtifactQueryContext;
	useFullContent?: boolean;
	chunks: ArtifactChunk[];
}): Promise<string> {
	if (args.useFullContent) {
		const fullContent = await resolveFullContentSnippet({
			artifact: args.artifact,
			queryContext: args.queryContext,
		});
		if (fullContent !== null) {
			return fullContent;
		}

		return (
			args.artifact.contentText ?? args.artifact.summary ?? args.artifact.name
		);
	}

	if (args.chunks.length === 0) {
		return (
			args.artifact.contentText ?? args.artifact.summary ?? args.artifact.name
		);
	}

	const ranked = rankArtifactChunks(
		args.artifact,
		args.chunks,
		args.queryContext.query,
		args.queryContext.queryHasTerms,
	);
	const chosen = await chooseArtifactChunks(
		args.artifact,
		args.queryContext,
		ranked,
	);
	return combineSnippetChunks(chosen, args.queryContext.perArtifactCharBudget);
}

async function resolveFullContentSnippet(args: {
	artifact: Artifact;
	queryContext: ArtifactQueryContext;
}): Promise<string | null> {
	if (!args.artifact.contentText) return null;

	const fullContent = await getFullArtifactContent(
		args.artifact.id,
		Math.min(
			FULL_CONTENT_MAX_CHARS,
			Math.max(
				0,
				args.queryContext.perArtifactCharBudget -
					FULL_CONTENT_TRUNCATION_NOTICE_CHARS,
			),
		),
	);
	return fullContent ?? null;
}

function rankArtifactChunks(
	artifact: Artifact,
	chunks: ArtifactChunk[],
	query: string,
	queryHasTerms: boolean,
): RankedChunkEntry[] {
	return chunks
		.map((chunk) => ({
			chunk,
			score: queryHasTerms
				? scoreMatch(
						query,
						`${artifact.name}\n${artifact.summary ?? ""}\n${chunk.contentText}`,
					)
				: 0,
		}))
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.chunk.chunkIndex - b.chunk.chunkIndex;
		});
}

async function chooseArtifactChunks(
	artifact: Artifact,
	queryContext: ArtifactQueryContext,
	ranked: RankedChunkEntry[],
): Promise<RankedChunkEntry[]> {
	let chosen = ranked
		.filter((entry) => entry.score > 0)
		.slice(0, queryContext.perArtifactLimit);
	if (chosen.length === 0) {
		chosen = ranked.slice(0, 1);
	}

	const rerankCandidates = selectChunkRerankCandidates(
		ranked,
		queryContext.perArtifactLimit,
	);
	if (
		!queryContext.queryHasTerms ||
		!canUseTeiReranker() ||
		rerankCandidates.length <= 2
	) {
		return chosen;
	}

	try {
		const reranked = await rerankItems({
			query: queryContext.query,
			items: rerankCandidates,
			getText: (entry) =>
				[
					`Artifact: ${artifact.name}`,
					artifact.summary
						? `Artifact summary: ${clipText(artifact.summary, 220)}`
						: null,
					clipText(entry.chunk.contentText, 500),
				]
					.filter((value): value is string => Boolean(value))
					.join("\n\n"),
			maxTexts: rerankCandidates.length,
		});

		if (
			reranked &&
			reranked.items.length > 0 &&
			reranked.confidence >= RERANK_CONFIDENCE_MIN
		) {
			return reranked.items
				.slice(0, queryContext.perArtifactLimit)
				.map(({ item }) => item);
		}
	} catch (error) {
		console.error("[TASK_STATE] Chunk reranker failed:", error);
	}

	return chosen;
}

function combineSnippetChunks(
	chosen: RankedChunkEntry[],
	perArtifactCharBudget: number,
): string {
	return chosen
		.map((entry) =>
			clipText(
				entry.chunk.contentText,
				Math.floor(perArtifactCharBudget / chosen.length),
			),
		)
		.join("\n\n");
}

function selectChunkRerankCandidates(
	ranked: RankedChunkEntry[],
	perArtifactLimit: number,
): RankedChunkEntry[] {
	if (ranked.length <= CHUNK_RERANK_MAX_CANDIDATES) return ranked;

	const candidateLimit = Math.max(
		perArtifactLimit,
		CHUNK_RERANK_MAX_CANDIDATES,
	);
	const selected: RankedChunkEntry[] = [];
	const seen = new Set<string>();
	const add = (entry: RankedChunkEntry | undefined) => {
		if (!entry || seen.has(entry.chunk.id)) return;
		seen.add(entry.chunk.id);
		selected.push(entry);
	};

	const topLexicalCount = Math.ceil(candidateLimit * 0.6);
	for (const entry of ranked.slice(0, topLexicalCount)) {
		add(entry);
	}

	const byDocumentOrder = [...ranked].sort(
		(left, right) => left.chunk.chunkIndex - right.chunk.chunkIndex,
	);
	const remainingSlots = candidateLimit - selected.length;
	if (remainingSlots > 0) {
		const denominator = Math.max(1, remainingSlots - 1);
		for (let index = 0; index < remainingSlots; index += 1) {
			const chunkIndex = Math.round(
				(index * (byDocumentOrder.length - 1)) / denominator,
			);
			add(byDocumentOrder[chunkIndex]);
		}
	}

	for (const entry of ranked) {
		if (selected.length >= candidateLimit) break;
		add(entry);
	}

	return selected;
}

export async function summarizeHistoricalContext(params: {
	message: string;
	taskState: TaskState | null;
	sectionBodies: Array<{ title: string; body: string }>;
	targetTokens: number;
}): Promise<string | null> {
	if (!canUseContextSummarizer()) return null;
	if (params.sectionBodies.length === 0) return null;

	const prompt = [
		params.taskState
			? `Current task objective: ${params.taskState.objective}`
			: null,
		`Current user message: ${params.message}`,
		"Condense the historical support context below into a compact working checkpoint for the current turn. Preserve only details that are clearly relevant to the current task and user message.",
		...params.sectionBodies.map(
			(section) => `## ${section.title}\n${section.body}`,
		),
	]
		.filter((value): value is string => Boolean(value))
		.join("\n\n");

	try {
		const content = await requestContextSummarizer({
			system:
				"You compress historical support context for a chat assistant. Return concise markdown, focused on currently relevant facts, decisions, open questions, and evidence. Do not invent new facts.",
			user: prompt,
			maxTokens: Math.max(
				240,
				Math.min(700, Math.floor(params.targetTokens / 3)),
			),
			temperature: 0.0,
		});
		return content ? content.trim() : null;
	} catch (error) {
		console.error(
			"[TASK_STATE] Historical context summarization failed:",
			error,
		);
		return null;
	}
}
