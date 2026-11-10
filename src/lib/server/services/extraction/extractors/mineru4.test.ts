// The MinerU 4.1 extractor, against the in-process 4.1 server.
//
// The ledger is not involved here: `mineru/integration.test.ts` runs the same
// extractor through the real worker. This file is about the extractor's own
// contract: what it asks the server before it asks for anything, what it emits
// and when, what it leaves on disk, which failure each refusal becomes, and
// what it does when the server forgets, changes its mind or is not the server
// it was expected to be.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import {
	getMineruStatusReport,
	resetMineruCapabilitiesCacheForTests,
	setMineruProbeClientFactory,
} from "$lib/server/services/mineru/capabilities";
import { MineruClient } from "$lib/server/services/mineru/client";
import type { MineruConfig } from "$lib/server/services/mineru/config";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	type FakeMineruServerOptions,
	MINERU_4_0_12_ERRORS,
	MINERU_FIXTURE_ROOT,
} from "$lib/server/services/mineru/testing/fake-server";
import { FILE_TYPE_ENTRIES } from "$lib/shared/file-types";
import type {
	ExtractDocumentRequest,
	ExtractionFile,
	ExtractionHandle,
	ExtractionProgress,
} from "../contracts";
import {
	DocumentExtractionError,
	ExtractionAbortError,
	extractionErrorMessage,
	isDocumentExtractionError,
} from "../contracts";
import { readerFileFor } from "../reader-input";
import {
	canonicalTaskFileName,
	createMineru4Extractor,
	installMineruProbeClientFactory,
	isMineru4StructuredPayload,
	MINERU4_EXTRACTOR_NAME,
	type Mineru4StructuredPayload,
	readHintedTier,
	readPreferredTier,
	toNormalizedName,
} from "./mineru4";

const TMP_PREFIX = "alfyai-mineru4-";

let server: FakeMineruServer;
let workDir: string;
let tempRoot: string;

function config(
	baseUrl: string,
	overrides: Partial<MineruConfig> = {},
): MineruConfig {
	return {
		baseUrl,
		apiKey: "",
		defaultTier: "auto",
		ocrMode: "auto",
		jobTimeoutMs: 20_000,
		pollMinMs: 5,
		pollMaxMs: 25,
		requestTimeoutMs: 5_000,
		transferTimeoutMs: 10_000,
		capabilitiesTtlMs: 0,
		bundleMaxBytes: 33_554_432,
		bundleUserQuotaBytes: 0,
		structureChunking: true,
		...overrides,
	};
}

function extractorFor(
	overrides: Partial<MineruConfig> = {},
	clientOverride?: (config: MineruConfig) => MineruClient,
) {
	const resolved = config(server.baseUrl, overrides);
	return createMineru4Extractor({
		resolveConfig: () => resolved,
		tempDirRoot: tempRoot,
		...(clientOverride ? { createClient: clientOverride } : {}),
	});
}

/** An extractor whose client talks to the fake through `fetchImpl`. */
function extractorThrough(
	fetchImpl: typeof fetch,
	overrides: Partial<MineruConfig> = {},
) {
	return extractorFor(
		overrides,
		(resolved) => new MineruClient({ config: resolved, fetchImpl }),
	);
}

interface RequestOverrides extends Partial<ExtractDocumentRequest> {
	fixture?: string;
	/** The digest the ledger holds of the file, when it holds one; null: the extractor hashes it. */
	contentSha256?: string | null;
}

async function buildRequest(overrides: RequestOverrides = {}): Promise<{
	request: ExtractDocumentRequest;
	/** What `request.openFile()` hands out. */
	file: ExtractionFile;
	/** `request.openFile`, as a spy: how often, and when, the extractor asked for the file. */
	openFile: Mock<() => Promise<ExtractionFile>>;
	progress: ExtractionProgress[];
	controller: AbortController;
}> {
	const fixture = overrides.fixture ?? "pdf";
	const fileName = overrides.fileName ?? `sample.${fixture}`;
	const source = join(MINERU_FIXTURE_ROOT, fixture, `sample.${fixture}`);
	const bytes = await readFile(source);
	// The copy on disk keeps a plain name: the user's name (which may be anything)
	// is a separate field on the request, and never a path.
	const absolute = join(workDir, `source-${fixture}`);
	await writeFile(absolute, bytes);

	const progress: ExtractionProgress[] = [];
	const controller = new AbortController();
	const { fixture: _drop, contentSha256 = null, ...rest } = overrides;
	const file: ExtractionFile = {
		filePathAbsolute: absolute,
		sizeBytes: bytes.byteLength,
		contentSha256,
	};
	const openFile = vi.fn(async () => file);

	return {
		progress,
		controller,
		file,
		openFile,
		request: {
			fileName,
			mimeType: "application/pdf",
			openFile,
			intakeRoute: "mineru",
			signal: controller.signal,
			onProgress: (entry) => progress.push(entry),
			...rest,
		} as ExtractDocumentRequest,
	};
}

/** The same request, its file opened as `file` changed by `patch` says. */
function openingAs(
	request: ExtractDocumentRequest,
	file: ExtractionFile,
	patch: Partial<ExtractionFile>,
): ExtractDocumentRequest {
	return { ...request, openFile: async () => ({ ...file, ...patch }) };
}

/** What the fake had been asked, as `METHOD /path`, at the moment this is called. */
function requestsSoFar(): string[] {
	return server.requests.map((entry) => `${entry.method} ${entry.path}`);
}

/**
 * Per-attempt download directories, counted inside a PRIVATE root.
 *
 * The extractor defaults to the OS temp directory, which every other test file
 * and every other process on the box also writes to; counting there is a race
 * that fails for reasons that have nothing to do with this code. `tempDirRoot`
 * exists so the count is about this test and nothing else.
 */
async function tempDirCount(): Promise<number> {
	const entries = await readdir(tempRoot);
	return entries.filter((entry) => entry.startsWith(TMP_PREFIX)).length;
}

/** The server the running test started, until `afterEach` has closed it. */
let running: FakeMineruServer | null = null;

async function start(options: FakeMineruServerOptions = {}): Promise<void> {
	server = await createFakeMineruServer(options);
	running = server;
	resetMineruCapabilitiesCacheForTests();
}

// -- what the fake saw ----------------------------------------------------------

const TASK_PATH = /^\/v1\/tasks\/[^/]+$/;

function creates() {
	return server.requests.filter(
		(entry) => entry.method === "POST" && entry.path === "/v1/tasks",
	);
}
function uploads() {
	return server.requests.filter((entry) => entry.method === "PUT");
}
function polls() {
	return server.requests.filter(
		(entry) => entry.method === "GET" && TASK_PATH.test(entry.path),
	);
}
function cancels() {
	return server.requests.filter(
		(entry) => entry.method === "POST" && entry.path.endsWith("/cancel"),
	);
}
function downloads() {
	return server.requests.filter(
		(entry) =>
			entry.method === "GET" &&
			/^\/v1\/files\/[^/]+\/content$/.test(entry.path),
	);
}
interface CreateBody {
	files: Array<{ file_name: string; bytes: number; sha256sum: string }>;
	output_formats: string[];
	tier?: string;
	ocr_mode?: string;
}
function createBody(index = 0): CreateBody {
	return creates()[index]?.json as CreateBody;
}

function urlOf(input: RequestInfo | URL): string {
	return typeof input === "string"
		? input
		: input instanceof URL
			? input.href
			: input.url;
}

/** Tells the fake to forget everything just before the first request matching. */
function restartBefore(
	matches: (method: string, path: string) => boolean,
): typeof fetch {
	let fired = false;
	return async (input, init) => {
		const path = new URL(urlOf(input)).pathname;
		if (!fired && matches((init?.method ?? "GET").toUpperCase(), path)) {
			fired = true;
			server.restart();
		}
		return fetch(input, init);
	};
}

/** Tells the fake to forget everything right after the Nth poll was answered. */
function restartAfterPoll(nth: number): typeof fetch {
	let seen = 0;
	return async (input, init) => {
		const response = await fetch(input, init);
		const path = new URL(urlOf(input)).pathname;
		if (
			(init?.method ?? "GET").toUpperCase() === "GET" &&
			TASK_PATH.test(path)
		) {
			seen += 1;
			if (seen === nth) server.restart();
		}
		return response;
	};
}

/**
 * The handle a worker would have stored when it was stopped the instant the
 * remote task existed (the ledger keeps what `onProgress` was last given).
 */
async function handleOfAnAttemptStoppedAt(
	phase: ExtractionProgress["phase"],
	request: ExtractDocumentRequest,
	extractor = extractorFor(),
): Promise<ExtractionHandle> {
	const controller = new AbortController();
	let handle: ExtractionHandle | null = null;
	await extractor
		.extract({
			...request,
			signal: controller.signal,
			onProgress: (entry) => {
				if (entry.handle) handle = entry.handle;
				if (entry.phase === phase && entry.handle) {
					controller.abort(new ExtractionAbortError("claim-lost"));
				}
			},
		})
		.catch(() => undefined);
	if (!handle) throw new Error("the attempt never produced a handle");
	return handle;
}

beforeEach(async () => {
	installMineruProbeClientFactory();
	// Deliberately NOT the `alfyai-mineru4-` prefix the extractor uses for its
	// own per-attempt directories: `tempDirCount()` counts those, and a source
	// directory that shared the prefix would make every cleanup assertion lie.
	const suffix = Math.random().toString(36).slice(2);
	workDir = join(tmpdir(), `alfyai-m4src-${suffix}`);
	tempRoot = join(tmpdir(), `alfyai-m4tmp-${suffix}`);
	await mkdir(workDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
});

afterEach(async () => {
	// Only the server THIS test started: a test that needs none (a table of names,
	// a guard over the registry) must not close the last test's, a second time.
	const started = running;
	running = null;
	await started?.close();
	// A test may stand something else in front of the capability probe.
	setMineruProbeClientFactory(
		(resolved) => new MineruClient({ config: resolved }),
	);
	resetMineruCapabilitiesCacheForTests();
	await rm(workDir, { recursive: true, force: true });
	await rm(tempRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("normalized name", () => {
	it("produces a .md name and survives multiple dots", () => {
		// Re-homed verbatim from the deleted 3.x client's test.
		expect(toNormalizedName("Quarterly Report.pdf")).toBe(
			"Quarterly Report.md",
		);
		expect(toNormalizedName("archive.2026.final.docx")).toBe(
			"archive.2026.final.md",
		);
		expect(toNormalizedName("noextension")).toBe("noextension.md");
		expect(toNormalizedName(".gitignore")).toBe(".gitignore.md");
	});
});

describe("tier hints", () => {
	it("reads only a known tier out of an opaque hint blob", () => {
		expect(readHintedTier({ tier: "standard" })).toBe("standard");
		expect(readHintedTier({ tier: "bogus" })).toBeNull();
		expect(readHintedTier({ tier: 3 })).toBeNull();
		expect(readHintedTier(null)).toBeNull();
		expect(readHintedTier(undefined)).toBeNull();
	});

	it("keeps the soft preference on its own key", () => {
		expect(readPreferredTier({ preferredTier: "flash" })).toBe("flash");
		expect(readPreferredTier({ preferredTier: "bogus" })).toBeNull();
		expect(readPreferredTier({ tier: "flash" })).toBeNull();
		expect(readHintedTier({ preferredTier: "flash" })).toBeNull();
		expect(readPreferredTier(null)).toBeNull();
	});
});

describe("the name MinerU is told (S3)", () => {
	it.each([
		// The registry's canonical extension, whatever the spelling the user used.
		["Quarterly Report.PDF", "application/pdf", "document.pdf"],
		["photo.JPEG", "image/jpeg", "document.jpg"],
		["scan.jfif", null, "document.jpg"],
		["page.htm", "text/html", "document.html"],
		["table.csv", "text/csv", "document.csv"],
		// MinerU 4.1.7 reads `tiff` and has never read `tif` (and routes by the
		// extension, D17), so a TIFF goes under the one spelling it accepts,
		// whichever the user used, and when only the declared type says what it is.
		["scan.tif", "image/tiff", "document.tiff"],
		["scan.TIFF", "image/tiff", "document.tiff"],
		["scan.tiff", null, "document.tiff"],
		["scan", "image/tiff", "document.tiff"],
		// A name the user would have trouble getting past 4.1 (it rejects / \ : and
		// control characters, D18) never travels.
		["Árvíztűrő: jelentés/2026\\final.pdf", "application/pdf", "document.pdf"],
		["rep\u0007ort\nfinal.docx", null, "document.docx"],
		["C:\\input\\report.csv", "text/csv", "document.csv"],
		["../../etc/passwd.pdf", "application/pdf", "document.pdf"],
		// No extension: the declared type decides.
		["Quarterly report", "application/pdf", "document.pdf"],
		[
			"Minutes",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			"document.docx",
		],
		// Nothing the registry knows: the user's extension, if it is a plain word.
		["notes.XYZ", "application/octet-stream", "document.xyz"],
		// …and nothing at all when it is not.
		["weird.p:df", null, "document"],
		["no-extension", null, "document"],
		["trailing.", null, "document"],
		["dots.here.and.there.because we can", null, "document"],
	])("%j (%s) is sent as %s", (name, mimeType, expected) => {
		expect(canonicalTaskFileName(name, mimeType)).toBe(expected);
	});

	it("never carries a path separator, a colon or a control character", () => {
		for (const name of [
			"a/b.pdf",
			"a\\b.pdf",
			"a:b.pdf",
			"x\u0000y.pdf",
			"x\ty.pdf",
			".pdf",
			"..",
			"",
		]) {
			expect(canonicalTaskFileName(name, "application/pdf")).toMatch(
				/^document(\.[a-z0-9]+)?$/,
			);
		}
	});

	it("reaches the server as document.<ext>, whatever the user called the file", async () => {
		await start();
		const { request } = await buildRequest({
			fileName: "Árvíztűrő tükörfúrógép: jelentés/2026\\végleges\u0007.PDF",
		});

		await extractorFor().extract(request);

		expect(createBody().files[0].file_name).toBe("document.pdf");
		expect([...server.tasks.values()][0].files[0].fileName).toBe(
			"document.pdf",
		);
		// …and the user's own name is still what the normalized artifact is called.
		expect(JSON.stringify(server.requests)).not.toContain("rvíztűrő");
	});
});

describe("the registry against what MinerU 4.1.7 accepts", () => {
	// The extensions MinerU 4.1.7 routes a file by, copied from its installed
	// source, `mineru/filetypes.py` lines 29-58 (4.0.12 has the same list). It
	// routes by extension (D17), so a file sent under any other name is refused
	// for good: `Unsupported file type`.
	const ACCEPTED_BY_MINERU_4_1_7 = new Set([
		"pdf",
		// tiered
		"png",
		"jpg",
		"jpeg",
		"webp",
		"gif",
		"bmp",
		"tiff",
		"jp2",
		// flash only
		"doc",
		"docx",
		"ppt",
		"pptx",
		"xls",
		"xlsx",
		"rtf",
		"odt",
		"ods",
		"odp",
		"html",
		"htm",
		"shtml",
		"mhtml",
		"mht",
		"csv",
		"tsv",
		"epub",
		"ofd",
	]);

	/**
	 * Registry entries routed to MinerU that no conversion makes acceptable to it,
	 * each with its reason. None today: HEIC and HEIF were here (neither 4.0.12 nor
	 * 4.1.7 accepts them) until the extraction runner began handing MinerU a PNG of
	 * such a photo (`intake.readAs`), so what MinerU receives is `document.png`.
	 * The list stays for the next type it will not take, and the staleness test
	 * below keeps whatever is on it honest.
	 */
	const KNOWN_EXCEPTIONS = new Map<string, string>();

	type Entry = (typeof FILE_TYPE_ENTRIES)[number];

	/**
	 * The name MinerU is told for a file saved as `file.<extension>` of this type:
	 * what the extraction runner hands the extractor, through the extractor's own
	 * `canonicalTaskFileName`. That is the stored name, or, for a type the registry
	 * says is read as another (`intake.readAs`), the name of the converted file.
	 */
	const nameMinerUReceives = (entry: Entry, extension: string): string => {
		const stored = `file.${extension}`;
		if (entry.intake.readAs === undefined) {
			return canonicalTaskFileName(stored, null);
		}
		const converted = readerFileFor(stored, entry.intake.readAs);
		return canonicalTaskFileName(converted.fileName, converted.mimeType);
	};
	const sentExtension = (entry: Entry): string =>
		nameMinerUReceives(entry, entry.extensions[0]).replace(/^document\./, "");
	const routedToMineru = FILE_TYPE_ENTRIES.filter(
		(entry) => entry.intake.route === "mineru",
	);
	/** MinerU is told a name whose extension it does not list. */
	const isRefused = (entry: Entry): boolean =>
		!ACCEPTED_BY_MINERU_4_1_7.has(sentExtension(entry));
	/** The listed exceptions that are not true any more: not routed to MinerU, or not refused. */
	const staleExceptions = (
		exceptions: ReadonlyMap<string, string>,
		entries: readonly Entry[] = routedToMineru,
	): string[] =>
		[...exceptions.keys()].filter((id) => {
			const entry = entries.find((candidate) => candidate.id === id);
			return entry === undefined || !isRefused(entry);
		});

	it("sends every type routed to MinerU under an extension it accepts", () => {
		const refused = routedToMineru
			.filter((entry) => !KNOWN_EXCEPTIONS.has(entry.id))
			.filter(isRefused)
			.map(
				(entry) => `${entry.id} is sent as document.${sentExtension(entry)}`,
			);
		expect(refused).toEqual([]);
	});

	it("sends every spelling of a type under that one extension", () => {
		// `.tif` and `.tiff`, `.jpg` / `.jpeg` / `.jfif`, `.html` / `.htm`: the
		// user's spelling never decides.
		for (const entry of routedToMineru) {
			for (const extension of entry.extensions) {
				expect(
					nameMinerUReceives(entry, extension),
					`${entry.id}: .${extension}`,
				).toBe(`document.${sentExtension(entry)}`);
			}
		}
	});

	it("lists as exceptions only types that really are routed to MinerU and really are refused", () => {
		// An exception that has stopped being one (its routing changed, MinerU
		// learned the type, or the app began to convert it) must leave the list, not
		// rot in it.
		expect(staleExceptions(KNOWN_EXCEPTIONS)).toEqual([]);
	});

	it("tells a refused type from an accepted one, and a stale exception from a true one", () => {
		// What keeps this guard from going quiet now that the list is empty. A HEIC
		// photo is read as a PNG, so MinerU receives document.png and takes it...
		const heic = routedToMineru.find((entry) => entry.id === "heic");
		if (!heic) {
			throw new Error("the registry has no heic entry routed to MinerU");
		}
		expect(nameMinerUReceives(heic, "heic")).toBe("document.png");
		expect(isRefused(heic)).toBe(false);
		// ...and that conversion is all there is between it and a refusal: without
		// it the photo is sent as document.heic, which MinerU has never accepted.
		const unconverted: Entry = {
			...heic,
			intake: { ...heic.intake, readAs: undefined },
		};
		expect(nameMinerUReceives(unconverted, "heic")).toBe("document.heic");
		expect(isRefused(unconverted)).toBe(true);

		// So an exception for HEIC is stale while it is converted and true when it
		// is not; one for a type MinerU accepts, or that is never routed to it
		// (AVIF is refused at upload), is stale whatever happens to the others.
		const listed = new Map([
			["heic", "listed"],
			["png", "listed"],
			["avif", "listed"],
		]);
		expect(staleExceptions(listed)).toEqual(["heic", "png", "avif"]);
		expect(
			staleExceptions(new Map([["heic", "listed"]]), [unconverted]),
		).toEqual([]);
	});
});

describe("the happy path", () => {
	it("creates one task, uploads, polls, downloads only the result and returns the prompt text", async () => {
		await start({ fixtureInput: "pdf" });
		const { request, file, progress } = await buildRequest();

		const result = await extractorFor().extract(request);

		expect(result.mimeType).toBe("text/markdown");
		expect(result.normalizedName).toBe("sample.md");
		expect(result.text.length).toBeGreaterThan(0);
		expect(result.pageCount).toBe(3);

		// The running heads the PDF fixture carries are dropped, and the figure
		// became a `[Figure N]` handle rather than an image link.
		expect(result.text).not.toContain("INDIA Confidential");
		expect(result.text).not.toContain("JULIET Document Footer");
		expect(result.text).not.toContain("![](");

		const paths = server.requests.map(
			(entry) => `${entry.method} ${entry.path}`,
		);
		expect(paths).toContain("GET /v1/health");
		expect(paths).toContain("GET /v1/tiers");
		expect(creates()).toHaveLength(1);
		expect(uploads()).toHaveLength(1);
		expect(polls().length).toBeGreaterThan(0);
		// ONE download: the result of the one file.
		expect(downloads()).toHaveLength(1);
		// Nothing of the 4.0 protocol is spoken any more.
		expect(paths.filter((path) => /\/v1\/(uploads|parse)/.test(path))).toEqual(
			[],
		);

		const body = createBody();
		expect(body.files).toHaveLength(1);
		expect(body.files[0].bytes).toBe(file.sizeBytes);
		expect(body.files[0].sha256sum).toMatch(/^[a-f0-9]{64}$/);
		// Only the default result, and only the keys a 4.1 server accepts (S5).
		expect(body.output_formats).toEqual(["default"]);
		expect(Object.keys(body).sort()).toEqual([
			"files",
			"output_formats",
			"tier",
		]);
		expect(Object.keys(body.files[0]).sort()).toEqual([
			"bytes",
			"file_name",
			"sha256sum",
		]);
		expect(body.tier).toBe("standard");

		// The handle exists from the moment the remote task does, before the PUT and
		// so before the first poll, so a worker that dies here resumes instead of
		// submitting a second task.
		expect(
			progress.map((entry) => [entry.phase, entry.handle != null]),
		).toEqual([
			["uploading", false],
			["uploading", true],
			["parsing", true],
			["downloading", true],
		]);
		const handle = progress[1].handle as ExtractionHandle;
		expect(handle.extractor).toBe(MINERU4_EXTRACTOR_NAME);
		expect(handle.remoteJobId).toMatch(/^job_/);
		expect(handle.remoteFileId).toMatch(/^file-/);
		expect(handle.remoteJobId).toBe([...server.tasks.keys()][0]);
		expect(handle.data?.sha256).toBe(body.files[0].sha256sum);
		expect(handle.data?.requestedTier).toBe("standard");
		expect(JSON.stringify(handle)).not.toMatch(/uploadId|outputZipFileId/);
	});

	it("carries the structured payload and writes the parse bundle", async () => {
		await start({ fixtureInput: "pdf" });
		const { request } = await buildRequest({
			userId: "user-1",
			sourceArtifactId: "11111111-2222-3333-4444-555555555555",
		});

		const previous = process.cwd();
		const cwd = join(workDir, "cwd");
		await mkdir(cwd, { recursive: true });
		process.chdir(cwd);
		let result: Awaited<ReturnType<ReturnType<typeof extractorFor>["extract"]>>;
		try {
			result = await extractorFor().extract(request);
		} finally {
			process.chdir(previous);
		}

		expect(isMineru4StructuredPayload(result.structured)).toBe(true);
		const structured = result.structured as Mineru4StructuredPayload;

		// Flat, so `structured.outline` / `.pageCount` / `.effectiveTier` read
		// exactly as the spec's persist contract writes them.
		expect(structured.markdown).toBe(result.text);
		expect(structured.parserVersion).toBe("mineru4/2");
		// What the RESULT says it was made by and at (the 4.0.4 capture this fake
		// serves)…
		expect(structured.producerVersion).toBe("4.0.4");
		expect(structured.effectiveTier).toBe("basic");
		// …and what the SERVER said about the file (the fake is a 4.1.7): the
		// per-file `parse` object, which is also where the tier the file really ran
		// at is read from (spike gotcha 12), not the request.
		expect(structured.serverParserVersion).toBe("4.1.7");
		expect(structured.jobTier).toBe("standard");
		expect(structured.pageCountKind).toBe("physical");
		expect(structured.pages).toHaveLength(3);
		expect(structured.outline.length).toBeGreaterThan(0);
		expect(structured.figures.length).toBeGreaterThan(0);

		// …plus the manifest, which is the only source of the bundle-derived
		// metadata keys.
		expect(structured.bundle).not.toBeNull();
		expect(structured.bundle?.sourceArtifactId).toBe(
			"11111111-2222-3333-4444-555555555555",
		);
		expect(structured.bundle?.normalizedArtifactId).toBeNull();
		expect(structured.bundle?.totalBytes).toBeGreaterThan(0);

		const bundleDir = join(
			cwd,
			"data",
			"knowledge",
			"user-1",
			"11111111-2222-3333-4444-555555555555.parse",
		);
		const written = await readdir(bundleDir);
		expect(written.sort()).toEqual([
			"images",
			"manifest.json",
			"normalized.md",
			"pages.json",
			"structured_content.json",
		]);
		expect(await readFile(join(bundleDir, "normalized.md"), "utf8")).toBe(
			result.text,
		);
	});

	it("skips the bundle when there is no artifact to hang it on", async () => {
		// A generated-file readback has no knowledge-tree bytes and therefore no
		// bundle; it must still produce text.
		await start({ fixtureInput: "docx" });
		const { request } = await buildRequest({
			fixture: "docx",
			fileName: "sample.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});

		const result = await extractorFor().extract(request);
		expect(result.text.length).toBeGreaterThan(0);
		expect((result.structured as Mineru4StructuredPayload).bundle).toBeNull();
	});

	it("reads the tier a native document ran at from the file's own parse, not from the request", async () => {
		// Spike gotcha 12: a native document always reports `flash`, and asked for
		// no tier at all, so nothing in the request can say it.
		await start({ fixtureInput: "docx" });
		const { request } = await buildRequest({
			fixture: "docx",
			fileName: "sample.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});

		const result = await extractorFor().extract(request);

		expect("tier" in createBody()).toBe(false);
		expect((result.structured as Mineru4StructuredPayload).jobTier).toBe(
			"flash",
		);
	});

	it("passes a configured OCR mode and leaves the key out for auto", async () => {
		await start();
		const { request } = await buildRequest();
		await extractorFor({ ocrMode: "ocr" }).extract(request);
		expect(createBody(0).ocr_mode).toBe("ocr");

		const second = await buildRequest();
		await extractorFor({ ocrMode: "auto" }).extract(second.request);
		expect("ocr_mode" in createBody(1)).toBe(false);
	});

	it("records, in the tier it logs, how it decided", async () => {
		await start();
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const { request } = await buildRequest();
		await extractorFor().extract(request);

		const decided = info.mock.calls.find((call) =>
			String(call[0]).includes("tier decided"),
		);
		expect(decided?.[1]).toMatchObject({
			tier: "standard",
			reason: "auto-best",
		});
		const created = info.mock.calls.find((call) =>
			String(call[0]).includes("task created"),
		);
		expect(created?.[1]).toMatchObject({
			cacheHit: false,
			tier: "standard",
		});
	});
});

describe("the digest", () => {
	it("reuses the ledger's sha256 instead of re-reading the file", async () => {
		await start();
		const { request, file } = await buildRequest();
		const resolved = config(server.baseUrl);
		const client = new MineruClient({ config: resolved });
		const sha = await client.sha256(file.filePathAbsolute);
		const spy = vi.spyOn(client, "sha256");

		await createMineru4Extractor({
			resolveConfig: () => resolved,
			createClient: () => client,
			tempDirRoot: tempRoot,
		}).extract(openingAs(request, file, { contentSha256: sha }));

		expect(spy).not.toHaveBeenCalled();
		expect(createBody().files[0].sha256sum).toBe(sha);
	});

	it("computes it when the ledger has none, and ignores a malformed one", async () => {
		await start();
		const { request, file } = await buildRequest();

		await extractorFor().extract(
			openingAs(request, file, { contentSha256: "not-a-digest" }),
		);

		expect(createBody().files[0].sha256sum).toMatch(/^[a-f0-9]{64}$/);
	});
});

// The photo of a HEIC upload is made when the extractor first needs bytes, and
// the extractor says when that is by asking for the file (`openFile`): after it
// has asked the server what it can do and has settled the tier, and not at all
// in an attempt that only polls a task which is already alive.
describe("asking for the file", () => {
	it("asks once, when it first needs the bytes: after the capability read, and before the task exists", async () => {
		await start();
		const { request, file, openFile } = await buildRequest();
		const seen: string[][] = [];
		openFile.mockImplementation(async () => {
			seen.push(requestsSoFar());
			return file;
		});

		await extractorFor().extract(request);

		// For the digest, for the size the task declares and for the PUT: one ask.
		expect(openFile).toHaveBeenCalledTimes(1);
		expect(seen[0]).toEqual(
			expect.arrayContaining(["GET /v1/health", "GET /v1/tiers"]),
		);
		expect(seen[0].some((entry) => entry.startsWith("POST /v1/tasks"))).toBe(
			false,
		);
		expect(seen[0].some((entry) => entry.startsWith("PUT"))).toBe(false);
	});

	it("asks once for an attempt that has to create its task again", async () => {
		// Two declarations and two PUTs, one file.
		await start({ restartAfterFirstUpload: true });
		const { request, openFile } = await buildRequest();

		await extractorFor().extract(request);

		expect(creates()).toHaveLength(2);
		expect(openFile).toHaveBeenCalledTimes(1);
	});

	it("does not ask while the server cannot say what it can do", async () => {
		await start();
		const { request, openFile } = await buildRequest();
		const resolved = config(`${server.baseUrl}/not-mineru4`);

		await expect(
			createMineru4Extractor({
				resolveConfig: () => resolved,
				tempDirRoot: tempRoot,
			}).extract(request),
		).rejects.toMatchObject({ code: "backend_misconfigured" });

		expect(openFile).not.toHaveBeenCalled();
	});

	it("does not ask when the tier cannot be had", async () => {
		await start({ tiers: ["flash", "basic"] });
		const { request, openFile } = await buildRequest({
			hints: { tier: "standard" },
		});

		await expect(extractorFor().extract(request)).rejects.toMatchObject({
			code: "tier_unavailable",
		});

		expect(openFile).not.toHaveBeenCalled();
	});

	it("lets a failure to open the file through as it is, with no task created", async () => {
		// The reader says what is wrong with a photo in the ledger's words
		// (`document_unreadable` for one libheif refuses); the extractor adds nothing.
		await start();
		const failure = new DocumentExtractionError({
			code: "document_unreadable",
			message: extractionErrorMessage("document_unreadable", ""),
			retryable: false,
			details: { reason: "image preparation failed: not a photo" },
		});
		const { request, openFile } = await buildRequest();
		openFile.mockRejectedValue(failure);

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toBe(failure);
		// It had asked the server what it can do, and was never given a task.
		expect(requestsSoFar()).toContain("GET /v1/health");
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(0);
	});

	it("stops with the cancel when the file is called off while it opens", async () => {
		await start();
		const { request, controller, openFile } = await buildRequest();
		const reason = new ExtractionAbortError("user-cancel");
		openFile.mockImplementation(async () => {
			controller.abort(reason);
			throw reason;
		});

		await expect(extractorFor().extract(request)).rejects.toMatchObject({
			code: "canceled",
			retryable: false,
		});

		expect(creates()).toHaveLength(0);
		expect(cancels()).toHaveLength(0);
	});
});

describe("tier resolution happens before the request is made", () => {
	it("refuses an unavailable re-extract tier without creating a task", async () => {
		await start({ tiers: ["flash", "basic"] });
		const { request } = await buildRequest({ hints: { tier: "standard" } });

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "tier_unavailable", retryable: false });
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(0);
		// The person reads a sentence of ours, never the setting's name or the
		// server's wording.
		expect(error.message).toBe(
			"The document service does not offer the requested quality tier. Ask an administrator to check the tier setting.",
		);
	});

	it.each([
		["standard", ["flash", "basic", "standard"]],
		["basic", ["flash", "basic"]],
		["flash", ["flash"]],
	] as const)("sends %s explicitly for a PDF on a server that lists %j", async (expected, tiers) => {
		await start({ tiers });
		const { request } = await buildRequest();

		await extractorFor().extract(request);

		// An omitted tier would have run at the server's start-up tier whatever
		// that is (D14); naming it is what makes "auto" mean "the best there is".
		expect(createBody().tier).toBe(expected);
	});

	it("never auto-picks advanced, even when the server lists it", async () => {
		await start({ tiers: ["flash", "basic", "standard", "advanced"] });
		const { request } = await buildRequest();
		await extractorFor().extract(request);
		expect(createBody().tier).toBe("standard");
	});

	it("tells MinerU a TIFF is a .tiff, whichever spelling the user's file had", async () => {
		// 4.1.7 reads .tiff and routes by extension; the canonical .tif is refused
		// for good (`Unsupported file type`), so every TIFF extraction failed.
		for (const [fileName, mimeType] of [
			["scan.tif", "image/tiff"],
			["scan.TIFF", "image/tiff"],
		] as const) {
			await start({ fixtureInput: "png" });
			const { request } = await buildRequest({
				fixture: "png",
				fileName,
				mimeType,
			});
			await extractorFor().extract(request);
			expect(createBody().files[0].file_name).toBe("document.tiff");
			expect(createBody().tier).toBe("standard");
			await running?.close();
			running = null;
		}
	});

	it("does not let one unreadable tier list decide the tier of every document that follows", async () => {
		// `/v1/tiers` fails once. The report that could not read it was cached with
		// no tiers, and for the whole TTL every PDF and image went out with NO tier
		// (D14: whatever the server starts at, which on a lower ceiling is a silent
		// downgrade). It is a failed refresh, not an answer to keep.
		await start({
			failures: [
				{
					path: "/v1/tiers",
					method: "GET",
					nth: 1,
					status: 503,
					body: {
						error: { code: "server_shutting_down", message: "stopping" },
					},
				},
			],
		});
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const cached = { capabilitiesTtlMs: 300_000 };
		const tierReads = () =>
			server.requests.filter((entry) => entry.path === "/v1/tiers");

		await extractorFor(cached).extract((await buildRequest()).request);
		// The one attempt that ran while the list was unreadable had nothing to
		// choose from (the one exception to S4)…
		expect("tier" in createBody(0)).toBe(false);
		expect(tierReads()).toHaveLength(1);

		// …and the next one reads the list again and names a tier.
		await extractorFor(cached).extract((await buildRequest()).request);
		expect(createBody(1).tier).toBe("standard");
		expect(tierReads()).toHaveLength(2);

		// A whole answer is kept, as it always was.
		await extractorFor(cached).extract((await buildRequest()).request);
		expect(createBody(2).tier).toBe("standard");
		expect(tierReads()).toHaveLength(2);
	});

	it("names a tier for an image too", async () => {
		await start({ fixtureInput: "png" });
		const { request } = await buildRequest({
			fixture: "png",
			fileName: "scan.png",
			mimeType: "image/png",
		});
		await extractorFor().extract(request);
		expect(createBody().tier).toBe("standard");
		expect(createBody().files[0].file_name).toBe("document.png");
	});

	it.each([
		[
			"docx",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		],
		[
			"xlsx",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		],
		[
			"pptx",
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		],
		["html", "text/html"],
	] as const)("sends NO tier for a native %s document", async (fixture, mimeType) => {
		await start({ fixtureInput: fixture });
		const { request } = await buildRequest({
			fixture,
			fileName: `sample.${fixture}`,
			mimeType,
		});

		await extractorFor().extract(request);

		expect("tier" in createBody()).toBe(false);
		expect(createBody().files[0].file_name).toBe(`document.${fixture}`);
	});

	it("sends no tier for a native document on a flash-only server either", async () => {
		await start({ tiers: ["flash"], fixtureInput: "docx" });
		const { request } = await buildRequest({
			fixture: "docx",
			fileName: "sample.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		});

		await extractorFor().extract(request);

		expect("tier" in createBody()).toBe(false);
	});

	it("sends no tier for a native document even when a re-extract asks for advanced", async () => {
		// `.docx` + `tier: advanced` is accepted at create and never runs (D14).
		await start({
			tiers: ["flash", "basic", "standard", "advanced"],
			fixtureInput: "docx",
		});
		const { request } = await buildRequest({
			fixture: "docx",
			fileName: "sample.docx",
			mimeType:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			hints: { tier: "advanced" },
		});

		await extractorFor().extract(request);

		expect("tier" in createBody()).toBe(false);
	});

	// Phase 6 D10: the generated-file readback's soft preference. A born-digital
	// PDF parses at flash instead of waiting on a cold basic job…
	it("sends a soft preferred tier the server offers", async () => {
		await start({ tiers: ["flash", "basic"] });
		const { request } = await buildRequest({
			hints: { preferredTier: "flash" },
		});

		await extractorFor().extract(request);

		expect(createBody().tier).toBe("flash");
	});

	// …and a server without flash still parses it, at the best tier it has, rather
	// than failing the job permanently the way an unavailable `hints.tier` does.
	it("degrades a soft preferred tier the server lacks", async () => {
		await start({ tiers: ["basic"] });
		const { request } = await buildRequest({
			hints: { preferredTier: "flash" },
		});

		const result = await extractorFor().extract(request);

		expect(result.text.length).toBeGreaterThan(0);
		expect(createBody().tier).toBe("basic");
	});

	it("honours a re-extract hint the server does offer", async () => {
		await start({ tiers: ["flash", "basic"] });
		const { request } = await buildRequest({ hints: { tier: "basic" } });

		await extractorFor().extract(request);

		expect(createBody().tier).toBe("basic");
	});

	it("honours the configured tier, and refuses one the server lacks", async () => {
		await start({ tiers: ["flash", "basic"] });
		const { request } = await buildRequest();
		await extractorFor({ defaultTier: "flash" }).extract(request);
		expect(createBody().tier).toBe("flash");

		await expect(
			extractorFor({ defaultTier: "advanced" }).extract(
				(await buildRequest()).request,
			),
		).rejects.toMatchObject({ code: "tier_unavailable", retryable: false });
		expect(creates()).toHaveLength(1);
	});

	it("fails once, clearly and without looping when the server turns out not to offer the tier", async () => {
		// The tier list was true when it was read and is not any more (the box was
		// restarted with a lower ceiling): the server answers 400 `invalid_request`
		// with `param: "tier"`, the real capture, pydantic dump and all.
		await start({
			failures: [
				{
					path: "/v1/tasks",
					method: "POST",
					fixture: "errors/08_tier_advanced_above_ceiling.json",
				},
			],
		});
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "tier_unavailable", retryable: false });
		expect(creates()).toHaveLength(1);
		expect(uploads()).toHaveLength(0);
		// The person never reads the server's pydantic dump or its URL…
		expect(error.message).toBe(
			"The document service does not offer the requested quality tier. Ask an administrator to check the tier setting.",
		);
		expect(error.message).not.toMatch(/pydantic|errors\.pydantic\.dev|Tier '/);
		// …an operator finds which parameter it was.
		expect(error.details).toMatchObject({
			mineruRule: "400:tier-not-available",
			mineruParam: "tier",
			httpStatus: 400,
		});
	});

	it.each([
		["a re-extract tier", {}, { hints: { tier: "standard" } }],
		["the configured tier", { defaultTier: "standard" as const }, {}],
	])("does not call %s missing when the tier list could not be read: the document waits, and goes through once it can", async (_name, overrides, requestOverrides) => {
		// `/v1/tiers` fails once. An empty list is no evidence that the server lacks
		// the tier, and `tier_unavailable` is never retried: one failed read would
		// have failed the document for good.
		await start({
			failures: [
				{
					path: "/v1/tiers",
					method: "GET",
					nth: 1,
					status: 503,
					body: {
						error: { code: "server_shutting_down", message: "stopping" },
					},
				},
			],
		});
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const error = await extractorFor(overrides)
			.extract((await buildRequest(requestOverrides)).request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "unavailable", retryable: true });
		expect(error.message).toBe("The document service could not be reached.");
		expect(error.details).toMatchObject({
			mineruRule: "client:tier-list-unreadable",
		});
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(0);

		// The report that lost its list was not kept: the next attempt reads it.
		await extractorFor(overrides).extract(
			(await buildRequest(requestOverrides)).request,
		);
		expect(createBody().tier).toBe("standard");
	});

	it("drops the tier list the server has just contradicted, so the next document reads it again", async () => {
		// The list was true when it was read; the box was then restarted at a lower
		// ceiling, and the list is cached for minutes more. The document that meets
		// the 400 fails, because the verdict is the server's. The ones behind it are
		// not held to a list that has been shown to be wrong.
		await start();
		const cached = { capabilitiesTtlMs: 300_000 };
		const tierReads = () =>
			server.requests.filter((entry) => entry.path === "/v1/tiers");

		await extractorFor(cached).extract((await buildRequest()).request);
		expect(createBody(0).tier).toBe("standard");
		expect(tierReads()).toHaveLength(1);

		server.setOptions({ tiers: ["flash", "basic"] });

		const error = await extractorFor(cached)
			.extract((await buildRequest()).request)
			.catch((thrown) => thrown);
		expect(error).toMatchObject({ code: "tier_unavailable", retryable: false });
		expect(createBody(1).tier).toBe("standard");
		// It was asked from the list on hand: nothing was read for it.
		expect(tierReads()).toHaveLength(1);

		await extractorFor(cached).extract((await buildRequest()).request);
		expect(tierReads()).toHaveLength(2);
		expect(createBody(2).tier).toBe("basic");

		// Once it is right again it is kept, as any whole answer is.
		await extractorFor(cached).extract((await buildRequest()).request);
		expect(tierReads()).toHaveLength(2);
		expect(createBody(3).tier).toBe("basic");
	});

	it("does not drop a tier list for a refusal that is not about the tier", async () => {
		await start({
			failures: [
				{
					path: "/v1/tasks",
					method: "POST",
					nth: 1,
					status: 400,
					body: {
						error: { code: "invalid_request", message: "x", param: "ocr_mode" },
					},
				},
			],
		});
		const cached = { capabilitiesTtlMs: 300_000 };
		const tierReads = () =>
			server.requests.filter((entry) => entry.path === "/v1/tiers");

		await extractorFor(cached)
			.extract((await buildRequest()).request)
			.catch(() => undefined);
		await extractorFor(cached).extract((await buildRequest()).request);

		expect(creates()).toHaveLength(2);
		expect(tierReads()).toHaveLength(1);
	});
});

describe("a backend that is not a MinerU 4.1", () => {
	it("fails NON-retryably and says so, rather than retrying forever", async () => {
		// A server that is not MinerU 4 has no /v1/health: FastAPI's own 404. An
		// `unavailable` would retry until the outage window ends on a fault no
		// retry can fix; `backend_misconfigured` is the honest verdict.
		await start();
		const { request } = await buildRequest();

		const resolved = config(`${server.baseUrl}/not-mineru4`);
		const error = await createMineru4Extractor({
			resolveConfig: () => resolved,
			tempDirRoot: tempRoot,
		})
			.extract(request)
			.catch((thrown) => thrown);

		expect(isDocumentExtractionError(error)).toBe(true);
		expect(error).toMatchObject({
			code: "backend_misconfigured",
			retryable: false,
		});
		expect(String((error as Error).message)).toContain("not a MinerU 4 server");
		expect(creates()).toHaveLength(0);
	});

	it("tells the admin status card the same thing, in words", async () => {
		// The card renders `report.error.message` under an "unreachable" pill.
		// Installing the real client as the capability probe is what makes that
		// message specific: the built-in probe would say "HTTP 404", and a bare
		// client would be read as an unrecognised Error and become `unavailable`.
		await start();
		const report = await getMineruStatusReport({
			config: config(`${server.baseUrl}/not-mineru4`),
		});

		expect(report.reachable).toBe(false);
		expect(report.error?.code).toBe("backend_misconfigured");
		expect(report.error?.message).toContain("not a MinerU 4 server");
		expect(report.error?.message).toContain(
			"MinerU 3.x is no longer supported",
		);
		expect(report.version).toBeNull();
	});

	it("still calls a refused connection an outage, which IS retryable", async () => {
		await start();
		const dead = await createFakeMineruServer();
		const deadUrl = dead.baseUrl;
		await dead.close();

		const { request } = await buildRequest();
		await expect(
			createMineru4Extractor({
				resolveConfig: () => config(deadUrl),
				tempDirRoot: tempRoot,
			}).extract(request),
		).rejects.toMatchObject({ code: "unavailable", retryable: true });
	});

	it("treats a 4.0.x server as one that is not there yet: unavailable, retryable, nothing sent", async () => {
		// 4.0.12 answers /v1/health like a healthy server. Reading its version is
		// what keeps the document out of a 400 (R14) and keeps the verdict one the
		// ledger retries with its patient outage budget.
		await start();
		setMineruProbeClientFactory(
			(resolved) =>
				new MineruClient({
					config: resolved,
					fetchImpl: async (input, init) =>
						urlOf(input).endsWith("/v1/health")
							? Response.json({ status: "ok", version: "4.0.12", features: {} })
							: fetch(input, init),
				}),
		);
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(isDocumentExtractionError(error)).toBe(true);
		expect(error).toMatchObject({ code: "unavailable", retryable: true });
		expect(error.details).toMatchObject({ stage: "capabilities" });
		expect(error.details?.rawMessage).toContain("4.0.12");
		expect(error.message).toBe("The document service could not be reached.");
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(0);
	});
});

describe("mapped failures", () => {
	it("maps a missing or wrong API key to auth_failed, non-retryable", async () => {
		await start({ apiKey: "the-real-key" });
		const { request } = await buildRequest();

		const error = await extractorFor({ apiKey: "" })
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "auth_failed", retryable: false });
		expect(uploads()).toHaveLength(0);
	});

	it("maps a rate limit and honours Retry-After", async () => {
		await start();
		let seen = 0;
		const extractor = extractorThrough(async (input, init) => {
			if (urlOf(input).endsWith("/v1/tasks") && init?.method === "POST") {
				seen += 1;
				return new Response(
					JSON.stringify({
						error: {
							code: "rate_limit_exceeded",
							message: "Too many requests",
						},
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "42",
						},
					},
				);
			}
			return fetch(input, init);
		});
		const { request } = await buildRequest();

		await expect(extractor.extract(request)).rejects.toMatchObject({
			code: "rate_limited",
			retryable: true,
			retryAfterMs: 42_000,
		});
		expect(seen).toBe(1);
	});

	describe("a file MinerU could not parse", () => {
		it.each([
			[
				"a corrupt PDF",
				"Failed to load document (PDFium: Data format error).",
				"document_unreadable",
				false,
				"damaged or password-protected",
			],
			[
				"a password-protected PDF",
				"Failed to load document (PDFium: Incorrect password error).",
				"document_unreadable",
				false,
				"damaged or password-protected",
			],
			[
				"a workbook that is not one",
				"Invalid XLSX package: file is not a ZIP archive.",
				"document_unreadable",
				false,
				"damaged or password-protected",
			],
			[
				"a type it cannot read",
				"Unsupported file type: notes.txt",
				"unsupported_type",
				false,
				"cannot read this file type",
			],
			[
				"a cause it does not name",
				"All connection attempts failed",
				"job_failed",
				true,
				"could not finish reading this file",
			],
		] as const)("%s becomes %s with a sentence of ours", async (_what, message, code, retryable, sentence) => {
			await start({ outcome: "file-failed", fileError: { message } });
			const { request } = await buildRequest();

			const error = await extractorFor()
				.extract(request)
				.catch((thrown) => thrown);

			expect(error).toMatchObject({ code, retryable, handleUnknown: true });
			expect(error.message).toContain(sentence);
			// MinerU's own words are never the person's.
			expect(error.message).not.toContain(message);
			expect(error.message).not.toMatch(/PDFium|XLSX|connection attempts/);
			// An operator still has them.
			expect(error.details?.rawMessage).toContain(message);
			expect(JSON.stringify(error.details)).toContain("parse_failed");
		});
	});

	it("calls an empty file empty itself: 4.1 answers 400 to a task of zero bytes", async () => {
		// Nothing about it is the server's to say (D22), and "the document service
		// sent a response this app could not use" would send the person looking in
		// the wrong place.
		await start();
		const { request, file } = await buildRequest();
		await writeFile(file.filePathAbsolute, "");

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "empty_result", retryable: false });
		expect(error.message).toContain("contains no readable text");
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(0);
	});

	it("maps an unmapped file error code to a retryable job_failed", async () => {
		await start({
			outcome: "file-failed",
			fileError: { code: "weird_new_code", message: "something new" },
		});
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({
			code: "job_failed",
			retryable: true,
			handleUnknown: true,
		});
		expect(error.details?.mineruRule).toBe("task:file-error-unmapped");
	});

	it("maps a failed file that says nothing about why to job_failed", async () => {
		await start({ outcome: "failed-without-detail" });
		const { request } = await buildRequest();

		await expect(extractorFor().extract(request)).rejects.toMatchObject({
			code: "job_failed",
			retryable: true,
			handleUnknown: true,
		});
	});

	it("maps a completed file without a result to protocol, and spends the task", async () => {
		await start({ outcome: "completed-without-result-url" });
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({
			code: "protocol",
			retryable: true,
			handleUnknown: true,
		});
		expect(downloads()).toHaveLength(0);
	});

	it("never shows a pydantic dump: a rejected manifest is a sentence of ours", async () => {
		await start({
			failures: [
				{
					path: "/v1/tasks",
					method: "POST",
					fixture: "errors/14_filename_dotdot_slash.json",
				},
			],
		});
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "protocol", retryable: false });
		expect(error.message).toBe(
			"The document service sent a response this app could not use.",
		);
		expect(JSON.stringify(error.details)).not.toMatch(/pydantic/);
		expect(error.details?.mineruParam).toBe("files.0.file_name");
	});
});

describe("a hostile download", () => {
	it("refuses a zip whose entry escapes the bundle directory", async () => {
		await start();
		const before = await tempDirCount();
		const zip = new JSZip();
		// A traversal entry beside a perfectly valid payload: the reader must
		// refuse the archive rather than quietly skip the entry, because a
		// skipped entry is a decision nobody reviewed.
		zip.file(
			"structured_content.json",
			JSON.stringify({ pages: [], metadata: {}, extensions: {} }),
		);
		zip.file("../escape.txt", "owned");
		const bytes = await zip.generateAsync({ type: "nodebuffer" });

		const resolved = config(server.baseUrl);
		const client = new MineruClient({ config: resolved });
		vi.spyOn(client, "downloadFile").mockImplementation(async (input) => {
			await writeFile(input.destinationPathAbsolute, bytes);
			return { bytes: bytes.byteLength };
		});

		const { request } = await buildRequest();
		await expect(
			createMineru4Extractor({
				resolveConfig: () => resolved,
				createClient: () => client,
				tempDirRoot: tempRoot,
			}).extract(request),
		).rejects.toMatchObject({
			code: "protocol",
			details: { mineruResultCode: "zip_entry_rejected" },
		});
		expect(await tempDirCount()).toBe(before);
	});

	describe("what the reader says about a result it will not use stays with the operator", () => {
		// `error_message` is read by the send gate and by the Knowledge row. The
		// reader's own messages name zip entries and quote the JSON they choked on,
		// which is a piece of the person's document.

		/** An attempt whose result download is a zip holding exactly `entries`. */
		async function extractFromZip(
			entries: Record<string, string>,
		): Promise<DocumentExtractionError> {
			await start();
			const zip = new JSZip();
			for (const [name, content] of Object.entries(entries)) {
				zip.file(name, content);
			}
			const bytes = await zip.generateAsync({ type: "nodebuffer" });
			const resolved = config(server.baseUrl);
			const client = new MineruClient({ config: resolved });
			vi.spyOn(client, "downloadFile").mockImplementation(async (input) => {
				await writeFile(input.destinationPathAbsolute, bytes);
				return { bytes: bytes.byteLength };
			});
			const { request } = await buildRequest();
			return (await createMineru4Extractor({
				resolveConfig: () => resolved,
				createClient: () => client,
				tempDirRoot: tempRoot,
			})
				.extract(request)
				.catch((thrown) => thrown)) as DocumentExtractionError;
		}

		const PROTOCOL_SENTENCE =
			"The document service sent a response this app could not use.";

		it("an entry the reader refuses is explained in the details, not in the sentence", async () => {
			const error = await extractFromZip({
				"structured_content.json": JSON.stringify({
					pages: [],
					metadata: {},
					extensions: {},
				}),
				"../escape.txt": "owned",
			});

			expect(error).toMatchObject({ code: "protocol", retryable: true });
			expect(error.message).toBe(PROTOCOL_SENTENCE);
			expect(error.message).not.toContain("escape");
			expect(error.details).toMatchObject({
				mineruResultCode: "zip_entry_rejected",
			});
			expect(error.details?.reason).toBeDefined();
			expect(String(error.details?.rawMessage)).toContain("refused");
		});

		it("a structured_content.json that is not JSON does not quote the document", async () => {
			const error = await extractFromZip({
				"structured_content.json":
					"SECRET-PARAGRAPH-OF-THE-PERSONS-DOCUMENT is not json {",
			});

			expect(error).toMatchObject({ code: "protocol", retryable: true });
			expect(error.message).toBe(PROTOCOL_SENTENCE);
			expect(error.message).not.toContain("SECRET");
			expect(error.details?.mineruResultCode).toBe(
				"structured_content_invalid",
			);
			// The operator keeps it, cut short.
			expect(String(error.details?.rawMessage)).toContain("SECRET");
			expect(String(error.details?.rawMessage).length).toBeLessThanOrEqual(301);
		});

		it("a result with nothing to read says what an empty document says", async () => {
			const error = await extractFromZip({
				"structured_content.json": JSON.stringify({
					pages: [],
					metadata: {},
					extensions: {},
				}),
			});

			expect(error).toMatchObject({ code: "empty_result", retryable: false });
			expect(error.message).toContain("contains no readable text");
			expect(error.message).not.toContain("renderable");
			expect(error.details?.mineruResultCode).toBe("empty_result");
			expect(String(error.details?.rawMessage)).toContain("renderable");
		});

		it("the api key is scrubbed from what the operator keeps", async () => {
			// A result whose JSON starts with the key: the parser quotes the first ten
			// characters of what it choked on, that quotation is the operator's line,
			// and the credential does not belong in it.
			await start({ apiKey: "sk-1234" });
			const zip = new JSZip();
			zip.file("structured_content.json", "sk-1234 is not JSON");
			const bytes = await zip.generateAsync({ type: "nodebuffer" });
			const resolved = config(server.baseUrl, { apiKey: "sk-1234" });
			const client = new MineruClient({ config: resolved });
			vi.spyOn(client, "downloadFile").mockImplementation(async (input) => {
				await writeFile(input.destinationPathAbsolute, bytes);
				return { bytes: bytes.byteLength };
			});
			const { request } = await buildRequest();
			const error = (await createMineru4Extractor({
				resolveConfig: () => resolved,
				createClient: () => client,
				tempDirRoot: tempRoot,
			})
				.extract(request)
				.catch((thrown) => thrown)) as DocumentExtractionError;

			expect(error.message).not.toContain("sk-1234");
			expect(String(error.details?.rawMessage)).not.toContain("sk-1234");
			expect(String(error.details?.rawMessage)).toContain("[redacted]");
		});
	});
});

describe("the temp directory", () => {
	it("is removed after a hostile or unreadable result zip", async () => {
		await start();
		const before = await tempDirCount();

		const resolved = config(server.baseUrl);
		const client = new MineruClient({ config: resolved });
		vi.spyOn(client, "downloadFile").mockImplementation(async (input) => {
			// A zip-shaped download that is not a MinerU result: no central
			// directory this reader will accept.
			await writeFile(
				input.destinationPathAbsolute,
				Buffer.from("PKnot a zip"),
			);
			return { bytes: 11 };
		});

		const { request } = await buildRequest();
		const error = await createMineru4Extractor({
			resolveConfig: () => resolved,
			createClient: () => client,
			tempDirRoot: tempRoot,
		})
			.extract(request)
			.catch((thrown) => thrown);

		expect(isDocumentExtractionError(error)).toBe(true);
		expect(error).toMatchObject({ code: "protocol" });
		expect(await tempDirCount()).toBe(before);
	});

	it("is removed after a success", async () => {
		await start();
		const before = await tempDirCount();
		const { request } = await buildRequest();
		await extractorFor().extract(request);
		expect(await tempDirCount()).toBe(before);
	});
});

describe("cancel", () => {
	/** Runs an attempt up to the point a remote task exists, then aborts it. */
	async function abortMidTask(reason?: ExtractionAbortError): Promise<{
		rejection: Promise<unknown>;
		before: number;
	}> {
		const { request, controller } = await buildRequest();
		const before = await tempDirCount();
		const running = extractorFor().extract(request);
		await vi.waitFor(() => {
			expect(creates().length).toBeGreaterThan(0);
		});
		controller.abort(reason);
		return { rejection: running, before };
	}

	it("cancels the remote task and throws canceled on a USER cancel", async () => {
		await start({ neverFinish: true });
		const { rejection, before } = await abortMidTask(
			new ExtractionAbortError("user-cancel"),
		);

		await expect(rejection).rejects.toMatchObject({
			code: "canceled",
			retryable: false,
		});
		await vi.waitFor(() => {
			expect(cancels()).toHaveLength(1);
		});
		const [taskId] = [...server.tasks.keys()];
		expect(cancels()[0].path).toBe(`/v1/tasks/${taskId}/cancel`);
		expect(server.tasks.get(taskId)?.status).toBe("canceled");
		expect(await tempDirCount()).toBe(before);
	});

	it("swallows a 409 task_already_terminal: the goal is met", async () => {
		// The task finished between the last poll and the cancel. The goal (it is
		// not running any more) is already met, and the extraction still ends as
		// the cancel it was.
		await start();
		const { request, controller } = await buildRequest();
		const extractor = extractorFor();
		const running = extractor.extract({
			...request,
			onProgress: (entry) => {
				if (entry.phase === "downloading") {
					controller.abort(new ExtractionAbortError("user-cancel"));
				}
			},
		});

		await expect(running).rejects.toMatchObject({ code: "canceled" });
		await vi.waitFor(() => {
			expect(cancels()).toHaveLength(1);
		});
		// The fake answered 409: the task was `completed`, and stayed that way.
		const [taskId] = [...server.tasks.keys()];
		expect(server.tasks.get(taskId)?.status).toBe("completed");
	});

	it.each([
		"claim-lost",
		"shutdown",
	] as const)("leaves the remote task alive on a %s abort", async (reason) => {
		// The stored handle exists precisely so the next attempt RESUMES this
		// remote task. Cancelling it on a stale-claim reclaim or a deploy restart
		// would turn a one-poll resume into a full re-upload and re-parse, and race
		// the worker that had just taken the claim.
		await start({ neverFinish: true });
		const { rejection, before } = await abortMidTask(
			new ExtractionAbortError(reason),
		);

		await expect(rejection).rejects.toMatchObject({ code: "canceled" });
		expect(cancels()).toHaveLength(0);
		// The task is still there for the next attempt to poll.
		const [taskId] = [...server.tasks.keys()];
		expect(server.tasks.get(taskId)?.status).not.toBe("canceled");
		expect(await tempDirCount()).toBe(before);
	});

	it("leaves the remote task alive on an unlabelled abort", async () => {
		// Cancelling a task that is still wanted costs the whole parse; keeping one
		// nobody reads costs a queue slot. An abort with no reason takes the
		// cheaper mistake.
		await start({ neverFinish: true });
		const { rejection } = await abortMidTask();

		await expect(rejection).rejects.toMatchObject({ code: "canceled" });
		expect(cancels()).toHaveLength(0);
	});

	it("cancels from a stored handle without re-reading the document, twice without complaint", async () => {
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		const extractor = extractorFor();
		const handle = await handleOfAnAttemptStoppedAt(
			"parsing",
			request,
			extractor,
		);
		server.resetLog();

		await extractor.cancel?.(handle);
		expect(cancels()).toHaveLength(1);
		// A second cancel is a 409 the client swallows: cancelling twice is not an
		// error, it is the goal already met.
		await expect(extractor.cancel?.(handle)).resolves.toBeUndefined();
		expect(cancels()).toHaveLength(2);
	});

	it("does not cancel anything for a handle that names no task of ours", async () => {
		await start();
		await extractorFor().cancel?.({
			extractor: MINERU4_EXTRACTOR_NAME,
			version: 1,
			remoteJobId: "job_from_the_old_protocol",
			remoteFileId: "file-old",
			data: { uploadId: "upload_old" },
		});
		expect(cancels()).toHaveLength(0);
	});
});

describe("the whole-job deadline", () => {
	// A deadline reached means one of two things, and they are not the same fault.
	// MinerU had not started the file (its queue is long, or a cold start is still
	// loading models): that is the box's, it says nothing about the document, and
	// it waits the way an outage waits. MinerU HAD started it and it was still
	// running: the document is too slow for the deadline, and trying it again
	// exactly the same way is an attempt like any other retryable failure, so it
	// ends after the normal attempt budget instead of being re-parsed from scratch
	// for half an hour. The task is cancelled either way.
	const TIMEOUT_SENTENCE = "The document service did not answer in time.";

	/** Snapshots that always show the file queued: a MinerU with a long line. */
	const queued: typeof fetch = async (input, init) => {
		const response = await fetch(input, init);
		if (
			(init?.method ?? "GET") !== "GET" ||
			!TASK_PATH.test(new URL(urlOf(input)).pathname)
		) {
			return response;
		}
		const body = (await response.json()) as {
			status: string;
			files: Array<Record<string, unknown>>;
		};
		body.status = "pending";
		for (const file of body.files) file.status = "pending";
		return Response.json(body, { status: response.status });
	};

	it("counts as an attempt when MinerU was running the file: job_failed, with the timeout's sentence", async () => {
		await start({ neverFinish: true });
		const before = await tempDirCount();
		const { request } = await buildRequest();

		const error = await extractorFor({ jobTimeoutMs: 400 })
			.extract(request)
			.catch((thrown) => thrown);

		// `job_failed` is the ledger's attempt budget; the sentence is the timeout's.
		expect(error).toMatchObject({ code: "job_failed", retryable: true });
		expect(error.message).toBe(TIMEOUT_SENTENCE);
		// The task we cancelled is spent: resuming it would only find it canceled,
		// and cost the document an attempt for nothing.
		expect(error.handleUnknown).toBe(true);
		expect(error.details).toMatchObject({
			mineruRule: "client:job-deadline",
			fileStatus: "running",
			deadlineMs: 400,
		});
		expect(cancels()).toHaveLength(1);
		const [taskId] = [...server.tasks.keys()];
		expect(server.tasks.get(taskId)?.status).toBe("canceled");
		expect(await tempDirCount()).toBe(before);
	});

	it("waits like an outage when MinerU had not started the file: timeout, no attempt spent", async () => {
		await start({ neverFinish: true });
		const { request } = await buildRequest();

		const error = await extractorThrough(queued, { jobTimeoutMs: 400 })
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "timeout", retryable: true });
		expect(error.message).toBe(TIMEOUT_SENTENCE);
		expect(error.handleUnknown).toBe(true);
		expect(error.details).toMatchObject({ fileStatus: "pending" });
		expect(cancels()).toHaveLength(1);
		const [taskId] = [...server.tasks.keys()];
		expect(server.tasks.get(taskId)?.status).toBe("canceled");
	});

	it("waits like an outage when the deadline is already over before the first look", async () => {
		// A long upload can use up the whole deadline. Nothing was seen of the file,
		// so nothing says MinerU started it.
		await start({ neverFinish: true });
		let clock = 0;
		const extractor = createMineru4Extractor({
			resolveConfig: () => config(server.baseUrl, { jobTimeoutMs: 1_000 }),
			tempDirRoot: tempRoot,
			now: () => clock,
		});
		const { request } = await buildRequest();

		const error = await extractor
			.extract({
				...request,
				onProgress: (entry) => {
					// The upload is over and the clock has run past the deadline.
					if (entry.phase === "parsing") clock = 60_000;
				},
			})
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "timeout", retryable: true });
		expect(error.handleUnknown).toBe(true);
		expect(error.details?.fileStatus).toBeNull();
		expect(polls()).toHaveLength(0);
		expect(cancels()).toHaveLength(1);
	});

	it("says in the log which of the two it was", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		await extractorFor({ jobTimeoutMs: 400 })
			.extract(request)
			.catch(() => undefined);

		const logged = warn.mock.calls.find((call) =>
			String(call[0]).includes("did not finish within the deadline"),
		);
		expect(logged?.[1]).toMatchObject({
			fileStatus: "running",
			spendsAnAttempt: true,
		});
	});
});

describe("restart amnesia: a server that forgets every id (S6)", () => {
	// MinerU keeps tasks, files and its hash cache in memory (spike section 8): a
	// restart forgets all of it, wherever in the flow it lands. Every step must end
	// in a completed extraction, by creating the task again and uploading again,
	// and none may loop.

	function expectRecovered(result: { text: string }, uploadsExpected: number) {
		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(2);
		expect(uploads()).toHaveLength(uploadsExpected);
		// The second create meets a server with an empty hash cache: it waits for
		// bytes again, and the bytes are sent again.
		expect(createBody(1).files[0].sha256sum).toBe(
			createBody(0).files[0].sha256sum,
		);
	}

	it("before the PUT: the link the 202 handed out is dead", async () => {
		await start({ restartAfterFirstTask: true });
		const { request } = await buildRequest();

		const result = await extractorFor().extract(request);

		// One PUT that found nothing (404), one that landed.
		expectRecovered(result, 2);
		expect(server.tasks.size).toBe(1);
	});

	it("after the PUT: the poll finds no task", async () => {
		await start({ restartAfterFirstUpload: true });
		const { request } = await buildRequest();

		const result = await extractorFor().extract(request);

		expectRecovered(result, 2);
	});

	it("mid-poll: the second poll finds no task", async () => {
		await start({ inProgressPolls: 4 });
		const { request } = await buildRequest();

		const result = await extractorThrough(restartAfterPoll(2)).extract(request);

		expectRecovered(result, 2);
		expect(polls().length).toBeGreaterThan(3);
	});

	it("at the download: the result is gone (file_not_found on result_url)", async () => {
		await start();
		const { request } = await buildRequest();

		const result = await extractorThrough(
			restartBefore(
				(method, path) => method === "GET" && path.startsWith("/v1/files/"),
			),
		).extract(request);

		expectRecovered(result, 2);
		// The result that was fetched is the second task's.
		expect(downloads().length).toBe(2);
	});

	it("never reports a phase backwards while recovering", async () => {
		// The ledger's state machine refuses `parsing → uploading` and the worker
		// reads that refusal as a lost claim, aborting the attempt. A recovery that
		// uploads again must therefore report the phase it already announced, not
		// the one it is literally performing, or a survivable server restart
		// cancels the document.
		await start({ restartAfterFirstUpload: true });
		const { request, progress } = await buildRequest();

		await extractorFor().extract(request);

		const order = { uploading: 0, parsing: 1, downloading: 2 } as const;
		const seen = progress.map((entry) => order[entry.phase]);
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		// And the handle the ledger ends up holding names the SECOND task.
		const last = progress.filter((entry) => entry.handle).at(-1);
		expect(last?.handle?.remoteJobId).toBe([...server.tasks.keys()].at(-1));
	});

	it("is bounded: a server that forgets every time ends in a retryable failure, not a loop", async () => {
		await start({
			failures: [
				{
					path: "/v1/tasks/",
					method: "GET",
					fixture: "errors/100_get_unknown_task.json",
				},
			],
		});
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		// One create, one recovery, and then it stops.
		expect(creates()).toHaveLength(2);
		expect(error).toMatchObject({ code: "protocol", retryable: true });
		// The id is dead: the ledger must not resume it.
		expect(error.handleUnknown).toBe(true);
		expect(error.details).toMatchObject({ mineruCode: "task_not_found" });
	});

	it("is bounded at the download too", async () => {
		await start({
			failures: [
				{
					path: "/v1/files/",
					method: "GET",
					fixture: "errors/105_get_unknown_file_content.json",
				},
			],
		});
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(creates()).toHaveLength(2);
		expect(error).toMatchObject({ code: "protocol", retryable: true });
		expect(error.details).toMatchObject({ mineruCode: "file_not_found" });
	});

	it("measures and hashes the file again when the PUT is refused because it no longer matches", async () => {
		// A short or altered file: the PUT is a 400 and the file stays waiting for
		// bytes (D13). The same link refuses the same bytes, so the way out is a
		// new task from a fresh look at the file (A's interface, step 3).
		await start({
			failures: [
				{
					path: "/v1/tasks/",
					method: "PUT",
					nth: 1,
					fixture: "errors/107_upload_size_short_by_one.json",
				},
			],
		});
		const { request } = await buildRequest();
		const resolved = config(server.baseUrl);
		const client = new MineruClient({ config: resolved });
		const hash = vi.spyOn(client, "sha256");
		const stat = vi.spyOn(client, "statFile");

		const result = await createMineru4Extractor({
			resolveConfig: () => resolved,
			createClient: () => client,
			tempDirRoot: tempRoot,
		}).extract(request);

		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(2);
		expect(uploads()).toHaveLength(2);
		expect(stat).toHaveBeenCalledTimes(2);
		// Once at the start, once for the new task.
		expect(hash).toHaveBeenCalledTimes(2);
	});

	it("gives up on a file that never matches what it declared", async () => {
		await start({
			failures: [
				{
					path: "/v1/tasks/",
					method: "PUT",
					fixture: "errors/113_upload_hash_mismatch_right_size.json",
				},
			],
		});
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(creates()).toHaveLength(2);
		expect(error).toMatchObject({ code: "protocol", retryable: true });
		// A task stuck waiting for bytes it will never get is not worth resuming.
		expect(error.handleUnknown).toBe(true);
	});
});

describe("a later task for the same bytes", () => {
	it("skips the PUT: the hash cache already holds them", async () => {
		await start();
		const first = await buildRequest();
		await extractorFor().extract(first.request);
		expect(uploads()).toHaveLength(1);

		const second = await buildRequest();
		const progress: ExtractionProgress[] = [];
		const result = await extractorFor().extract({
			...second.request,
			hints: { tier: "basic" },
			onProgress: (entry) => progress.push(entry),
		});

		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(2);
		// The receipt was `pending` with no `upload`: nothing to send.
		expect(uploads()).toHaveLength(1);
		// …and it was a new task with the options of its own.
		expect(createBody(1).tier).toBe("basic");
		expect(progress.map((entry) => entry.phase)).toEqual([
			"uploading",
			"uploading",
			"parsing",
			"downloading",
		]);
	});

	it("says so in its log", async () => {
		await start();
		const first = await buildRequest();
		await extractorFor().extract(first.request);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

		await extractorFor().extract((await buildRequest()).request);

		const created = info.mock.calls.find((call) =>
			String(call[0]).includes("task created"),
		);
		expect(created?.[1]).toMatchObject({ cacheHit: true });
	});
});

describe("resuming a stored handle (a worker died; the ledger holds a task id)", () => {
	it("picks a task that is still pending or running back up, without a second create or upload", async () => {
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		const handle = await handleOfAnAttemptStoppedAt("parsing", request);
		server.resetLog();

		// The remote task can progress now: queued, working, done.
		server.setOptions({ neverFinish: false, inProgressPolls: 2 });
		const resumed = await buildRequest();
		const result = await extractorFor().extract({
			...resumed.request,
			resumeHandle: handle,
		});

		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(0);
		// The task already holds the bytes and the handle holds their digest: an
		// attempt that only polls never asks for the file (a photo is not decoded
		// again to be looked at by nobody).
		expect(resumed.openFile).not.toHaveBeenCalled();
		expect(polls().length).toBeGreaterThanOrEqual(3);
		expect(downloads()).toHaveLength(1);
		expect(
			polls().every((entry) =>
				entry.path.endsWith(handle.remoteJobId as string),
			),
		).toBe(true);
	});

	it("downloads a task that already completed, without a second parse", async () => {
		await start();
		const { request, progress } = await buildRequest();
		const extractor = extractorFor();
		await extractor.extract(request);
		const handle = progress.find((entry) => entry.handle)?.handle ?? null;
		expect(handle?.remoteJobId).toBeTruthy();
		server.resetLog();

		// Exactly what the ledger hands a second attempt after a restart.
		const resumed = await buildRequest();
		const result = await extractor.extract({
			...resumed.request,
			resumeHandle: handle,
		});

		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(0);
		expect(resumed.openFile).not.toHaveBeenCalled();
		expect(downloads()).toHaveLength(1);
	});

	const PUT_FAILS_ONCE = {
		path: "/v1/tasks/",
		method: "PUT",
		nth: 1,
		status: 503,
		body: { error: { code: "server_shutting_down", message: "stopping" } },
	} as const;

	/** An attempt whose PUT failed: the task exists, waiting for bytes, and the handle names it. */
	async function attemptWhoseBytesNeverLanded(): Promise<ExtractionHandle> {
		await start({ failures: [PUT_FAILS_ONCE] });
		const { request, progress } = await buildRequest();
		const first = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);
		expect(first).toMatchObject({ code: "unavailable", retryable: true });
		// The handle is stored before the PUT, so the failure keeps it.
		expect(first.handleUnknown).toBe(false);
		const handle = progress.filter((entry) => entry.handle).at(-1)
			?.handle as ExtractionHandle;
		expect(handle.remoteJobId).toBe([...server.tasks.keys()][0]);
		expect([...server.tasks.values()][0].status).toBe("waiting-file");
		server.setOptions({ failures: [] });
		server.resetLog();
		return handle;
	}

	it("PUTs again, with the link the task hands out, when the bytes never landed", async () => {
		const handle = await attemptWhoseBytesNeverLanded();

		const resumed = await buildRequest();
		const result = await extractorFor().extract({
			...resumed.request,
			resumeHandle: handle,
		});

		expect(result.text.length).toBeGreaterThan(0);
		// The bytes are needed after all, and this is the first the attempt knows it.
		expect(resumed.openFile).toHaveBeenCalledTimes(1);
		// The same task: no second create, one PUT, to its own file.
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(1);
		expect(uploads()[0].path).toBe(
			`/v1/tasks/${handle.remoteJobId}/uploads/${handle.remoteFileId}`,
		);
		expect(downloads()).toHaveLength(1);
	});

	it("creates the task again when a waiting task offers no link to PUT to", async () => {
		const handle = await attemptWhoseBytesNeverLanded();

		// A snapshot of a waiting file that lost its link.
		const stripLink: typeof fetch = async (input, init) => {
			const response = await fetch(input, init);
			if (
				(init?.method ?? "GET") !== "GET" ||
				!TASK_PATH.test(new URL(urlOf(input)).pathname)
			) {
				return response;
			}
			const body = (await response.json()) as {
				files: Array<Record<string, unknown>>;
			};
			for (const file of body.files) delete file.upload;
			return Response.json(body, { status: response.status });
		};
		const result = await extractorThrough(stripLink).extract({
			...(await buildRequest()).request,
			resumeHandle: handle,
		});

		expect(result.text.length).toBeGreaterThan(0);
		// A new task, whose receipt does hand out a link.
		expect(creates()).toHaveLength(1);
		expect(uploads()).toHaveLength(1);
		expect(uploads()[0].path).not.toContain(handle.remoteJobId as string);
	});

	it("creates the task again when the link it was given is refused for the bytes it was sent", async () => {
		const handle = await attemptWhoseBytesNeverLanded();
		server.setOptions({
			failures: [
				{
					path: "/v1/tasks/",
					method: "PUT",
					nth: 1,
					fixture: "errors/113_upload_hash_mismatch_right_size.json",
				},
			],
		});

		const result = await extractorFor().extract({
			...(await buildRequest()).request,
			resumeHandle: handle,
		});

		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(1);
		// The refused PUT, and the one that landed on the new task.
		expect(uploads()).toHaveLength(2);
	});

	it("starts over when the server forgot the task", async () => {
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		const handle = await handleOfAnAttemptStoppedAt("parsing", request);
		server.restart();
		server.setOptions({ neverFinish: false });
		server.resetLog();

		const resumed = await buildRequest();
		const result = await extractorFor().extract({
			...resumed.request,
			resumeHandle: handle,
		});

		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(1);
		expect(uploads()).toHaveLength(1);
		// A task of its own to declare and send: now the bytes are needed.
		expect(resumed.openFile).toHaveBeenCalledTimes(1);
	});

	// The handle's digest is the one the live task was declared with, so it is the
	// one the attempt goes on with: ahead of what the file brings, and without
	// opening the file to find out (D8). Both name the same bytes for a stored file,
	// which never changes; a photo's PNG has no ledger digest at all.
	it("goes on with the digest the live task was declared with, and does not open the file for it", async () => {
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		const handle = await handleOfAnAttemptStoppedAt("parsing", request);
		server.setOptions({ neverFinish: false });
		server.resetLog();

		const resumed = await buildRequest({ contentSha256: "b".repeat(64) });
		await extractorFor().extract({ ...resumed.request, resumeHandle: handle });

		const declared = handle.data?.sha256;
		expect(declared).toMatch(/^[a-f0-9]{64}$/);
		const kept = resumed.progress.filter((entry) => entry.handle).at(-1);
		expect(kept?.handle?.data?.sha256).toBe(declared);
		expect(kept?.handle?.data?.sha256).not.toBe("b".repeat(64));
		expect(resumed.openFile).not.toHaveBeenCalled();
	});

	it("opens the file for the digest when the handle has none to give", async () => {
		// A handle the 4.0 client wrote is not ours to resume, and its digest is not
		// ours to trust: the file brings the one the new task is declared with.
		await start();
		const { request, file } = await buildRequest();
		const sha = await new MineruClient({
			config: config(server.baseUrl),
		}).sha256(file.filePathAbsolute);
		const openFile = vi.fn(async () => ({ ...file, contentSha256: sha }));

		await extractorFor().extract({
			...request,
			openFile,
			resumeHandle: {
				extractor: MINERU4_EXTRACTOR_NAME,
				version: 1,
				remoteJobId: "job_00000000000000000000beef",
				remoteFileId: "file-00000000000000000000beef",
				data: { sha256: "f".repeat(64) },
			},
		});

		expect(openFile).toHaveBeenCalledTimes(1);
		expect(createBody().files[0].sha256sum).toBe(sha);
	});

	// A handle's digest is for continuing the live task it names, and for nothing
	// else. A task created fresh declares the digest of the bytes it is about to
	// send, which is what a deploy that changed those bytes needs: a photo's PNG is
	// not the one the previous release made, so the handle that release stored
	// names bytes this one never sends. If MinerU has forgotten the task as well
	// (a restart, an expiry), declaring the handle's digest would be refused at the
	// PUT, once the one recovery of the attempt was spent.
	describe("a task created again after the server forgot the one a handle names", () => {
		const PREVIOUS_RELEASES_DIGEST = createHash("sha256")
			.update("the PNG the previous release made of this photo")
			.digest("hex");

		/**
		 * A handle to a task the server no longer has, whose digest is that of other
		 * bytes than the ones the file holds now.
		 */
		async function handleToAForgottenTaskOfOtherBytes(): Promise<ExtractionHandle> {
			await start({ neverFinish: true });
			const { request } = await buildRequest();
			const handle = await handleOfAnAttemptStoppedAt("parsing", request);
			server.restart();
			server.setOptions({ neverFinish: false });
			server.resetLog();
			return {
				...handle,
				data: { ...handle.data, sha256: PREVIOUS_RELEASES_DIGEST },
			};
		}

		it("declares the digest of the file it sends, and succeeds in one go", async () => {
			const handle = await handleToAForgottenTaskOfOtherBytes();
			const resumed = await buildRequest();
			const actual = createHash("sha256")
				.update(await readFile(resumed.file.filePathAbsolute))
				.digest("hex");
			expect(actual).not.toBe(PREVIOUS_RELEASES_DIGEST);

			const result = await extractorFor().extract({
				...resumed.request,
				resumeHandle: handle,
			});

			expect(result.text.length).toBeGreaterThan(0);
			// The poll of the old task found nothing; the one task created after it
			// was declared right, so its PUT landed and nothing was created twice.
			expect(createBody().files[0].sha256sum).toBe(actual);
			expect(creates()).toHaveLength(1);
			expect(uploads()).toHaveLength(1);
			// One ask for the file, whichever steps needed it.
			expect(resumed.openFile).toHaveBeenCalledTimes(1);
			// The handle the ledger ends up holding names the new task and its digest.
			const kept = resumed.progress.filter((entry) => entry.handle).at(-1);
			expect(kept?.handle?.remoteJobId).not.toBe(handle.remoteJobId);
			expect(kept?.handle?.data?.sha256).toBe(actual);
		});

		it("takes the ledger's digest of a stored file when it holds one, and hashes nothing", async () => {
			const handle = await handleToAForgottenTaskOfOtherBytes();
			const resumed = await buildRequest();
			const resolved = config(server.baseUrl);
			const client = new MineruClient({ config: resolved });
			const ledgers = await client.sha256(resumed.file.filePathAbsolute);
			const hash = vi.spyOn(client, "sha256");

			const result = await createMineru4Extractor({
				resolveConfig: () => resolved,
				createClient: () => client,
				tempDirRoot: tempRoot,
			}).extract({
				...openingAs(resumed.request, resumed.file, {
					contentSha256: ledgers,
				}),
				resumeHandle: handle,
			});

			expect(result.text.length).toBeGreaterThan(0);
			expect(hash).not.toHaveBeenCalled();
			expect(createBody().files[0].sha256sum).toBe(ledgers);
			expect(creates()).toHaveLength(1);
			expect(uploads()).toHaveLength(1);
		});
	});

	it("reports a task that failed while nobody was watching, and spends it", async () => {
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		const handle = await handleOfAnAttemptStoppedAt("parsing", request);
		server.setOptions({
			neverFinish: false,
			outcome: "file-failed",
			fileError: {
				message: "Failed to load document (PDFium: Data format error).",
			},
		});

		await expect(
			extractorFor().extract({
				...(await buildRequest()).request,
				resumeHandle: handle,
			}),
		).rejects.toMatchObject({
			code: "document_unreadable",
			retryable: false,
			handleUnknown: true,
		});
	});

	it("reports a task somebody else cancelled as a failure of its own, not as our cancel", async () => {
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		const handle = await handleOfAnAttemptStoppedAt("parsing", request);
		const client = new MineruClient({ config: config(server.baseUrl) });
		await client.cancelTask({
			taskId: handle.remoteJobId as string,
			signal: AbortSignal.timeout(5_000),
		});

		const error = await extractorFor()
			.extract({ ...(await buildRequest()).request, resumeHandle: handle })
			.catch((thrown) => thrown);

		expect(error).toMatchObject({
			code: "job_failed",
			retryable: true,
			handleUnknown: true,
		});
		expect(error.details?.mineruRule).toBe("task:canceled-by-someone-else");
	});

	it("does not resume a handle the 4.0 client wrote", async () => {
		// Its job and upload ids belong to a protocol that no longer exists, and
		// 4.1 ids look the same (`job_…`, `file-…`): resuming one would poll a
		// stranger's task, or one that was never ours. It is not a handle.
		await start();
		const { request } = await buildRequest();

		const result = await extractorFor().extract({
			...request,
			resumeHandle: {
				extractor: MINERU4_EXTRACTOR_NAME,
				version: 1,
				remoteJobId: "job_00000000000000000000beef",
				remoteFileId: "file-00000000000000000000beef",
				data: {
					uploadId: "upload_old",
					sha256: "f".repeat(64),
					outputZipFileId: null,
					requestedTier: "basic",
				},
			},
		});

		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(1);
		expect(polls().some((entry) => entry.path.includes("beef"))).toBe(false);
		// The digest it carried is still a digest, but the ledger's is preferred.
		expect(createBody().files[0].sha256sum).not.toBe("f".repeat(64));
	});
});

describe("the cutover window: the URL still points at MinerU 4.0.12 (S6, R14)", () => {
	// 4.0.12 already serves POST /v1/tasks, in an older shape, and refuses a 4.1
	// manifest with a 400 in ITS error voice (`error.type`). The seconds between a
	// deploy and the URL flip must cost a retry, not a document.

	const OLD_SERVER = {
		path: "/v1/tasks",
		method: "POST",
		status: 400,
		body: MINERU_4_0_12_ERRORS.invalidManifest,
	} as const;

	it("is retried with the outage budget, reported, and succeeds once the server speaks 4.1", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await start({ failures: [OLD_SERVER] });
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		// `unavailable`: the ledger's patient outage walk, not three document
		// attempts (a 400 it would otherwise take for a bad request).
		expect(error).toMatchObject({ code: "unavailable", retryable: true });
		expect(error.handleUnknown).toBe(false);
		expect(error.details).toMatchObject({
			mineruRule: "wrong-protocol",
			wrongProtocol: "error.type invalid_request_error",
			httpStatus: 400,
		});
		// No pydantic dump, no name of the manifest field.
		expect(error.message).toBe("The document service could not be reached.");
		expect(JSON.stringify(error)).not.toMatch(/pydantic|extra_forbidden/);
		expect(creates()).toHaveLength(1);
		expect(uploads()).toHaveLength(0);
		// An operator sees it in the log.
		const reported = warn.mock.calls.find((call) =>
			String(call[0]).includes("another protocol"),
		);
		expect(reported?.[1]).toMatchObject({
			wrongProtocol: "error.type invalid_request_error",
		});

		// The URL is flipped.
		server.setOptions({ failures: [] });
		const result = await extractorFor().extract((await buildRequest()).request);
		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(2);
	});

	it("treats the plain FastAPI 404 of a route the old server lacks the same way", async () => {
		await start({
			failures: [
				{
					path: "/v1/tasks",
					method: "POST",
					status: 404,
					body: MINERU_4_0_12_ERRORS.routeMissing,
				},
			],
		});
		const { request } = await buildRequest();

		const error = await extractorFor()
			.extract(request)
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "unavailable", retryable: true });
		expect(error.details?.wrongProtocol).toBe("a FastAPI 404 {detail}");
	});

	it("keeps the handle of a task the old server cannot answer for, and resumes it after the flip", async () => {
		// A resume that polls a 4.1 task id against the old server: its 404
		// `task_not_found` carries a `type`, so it is the old server and not a
		// forgotten id. Creating the task again would be the wrong answer.
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		const handle = await handleOfAnAttemptStoppedAt("parsing", request);
		server.resetLog();
		server.setOptions({
			neverFinish: false,
			failures: [
				{
					path: "/v1/tasks/",
					method: "GET",
					status: 404,
					body: MINERU_4_0_12_ERRORS.taskNotFound,
				},
			],
		});

		const error = await extractorFor()
			.extract({ ...(await buildRequest()).request, resumeHandle: handle })
			.catch((thrown) => thrown);

		expect(error).toMatchObject({ code: "unavailable", retryable: true });
		expect(error.handleUnknown).toBe(false);
		// Not one create: it was not read as a forgotten id.
		expect(creates()).toHaveLength(0);

		server.setOptions({ failures: [] });
		const result = await extractorFor().extract({
			...(await buildRequest()).request,
			resumeHandle: handle,
		});
		expect(result.text.length).toBeGreaterThan(0);
		expect(creates()).toHaveLength(0);
		expect(uploads()).toHaveLength(0);
	});
});

describe("the API key", () => {
	it("travels to MinerU's own origin and is never logged", async () => {
		await start({ apiKey: "secret-token-value" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const { request } = await buildRequest();

		await extractorFor({ apiKey: "secret-token-value" }).extract(request);

		const authorized = server.requests.filter(
			(entry) => entry.headers.authorization === "Bearer secret-token-value",
		);
		expect(authorized.length).toBeGreaterThan(0);
		// Every request that carried it went to the configured origin, the upload
		// and the download included.
		for (const entry of authorized) {
			expect(entry.headers.host).toBe(`127.0.0.1:${server.port}`);
		}
		expect(authorized.some((entry) => entry.method === "PUT")).toBe(true);
		expect(
			authorized.some((entry) => entry.path.startsWith("/v1/files/")),
		).toBe(true);

		const logged = [...warn.mock.calls, ...info.mock.calls]
			.map((call) => JSON.stringify(call))
			.join("\n");
		expect(logged).not.toContain("secret-token-value");
	});
});
