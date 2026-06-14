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
	const perArtifactLimit = params.perArtifactLimit ?? 2;
	const perArtifactCharBudget = params.perArtifactCharBudget ?? 1400;
	let remainingTotalCharBudget =
		typeof params.totalCharBudget === "number" &&
		Number.isFinite(params.totalCharBudget)
			? Math.max(0, Math.floor(params.totalCharBudget))
			: null;
	const artifactIds = params.artifacts.map((artifact) => artifact.id);
	const chunkRows = await listArtifactChunksForArtifacts(
		params.userId,
		artifactIds,
	);
	const chunksByArtifactId = new Map<string, ArtifactChunk[]>();

	for (const chunk of chunkRows) {
		const list = chunksByArtifactId.get(chunk.artifactId) ?? [];
		list.push(chunk);
		chunksByArtifactId.set(chunk.artifactId, list);
	}

	const snippets = new Map<string, string>();
	const setBudgetedSnippet = (artifactId: string, text: string) => {
		const availableBudget =
			remainingTotalCharBudget === null
				? perArtifactCharBudget
				: Math.min(perArtifactCharBudget, remainingTotalCharBudget);
		const snippet = availableBudget > 0 ? clipText(text, availableBudget) : "";
		snippets.set(artifactId, snippet);
		if (remainingTotalCharBudget !== null) {
			remainingTotalCharBudget = Math.max(
				0,
				remainingTotalCharBudget - snippet.length,
			);
		}
	};

	for (const artifact of params.artifacts) {
		if (remainingTotalCharBudget === 0) {
			snippets.set(artifact.id, "");
			continue;
		}

		const chunks = chunksByArtifactId.get(artifact.id) ?? [];

		if (chunks.length === 0 || params.useFullContent) {
			if (params.useFullContent && artifact.contentText) {
				const fullContentBudget =
					remainingTotalCharBudget === null
						? perArtifactCharBudget
						: Math.min(perArtifactCharBudget, remainingTotalCharBudget);
				const fullContentReadBudget = Math.max(
					0,
					fullContentBudget - FULL_CONTENT_TRUNCATION_NOTICE_CHARS,
				);
				const fullContent = await getFullArtifactContent(
					artifact.id,
					Math.min(FULL_CONTENT_MAX_CHARS, fullContentReadBudget),
				);
				if (fullContent) {
					setBudgetedSnippet(artifact.id, fullContent);
					continue;
				}
			}
			const fallback =
				artifact.contentText ?? artifact.summary ?? artifact.name;
			setBudgetedSnippet(artifact.id, fallback);
			continue;
		}

		const ranked = chunks
			.map((chunk) => ({
				chunk,
				score: params.query.trim()
					? scoreMatch(
							params.query,
							`${artifact.name}\n${artifact.summary ?? ""}\n${chunk.contentText}`,
						)
					: 0,
			}))
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				return a.chunk.chunkIndex - b.chunk.chunkIndex;
			});

		let chosen = ranked
			.filter((entry) => entry.score > 0)
			.slice(0, perArtifactLimit);
		if (chosen.length === 0) {
			chosen = ranked.slice(0, 1);
		}

		const rerankCandidates = selectChunkRerankCandidates(
			ranked,
			perArtifactLimit,
		);
		if (
			canUseTeiReranker() &&
			params.query.trim() &&
			rerankCandidates.length > 2
		) {
			try {
				const reranked = await rerankItems({
					query: params.query,
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
					chosen = reranked.items
						.slice(0, perArtifactLimit)
						.map(({ item }) => item);
				}
			} catch (error) {
				console.error("[TASK_STATE] Chunk reranker failed:", error);
			}
		}

		const combined = chosen
			.map((entry) =>
				clipText(
					entry.chunk.contentText,
					Math.floor(perArtifactCharBudget / chosen.length),
				),
			)
			.join("\n\n");
		setBudgetedSnippet(artifact.id, combined);
	}

	return snippets;
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
