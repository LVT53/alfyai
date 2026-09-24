// Atlas v3 lifecycle seeding (Phase D, ADR 0063 as amended; ADR 0036 branch
// 19; ADR 0037 edge case 5).
//
// A Continue, Revise or Fork child starts from its parent instead of from
// nothing, and exactly how much it takes is the whole design:
//
//   Continue  the parent's evidence bank (rechecked with a 14-day window), its
//             memo and asked queries, and its outline as `previous`.
//   Revise    the bank (every time-sensitive source rechecked) and the outline,
//             but NOT the memo: the parent's answer would anchor the rewrite.
//   Fork      no bank at all. Quotes were extracted FOR the parent's goals, and
//             reusing them would bend a new direction back toward the old one.
//             Only the parent's title and verdict, for orientation.
//
// All three inherit the user's documents the parent read. A v1 or v2 parent
// has no bank: its report's web source URLs become seed pages, read afresh,
// and none of its text is trusted unread.
//
// Two halves: `loadAtlasV3ParentSeed` reads (through injected DB reads, so it
// is testable without a database), and `applyAtlasV3Seed` builds the child's
// starting bank, spending live re-reads within one research round's budget.

import type {
	GeneratedDocumentBlock,
	GeneratedDocumentSource,
} from "$lib/server/services/file-production/source-schema";
import type { SupportedLanguage } from "$lib/server/services/language";
import { canonicalizeGroundedWebUrl } from "$lib/server/services/web-grounding";
import type { AtlasParentJob } from "../atlas/checkpoints";
import type { AtlasPipelineJobContext } from "../atlas/types";
import { readAtlasV3ResumeState } from "./checkpoint-state";
import { ATLAS_V3_MAX_OUTPUT_TOKENS } from "./config";
import {
	ATLAS_V3_READ_SYSTEM,
	type AtlasV3BankState,
	addAtlasV3Source,
	buildAtlasV3ReadPrompt,
	createAtlasV3Bank,
	dropAtlasV3SourceEvidence,
	fileAtlasV3Read,
	parseAtlasV3Read,
	thawAtlasV3Bank,
} from "./evidence-bank";
import { atlasV3QuoteStillStated, planAtlasV3SeedRechecks } from "./freshness";
import type { AtlasV3NativeSourceSet } from "./language-standard";
import type { AtlasV3LocalDocument } from "./local-sources";
import type { AtlasV3ModelCall } from "./model-call";
import type { AtlasV3ResearchWeb } from "./research-web-adapter";
import { ATLAS_V3_MAX_PAGE_CHARS } from "./researcher";
import { mapWithConcurrency } from "./rounds";
import type {
	AtlasV3EvidenceBank,
	AtlasV3Memo,
	AtlasV3Outline,
	AtlasV3ParentSeed,
	AtlasV3RecheckOutcome,
	AtlasV3SeedDiagnostics,
	AtlasV3Usage,
} from "./types";

/** Characters of the parent's verdict the child's ask may see. */
export const ATLAS_V3_SEED_VERDICT_CHARS = 1_200;
const MAX_HEADINGS = 12;
const MAX_HEADING_CHARS = 160;
/** Unreachable-evidence hints added to the child's first research round. */
export const ATLAS_V3_SEED_MAX_HINTS = 2;

// ---------------------------------------------------------------------------
// Reading the parent's report
// ---------------------------------------------------------------------------

/** Headings every Atlas report carries; they say nothing about its content. */
const CHROME_HEADING =
	/^(?:executive summary|summary|verdict|limitations|sources|web sources|your library|what this report could not establish|vezetői összefoglaló|összefoglaló|ítélet|korlátok|források|saját könyvtár|amit ez a jelentés nem tudott megállapítani)$/iu;
const VERDICT_HEADING =
	/^(?:executive summary|summary|verdict|vezetői összefoglaló|összefoglaló|ítélet)$/iu;

/**
 * Paragraph text without citation tokens: v2/v3's `[[cite:n:c]]` and
 * `[[cite:i]]`, printed `[n]` markers, and the confidence superscripts.
 */
export function stripAtlasV3CitationTokens(text: string): string {
	return text
		.replace(/\[\[cite:[^\]]*\]\]/gu, "")
		.replace(/\[\d+\]/gu, "")
		.replace(/[ᶜˢⁱ]/gu, "")
		.replace(/\s+([.,;:!?])/gu, "$1")
		.replace(/\s+/gu, " ")
		.trim();
}

function isHttpUrl(value: unknown): value is string {
	return typeof value === "string" && /^https?:\/\//iu.test(value.trim());
}

/**
 * The parts of a persisted report a child may use: its title, its section
 * headings, its verdict or executive summary (citation tokens stripped, at
 * most 1,200 characters) and its web sources. Works on what v1, v2 and v3 all
 * persisted — v1's basis markers and v2/v3's cite tokens alike — because it
 * reads only headings, paragraph text and source chips.
 */
export function extractAtlasV3ParentReport(
	source: GeneratedDocumentSource,
): NonNullable<AtlasV3ParentSeed["report"]> {
	const blocks: readonly GeneratedDocumentBlock[] = source.blocks;
	const headings: string[] = [];
	for (const block of blocks) {
		if (block.type !== "heading" || block.level !== 2) continue;
		const text = block.text.replace(/\s+/gu, " ").trim();
		if (!text || CHROME_HEADING.test(text)) continue;
		if (!headings.includes(text))
			headings.push(text.slice(0, MAX_HEADING_CHARS));
		if (headings.length >= MAX_HEADINGS) break;
	}

	// The paragraphs under the verdict / executive-summary heading; failing
	// that, the report's first paragraph.
	const paragraphs: string[] = [];
	const verdictIndex = blocks.findIndex(
		(block) =>
			block.type === "heading" && VERDICT_HEADING.test(block.text.trim()),
	);
	if (verdictIndex >= 0) {
		for (const block of blocks.slice(verdictIndex + 1)) {
			if (block.type === "heading") break;
			if (block.type === "paragraph") paragraphs.push(block.text);
		}
	}
	if (paragraphs.length === 0) {
		const first = blocks.find((block) => block.type === "paragraph");
		if (first?.type === "paragraph") paragraphs.push(first.text);
	}
	const verdict = stripAtlasV3CitationTokens(paragraphs.join(" ")).slice(
		0,
		ATLAS_V3_SEED_VERDICT_CHARS,
	);

	const webSources: Array<{ url: string; title: string }> = [];
	for (const block of blocks) {
		if (block.type !== "sourceChips") continue;
		for (const chip of block.sources) {
			if (chip.kind === "library" || !isHttpUrl(chip.url)) continue;
			const url = chip.url.trim();
			if (webSources.some((entry) => entry.url === url)) continue;
			webSources.push({ url, title: chip.title });
		}
	}
	return {
		title: source.title.replace(/\s+/gu, " ").trim(),
		headings,
		verdict,
		webSources,
	};
}

/**
 * Web source URLs from an old parent's checkpoint pool, for a parent whose
 * report did not persist: v1 kept `{ web: [{ url, title }] }`, v2 and v3 a
 * flat array of `{ url, title }`.
 */
export function atlasV3SeedUrlsFromCheckpointPool(
	pool: unknown,
): Array<{ url: string; title: string }> {
	const entries = Array.isArray(pool)
		? pool
		: pool &&
				typeof pool === "object" &&
				Array.isArray((pool as { web?: unknown }).web)
			? (pool as { web: unknown[] }).web
			: [];
	const urls: Array<{ url: string; title: string }> = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { url?: unknown; title?: unknown; kind?: unknown };
		if (record.kind === "local" || !isHttpUrl(record.url)) continue;
		const url = record.url.trim();
		if (urls.some((existing) => existing.url === url)) continue;
		urls.push({
			url,
			title: typeof record.title === "string" ? record.title : url,
		});
	}
	return urls;
}

// ---------------------------------------------------------------------------
// Loading the seed
// ---------------------------------------------------------------------------

/** The database reads the loader needs; bound in worker-bindings.ts. */
export interface AtlasV3SeedReads {
	loadParentJob(input: {
		userId: string;
		parentAtlasJobId: string;
	}): Promise<AtlasParentJob | null>;
	loadCheckpoints(jobId: string): Promise<
		Array<{
			roundNumber: number;
			checkpoint: unknown;
			curatedSourcePool: unknown;
		}>
	>;
	loadReportSource(input: {
		userId: string;
		conversationId: string;
		fileProductionJobId: string;
	}): Promise<GeneratedDocumentSource | null>;
	/** Display ids of the documents attached or linked to the parent's kickoff. */
	listKickoffDocumentIds(input: {
		userId: string;
		conversationId: string;
		assistantMessageId: string | null;
	}): Promise<string[]>;
}

/**
 * The seed a lifecycle child may use, or null: a `create` job, a parent that
 * is not this user's, one that did not succeed, and one from ANOTHER
 * conversation all seed nothing. The last is the incognito rule — a report
 * from a private chat must not seed one elsewhere — and the send route already
 * refuses such a kickoff; this is the worker-time check.
 */
export async function loadAtlasV3ParentSeed(input: {
	job: Pick<
		AtlasPipelineJobContext,
		"userId" | "conversationId" | "action" | "parentAtlasJobId"
	>;
	reads: AtlasV3SeedReads;
}): Promise<AtlasV3ParentSeed | null> {
	const { job, reads } = input;
	if (job.action === "create" || !job.parentAtlasJobId) return null;
	const action = job.action;
	const parent = await reads.loadParentJob({
		userId: job.userId,
		parentAtlasJobId: job.parentAtlasJobId,
	});
	if (
		!parent ||
		parent.status !== "succeeded" ||
		parent.conversationId !== job.conversationId
	) {
		console.warn("[ATLAS v3] Lifecycle parent cannot seed this job", {
			parentAtlasJobId: job.parentAtlasJobId,
			found: Boolean(parent),
			status: parent?.status ?? null,
			sameConversation: parent
				? parent.conversationId === job.conversationId
				: null,
		});
		return null;
	}

	const checkpoints = await reads.loadCheckpoints(parent.id);
	const reportSource = parent.fileProductionJobId
		? await reads.loadReportSource({
				userId: job.userId,
				conversationId: job.conversationId,
				fileProductionJobId: parent.fileProductionJobId,
			})
		: null;
	let report = reportSource ? extractAtlasV3ParentReport(reportSource) : null;
	if (!report || report.webSources.length === 0) {
		// No persisted report (or one with no web chips): the checkpoint pool is
		// the parent's list of sources. The latest row that has one wins.
		const pooled = [...checkpoints]
			.sort((left, right) => right.roundNumber - left.roundNumber)
			.map((entry) =>
				atlasV3SeedUrlsFromCheckpointPool(entry.curatedSourcePool),
			)
			.find((urls) => urls.length > 0);
		if (pooled) {
			report = report
				? { ...report, webSources: pooled }
				: { title: "", headings: [], verdict: "", webSources: pooled };
		}
	}

	const resume =
		parent.pipelineVersion === 3 ? readAtlasV3ResumeState(checkpoints) : null;
	const bank = resume ? (resume.verifiedBank ?? resume.bank ?? null) : null;
	const citedSourceIds =
		resume?.citedSourceIds ??
		(bank && report ? citedSourcesByUrl(bank, report.webSources) : []);

	const localIds: string[] = [];
	const addLocal = (id: string) => {
		if (id && !localIds.includes(id)) localIds.push(id);
	};
	for (const source of bank?.sources ?? []) {
		if (source.kind === "local") addLocal(source.displayArtifactId);
	}
	for (const id of await reads.listKickoffDocumentIds({
		userId: job.userId,
		conversationId: job.conversationId,
		assistantMessageId: parent.assistantMessageId,
	})) {
		addLocal(id);
	}

	return {
		parentJobId: parent.id,
		action,
		parentPipelineVersion: parent.pipelineVersion,
		parentCompletedAt: parent.completedAt
			? parent.completedAt.toISOString()
			: null,
		report,
		// A Fork reuses none of the parent's working state.
		v3:
			resume && action !== "fork"
				? {
						ask: resume.ask ?? null,
						bank,
						memo: resume.memo ?? null,
						asked: resume.askedQuestions ?? [],
						outline: resume.outline ?? null,
						citedSourceIds,
					}
				: null,
		localDisplayArtifactIds: localIds,
	};
}

/** For a parent that predates `citedSourceIds`: its report's chips, by URL. */
function citedSourcesByUrl(
	bank: AtlasV3EvidenceBank,
	webSources: ReadonlyArray<{ url: string }>,
): string[] {
	const ids: string[] = [];
	for (const entry of webSources) {
		const canonical = canonicalizeGroundedWebUrl(entry.url)?.canonicalUrl;
		const source = bank.sources.find(
			(candidate) =>
				candidate.canonicalUrl === canonical ||
				candidate.canonicalUrl === entry.url,
		);
		if (source && !ids.includes(source.id)) ids.push(source.id);
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Applying the seed
// ---------------------------------------------------------------------------

export interface ApplyAtlasV3SeedInput {
	seed: AtlasV3ParentSeed;
	now: Date;
	language: SupportedLanguage;
	currentDate: string;
	/** The child's core question: the goal a changed page or seed page is read for. */
	coreQuestion: string;
	/** Live reads this seeding may spend (`atlasV3SeedRecheckBudget`). */
	budget: number;
	/** Continue's window; a Revise uses 0 whatever is passed. */
	windowDays: number;
	/** The user's documents the child resolved, kickoff and inherited alike. */
	localDocuments: readonly AtlasV3LocalDocument[];
	researchWeb: AtlasV3ResearchWeb;
	runReadModel: AtlasV3ModelCall;
	concurrency: number;
	nativeSources?: readonly AtlasV3NativeSourceSet[];
	onUsage?: (usage: AtlasV3Usage) => void;
	onPageRead?: () => void;
	/** Heartbeat hook: how many live re-reads are about to run. */
	onRecheckStart?: (count: number) => Promise<void> | void;
}

export interface AtlasV3SeedResult {
	state: AtlasV3BankState;
	/** Continue only: the parent's memo, filtered to surviving claims. */
	memo: AtlasV3Memo | null;
	/** Continue only: the queries the parent already spent. */
	asked: string[];
	/** Continue and Revise: the parent's outline, filtered to surviving quotes. */
	outline: AtlasV3Outline | null;
	/** `entity metric period` of evidence that was unreachable, for round one. */
	hints: string[];
	diagnostics: AtlasV3SeedDiagnostics;
	/** Per seeded web source, what happened to it. */
	outcomes: Record<string, AtlasV3RecheckOutcome>;
}

function emptyDiagnostics(seed: AtlasV3ParentSeed): AtlasV3SeedDiagnostics {
	return {
		action: seed.action,
		parentPipelineVersion: seed.parentPipelineVersion,
		sourcesSeeded: 0,
		quotesSeeded: 0,
		trusted: 0,
		rechecked: 0,
		confirmed: 0,
		changed: 0,
		dropped: 0,
		seedPagesRead: 0,
	};
}

/** One read-for-goal of a page's text, filed into the bank. */
async function readPageForGoal(input: {
	state: AtlasV3BankState;
	sourceId: string;
	pageText: string;
	goal: string;
	language: SupportedLanguage;
	currentDate: string;
	runReadModel: AtlasV3ModelCall;
	onUsage?: (usage: AtlasV3Usage) => void;
}): Promise<number> {
	const source = input.state.sources.find(
		(entry) => entry.id === input.sourceId,
	);
	if (!source) return 0;
	try {
		const call = await input.runReadModel({
			stage: `v3:read:${source.id}`,
			thinkingMode: "off",
			maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.researchNote,
			system: ATLAS_V3_READ_SYSTEM[input.language],
			prompt: buildAtlasV3ReadPrompt({
				goal: input.goal,
				language: input.language,
				sourceTitle: source.title,
				sourceHost: source.host,
				sourceDate: source.date,
				tier: source.tier,
				pageText: input.pageText,
				maxPageChars: ATLAS_V3_MAX_PAGE_CHARS,
				currentDate: input.currentDate,
			}),
		});
		input.onUsage?.(call.usage);
		const read = parseAtlasV3Read(call.text);
		if (!read || read.useless) return 0;
		return fileAtlasV3Read({
			state: input.state,
			sourceId: source.id,
			goal: input.goal,
			read,
		}).quotes.length;
	} catch {
		return 0;
	}
}

/** `entity metric period` of each claim a source's quotes carried. */
function hintsForSource(state: AtlasV3BankState, sourceId: string): string[] {
	const quoteIds = new Set(
		state.quotes
			.filter((quote) => quote.sourceId === sourceId)
			.map((quote) => quote.id),
	);
	return state.claims
		.filter((claim) => claim.evidenceIds.some((id) => quoteIds.has(id)))
		.map((claim) =>
			[claim.entity, claim.metric, claim.period]
				.filter(Boolean)
				.join(" ")
				.replace(/\s+/gu, " ")
				.trim(),
		)
		.filter(Boolean);
}

/**
 * Builds the child's starting bank from the seed.
 *
 *  - Fork: an empty bank. Its documents are re-read by the local step.
 *  - A v3 parent with a bank (Continue, Revise): the bank is thawed; user
 *    documents that no longer resolve, or changed since they were read, lose
 *    their quotes; web sources are planned by freshness.ts and rechecked live
 *    (`fresh`) within the budget — confirmed, changed (unstated quotes dropped,
 *    the fresh page read for the core question), or unreachable (dropped, its
 *    claims turned into hints) — and what the budget cannot reach is dropped.
 *  - A v1/v2 parent (or a v3 one with no bank): its report's web sources are
 *    read as seed pages, within the budget, for the core question.
 */
export async function applyAtlasV3Seed(
	input: ApplyAtlasV3SeedInput,
): Promise<AtlasV3SeedResult> {
	const { seed } = input;
	const diagnostics = emptyDiagnostics(seed);
	const outcomes: Record<string, AtlasV3RecheckOutcome> = {};
	const retrievedAt = input.now.toISOString();
	if (seed.action === "fork") {
		return {
			state: createAtlasV3Bank(),
			memo: null,
			asked: [],
			outline: null,
			hints: [],
			diagnostics,
			outcomes,
		};
	}

	const parentBank = seed.v3?.bank ?? null;
	if (!parentBank) {
		return applyAtlasV3SeedPages({ ...input, diagnostics, outcomes });
	}

	// A deep copy: the recheck mutates sources and claims in place.
	const state = thawAtlasV3Bank(
		JSON.parse(JSON.stringify(parentBank)) as AtlasV3EvidenceBank,
	);
	diagnostics.sourcesSeeded = state.sources.length;
	diagnostics.quotesSeeded = state.quotes.length;
	for (const source of state.sources) {
		source.seededFrom = seed.parentJobId;
		source.retrievedAt ??= seed.parentCompletedAt;
	}

	// -- the user's documents: re-resolved, never re-trusted blindly ----------
	const documents = new Map(
		input.localDocuments.map((document) => [
			document.displayArtifactId,
			document,
		]),
	);
	for (const source of [...state.sources]) {
		if (source.kind !== "local") continue;
		const document = documents.get(source.displayArtifactId);
		const changedSince =
			document?.updatedAt &&
			source.retrievedAt &&
			Date.parse(document.updatedAt) > Date.parse(source.retrievedAt);
		if (!document || changedSince) {
			// Gone, out of scope, over the cap, or edited since it was read: its
			// old quotes go, and a document that still resolves is read again.
			dropAtlasV3SourceEvidence(state, source.id);
			diagnostics.dropped += 1;
			continue;
		}
		source.origin = "inherited";
		source.promptArtifactId = document.promptArtifactId;
		diagnostics.trusted += 1;
	}

	// -- web sources: trusted, rechecked, or dropped --------------------------
	const plan = planAtlasV3SeedRechecks({
		bank: state,
		action: seed.action,
		now: input.now,
		windowDays: seed.action === "revise" ? 0 : input.windowDays,
		budget: input.budget,
		citedSourceIds: seed.v3?.citedSourceIds ?? [],
		fallbackRetrievedAt: seed.parentCompletedAt,
	});
	for (const id of plan.trusted) outcomes[id] = "trusted";
	diagnostics.trusted += plan.trusted.length;
	const hints: string[] = [];
	for (const id of plan.overBudget) {
		outcomes[id] = "over_budget";
		dropAtlasV3SourceEvidence(state, id);
		diagnostics.dropped += 1;
	}
	if (plan.recheck.length > 0)
		await input.onRecheckStart?.(plan.recheck.length);
	diagnostics.rechecked = plan.recheck.length;
	const targets = plan.recheck
		.map((id) => state.sources.find((source) => source.id === id))
		.filter((source): source is NonNullable<typeof source> => Boolean(source));
	await mapWithConcurrency(
		targets,
		Math.max(1, input.concurrency),
		async (source) => {
			const page = await input.researchWeb.read(source.canonicalUrl, {
				fresh: true,
			});
			if (!page.text) {
				outcomes[source.id] = "unreachable";
				hints.push(...hintsForSource(state, source.id));
				dropAtlasV3SourceEvidence(state, source.id);
				diagnostics.dropped += 1;
				return;
			}
			input.onPageRead?.();
			const pageText = page.text;
			const quotes = state.quotes.filter(
				(quote) => quote.sourceId === source.id,
			);
			const stated = quotes.filter((quote) =>
				atlasV3QuoteStillStated(quote, pageText),
			);
			if (stated.length === quotes.length) {
				outcomes[source.id] = "confirmed";
				source.retrievedAt = retrievedAt;
				diagnostics.confirmed += 1;
				return;
			}
			outcomes[source.id] = "changed";
			diagnostics.changed += 1;
			dropAtlasV3SourceEvidence(state, source.id, {
				keepQuoteIds: stated.map((quote) => quote.id),
			});
			// The page is still there and says something else now: read it for the
			// question again. A source that lost every quote was taken out of the
			// bank, so it is added back as a freshly read page.
			const current =
				state.sources.find((entry) => entry.id === source.id) ??
				addAtlasV3Source(state, {
					url: source.canonicalUrl,
					title: source.title,
					publishedAt: source.date,
					read: true,
					retrievedAt,
					nativeSources: input.nativeSources,
				});
			if (!current) return;
			current.retrievedAt = retrievedAt;
			current.read = true;
			await readPageForGoal({
				state,
				sourceId: current.id,
				pageText,
				goal: input.coreQuestion,
				language: input.language,
				currentDate: input.currentDate,
				runReadModel: input.runReadModel,
				onUsage: input.onUsage,
			});
		},
	);

	// -- what the child keeps of the parent's reasoning -----------------------
	const liveClaimIds = new Set(state.claims.map((claim) => claim.id));
	const liveQuoteIds = new Set(state.quotes.map((quote) => quote.id));
	const parentMemo = seed.v3?.memo ?? null;
	const memo: AtlasV3Memo | null =
		seed.action === "continue" && parentMemo
			? {
					// The parent's prose answer is not carried: it may rest on evidence
					// the recheck just dropped. The claim ids ARE the answer so far.
					answerSoFar: "",
					claimIds: parentMemo.claimIds.filter((id) => liveClaimIds.has(id)),
					openQuestions: [...parentMemo.openQuestions],
					deadEnds: [...parentMemo.deadEnds],
					budgetUsed: {
						searches: 0,
						pagesRead: diagnostics.rechecked,
						rounds: 0,
					},
				}
			: null;
	const parentOutline = seed.v3?.outline ?? null;
	const outline: AtlasV3Outline | null = parentOutline
		? {
				nodes: parentOutline.nodes
					.filter((node) => node.status !== "cut")
					.map((node) => {
						const evidenceIds = node.evidenceIds.filter((id) =>
							liveQuoteIds.has(id),
						);
						return {
							...node,
							evidenceIds,
							status:
								evidenceIds.length === 0 ? ("planned" as const) : node.status,
						};
					}),
				cut: [],
			}
		: null;

	return {
		state,
		memo,
		asked: seed.action === "continue" ? [...(seed.v3?.asked ?? [])] : [],
		outline,
		hints: [...new Set(hints)].slice(0, ATLAS_V3_SEED_MAX_HINTS),
		diagnostics,
		outcomes,
	};
}

/**
 * An old (v1/v2) parent's seed: its report's web sources, read now, for the
 * child's core question, within the budget — filed as fresh sources. The
 * parent's text is never trusted: only what these reads quote enters the bank.
 */
async function applyAtlasV3SeedPages(
	input: ApplyAtlasV3SeedInput & {
		diagnostics: AtlasV3SeedDiagnostics;
		outcomes: Record<string, AtlasV3RecheckOutcome>;
	},
): Promise<AtlasV3SeedResult> {
	const state = createAtlasV3Bank();
	const retrievedAt = input.now.toISOString();
	const pages = (input.seed.report?.webSources ?? []).slice(
		0,
		Math.max(0, Math.floor(input.budget)),
	);
	if (pages.length > 0) await input.onRecheckStart?.(pages.length);
	const reads = await mapWithConcurrency(
		pages,
		Math.max(1, input.concurrency),
		async (page) => ({ page, result: await input.researchWeb.read(page.url) }),
	);
	// Filed in report order, so source ids do not depend on which read finished
	// first.
	for (const { page, result } of reads) {
		if (!result.text) continue;
		const source = addAtlasV3Source(state, {
			url: page.url,
			title: page.title,
			publishedAt: null,
			read: true,
			retrievedAt,
			nativeSources: input.nativeSources,
		});
		if (!source) continue;
		input.onPageRead?.();
		input.diagnostics.seedPagesRead += 1;
		await readPageForGoal({
			state,
			sourceId: source.id,
			pageText: result.text,
			goal: input.coreQuestion,
			language: input.language,
			currentDate: input.currentDate,
			runReadModel: input.runReadModel,
			onUsage: input.onUsage,
		});
	}
	// A seed page whose read quoted nothing is not evidence.
	for (const source of [...state.sources]) {
		if (!state.quotes.some((quote) => quote.sourceId === source.id)) {
			dropAtlasV3SourceEvidence(state, source.id);
		}
	}
	return {
		state,
		memo: null,
		asked: [],
		outline: null,
		hints: [],
		diagnostics: input.diagnostics,
		outcomes: input.outcomes,
	};
}
