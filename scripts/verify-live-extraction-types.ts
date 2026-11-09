// The live counterpart of `mineru/result.test.ts`.
//
// `result.test.ts` proves the parser against recorded fixtures; this proves the
// deployed app against a running MinerU 4.1. It uploads the sample files
// through the real endpoints, watches the extraction ladder, and checks what
// came back against what was recorded — the MinerU version that answered, the
// app's parser version, the effective tier, the page count and its kind, the
// text, the figures and the outline.
//
// Two groups of expectations, and the difference matters when one fails:
//   - `v1`: `fixtures/mineru-v1/<id>/sample.*`, the 4.0.4 spike's samples. Their
//     page counts, figures and outlines were read off that server's output;
//     nobody had run MinerU 4.1.7 on these exact files when this was written, so
//     a mismatch there is first a question about the expectation.
//   - `plan41`: the 4.1.7 spike's own inputs
//     (`docs/plans/mineru-4-1/fixtures/inputs`), with expectations taken from
//     its captured answers and run through the app's own parser (spike report
//     §7, `fixtures/mineru-v41/results`). The two TIFFs are the exception: they
//     are the v1 PNG sample converted (`sips -s format tiff`, then `tiffutil
//     -lzw` for the .tif and `-packbits` for the .tiff, so the bytes differ and
//     no upload can pass for the other), so their expectations are the PNG's and
//     unproven until a live run.
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
// What it covers of the 4.1 live list (client-spec §5): a text PDF (`pdf`,
// `paper`), the scan PNG, DOCX, XLSX, PPTX, HTML, CSV (which makes no MinerU
// request at all: `direct-text`), the Hungarian-named PDF, a corrupt PDF with
// the right failure sentence, both TIFF spellings, and a re-extract
// (`LIVE_EXTRACTION_TIER`). NOT automated, by hand on ai.dev: a cancel, and
// `systemctl restart mineru41` in the middle of a job (the job must recover by
// creating the task again, not fail).
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

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

// ── configuration ──────────────────────────────────────────────────────────

const baseUrl = process.env.LIVE_AI_BASE_URL ?? "https://ai.alfydesign.com";
const email = process.env.LIVE_AI_EMAIL;
const password = process.env.LIVE_AI_PASSWORD;
const headless = process.env.LIVE_AI_HEADLESS !== "false";
const keepConversation = process.env.LIVE_AI_KEEP_CONVERSATION === "true";
/**
 * Generous on purpose: the first `standard` job after a MinerU start measured
 * 8 to 11 s on the box (the one-off model load) and the first `basic` one about
 * 10 s more, so the real ceiling is one slow document, not a cold start.
 */
const timeoutMs = Number(process.env.LIVE_AI_TIMEOUT_MS ?? 600_000);
const fixtureDir =
	process.env.LIVE_EXTRACTION_FIXTURE_DIR ??
	path.join(process.cwd(), "fixtures", "mineru-v1");
/** Where the `plan41` inputs live: the 4.1.7 spike's synthetic files. */
const plan41InputDir =
	process.env.LIVE_EXTRACTION_PLAN41_DIR ??
	path.join(process.cwd(), "docs", "plans", "mineru-4-1", "fixtures", "inputs");
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
 * The tier PDFs and images are expected to have been parsed at. The app names
 * it itself (`MINERU_DEFAULT_TIER=auto` is resolved to the best tier
 * `/v1/tiers` lists: standard, then basic, then flash), and the box serves
 * flash, basic and standard, so the default is `standard`. Point this at the
 * tier a differently started server tops out at, or at a tier an admin pinned,
 * so a correct run does not read as a wall of mismatches.
 */
const expectedPdfTier = process.env.LIVE_EXTRACTION_EXPECTED_TIER ?? "standard";
/**
 * The MinerU the deployment is expected to talk to (`/v1/health` `version`, read
 * through the admin status card) and, per document, `parse.parser_version`
 * (`extractionServerParserVersion`). Exact on purpose: a newer 4.1.x is a
 * reason to read its release notes and re-capture, not to pass silently.
 */
const expectedServerVersion =
	process.env.LIVE_EXTRACTION_EXPECTED_SERVER_VERSION ?? "4.1.7";
/**
 * The app's own renderer version (`MINERU_PARSER_VERSION` in `mineru/result.ts`,
 * stored as `extractionParserVersion`): `mineru4/2` since the 4.1 release,
 * `mineru4/1` for a document the 4.0 client read.
 */
const expectedParserVersion =
	process.env.LIVE_EXTRACTION_EXPECTED_PARSER_VERSION ?? "mineru4/2";

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
	retryable?: boolean;
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

/** Which input folder a case's `file` is read from (see the header). */
type FixtureRoot = "v1" | "plan41";

type ExtractionCase = {
	id: string;
	file: string;
	/** Defaults to "v1". */
	root?: FixtureRoot;
	/** The file name the upload carries, when it differs from `file`'s. */
	uploadName?: string;
	mimeType: string;
	/**
	 * Phase 5 P5-B, `tsv`. Defaults to "mineru". A `direct-text` case never
	 * reaches MinerU at all (`csv` and `tsv` send it no request), so `compare()`
	 * skips every MinerU-specific field (tier, versions, page count/kind,
	 * figures, outline), checks the job's `intakeRoute` instead, and checks the
	 * text and `statusesSeen`.
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
		/**
		 * The name the normalized document must carry (`<stem>.md` of the name the
		 * person uploaded). The upload's name never reaches MinerU, which is told
		 * `document.<ext>`; this is where a name with accents has to survive.
		 */
		normalizedName?: string;
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
 * A document MinerU cannot read: the upload is accepted, the job ends `failed`,
 * and what a person reads is the app's own sentence for the code, never
 * MinerU's wording (every cause of a failed file is the one code
 * `parse_failed`, and the app maps the message it carries to a reason of its
 * own, `mineru/errors.ts`).
 */
type FailureCase = {
	id: string;
	file: string;
	root: FixtureRoot;
	mimeType: string;
	expect: {
		/** The extraction error code the job ends with. */
		code: string;
		/** `retryable` on the job: false when the same bytes can never read. */
		retryable: boolean;
		/** MinerU's own words, which must not reach the sentence a person reads. */
		mustNotContain: string[];
	};
};

export const FAILURE_CASES: FailureCase[] = [
	{
		// The spike's `garbage.pdf`: `%PDF-1.7` followed by noise. MinerU answers
		// `parse_failed` "Failed to load document (PDFium: Data format error).",
		// which the app maps to `document_unreadable`: not retried, no Retry
		// button, since a repaired file has another hash and arrives as a new one.
		id: "corrupt-pdf",
		file: "garbage.pdf",
		root: "plan41",
		mimeType: "application/pdf",
		expect: {
			code: "document_unreadable",
			retryable: false,
			mustNotContain: ["PDFium", "Failed to load", "parse_failed"],
		},
	},
];

/**
 * Types the registry routes to MinerU that this sweep has no row for. Listed in
 * the summary so a run never reads as complete coverage of the formats the app
 * admits.
 *
 * MinerU 4.0.12 and 4.1.7 share one extension list and neither has heic or heif
 * on it, so the app does not send those two as they are: it hands MinerU a PNG
 * of the photo (`intake.readAs`), told as `document.png`. That is run against
 * the 4.1 server's stand-in by `mineru/heic.integration.test.ts`. What is
 * missing here is a live row: the repo holds no HEIC photo with text in it to
 * expect a reading of (`vision/__fixtures__/tiny.heic` is four flat colours).
 */
const KNOWN_GAPS = [
	{
		id: "heic",
		reason:
			"sent to MinerU as a PNG the app makes of the photo; no live row, since the repo has no HEIC photo with text in it",
	},
	{
		id: "heif",
		reason:
			"sent to MinerU as a PNG the app makes of the photo; no live row, since the repo has no HEIF photo with text in it",
	},
] as const;

/** What a scanned page as a TIFF must read like: the `png` case's numbers. */
const TIFF_EXPECT: ExtractionCase["expect"] = {
	effectiveTier: "expected-pdf-tier",
	pageCount: 1,
	pageCountKind: "unknown",
	minTextLength: 200,
	mustContain: [],
	mustNotContain: [],
	figureCount: 0,
	outlineMin: 1,
};

/**
 * Transcribed from §1.4 of the spec and from the fixture Markdown, so this
 * table is the live twin of `result.test.ts`'s (the `plan41` rows: from the
 * 4.1.7 captures, through the app's parser).
 *
 * `effectiveTier: "expected-pdf-tier"` resolves to `LIVE_EXTRACTION_EXPECTED_TIER`:
 * the app names that tier for every PDF and image, while every Office,
 * OpenDocument, HTML, RTF and EPUB input is a native document: the app names no
 * tier and MinerU runs it at `flash` no matter what the job asked for, which
 * `parse.tier` says — the effective-tier trap, and the single most valuable
 * thing this sweep checks. `compare()` holds both `extractionTier` (the
 * result's own) and `extractionJobTier` (the server's `parse.tier`) to it.
 */
export const CASES: ExtractionCase[] = [
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
			// Confirmed live on the MinerU 4.0.4 server (2026-09-22): the sample
			// really does embed one JPEG on slide 2.
			figureCount: 1,
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
		mimeType: "text/csv",
		// `csv` has been `direct-text` in the registry since Phase 1, so it
		// never reaches MinerU: the app makes NO `/v1/tasks` request for it (MinerU
		// 4.1 would run it at flash, as its csv sample did, but the app never
		// asks), and there is no tier, page count, figure count or parser
		// version to check. The expectations below were transcribed from the
		// Phase 0 spike, which measured csv THROUGH MinerU; without this field
		// `compare()` asserts all of them and the sweep reports five mismatches
		// for a case that is working correctly. `tsv` got the field when Phase 5
		// added it; `csv` was missed. The job's `intakeRoute` and the missing
		// `parsing` status below are what prove the route.
		route: "direct-text",
		expect: {
			// Unused by `compare()` for a direct-text case (kept only so every
			// case satisfies the same type); the real assertions are
			// minTextLength, mustContain and mustNotSeeStatus below.
			effectiveTier: "flash",
			pageCount: 1,
			pageCountKind: "logical",
			minTextLength: 80,
			mustContain: ["Northland"],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 0,
			mustNotSeeStatus: "parsing",
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
			// Confirmed live on the MinerU 4.0.4 server (2026-09-22): `rtf` is
			// `category: "text"` in file-types/table.ts, and
			// `normalizePageCountKind()` (result.ts) returns "unknown" for that
			// category when the server sends no `page_count_kind` — it is not
			// "declared" (the legacy-document default) because `rtf` was never
			// registered as `category: "document"`.
			pageCountKind: "unknown",
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
	// ── MinerU 4.1 (client-spec §5) ─────────────────────────────────────────
	{
		// The spike's synthetic two-page paper: a table, a footnote, inline and
		// display formulas, a chart with a caption, and a Hungarian paragraph.
		// MinerU 4.0.12 emits the same chart, equation and page_footnote blocks, so
		// what this proves is the renderer: the chart is a figure handle whose
		// caption is in the text once, the display math is fenced with its tag
		// kept, the footnote is a paragraph, and nothing of MinerU's own markup
		// (an image link, the footnote's span) reaches the prompt text. Numbers:
		// the capture `pdf-paper-default-tier` through `parseMineruResultZip`.
		id: "paper",
		file: "paper-en.pdf",
		root: "plan41",
		mimeType: "application/pdf",
		expect: {
			effectiveTier: "expected-pdf-tier",
			pageCount: 2,
			pageCountKind: "physical",
			minTextLength: 1500,
			mustContain: [
				"Throughput of Tiered Document Parsing",
				"[Figure 1: Figure 1. Relative throughput by tier.]",
				"$$",
				"\\tag{1}",
				"Table 1. Parsing latency by tier",
				"The norm constraint is the usual unit-ball",
				"Az árvíztűrő tükörfúrógép",
			],
			mustNotContain: [
				"![](",
				"images/page_1_chart",
				"docvortex-page-footnote",
			],
			figureCount: 1,
			outlineMin: 4,
		},
	},
	{
		// A name with accents and spaces. MinerU is told `document.pdf`, so none of
		// it reaches the server; the normalized document keeps the person's name.
		// Numbers: the capture `pdf-hu-accented-name`.
		id: "hu-pdf",
		file: "hu-accented-name.pdf",
		root: "plan41",
		uploadName: "Árvíztűrő tükörfúrógép jelentés.pdf",
		mimeType: "application/pdf",
		expect: {
			effectiveTier: "expected-pdf-tier",
			pageCount: 1,
			pageCountKind: "physical",
			minTextLength: 300,
			mustContain: [
				"Árvíztűrő tükörfúrógép jelentés",
				"Az árvíztűrő tükörfúrógép egy magyar pangram",
			],
			mustNotContain: [],
			figureCount: 0,
			outlineMin: 1,
			normalizedName: "Árvíztűrő tükörfúrógép jelentés.md",
		},
	},
	// MinerU 4.1.7 lists `tiff` and not `tif`, and routes by the extension, so the
	// app sends both spellings as `document.tiff`: each upload must reach
	// `succeeded`. The inputs are the v1 PNG sample converted, so the expectations
	// are the `png` case's, unproven for TIFF until a live run.
	{
		id: "tif",
		file: "scan-sample.tif",
		root: "plan41",
		mimeType: "image/tiff",
		expect: TIFF_EXPECT,
	},
	{
		id: "tiff",
		file: "scan-sample.tiff",
		root: "plan41",
		mimeType: "image/tiff",
		expect: TIFF_EXPECT,
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
	// What a browser sends on every POST. The raw upload's body type is the
	// file's own (often text/plain), a form type, and SvelteKit's CSRF check
	// refuses a form-typed POST that names no Origin.
	headers.set("Origin", new URL(baseUrl).origin);
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

/** Where a case's input lives: `v1` samples or the 4.1.7 spike's `plan41` inputs. */
function fixturePath(root: FixtureRoot | undefined, file: string): string {
	return path.join(root === "plan41" ? plan41InputDir : fixtureDir, file);
}

async function uploadFixture(
	page: Page,
	conversationId: string,
	testCase: ExtractionCase | FailureCase,
): Promise<UploadResponse> {
	const absolute = fixturePath(testCase.root, testCase.file);
	const bytes = await readFile(absolute);
	const fileName =
		("uploadName" in testCase ? testCase.uploadName : undefined) ??
		path.basename(absolute);

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
			// Percent-encoded, as the browser client sends it
			// (`encodeUploadHeaderValue`): a header value must be Latin-1, and the
			// route decodes it. `hu-pdf` is the first name here that is not ASCII.
			"x-alfyai-upload-name": encodeURIComponent(fileName),
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
	/** The app's renderer version (`mineru4/2`). */
	parserVersion: unknown;
	/** MinerU's own `parse.parser_version` for this file (`4.1.7`). */
	serverParserVersion: unknown;
	producerVersion: unknown;
	parseMode: unknown;
	bundleBytes: unknown;
};

export function readActual(
	artifact: ArtifactResponse["artifact"],
): ActualExtraction {
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
		serverParserVersion: metadata.extractionServerParserVersion,
		producerVersion: metadata.extractionProducerVersion,
		parseMode: metadata.extractionParseMode,
		bundleBytes: metadata.extractionBundleBytes,
	};
}

/** What a run is held to; `main()` fills it from the environment. */
type Expectations = {
	/** The tier PDFs and images are expected to have been parsed at. */
	pdfTier: string;
	/** The MinerU version, for `parse.parser_version` of every document. */
	serverVersion: string;
	/** The app's own renderer version. */
	parserVersion: string;
};

/**
 * Whether a document that reached `succeeded` is the one its case describes:
 * the mismatches, empty when it is. Pure, so the decisions can be tested without
 * a deployment.
 */
export function compare(
	testCase: ExtractionCase,
	actual: ActualExtraction,
	text: string,
	statusesSeen: string[],
	job: ExtractionJob,
	normalizedName: string,
	expected: Expectations,
): string[] {
	const mismatches: string[] = [];
	const isDirectText = testCase.route === "direct-text";

	// The route is what says whether MinerU was asked at all: `csv` and `tsv` are
	// `direct-text` and make no `/v1/tasks` request, everything else is `mineru`.
	// Absent on a deployment older than the field, which is no evidence.
	const expectedRoute = isDirectText ? "direct-text" : "mineru";
	if (job.intakeRoute !== undefined && job.intakeRoute !== expectedRoute) {
		mismatches.push(
			`intakeRoute: expected ${expectedRoute}, got ${job.intakeRoute}`,
		);
	}

	if (!isDirectText) {
		const expectedTier =
			testCase.expect.effectiveTier === "expected-pdf-tier"
				? expected.pdfTier
				: testCase.expect.effectiveTier;

		if (actual.effectiveTier !== expectedTier) {
			mismatches.push(
				`effectiveTier: expected ${expectedTier}, got ${String(actual.effectiveTier)}`,
			);
		}
		// The server's own `parse.tier` for this file, which the app records
		// beside the result's: a native document says `flash` whatever was asked.
		if (actual.jobTier !== expectedTier) {
			mismatches.push(
				`jobTier (parse.tier): expected ${expectedTier}, got ${String(actual.jobTier)}`,
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
		if (actual.parserVersion !== expected.parserVersion) {
			mismatches.push(
				`extractionParserVersion: expected ${expected.parserVersion}, got ${String(actual.parserVersion)}`,
			);
		}
		if (actual.serverParserVersion !== expected.serverVersion) {
			mismatches.push(
				`extractionServerParserVersion (parse.parser_version): expected ${expected.serverVersion}, got ${String(actual.serverParserVersion)}`,
			);
		}
		// Every block type in the 4.1.7 captures is one the renderer knows; a name
		// here is a new block type a MinerU upgrade brought, rendered as plain text.
		const unknownTypes =
			actual.unknownBlockTypes && typeof actual.unknownBlockTypes === "object"
				? Object.keys(actual.unknownBlockTypes)
				: [];
		if (unknownTypes.length > 0) {
			mismatches.push(`unknown block types: ${unknownTypes.join(", ")}`);
		}
	}

	if (
		testCase.expect.normalizedName !== undefined &&
		normalizedName !== testCase.expect.normalizedName
	) {
		mismatches.push(
			`normalized name: expected ${testCase.expect.normalizedName}, got ${normalizedName}`,
		);
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
): Promise<{ actual: ActualExtraction; text: string; name: string }> {
	const payload = await apiJson<ArtifactResponse>(
		page,
		`/api/knowledge/${encodeURIComponent(normalizedArtifactId)}`,
	);
	return {
		actual: readActual(payload.artifact),
		text: payload.artifact.contentText ?? "",
		name: payload.artifact.name,
	};
}

/**
 * A document MinerU cannot read: the job has to end `failed` with the app's
 * own code and sentence, and (for a file whose bytes can never become
 * readable) without offering a Retry. The mismatches, empty when it did.
 */
export function failureMismatches(
	job: ExtractionJob | null,
	expect: FailureCase["expect"],
): string[] {
	const mismatches: string[] = [];
	if (!job || job.status !== "failed") {
		mismatches.push(
			`expected the extraction to fail, it ended ${job?.status ?? "missing"}`,
		);
		return mismatches;
	}
	if (job.error?.code !== expect.code) {
		mismatches.push(
			`error code: expected ${expect.code}, got ${String(job.error?.code)}`,
		);
	}
	// Absent on a deployment older than the field, which is no evidence.
	if (job.retryable !== undefined && job.retryable !== expect.retryable) {
		mismatches.push(
			`retryable: expected ${expect.retryable}, got ${String(job.retryable)}`,
		);
	}
	const sentence = job.error?.message ?? "";
	if (!sentence) mismatches.push("the job carries no error sentence");
	for (const needle of expect.mustNotContain) {
		if (sentence.includes(needle)) {
			mismatches.push(`MinerU's wording reached the sentence: ${needle}`);
		}
	}
	return mismatches;
}

async function checkFailure(
	page: Page,
	conversationId: string,
	testCase: FailureCase,
): Promise<{
	mismatches: string[];
	statusesSeen: string[];
	error: ExtractionJob["error"];
}> {
	const upload = await uploadFixture(page, conversationId, testCase);
	const { job, statusesSeen } = await pollExtraction(page, upload.artifact.id);
	return {
		mismatches: failureMismatches(job, testCase.expect),
		statusesSeen,
		error: job?.error ?? null,
	};
}

/**
 * What is wrong with the deployment itself, before any document is read: the
 * rows mean something only for the MinerU this run was written for, at the tier
 * it expects. Not fatal, but never silent. Empty when all is as expected.
 */
export function preflightProblems(
	server: MineruStatusResponse["report"] | null,
	expected: Expectations,
): string[] {
	if (!server) return ["the MinerU status card could not be read"];
	const problems: string[] = [];
	if (server.version !== expected.serverVersion) {
		problems.push(
			`MinerU version: expected ${expected.serverVersion}, the server says ${String(server.version)}`,
		);
	}
	if (!server.tiers?.some((tier) => tier.id === expected.pdfTier)) {
		problems.push(
			`the server does not list the tier PDFs and images are expected at (${expected.pdfTier})`,
		);
	}
	return problems;
}

async function main() {
	await mkdir(outputDir, { recursive: true });
	const browser = await chromium.launch({ headless });
	const page = await browser.newPage();

	const results: Array<Record<string, unknown>> = [];
	const expected: Expectations = {
		pdfTier: expectedPdfTier,
		serverVersion: expectedServerVersion,
		parserVersion: expectedParserVersion,
	};
	let preflight: string[] = [];
	let conversationId = "";
	let server: MineruStatusResponse["report"] | null = null;

	try {
		await login(page);

		// Every case would fail identically against a MinerU that is down, so
		// the run stops before it uploads anything. A 4.0.x server is "down" for
		// this app too: the status card reports it unreachable, with its version
		// and "speaks the old protocol".
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
		preflight = preflightProblems(server, expected);

		conversationId = await createConversation(page);

		const selected = onlyCases.length
			? CASES.filter((testCase) => onlyCases.includes(testCase.id))
			: CASES;

		// Sequential on purpose: each row's timing is then its own (the box runs
		// MinerU with --concurrency 4, and the app's extraction worker has limits
		// of its own), and a failure points at one document.
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

				const { actual, text, name } = await readNormalized(
					page,
					job.normalizedArtifactId,
				);
				result.actual = actual;
				result.normalizedName = name;
				const mismatches = compare(
					testCase,
					actual,
					text,
					statusesSeen,
					job,
					name,
					expected,
				);
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

		// The documents MinerU cannot read: accepted, then failed with our sentence.
		const selectedFailures = onlyCases.length
			? FAILURE_CASES.filter((testCase) => onlyCases.includes(testCase.id))
			: FAILURE_CASES;
		for (const testCase of selectedFailures) {
			const result: Record<string, unknown> = {
				id: testCase.id,
				ok: false,
				mismatches: [] as string[],
			};
			results.push(result);
			try {
				const outcome = await checkFailure(page, conversationId, testCase);
				result.statusesSeen = outcome.statusesSeen;
				result.error = outcome.error;
				(result.mismatches as string[]).push(...outcome.mismatches);
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
		expected,
		preflight,
		tierUnderTest: reextractTier,
		// Formats the app admits and MinerU has never read: not asserted, listed
		// so a green run is not read as covering them.
		knownGaps: KNOWN_GAPS,
		results,
		ok: preflight.length === 0 && results.every((result) => result.ok === true),
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

/**
 * The sweep runs only when this file is the one started. The tests import the
 * decisions above (`compare`, `preflightProblems`, `failureMismatches`) and must
 * not launch a browser.
 */
export function isDirectRun(
	argv1: string | undefined,
	moduleUrl: string,
): boolean {
	if (!argv1) return false;
	// Real paths on both sides: started through a symlinked directory the two
	// spellings differ, the guard would be false, and a live check would print
	// nothing and exit 0.
	try {
		return (
			realpathSync(path.resolve(argv1)) ===
			realpathSync(fileURLToPath(moduleUrl))
		);
	} catch {
		return false;
	}
}

if (isDirectRun(process.argv[1], import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
