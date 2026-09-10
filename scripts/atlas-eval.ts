#!/usr/bin/env tsx

/**
 * Atlas evaluation harness (ADR 0062).
 *
 * Runs the queries in `scripts/atlas-eval-queries.json` against a LIVE
 * deployment, for one or both pipeline versions, and writes a Markdown
 * comparison table plus per-query notes for the manual false-claim pass.
 *
 * It drives the same HTTP surface a browser does — login, create a
 * conversation, POST /api/chat/send with atlasMode, poll
 * GET /api/conversations/:id until the job ends, download the Markdown —
 * exactly like /root/verify-harness.mjs on the box.
 *
 * Usage:
 *   BASE=https://staging.example EMAIL=... PASSWORD=... \
 *     npx tsx scripts/atlas-eval.ts --pipeline v2 --out /tmp/atlas-eval
 *
 * Options:
 *   --pipeline v1|v2|v3|all Which pipeline to measure (default: v1 and v2).
 *   --queries <ids>         Comma-separated query ids to run (default: all).
 *   --profile <p>           Override every query's profile.
 *   --timeout <minutes>     Per-job timeout (default: 45).
 *   --out <dir>             Where to write the report (default: ./atlas-eval).
 *   --concurrency <n>       Jobs in flight at once (default: 1).
 *   --judge                 Also run the rubric judge (ADR 0063). Each score
 *                           must come back with a verbatim quote from the
 *                           report; a score with no quote is discarded.
 *
 * NOTE on --judge: the judge runs through the deployment's own chat API, which
 * takes no model parameter — it uses the eval account's selected model. Set
 * that account to the model ATLAS_AUDIT_MODEL names before judging, or the
 * scores are not comparable across runs.
 *
 * IMPORTANT: switching pipelines is an ADMIN CONFIG change on the deployment
 * (ATLAS_PIPELINE=v1|v2|v3) and this script does NOT make it. Set the flag, run
 * the script with the matching --pipeline value so the output is labelled
 * correctly, then flip and run again. The script verifies the pipeline each
 * job actually ran on (from the job card's `pipelineVersion`) and refuses to
 * mislabel a run.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types mirroring the HTTP surface (kept local: this script runs standalone)
// ---------------------------------------------------------------------------

/** ADR 0062 added v2; ADR 0063 added v3. */
type EvalPipeline = "v1" | "v2" | "v3";

interface EvalQuery {
	id: string;
	kind: string;
	profile: "overview" | "in-depth" | "exhaustive";
	language: string;
	query: string;
	expectations: string[];
	/**
	 * What "the report answered the question that was asked" looks like for this
	 * query, as a regular expression the executive summary must match. Checked
	 * against the summary first and the whole body second, so a report that
	 * answers the question late still counts as answering it — badly.
	 */
	coreAnswerRegex?: string;
	/** Alternative to the regex: every keyword must appear. */
	coreAnswerKeywords?: string[];
}

/**
 * The word budget per profile. Duplicated from
 * `src/lib/server/services/atlas-v2/budget.ts` ON PURPOSE: this harness checks
 * the server's claim with a second pair of eyes and must not import the
 * server's own constants to do it.
 */
const WORD_BUDGETS: Record<EvalQuery["profile"], { min: number; max: number }> =
	{
		overview: { min: 700, max: 1100 },
		"in-depth": { min: 1800, max: 2800 },
		exhaustive: { min: 3500, max: 5500 },
	};

interface EvidenceSource {
	n: number;
	title: string;
	host: string;
	date: string | null;
	cited: boolean;
	snippet: string;
}

interface AtlasJobCardLike {
	id: string;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	stage?: string | null;
	pipelineVersion?: 1 | 2 | 3;
	progress?: {
		percent: number;
		stage: string;
		details?: {
			pipelineVersion?: number;
			phase?: string;
			sourcesRead?: number;
			/** Per-phase wall time, present from the write phase onwards on v2. */
			phaseDurationsMs?: Record<string, number>;
			/** Sections written against sections planned, v2 from the writer on. */
			sections?: { written: number; planned: number };
			/**
			 * ADR 0063's diagnostics, present on v3 from the verify phase on. The
			 * harness reports them alongside its own measurements rather than
			 * trusting them: the job's claim and the report's text are two
			 * independent views of the same run.
			 */
			qualityDiagnostics?: {
				abstained?: boolean;
				verdictPresent?: boolean;
				claimCount?: number;
				verifiedClaimCount?: number;
				contestedClaimCount?: number;
				answerTableCells?: number;
				derivedFigures?: number;
				criticRounds?: number;
				criticFindings?: number;
				needsEvidenceResolved?: number;
				roundsRun?: number;
				sectionsPlanned?: number;
				sectionsWritten?: number;
				writerRunaways?: {
					length: number;
					salvaged: number;
					retried: number;
					fallback: number;
				};
			};
			/**
			 * Writer calls that ended at their output cap, and the repairs they
			 * cost. A runaway shows up in the wall time as "the model was slow"
			 * and nowhere else, so the job reports it explicitly.
			 */
			writerRunaways?: {
				length: number;
				salvaged: number;
				retried: number;
				fallback: number;
			};
			evidence?: {
				corroborated: number;
				single: number;
				inferred: number;
				cut: number;
				filteredCount: number;
				sources: EvidenceSource[];
			};
		};
	};
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		costUsdMicros: number;
	};
	sourceCounts?: {
		local: number;
		web: number;
		accepted: number;
		rejected: number;
	};
	outputs?: {
		markdownChatGeneratedFileId?: string | null;
		htmlChatGeneratedFileId?: string | null;
		pdfChatGeneratedFileId?: string | null;
	};
	error?: { code: string; message: string } | null;
}

interface QueryResult {
	query: EvalQuery;
	pipeline: EvalPipeline;
	reportedPipelineVersion: number | null;
	status: string;
	error: string | null;
	wallMs: number;
	usage: { inputTokens: number; outputTokens: number; totalTokens: number };
	markdown: string | null;
	metrics: Metrics;
	/** Per-phase wall time the job reported, when it reported any. */
	phaseDurationsMs: Record<string, number> | null;
}

interface Metrics {
	wordCount: number;
	citationCount: number;
	/** Citations per 100 words. */
	citationDensity: number;
	resolvedCitationCount: number;
	/** Share of `[n]` markers whose n exists in the source list. */
	citationResolutionRate: number | null;
	numbersChecked: number;
	numbersMatched: number;
	/** Share of numbers in cited sentences found in the cited source text. */
	numberMatchRate: number | null;
	corroborationRate: number | null;
	corroboratedCount: number;
	singleCount: number;
	inferredCount: number;
	cutCount: number;
	filteredCount: number;
	sourceCount: number;
	citedSourceCount: number;
	junkSourceCount: number;
	junkSourceNotes: string[];
	/** Sentences whose figure the cited snippet did not carry. */
	unmatchedNumberNotes: string[];
	/**
	 * Words against the profile band: "in range (700-1100)", "over by n (…)" or
	 * "under by n (…)".
	 */
	wordBudget: string;
	wordBudgetOk: boolean;
	/** Sentences whose figure set repeats an earlier sentence's. */
	repeatedFactCount: number;
	sectionCount: number;
	/**
	 * Sections the plan asked for, when the job reported it. A report with fewer
	 * headings than the plan promised lost sections in the writer, which is a
	 * defect the word count alone reads as "a bit short".
	 */
	sectionsPlanned: number | null;
	/**
	 * Writer calls that ran to their output cap, and what it took to recover.
	 * Null on v1 and on any job that reported none.
	 */
	writerRunaways: {
		length: number;
		salvaged: number;
		retried: number;
		fallback: number;
	} | null;
	/** Did the report answer the question that was asked? Null when unchecked. */
	coreAnswerPresent: boolean | null;
	/** Disagreement lines in Limitations; the pipeline caps these at 3. */
	contradictionLineCount: number;

	// -- ADR 0063's deterministic quality layer ------------------------------
	//
	// Half of the sixteen-dimension rubric is checkable without a model, and
	// these are the checks judges are worst at. They run on every report, on
	// every pipeline, so v2 and v3 are measured on the same ruler.

	/** Does a conclusion with a figure appear in the first 150 words? */
	verdictInWindow: boolean;
	/** Sentences restating an earlier SECTION's claim, by content-word overlap. */
	crossSectionRepeatCount: number;
	/** Distinct cited claims per 1,000 words. Padding drives this down. */
	claimsPerThousandWords: number;
	/** Volatile figures (shares, rates, counts) carrying an inline date. */
	datedVolatileCount: number;
	volatileFigureCount: number;
	datedVolatileRate: number | null;
	/** A comparison or pricing question must ship a table. */
	tableExpected: boolean;
	tablePresent: boolean;
	/** The job's own ADR 0063 diagnostics, when it reported them. */
	diagnostics:
		| NonNullable<
				NonNullable<AtlasJobCardLike["progress"]>["details"]
		  >["qualityDiagnostics"]
		| null;
	/** Rubric-judge scores, when --judge ran. */
	judge: JudgeResult | null;
}

interface JudgeScore {
	dimension: string;
	score: number;
	justification: string;
	/** Verbatim from the report. A score with no quote is DISCARDED. */
	quote: string;
}

interface JudgeResult {
	scores: JudgeScore[];
	/** Scores the judge returned without a quote it could point at. */
	discarded: number;
	average: number | null;
	error: string | null;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[index + 1];
		if (next && !next.startsWith("--")) {
			args[key] = next;
			index += 1;
		} else {
			args[key] = "true";
		}
	}
	return args;
}

// ---------------------------------------------------------------------------
// HTTP client with a session cookie
// ---------------------------------------------------------------------------

class Session {
	private cookie = "";

	constructor(private readonly base: string) {}

	async login(email: string, password: string): Promise<void> {
		const response = await fetch(`${this.base}/api/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password, rememberMe: true }),
		});
		if (!response.ok) {
			throw new Error(
				`Login failed: ${response.status} ${await response.text()}`,
			);
		}
		const setCookie = response.headers.getSetCookie?.() ?? [];
		const header = response.headers.get("set-cookie");
		const cookies = setCookie.length > 0 ? setCookie : header ? [header] : [];
		this.cookie = cookies
			.map((entry) => entry.split(";")[0])
			.filter(Boolean)
			.join("; ");
		if (!this.cookie) throw new Error("Login returned no session cookie.");
	}

	async json<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetch(`${this.base}${path}`, {
			...init,
			headers: {
				"content-type": "application/json",
				cookie: this.cookie,
				...(init?.headers ?? {}),
			},
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`${init?.method ?? "GET"} ${path} -> ${response.status} ${text.slice(0, 400)}`,
			);
		}
		return text ? (JSON.parse(text) as T) : ({} as T);
	}

	async text(path: string): Promise<string> {
		const response = await fetch(`${this.base}${path}`, {
			headers: { cookie: this.cookie },
		});
		if (!response.ok) {
			throw new Error(`GET ${path} -> ${response.status}`);
		}
		return response.text();
	}
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const CITATION_PATTERN = /\[(\d{1,3})\]/g;
const CONFIDENCE_MARKS = { corroborated: "ᶜ", single: "ˢ", inferred: "ⁱ" };

/**
 * Number extraction and variant matching, kept deliberately simple and
 * INDEPENDENT of the server's implementation: the point of the harness is to
 * check the server's claim with a second pair of eyes, so it must not reuse
 * the same matcher. It covers separators, unit spacing, the SI power ladder
 * and scale words — the cases the report actually turns on.
 */
/**
 * Runs of digits that are NOT quantities, and so must not be checked against a
 * source: full dates, bare years, ordinals, and model/version tokens. The first
 * live evaluation reported "2025", "21, 2026" (out of "January 21, 2026"),
 * "13 9343" (a Dell model number) and "GPT-5.6" as figures the source did not
 * carry, which is a false positive every time.
 */
const NON_QUANTITY_PATTERNS: RegExp[] = [
	// ISO and numeric dates.
	/\b\d{4}-\d{2}-\d{2}\b/g,
	/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
	/\b\d{4}\.\s?\d{1,2}\.\s?\d{1,2}\.?/g,
	// Spelled dates, in the report languages.
	/\b\d{1,2}\.?\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|január|február|március|április|május|június|július|augusztus|szeptember|október|januari|februari|maart|mei|juni|juli|augustus|oktober)[\p{L}]*\.?,?(?:\s\d{4})?/giu,
	/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|január|február|március|április|május|június|július|augusztus|szeptember|október|januari|februari|maart|mei|juni|juli|augustus|oktober)[\p{L}]*\.?\s\d{1,2}(?:st|nd|rd|th)?,?(?:\s\d{4})?/giu,
	// Model, version and part numbers.
	/\b[\p{L}][\p{L}]*-\d+(?:\.\d+)*\b/giu,
	/\b[\p{L}][\p{L}]*\d+(?:\.\d+)*\b/giu,
	/\b\d{1,4}\s\d{4,}\b/g,
	// Ordinals.
	/\b\d{1,3}(?:st|nd|rd|th)\b/gi,
	// Bare years.
	/\b(?:1[89]\d{2}|20\d{2}|21\d{2})\b/g,
];

/** Blanks out every non-quantity run, so only quantities are left to check. */
function maskNonQuantities(text: string): string {
	let masked = text;
	for (const pattern of NON_QUANTITY_PATTERNS) {
		masked = masked.replace(pattern, (match) => " ".repeat(match.length));
	}
	return masked;
}

function numbersIn(text: string): string[] {
	const stripped = maskNonQuantities(
		text.replace(CITATION_PATTERN, " ").replace(/[ᶜˢⁱ]/g, " "),
	);
	return [
		...new Set(
			[...stripped.matchAll(/\d[\d.,\u00a0\u202f ]*\d|\d/g)].map((match) =>
				match[0].trim().replace(/[.,]$/, ""),
			),
		),
	].filter((value) => value.length > 0);
}

function numericValue(raw: string): number | null {
	const cleaned = raw.replace(/[\u00a0\u202f ]/g, "");
	const hasComma = cleaned.includes(",");
	const hasDot = cleaned.includes(".");
	let normalized = cleaned;
	if (hasComma && hasDot) {
		normalized =
			cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
				? cleaned.replace(/\./g, "").replace(",", ".")
				: cleaned.replace(/,/g, "");
	} else if (hasComma) {
		normalized = /,\d{3}(\D|$)/.test(cleaned)
			? cleaned.replace(/,/g, "")
			: cleaned.replace(",", ".");
	} else if (hasDot && /\.\d{3}(\D|$)/.test(cleaned)) {
		normalized = cleaned.replace(/\./g, "");
	}
	const parsed = Number.parseFloat(normalized);
	return Number.isFinite(parsed) ? parsed : null;
}

const LADDER_FACTORS = [1, 1e3, 1e6, 1e9, 1e-3, 1e-6, 1e-9];
const SCALE_FACTORS = [1e3, 1e6, 1e9, 1e12];

function numberAppearsIn(raw: string, haystack: string): boolean {
	const normalizedHaystack = haystack
		.toLowerCase()
		.replace(/[\u00a0\u202f]/g, " ");
	const candidates = new Set<string>([raw.toLowerCase()]);
	const value = numericValue(raw);
	if (value !== null) {
		for (const factor of LADDER_FACTORS) {
			const scaled = value * factor;
			if (!Number.isFinite(scaled)) continue;
			if (
				Math.abs(scaled) >= 1e15 ||
				(scaled !== 0 && Math.abs(scaled) < 1e-4)
			) {
				continue;
			}
			addNumberForms(candidates, scaled);
		}
		for (const factor of SCALE_FACTORS) {
			const scaled = value / factor;
			if (scaled >= 0.1 && scaled < 1000) addNumberForms(candidates, scaled);
		}
	}
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (normalizedHaystack.includes(candidate)) return true;
	}
	return false;
}

function addNumberForms(into: Set<string>, value: number): void {
	const plain = Number.isInteger(value)
		? value.toString()
		: value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
	into.add(plain);
	into.add(plain.replace(".", ","));
	if (Number.isInteger(value) && Math.abs(value) >= 1000) {
		const grouped = Math.trunc(value)
			.toString()
			.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		into.add(grouped);
		into.add(grouped.replace(/,/g, "."));
		into.add(grouped.replace(/,/g, " "));
	}
}

const JUNK_TITLE_PATTERNS = [
	/\b30[1278]\b/,
	/moved\s+permanently/i,
	/\b(403|404|401|500|502|503)\b/,
	/forbidden/i,
	/not\s+found/i,
	/just\s+a\s+moment/i,
];
const SOCIAL_HOSTS = [
	"linkedin.com",
	"facebook.com",
	"x.com",
	"twitter.com",
	"instagram.com",
	"tiktok.com",
	"pinterest.com",
];

function junkSourceNotes(sources: EvidenceSource[]): string[] {
	const notes: string[] = [];
	const seenIdentity = new Map<string, number>();
	for (const source of sources) {
		const host = source.host.toLowerCase().replace(/^www\./, "");
		if (JUNK_TITLE_PATTERNS.some((pattern) => pattern.test(source.title))) {
			notes.push(`[${source.n}] redirect or error stub: "${source.title}"`);
			continue;
		}
		if (
			SOCIAL_HOSTS.some(
				(social) => host === social || host.endsWith(`.${social}`),
			)
		) {
			notes.push(`[${source.n}] social profile: ${host}`);
			continue;
		}
		// Same title on a mirror/CDN/staging variant of the same registrable name.
		const bareHost = host.replace(
			/^(cdn|amp|staging|stage|dev|test|preview|m|www\d?)\./,
			"",
		);
		const identity = `${bareHost}::${source.title.toLowerCase()}`;
		const previous = seenIdentity.get(identity);
		if (previous !== undefined) {
			notes.push(
				`[${source.n}] duplicate of [${previous}]: same title on ${host}`,
			);
			continue;
		}
		seenIdentity.set(identity, source.n);
	}
	return notes;
}

/** The report body, with the Sources section and the legend removed. */
function reportBody(markdown: string): string {
	const withoutSources = markdown.split(/\n#{1,3}\s*(Sources|Források)\b/)[0];
	return withoutSources
		.split("\n")
		.filter((line) => !/^Confidence key:|^Bizonyossági jelölés:/.test(line))
		.join("\n");
}

/** The executive-summary section of the report, or "" when there is none. */
function executiveSummarySection(markdown: string): string {
	// `\b` is ASCII-only, so it never matches after the "ó" that ends
	// "összefoglaló": the Hungarian summary was invisible to this harness.
	const match =
		/(?:^|\n)#{1,3}\s*(?:Executive summary|Vezetői összefoglaló)(?=\s|$)([\s\S]*?)(?=\n#{1,3}\s|$)/i.exec(
			markdown,
		);
	return match ? match[1].trim() : "";
}

/** The Limitations bullet list, for counting disagreement lines. */
function limitationsSection(markdown: string): string {
	const match =
		/\n#{1,3}\s*(?:Limitations|Korlátok)\b([\s\S]*?)(?=\n#{1,3}\s|$)/i.exec(
			markdown,
		);
	return match ? match[1].trim() : "";
}

/**
 * A heading that is report chrome rather than a body section. v3's are the
 * verdict, its Limitations heading (a sentence, not the word "Limitations") and
 * the evidence card.
 */
const CHROME_HEADING =
	/^(executive summary|vezetői összefoglaló|verdict|ítélet|limitations|korlátok|what this report could not establish|amit ez a jelentés nem tudott megállapítani|sources|források)\b/i;

/**
 * Body sections, not counting chrome.
 *
 * Only `##` counts. A `###` is the answer table's own title INSIDE a section,
 * and counting it said "11 / 8 sections" for a report with eight, which read as
 * the writer inventing sections it was never asked for.
 */
function countHeadings(markdown: string): number {
	return [...markdown.matchAll(/^##[ \t]+(.+)$/gm)].filter(
		(match) => !CHROME_HEADING.test(match[1].trim()),
	).length;
}

/**
 * Did the report answer the question that was asked? Checked against the
 * executive summary first, since that is where the answer belongs, then the
 * whole body — a report that buries the answer still counts as having it.
 */
function coreAnswerPresent(input: {
	markdown: string;
	query: EvalQuery;
}): boolean | null {
	const patterns: RegExp[] = [];
	if (input.query.coreAnswerRegex) {
		try {
			patterns.push(new RegExp(input.query.coreAnswerRegex, "i"));
		} catch {
			// A malformed expectation is a harness bug, not a report failure.
			return null;
		}
	}
	for (const keyword of input.query.coreAnswerKeywords ?? []) {
		patterns.push(
			new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
		);
	}
	if (patterns.length === 0) return null;
	const summary = executiveSummarySection(input.markdown);
	const body = reportBody(input.markdown);
	return (
		patterns.every((pattern) => pattern.test(summary)) ||
		patterns.every((pattern) => pattern.test(body))
	);
}

/**
 * Where the report landed against the profile band, WITH the band: "in range",
 * "over by n" or "under by n", each naming the range it is measured against, so
 * the number in the table can be read without opening this file.
 */
function describeWordBudget(
	wordCount: number,
	profile: EvalQuery["profile"],
): { label: string; ok: boolean } {
	const band = WORD_BUDGETS[profile];
	const range = `${band.min}-${band.max}`;
	if (wordCount > band.max) {
		return { label: `over by ${wordCount - band.max} (${range})`, ok: false };
	}
	if (wordCount < band.min) {
		return { label: `under by ${band.min - wordCount} (${range})`, ok: false };
	}
	return { label: `in range (${range})`, ok: true };
}

/**
 * Every prose sentence in the report body, headings and list chrome excluded.
 * Splitting per LINE first matters: a section heading sits between two
 * paragraphs, and a sentence splitter run over the whole body would glue the
 * heading to the sentence on either side of it.
 */
function reportSentences(body: string): string[] {
	return body
		.split(/\n+/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.flatMap((line) => sentencesOf(line));
}

/**
 * Sentences that restate an earlier sentence's figures.
 *
 * The second evaluation's reports said the same thing in three sections — "65.1
 * GW in 2025, down 0.7% from 65.6 GW in 2024" in all three — and then reported
 * themselves as short. A repeated figure set is the cheapest detectable form of
 * that. It is MEASURED here and deliberately not deleted on the server: the
 * novelty guard that used to delete it made reports shorter without making them
 * less repetitive, so repetition is now a number the evaluation reports rather
 * than something the pipeline silently prunes.
 */
function repeatedFactCount(body: string): number {
	const seen: Array<Set<string>> = [];
	let repeats = 0;
	for (const sentence of reportSentences(body)) {
		const figures = new Set(
			numbersIn(sentence).filter(
				(number) => number.replace(/\D/g, "").length >= 2,
			),
		);
		if (figures.size === 0) continue;
		const isRepeat = seen.some(
			(earlier) =>
				earlier.size === figures.size &&
				[...figures].every((figure) => earlier.has(figure)),
		);
		if (isRepeat) {
			repeats += 1;
			continue;
		}
		seen.push(figures);
	}
	return repeats;
}

/**
 * Splits a report body into sentences, ACCEPTING the citation group and
 * confidence glyph that follow the full stop: an Atlas sentence ends
 * `… in 2024. [2][3]ᶜ`, and a splitter that only looks for `.` followed by a
 * capital never split there at all — it handed the whole report back as one
 * "sentence", which quietly pooled every figure against every cited source.
 */
function sentencesOf(text: string): string[] {
	return text
		.split(
			/(?<=[.!?][)"'\]]*(?:\s*\[\d{1,3}\])*\s*[ᶜˢⁱ]?)\s+(?=[A-ZÁÉÍÓÖŐÚÜŰ0-9])/u,
		)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// ADR 0063's deterministic quality layer
// ---------------------------------------------------------------------------

/** The heading the report's answer lives under, on either pipeline. */
const VERDICT_HEADINGS =
	/(?:^|\n)#{1,3}\s*(?:Verdict|Ítélet|Executive summary|Vezetői összefoglaló)(?=\s|$)([\s\S]*?)(?=\n#{1,3}\s|$)/i;

function verdictSection(markdown: string): string {
	const match = VERDICT_HEADINGS.exec(markdown);
	return match ? match[1].trim() : "";
}

/**
 * Does the report state its answer in the first 150 words?
 *
 * "States its answer" is measured, not judged: a figure of at least two digits
 * inside the opening window. v2 scored 0/13 here because its executive summary
 * never survived to the rendered file at all.
 */
function verdictInWindow(markdown: string, windowWords = 150): boolean {
	const opening = reportBody(markdown)
		.split(/\n+/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.join(" ")
		.split(/\s+/)
		.slice(0, windowWords)
		.join(" ");
	return numbersIn(opening).some(
		(number) => number.replace(/\D/g, "").length >= 2,
	);
}

const REDUNDANCY_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"of",
	"in",
	"on",
	"at",
	"to",
	"for",
	"and",
	"or",
	"but",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"has",
	"have",
	"had",
	"that",
	"this",
	"these",
	"those",
	"it",
	"its",
	"by",
	"with",
	"as",
	"from",
	"than",
	"which",
	"also",
	"more",
	"most",
	"az",
	"és",
	"hogy",
	"nem",
	"de",
	"vagy",
	"egy",
	"volt",
	"lesz",
	"mint",
	"már",
	"még",
]);

function contentWordSet(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/\[\d{1,3}\]/g, " ")
			.replace(/[^\p{L}\p{N}\s.,%-]/gu, " ")
			.split(/\s+/)
			.filter((word) => word.length > 2 && !REDUNDANCY_STOPWORDS.has(word)),
	);
}

/** The report body split into (heading, sentences) sections. */
function sectionsOf(
	markdown: string,
): Array<{ title: string; sentences: string[] }> {
	const sections: Array<{ title: string; sentences: string[] }> = [];
	let current: { title: string; sentences: string[] } | null = null;
	for (const line of reportBody(markdown).split(/\n+/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const heading = /^#{2,3}[ \t]+(.+)$/.exec(trimmed);
		if (heading) {
			current = { title: heading[1].trim(), sentences: [] };
			sections.push(current);
			continue;
		}
		if (!current) {
			current = { title: "", sentences: [] };
			sections.push(current);
		}
		current.sentences.push(...sentencesOf(trimmed));
	}
	return sections;
}

/**
 * Sentences that restate a claim an EARLIER SECTION already made, by
 * content-word overlap. Distinct from `repeatedFactCount`, which compares
 * figure sets: a report can repeat a claim in words without repeating a number,
 * and the quality memo counts both as redundancy.
 */
function crossSectionRepeatCount(markdown: string, sharedWords = 5): number {
	const seen: Array<{ title: string; words: Set<string> }> = [];
	let repeats = 0;
	for (const section of sectionsOf(markdown)) {
		for (const sentence of section.sentences) {
			const words = contentWordSet(sentence);
			if (words.size < sharedWords) continue;
			const duplicate = seen.some((earlier) => {
				if (earlier.title === section.title) return false;
				let shared = 0;
				for (const word of words) if (earlier.words.has(word)) shared += 1;
				return shared >= sharedWords;
			});
			if (duplicate) repeats += 1;
			else seen.push({ title: section.title, words });
		}
	}
	return repeats;
}

/** Distinct cited claims per 1,000 words. Mechanical padding drives it down. */
function claimsPerThousandWords(markdown: string, wordCount: number): number {
	if (wordCount === 0) return 0;
	const distinct = new Set<string>();
	for (const sentence of reportSentences(reportBody(markdown))) {
		if (!/\[\d{1,3}\]/.test(sentence)) continue;
		const key = [...contentWordSet(sentence)].sort().join(" ");
		if (key) distinct.add(key);
	}
	return (distinct.size / wordCount) * 1000;
}

/** A figure that rots: a share, a rate, a price, a capacity. */
const VOLATILE_FIGURE =
	/\d[\d.,  ]*\s*(?:%|percent|százalék|EUR|USD|GBP|HUF|Ft|GW|MW|TWh|GWh|kWh|bn|billion|million|milliárd|millió)/iu;

/** An inline date clause: "(as of December 2025)", "2026. februári adat". */
const INLINE_DATE_PATTERNS: RegExp[] = [
	/\b(?:as of|per|status|adat|állapot|szerint)\b[^.]{0,30}\b(?:19|20)\d{2}\b/iu,
	/\b(?:19|20)\d{2}\.?\s*(?:janu|febru|márci|április|máju|júni|júli|augusz|szeptem|októbe|novemb|decemb)/iu,
	/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(?:19|20)\d{2}\b/iu,
	/\bq[1-4]\s*(?:19|20)\d{2}\b/iu,
];

function volatileDateCoverage(markdown: string): {
	dated: number;
	total: number;
} {
	let dated = 0;
	let total = 0;
	for (const sentence of reportSentences(reportBody(markdown))) {
		if (!VOLATILE_FIGURE.test(sentence)) continue;
		total += 1;
		if (INLINE_DATE_PATTERNS.some((pattern) => pattern.test(sentence))) {
			dated += 1;
		}
	}
	return { dated, total };
}

/** Question kinds whose answer belongs in a table. */
const TABLE_KINDS = ["comparison", "pricing", "product", "timeline", "matrix"];

function tableExpectedFor(query: EvalQuery | undefined): boolean {
	if (!query) return false;
	const kind = query.kind.toLowerCase();
	return TABLE_KINDS.some((candidate) => kind.includes(candidate));
}

/** A Markdown table, not merely a stray pipe character. */
function tablePresent(markdown: string): boolean {
	const lines = markdown.split(/\r?\n/);
	for (let index = 0; index < lines.length - 1; index += 1) {
		const header = lines[index].trim();
		const rule = lines[index + 1].trim();
		if (!header.startsWith("|") || !rule.startsWith("|")) continue;
		if (/^\|[\s:|-]+\|$/.test(rule)) return true;
	}
	return false;
}

function computeMetrics(input: {
	/** Sections the plan asked for, from the job's own progress card. */
	sectionsPlanned?: number | null;
	/** Writer runaway counters, from the job's own progress card. */
	writerRunaways?: Metrics["writerRunaways"];
	/** ADR 0063's diagnostics, from the job's own progress card. */
	diagnostics?: Metrics["diagnostics"];
	markdown: string | null;
	/** Omitted only by the empty-result path. */
	query?: EvalQuery;
	evidence: AtlasJobCardLike["progress"] extends never
		? never
		: NonNullable<
				NonNullable<AtlasJobCardLike["progress"]>["details"]
			>["evidence"];
}): Metrics {
	const empty: Metrics = {
		wordCount: 0,
		citationCount: 0,
		citationDensity: 0,
		resolvedCitationCount: 0,
		citationResolutionRate: null,
		numbersChecked: 0,
		numbersMatched: 0,
		numberMatchRate: null,
		corroborationRate: null,
		corroboratedCount: 0,
		singleCount: 0,
		inferredCount: 0,
		cutCount: 0,
		filteredCount: 0,
		sourceCount: 0,
		citedSourceCount: 0,
		junkSourceCount: 0,
		junkSourceNotes: [],
		unmatchedNumberNotes: [],
		wordBudget: "n/a",
		wordBudgetOk: false,
		repeatedFactCount: 0,
		sectionCount: 0,
		sectionsPlanned: null,
		writerRunaways: null,
		coreAnswerPresent: null,
		contradictionLineCount: 0,
		verdictInWindow: false,
		crossSectionRepeatCount: 0,
		claimsPerThousandWords: 0,
		datedVolatileCount: 0,
		volatileFigureCount: 0,
		datedVolatileRate: null,
		tableExpected: false,
		tablePresent: false,
		diagnostics: null,
		judge: null,
	};
	// A job that ran away and then failed reports nothing but the counters, so
	// they survive the empty-markdown path.
	if (!input.markdown) {
		return {
			...empty,
			writerRunaways: input.writerRunaways ?? null,
			diagnostics: input.diagnostics ?? null,
		};
	}

	const body = reportBody(input.markdown);
	const wordCount = body.split(/\s+/).filter(Boolean).length;
	const citations = [...body.matchAll(CITATION_PATTERN)].map((match) =>
		Number.parseInt(match[1], 10),
	);
	const sources = input.evidence?.sources ?? [];
	const sourceByNumber = new Map(sources.map((source) => [source.n, source]));
	const resolved = citations.filter((citation) =>
		sourceByNumber.has(citation),
	).length;

	// Number matching: for every cited sentence, every number in it must appear
	// in the text of at least one source it cites.
	let numbersChecked = 0;
	let numbersMatched = 0;
	const unmatchedNumberNotes: string[] = [];
	if (sources.length > 0) {
		for (const sentence of reportSentences(body)) {
			const sentenceCitations = [...sentence.matchAll(CITATION_PATTERN)].map(
				(match) => Number.parseInt(match[1], 10),
			);
			if (sentenceCitations.length === 0) continue;
			const haystack = sentenceCitations
				.map((citation) => sourceByNumber.get(citation)?.snippet ?? "")
				.join("\n");
			if (!haystack.trim()) continue;
			for (const number of numbersIn(sentence)) {
				// Single digits are usually list ordinals or footnote noise.
				if (number.replace(/\D/g, "").length < 2) continue;
				numbersChecked += 1;
				if (numberAppearsIn(number, haystack)) {
					numbersMatched += 1;
				} else {
					const closest = closestNumberIn(number, haystack);
					unmatchedNumberNotes.push(
						closest
							? `"${number}" (closest in the cited source: "${closest}") in: ${sentence.slice(0, 180)}`
							: `"${number}" in: ${sentence.slice(0, 180)}`,
					);
				}
			}
		}
	}

	const corroborated = input.evidence?.corroborated ?? 0;
	const single = input.evidence?.single ?? 0;
	const inferred = input.evidence?.inferred ?? 0;
	const claimTotal = corroborated + single + inferred;
	const notes = junkSourceNotes(sources);
	const budget = input.query
		? describeWordBudget(wordCount, input.query.profile)
		: { label: "n/a", ok: false };
	const volatile = volatileDateCoverage(input.markdown);
	const contradictionLineCount = limitationsSection(input.markdown)
		.split("\n")
		.filter((line) =>
			/^[-*]\s.*(?:sources disagree|a források nem egyeznek)/i.test(
				line.trim(),
			),
		).length;

	return {
		wordCount,
		citationCount: citations.length,
		citationDensity: wordCount > 0 ? (citations.length / wordCount) * 100 : 0,
		resolvedCitationCount: resolved,
		citationResolutionRate:
			citations.length > 0 ? resolved / citations.length : null,
		numbersChecked,
		numbersMatched,
		numberMatchRate:
			numbersChecked > 0 ? numbersMatched / numbersChecked : null,
		corroborationRate: claimTotal > 0 ? corroborated / claimTotal : null,
		corroboratedCount: corroborated,
		singleCount: single,
		inferredCount: inferred,
		cutCount: input.evidence?.cut ?? 0,
		filteredCount: input.evidence?.filteredCount ?? 0,
		sourceCount: sources.length,
		citedSourceCount: sources.filter((source) => source.cited).length,
		junkSourceCount: notes.length,
		junkSourceNotes: notes,
		unmatchedNumberNotes: unmatchedNumberNotes.slice(0, 12),
		wordBudget: budget.label,
		wordBudgetOk: budget.ok,
		repeatedFactCount: repeatedFactCount(body),
		sectionCount: countHeadings(input.markdown),
		sectionsPlanned: input.sectionsPlanned ?? null,
		writerRunaways: input.writerRunaways ?? null,
		coreAnswerPresent: input.query
			? coreAnswerPresent({ markdown: input.markdown, query: input.query })
			: null,
		contradictionLineCount,
		verdictInWindow: verdictInWindow(input.markdown),
		crossSectionRepeatCount: crossSectionRepeatCount(input.markdown),
		claimsPerThousandWords: claimsPerThousandWords(input.markdown, wordCount),
		datedVolatileCount: volatile.dated,
		volatileFigureCount: volatile.total,
		datedVolatileRate:
			volatile.total > 0 ? volatile.dated / volatile.total : null,
		tableExpected: tableExpectedFor(input.query),
		tablePresent: tablePresent(input.markdown),
		diagnostics: input.diagnostics ?? null,
		judge: null,
	};
}

/** The nearest number the cited source states, for the mismatch note. */
function closestNumberIn(raw: string, haystack: string): string | null {
	const target = numericValue(raw);
	if (target === null) return null;
	let best: { text: string; distance: number } | null = null;
	for (const candidate of numbersIn(haystack)) {
		const value = numericValue(candidate);
		if (value === null) continue;
		const distance = Math.abs(value - target);
		if (!best || distance < best.distance) {
			best = { text: candidate, distance };
		}
	}
	return best?.text ?? null;
}

// ---------------------------------------------------------------------------
// Layer 2: the rubric judge (ADR 0063)
// ---------------------------------------------------------------------------
//
// Eight of the sixteen rubric dimensions cannot be checked deterministically.
// The judge scores those, and every score MUST come back with a verbatim quote
// from the report — requiring a quote is the cheapest anti-hallucination device
// available, and a score whose quote is not in the report is thrown away here
// rather than averaged in.
//
// The judge runs through the deployment's own chat API, which takes no model
// parameter: it uses the eval account's selected model. Set that account to the
// model ATLAS_AUDIT_MODEL names before judging.

const JUDGE_DIMENSIONS = [
	"question_fidelity",
	"source_quality",
	"cross_source_synthesis",
	"conflict_handling",
	"insight",
	"calibrated_uncertainty",
	"answer_first_structure",
	"coverage_vs_plan",
] as const;

const JUDGE_INSTRUCTIONS = [
	"You are grading a research report against a fixed rubric. Answer with STRICT JSON only, no prose and no code fence.",
	'Shape: {"scores":[{"dimension":"insight","score":3,"justification":"one sentence","quote":"verbatim sentence from the report"}]}',
	`Score every one of these dimensions, 1 to 5: ${JUDGE_DIMENSIONS.join(", ")}.`,
	"question_fidelity: does the report answer the question actually asked, including the decision behind it?",
	"source_quality: do the claims rest on primary or authoritative publishers rather than aggregators echoing one origin?",
	"cross_source_synthesis: do sections integrate several sources into one claim, rather than narrating them one by one?",
	"conflict_handling: is at least one genuine disagreement named, adjudicated, and the reason given?",
	"insight: does the report conclude something a competent reader could not have written from the question alone?",
	"calibrated_uncertainty: is uncertainty attached to specific claims, with a reason and what would resolve it?",
	"answer_first_structure: does the bottom line appear before the evidence, with the figures it rests on?",
	"coverage_vs_plan: is every sub-question the report itself promised actually delivered?",
	"`quote` MUST be copied verbatim from the report. A score you cannot point at with a quote is worthless; if you cannot find one, do not score that dimension.",
	"Do not rewrite the report. Do not explain your process.",
] as const;

function buildJudgePrompt(input: {
	query: EvalQuery;
	markdown: string;
}): string {
	return [
		JUDGE_INSTRUCTIONS.join("\n"),
		"",
		`QUESTION ASKED: ${input.query.query}`,
		input.query.expectations.length > 0
			? `WHAT A GOOD ANSWER CONTAINS: ${input.query.expectations.join("; ")}`
			: "",
		"",
		"REPORT:",
		input.markdown.slice(0, 40_000),
	]
		.filter(Boolean)
		.join("\n");
}

function extractJson(text: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidate = (fenced ? fenced[1] : text).trim();
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** Whitespace-insensitive containment, so a quote survives re-wrapping. */
function quoteAppearsIn(quote: string, markdown: string): boolean {
	const normalize = (value: string) =>
		value.toLowerCase().replace(/\s+/g, " ").trim();
	const needle = normalize(quote);
	if (needle.length < 12) return false;
	return normalize(markdown).includes(needle);
}

function parseJudgeAnswer(input: {
	text: string;
	markdown: string;
}): JudgeResult {
	const parsed = extractJson(input.text);
	if (!parsed || typeof parsed !== "object") {
		return {
			scores: [],
			discarded: 0,
			average: null,
			error: "The judge did not answer with JSON.",
		};
	}
	const raw = (parsed as { scores?: unknown }).scores;
	if (!Array.isArray(raw)) {
		return {
			scores: [],
			discarded: 0,
			average: null,
			error: "The judge's answer carried no scores.",
		};
	}
	const scores: JudgeScore[] = [];
	let discarded = 0;
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const dimension =
			typeof record.dimension === "string" ? record.dimension.trim() : "";
		const score =
			typeof record.score === "number" ? Math.round(record.score) : Number.NaN;
		const quote = typeof record.quote === "string" ? record.quote.trim() : "";
		if (!dimension || !Number.isFinite(score) || score < 1 || score > 5) {
			discarded += 1;
			continue;
		}
		// The quote gate: a score the judge cannot point at is discarded.
		if (!quoteAppearsIn(quote, input.markdown)) {
			discarded += 1;
			continue;
		}
		scores.push({
			dimension,
			score,
			justification:
				typeof record.justification === "string"
					? record.justification.replace(/\s+/g, " ").trim().slice(0, 300)
					: "",
			quote: quote.slice(0, 300),
		});
	}
	return {
		scores,
		discarded,
		average:
			scores.length > 0
				? scores.reduce((total, entry) => total + entry.score, 0) /
					scores.length
				: null,
		error: null,
	};
}

async function judgeReport(input: {
	session: Session;
	query: EvalQuery;
	markdown: string;
}): Promise<JudgeResult> {
	try {
		const conversation = await input.session.json<{ id: string }>(
			"/api/conversations",
			{
				method: "POST",
				body: JSON.stringify({
					title: `Atlas eval judge: ${input.query.id}`,
					projectId: null,
				}),
			},
		);
		const answer = await input.session.json<{ response?: { text?: string } }>(
			"/api/chat/send",
			{
				method: "POST",
				body: JSON.stringify({
					conversationId: conversation.id,
					message: buildJudgePrompt(input),
				}),
			},
		);
		return parseJudgeAnswer({
			text: answer.response?.text ?? "",
			markdown: input.markdown,
		});
	} catch (error) {
		return {
			scores: [],
			discarded: 0,
			average: null,
			error: error instanceof Error ? error.message : "The judge call failed.",
		};
	}
}

// ---------------------------------------------------------------------------
// Running one query
// ---------------------------------------------------------------------------

async function runQuery(input: {
	session: Session;
	query: EvalQuery;
	pipeline: EvalPipeline;
	profileOverride: EvalQuery["profile"] | null;
	timeoutMs: number;
}): Promise<QueryResult> {
	// A --profile override changes the profile the job actually ran on, so the
	// budget the report is graded against has to follow it.
	const query: EvalQuery = input.profileOverride
		? { ...input.query, profile: input.profileOverride }
		: input.query;
	const { session } = input;
	const startedAt = Date.now();
	const conversation = await session.json<{ id: string }>(
		"/api/conversations",
		{
			method: "POST",
			body: JSON.stringify({
				title: `Atlas eval ${input.pipeline}: ${query.id}`,
				projectId: null,
			}),
		},
	);

	const send = await session.json<{ atlasJob?: AtlasJobCardLike }>(
		"/api/chat/send",
		{
			method: "POST",
			body: JSON.stringify({
				conversationId: conversation.id,
				message: query.query,
				atlasMode: true,
				atlasProfile: query.profile,
				atlasAction: "create",
				clientAtlasTurnId: randomUUID(),
			}),
		},
	);
	const jobId = send.atlasJob?.id;
	if (!jobId) throw new Error(`No Atlas job created for ${query.id}.`);
	process.stdout.write(`  ${query.id}: job ${jobId} queued\n`);

	let card: AtlasJobCardLike | null = null;
	let lastPhase = "";
	const deadline = Date.now() + input.timeoutMs;
	while (Date.now() < deadline) {
		await sleep(5000);
		const detail = await session.json<{ atlasJobs?: AtlasJobCardLike[] }>(
			`/api/conversations/${conversation.id}`,
		);
		card = detail.atlasJobs?.find((job) => job.id === jobId) ?? null;
		if (!card) continue;
		const phase = card.progress?.details?.phase ?? card.stage ?? card.status;
		if (phase !== lastPhase) {
			lastPhase = phase;
			process.stdout.write(
				`  ${query.id}: ${card.status} · ${phase} · ${card.progress?.details?.sourcesRead ?? 0} sources read\n`,
			);
		}
		if (
			card.status === "succeeded" ||
			card.status === "failed" ||
			card.status === "cancelled"
		) {
			// A failure printed nothing while the run continued, so a two-hour
			// evaluation only revealed its dead jobs in the final table.
			if (card.status !== "succeeded") {
				process.stdout.write(
					`  ${query.id}: ${card.status} · ${card.error?.code ?? "no_error_code"} · ${
						card.error?.message ?? "no error message"
					}\n`,
				);
			}
			break;
		}
	}

	const wallMs = Date.now() - startedAt;
	if (!card) {
		return {
			query,
			pipeline: input.pipeline,
			reportedPipelineVersion: null,
			status: "timeout",
			error: "The job card never appeared.",
			wallMs,
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			markdown: null,
			phaseDurationsMs: null,
			metrics: computeMetrics({ markdown: null, evidence: undefined }),
		};
	}

	let markdown: string | null = null;
	const markdownFileId = card.outputs?.markdownChatGeneratedFileId;
	if (card.status === "succeeded" && markdownFileId) {
		markdown = await session
			.text(`/api/chat/files/${markdownFileId}/download`)
			.catch(() => null);
	}

	return {
		query,
		pipeline: input.pipeline,
		reportedPipelineVersion:
			card.pipelineVersion ?? card.progress?.details?.pipelineVersion ?? null,
		status: card.status === "succeeded" ? "succeeded" : card.status,
		error: card.error?.message ?? null,
		wallMs,
		usage: {
			inputTokens: card.usage?.inputTokens ?? 0,
			outputTokens: card.usage?.outputTokens ?? 0,
			totalTokens: card.usage?.totalTokens ?? 0,
		},
		markdown,
		phaseDurationsMs: card.progress?.details?.phaseDurationsMs ?? null,
		metrics: computeMetrics({
			markdown,
			query,
			evidence: card.progress?.details?.evidence,
			sectionsPlanned:
				card.progress?.details?.sections?.planned ??
				card.progress?.details?.qualityDiagnostics?.sectionsPlanned ??
				null,
			writerRunaways:
				card.progress?.details?.writerRunaways ??
				card.progress?.details?.qualityDiagnostics?.writerRunaways ??
				null,
			diagnostics: card.progress?.details?.qualityDiagnostics ?? null,
		}),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * "5 / 5", or bolded when the report has fewer sections than the plan asked
 * for. Falls back to the heading count alone on v1, which reports no plan.
 */
function sectionsCell(metrics: Metrics): string {
	if (metrics.sectionsPlanned === null) return String(metrics.sectionCount);
	const cell = `${metrics.sectionCount} / ${metrics.sectionsPlanned}`;
	return metrics.sectionCount < metrics.sectionsPlanned ? `**${cell}**` : cell;
}

/**
 * "0", or "2 (1 salvaged, 1 plain)" bolded when a writer call ran to its output
 * cap. A runaway is the defect the wall time reads as "the model was slow": the
 * body comes back unclosed and the section is written twice or dropped.
 */
export function writerRunawaysCell(metrics: Metrics): string {
	const runaways = metrics.writerRunaways;
	if (!runaways) return "n/a";
	if (runaways.length === 0) return "0";
	const repairs = [
		runaways.salvaged > 0 ? `${runaways.salvaged} salvaged` : null,
		runaways.retried > 0 ? `${runaways.retried} retried` : null,
		runaways.fallback > 0 ? `${runaways.fallback} plain` : null,
	].filter((part): part is string => part !== null);
	return `**${runaways.length}${repairs.length > 0 ? ` (${repairs.join(", ")})` : ""}**`;
}

function percent(value: number | null): string {
	return value === null ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

function minutes(ms: number): string {
	return `${(ms / 60000).toFixed(1)}m`;
}

function buildMarkdownReport(results: QueryResult[]): string {
	const lines: string[] = [
		"# Atlas evaluation",
		"",
		`Run at ${new Date().toISOString()}.`,
		"",
		"`n/a` means the metric does not apply to that pipeline — v1 emits no `[n]`",
		"markers and no per-claim confidence, so its citation, number-match and",
		"corroboration columns are honestly empty rather than zero-by-construction.",
		"",
		"## Comparison",
		"",
		"| Query | Kind | Pipeline | Profile | Status | Wall | Tokens in/out | Words | Budget | Sections | Writer runaways | Core answer | Citations | Cites/100w | Resolved | Numbers matched | Corroborated | Repeated facts | Cut | Disagreements | Sources (cited) | Filtered | Junk |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];

	for (const result of results) {
		const metrics = result.metrics;
		// v1 emits no `[n]` markers and no per-claim confidence; v2 and v3 do.
		const applies = result.pipeline !== "v1";
		const coreAnswer =
			metrics.coreAnswerPresent === null
				? "n/a"
				: metrics.coreAnswerPresent
					? "yes"
					: "**NO**";
		lines.push(
			`| ${result.query.id} | ${result.query.kind} | ${result.pipeline} | ${result.query.profile} | ${result.status} | ${minutes(result.wallMs)} | ${result.usage.inputTokens}/${result.usage.outputTokens} | ${metrics.wordCount} | ${metrics.wordBudgetOk ? metrics.wordBudget : `**${metrics.wordBudget}**`} | ${sectionsCell(metrics)} | ${writerRunawaysCell(metrics)} | ${coreAnswer} | ${metrics.citationCount} | ${metrics.citationDensity.toFixed(1)} | ${applies ? percent(metrics.citationResolutionRate) : "n/a"} | ${applies ? `${percent(metrics.numberMatchRate)} (${metrics.numbersMatched}/${metrics.numbersChecked})` : "n/a"} | ${applies ? percent(metrics.corroborationRate) : "n/a"} | ${metrics.repeatedFactCount === 0 ? "0" : `**${metrics.repeatedFactCount}**`} | ${applies ? metrics.cutCount : "n/a"} | ${metrics.contradictionLineCount} | ${metrics.sourceCount} (${metrics.citedSourceCount}) | ${metrics.filteredCount} | ${metrics.junkSourceCount} |`,
		);
	}

	// ADR 0063's deterministic quality layer, measured on every pipeline so v2
	// and v3 are graded on the same ruler.
	lines.push(
		"",
		"## Quality (deterministic)",
		"",
		"Measured from the rendered report, independently of what the job claimed.",
		"",
		"| Query | Pipeline | Verdict in first 150w | Cross-section repeats | Claims/1000w | Dated volatile figures | Table | Delivered/planned | Judge |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	);
	for (const result of results) {
		const metrics = result.metrics;
		const table = metrics.tableExpected
			? metrics.tablePresent
				? "yes"
				: "**MISSING**"
			: metrics.tablePresent
				? "yes"
				: "n/a";
		const judge =
			metrics.judge === null
				? "n/a"
				: metrics.judge.average === null
					? `**none** (${metrics.judge.discarded} discarded)`
					: `${metrics.judge.average.toFixed(2)} (${metrics.judge.scores.length}/${metrics.judge.scores.length + metrics.judge.discarded})`;
		lines.push(
			`| ${result.query.id} | ${result.pipeline} | ${metrics.verdictInWindow ? "yes" : "**NO**"} | ${metrics.crossSectionRepeatCount === 0 ? "0" : `**${metrics.crossSectionRepeatCount}**`} | ${metrics.claimsPerThousandWords.toFixed(1)} | ${percent(metrics.datedVolatileRate)} (${metrics.datedVolatileCount}/${metrics.volatileFigureCount}) | ${table} | ${sectionsCell(metrics)} | ${judge} |`,
		);
	}

	const byPipeline = new Map<string, QueryResult[]>();
	for (const result of results) {
		const bucket = byPipeline.get(result.pipeline) ?? [];
		bucket.push(result);
		byPipeline.set(result.pipeline, bucket);
	}
	lines.push("", "## Totals", "");
	for (const [pipeline, bucket] of byPipeline) {
		const succeeded = bucket.filter((entry) => entry.status === "succeeded");
		const totalWall = bucket.reduce((sum, entry) => sum + entry.wallMs, 0);
		const totalTokens = bucket.reduce(
			(sum, entry) => sum + entry.usage.totalTokens,
			0,
		);
		const junk = bucket.reduce(
			(sum, entry) => sum + entry.metrics.junkSourceCount,
			0,
		);
		const density = succeeded.length
			? succeeded.reduce(
					(sum, entry) => sum + entry.metrics.citationDensity,
					0,
				) / succeeded.length
			: 0;
		const inBudget = succeeded.filter(
			(entry) => entry.metrics.wordBudgetOk,
		).length;
		const checkedCore = succeeded.filter(
			(entry) => entry.metrics.coreAnswerPresent !== null,
		);
		const answered = checkedCore.filter(
			(entry) => entry.metrics.coreAnswerPresent === true,
		).length;
		lines.push(
			`- **${pipeline}**: ${succeeded.length}/${bucket.length} succeeded · ${minutes(totalWall)} total · ${totalTokens} tokens · ${density.toFixed(1)} citations per 100 words · ${junk} junk sources`,
			`  - words inside the profile budget: ${inBudget}/${succeeded.length}`,
			`  - sentences repeating an earlier figure set: ${bucket.reduce(
				(sum, entry) => sum + entry.metrics.repeatedFactCount,
				0,
			)}`,
			`  - reports missing a section the plan asked for: ${
				succeeded.filter(
					(entry) =>
						entry.metrics.sectionsPlanned !== null &&
						entry.metrics.sectionCount < entry.metrics.sectionsPlanned,
				).length
			}/${succeeded.length}`,
			`  - writer calls that ran to the output cap: ${bucket.reduce(
				(sum, entry) => sum + (entry.metrics.writerRunaways?.length ?? 0),
				0,
			)}`,
			checkedCore.length > 0
				? `  - answered the core question: ${answered}/${checkedCore.length}`
				: "  - answered the core question: not checked (no `coreAnswerRegex` in the query file)",
		);
	}

	lines.push(
		"",
		"## Per-query notes",
		"",
		"Each block lists the hand-checkable expectations for a manual false-claim",
		"pass, then anything the harness could not verify itself.",
		"",
	);
	for (const result of results) {
		lines.push(
			`### ${result.query.id} (${result.pipeline}) — ${result.status}`,
			"",
			`**Request:** ${result.query.query}`,
			"",
		);
		if (result.reportedPipelineVersion !== null) {
			const expected = result.pipeline === "v2" ? 2 : 1;
			if (result.reportedPipelineVersion !== expected) {
				lines.push(
					`> **MISLABELLED RUN.** The job reported \`pipelineVersion: ${result.reportedPipelineVersion}\` but this run is labelled \`${result.pipeline}\`. Check ATLAS_PIPELINE on the deployment.`,
					"",
				);
			}
		}
		if (result.error) lines.push(`**Error:** ${result.error}`, "");
		lines.push("**Check by hand:**", "");
		for (const expectation of result.query.expectations) {
			lines.push(`- [ ] ${expectation}`);
		}
		lines.push("");
		if (result.phaseDurationsMs) {
			const durations = Object.entries(result.phaseDurationsMs)
				.sort(([, left], [, right]) => right - left)
				.map(([phase, ms]) => `${phase} ${(ms / 1000).toFixed(0)}s`)
				.join(" · ");
			lines.push(`**Phase durations:** ${durations}`, "");
		}
		lines.push(
			`**Length:** ${result.metrics.wordCount} words against the ${result.query.profile} budget — ${result.metrics.wordBudget}; ${sectionsCell(result.metrics)} sections written/planned.`,
			"",
		);
		if (
			result.metrics.sectionsPlanned !== null &&
			result.metrics.sectionCount < result.metrics.sectionsPlanned
		) {
			lines.push(
				`> **The report is missing ${result.metrics.sectionsPlanned - result.metrics.sectionCount} of the ${result.metrics.sectionsPlanned} sections the plan asked for.**`,
				"> A section the writer could not produce is logged with its reason by",
				"> the pipeline; a short report here is a lost section, not a terse one.",
				"",
			);
		}
		if (result.metrics.repeatedFactCount > 0) {
			lines.push(
				`**Repeated facts:** ${result.metrics.repeatedFactCount} sentence(s) restate a figure set an earlier sentence already carried.`,
				"",
			);
		}
		if (result.metrics.coreAnswerPresent === false) {
			lines.push(
				"> **The report did not answer the core question.** The executive",
				"> summary matched none of this query's expected-answer patterns.",
				"",
			);
		}
		if (result.metrics.unmatchedNumberNotes.length > 0) {
			lines.push("**Numbers the cited source text did not carry:**", "");
			for (const note of result.metrics.unmatchedNumberNotes) {
				lines.push(`- ${note}`);
			}
			lines.push("");
		}
		if (result.metrics.junkSourceNotes.length > 0) {
			lines.push("**Junk sources:**", "");
			for (const note of result.metrics.junkSourceNotes) {
				lines.push(`- ${note}`);
			}
			lines.push("");
		}
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const base = (process.env.BASE ?? "").replace(/\/+$/, "");
	const email = process.env.EMAIL ?? "";
	const password = process.env.PASSWORD ?? "";
	if (!base || !email || !password) {
		console.error(
			"BASE, EMAIL and PASSWORD are required.\n" +
				"  BASE=https://staging.example EMAIL=... PASSWORD=... npx tsx scripts/atlas-eval.ts",
		);
		process.exit(1);
	}

	const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
	const queriesFile = resolve(root, "scripts/atlas-eval-queries.json");
	const allQueries = (
		JSON.parse(readFileSync(queriesFile, "utf8")) as { queries: EvalQuery[] }
	).queries;
	const wantedIds = args.queries
		? new Set(args.queries.split(",").map((id) => id.trim()))
		: null;
	const queries = wantedIds
		? allQueries.filter((query) => wantedIds.has(query.id))
		: allQueries;
	if (queries.length === 0) {
		console.error("No queries selected.");
		process.exit(1);
	}

	const pipelines: EvalPipeline[] =
		args.pipeline === "v1"
			? ["v1"]
			: args.pipeline === "v2"
				? ["v2"]
				: args.pipeline === "v3"
					? ["v3"]
					: args.pipeline === "all"
						? ["v1", "v2", "v3"]
						: ["v1", "v2"];
	const timeoutMs = Number.parseInt(args.timeout ?? "45", 10) * 60_000;
	const concurrency = Math.max(1, Number.parseInt(args.concurrency ?? "1", 10));
	const outDir = resolve(root, args.out ?? "atlas-eval");
	const profileOverride =
		args.profile === "overview" ||
		args.profile === "in-depth" ||
		args.profile === "exhaustive"
			? args.profile
			: null;

	const session = new Session(base);
	await session.login(email, password);
	console.log(`Logged in to ${base} as ${email}.`);

	const results: QueryResult[] = [];
	for (const pipeline of pipelines) {
		if (pipelines.length > 1) {
			console.log(
				`\n=== ${pipeline} ===\nSet ATLAS_PIPELINE=${pipeline} on the deployment before this batch, then press Enter.`,
			);
			await waitForEnter();
		}
		console.log(`Running ${queries.length} queries on ${pipeline}.`);
		const queue = [...queries];
		const workers = Array.from(
			{ length: Math.min(concurrency, queue.length) },
			async () => {
				for (;;) {
					const query = queue.shift();
					if (!query) return;
					try {
						results.push(
							await runQuery({
								session,
								query,
								pipeline,
								profileOverride,
								timeoutMs,
							}),
						);
					} catch (error) {
						console.error(`  ${query.id}: ${String(error)}`);
						results.push({
							query,
							pipeline,
							reportedPipelineVersion: null,
							status: "error",
							error: String(error),
							wallMs: 0,
							usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
							markdown: null,
							phaseDurationsMs: null,
							metrics: computeMetrics({
								markdown: null,
								evidence: undefined,
							}),
						});
					}
				}
			},
		);
		await Promise.all(workers);
	}

	// Layer 2 runs AFTER every report is in hand, sequentially: the judge shares
	// the deployment's model with nothing else at that point, and one judge call
	// per report is cheap next to the reports themselves.
	if (args.judge === "true") {
		console.log("\nJudging the reports against the rubric.");
		for (const result of results) {
			if (!result.markdown) continue;
			result.metrics.judge = await judgeReport({
				session,
				query: result.query,
				markdown: result.markdown,
			});
			const judged = result.metrics.judge;
			console.log(
				`  ${result.pipeline}-${result.query.id}: ${
					judged.average === null
						? "no usable score"
						: judged.average.toFixed(2)
				} over ${judged.scores.length} dimension(s), ${judged.discarded} discarded`,
			);
		}
	}

	mkdirSync(outDir, { recursive: true });
	for (const result of results) {
		if (!result.markdown) continue;
		writeFileSync(
			resolve(outDir, `${result.pipeline}-${result.query.id}.md`),
			result.markdown,
			"utf8",
		);
	}
	const reportPath = resolve(outDir, "report.md");
	writeFileSync(reportPath, buildMarkdownReport(results), "utf8");
	writeFileSync(
		resolve(outDir, "results.json"),
		JSON.stringify(
			results.map(({ markdown: _markdown, ...rest }) => rest),
			null,
			2,
		),
		"utf8",
	);
	console.log(`\nWrote ${reportPath}`);

	const failures = results.filter((result) => result.status !== "succeeded");
	if (failures.length > 0) {
		console.error(
			`${failures.length} of ${results.length} runs did not succeed.`,
		);
		process.exitCode = 1;
	}
}

function waitForEnter(): Promise<void> {
	if (!process.stdin.isTTY) return Promise.resolve();
	return new Promise((done) => {
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.pause();
			done();
		});
	});
}

// Exported for the unit test; the script body only runs when invoked directly.
export {
	buildMarkdownReport,
	CONFIDENCE_MARKS,
	claimsPerThousandWords,
	computeMetrics,
	coreAnswerPresent,
	countHeadings,
	crossSectionRepeatCount,
	describeWordBudget,
	executiveSummarySection,
	junkSourceNotes,
	numberAppearsIn,
	numbersIn,
	parseJudgeAnswer,
	repeatedFactCount,
	reportBody,
	sectionsCell,
	tableExpectedFor,
	tablePresent,
	verdictInWindow,
	verdictSection,
	volatileDateCoverage,
	WORD_BUDGETS,
};

const invokedDirectly = process.argv[1]?.endsWith("atlas-eval.ts");
if (invokedDirectly) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
