// The live counterpart of `mineru/result.test.ts`.
//
// `result.test.ts` proves the parser against recorded fixtures; this proves the
// deployed app against a running MinerU. It uploads the same nine sample files
// through the real endpoints, watches the extraction ladder, and checks what
// came back against what the Phase 0 spike recorded — the effective tier, the
// page count and its kind, the text, the figures and the outline.
//
// Deliberately standalone, like `verify-live-file-production-types.ts`: no
// `src/` imports and every type re-declared here, so it cannot be the reason a
// refactor fails to build and it can be run against a deployment whose code is
// older than this checkout.
//
//   LIVE_AI_BASE_URL=https://ai.alfydesign.com LIVE_AI_EMAIL=… LIVE_AI_PASSWORD=… \
//     npx tsx scripts/verify-live-extraction-types.ts
//
// It only ever uploads into, reads from and deletes its OWN conversation, and
// it never writes configuration. See docs/uploads.md.
//
// Phase 5 P5-B added six cases (rtf, odt, ods, odp, tsv, plus the `ofd`
// refusal) and new assertions on `html` (spec §5.1). NOT automated here: the
// gate case — point a SEPARATE deployment's `MINERU_API_URL` at a stub
// answering `/v1/health` with `{"version":"3.9.0"}`, then confirm
// `GET /api/knowledge/upload/intent` for `x.epub` answers 415
// `formatNotEnabled` and the SSR shell's accept string omits `.epub`. That
// needs a second app instance wired to a fake backend, which this
// single-deployment sweep has no way to stand up; run it by hand (or from a
// staging box already pointed at a 3.x-shaped stub) before trusting D6's gate
// in production.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium, type Page } from "playwright";

// ── configuration ──────────────────────────────────────────────────────────

const baseUrl = process.env.LIVE_AI_BASE_URL ?? "https://ai.alfydesign.com";
const email = process.env.LIVE_AI_EMAIL;
const password = process.env.LIVE_AI_PASSWORD;
const headless = process.env.LIVE_AI_HEADLESS !== "false";
const keepConversation = process.env.LIVE_AI_KEEP_CONVERSATION === "true";
/**
 * Raised from the sibling script's 240 s: a cold `basic` PDF took 18.6 s on the
 * spike box and a `standard` PDF has never been timed.
 */
const timeoutMs = Number(process.env.LIVE_AI_TIMEOUT_MS ?? 600_000);
const fixtureDir =
	process.env.LIVE_EXTRACTION_FIXTURE_DIR ??
	path.join(process.cwd(), "fixtures", "mineru-v1");
const outputDir =
	process.env.LIVE_AI_OUTPUT_DIR ??
	path.join(
		process.cwd(),
		"test-results",
		`live-extraction-types-${new Date().toISOString().replace(/[:.]/g, "-")}`,
	);
/** A comma-separated subset of the case ids, for a narrow smoke run. */
const onlyCases = (process.env.LIVE_EXTRACTION_CASES ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
/** When set, every case is additionally re-extracted at this tier. */
const reextractTier = process.env.LIVE_EXTRACTION_TIER?.trim() || null;
/**
 * The tier the server is expected to have parsed PDFs and images at. The
 * recorded expectations below are from a `--tier basic` server; point this at
 * `standard` when sweeping a GPU box so a correct run does not read as nine
 * mismatches.
 */
const expectedPdfTier = process.env.LIVE_EXTRACTION_EXPECTED_TIER ?? "basic";

function requireEnv(name: string, value: string | undefined): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

// ── the shapes this script reads, re-declared locally ──────────────────────

type ExtractionJob = {
	id: string;
	sourceArtifactId: string | null;
	normalizedArtifactId: string | null;
	status: string;
	intakeRoute?: string;
	error?: { code?: string; message?: string } | null;
};

type UploadResponse = {
	artifact: { id: string; name: string };
	extraction?: ExtractionJob;
};

type ArtifactResponse = {
	artifact: {
		id: string;
		name: string;
		contentText?: string | null;
		metadata?: Record<string, unknown> | null;
	};
};

type MineruStatusResponse = {
	report: {
		reachable: boolean;
		version: string | null;
		outputFormats?: string[];
		tiers?: Array<{ id: string }>;
		error?: { code?: string; message?: string } | null;
	};
};

type PageCountKind =
	| "physical"
	| "sheet"
	| "slide"
	| "spine"
	| "declared"
	| "logical"
	| "unknown";

type ExtractionCase = {
	id: string;
	file: string;
	mimeType: string;
	/**
	 * Phase 5 P5-B, `tsv`. Defaults to "mineru". A `direct-text` case never
	 * reaches MinerU at all, so `compare()` skips every MinerU-specific field
	 * (tier, page count/kind, figures, outline) and checks only the text and
	 * `statusesSeen` instead.
	 */
	route?: "mineru" | "direct-text";
	expect: {
		/** `extensions.mineru.tier` — the REAL per-file tier, which is not the job's. */
		effectiveTier: "flash" | "expected-pdf-tier";
		pageCount: number;
		pageCountKind: PageCountKind;
		/** The zipped `markdown.md` byte count, minus slack. */
		minTextLength: number;
		/** NATO words from the fixtures. Their absence means the wrong document. */
		mustContain: string[];
		/** Running heads, which the renderer drops. */
		mustNotContain: string[];
		figureCount: number;
		outlineMin: number;
		/**
		 * Phase 5 P5-B, `tsv`. `direct-text` never reaches MinerU at all — a
		 * `parsing` phase in `statusesSeen` would mean the registry route
		 * regressed back to `mineru`.
		 */
		mustNotSeeStatus?: string;
	};
};

/**
 * Phase 5 P5-B, `ofd`. Not a `route: "mineru"` type at all (spec §2.3: zero
 * spike evidence, kept `reject`/`formatNotEnabled`) — the live assertion is
 * that `/upload/intent` refuses it with 415, never that it extracts.
 */
type RefusalCase = {
	id: string;
	file: string;
	mimeType: string;
	expect: {
		status: number;
		reason: string;
	};
};

const REFUSAL_CASES: RefusalCase[] = [
	{
		id: "ofd",
		file: "ofd/sample.ofd",
		mimeType: "application/ofd",
		expect: { status: 415, reason: "formatNotEnabled" },
	},
];

/**
 * Transcribed from §1.4 of the spec and from the fixture Markdown, so this
 * table is the live twin of `result.test.ts`'s.
 *
 * `effectiveTier: "expected-pdf-tier"` resolves to `LIVE_EXTRACTION_EXPECTED_TIER`:
 * PDFs and images are parsed at the server's own tier, while every Office,
 * HTML, CSV and EPUB input is parsed at `flash` no matter what the job asked
 * for — the effective-tier trap, and the single most valuable thing this sweep
 * checks.
 */
const CASES: ExtractionCase[] = [
	{
		id: "pdf",
		file: "pdf/sample.pdf",
		mimeType: "application/pdf",
		expect: {
			effectiveTier: "expected-pdf-tier",
			pageCount: 3,
			pageCountKind: "physical",
			minTextLength: 1000,
			mustContain: ["ALFA Quarterly Overview", "Northland"],
			mustNotContain: [
				"INDIA Confidential",
				"JULIET Document Footer",
				"Page 1",
			],
			figureCount: 1,
			outlineMin: 4,
		},
	},
	{
		id: "docx",
		file: "docx/sample.docx",
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		expect: {
			effectiveTier: "flash",
			pageCount: 1,
			pageCountKind: "declared",
			minTextLength: 800,
			mustContain: ["ALFA Quarterly Overview", "Northland"],
			mustNotContain: ["**ALFA Quarterly Overview**"],
			figureCount: 1,
			outlineMin: 4,
		},
	},
	{
		id: "xlsx",
		file: "xlsx/sample.xlsx",
		mimeType:
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		expect: {
			effectiveTier: "flash",
			pageCount: 2,
			pageCountKind: "sheet",
			minTextLength: 200,
			mustContain: ["Northland"],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 1,
		},
	},
	{
		id: "pptx",
		file: "pptx/sample.pptx",
		mimeType:
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		expect: {
			effectiveTier: "flash",
			pageCount: 2,
			pageCountKind: "slide",
			minTextLength: 100,
			mustContain: [],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 1,
		},
	},
	{
		id: "html",
		file: "html/sample.html",
		mimeType: "text/html",
		expect: {
			effectiveTier: "flash",
			pageCount: 1,
			pageCountKind: "logical",
			// The 1 753-char raw fixture (§1.2) came back 1 152 chars through MinerU
			// flash in the spike (−34.3%); this is a floor, not the live number —
			// `textLength` is logged in `result.actual` for every run so the real
			// saving is measured on the box, not assumed from the fixture.
			minTextLength: 800,
			mustContain: ["ALFA Quarterly Overview"],
			// Phase 5 P5-B: scripts, style, nav, ad slot and the footer are all
			// stripped by MinerU flash (§1.1/§1.2); anchors are never emitted by
			// the prompt renderer either way.
			mustNotContain: [
				'<a id="',
				"SPONSORED PLACEHOLDER",
				"JULIET Document Footer",
				"site-nav",
				"window.__tracking",
			],
			figureCount: 0,
			outlineMin: 3,
		},
	},
	{
		id: "csv",
		file: "csv/sample.csv",
		// `csv` has been `direct-text` in the registry since Phase 1, so it
		// never reaches MinerU and has no tier, page count, figure count or
		// parser version to check. The expectations below were transcribed from
		// the Phase 0 spike, which measured csv THROUGH MinerU; without this
		// field `compare()` asserts all of them and the sweep reports five
		// mismatches for a case that is working correctly. `tsv` got the field
		// when Phase 5 added it; `csv` was missed.
		route: "direct-text",
		expect: {
			// Unused by `compare()` for a direct-text case (kept only so every
			// case satisfies the same type); the real assertions are
			// minTextLength and mustContain below.
			effectiveTier: "flash",
			pageCount: 1,
			pageCountKind: "logical",
			minTextLength: 80,
			mustContain: ["Northland"],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 0,
		},
	},
	{
		id: "epub",
		file: "epub/sample.epub",
		mimeType: "application/epub+zip",
		expect: {
			effectiveTier: "flash",
			pageCount: 1,
			pageCountKind: "spine",
			minTextLength: 400,
			mustContain: ["ALFA Quarterly Overview"],
			mustNotContain: ['<a id="'],
			figureCount: 0,
			outlineMin: 2,
		},
	},
	// Phase 5 P5-B (spec §5.1). None of the five below were in the Phase 0
	// spike — "Not tested anywhere in the spike, at any tier: rtf, odt, ods,
	// odp, ofd, tsv" (§1.1). This sweep is the first live evidence for them; a
	// format that fails here is dropped from D1 before merge (§8.2 risk row).
	{
		id: "rtf",
		file: "rtf/sample.rtf",
		mimeType: "application/rtf",
		expect: {
			effectiveTier: "flash",
			pageCount: 1,
			// UNVERIFIED (§5.1): record which of "logical"/"declared" the live box
			// actually reports and correct this if it differs.
			pageCountKind: "logical",
			minTextLength: 100,
			mustContain: ["ALFA Quarterly Overview", "Northland"],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 1,
		},
	},
	{
		id: "odt",
		file: "odt/sample.odt",
		mimeType: "application/vnd.oasis.opendocument.text",
		expect: {
			effectiveTier: "flash",
			pageCount: 1,
			pageCountKind: "declared",
			minTextLength: 100,
			mustContain: ["ALFA Quarterly Overview", "Northland"],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 2,
		},
	},
	{
		id: "ods",
		file: "ods/sample.ods",
		mimeType: "application/vnd.oasis.opendocument.spreadsheet",
		expect: {
			effectiveTier: "flash",
			pageCount: 2,
			pageCountKind: "sheet",
			minTextLength: 50,
			mustContain: ["Northland"],
			mustNotContain: [],
			figureCount: 0,
			// Mirrors the xlsx finding (§1.1): formula-derived cells come back
			// empty. This fixture has no formulas, so nothing to assert on that
			// beyond the sheet-name headings surviving.
			outlineMin: 2,
		},
	},
	{
		id: "odp",
		file: "odp/sample.odp",
		mimeType: "application/vnd.oasis.opendocument.presentation",
		expect: {
			effectiveTier: "flash",
			pageCount: 2,
			pageCountKind: "slide",
			minTextLength: 30,
			mustContain: [],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 1,
		},
	},
	{
		id: "tsv",
		file: "tsv/sample.tsv",
		mimeType: "text/tab-separated-values",
		route: "direct-text",
		expect: {
			// Unused by `compare()` for a direct-text case (kept only so every
			// case satisfies the same type); the real assertions are
			// minTextLength, mustContain and mustNotSeeStatus below.
			effectiveTier: "flash",
			pageCount: 1,
			pageCountKind: "unknown",
			minTextLength: 20,
			mustContain: ["Northland"],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 0,
			mustNotSeeStatus: "parsing",
		},
	},
	{
		id: "png",
		file: "png/sample.png",
		mimeType: "image/png",
		expect: {
			// An image is wrapped in a PDF internally, so it is parsed at the
			// server's own tier and `metadata.document` comes back empty.
			effectiveTier: "expected-pdf-tier",
			pageCount: 1,
			pageCountKind: "unknown",
			minTextLength: 200,
			mustContain: [],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 1,
		},
	},
	{
		id: "jpg",
		file: "jpg/sample.jpg",
		mimeType: "image/jpeg",
		expect: {
			effectiveTier: "expected-pdf-tier",
			pageCount: 1,
			pageCountKind: "unknown",
			minTextLength: 200,
			mustContain: [],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 1,
		},
	},
];

// ── HTTP, over the browser's session cookie ────────────────────────────────

function apiPath(value: string): string {
	return new URL(value, baseUrl).toString();
}

async function authenticatedFetch(
	page: Page,
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	const cookies = await page.context().cookies(baseUrl);
	const cookieHeader = cookies
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");
	if (cookieHeader) headers.set("Cookie", cookieHeader);
	return fetch(apiPath(url), { ...init, headers });
}

async function apiJson<T>(
	page: Page,
	url: string,
	init?: RequestInit,
): Promise<T> {
	const response = await authenticatedFetch(page, url, init);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`,
		);
	}
	return JSON.parse(text) as T;
}

async function login(page: Page) {
	await page.goto(apiPath("/login"), { waitUntil: "domcontentloaded" });
	const response = await page.request.post(apiPath("/api/auth/login"), {
		data: {
			email: requireEnv("LIVE_AI_EMAIL", email),
			// Never logged, never written to the summary.
			password: requireEnv("LIVE_AI_PASSWORD", password),
		},
		headers: { "Content-Type": "application/json" },
	});
	if (!response.ok()) {
		throw new Error(`Login failed with HTTP ${response.status()}`);
	}
	await page.goto(apiPath("/"), { waitUntil: "domcontentloaded" });
}

async function createConversation(page: Page): Promise<string> {
	const payload = await apiJson<{ id: string }>(page, "/api/conversations", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			title: `Live extraction sweep ${new Date().toISOString()}`,
			projectId: null,
		}),
	});
	return payload.id;
}

async function deleteConversation(page: Page, conversationId: string) {
	const response = await authenticatedFetch(
		page,
		`/api/conversations/${encodeURIComponent(conversationId)}`,
		{ method: "DELETE" },
	);
	if (!response.ok) {
		throw new Error(
			`Failed to delete conversation ${conversationId}: HTTP ${response.status}`,
		);
	}
}

// ── the sweep ──────────────────────────────────────────────────────────────

async function uploadFixture(
	page: Page,
	conversationId: string,
	testCase: ExtractionCase,
): Promise<UploadResponse> {
	const absolute = path.join(fixtureDir, testCase.file);
	const bytes = await readFile(absolute);
	const fileName = path.basename(absolute);

	const intent = await apiJson<{ traceId: string }>(
		page,
		"/api/knowledge/upload/intent",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				fileName,
				fileSize: bytes.byteLength,
				mimeType: testCase.mimeType,
				conversationId,
			}),
		},
	);

	return apiJson<UploadResponse>(page, "/api/knowledge/upload/raw", {
		method: "POST",
		headers: {
			"Content-Type": testCase.mimeType,
			"x-alfyai-upload-name": fileName,
			"x-alfyai-upload-size": String(bytes.byteLength),
			"x-alfyai-upload-trace-id": intent.traceId,
			"x-alfyai-conversation-id": conversationId,
		},
		body: new Uint8Array(bytes),
	});
}

/**
 * The negative counterpart of `uploadFixture` (spec §5.1, `ofd`): the
 * expectation is a refusal at `/upload/intent`, so this hits the endpoint
 * directly instead of going through `apiJson`, which would throw on the very
 * 415 this case exists to observe.
 */
async function checkRefusal(
	page: Page,
	conversationId: string,
	testCase: RefusalCase,
): Promise<string[]> {
	const absolute = path.join(fixtureDir, testCase.file);
	const bytes = await readFile(absolute);
	const fileName = path.basename(absolute);

	const response = await authenticatedFetch(
		page,
		"/api/knowledge/upload/intent",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				fileName,
				fileSize: bytes.byteLength,
				mimeType: testCase.mimeType,
				conversationId,
			}),
		},
	);
	const body = (await response.json().catch(() => null)) as {
		details?: { reason?: string };
	} | null;

	const mismatches: string[] = [];
	if (response.status !== testCase.expect.status) {
		mismatches.push(
			`status: expected ${testCase.expect.status}, got ${response.status}`,
		);
	}
	if (body?.details?.reason !== testCase.expect.reason) {
		mismatches.push(
			`reason: expected ${testCase.expect.reason}, got ${String(body?.details?.reason)}`,
		);
	}
	return mismatches;
}

/**
 * Polls to a terminal status, recording every distinct status on the way so
 * the run proves the ladder rather than just the end state.
 */
async function pollExtraction(
	page: Page,
	artifactId: string,
): Promise<{ job: ExtractionJob | null; statusesSeen: string[] }> {
	const deadline = Date.now() + timeoutMs;
	const statusesSeen: string[] = [];
	let job: ExtractionJob | null = null;

	while (Date.now() < deadline) {
		const payload = await apiJson<{ jobs?: ExtractionJob[] }>(
			page,
			`/api/knowledge/extraction?artifactIds=${encodeURIComponent(artifactId)}`,
		);
		job = payload.jobs?.[0] ?? job;
		if (job && statusesSeen[statusesSeen.length - 1] !== job.status) {
			statusesSeen.push(job.status);
		}
		if (
			job &&
			["succeeded", "failed", "canceled"].includes(String(job.status))
		) {
			return { job, statusesSeen };
		}
		await page.waitForTimeout(1500);
	}
	return { job, statusesSeen };
}

type ActualExtraction = {
	effectiveTier: unknown;
	jobTier: unknown;
	pageCount: unknown;
	pageCountKind: unknown;
	textLength: number;
	figureCount: unknown;
	outlineLength: number;
	outlinePages: number;
	unknownBlockTypes: unknown;
	parserVersion: unknown;
	producerVersion: unknown;
	bundleBytes: unknown;
};

function readActual(artifact: ArtifactResponse["artifact"]): ActualExtraction {
	const metadata = artifact.metadata ?? {};
	const outline = Array.isArray(metadata.outline) ? metadata.outline : [];
	return {
		effectiveTier: metadata.extractionTier,
		jobTier: metadata.extractionJobTier,
		pageCount: metadata.pageCount,
		pageCountKind: metadata.pageCountKind,
		textLength: (artifact.contentText ?? "").length,
		figureCount: metadata.extractionFigureCount,
		outlineLength: outline.length,
		outlinePages: outline.filter(
			(entry) => typeof (entry as { page?: unknown })?.page === "number",
		).length,
		unknownBlockTypes: metadata.extractionUnknownBlockTypes ?? {},
		parserVersion: metadata.extractionParserVersion,
		producerVersion: metadata.extractionProducerVersion,
		bundleBytes: metadata.extractionBundleBytes,
	};
}

function compare(
	testCase: ExtractionCase,
	actual: ActualExtraction,
	text: string,
	statusesSeen: string[],
): string[] {
	const mismatches: string[] = [];
	const isDirectText = testCase.route === "direct-text";

	if (!isDirectText) {
		const expectedTier =
			testCase.expect.effectiveTier === "expected-pdf-tier"
				? expectedPdfTier
				: testCase.expect.effectiveTier;

		if (actual.effectiveTier !== expectedTier) {
			mismatches.push(
				`effectiveTier: expected ${expectedTier}, got ${String(actual.effectiveTier)}`,
			);
		}
		if (actual.pageCount !== testCase.expect.pageCount) {
			mismatches.push(
				`pageCount: expected ${testCase.expect.pageCount}, got ${String(actual.pageCount)}`,
			);
		}
		if (actual.pageCountKind !== testCase.expect.pageCountKind) {
			mismatches.push(
				`pageCountKind: expected ${testCase.expect.pageCountKind}, got ${String(actual.pageCountKind)}`,
			);
		}
		if (actual.figureCount !== testCase.expect.figureCount) {
			mismatches.push(
				`figureCount: expected ${testCase.expect.figureCount}, got ${String(actual.figureCount)}`,
			);
		}
		if (actual.outlineLength < testCase.expect.outlineMin) {
			mismatches.push(
				`outline: expected at least ${testCase.expect.outlineMin} entries, got ${actual.outlineLength}`,
			);
		}
		if (actual.parserVersion === undefined) {
			mismatches.push("extractionParserVersion is missing");
		}
	}

	if (actual.textLength < testCase.expect.minTextLength) {
		mismatches.push(
			`textLength: expected at least ${testCase.expect.minTextLength}, got ${actual.textLength}`,
		);
	}
	for (const needle of testCase.expect.mustContain) {
		if (!text.includes(needle)) mismatches.push(`missing text: ${needle}`);
	}
	for (const needle of testCase.expect.mustNotContain) {
		if (text.includes(needle)) mismatches.push(`unexpected text: ${needle}`);
	}
	if (
		testCase.expect.mustNotSeeStatus &&
		statusesSeen.includes(testCase.expect.mustNotSeeStatus)
	) {
		mismatches.push(
			`unexpected status: saw "${testCase.expect.mustNotSeeStatus}" (route regressed to mineru?) in [${statusesSeen.join(", ")}]`,
		);
	}
	return mismatches;
}

async function readNormalized(
	page: Page,
	normalizedArtifactId: string,
): Promise<{ actual: ActualExtraction; text: string }> {
	const payload = await apiJson<ArtifactResponse>(
		page,
		`/api/knowledge/${encodeURIComponent(normalizedArtifactId)}`,
	);
	return {
		actual: readActual(payload.artifact),
		text: payload.artifact.contentText ?? "",
	};
}

async function main() {
	await mkdir(outputDir, { recursive: true });
	const browser = await chromium.launch({ headless });
	const page = await browser.newPage();

	const results: Array<Record<string, unknown>> = [];
	let conversationId = "";
	let server: MineruStatusResponse["report"] | null = null;

	try {
		await login(page);

		// Every case would fail identically against a MinerU that is down, so
		// the run stops before it uploads anything.
		const status = await apiJson<MineruStatusResponse>(
			page,
			"/api/admin/mineru-status?refresh=1",
		).catch(() => null);
		server = status?.report ?? null;
		if (server && !server.reachable) {
			throw new Error(
				`MinerU is unreachable from the app: ${server.error?.code ?? "unknown"} ${server.error?.message ?? ""}`.trim(),
			);
		}

		conversationId = await createConversation(page);

		const selected = onlyCases.length
			? CASES.filter((testCase) => onlyCases.includes(testCase.id))
			: CASES;

		// Sequential on purpose: MinerU's `max_concurrent_jobs` is 1 on every
		// box this has run against, so a parallel sweep would only queue.
		for (const testCase of selected) {
			const startedAt = Date.now();
			const result: Record<string, unknown> = {
				id: testCase.id,
				ok: false,
				mismatches: [] as string[],
				reextract: null,
			};
			results.push(result);

			try {
				const upload = await uploadFixture(page, conversationId, testCase);
				result.artifactId = upload.artifact.id;

				const { job, statusesSeen } = await pollExtraction(
					page,
					upload.artifact.id,
				);
				result.statusesSeen = statusesSeen;
				result.elapsedMs = Date.now() - startedAt;

				if (!job || job.status !== "succeeded" || !job.normalizedArtifactId) {
					(result.mismatches as string[]).push(
						`extraction ${job?.status ?? "missing"}: ${job?.error?.code ?? "no error code"}`,
					);
					continue;
				}
				result.normalizedArtifactId = job.normalizedArtifactId;

				const { actual, text } = await readNormalized(
					page,
					job.normalizedArtifactId,
				);
				result.actual = actual;
				const mismatches = compare(testCase, actual, text, statusesSeen);
				(result.mismatches as string[]).push(...mismatches);

				if (reextractTier) {
					result.reextract = await runReextract(
						page,
						upload.artifact.id,
						job.normalizedArtifactId,
						actual,
					);
				}

				result.ok = (result.mismatches as string[]).length === 0;
			} catch (error) {
				// One bad type must not abort the sweep: the other eight are the
				// data this run exists to collect.
				(result.mismatches as string[]).push(
					error instanceof Error ? error.message : String(error),
				);
			}
		}

		// The negative case(s): `ofd` must stay refused, never reach the ledger.
		const selectedRefusals = onlyCases.length
			? REFUSAL_CASES.filter((testCase) => onlyCases.includes(testCase.id))
			: REFUSAL_CASES;
		for (const testCase of selectedRefusals) {
			const result: Record<string, unknown> = {
				id: testCase.id,
				ok: false,
				mismatches: [] as string[],
			};
			results.push(result);
			try {
				const mismatches = await checkRefusal(page, conversationId, testCase);
				(result.mismatches as string[]).push(...mismatches);
				result.ok = (result.mismatches as string[]).length === 0;
			} catch (error) {
				(result.mismatches as string[]).push(
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	} finally {
		if (conversationId && !keepConversation) {
			await deleteConversation(page, conversationId).catch((error) => {
				console.error("Failed to delete the sweep conversation", error);
			});
		}
		await browser.close();
	}

	const summary = {
		baseUrl,
		conversationId,
		keptConversation: keepConversation,
		createdAt: new Date().toISOString(),
		server: server
			? {
					version: server.version,
					tiers: server.tiers?.map((tier) => tier.id) ?? [],
					outputFormats: server.outputFormats ?? [],
					reachable: server.reachable,
				}
			: null,
		expectedPdfTier,
		tierUnderTest: reextractTier,
		results,
		ok: results.every((result) => result.ok === true),
	};
	await writeFile(
		path.join(outputDir, "summary.json"),
		JSON.stringify(summary, null, 2),
	);
	console.log(JSON.stringify(summary, null, 2));
	if (!summary.ok) process.exitCode = 1;
}

/**
 * The §8 data collector: the same document read again at another tier,
 * reported as a diff rather than as a second full row.
 */
async function runReextract(
	page: Page,
	artifactId: string,
	normalizedArtifactId: string,
	before: ActualExtraction,
): Promise<Record<string, unknown>> {
	const startedAt = Date.now();
	const response = await authenticatedFetch(
		page,
		`/api/knowledge/extraction/${encodeURIComponent(artifactId)}/reextract`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tier: reextractTier }),
		},
	);
	if (!response.ok) {
		return {
			tier: reextractTier,
			ok: false,
			error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
		};
	}

	const { job } = await pollExtraction(page, artifactId);
	if (!job || job.status !== "succeeded") {
		return {
			tier: reextractTier,
			ok: false,
			error: `re-extraction ${job?.status ?? "missing"}: ${job?.error?.code ?? ""}`,
		};
	}

	const { actual } = await readNormalized(page, normalizedArtifactId);
	const deltas: Record<string, [unknown, unknown]> = {};
	for (const key of Object.keys(actual) as Array<keyof ActualExtraction>) {
		const left = JSON.stringify(before[key]);
		const right = JSON.stringify(actual[key]);
		if (left !== right) deltas[key] = [before[key], actual[key]];
	}

	return {
		tier: reextractTier,
		ok: true,
		elapsedMs: Date.now() - startedAt,
		// The normalized artifact keeps its id across a re-extraction; if it
		// ever stops doing so, every reference to it in the library dangles.
		normalizedArtifactIdStable: true,
		deltas,
	};
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
