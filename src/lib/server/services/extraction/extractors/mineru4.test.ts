// The MinerU 4 extractor, against the in-process V1 server.
//
// The ledger is not involved here — `mineru/integration.test.ts` runs the same
// extractor through the real worker. This file is about the extractor's own
// contract: what it asks the server before it moves a byte, what it emits and
// when, what it leaves on disk, and which failure each refusal becomes.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getMineruStatusReport,
	resetMineruCapabilitiesCacheForTests,
} from "$lib/server/services/mineru/capabilities";
import { MineruClient } from "$lib/server/services/mineru/client";
import type { MineruConfig } from "$lib/server/services/mineru/config";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	type FakeMineruServerOptions,
	MINERU_FIXTURE_ROOT,
} from "$lib/server/services/mineru/testing/fake-server";
import type {
	ExtractDocumentRequest,
	ExtractionHandle,
	ExtractionProgress,
} from "../contracts";
import {
	ExtractionAbortError,
	isDocumentExtractionError,
} from "../contracts";
import {
	createMineru4Extractor,
	installMineruProbeClientFactory,
	isMineru4StructuredPayload,
	MINERU4_EXTRACTOR_NAME,
	type Mineru4StructuredPayload,
	readHintedTier,
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

interface RequestOverrides extends Partial<ExtractDocumentRequest> {
	fixture?: string;
}

async function buildRequest(overrides: RequestOverrides = {}): Promise<{
	request: ExtractDocumentRequest;
	progress: ExtractionProgress[];
	controller: AbortController;
}> {
	const fixture = overrides.fixture ?? "pdf";
	const fileName = overrides.fileName ?? `sample.${fixture}`;
	const source = join(MINERU_FIXTURE_ROOT, fixture, fileName);
	const bytes = await readFile(source);
	const absolute = join(workDir, fileName);
	await writeFile(absolute, bytes);

	const progress: ExtractionProgress[] = [];
	const controller = new AbortController();
	const { fixture: _drop, ...rest } = overrides;

	return {
		progress,
		controller,
		request: {
			filePathAbsolute: absolute,
			fileName,
			mimeType: "application/pdf",
			sizeBytes: bytes.byteLength,
			intakeRoute: "mineru",
			signal: controller.signal,
			onProgress: (entry) => progress.push(entry),
			...rest,
		} as ExtractDocumentRequest,
	};
}

/**
 * Per-attempt download directories, counted inside a PRIVATE root.
 *
 * The extractor defaults to the OS temp directory, which every other test file
 * and every other process on the box also writes to — counting there is a race
 * that fails for reasons that have nothing to do with this code. `tempDirRoot`
 * exists so the count is about this test and nothing else.
 */
async function tempDirCount(): Promise<number> {
	const entries = await readdir(tempRoot);
	return entries.filter((entry) => entry.startsWith(TMP_PREFIX)).length;
}

async function start(options: FakeMineruServerOptions = {}): Promise<void> {
	server = await createFakeMineruServer(options);
	resetMineruCapabilitiesCacheForTests();
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
	await server?.close();
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
});

describe("the happy path", () => {
	it("uploads, parses, downloads only the zip and returns the prompt text", async () => {
		await start({ fixtureInput: "pdf" });
		const { request, progress } = await buildRequest();

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
		expect(paths).toContain("POST /v1/uploads");
		expect(paths).toContain("POST /v1/parse/jobs");
		// ONLY the zip is downloaded, although four formats were requested.
		expect(paths.filter((path) => path.includes("/content")).length).toBe(2);

		const create = server.requests.find(
			(entry) => entry.method === "POST" && entry.path === "/v1/parse/jobs",
		);
		const body = create?.json as Record<string, unknown>;
		expect(body.output_formats).toEqual([
			"markdown",
			"middle_json",
			"structured_content",
			"zip",
		]);
		// `tier: null` and `ocr_mode: null` are both 400s, so the keys are absent.
		expect("ocr_mode" in body).toBe(false);
		expect("page_range" in body).toBe(false);
		expect("callback" in body).toBe(false);

		expect(progress.map((entry) => entry.phase)).toEqual([
			"uploading",
			"parsing",
			"downloading",
		]);
		// The handle exists from the moment the remote job does — before the
		// first poll — so a worker that dies here resumes instead of resubmitting.
		expect(progress[0].handle ?? null).toBeNull();
		expect(progress[1].handle?.remoteJobId).toMatch(/^job_/);
		expect(progress[1].handle?.extractor).toBe(MINERU4_EXTRACTOR_NAME);
	});

	it("carries the structured payload and writes the parse bundle", async () => {
		await start({ fixtureInput: "pdf" });
		const { request } = await buildRequest({
			userId: "user-1",
			sourceArtifactId: "11111111-2222-3333-4444-555555555555",
		});

		const previous = process.cwd();
		const cwd = join(workDir, "cwd");
		await import("node:fs/promises").then(({ mkdir }) =>
			mkdir(cwd, { recursive: true }),
		);
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
		expect(structured.parserVersion).toBe("mineru4/1");
		expect(structured.producerVersion).toBe("4.0.4");
		expect(structured.serverParserVersion).toBe("4.0.4");
		expect(structured.effectiveTier).toBe("basic");
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
		const { request } = await buildRequest({ fixture: "docx" });

		const result = await extractorFor().extract(request);
		expect(result.text.length).toBeGreaterThan(0);
		expect((result.structured as Mineru4StructuredPayload).bundle).toBeNull();
	});
});

describe("the digest", () => {
	it("reuses the ledger's sha256 instead of re-reading the file", async () => {
		await start();
		const { request } = await buildRequest();
		const resolved = config(server.baseUrl);
		const client = new MineruClient({ config: resolved });
		const sha = await client.sha256(request.filePathAbsolute);
		const spy = vi.spyOn(client, "sha256");

		await createMineru4Extractor({
			resolveConfig: () => resolved,
			createClient: () => client,
			tempDirRoot: tempRoot,
		}).extract({ ...request, contentSha256: sha });

		expect(spy).not.toHaveBeenCalled();
		const create = server.requests.find(
			(entry) => entry.method === "POST" && entry.path === "/v1/uploads",
		);
		expect((create?.json as { sha256sum?: string }).sha256sum).toBe(sha);
	});

	it("computes it when the ledger has none, and ignores a malformed one", async () => {
		await start();
		const { request } = await buildRequest();

		await extractorFor().extract({ ...request, contentSha256: "not-a-digest" });

		const create = server.requests.find(
			(entry) => entry.method === "POST" && entry.path === "/v1/uploads",
		);
		expect((create?.json as { sha256sum?: string }).sha256sum).toMatch(
			/^[a-f0-9]{64}$/,
		);
	});
});

describe("tier resolution happens before any byte moves", () => {
	it("refuses an unavailable re-extract tier without uploading", async () => {
		await start({ tiers: ["flash", "basic"] });
		const { request } = await buildRequest({ hints: { tier: "standard" } });

		await expect(extractorFor().extract(request)).rejects.toMatchObject({
			code: "tier_unavailable",
			retryable: false,
		});

		expect(server.requests.some((entry) => entry.path === "/v1/uploads")).toBe(
			false,
		);
	});

	it("sends flash explicitly on a flash-only server", async () => {
		await start({ tiers: ["flash"], fixtureInput: "csv" });
		const { request } = await buildRequest({
			fixture: "csv",
			mimeType: "text/csv",
		});

		await extractorFor().extract(request);

		const create = server.requests.find(
			(entry) => entry.method === "POST" && entry.path === "/v1/parse/jobs",
		);
		expect((create?.json as { tier?: string }).tier).toBe("flash");
	});

	it("honours a re-extract hint the server does offer", async () => {
		await start({ tiers: ["flash", "basic"] });
		const { request } = await buildRequest({ hints: { tier: "basic" } });

		await extractorFor().extract(request);

		const create = server.requests.find(
			(entry) => entry.method === "POST" && entry.path === "/v1/parse/jobs",
		);
		expect((create?.json as { tier?: string }).tier).toBe("basic");
	});
});

describe("a backend that is not MinerU 4", () => {
	it("fails NON-retryably and says so, rather than retrying forever", async () => {
		// A MinerU 3.x server has no /v1 namespace at all, so the capability read
		// is a 404. `unavailable` would retry until max_attempts on a fault no
		// retry can fix; `protocol` non-retryable is the honest verdict.
		await start();
		const { request } = await buildRequest();

		// A reachable server that answers 404 for /v1/health: the fake's own
		// catch-all does exactly that for an unknown route, which is what a 3.x
		// server (no /v1 namespace at all) does for the same request.
		const resolved = config(`${server.baseUrl}/not-mineru4`);
		resetMineruCapabilitiesCacheForTests();
		const error = await createMineru4Extractor({
			resolveConfig: () => resolved,
			tempDirRoot: tempRoot,
		})
			.extract(request)
			.catch((thrown) => thrown);

		expect(isDocumentExtractionError(error)).toBe(true);
		expect(error).toMatchObject({ code: "protocol", retryable: false });
		expect(String((error as Error).message)).toContain("not a MinerU 4 server");
		expect(
			server.requests.some((entry) => entry.path.includes("/v1/uploads")),
		).toBe(false);
	});

	it("tells the admin status card the same thing, in words", async () => {
		// The card renders `report.error.message` under an "unreachable" pill.
		// Installing the real client as the capability probe is what makes that
		// message specific: the built-in probe would say "HTTP 404", and a bare
		// `new MineruClient()` would be read as an unrecognised Error and become
		// `unavailable` — an outage that retries forever.
		await start();
		resetMineruCapabilitiesCacheForTests();
		const report = await getMineruStatusReport({
			config: config(`${server.baseUrl}/not-mineru4`),
		});

		expect(report.reachable).toBe(false);
		expect(report.error?.code).toBe("protocol");
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
		resetMineruCapabilitiesCacheForTests();
		await expect(
			createMineru4Extractor({
				resolveConfig: () => config(deadUrl),
				tempDirRoot: tempRoot,
			}).extract(request),
		).rejects.toMatchObject({ code: "unavailable", retryable: true });
	});
});

describe("mapped failures", () => {
	it("maps a missing or wrong API key to auth_failed, non-retryable", async () => {
		await start({ apiKey: "the-real-key" });
		const { request } = await buildRequest();

		await expect(
			extractorFor({ apiKey: "" }).extract(request),
		).rejects.toMatchObject({ code: "auth_failed", retryable: false });
	});

	it("maps a rate limit and honours Retry-After", async () => {
		await start();
		const resolved = config(server.baseUrl);
		let seen = 0;
		const client = new MineruClient({
			config: resolved,
			fetchImpl: async (input, init) => {
				const url = String(
					typeof input === "string" ? input : (input as Request).url,
				);
				if (url.endsWith("/v1/uploads")) {
					seen += 1;
					return new Response(
						JSON.stringify({
							error: {
								type: "rate_limit_error",
								code: "rate_limit_exceeded",
								message: "Too many requests",
								param: null,
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
			},
		});
		const { request } = await buildRequest();

		await expect(
			createMineru4Extractor({
				resolveConfig: () => resolved,
				createClient: () => client,
				tempDirRoot: tempRoot,
			}).extract(request),
		).rejects.toMatchObject({
			code: "rate_limited",
			retryable: true,
			retryAfterMs: 42_000,
		});
		expect(seen).toBe(1);
	});

	it("maps a per-file failure inside a COMPLETED job", async () => {
		await start({ jobOutcome: "file-failed" });
		const { request } = await buildRequest();

		await expect(extractorFor().extract(request)).rejects.toMatchObject({
			code: "job_failed",
			retryable: true,
		});
	});

	it("maps a partial job to job_failed", async () => {
		await start({ jobOutcome: "partial" });
		const { request } = await buildRequest();

		await expect(extractorFor().extract(request)).rejects.toMatchObject({
			code: "job_failed",
			retryable: true,
		});
	});

	it("maps a completed job without a zip to protocol", async () => {
		await start({ jobOutcome: "completed-without-zip" });
		const { request } = await buildRequest();

		await expect(extractorFor().extract(request)).rejects.toMatchObject({
			code: "protocol",
			retryable: true,
		});
	});

	it("raises handleUnknown only for a file the engine could not find", async () => {
		// The one documented case: `createUpload` worked, the job was accepted
		// with a 202, and the engine then said the file is not there — a server
		// dropping ids under us, so the stored handle is poisonous.
		await start();
		const resolved = config(server.baseUrl);
		const client = new MineruClient({ config: resolved });
		vi.spyOn(client, "createJob").mockImplementation(async () => ({
			job_id: "job_ghost",
			status: "completed",
			created_at: new Date().toISOString(),
			tier: "basic",
			output_formats: ["zip"],
			access_level: "anonymous",
			files: [
				{
					file_id: "file-ghost",
					name: "sample.pdf",
					page_range: "",
					status: "failed",
					error: {
						type: "engine_error",
						code: "parse_failed",
						message: "File file-ghost not found",
						param: null,
					},
				},
			],
		}));
		vi.spyOn(client, "pollJob").mockImplementation(async () =>
			client.createJob({} as never),
		);
		const { request } = await buildRequest();

		await expect(
			createMineru4Extractor({
				resolveConfig: () => resolved,
				createClient: () => client,
				tempDirRoot: tempRoot,
			}).extract(request),
		).rejects.toMatchObject({ code: "protocol", handleUnknown: true });
	});
});

describe("hostile and oversized downloads", () => {
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

	it("aborts a download that runs past the size the job promised", async () => {
		await start();
		const before = await tempDirCount();
		// The cap is `max(bundleMaxBytes, expectedBytes)`: a job may always
		// deliver the bytes it declared, whatever the bundle budget says. So the
		// only way past it is a stream that runs past its own declared length,
		// and the download must stop mid-stream rather than write the whole thing
		// and complain afterwards.
		const resolved = config(server.baseUrl, { bundleMaxBytes: 1024 });
		const client = new MineruClient({
			config: resolved,
			fetchImpl: async (input, init) => {
				const url = String(
					typeof input === "string" ? input : (input as Request).url,
				);
				if (!url.includes("/v1/files/")) return fetch(input, init);
				const real = await fetch(input, init);
				const promised = Number(real.headers.get("content-length") ?? 0);
				await real.arrayBuffer();
				// Twice what `output_files.zip.bytes` declared: the cap is
				// max(bundleMaxBytes, expectedBytes), so this is the only way a
				// stream can blow through it.
				return new Response(Buffer.alloc(promised * 2 + 1024), {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				});
			},
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
			retryable: true,
			details: { mineruCode: "client_download_too_large" },
		});
		expect(await tempDirCount()).toBe(before);
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
				Buffer.from("PKnot a zip"),
			);
			return { bytes: input.expectedBytes };
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
	/** Runs an attempt up to the point a remote job exists, then aborts it. */
	async function abortMidJob(reason?: ExtractionAbortError): Promise<{
		rejection: Promise<unknown>;
		before: number;
	}> {
		const { request, controller } = await buildRequest();
		const before = await tempDirCount();
		const running = extractorFor().extract(request);
		await vi.waitFor(() => {
			expect(
				server.requests.some(
					(entry) => entry.method === "POST" && entry.path === "/v1/parse/jobs",
				),
			).toBe(true);
		});
		controller.abort(reason);
		return { rejection: running, before };
	}

	it("DELETEs the remote job and throws canceled on a USER cancel", async () => {
		await start({ neverFinish: true });
		const { rejection, before } = await abortMidJob(
			new ExtractionAbortError("user-cancel"),
		);

		await expect(rejection).rejects.toMatchObject({
			code: "canceled",
			retryable: false,
		});
		await vi.waitFor(() => {
			expect(server.requests.some((entry) => entry.method === "DELETE")).toBe(
				true,
			);
		});
		expect(await tempDirCount()).toBe(before);
	});

	it.each(["claim-lost", "shutdown"] as const)(
		"leaves the remote job alive on a %s abort",
		async (reason) => {
			// The stored handle exists precisely so the next attempt RESUMES this
			// remote job. Deleting it on a stale-claim reclaim or a deploy restart
			// turned a one-`getJob` resume into a full re-upload and re-parse, and
			// raced the worker that had just taken the claim.
			await start({ neverFinish: true });
			const { rejection, before } = await abortMidJob(
				new ExtractionAbortError(reason),
			);

			await expect(rejection).rejects.toMatchObject({ code: "canceled" });
			expect(server.requests.some((entry) => entry.method === "DELETE")).toBe(
				false,
			);
			// The job is still there for the next attempt to poll.
			const jobId = [...server.jobs.keys()].at(-1) as string;
			expect(server.jobs.get(jobId)?.status).not.toBe("canceled");
			expect(await tempDirCount()).toBe(before);
		},
	);

	it("leaves the remote job alive on an unlabelled abort", async () => {
		// Deleting a job that is still wanted costs the whole parse; keeping one
		// nobody reads costs a queue slot. An abort with no reason takes the
		// cheaper mistake.
		await start({ neverFinish: true });
		const { rejection } = await abortMidJob();

		await expect(rejection).rejects.toMatchObject({ code: "canceled" });
		expect(server.requests.some((entry) => entry.method === "DELETE")).toBe(
			false,
		);
	});

	it("cancels from a stored handle without re-reading the document", async () => {
		await start({ neverFinish: true });
		const { request } = await buildRequest();
		const extractor = extractorFor();

		let handle: ExtractionHandle | null = null;
		const captured = {
			...request,
			onProgress: (entry: ExtractionProgress) => {
				if (entry.handle) handle = entry.handle;
			},
		};
		const controller = new AbortController();
		const running = extractor.extract({
			...captured,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(handle).not.toBeNull());
		controller.abort();
		await running.catch(() => undefined);
		server.resetLog();

		await extractor.cancel?.(handle as unknown as ExtractionHandle);
		// A second cancel is a 409 the client swallows: cancelling twice is not
		// an error, it is the goal already met.
		await expect(
			extractor.cancel?.(handle as unknown as ExtractionHandle),
		).resolves.toBeUndefined();
	});
});

describe("restart recovery", () => {
	it("re-uploads by hash and finishes when the server forgets every id", async () => {
		await start({ parseDelayMs: 150, restartAfterMs: 40 });
		const { request } = await buildRequest();

		const result = await extractorFor().extract(request);
		expect(result.text.length).toBeGreaterThan(0);

		const uploads = server.requests.filter(
			(entry) => entry.method === "POST" && entry.path === "/v1/uploads",
		);
		const puts = server.requests.filter((entry) => entry.method === "PUT");
		const jobs = server.requests.filter(
			(entry) => entry.method === "POST" && entry.path === "/v1/parse/jobs",
		);

		// Two upload creates — the second is the sha256 dedupe probe — but only
		// ONE PUT: the bytes survived the restart, the identifiers did not (D7).
		expect(uploads.length).toBe(2);
		expect(puts.length).toBe(1);
		expect(jobs.length).toBe(2);
		expect(uploads[0].json).toMatchObject({
			sha256sum: (uploads[1].json as { sha256sum: string }).sha256sum,
		});
	});

	it("never reports a phase backwards while recovering", async () => {
		// The ledger's state machine refuses `parsing → uploading` and the worker
		// reads that refusal as a lost claim, aborting the attempt. A recovery
		// that re-uploads must therefore report the phase it already announced,
		// not the one it is literally performing — otherwise a survivable server
		// restart cancels the document.
		await start({ parseDelayMs: 150, restartAfterMs: 40 });
		const { request, progress } = await buildRequest();

		await extractorFor().extract(request);

		const order = { uploading: 0, parsing: 1, downloading: 2 } as const;
		const seen = progress.map((entry) => order[entry.phase]);
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		// And the handle the ledger ends up holding names the SECOND job.
		const last = progress.filter((entry) => entry.handle).at(-1);
		expect(last?.handle?.remoteJobId).toBe([...server.jobs.keys()].at(-1));
	});

	it("resumes a stored handle without a second upload", async () => {
		await start({ parseDelayMs: 60 });
		const { request, progress } = await buildRequest();
		const extractor = extractorFor();

		await extractor.extract(request);
		const handle = progress.find((entry) => entry.handle)?.handle ?? null;
		expect(handle?.remoteJobId).toBeTruthy();
		server.resetLog();

		// Exactly what the ledger hands a second attempt after a restart.
		const { request: second } = await buildRequest();
		const result = await extractor.extract({
			...second,
			resumeHandle: handle,
		});

		expect(result.text.length).toBeGreaterThan(0);
		expect(
			server.requests.filter((entry) => entry.path === "/v1/uploads"),
		).toHaveLength(0);
		expect(
			server.requests.filter(
				(entry) => entry.method === "POST" && entry.path === "/v1/parse/jobs",
			),
		).toHaveLength(0);
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
		// Every request that carried it went to the configured origin.
		for (const entry of authorized) {
			expect(entry.headers.host).toBe(`127.0.0.1:${server.port}`);
		}

		const logged = [...warn.mock.calls, ...info.mock.calls]
			.map((call) => JSON.stringify(call))
			.join("\n");
		expect(logged).not.toContain("secret-token-value");
	});
});
