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
}

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
function numbersIn(text: string): string[] {
	const stripped = text.replace(CITATION_PATTERN, " ").replace(/[ᶜˢⁱ]/g, " ");
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

function sentencesOf(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÖŐÚÜŰ0-9])/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

function computeMetrics(input: {
	markdown: string | null;
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
					unmatchedNumberNotes.push(
						`"${number}" in: ${sentence.slice(0, 180)}`,
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
	};
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
	const { session, query } = input;
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
				atlasProfile: input.profileOverride ?? query.profile,
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
		metrics: computeMetrics({
			markdown,
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
		"| Query | Kind | Pipeline | Status | Wall | Tokens in/out | Words | Citations | Cites/100w | Resolved | Numbers matched | Corroborated | Cut | Sources (cited) | Filtered | Junk |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];

	for (const result of results) {
		const metrics = result.metrics;
		const applies = result.pipeline === "v2";
		lines.push(
			`| ${result.query.id} | ${result.query.kind} | ${result.pipeline} | ${result.status} | ${minutes(result.wallMs)} | ${result.usage.inputTokens}/${result.usage.outputTokens} | ${metrics.wordCount} | ${metrics.citationCount} | ${metrics.citationDensity.toFixed(1)} | ${applies ? percent(metrics.citationResolutionRate) : "n/a"} | ${applies ? `${percent(metrics.numberMatchRate)} (${metrics.numbersMatched}/${metrics.numbersChecked})` : "n/a"} | ${applies ? percent(metrics.corroborationRate) : "n/a"} | ${applies ? metrics.cutCount : "n/a"} | ${metrics.sourceCount} (${metrics.citedSourceCount}) | ${metrics.filteredCount} | ${metrics.junkSourceCount} |`,
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
		lines.push(
			`- **${pipeline}**: ${succeeded.length}/${bucket.length} succeeded · ${minutes(totalWall)} total · ${totalTokens} tokens · ${density.toFixed(1)} citations per 100 words · ${junk} junk sources`,
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
	junkSourceNotes,
	numberAppearsIn,
	numbersIn,
	reportBody,
};

const invokedDirectly = process.argv[1]?.endsWith("atlas-eval.ts");
if (invokedDirectly) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
