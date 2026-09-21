// The live counterpart of the file-production unit tests (`file-production/*.test.ts`,
// `produce-file.test.ts`, `execution-adapter.test.ts`).
//
// Those prove the intake/execution/validation logic against an in-memory
// ledger; this proves the DEPLOYED app end to end: it logs in, POSTs to the
// real `/api/chat/files/produce`, polls the real job ledger, and downloads
// the real bytes it served. It only ever creates, uses and deletes its OWN
// conversation, and it never writes configuration or prints a credential.
//
//   LIVE_AI_BASE_URL=https://ai.alfydesign.com LIVE_AI_EMAIL=… LIVE_AI_PASSWORD=… \
//     PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsx scripts/verify-live-file-production-types.ts
//
// Environment variables (all optional except the two credentials):
//   LIVE_AI_BASE_URL              Target origin. Default https://ai.alfydesign.com.
//   LIVE_AI_EMAIL                 Login email. Required.
//   LIVE_AI_PASSWORD              Login password. Required. Never logged or written
//                                 to summary.json.
//   LIVE_AI_HEADLESS              "false" runs the driving browser headed. Default headless.
//   LIVE_AI_KEEP_CONVERSATION     "true" skips deleting the sweep conversation afterwards,
//                                 useful for inspecting a failure in the UI.
//   LIVE_AI_TIMEOUT_MS            Per-job poll timeout. Default 240000 (240s).
//   LIVE_AI_OUTPUT_DIR            Where summary.json lands. Default a timestamped
//                                 folder under test-results/.
//   LIVE_FILE_PRODUCTION_CASES    Comma-separated case labels (see `cases`/`negativeCases`
//                                 below) to run a narrow subset instead of the full sweep.
//   LIVE_FILE_PRODUCTION_SKIP_DOCKER
//                                 "true" skips every case whose `needsDocker` is true (the
//                                 ten `program-*` cases, `program-tsv` and the program-mode
//                                 negative case) — for a target whose sandbox Docker daemon
//                                 is unreachable. Skipped cases are recorded with
//                                 `skipped: true` and do not fail the run.
//
// Phase 6 P6-C additions over the original 13-case sweep (document-pdf,
// document-docx, document-html, program-csv/json/txt/markdown/svg/zip/xlsx/
// pptx/docx/odt):
//   - an `inline` source mode for D8's `inline_text` production (no Docker);
//   - `inline-markdown` / `inline-tsv`: byte-exact, no-reformatting checks;
//   - `inline-multi-md-txt`: one job, two files, one shared `content`;
//   - `program-tsv`: tsv is also producible through the sandbox (D7);
//   - `document-markdown`: the document_source -> markdown render, never
//     covered by the original sweep;
//   - `document-pdf-readback-skip`: D9's claim that a document_source file
//     never enqueues a MinerU readback job, checked against the real
//     ledger via `/api/knowledge/extraction`;
//   - two NEGATIVE cases (`negative-mixed-outputs`,
//     `negative-program-pdf-signature-mismatch`) proving two ways a bad
//     request is refused rather than silently mis-produced.
//
// `FileProductionJob` (`file-production/types.ts`) and both `mapJobRow`
// implementations (`job-ledger.ts`, `read-model.ts`) now serialize
// `source_mode` to the client as `sourceMode`, so every `document-*`,
// `program-*` and `inline-*` case below asserts `job.sourceMode` against the
// value the intake route is expected to have stored — `"document_source"`,
// `"program"`, or `"inline_text"` for a case whose own `sourceMode` label is
// `"inline"` (the request-shape label; the ledger's stored value is D8's
// `FILE_PRODUCTION_INLINE_TEXT_SOURCE_MODE`).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium, type Page } from "playwright";
import { getCanonicalMimeForExtension } from "$lib/shared/file-types";
import { getExpectedExtensionForOutputType } from "$lib/shared/file-types/production";

type ConversationDetail = {
	fileProductionJobs?: FileProductionJob[];
};

type FileProductionJob = {
	id: string;
	title?: string;
	status?: string;
	error?: { code?: string; message?: string; retryable?: boolean } | null;
	files?: ProducedFile[];
	/** `file_production_jobs.source_mode` verbatim: `"document_source"`,
	 * `"program"`, `"inline_text"`, or `null`/absent for a legacy job. */
	sourceMode?: string | null;
};

type ProducedFile = {
	id: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	downloadUrl: string;
	/**
	 * Present for a `document_source` output: the id of the `generated_output`
	 * artifact the job rendered from (`source-persistence.ts`). Used by
	 * `document-pdf-readback-skip` below to reach the D9 assertions through
	 * `/api/knowledge/**`, since there is no `read_generated_file` HTTP route
	 * (it is a chat tool, invoked in-process by the model, not a fetchable
	 * endpoint this script can hit directly).
	 */
	artifactId?: string | null;
};

type FileTypeCase = {
	label: string;
	sourceMode: "document_source" | "program" | "inline";
	/** The output type used for the label/summary and, for a single-output
	 * case, the one entry `expectedOutputTypes` defaults to. */
	requestedType: string;
	/** Every output type the job must produce. Defaults to `[requestedType]`. */
	expectedOutputTypes?: string[];
	body: (conversationId: string) => Record<string, unknown>;
	/**
	 * When set, every produced file's downloaded bytes must equal this string
	 * (UTF-8 encoded) EXACTLY — no CRLF or trailing-newline normalisation. This
	 * is the D8 no-reformatting assertion: `inline_text` writes the caller's
	 * bytes straight to storage.
	 */
	expectedBytes?: (conversationId: string) => string;
	/** True for a case that spawns the sandbox (a `program.sourceCode` run in
	 * Docker, or a `document_source` PDF/DOCX render, which does not need
	 * Docker but is left false — only the sandbox needs the flag). */
	needsDocker?: boolean;
	/** Shown on a skip; also doubles as the required "why Docker" note. */
	skipReason?: string;
};

type ExpectedFileType = {
	expectedExtension: string;
	expectedMimePrefix: string;
};

/**
 * The `file_production_jobs.source_mode` value the intake route is expected
 * to have stored for a case, given that case's own `sourceMode` label.
 * `"inline"` is this script's request-shape label (`FileTypeCase.sourceMode`,
 * used to build the request body); the ledger stores D8's
 * `FILE_PRODUCTION_INLINE_TEXT_SOURCE_MODE` (`"inline_text"`) for it.
 * `"document_source"` and `"program"` pass through unchanged.
 */
function expectedServerSourceMode(
	caseSourceMode: FileTypeCase["sourceMode"],
): string {
	return caseSourceMode === "inline" ? "inline_text" : caseSourceMode;
}

// This script used to restate the extension and MIME of all 12 types — a
// second source of truth next to the production table. It asks the shared
// registry now, so a table change cannot leave the live sweep asserting the
// old answer (spec row 64).
function expectedFileType(requestedType: string): ExpectedFileType {
	const expectedExtension = getExpectedExtensionForOutputType(requestedType);
	if (!expectedExtension) {
		throw new Error(
			`${requestedType} is not a producible output type in the registry`,
		);
	}
	const expectedMimePrefix = getCanonicalMimeForExtension(expectedExtension);
	if (!expectedMimePrefix) {
		throw new Error(
			`${requestedType} resolves to ${expectedExtension}, which has no canonical MIME`,
		);
	}
	return { expectedExtension, expectedMimePrefix };
}

const baseUrl = process.env.LIVE_AI_BASE_URL ?? "https://ai.alfydesign.com";
const email = process.env.LIVE_AI_EMAIL;
const password = process.env.LIVE_AI_PASSWORD;
const headless = process.env.LIVE_AI_HEADLESS !== "false";
const keepConversation = process.env.LIVE_AI_KEEP_CONVERSATION === "true";
const timeoutMs = Number(process.env.LIVE_AI_TIMEOUT_MS ?? 240_000);
const outputDir =
	process.env.LIVE_AI_OUTPUT_DIR ??
	path.join(
		process.cwd(),
		"test-results",
		`live-file-production-types-${new Date().toISOString().replace(/[:.]/g, "-")}`,
	);
/** A comma-separated subset of case labels, for a narrow smoke run. */
const onlyCases = (process.env.LIVE_FILE_PRODUCTION_CASES ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
const skipDocker = process.env.LIVE_FILE_PRODUCTION_SKIP_DOCKER === "true";

function requireEnv(name: string, value: string | undefined): string {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

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
		throw new Error(`HTTP ${response.status} from ${url}: ${text}`);
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
			title: `Live file type sweep ${new Date().toISOString()}`,
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
			`Failed to delete conversation ${conversationId}: HTTP ${response.status} ${await response.text()}`,
		);
	}
}

async function getConversationDetail(
	page: Page,
	conversationId: string,
): Promise<ConversationDetail> {
	return apiJson<ConversationDetail>(
		page,
		`/api/conversations/${encodeURIComponent(conversationId)}`,
	);
}

async function pollForJob(
	page: Page,
	conversationId: string,
	jobId: string,
): Promise<FileProductionJob> {
	const deadline = Date.now() + timeoutMs;
	let lastJob: FileProductionJob | null = null;
	while (Date.now() < deadline) {
		const detail = await getConversationDetail(page, conversationId);
		lastJob =
			detail.fileProductionJobs?.find((candidate) => candidate.id === jobId) ??
			lastJob;
		if (
			lastJob &&
			["succeeded", "failed", "cancelled"].includes(
				String(lastJob.status ?? ""),
			)
		) {
			return lastJob;
		}
		await page.waitForTimeout(1500);
	}
	throw new Error(
		`Timed out waiting for job ${jobId}; last status=${lastJob?.status ?? "missing"}`,
	);
}

const documentSource = {
	version: 1,
	template: "alfyai_standard_report",
	title: "Live File Type Report",
	blocks: [
		{ type: "heading", level: 2, text: "Summary" },
		{
			type: "paragraph",
			text: "This file was generated by the live file production type sweep.",
		},
		{ type: "list", style: "bullet", items: ["Alpha", "Beta", "Gamma"] },
	],
};

/** Text that must survive into the rendered `document_source` output, used to
 * assert the readback text in `document-pdf-readback-skip`. */
const DOCUMENT_SOURCE_HEADING = "Summary";

function documentSourceBody(type: string, conversationId: string) {
	return {
		conversationId,
		idempotencyKey: `live-type:${type}:${crypto.randomUUID()}`,
		requestTitle: `Live document ${type.toUpperCase()}`,
		sourceMode: "document_source",
		requestedOutputs: [{ type }],
		documentIntent: "live file type sweep document",
		documentSource,
	};
}

function programBody(
	type: string,
	conversationId: string,
	filename: string,
	language: "python" | "javascript",
	sourceCode: string,
) {
	return {
		conversationId,
		idempotencyKey: `live-type:${type}:${crypto.randomUUID()}`,
		requestTitle: `Live program ${type.toUpperCase()}`,
		sourceMode: "program",
		requestedOutputs: [{ type }],
		documentIntent: "live file production sweep program artifact",
		program: { language, sourceCode, filename },
	};
}

/**
 * D8's `inline_text` request shape, posted straight to `/api/chat/files/produce`
 * — the raw intake this route accepts (`intake.ts`'s `normalizeInlineTextIntake`),
 * not the model-tool's looser `{ markdown, requestedOutputs }` shape. See the
 * header comment and `negative-mixed-outputs` for why those are different
 * surfaces.
 */
function inlineTextBody(
	conversationId: string,
	label: string,
	content: string,
	files: Array<{ filename: string; outputType: string }>,
) {
	return {
		conversationId,
		idempotencyKey: `live-type:${label}:${crypto.randomUUID()}`,
		requestTitle: `Live inline ${label}`,
		sourceMode: "inline_text",
		documentIntent: "live file production sweep inline text artifact",
		inlineText: { content, files },
	};
}

// A markdown sample that exercises every byte D8 promises to leave alone: a
// CRLF-terminated line, a GFM pipe table and a fenced code block. `runInlineText`
// (`execution-adapter.ts`) writes `Buffer.from(request.content, "utf8")`
// straight to storage with no trim and no CRLF rewrite, so the round trip
// through this sweep must reproduce every one of these bytes.
const INLINE_MARKDOWN_CONTENT =
	"# Live inline markdown\r\n" +
	"\r\n" +
	"| Col A | Col B |\n" +
	"| --- | --- |\n" +
	"| alpha | 1 |\n" +
	"\n" +
	"```text\n" +
	"plain fenced block, kept verbatim\n" +
	"```\n";

const INLINE_TSV_CONTENT = "a\tb\n1\t2\n";

const INLINE_MULTI_CONTENT =
	"Shared inline content across the md and txt outputs of one job.\n";

const cases: FileTypeCase[] = [
	{
		label: "document-pdf",
		sourceMode: "document_source",
		requestedType: "pdf",
		body: (conversationId) => documentSourceBody("pdf", conversationId),
	},
	{
		label: "document-docx",
		sourceMode: "document_source",
		requestedType: "docx",
		body: (conversationId) => documentSourceBody("docx", conversationId),
	},
	{
		label: "document-html",
		sourceMode: "document_source",
		requestedType: "html",
		body: (conversationId) => documentSourceBody("html", conversationId),
	},
	// Phase 6 P6-C: the document_source -> markdown render, never covered by
	// the original sweep (D9 — `renderStandardReportMarkdown` is now also the
	// renderer for `chat-files.ts`'s persisted source-first readback text).
	{
		label: "document-markdown",
		sourceMode: "document_source",
		requestedType: "markdown",
		body: (conversationId) => documentSourceBody("markdown", conversationId),
	},
	{
		label: "program-csv",
		sourceMode: "program",
		requestedType: "csv",
		needsDocker: true,
		skipReason: "runs a Python program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"csv",
				conversationId,
				"live-type.csv",
				"python",
				`from pathlib import Path\nPath('/output/live-type.csv').write_text('name,value\\nalpha,1\\n', encoding='utf-8')`,
			),
	},
	{
		label: "program-json",
		sourceMode: "program",
		requestedType: "json",
		needsDocker: true,
		skipReason: "runs a Python program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"json",
				conversationId,
				"live-type.json",
				"python",
				`from pathlib import Path\nPath('/output/live-type.json').write_text('{"name":"alpha","value":1}\\n', encoding='utf-8')`,
			),
	},
	{
		label: "program-txt",
		sourceMode: "program",
		requestedType: "txt",
		needsDocker: true,
		skipReason: "runs a Python program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"txt",
				conversationId,
				"live-type.txt",
				"python",
				`from pathlib import Path\nPath('/output/live-type.txt').write_text('plain text output\\n', encoding='utf-8')`,
			),
	},
	{
		label: "program-markdown",
		sourceMode: "program",
		requestedType: "markdown",
		needsDocker: true,
		skipReason: "runs a Python program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"markdown",
				conversationId,
				"live-type.md",
				"python",
				`from pathlib import Path\nPath('/output/live-type.md').write_text('# Markdown output\\n\\n- alpha\\n- beta\\n', encoding='utf-8')`,
			),
	},
	{
		label: "program-svg",
		sourceMode: "program",
		requestedType: "svg",
		needsDocker: true,
		skipReason: "runs a Python program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"svg",
				conversationId,
				"live-type.svg",
				"python",
				`from pathlib import Path\nPath('/output/live-type.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#f4f4f5"/><text x="20" y="45" font-size="18">Live SVG</text></svg>', encoding='utf-8')`,
			),
	},
	{
		label: "program-zip",
		sourceMode: "program",
		requestedType: "zip",
		needsDocker: true,
		skipReason: "runs a Python program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"zip",
				conversationId,
				"live-type.zip",
				"python",
				`from pathlib import Path\nfrom zipfile import ZipFile\nwith ZipFile('/output/live-type.zip', 'w') as z:\n    z.writestr('README.txt', 'zip output')`,
			),
	},
	// Phase 6 D7: tsv is now also producible through the sandbox, not only
	// `inline_text` — the spec's per-format decision table lists `program-tsv`
	// alongside `inline-tsv` as the two live-verify rows for the new output.
	{
		label: "program-tsv",
		sourceMode: "program",
		requestedType: "tsv",
		needsDocker: true,
		skipReason: "runs a Python program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"tsv",
				conversationId,
				"live-type.tsv",
				"python",
				`from pathlib import Path\nPath('/output/live-type.tsv').write_text('region\\trevenue\\nNorth\\t24.25\\n', encoding='utf-8')`,
			),
	},
	{
		label: "program-xlsx",
		sourceMode: "program",
		requestedType: "xlsx",
		needsDocker: true,
		skipReason: "runs a JavaScript program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"xlsx",
				conversationId,
				"live-type.xlsx",
				"javascript",
				`
const ExcelJS = require('exceljs');
const workbook = new ExcelJS.Workbook();
workbook.calcProperties.fullCalcOnLoad = true;
const sheet = workbook.addWorksheet('Summary');
sheet.columns = [{ header: 'Metric', key: 'metric' }, { header: 'Value', key: 'value' }];
sheet.addRow({ metric: 'alpha', value: 1 });
await workbook.xlsx.writeFile('/output/live-type.xlsx');
`.trim(),
			),
	},
	{
		label: "program-pptx",
		sourceMode: "program",
		requestedType: "pptx",
		needsDocker: true,
		skipReason: "runs a JavaScript program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"pptx",
				conversationId,
				"live-type.pptx",
				"javascript",
				`
const pptxgen = require('pptxgenjs');
const pptx = new pptxgen();
const slide = pptx.addSlide();
slide.addText('Live PPTX output', { x: 0.7, y: 0.7, w: 8, h: 0.6, fontSize: 24 });
await pptx.writeFile({ fileName: '/output/live-type.pptx' });
`.trim(),
			),
	},
	{
		label: "program-docx",
		sourceMode: "program",
		requestedType: "docx",
		needsDocker: true,
		skipReason: "runs a JavaScript program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"docx",
				conversationId,
				"live-type.docx",
				"javascript",
				`
const fs = require('fs');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const doc = new Document({
  sections: [{ children: [new Paragraph({ children: [new TextRun('Live DOCX output')] })] }],
});
fs.writeFileSync('/output/live-type.docx', await Packer.toBuffer(doc));
`.trim(),
			),
	},
	{
		label: "program-odt",
		sourceMode: "program",
		requestedType: "odt",
		needsDocker: true,
		skipReason: "runs a JavaScript program inside the Docker sandbox",
		body: (conversationId) =>
			programBody(
				"odt",
				conversationId,
				"live-type.odt",
				"javascript",
				`
const fs = require('fs');
const JSZip = require('jszip');
const zip = new JSZip();
zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
zip.file('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Live ODT output</text:p></office:text></office:body></office:document-content>');
fs.writeFileSync('/output/live-type.odt', await zip.generateAsync({ type: 'nodebuffer' }));
`.trim(),
			),
	},
	// ── Phase 6 D8 — `inline_text`, no Docker ──────────────────────────────
	{
		label: "inline-markdown",
		sourceMode: "inline",
		requestedType: "md",
		expectedBytes: () => INLINE_MARKDOWN_CONTENT,
		body: (conversationId) =>
			inlineTextBody(
				conversationId,
				"inline-markdown",
				INLINE_MARKDOWN_CONTENT,
				[{ filename: "live-type.md", outputType: "md" }],
			),
	},
	{
		label: "inline-tsv",
		sourceMode: "inline",
		requestedType: "tsv",
		expectedBytes: () => INLINE_TSV_CONTENT,
		body: (conversationId) =>
			inlineTextBody(conversationId, "inline-tsv", INLINE_TSV_CONTENT, [
				{ filename: "live-type.tsv", outputType: "tsv" },
			]),
	},
	// The extra case P6-B's own slice asked for: one job, two files, one shared
	// `content` — `NormalizedInlineTextRequest`'s doc comment (`produce-file.ts`)
	// says a request may ask for the same text as both `.md` and `.txt`.
	{
		label: "inline-multi-md-txt",
		sourceMode: "inline",
		requestedType: "md",
		expectedOutputTypes: ["md", "txt"],
		expectedBytes: () => INLINE_MULTI_CONTENT,
		body: (conversationId) =>
			inlineTextBody(
				conversationId,
				"inline-multi-md-txt",
				INLINE_MULTI_CONTENT,
				[
					{ filename: "live-type-multi.md", outputType: "md" },
					{ filename: "live-type-multi.txt", outputType: "txt" },
				],
			),
	},
];

/**
 * Runs one negative case and reports what the route actually did — status,
 * error code, message — rather than asserting a fixed outcome sight unseen.
 * `ok` still gates the exit code; see each case for its own pass condition.
 */
type NegativeCaseResult = Record<string, unknown> & {
	label: string;
	ok: boolean;
};

type NegativeCase = {
	label: string;
	needsDocker?: boolean;
	skipReason?: string;
	run: (page: Page, conversationId: string) => Promise<NegativeCaseResult>;
};

/**
 * Sends the shape the `produce_file` MODEL TOOL would receive from a model
 * that named two formats from different families without an explicit
 * `sourceMode` — `{ markdown, requestedOutputs: [{type:"pdf"},{type:"md"}] }`.
 *
 * The mixed-family rule used to live inside
 * `normal-chat-tools/produce-file.ts`, i.e. it ran only in the tool's
 * in-process `normalizeProduceFileInput` step and never on this route, so a
 * direct caller — Atlas, or the signed service-assertion path in
 * `+server.ts`'s `resolveOwnerUserId` — got a generic `unsupported_source_mode`
 * instead. The predicate now lives in
 * `file-production/mixed-output-groups.ts` and `file-production/intake.ts`
 * applies it, so this route answers `mixed_output_groups` with the SAME
 * message the model sees.
 *
 * A caller-authored `program.sourceCode` and a `document_source` job are
 * deliberately exempt (both may legitimately span the two families), which is
 * why this case sends neither.
 */
async function runNegativeMixedOutputsCase(
	page: Page,
	conversationId: string,
): Promise<NegativeCaseResult> {
	const idempotencyKey = `live-type:negative-mixed:${crypto.randomUUID()}`;
	const response = await authenticatedFetch(page, "/api/chat/files/produce", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			conversationId,
			idempotencyKey,
			requestTitle: "Live negative mixed outputs",
			requestedOutputs: [{ type: "pdf" }, { type: "md" }],
			markdown:
				"# Mixed output negative case\n\nThis body deliberately mixes a " +
				"document-source output (pdf) with a plain-text output (md) and " +
				"omits sourceMode, mirroring what a model sends the produce_file " +
				"TOOL. The raw HTTP intake has no equivalent resolution step; see " +
				"this case's `note` field.",
		}),
	});
	const httpStatus = response.status;
	const payload = (await response.json().catch(() => null)) as {
		error?: string;
		job?: {
			status?: string;
			files?: unknown[];
			error?: { code?: string; message?: string } | null;
		};
	} | null;
	const code = payload?.job?.error?.code ?? null;
	const message = payload?.job?.error?.message ?? payload?.error ?? null;
	const refused = httpStatus >= 400 && httpStatus < 500;
	const noFilesProduced = (payload?.job?.files?.length ?? 0) === 0;
	const matchesToolLayerMessage = Boolean(message?.includes("Cannot produce"));
	return {
		label: "negative-mixed-outputs",
		sourceMode: "unresolved",
		requestedTypes: ["pdf", "md"],
		// The real, reachable bar for this route: refused, no file written.
		ok:
			refused &&
			noFilesProduced &&
			code === "mixed_output_groups" &&
			matchesToolLayerMessage,
		httpStatus,
		errorCode: code,
		errorMessage: message,
		matchesToolLayerMessage,
		note:
			"refuseMixedOutputGroups now lives in " +
			"file-production/mixed-output-groups.ts and is applied by " +
			"file-production/intake.ts, so this route refuses the ambiguous " +
			"shape with the tool's own 'Cannot produce …' message and the " +
			"mixed_output_groups code rather than a generic " +
			"unsupported_source_mode. matchesToolLayerMessage is now part of " +
			"the pass condition.",
	};
}

/**
 * A program job that requests `pdf` but writes plain text into
 * `/output/live-type.pdf`. `output-validation.ts`'s
 * `validateProducedFileSignature` sniffs the produced bytes against the
 * registry's `%PDF-` signature (reusing the upload-side matcher) and the
 * storage adapter runs this BEFORE writing anything, so the job must fail
 * with `program_output_signature_mismatch` and store no file — the defence
 * P6-B added against "the model asked for a PDF and got a renamed text
 * file" (spec §1.4's latent-bug note).
 */
async function runNegativeProgramPdfSignatureMismatchCase(
	page: Page,
	conversationId: string,
): Promise<NegativeCaseResult> {
	const body = programBody(
		"pdf",
		conversationId,
		"live-type.pdf",
		"python",
		`from pathlib import Path\nPath('/output/live-type.pdf').write_text('This is plain text, not a real PDF.\\n', encoding='utf-8')`,
	);
	const accepted = await postProduceFile(page, body);
	const terminal =
		accepted.id === "missing-job" || accepted.status === "failed"
			? accepted
			: await pollForJob(page, conversationId, accepted.id);
	const noFilesStored = (terminal.files?.length ?? 0) === 0;
	const ok =
		terminal.status === "failed" &&
		terminal.error?.code === "program_output_signature_mismatch" &&
		noFilesStored;
	return {
		label: "negative-program-pdf-signature-mismatch",
		sourceMode: "program",
		requestedTypes: ["pdf"],
		ok,
		jobId: terminal.id,
		status: terminal.status,
		error: terminal.error ?? null,
		noFilesStored,
	};
}

const negativeCases: NegativeCase[] = [
	{ label: "negative-mixed-outputs", run: runNegativeMixedOutputsCase },
	{
		label: "negative-program-pdf-signature-mismatch",
		needsDocker: true,
		skipReason: "runs a Python program inside the Docker sandbox",
		run: runNegativeProgramPdfSignatureMismatchCase,
	},
];

async function postProduceFile(
	page: Page,
	body: Record<string, unknown>,
): Promise<FileProductionJob & { httpStatus: number }> {
	const response = await authenticatedFetch(page, "/api/chat/files/produce", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await response.json()) as {
		job?: FileProductionJob;
		error?: string;
	};
	if (!response.ok) {
		return {
			id: data.job?.id ?? "missing-job",
			status: data.job?.status ?? "request_failed",
			error: data.job?.error ?? {
				message: data.error ?? `HTTP ${response.status}`,
			},
			files: data.job?.files ?? [],
			httpStatus: response.status,
		};
	}
	if (!data.job) throw new Error("produce_file response did not contain job");
	return { ...data.job, httpStatus: response.status };
}

async function verifyDownload(
	page: Page,
	file: ProducedFile,
	expected: ExpectedFileType,
	expectedBytes?: Buffer,
) {
	const response = await authenticatedFetch(page, file.downloadUrl);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const bytesMatchExpected =
		expectedBytes === undefined
			? null
			: Buffer.compare(Buffer.from(bytes), expectedBytes) === 0;
	return {
		ok:
			response.ok &&
			file.filename.endsWith(expected.expectedExtension) &&
			(file.mimeType ?? "").startsWith(expected.expectedMimePrefix) &&
			(response.headers.get("content-type") ?? "").startsWith(
				expected.expectedMimePrefix,
			) &&
			bytes.byteLength > 0 &&
			bytesMatchExpected !== false,
		status: response.status,
		contentType: response.headers.get("content-type"),
		contentLength: bytes.byteLength,
		bytesMatchExpected,
	};
}

/**
 * Matches produced files to expected output types by extension (order is not
 * guaranteed to mirror the request for a multi-output job) and verifies each
 * one, including an optional byte-exact check.
 */
async function verifyProducedFiles(
	page: Page,
	files: ProducedFile[],
	expectedOutputTypes: string[],
	expectedBytes: string | undefined,
): Promise<{ ok: boolean; perFile: Array<Record<string, unknown>> }> {
	const remaining = [...files];
	const perFile: Array<Record<string, unknown>> = [];
	let ok = files.length === expectedOutputTypes.length;

	for (const outputType of expectedOutputTypes) {
		const expected = expectedFileType(outputType);
		const matchIndex = remaining.findIndex((file) =>
			file.filename.toLowerCase().endsWith(expected.expectedExtension),
		);
		if (matchIndex === -1) {
			ok = false;
			perFile.push({
				outputType,
				ok: false,
				reason: "no matching file produced",
			});
			continue;
		}
		const [file] = remaining.splice(matchIndex, 1);
		const download = await verifyDownload(
			page,
			file,
			expected,
			expectedBytes !== undefined
				? Buffer.from(expectedBytes, "utf8")
				: undefined,
		);
		if (!download.ok) ok = false;
		perFile.push({
			outputType,
			filename: file.filename,
			artifactId: file.artifactId ?? null,
			ok: download.ok,
			download,
		});
	}
	return { ok, perFile };
}

/**
 * D9: a `document_source` output must never enqueue a MinerU readback job —
 * `chat-files.ts`'s `listGeneratedOutputArtifactIdsByChatFile` maps the
 * produced chat file straight onto the `generated_output` artifact that
 * `source-persistence.ts` already wrote, and `enqueueGeneratedFileReadback`
 * skips it. There is no `read_generated_file` HTTP route to call directly (it
 * is a chat tool the model invokes in-process), so this reads the SAME
 * persisted text the tool would return — `renderStandardReportMarkdown`'s
 * output, stored as the artifact's `contentText` — via
 * `GET /api/knowledge/{artifactId}`, and separately confirms no extraction
 * job exists for it via `GET /api/knowledge/extraction?artifactIds=…`.
 */
async function verifyDocumentPdfReadbackSkip(
	page: Page,
	pdfFile: ProducedFile,
): Promise<NegativeCaseResult> {
	const artifactId = pdfFile.artifactId ?? null;
	if (!artifactId) {
		return {
			label: "document-pdf-readback-skip",
			ok: false,
			reason:
				"document-pdf's produced file carried no artifactId in the API " +
				"response, so the D9 source-first-skip assertions could not run. " +
				"See the ProducedFile.artifactId comment above.",
		};
	}
	const artifact = await apiJson<{
		artifact: { id: string; contentText?: string | null };
	}>(page, `/api/knowledge/${encodeURIComponent(artifactId)}`);
	const text = artifact.artifact.contentText ?? "";
	const containsHeading = text.includes(DOCUMENT_SOURCE_HEADING);

	const extraction = await apiJson<{ jobs?: Array<{ id: string }> }>(
		page,
		`/api/knowledge/extraction?artifactIds=${encodeURIComponent(artifactId)}`,
	);
	const noExtractionJob = (extraction.jobs ?? []).length === 0;

	return {
		label: "document-pdf-readback-skip",
		ok: containsHeading && noExtractionJob,
		artifactId,
		containsHeading,
		noExtractionJob,
		textLength: text.length,
	};
}

async function main() {
	await mkdir(outputDir, { recursive: true });
	const browser = await chromium.launch({ headless });
	const page = await browser.newPage();
	const results: Array<Record<string, unknown>> = [];
	let conversationId: string | null = null;

	try {
		await login(page);
		conversationId = await createConversation(page);

		const selectedCases = onlyCases.length
			? cases.filter((testCase) => onlyCases.includes(testCase.label))
			: cases;
		const selectedNegativeCases = onlyCases.length
			? negativeCases.filter((testCase) => onlyCases.includes(testCase.label))
			: negativeCases;

		for (const testCase of selectedCases) {
			const startedAt = Date.now();
			if (testCase.needsDocker && skipDocker) {
				results.push({
					label: testCase.label,
					sourceMode: testCase.sourceMode,
					requestedType: testCase.requestedType,
					skipped: true,
					ok: true,
					reason:
						testCase.skipReason ??
						"needs Docker; skipped via LIVE_FILE_PRODUCTION_SKIP_DOCKER=true",
					elapsedMs: 0,
				});
				continue;
			}

			try {
				const accepted = await postProduceFile(
					page,
					testCase.body(conversationId),
				);
				const terminal =
					accepted.id === "missing-job" || accepted.status === "failed"
						? accepted
						: await pollForJob(page, conversationId, accepted.id);
				const expectedOutputTypes = testCase.expectedOutputTypes ?? [
					testCase.requestedType,
				];
				const expectedBytes = testCase.expectedBytes?.(conversationId);
				const verification =
					terminal.status === "succeeded"
						? await verifyProducedFiles(
								page,
								terminal.files ?? [],
								expectedOutputTypes,
								expectedBytes,
							)
						: { ok: false, perFile: [] };
				const expectedSourceMode = expectedServerSourceMode(
					testCase.sourceMode,
				);
				const sourceModeMatches =
					terminal.status === "succeeded" &&
					terminal.sourceMode === expectedSourceMode;
				const ok =
					terminal.status === "succeeded" &&
					verification.ok &&
					sourceModeMatches;
				results.push({
					label: testCase.label,
					sourceMode: testCase.sourceMode,
					expectedSourceMode,
					actualSourceMode: terminal.sourceMode ?? null,
					requestedType: testCase.requestedType,
					expectedOutputTypes,
					ok,
					jobId: terminal.id,
					status: terminal.status,
					error: terminal.error ?? null,
					files: (terminal.files ?? []).map((file) => ({
						filename: file.filename,
						mimeType: file.mimeType,
						sizeBytes: file.sizeBytes,
						artifactId: file.artifactId ?? null,
					})),
					verification: verification.perFile,
					elapsedMs: Date.now() - startedAt,
				});

				if (testCase.label === "document-pdf" && ok) {
					const pdfFile = terminal.files?.[0] ?? null;
					if (pdfFile) {
						results.push(await verifyDocumentPdfReadbackSkip(page, pdfFile));
					}
				}
			} catch (error) {
				// One bad case must not abort the sweep: the rest are the data this
				// run exists to collect.
				results.push({
					label: testCase.label,
					sourceMode: testCase.sourceMode,
					requestedType: testCase.requestedType,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					elapsedMs: Date.now() - startedAt,
				});
			}
		}

		for (const negativeCase of selectedNegativeCases) {
			const startedAt = Date.now();
			if (negativeCase.needsDocker && skipDocker) {
				results.push({
					label: negativeCase.label,
					skipped: true,
					ok: true,
					reason:
						negativeCase.skipReason ??
						"needs Docker; skipped via LIVE_FILE_PRODUCTION_SKIP_DOCKER=true",
					elapsedMs: 0,
				});
				continue;
			}
			try {
				const result = await negativeCase.run(page, conversationId);
				results.push({ ...result, elapsedMs: Date.now() - startedAt });
			} catch (error) {
				results.push({
					label: negativeCase.label,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
					elapsedMs: Date.now() - startedAt,
				});
			}
		}
	} finally {
		if (conversationId && !keepConversation) {
			await deleteConversation(page, conversationId);
		}
		await browser.close();
	}

	const summary = {
		baseUrl,
		conversationId,
		keptConversation: keepConversation,
		createdAt: new Date().toISOString(),
		results,
		ok: results.every((result) => result.ok === true),
	};
	await writeFile(
		path.join(outputDir, "summary.json"),
		JSON.stringify(summary, null, 2),
	);
	console.log(JSON.stringify(summary, null, 2));

	// A compact table (case, expected, actual, pass/fail, ms) for a human
	// glancing at CI output, alongside the full summary.json above.
	const table = results.map((result) => ({
		case: String(result.label ?? "?"),
		expected: result.skipped
			? "skipped"
			: typeof result.status === "string"
				? "succeeded"
				: typeof result.httpStatus === "number"
					? "refused"
					: "ok",
		actual: result.skipped
			? (result.reason ?? "skipped")
			: (result.status ?? result.httpStatus ?? (result.ok ? "ok" : "not ok")),
		pass: result.ok === true ? "PASS" : "FAIL",
		ms: result.elapsedMs ?? "",
	}));
	console.table(table);

	if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
