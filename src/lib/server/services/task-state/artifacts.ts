import { and, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import { artifactChunks } from "$lib/server/db/schema";
import type {
	Artifact,
	ArtifactChunk,
} from "$lib/server/services/knowledge/types";
import type { TaskState } from "$lib/server/services/task-state/types";
import { scoreMatch } from "$lib/server/services/working-set";
import { RERANK_CONFIDENCE_MIN } from "$lib/server/utils/constants";
import { clipText } from "$lib/server/utils/text";
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
	return combineSnippetChunks(
		chosen,
		args.queryContext.perArtifactCharBudget,
		resolveArtifactPageLabel(args.artifact),
	);
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
	options: {
		/**
		 * When no chunk scores, fall back to the first chunk in document
		 * order (the pushed-context default: some excerpt beats none). Off
		 * for the pull side, where "no match" must be reported as such.
		 */
		allowOrderFallback?: boolean;
	} = {},
): Promise<RankedChunkEntry[]> {
	let chosen = ranked
		.filter((entry) => entry.score > 0)
		.slice(0, queryContext.perArtifactLimit);
	if (chosen.length === 0 && options.allowOrderFallback !== false) {
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

/**
 * The page vocabulary a citation may use, keyed by the artifact's
 * `pageCountKind`.
 *
 * Only these four kinds are citable. `declared` is what DOCX reports — a
 * four-heading document comes back as `page_count: 1` — and `logical` is what
 * CSV and HTML report; "p. 1" there would be an invention, not a citation.
 * `unknown` (PNG/JPEG, whose `metadata.document` is `{}`) is the same.
 */
const PAGE_CITATION_LABELS: Readonly<Record<string, string>> = {
	physical: "p.",
	spine: "p.",
	slide: "slide",
	sheet: "sheet",
};

/**
 * The label this artifact's chunks may cite with, or null when it may not
 * cite at all.
 *
 * A single-page document is never cited either: "[p. 1]" on every chunk of a
 * one-page document is noise that buys the model nothing.
 */
export function resolveArtifactPageLabel(artifact: Artifact): string | null {
	const metadata = artifact.metadata;
	const kind =
		typeof metadata?.pageCountKind === "string"
			? metadata.pageCountKind.trim().toLowerCase()
			: null;
	const label = kind ? PAGE_CITATION_LABELS[kind] : undefined;
	if (!label) return null;

	const metadataPageCount =
		typeof metadata?.pageCount === "number" ? metadata.pageCount : null;
	const pageCount = artifact.pageCount ?? metadataPageCount;
	if (typeof pageCount !== "number" || pageCount <= 1) return null;

	return label;
}

/**
 * `[p. 3]` / `[p. 3–4]` / `[slide 2]` / `[sheet 1]`, or `""` when this chunk
 * carries no usable page range. En dash for the span, ASCII otherwise.
 */
export function formatPageCitation(
	chunk: Pick<ArtifactChunk, "pageStart" | "pageEnd">,
	label: string | null,
): string {
	if (!label) return "";
	const start = chunk.pageStart;
	if (typeof start !== "number" || !Number.isInteger(start) || start < 1) {
		return "";
	}
	const end = chunk.pageEnd;
	const spansPages =
		typeof end === "number" && Number.isInteger(end) && end > start;
	return spansPages ? `[${label} ${start}–${end}]` : `[${label} ${start}]`;
}

/**
 * The chunks the model sees, each prefixed with its page when the document
 * has citable pages.
 *
 * The prefix is paid for OUT OF the chunk's share of the character budget —
 * the body is clipped by the citation's own length — so a cited snippet is
 * never longer than an uncited one. The evidence section is clipped again by
 * token budget further up (`serializeWorkingSetArtifacts`), and citations
 * displacing body text there rather than growing the section is the whole
 * point: a prompt that gets longer because it cites is a prompt that trims
 * something else away instead.
 */
function combineSnippetChunks(
	chosen: RankedChunkEntry[],
	perArtifactCharBudget: number,
	pageLabel: string | null,
): string {
	const perChunkBudget = Math.floor(perArtifactCharBudget / chosen.length);
	return chosen
		.map((entry) => {
			const citation = formatPageCitation(entry.chunk, pageLabel);
			// Nothing to cite with: a budget so small the citation would leave no
			// room for text drops the citation, never the text.
			const bodyBudget = citation
				? perChunkBudget - citation.length - 1
				: perChunkBudget;
			if (bodyBudget <= 0) {
				return clipText(entry.chunk.contentText, perChunkBudget);
			}
			const body = clipText(entry.chunk.contentText, bodyBudget);
			return citation ? `${citation}\n${body}` : body;
		})
		.join("\n\n");
}

export type DocumentPassage = {
	chunkIndex: number;
	/**
	 * A verbatim prefix of the chunk, cut to its share of the char budget.
	 * Verbatim (no whitespace collapsing, no ellipsis) so that
	 * `charOffset + text.length` is exactly where the text stops in the
	 * document, and a `from` window can pick up from there.
	 */
	text: string;
	/** Lexical/rerank score the chunk was chosen with (0 = rerank-only). */
	score: number;
	/** True when `text` is shorter than the chunk it was cut from. */
	truncated: boolean;
	/** The chunk's full (uncut) text, for callers deriving offsets. */
	chunkText: string;
	/**
	 * 1-based inclusive pages the chunk spans, for a document parsed with
	 * structure. Null for direct text, for legacy rows and for the synthesized
	 * pseudo-chunk of a document that is too small to have chunks at all.
	 */
	pageStart: number | null;
	pageEnd: number | null;
};

/**
 * The best chunks of ONE document for a query — the pull-side counterpart
 * of {@link getPromptArtifactSnippets}. Reuses the same ranking and rerank
 * path (`rankArtifactChunks` / `chooseArtifactChunks`) so read_generated_file's
 * `query` mode and the pushed context never disagree about what "relevant"
 * means. Documents below the chunking threshold (chunk-sync.ts stores them
 * unchunked) are treated as a single chunk so they still answer.
 *
 * Unlike the pushed snippets, a query that matches nothing returns NO
 * passages rather than the document's first chunk: the tool result says
 * "passages about X", and a chunk that is merely first is not that.
 *
 * `useStoredChunks: false` skips `artifact_chunks` and chunks the given
 * `contentText` as one passage — for generated files, whose stored chunks
 * were cut from the memory wrapper (see read-generated-file.ts) rather
 * than from the text the caller is offsetting into.
 */
export async function selectDocumentPassages(params: {
	userId: string;
	artifact: Artifact;
	query: string;
	limit?: number;
	charBudget?: number;
	useStoredChunks?: boolean;
}): Promise<{ passages: DocumentPassage[]; chunkCount: number }> {
	const limit = Math.max(1, Math.floor(params.limit ?? 3));
	const charBudget = Math.max(
		200,
		Math.floor(params.charBudget ?? 1200 * limit),
	);
	const queryContext = buildArtifactQueryContext({
		query: params.query,
		perArtifactLimit: limit,
		perArtifactCharBudget: charBudget,
	});

	let chunks =
		params.useStoredChunks === false
			? []
			: await listArtifactChunksForArtifacts(params.userId, [
					params.artifact.id,
				]);
	if (chunks.length === 0 && params.artifact.contentText?.trim()) {
		chunks = [
			{
				id: `${params.artifact.id}:0`,
				artifactId: params.artifact.id,
				userId: params.userId,
				conversationId: params.artifact.conversationId,
				chunkIndex: 0,
				contentText: params.artifact.contentText.trim(),
				tokenEstimate: 0,
				// The whole document as one chunk: it spans every page, so no
				// single page is the honest answer.
				pageStart: null,
				pageEnd: null,
				createdAt: params.artifact.createdAt,
				updatedAt: params.artifact.updatedAt,
			},
		];
	}
	if (chunks.length === 0) {
		return { passages: [], chunkCount: 0 };
	}

	const ranked = rankArtifactChunks(
		params.artifact,
		chunks,
		queryContext.query,
		queryContext.queryHasTerms,
	);
	const chosen = await chooseArtifactChunks(
		params.artifact,
		queryContext,
		ranked,
		{ allowOrderFallback: false },
	);
	const perPassageChars = Math.floor(charBudget / Math.max(1, chosen.length));

	return {
		chunkCount: chunks.length,
		passages: chosen.map((entry) => ({
			chunkIndex: entry.chunk.chunkIndex,
			text: entry.chunk.contentText.slice(0, perPassageChars),
			score: entry.score,
			truncated: entry.chunk.contentText.length > perPassageChars,
			chunkText: entry.chunk.contentText,
			pageStart: entry.chunk.pageStart,
			pageEnd: entry.chunk.pageEnd,
		})),
	};
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
