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
 *   --pipeline v1|v2|both   Which pipeline to measure (default: both).
 *   --queries <ids>         Comma-separated query ids to run (default: all).
 *   --profile <p>           Override every query's profile.
 *   --timeout <minutes>     Per-job timeout (default: 45).
 *   --out <dir>             Where to write the report (default: ./atlas-eval).
 *   --concurrency <n>       Jobs in flight at once (default: 1).
 *
 * IMPORTANT: switching pipelines is an ADMIN CONFIG change on the deployment
 * (ATLAS_PIPELINE=v1|v2) and this script does NOT make it. Set the flag, run
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
	pipelineVersion?: 1 | 2;
	progress?: {
		percent: number;
		stage: string;
		details?: {
			pipelineVersion?: number;
			phase?: string;
			sourcesRead?: number;
			/** Per-phase wall time, present from the write phase onwards on v2. */
			phaseDurationsMs?: Record<string, number>;
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
	pipeline: "v1" | "v2";
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
	/** Words against the profile budget: "ok", "over by n" or "under by n". */
	wordBudget: string;
	wordBudgetOk: boolean;
	sectionCount: number;
	/** Did the report answer the question that was asked? Null when unchecked. */
	coreAnswerPresent: boolean | null;
	/** Disagreement lines in Limitations; the pipeline caps these at 3. */
	contradictionLineCount: number;
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
	const match =
		/\n#{1,3}\s*(?:Executive summary|Vezetői összefoglaló)\b([\s\S]*?)(?=\n#{1,3}\s|$)/i.exec(
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

/** Body sections, not counting the summary, Limitations or Sources chrome. */
function countHeadings(markdown: string): number {
	return [...markdown.matchAll(/^#{2,3}[ \t]+(.+)$/gm)].filter(
		(match) =>
			!/^(executive summary|vezetői összefoglaló|limitations|korlátok|sources|források)/i.test(
				match[1].trim(),
			),
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

/** "ok", or how far outside the profile band the report landed. */
function describeWordBudget(
	wordCount: number,
	profile: EvalQuery["profile"],
): { label: string; ok: boolean } {
	const band = WORD_BUDGETS[profile];
	if (wordCount > band.max) {
		return { label: `over by ${wordCount - band.max}`, ok: false };
	}
	if (wordCount < band.min) {
		return { label: `under by ${band.min - wordCount}`, ok: false };
	}
	return { label: "ok", ok: true };
}

function sentencesOf(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÖŐÚÜŰ0-9])/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

function computeMetrics(input: {
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
		sectionCount: 0,
		coreAnswerPresent: null,
		contradictionLineCount: 0,
	};
	if (!input.markdown) return empty;

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
		for (const sentence of sentencesOf(body)) {
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
		sectionCount: countHeadings(input.markdown),
		coreAnswerPresent: input.query
			? coreAnswerPresent({ markdown: input.markdown, query: input.query })
			: null,
		contradictionLineCount,
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
// Running one query
// ---------------------------------------------------------------------------

async function runQuery(input: {
	session: Session;
	query: EvalQuery;
	pipeline: "v1" | "v2";
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
		}),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

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
		"| Query | Kind | Pipeline | Profile | Status | Wall | Tokens in/out | Words | Budget | Sections | Core answer | Citations | Cites/100w | Resolved | Numbers matched | Corroborated | Cut | Disagreements | Sources (cited) | Filtered | Junk |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];

	for (const result of results) {
		const metrics = result.metrics;
		const applies = result.pipeline === "v2";
		const coreAnswer =
			metrics.coreAnswerPresent === null
				? "n/a"
				: metrics.coreAnswerPresent
					? "yes"
					: "**NO**";
		lines.push(
			`| ${result.query.id} | ${result.query.kind} | ${result.pipeline} | ${result.query.profile} | ${result.status} | ${minutes(result.wallMs)} | ${result.usage.inputTokens}/${result.usage.outputTokens} | ${metrics.wordCount} | ${metrics.wordBudgetOk ? "ok" : `**${metrics.wordBudget}**`} | ${metrics.sectionCount} | ${coreAnswer} | ${metrics.citationCount} | ${metrics.citationDensity.toFixed(1)} | ${applies ? percent(metrics.citationResolutionRate) : "n/a"} | ${applies ? `${percent(metrics.numberMatchRate)} (${metrics.numbersMatched}/${metrics.numbersChecked})` : "n/a"} | ${applies ? percent(metrics.corroborationRate) : "n/a"} | ${applies ? metrics.cutCount : "n/a"} | ${metrics.contradictionLineCount} | ${metrics.sourceCount} (${metrics.citedSourceCount}) | ${metrics.filteredCount} | ${metrics.junkSourceCount} |`,
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
			`**Length:** ${result.metrics.wordCount} words against the ${result.query.profile} budget (${WORD_BUDGETS[result.query.profile].min}-${WORD_BUDGETS[result.query.profile].max}) — ${result.metrics.wordBudget}; ${result.metrics.sectionCount} sections.`,
			"",
		);
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

	const pipelines: Array<"v1" | "v2"> =
		args.pipeline === "v1"
			? ["v1"]
			: args.pipeline === "v2"
				? ["v2"]
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
	computeMetrics,
	coreAnswerPresent,
	describeWordBudget,
	executiveSummarySection,
	junkSourceNotes,
	numberAppearsIn,
	numbersIn,
	reportBody,
	WORD_BUDGETS,
};

const invokedDirectly = process.argv[1]?.endsWith("atlas-eval.ts");
if (invokedDirectly) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
