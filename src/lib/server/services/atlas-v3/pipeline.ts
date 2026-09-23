// The Atlas v3 content pipeline (ADR 0063).
//
// Nine stages, each a durable checkpoint, each cancellable through the existing
// heartbeat (the worker's heartbeat throws when the job is no longer running).
// The job infrastructure below this module — ledger, claiming, heartbeats,
// checkpoints, cancel, idempotent kickoff, lifecycle, analytics, file
// production — is v1's, unchanged, and shared with v2.

import type { GeneratedDocumentSource } from "$lib/server/services/file-production/source-schema";
import {
	detectLanguage,
	type SupportedLanguage,
} from "$lib/server/services/language";
import type { AtlasOutputIds } from "../atlas/output-files";
import type { AtlasPipelineJobContext } from "../atlas/types";
import {
	type AtlasV3AbstentionReport,
	atlasV3BankIsUnusable,
	buildAtlasV3AbstentionReport,
} from "./abstain";
import {
	type AtlasV3CalculationRunner,
	atlasV3AnswerTableEvidenceIds,
	buildAtlasV3Answer,
} from "./answer-table";
import {
	ATLAS_V3_ASK_SYSTEM,
	buildAtlasV3AskPrompt,
	deterministicAtlasV3Title,
	fallbackAtlasV3Ask,
	parseAtlasV3Ask,
} from "./ask";
import {
	ATLAS_V3_LOCAL_MAX_CHARS_PER_DOCUMENT,
	ATLAS_V3_MAX_LOCAL_SOURCES,
	ATLAS_V3_MAX_OUTPUT_TOKENS,
	type AtlasV3ProfileConfig,
	atlasV3BodyWordBudget,
	atlasV3SectionBudget,
	getAtlasV3CriticRounds,
	getAtlasV3HungarianStandardEnabled,
	getAtlasV3ProfileConfig,
	getAtlasV3ResearcherConcurrency,
	getAtlasV3StaleMonths,
} from "./config";
import {
	applyAtlasV3Cuts,
	atlasV3EvidenceQueries,
	atlasV3RewriteNodeIds,
	runAtlasV3Critic,
} from "./critic";
import {
	ATLAS_V3_LOCAL_PASSAGE_SEPARATOR,
	ATLAS_V3_READ_DOCUMENT_SYSTEM,
	type AtlasV3BankState,
	addAtlasV3LocalSource,
	atlasV3AlsoStatedBy,
	buildAtlasV3LocalReadPrompt,
	capAtlasV3Bank,
	createAtlasV3Bank,
	fileAtlasV3Read,
	freezeAtlasV3Bank,
	parseAtlasV3Read,
	removeAtlasV3SourceWithoutQuotes,
	thawAtlasV3Bank,
} from "./evidence-bank";
import { atlasV3GoalLimitations, runAtlasV3GoalTest } from "./goal";
import { atlasV3NativeSourcesForRequest } from "./language-standard";
import type {
	AtlasV3LocalDocument,
	AtlasV3LocalSources,
	AtlasV3LocalUnavailable,
} from "./local-sources";
import {
	ATLAS_V3_ZERO_USAGE,
	type AtlasV3ModelCall,
	type AtlasV3ModelCalls,
	addAtlasV3Usage,
} from "./model-call";
import {
	atlasV3OutlineGaps,
	reviseAtlasV3Outline,
	trialWriteAtlasV3Nodes,
} from "./outline";
import {
	ATLAS_V3_PHASE_PROGRESS,
	atlasV3ClaimCounts,
	buildAtlasV3ProgressDetails,
	buildAtlasV3ProgressEvidence,
} from "./progress";
import { buildAtlasV3DocumentSource } from "./render";
import type { AtlasV3ResearchWeb } from "./research-web-adapter";
import {
	mapWithConcurrency,
	nextAtlasV3SubQuestions,
	runAtlasV3Round,
} from "./rounds";
import {
	ATLAS_V3_CHECKPOINT_SCHEMA_VERSION,
	type AtlasV3AnswerTable,
	type AtlasV3Ask,
	type AtlasV3EvidenceBank,
	type AtlasV3FindingsNote,
	type AtlasV3Limitation,
	type AtlasV3Memo,
	type AtlasV3Outline,
	type AtlasV3Phase,
	AtlasV3PipelineError,
	type AtlasV3PipelineResult,
	type AtlasV3ProgressEvidence,
	type AtlasV3QualityDiagnostics,
	type AtlasV3Sentence,
	type AtlasV3Usage,
	type AtlasV3VerifiedSection,
	type AtlasV3VerifiedSentence,
	type AtlasV3WrittenSection,
} from "./types";
import {
	atlasV3TableFailureSubject,
	atlasV3WordCount,
	capAtlasV3ToWordBudget,
	pruneAtlasV3AnswerTable,
	verifyAtlasV3AnswerTable,
	verifyAtlasV3Report,
} from "./verify";
import { mergeAtlasV3Memos } from "./workspace";
import {
	atlasV3VerdictAnswersInWindow,
	deterministicAtlasV3Verdict,
	deterministicAtlasV3VerifiedVerdict,
	dropAtlasV3DanglingAnaphora,
	writeAtlasV3Report,
	writeAtlasV3Verdict,
} from "./writer";

/** Checkpoint `roundNumber` per phase, so a resume can find the latest. */
const CHECKPOINT_ROUND = {
	ask: 1,
	research: 10,
	outline: 20,
	answer: 21,
	write: 22,
	critic: 23,
	verify: 24,
	render: 25,
} as const;

export interface RunAtlasV3PipelineInput {
	job: AtlasPipelineJobContext;
	now?: Date;
	dependencies: {
		researchWeb: AtlasV3ResearchWeb;
		/** One model call per task; see config.ts and worker-bindings.ts. */
		models: AtlasV3ModelCalls;
		/** Arithmetic, through the same sandbox `run_python` uses. */
		runPython?: AtlasV3CalculationRunner;
		heartbeat?: (input: {
			stage: string;
			progressPercent: number;
			progressDetails?: unknown;
		}) => Promise<void>;
		writeCheckpoint: (input: {
			jobId: string;
			roundNumber: number;
			stage: string;
			checkpoint: unknown;
			curatedSourcePool: unknown;
			compressedFindings: unknown;
			usage: AtlasV3Usage;
			qualityDiagnostics: unknown;
			documentSourceSummary: unknown;
		}) => Promise<void>;
		loadCheckpoints?: (
			jobId: string,
		) => Promise<Array<{ roundNumber: number; checkpoint: unknown }>>;
		applyGeneratedTitle?: (input: {
			jobId: string;
			title: string;
		}) => Promise<void>;
		renderOutputs: (source: GeneratedDocumentSource) => Promise<AtlasOutputIds>;
		setAssistantMessageContent?: (input: {
			messageId: string;
			content: string;
		}) => Promise<void>;
		researcherConcurrency?: number;
		criticRounds?: number;
		hungarianStandardEnabled?: boolean;
		/** Test and eval overrides for the profile knobs. */
		profileOverrides?: Partial<AtlasV3ProfileConfig>;
		/**
		 * The user's own documents (Atlas Local Sources). Absent means none:
		 * a job with no resolver reads the web only.
		 */
		localSources?: AtlasV3LocalSources;
	};
}

interface ResumeState {
	ask?: AtlasV3Ask;
	bank?: AtlasV3EvidenceBank;
	memo?: AtlasV3Memo;
	completedRounds?: number;
	askedQuestions?: string[];
	outline?: AtlasV3Outline;
	answerTable?: AtlasV3AnswerTable | null;
	sections?: AtlasV3WrittenSection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Rebuilds what earlier phases produced from the durable checkpoints. Anything
 * that does not parse is simply not resumed — the phase runs again, which is
 * always correct and only ever costs time.
 */
export function readAtlasV3ResumeState(
	checkpoints: Array<{ roundNumber: number; checkpoint: unknown }>,
): ResumeState {
	const state: ResumeState = {};
	for (const entry of [...checkpoints].sort(
		(left, right) => left.roundNumber - right.roundNumber,
	)) {
		if (!isRecord(entry.checkpoint)) continue;
		if (entry.checkpoint.schema !== ATLAS_V3_CHECKPOINT_SCHEMA_VERSION)
			continue;
		const data = isRecord(entry.checkpoint.data) ? entry.checkpoint.data : {};
		switch (entry.checkpoint.phase) {
			case "ask":
				if (isRecord(data.ask)) state.ask = data.ask as unknown as AtlasV3Ask;
				break;
			case "research":
				if (isRecord(data.bank)) {
					state.bank = data.bank as unknown as AtlasV3EvidenceBank;
				}
				if (isRecord(data.memo)) {
					state.memo = data.memo as unknown as AtlasV3Memo;
				}
				if (typeof data.round === "number") state.completedRounds = data.round;
				if (Array.isArray(data.asked)) {
					state.askedQuestions = data.asked as string[];
				}
				break;
			case "outline":
				if (isRecord(data.outline)) {
					state.outline = data.outline as unknown as AtlasV3Outline;
				}
				break;
			case "answer":
				state.answerTable = isRecord(data.answerTable)
					? (data.answerTable as unknown as AtlasV3AnswerTable)
					: null;
				break;
			case "write":
				if (Array.isArray(data.sections)) {
					state.sections = data.sections as AtlasV3WrittenSection[];
				}
				break;
			default:
				break;
		}
	}
	return state;
}

function isoDate(now: Date): string {
	return now.toISOString().slice(0, 10);
}

function safeNumber(read: () => number, fallback: number): number {
	try {
		return read();
	} catch {
		return fallback;
	}
}

/** A config flag, defaulting to ON when the config singleton is not up. */
function safeFlag(read: () => boolean): boolean {
	try {
		return read();
	} catch {
		return true;
	}
}

/**
 * The quotes the verdict may cite: the ones the finished sections and the
 * answer table already rest on, capped. Handing the verdict the WHOLE bank
 * would be the biggest prompt in the pipeline and would invite it to cite a
 * source the report never used.
 */
function verdictEvidence(input: {
	bank: AtlasV3EvidenceBank;
	sections: readonly AtlasV3WrittenSection[];
	answerTable: AtlasV3AnswerTable | null;
	limit?: number;
}): Array<{
	id: string;
	text: string;
	publisher: string;
	alsoStatedBy?: string[];
}> {
	const wanted: string[] = [];
	for (const id of [
		...input.sections.flatMap((section) =>
			section.paragraphs.flat().flatMap((sentence) => sentence.evidenceIds),
		),
		...atlasV3AnswerTableEvidenceIds(input.answerTable),
	]) {
		if (!wanted.includes(id)) wanted.push(id);
	}
	return wanted
		.slice(0, input.limit ?? 30)
		.map((id) => input.bank.quotes.find((quote) => quote.id === id))
		.filter((quote): quote is NonNullable<typeof quote> => Boolean(quote))
		.map((quote) => {
			const alsoStatedBy = atlasV3AlsoStatedBy(input.bank, quote.id);
			const source = input.bank.sources.find(
				(entry) => entry.id === quote.sourceId,
			);
			return {
				id: quote.id,
				text: quote.text,
				// `user-documents` / `user_document` for the user's own material, so
				// the verdict attributes it as theirs rather than as published.
				publisher: source?.publisher ?? "",
				tier: source?.tier ?? "press",
				...(alsoStatedBy.length > 0 ? { alsoStatedBy } : {}),
			};
		});
}

// ---------------------------------------------------------------------------
// Atlas Local Sources: the user's own documents
// ---------------------------------------------------------------------------

interface LocalChrome {
	nothingBearing: string;
	overCap: (count: number) => string;
	overCapReason: (titles: string) => string;
	unavailable: Record<AtlasV3LocalUnavailable["reason"], string>;
	priorDocument: string;
	noteLabel: (title: string) => string;
}

const LOCAL_CHROME: Record<SupportedLanguage, LocalChrome> = {
	en: {
		nothingBearing: "contained nothing bearing on the question",
		overCap: (count) =>
			`${count} more document${count === 1 ? "" : "s"} you provided`,
		overCapReason: (titles) =>
			`not read — a report reads at most ${ATLAS_V3_MAX_LOCAL_SOURCES} of your documents: ${titles}`,
		unavailable: {
			not_found: "is no longer available, so it was not read again",
			out_of_scope:
				"now belongs to an incognito conversation, so it was not read",
			no_text: "has no readable text, so it was not read",
		},
		priorDocument: "a document the earlier report read",
		noteLabel: (title) => `User document: ${title}`,
	},
	hu: {
		nothingBearing: "semmi olyat nem tartalmazott, ami a kérdéshez kapcsolódna",
		overCap: (count) => `további ${count} általad megadott dokumentum`,
		overCapReason: (titles) =>
			`nem került elolvasásra — egy jelentés legfeljebb ${ATLAS_V3_MAX_LOCAL_SOURCES} dokumentumodat olvassa el: ${titles}`,
		unavailable: {
			not_found: "már nem érhető el, ezért nem került újra elolvasásra",
			out_of_scope:
				"azóta egy inkognitó beszélgetéshez tartozik, ezért nem került elolvasásra",
			no_text: "nincs olvasható szövege, ezért nem került elolvasásra",
		},
		priorDocument: "egy dokumentum, amelyet a korábbi jelentés olvasott",
		noteLabel: (title) => `Felhasználói dokumentum: ${title}`,
	},
};

/**
 * Reads each of the user's documents ONCE, for all the job's questions: its
 * best passages go to one read call, and what the read quotes is filed into
 * the bank exactly like a web page's quotes — except that a quote must occur
 * verbatim in the passages sent (the local verbatim guard).
 *
 * Sources are minted up front, in document order, so their ids do not depend
 * on which read finishes first. A document that yields no quote is taken back
 * out of the bank: it cannot be cited, and the Limitations line says why.
 */
async function readAtlasV3LocalDocuments(input: {
	documents: readonly AtlasV3LocalDocument[];
	localSources: AtlasV3LocalSources;
	userId: string;
	ask: AtlasV3Ask;
	language: SupportedLanguage;
	currentDate: string;
	/** Stamped on each document's source as its retrieval time. */
	retrievedAt: string;
	state: AtlasV3BankState;
	runModel: AtlasV3ModelCall;
	concurrency: number;
	onUsage: (usage: AtlasV3Usage) => void;
}): Promise<AtlasV3FindingsNote[]> {
	const sources = input.documents.map((document) =>
		addAtlasV3LocalSource(input.state, {
			displayArtifactId: document.displayArtifactId,
			promptArtifactId: document.promptArtifactId,
			title: document.title,
			origin: document.origin,
			retrievedAt: input.retrievedAt,
		}),
	);
	const goals = [
		input.ask.coreQuestion,
		...input.ask.subQuestions.filter(
			(question) => question !== input.ask.coreQuestion,
		),
	];
	const notes = await mapWithConcurrency(
		input.documents,
		Math.max(1, input.concurrency),
		async (document, index): Promise<AtlasV3FindingsNote | null> => {
			const source = sources[index];
			try {
				const passages = await input.localSources.passages({
					userId: input.userId,
					document,
					goals,
					maxChars: ATLAS_V3_LOCAL_MAX_CHARS_PER_DOCUMENT,
				});
				const texts = passages
					.map((passage) => passage.text.replace(/\s+/g, " ").trim())
					.filter(Boolean);
				if (texts.length === 0) return null;
				const call = await input.runModel({
					stage: `v3:read:local:${source.id}`,
					thinkingMode: "off",
					maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.researchNote,
					system: ATLAS_V3_READ_DOCUMENT_SYSTEM[input.language],
					prompt: buildAtlasV3LocalReadPrompt({
						goals,
						language: input.language,
						title: source.title,
						passages: texts,
						currentDate: input.currentDate,
					}),
				});
				input.onUsage(call.usage);
				const read = parseAtlasV3Read(call.text);
				if (!read || read.useless) return null;
				const filed = fileAtlasV3Read({
					state: input.state,
					sourceId: source.id,
					goal: input.ask.coreQuestion,
					read,
					sourceText: texts.join(ATLAS_V3_LOCAL_PASSAGE_SEPARATOR),
				});
				if (filed.quotes.length === 0) return null;
				source.read = true;
				// Deterministic: no note call. The quotes and claims are the note.
				return {
					subQuestion: LOCAL_CHROME[input.language].noteLabel(source.title),
					summary: "",
					quotes: filed.quotes,
					claims: filed.claims,
					openQuestions: [],
					deadEnds: [],
					searches: 0,
					pagesRead: 1,
					error: null,
				};
			} catch (error) {
				console.warn("[ATLAS v3] Local document read failed", {
					sourceId: source.id,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}
		},
	);
	for (const source of sources) {
		removeAtlasV3SourceWithoutQuotes(input.state, source.id);
	}
	return notes.filter((note): note is AtlasV3FindingsNote => note !== null);
}

/**
 * Limitations for the user's documents: the ones over the cap, the inherited
 * ones that could not be read again, and the ones whose read left nothing in
 * the bank. Derived from the FINAL bank, so a resumed job states them too.
 */
function atlasV3LocalLimitations(input: {
	language: SupportedLanguage;
	documents: readonly AtlasV3LocalDocument[];
	overCap: readonly AtlasV3LocalDocument[];
	unavailable: readonly AtlasV3LocalUnavailable[];
	bank: AtlasV3EvidenceBank;
}): AtlasV3Limitation[] {
	const chrome = LOCAL_CHROME[input.language];
	const limitations: AtlasV3Limitation[] = [];
	// One line per KIND of problem, naming every document it applies to: the
	// render keeps only the first eight lines, and twelve unread documents must
	// not push everything else — or each other — off the list.
	const line = (titles: string[], reason: string) => {
		if (titles.length === 0) return;
		limitations.push({ subject: titles.join(", ").slice(0, 400), reason });
	};
	if (input.overCap.length > 0) {
		limitations.push({
			subject: chrome.overCap(input.overCap.length),
			reason: chrome.overCapReason(
				input.overCap.map((document) => document.title).join(", "),
			),
		});
	}
	for (const reason of ["not_found", "out_of_scope", "no_text"] as const) {
		line(
			input.unavailable
				.filter((entry) => entry.reason === reason)
				.map((entry) => entry.title ?? chrome.priorDocument),
			chrome.unavailable[reason],
		);
	}
	const inBank = new Set(
		input.bank.sources.flatMap((source) =>
			source.kind === "local" ? [source.displayArtifactId] : [],
		),
	);
	line(
		input.documents
			.filter((document) => !inBank.has(document.displayArtifactId))
			.map((document) => document.title),
		chrome.nothingBearing,
	);
	return limitations;
}

export async function runAtlasV3Pipeline(
	input: RunAtlasV3PipelineInput,
): Promise<AtlasV3PipelineResult> {
	const now = input.now ?? new Date();
	const { job, dependencies: deps } = input;
	const language = detectLanguage(job.query);
	const config = getAtlasV3ProfileConfig(job.profile, deps.profileOverrides);
	const staleMonths = getAtlasV3StaleMonths();
	const concurrency =
		deps.researcherConcurrency ??
		safeNumber(getAtlasV3ResearcherConcurrency, 3);
	const criticRounds =
		deps.criticRounds ?? safeNumber(getAtlasV3CriticRounds, 2);
	const hungarianStandardEnabled =
		deps.hungarianStandardEnabled ??
		safeFlag(getAtlasV3HungarianStandardEnabled);
	const nativeSources = atlasV3NativeSourcesForRequest({
		query: job.query,
		language,
	});
	const preferredSources = nativeSources.flatMap((set) => [
		...set.preferredNames,
	]);

	let usage = ATLAS_V3_ZERO_USAGE;
	const onUsage = (next: AtlasV3Usage) => {
		usage = addAtlasV3Usage(usage, next);
	};
	const phaseDurationsMs: Record<string, number> = {};
	const timePhase = async <T>(
		name: string,
		run: () => Promise<T>,
	): Promise<T> => {
		const startedAt = Date.now();
		try {
			return await run();
		} finally {
			phaseDurationsMs[name] =
				(phaseDurationsMs[name] ?? 0) + (Date.now() - startedAt);
		}
	};

	const resume = deps.loadCheckpoints
		? readAtlasV3ResumeState(await deps.loadCheckpoints(job.id))
		: {};

	let sourcesRead = 0;
	let sectionCounts: { written: number; planned: number } | null = null;
	let diagnostics: AtlasV3QualityDiagnostics | null = null;
	let outline: AtlasV3Outline | null = resume.outline ?? null;
	let subQuestionsInFlight: string[] = [];
	const runningQuestions = new Set<string>();
	const doneQuestions = new Set<string>();
	let roundState = { current: 1, total: config.rounds };

	const heartbeat = async (
		phase: AtlasV3Phase,
		extra?: { evidence?: AtlasV3ProgressEvidence },
	): Promise<void> => {
		await deps.heartbeat?.({
			stage: phase,
			progressPercent: ATLAS_V3_PHASE_PROGRESS[phase],
			progressDetails: buildAtlasV3ProgressDetails({
				phase,
				language,
				outline,
				subQuestions: subQuestionsInFlight,
				runningQuestions: [...runningQuestions],
				doneQuestions: [...doneQuestions],
				round: roundState,
				sourcesRead,
				phaseDurationsMs,
				...(extra?.evidence ? { evidence: extra.evidence } : {}),
				...(sectionCounts ? { sections: sectionCounts } : {}),
				...(diagnostics ? { qualityDiagnostics: diagnostics } : {}),
			}),
		});
	};

	const checkpoint = async (
		phase: AtlasV3Phase,
		roundNumber: number,
		data: unknown,
		extras?: {
			curatedSourcePool?: unknown;
			compressedFindings?: unknown;
			documentSourceSummary?: unknown;
			qualityDiagnostics?: unknown;
		},
	): Promise<void> => {
		await deps.writeCheckpoint({
			jobId: job.id,
			roundNumber,
			stage: phase,
			checkpoint: {
				schema: ATLAS_V3_CHECKPOINT_SCHEMA_VERSION,
				phase,
				data,
			},
			curatedSourcePool: extras?.curatedSourcePool ?? [],
			compressedFindings: extras?.compressedFindings ?? {},
			usage,
			qualityDiagnostics: extras?.qualityDiagnostics ?? {},
			documentSourceSummary: extras?.documentSourceSummary ?? {},
		});
	};

	// -- 0. The user's own documents ----------------------------------------
	//
	// Resolved at worker time, through the knowledge boundary, under the job
	// conversation's strict incognito scope. An EXPLICIT source (attached to, or
	// linked into, the kickoff message) that cannot be read fails the job: the
	// user asked for a report on it, and a report without it would answer a
	// different question (ADR 0036 edge case 5). An inherited one degrades.
	const resolvedLocal = deps.localSources
		? await deps.localSources.resolve({
				userId: job.userId,
				conversationId: job.conversationId,
				kickoffUserMessageId: job.kickoffUserMessageId,
			})
		: { documents: [], unavailable: [] };
	const explicitUnavailable = resolvedLocal.unavailable.filter(
		(entry) => entry.origin !== "inherited",
	);
	if (explicitUnavailable.length > 0) {
		throw new AtlasV3PipelineError(
			"atlas_v3_local_source_unavailable",
			`Atlas could not read ${explicitUnavailable
				.map(
					(entry) =>
						`${entry.title ? `"${entry.title}"` : "a document you provided"} (${entry.reason.replace(/_/g, " ")})`,
				)
				.join(", ")}; the report was not started without it.`,
		);
	}
	const localDocuments = resolvedLocal.documents.slice(
		0,
		ATLAS_V3_MAX_LOCAL_SOURCES,
	);
	const localOverCap = resolvedLocal.documents.slice(
		ATLAS_V3_MAX_LOCAL_SOURCES,
	);
	const localUnavailable = resolvedLocal.unavailable;

	// -- 1. Understand the ask ----------------------------------------------
	await heartbeat("ask");
	let ask = resume.ask ?? null;
	if (!ask) {
		ask = await timePhase("ask", async () => {
			try {
				const call = await deps.models.ask({
					stage: "v3:ask",
					thinkingMode: "off",
					maxOutputTokens: ATLAS_V3_MAX_OUTPUT_TOKENS.ask,
					system: ATLAS_V3_ASK_SYSTEM[language],
					prompt: buildAtlasV3AskPrompt({
						query: job.query,
						profile: job.profile,
						language,
						currentDate: isoDate(now),
						instruction: job.action === "create" ? null : job.query,
						preferredSources,
						localSources: localDocuments.map((document) => ({
							title: document.title,
							origin: document.origin,
							summary: document.summary,
						})),
					}),
				});
				onUsage(call.usage);
				return (
					parseAtlasV3Ask(call.text, { query: job.query, language }) ??
					fallbackAtlasV3Ask({ query: job.query, language })
				);
			} catch {
				return fallbackAtlasV3Ask({ query: job.query, language });
			}
		});
		await checkpoint("ask", CHECKPOINT_ROUND.ask, { ask });
	}
	const resolvedAsk: AtlasV3Ask = ask;

	// -- 2/3/4. Research rounds, living outline, goal test -------------------
	const state: AtlasV3BankState = resume.bank
		? thawAtlasV3Bank(resume.bank)
		: createAtlasV3Bank();
	let memo: AtlasV3Memo | null = resume.memo ?? null;
	const asked: string[] = [...(resume.askedQuestions ?? [])];
	let roundsRun = resume.completedRounds ?? 0;
	let goal = null as ReturnType<typeof runAtlasV3GoalTest> | null;

	const researchRound = async (
		round: number,
		subQuestions: string[],
		previousMemo: AtlasV3Memo | null,
		localNotes: readonly AtlasV3FindingsNote[] = [],
	) => {
		subQuestionsInFlight = subQuestions;
		runningQuestions.clear();
		for (const question of subQuestions) runningQuestions.add(question);
		roundState = { current: round, total: config.rounds };
		await heartbeat("research");
		return timePhase("research", () =>
			runAtlasV3Round({
				round,
				roundsTotal: config.rounds,
				subQuestions,
				coreQuestion: resolvedAsk.coreQuestion,
				decision: resolvedAsk.decision,
				language,
				currentDate: isoDate(now),
				state,
				researchWeb: deps.researchWeb,
				runResearcherModel: deps.models.researcher,
				runMemoModel: deps.models.outline,
				searchesPerStep: config.searchesPerStep,
				pagesPerQuestion: config.pagesPerQuestion,
				concurrency,
				previousMemo,
				nativeSources,
				preferredSources,
				alreadyTried: asked,
				localNotes,
				retrievedAt: now.toISOString(),
				onUsage,
				onQuestionDone: ({ subQuestion }) => {
					runningQuestions.delete(subQuestion);
					doneQuestions.add(subQuestion);
				},
				onPageRead: () => {
					sourcesRead += 1;
				},
			}),
		);
	};

	if (roundsRun === 0) {
		// The user's documents are read before round one, so the first memo
		// already knows what the user supplied. Once, not per pass and not per
		// round: the gap and critic rounds research the web.
		let localNotes: AtlasV3FindingsNote[] = [];
		if (deps.localSources && localDocuments.length > 0) {
			await heartbeat("research");
			const localSources = deps.localSources;
			localNotes = await timePhase("local", () =>
				readAtlasV3LocalDocuments({
					documents: localDocuments,
					localSources,
					userId: job.userId,
					ask: resolvedAsk,
					language,
					currentDate: isoDate(now),
					retrievedAt: now.toISOString(),
					state,
					runModel: deps.models.researcher,
					concurrency,
					onUsage,
				}),
			);
		}
		// Exhaustive runs INDEPENDENT passes over the same bank and merges their
		// memos before anything is outlined. Cheapest quality lever we have that
		// needs no training; gated by profile because it multiplies the cost.
		const passes: AtlasV3Memo[] = [];
		for (let pass = 0; pass < config.researchPasses; pass += 1) {
			const questions = resolvedAsk.subQuestions.slice(
				0,
				config.subQuestionsPerRound,
			);
			const result = await researchRound(1, questions, null, localNotes);
			asked.push(...result.queries);
			passes.push(result.memo);
		}
		memo = mergeAtlasV3Memos(passes);
		roundsRun = 1;
		await checkpoint("research", CHECKPOINT_ROUND.research + 1, {
			round: roundsRun,
			bank: freezeAtlasV3Bank(state),
			memo,
			asked,
		});
	}

	for (;;) {
		const currentMemo: AtlasV3Memo = memo ?? {
			answerSoFar: "",
			claimIds: [],
			openQuestions: resolvedAsk.subQuestions,
			deadEnds: [],
			budgetUsed: { searches: 0, pagesRead: 0, rounds: roundsRun },
		};
		await heartbeat("outline");
		outline = await timePhase("outline", () =>
			reviseAtlasV3Outline({
				ask: resolvedAsk,
				memo: currentMemo,
				bank: freezeAtlasV3Bank(state),
				language,
				currentDate: isoDate(now),
				round: roundsRun,
				minSections: config.minSections,
				maxSections: config.maxSections,
				minEvidencePerNode: config.minEvidencePerNode,
				previous: outline,
				runModel: deps.models.outline,
				onUsage,
			}),
		);
		goal = runAtlasV3GoalTest({
			memo: currentMemo,
			outline,
			bank: freezeAtlasV3Bank(state),
			config,
			roundsRun,
		});
		if (goal.passed || goal.exhausted) break;
		const next = nextAtlasV3SubQuestions({
			gaps: [...goal.gaps, ...atlasV3OutlineGaps(outline)],
			memo: currentMemo,
			asked,
			limit: config.subQuestionsPerRound,
		});
		if (next.length === 0) break;
		roundsRun += 1;
		const result = await researchRound(roundsRun, next, currentMemo);
		asked.push(...result.queries);
		memo = result.memo;
		await checkpoint("research", CHECKPOINT_ROUND.research + roundsRun, {
			round: roundsRun,
			bank: freezeAtlasV3Bank(state),
			memo,
			asked,
		});
	}

	const resolvedMemo: AtlasV3Memo = memo ?? {
		answerSoFar: "",
		claimIds: [],
		openQuestions: [],
		deadEnds: [],
		budgetUsed: { searches: 0, pagesRead: sourcesRead, rounds: roundsRun },
	};
	const resolvedGoal =
		goal ??
		runAtlasV3GoalTest({
			memo: resolvedMemo,
			outline: outline ?? { nodes: [], cut: [] },
			bank: freezeAtlasV3Bank(state),
			config,
			roundsRun,
		});

	// A thin node that never filled is trial-written once; what cannot carry a
	// lead is cut with its reason rather than shipped as a section that admits
	// it found nothing.
	if (outline) {
		outline = await timePhase("outline", () =>
			trialWriteAtlasV3Nodes({
				outline: outline as AtlasV3Outline,
				bank: freezeAtlasV3Bank(state),
				language,
				runModel: deps.models.outline,
				onUsage,
			}),
		);
	}
	const capped = capAtlasV3Bank({ state, maxSources: config.maxSources });
	if (capped.dropped > 0) {
		console.info("[ATLAS v3] Capped the evidence bank to the source budget", {
			jobId: job.id,
			profile: job.profile,
			kept: state.sources.length,
			dropped: capped.dropped,
		});
	}
	const bank = freezeAtlasV3Bank(state);
	// Capping the bank can take a quote an outline node was bound to with it. A
	// node still naming a dropped quote would reach the writer with fewer ids
	// than it thinks it has — or none, and be reported as a lost section — so the
	// binding is re-filtered against what the bank actually still holds.
	const liveQuoteIds = new Set(bank.quotes.map((quote) => quote.id));
	const resolvedOutline: AtlasV3Outline = outline
		? {
				...outline,
				nodes: outline.nodes.map((node) => ({
					...node,
					evidenceIds: node.evidenceIds.filter((id) => liveQuoteIds.has(id)),
				})),
			}
		: { nodes: [], cut: [] };
	// Zero SOURCES is the only state that has nothing to report — not even what
	// was searched. Anything above that abstains instead of failing (ADR 0063's
	// abstention outcome), which is why the check is on sources and not quotes.
	if (bank.sources.length === 0) {
		throw new AtlasV3PipelineError(
			"atlas_v3_no_evidence",
			"Atlas found no usable evidence: every page it read was a listing, a stub or a duplicate.",
		);
	}
	const bankUsable = !atlasV3BankIsUnusable(bank);
	await checkpoint("outline", CHECKPOINT_ROUND.outline, {
		outline: resolvedOutline,
	});

	// -- 5. Answer table -----------------------------------------------------
	await heartbeat("answer");
	const answerTable = !bankUsable
		? null
		: resume.answerTable !== undefined
			? resume.answerTable
			: await timePhase("answer", () =>
					buildAtlasV3Answer({
						ask: resolvedAsk,
						memo: resolvedMemo,
						bank,
						language,
						currentDate: isoDate(now),
						runModel: deps.models.writer,
						runPython: deps.runPython,
						onUsage,
					}),
				);
	await checkpoint("answer", CHECKPOINT_ROUND.answer, { answerTable });

	// -- 6. Write ------------------------------------------------------------
	await heartbeat("write");
	const budget = atlasV3SectionBudget({
		config,
		sectionCount: resolvedOutline.nodes.filter((node) => node.status !== "cut")
			.length,
	});
	const written: Awaited<ReturnType<typeof writeAtlasV3Report>> = !bankUsable
		? {
				sections: [],
				runaways: { length: 0, salvaged: 0, retried: 0, fallback: 0 },
				dropped: [],
			}
		: resume.sections !== undefined
			? {
					sections: resume.sections,
					runaways: { length: 0, salvaged: 0, retried: 0, fallback: 0 },
					dropped: [],
				}
			: await timePhase("write", () =>
					writeAtlasV3Report({
						ask: resolvedAsk,
						outline: resolvedOutline,
						answerTable,
						bank,
						language,
						currentDate: isoDate(now),
						budget,
						maxEvidencePerSection: config.maxEvidencePerSection,
						hungarianStandardEnabled,
						runModel: deps.models.writer,
						onUsage,
					}),
				);
	sectionCounts = {
		written: written.sections.length,
		planned: resolvedOutline.nodes.filter((node) => node.status !== "cut")
			.length,
	};
	if (written.dropped.length > 0) {
		console.error("[ATLAS v3] Wrote fewer sections than the outline promised", {
			jobId: job.id,
			profile: job.profile,
			...sectionCounts,
			dropped: written.dropped,
		});
	}
	// Research that produced nothing writable ABSTAINS; it does not fail. What
	// was searched, and the sources reached, are the report.
	const abstention: AtlasV3AbstentionReport | null =
		written.sections.length === 0
			? buildAtlasV3AbstentionReport({
					coreQuestion: resolvedAsk.coreQuestion || job.query,
					subQuestions:
						resolvedAsk.subQuestions.length > 0
							? resolvedAsk.subQuestions
							: asked,
					bank,
					language,
					searches: resolvedMemo.budgetUsed.searches,
					pagesRead: sourcesRead,
				})
			: null;
	if (abstention) {
		console.warn("[ATLAS v3] Abstaining: no section could be written", {
			jobId: job.id,
			profile: job.profile,
			sources: bank.sources.length,
			quotes: bank.quotes.length,
			claims: bank.claims.length,
		});
	}
	await checkpoint("write", CHECKPOINT_ROUND.write, {
		sections: written.sections,
	});

	// -- 7. Verdict ----------------------------------------------------------
	// The user's documents come first: the render keeps only the first eight
	// Limitations lines, and a document the user chose that went unread must
	// never be the line that silently falls off.
	const limitations: AtlasV3Limitation[] = [
		...atlasV3LocalLimitations({
			language,
			documents: localDocuments,
			overCap: localOverCap,
			unavailable: localUnavailable,
			bank,
		}),
		...atlasV3GoalLimitations({
			verdict: resolvedGoal,
			outline: resolvedOutline,
			memo: resolvedMemo,
			bank,
			language,
		}),
	];
	let sections = written.sections;
	let verdictFallback = false;
	let verdict: AtlasV3Sentence[] = [];
	if (!abstention) {
		const firstVerdict = await timePhase("verdict", () =>
			writeAtlasV3Verdict({
				ask: resolvedAsk,
				memo: resolvedMemo,
				answerTable,
				sections,
				evidence: verdictEvidence({ bank, sections, answerTable }),
				language,
				currentDate: isoDate(now),
				abstain: resolvedGoal.abstain,
				limitations,
				bank,
				jobId: job.id,
				runModel: deps.models.writer,
				onUsage,
			}),
		);
		// v2 lost its executive summary in 13 of 13 runs because an empty summary
		// was simply an empty block. Losing it is still not acceptable — but a
		// verdict assembled from the sections the report already carries beats
		// throwing away five finished stages of work.
		if (firstVerdict && firstVerdict.length > 0) {
			verdict = firstVerdict;
		} else {
			verdict = deterministicAtlasV3Verdict({
				sections,
				language,
				abstain: resolvedGoal.abstain,
			});
			verdictFallback = verdict.length > 0;
		}
		if (verdict.length === 0) {
			throw new AtlasV3PipelineError(
				"atlas_v3_no_verdict",
				"Atlas produced a report with no verdict; a report that does not open with its answer is not shipped.",
			);
		}
	}

	// -- 8. Critic rounds ----------------------------------------------------
	let criticRoundsRun = 0;
	let criticFindingCount = 0;
	let needsEvidenceResolved = 0;
	for (let round = 1; round <= criticRounds && !abstention; round += 1) {
		await heartbeat("critic");
		const verdictAnswers = atlasV3VerdictAnswersInWindow({ verdict });
		const findings = await timePhase("critic", () =>
			runAtlasV3Critic({
				ask: resolvedAsk,
				sections,
				verdict,
				answerTable,
				bank: freezeAtlasV3Bank(state),
				language,
				currentDate: isoDate(now),
				round,
				alreadyFound: [],
				verdictAnswers,
				hungarianStandardEnabled,
				runModel: deps.models.critic,
				onUsage,
			}),
		);
		if (findings.length === 0) break;
		criticRoundsRun = round;
		criticFindingCount += findings.length;

		// `needs_evidence` spends a SMALL targeted research budget and re-enters,
		// which is the loop v2 never had: its verifier could only delete.
		//
		// The quotes it finds are bound to the NODE whose finding asked for them,
		// so the rewrite below actually has them: fetching better evidence and
		// then not handing it to the writer would be the same delete-only loop
		// with extra steps.
		const queries = atlasV3EvidenceQueries(findings);
		const freshEvidenceByNode = new Map<string, string[]>();
		if (queries.length > 0) {
			const nodeByQuery = new Map<string, string>();
			for (const finding of findings) {
				const query = finding.instruction.query?.trim();
				if (
					finding.instruction.kind !== "needs_evidence" ||
					!query ||
					!finding.nodeId
				) {
					continue;
				}
				if (!nodeByQuery.has(query)) nodeByQuery.set(query, finding.nodeId);
			}
			const before = state.quotes.length;
			roundsRun += 1;
			const result = await researchRound(roundsRun, queries, resolvedMemo);
			asked.push(...result.queries);
			needsEvidenceResolved += state.quotes.length - before;
			// The critic's round is a research round: without its own checkpoint the
			// quotes it fetched are invisible to a post-mortem, and a resume would
			// pay for them twice. The memo stays the pipeline's own — the critic's
			// research answers a finding, it does not rewrite the answer so far.
			await checkpoint("research", CHECKPOINT_ROUND.research + roundsRun, {
				round: roundsRun,
				bank: freezeAtlasV3Bank(state),
				memo: resolvedMemo,
				asked,
			});
			for (const note of result.notes) {
				const nodeId = nodeByQuery.get(note.subQuestion);
				if (!nodeId || note.quotes.length === 0) continue;
				freshEvidenceByNode.set(nodeId, [
					...(freshEvidenceByNode.get(nodeId) ?? []),
					...note.quotes.map((quote) => quote.id),
				]);
			}
		}

		const cuts = applyAtlasV3Cuts({ sections, findings });
		sections = cuts.sections;

		// A rewrite is the writer running again over the same nodes, now with the
		// findings in the outline's `needs` so the instruction reaches the prompt,
		// and with whatever the targeted research just found bound to the node.
		const rewriteIds = [
			...new Set([
				...atlasV3RewriteNodeIds(findings),
				...freshEvidenceByNode.keys(),
			]),
		];
		if (rewriteIds.length > 0) {
			const instructions = new Map<string, string[]>();
			for (const finding of findings) {
				if (!finding.nodeId) continue;
				if (
					finding.instruction.kind !== "rewrite" &&
					finding.instruction.kind !== "needs_evidence"
				) {
					continue;
				}
				instructions.set(finding.nodeId, [
					...(instructions.get(finding.nodeId) ?? []),
					finding.detail,
				]);
			}
			const rewriteOutline: AtlasV3Outline = {
				nodes: resolvedOutline.nodes
					.filter((node) => rewriteIds.includes(node.id))
					.map((node) => ({
						...node,
						needs: [...node.needs, ...(instructions.get(node.id) ?? [])],
						evidenceIds: [
							...new Set([
								...node.evidenceIds,
								...(freshEvidenceByNode.get(node.id) ?? []),
							]),
						],
					})),
				cut: resolvedOutline.cut,
			};
			const rewritten = await timePhase("write", () =>
				writeAtlasV3Report({
					ask: resolvedAsk,
					outline: rewriteOutline,
					answerTable,
					bank: freezeAtlasV3Bank(state),
					language,
					currentDate: isoDate(now),
					budget,
					maxEvidencePerSection: config.maxEvidencePerSection,
					hungarianStandardEnabled,
					runModel: deps.models.writer,
					onUsage,
				}),
			);
			const replacements = new Map(
				rewritten.sections.map((section) => [section.nodeId, section]),
			);
			sections = sections.map((section) => {
				const replacement = replacements.get(section.nodeId);
				// Only take a rewrite that is at least as substantial as what it
				// replaces: a rewrite that lost the section is worse than the defect.
				return replacement &&
					replacement.paragraphs.flat().length >=
						section.paragraphs.flat().length
					? { ...replacement, table: section.table }
					: section;
			});
		}

		// The verdict is rewritten when the critic said it did not answer.
		if (findings.some((finding) => finding.code === "no_verdict")) {
			const retry = await timePhase("verdict", () =>
				writeAtlasV3Verdict({
					ask: resolvedAsk,
					memo: resolvedMemo,
					answerTable,
					sections,
					evidence: verdictEvidence({
						bank: freezeAtlasV3Bank(state),
						sections,
						answerTable,
					}),
					language,
					currentDate: isoDate(now),
					abstain: resolvedGoal.abstain,
					limitations,
					bank: freezeAtlasV3Bank(state),
					jobId: job.id,
					runModel: deps.models.writer,
					onUsage,
				}),
			);
			// Only take a retry that is actually better.
			if (retry && atlasV3VerdictAnswersInWindow({ verdict: retry })) {
				verdict = retry;
				verdictFallback = false;
			}
		}
	}
	await checkpoint("critic", CHECKPOINT_ROUND.critic, {
		rounds: criticRoundsRun,
		findings: criticFindingCount,
	});

	// -- 9. Verify -----------------------------------------------------------
	await heartbeat("verify");
	const finalBank = freezeAtlasV3Bank(state);
	const localSourceIds = new Set(
		finalBank.sources
			.filter((source) => source.kind === "local")
			.map((source) => source.id),
	);
	const verification = abstention
		? {
				sections: abstention.sections,
				totals: abstention.totals,
				citedEvidenceIds: [],
				needsEvidence: [],
				staleSourceIds: [],
			}
		: await timePhase("verify", async () =>
				verifyAtlasV3Report({
					sections,
					bank: finalBank,
					answerTable,
					staleMonths,
					now,
					finalPass: true,
				}),
			);

	/** One verification pass over the verdict alone, as its own section. */
	const verifyVerdict = (
		candidate: readonly AtlasV3Sentence[],
	): AtlasV3VerifiedSentence[] =>
		verifyAtlasV3Report({
			sections: [
				{
					nodeId: "verdict",
					title: "verdict",
					paragraphs: [[...candidate]],
					table: null,
				},
			],
			bank: finalBank,
			answerTable,
			staleMonths,
			now,
			finalPass: true,
			// The verdict is six sentences, not a section: the restatement and
			// inference caps would trim an abstaining opener, and the caller reads
			// a cut sentence as one whose FIGURE could not be supported.
			qualityCaps: false,
		}).sections[0]?.paragraphs.flat() ?? [];

	let verifiedVerdict: AtlasV3VerifiedSentence[] = abstention
		? abstention.verdict
		: verifyVerdict(verdict);
	if (!abstention) {
		// A verdict that lost a sentence is not a shorter verdict: it is a verdict
		// whose remaining sentences may now refer to a figure nobody stated. One
		// shipped report opened "These core duties include technical
		// documentation…" for exactly this reason. Regenerate once, naming what may
		// not be stated; then drop whatever still dangles.
		const cut = verdict.filter(
			(sentence) =>
				!verifiedVerdict.some((kept) => kept.text === sentence.text),
		);
		if (cut.length > 0) {
			const rewritten = await timePhase("verdict", () =>
				writeAtlasV3Verdict({
					ask: resolvedAsk,
					memo: resolvedMemo,
					answerTable,
					sections,
					evidence: verdictEvidence({ bank: finalBank, sections, answerTable }),
					language,
					currentDate: isoDate(now),
					abstain: resolvedGoal.abstain,
					limitations,
					doNotState: cut.map((sentence) => sentence.text),
					bank: finalBank,
					jobId: job.id,
					runModel: deps.models.writer,
					onUsage,
				}),
			);
			if (rewritten && rewritten.length > 0) {
				const reverified = verifyVerdict(rewritten);
				if (reverified.length > 0) {
					verdict = rewritten;
					verifiedVerdict = reverified;
					verdictFallback = false;
				}
			}
			verifiedVerdict = dropAtlasV3DanglingAnaphora({
				written: verdict,
				kept: verifiedVerdict,
				language,
			});
		}
		if (verifiedVerdict.length === 0) {
			verifiedVerdict = deterministicAtlasV3VerifiedVerdict({
				sections: verification.sections,
				language,
				abstain: resolvedGoal.abstain,
			});
			verdictFallback = verifiedVerdict.length > 0;
		}
		if (verifiedVerdict.length === 0) {
			throw new AtlasV3PipelineError(
				"atlas_v3_no_verdict",
				"Atlas's verdict did not survive verification; a report that does not open with its answer is not shipped.",
			);
		}
	}
	const tableFailures = verifyAtlasV3AnswerTable({
		table: answerTable,
		bank: finalBank,
	});
	const verifiedTable = pruneAtlasV3AnswerTable({
		table: answerTable,
		failures: tableFailures,
		placeholder: language === "hu" ? "nincs közzétéve" : "not published",
	});
	const bodyCap = abstention
		? { sections: abstention.sections, droppedSentenceCount: 0 }
		: capAtlasV3ToWordBudget({
				// The section that owns the table now carries the PRUNED table: a cell
				// no quote supports says "not published" rather than stating a figure.
				sections: verification.sections.map((section) => ({
					...section,
					table: section.table ? verifiedTable : null,
				})),
				maxWords: atlasV3BodyWordBudget(config),
			});
	const verifiedSections: AtlasV3VerifiedSection[] = bodyCap.sections;
	if (verifiedSections.length === 0) {
		throw new AtlasV3PipelineError(
			"atlas_v3_no_sections",
			"Atlas's sections did not survive verification.",
		);
	}
	for (const failure of tableFailures) {
		// A cell that already said "not published" owes the reader nothing: the
		// prune keeps the admission and drops the figures after it.
		if (failure.kind !== "unsupported") continue;
		limitations.push({
			subject: atlasV3TableFailureSubject(failure),
			reason: failure.detail,
		});
	}
	for (const entry of verification.needsEvidence) {
		limitations.push({
			subject: entry.text.slice(0, 160),
			reason:
				language === "hu"
					? "egyetlen idézet sem támasztotta alá a benne szereplő számot"
					: "no quote the report holds states the figure in it",
		});
	}
	if (verdictFallback) {
		limitations.push({
			subject:
				language === "hu" ? "a jelentés nyitása" : "the report's opening",
			reason:
				language === "hu"
					? "a szakaszok saját mondataiból állt össze, mert az ítélet nem készült el"
					: "it was assembled from the sections because the verdict could not be written",
		});
	}

	// The document is built BEFORE the evidence card, because the card's source
	// numbers must be the numbers the report actually printed: the evaluation
	// cross-checks every `[n]` in the prose against this card, and two
	// independent orderings would make every citation look like a mismatch.
	const title =
		resolvedAsk.title.trim() || deterministicAtlasV3Title(job.query);
	const abstained = resolvedGoal.abstain || abstention !== null;
	const rendered = buildAtlasV3DocumentSource({
		title,
		language,
		date: isoDate(now),
		bank: finalBank,
		verdict: verifiedVerdict,
		sections: verifiedSections,
		limitations,
		abstained,
		extraSourceIds: abstention?.extraSourceIds ?? [],
	});
	const claimCounts = atlasV3ClaimCounts(finalBank);
	const evidence = buildAtlasV3ProgressEvidence({
		bank: finalBank,
		totals: verification.totals,
		citations: rendered.citations,
	});
	diagnostics = {
		abstained,
		verdictPresent: verifiedVerdict.length > 0,
		verdictFallback,
		repeatedSentences: verification.totals.repeated,
		claimCount: claimCounts.total,
		verifiedClaimCount: claimCounts.verified,
		contestedClaimCount: claimCounts.contested,
		claimsMerged: state.claimsMerged,
		answerTableCells: verifiedTable
			? verifiedTable.rows.length * verifiedTable.columns.length
			: 0,
		derivedFigures: (verifiedTable?.derived ?? []).filter(
			(entry) => entry.value !== null,
		).length,
		criticRounds: criticRoundsRun,
		criticFindings: criticFindingCount,
		needsEvidenceResolved,
		roundsRun,
		searches: resolvedMemo.budgetUsed.searches,
		pagesRead: sourcesRead,
		sectionsPlanned: sectionCounts.planned,
		sectionsWritten: verifiedSections.length,
		sectionsSupplemented: resolvedOutline.supplemented ?? 0,
		wordCount: atlasV3WordCount(verifiedSections, verifiedVerdict),
		writerRunaways: { ...written.runaways },
		...(localDocuments.length + localOverCap.length + localUnavailable.length >
		0
			? {
					localSources: {
						resolved: localDocuments.length,
						read: localSourceIds.size,
						quotes: finalBank.quotes.filter((quote) =>
							localSourceIds.has(quote.sourceId),
						).length,
						unavailable: localUnavailable.length,
					},
				}
			: {}),
	};
	await heartbeat("verify", { evidence });
	await checkpoint("verify", CHECKPOINT_ROUND.verify, {
		totals: verification.totals,
		staleSourceIds: verification.staleSourceIds,
	});

	// -- 10. Render ----------------------------------------------------------
	await heartbeat("render", { evidence });
	if (title && title !== job.title) {
		await deps
			.applyGeneratedTitle?.({ jobId: job.id, title })
			.catch((error) => {
				console.warn("[ATLAS v3] Failed to apply the generated title", {
					jobId: job.id,
					error,
				});
			});
	}
	const outputs = await timePhase("render", () =>
		deps.renderOutputs(rendered.documentSource),
	);
	await heartbeat("render", { evidence });

	if (rendered.verdictMarkdown && job.assistantMessageId) {
		await deps
			.setAssistantMessageContent?.({
				messageId: job.assistantMessageId,
				content: rendered.verdictMarkdown,
			})
			.catch((error) => {
				console.warn("[ATLAS v3] Failed to set assistant message content", {
					jobId: job.id,
					error,
				});
			});
	}

	await checkpoint(
		"render",
		CHECKPOINT_ROUND.render,
		{ outputs },
		{
			curatedSourcePool: finalBank.sources.map((source) =>
				source.kind === "local"
					? {
							kind: "local",
							url: null,
							title: source.title,
							host: "",
							date: null,
							tier: source.tier,
							displayArtifactId: source.displayArtifactId,
						}
					: {
							kind: "web",
							url: source.canonicalUrl,
							title: source.title,
							host: source.host,
							date: source.date,
							tier: source.tier,
						},
			),
			compressedFindings: {
				coreQuestion: resolvedAsk.coreQuestion,
				answerSoFar: resolvedMemo.answerSoFar,
				openQuestions: resolvedMemo.openQuestions,
				deadEnds: resolvedMemo.deadEnds,
			},
			documentSourceSummary: {
				atlasFamily: job.lifecycle.family,
				pipelineVersion: 3,
				title,
				sourceCount: rendered.citations.sources.length,
			},
			qualityDiagnostics: {
				...diagnostics,
				goal: resolvedGoal.reason,
				phaseDurationsMs: { ...phaseDurationsMs },
				sentencesDroppedForBudget: bodyCap.droppedSentenceCount,
				sourcesDroppedForBudget: capped.dropped,
			},
		},
	);

	return {
		status: "succeeded",
		stage: "render",
		pipelineVersion: 3,
		title,
		executiveSummaryMarkdown: rendered.verdictMarkdown,
		abstained,
		outputs,
		usage,
		sourceCounts: {
			local: localDocuments.length,
			web: finalBank.sources.length - localSourceIds.size,
			accepted: rendered.citations.sources.length,
			rejected: finalBank.filteredCount,
		},
		diagnostics,
	};
}
