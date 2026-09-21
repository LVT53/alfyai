/**
 * The client against reality, twice over.
 *
 *  1. **Replay** — the recorded fixtures are handed back through an injected
 *     `fetchImpl`, and the REQUESTS the client made are asserted field by
 *     field. This is where "no page_range, no callback, no `tier: null`, no
 *     `ocr_mode: null`" is proven.
 *  2. **The fake V1 server** — real HTTP on an ephemeral port, with the
 *     scripted behaviours the spike recorded: sha dedupe, a 200 for the wrong
 *     bytes, a hash mismatch that only appears at `complete`, a 202 for an
 *     unknown file id, a restart that forgets every identifier while the bytes
 *     survive, cancels, redirects and downloads.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getMineruStatusReport,
	type MineruProbeClientFactory,
	resetMineruCapabilitiesCacheForTests,
	setMineruProbeClientFactory,
} from "./capabilities";
import { MineruClient } from "./client";
import type { MineruConfig } from "./config";
import { MineruApiError, mapMineruError, mapMineruJobFailure } from "./errors";
import type { MineruUpload } from "./schemas";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	type FakeMineruServerOptions,
	MINERU_FIXTURE_ROOT,
	readMineruFixtureJson,
} from "./testing/fake-server";

const RECORDED_ORIGIN = "http://127.0.0.1:8765";

function testConfig(patch: Partial<MineruConfig> = {}): MineruConfig {
	return {
		baseUrl: RECORDED_ORIGIN,
		apiKey: "",
		defaultTier: "auto",
		ocrMode: "auto",
		jobTimeoutMs: 5000,
		pollMinMs: 1,
		pollMaxMs: 5,
		requestTimeoutMs: 2000,
		transferTimeoutMs: 4000,
		capabilitiesTtlMs: 0,
		bundleMaxBytes: 33554432,
		structureChunking: true,
		...patch,
	};
}

interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

function scriptedFetch(
	handler: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		let body: unknown;
		if (typeof init?.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		} else if (init?.body) {
			body = "<stream>";
		}
		const call: RecordedCall = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: Object.fromEntries(headers.entries()),
			body,
		};
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const never = new AbortController().signal;

let tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mineru-contract-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	tempDirs = [];
});

// ---------------------------------------------------------------------------
// 1. Replaying the recorded sequences
// ---------------------------------------------------------------------------

describe("recorded sequence — the PDF dedupe path", () => {
	it("skips the PUT and the complete when the sha is already known", async () => {
		const upload = readMineruFixtureJson<MineruUpload>(
			"pdf/upload.create.json",
		);
		const { fetchImpl, calls } = scriptedFetch((call) => {
			if (call.url.endsWith("/v1/uploads")) return jsonResponse(upload);
			throw new Error(`unexpected call: ${call.method} ${call.url}`);
		});

		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const created = await client.createUpload({
			filename: "sample.pdf",
			bytes: 6727,
			mimeType: "application/pdf",
			sha256sum:
				"5637ad7a417669669f181aec769fa3ac3a392285f1b9c222830337360a2f42bd",
			signal: never,
		});

		expect(created.status).toBe("completed");
		expect(created.file?.id).toBe("file-10c3b409b0ab0e3b7da5fc00");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({
			filename: "sample.pdf",
			bytes: 6727,
			mime_type: "application/pdf",
			purpose: "parse",
			sha256sum:
				"5637ad7a417669669f181aec769fa3ac3a392285f1b9c222830337360a2f42bd",
		});
	});

	it("creates the job with the exact recorded body, then polls and downloads", async () => {
		const created = readMineruFixtureJson("pdf/job.create.json");
		const final = readMineruFixtureJson("pdf/job.final.json");
		const zip = readFileSync(join(MINERU_FIXTURE_ROOT, "pdf", "result.zip"));

		const { fetchImpl, calls } = scriptedFetch((call) => {
			if (call.url.endsWith("/v1/parse/jobs"))
				return jsonResponse(created, 202);
			if (call.url.includes("/v1/parse/jobs/")) return jsonResponse(final);
			if (call.url.includes("/content")) {
				return new Response(zip, {
					headers: {
						"content-type": "application/octet-stream",
						"content-length": String(zip.byteLength),
					},
				});
			}
			throw new Error(`unexpected call: ${call.url}`);
		});

		const client = new MineruClient({ config: testConfig(), fetchImpl });
		const job = await client.createJob({
			fileId: "file-10c3b409b0ab0e3b7da5fc00",
			tier: "basic",
			outputFormats: ["markdown", "middle_json", "structured_content", "zip"],
			signal: never,
		});
		expect(job.status).toBe("queued");
		expect(calls[0]?.body).toEqual({
			files: [
				{
					source: {
						type: "file_id",
						file_id: "file-10c3b409b0ab0e3b7da5fc00",
					},
				},
			],
			output_formats: ["markdown", "middle_json", "structured_content", "zip"],
			tier: "basic",
		});

		const terminal = await client.pollJob({ jobId: job.job_id, signal: never });
		expect(terminal.status).toBe("completed");
		expect(mapMineruJobFailure(terminal)).toBeNull();

		const zipRef = terminal.files[0]?.output_files?.zip;
		expect(zipRef).toBeTruthy();
		const destination = join(tempDir(), "result.zip");
		const { bytes } = await client.downloadFile({
			fileId: zipRef?.file_id as string,
			destinationPathAbsolute: destination,
			expectedBytes: zipRef?.bytes as number,
			signal: never,
		});
		expect(bytes).toBe(71547);
		expect((await stat(destination)).size).toBe(71547);
		expect(await readFile(destination)).toEqual(zip);
	});
});

describe("recorded sequence — the fresh DOCX path", () => {
	it("PUTs to the recorded upload_url and completes with the sha", async () => {
		const pending = readMineruFixtureJson<MineruUpload>(
			"docx/upload.create.json",
		);
		const completed = readMineruFixtureJson<MineruUpload>(
			"docx/upload.complete.json",
		);
		const sample = join(MINERU_FIXTURE_ROOT, "docx", "sample.docx");

		const { fetchImpl, calls } = scriptedFetch((call) => {
			if (call.method === "PUT") {
				// 200, EMPTY body, no content-type — and a 200 even for wrong bytes.
				return new Response(null, { status: 200 });
			}
			if (call.url.endsWith("/complete")) return jsonResponse(completed);
			return jsonResponse(pending);
		});

		const client = new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		});

		await client.putUploadContent({
			upload: pending,
			filePathAbsolute: sample,
			signal: never,
		});
		const put = calls[0];
		expect(put?.method).toBe("PUT");
		expect(put?.url).toBe(pending.upload_url);
		expect(put?.headers["content-length"]).toBe(
			String((await stat(sample)).size),
		);
		expect(put?.headers["content-type"]).toContain("wordprocessingml");
		// Same origin as MINERU_API_URL, so the key travels.
		expect(put?.headers.authorization).toBe("Bearer testkey");

		const done = await client.completeUpload({
			uploadId: pending.id,
			sha256sum: pending.sha256sum as string,
			signal: never,
		});
		expect(done.file?.id).toBe("file-b8425a8a38ec4d53b1985365");
		expect(calls[1]?.body).toEqual({ sha256sum: pending.sha256sum });
	});

	it("refuses an upload_url on a foreign origin, before sending a byte", async () => {
		const pending = readMineruFixtureJson<MineruUpload>(
			"docx/upload.create.json",
		);
		const { fetchImpl, calls } = scriptedFetch(() => {
			throw new Error("the client must not have sent anything");
		});
		const client = new MineruClient({
			config: testConfig({ apiKey: "testkey" }),
			fetchImpl,
		});

		const error = await client
			.putUploadContent({
				upload: { ...pending, upload_url: "http://attacker.example/v1/steal" },
				filePathAbsolute: join(MINERU_FIXTURE_ROOT, "docx", "sample.docx"),
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);

		expect(calls).toHaveLength(0);
		expect(error).toBeInstanceOf(MineruApiError);
		expect((error as MineruApiError).message).not.toContain("testkey");
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("protocol");
		// Retrying a hostile or misconfigured server only repeats it.
		expect(mapping.retryable).toBe(false);
	});

	it("resolves a RELATIVE upload_url against MINERU_API_URL", async () => {
		const pending = readMineruFixtureJson<MineruUpload>(
			"docx/upload.create.json",
		);
		const { fetchImpl, calls } = scriptedFetch(
			() => new Response(null, { status: 200 }),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		await client.putUploadContent({
			upload: { ...pending, upload_url: "/v1/uploads/upload_x/content" },
			filePathAbsolute: join(MINERU_FIXTURE_ROOT, "csv", "sample.csv"),
			signal: never,
		});
		expect(calls[0]?.url).toBe(
			`${RECORDED_ORIGIN}/v1/uploads/upload_x/content`,
		);
	});
});

describe("the request bodies this client can emit", () => {
	it("never sends page_range, callback, tier:null or ocr_mode:null", async () => {
		const { fetchImpl, calls } = scriptedFetch((call) => {
			if (call.url.endsWith("/v1/parse/jobs")) {
				return jsonResponse(readMineruFixtureJson("pdf/job.create.json"), 202);
			}
			return jsonResponse(readMineruFixtureJson("pdf/upload.create.json"));
		});
		const client = new MineruClient({ config: testConfig(), fetchImpl });

		// Every shape createJob can produce: with and without each optional key.
		for (const tier of [undefined, "flash", "basic"] as const) {
			for (const ocrMode of [undefined, "txt", "ocr"] as const) {
				await client.createJob({
					fileId: "file-1",
					tier,
					ocrMode,
					outputFormats: ["markdown", "zip"],
					signal: never,
				});
			}
		}

		for (const call of calls) {
			const body = call.body as Record<string, unknown>;
			expect(Object.keys(body)).not.toContain("page_range");
			expect(Object.keys(body)).not.toContain("callback");
			if ("tier" in body) expect(body.tier).not.toBeNull();
			if ("ocr_mode" in body) expect(body.ocr_mode).not.toBeNull();
			expect(JSON.stringify(body)).not.toContain("page_range");
		}
		// Three tiers × three ocr modes, and the key is absent when undefined.
		expect(
			calls.filter((call) => "tier" in (call.body as object)),
		).toHaveLength(6);
		expect(
			calls.filter((call) => "ocr_mode" in (call.body as object)),
		).toHaveLength(6);
	});

	it("has no page_range or callback anywhere in the protocol source", () => {
		for (const file of ["client.ts", "tier-policy.ts"]) {
			const source = readFileSync(join(__dirname, file), "utf8");
			// Comments explain why they are never sent; code must not name them.
			const code = source
				.split("\n")
				.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
				.join("\n");
			expect(code).not.toContain("page_range");
			expect(code).not.toContain("callback");
		}
	});

	it("sends the display name only, never a local path", async () => {
		const { fetchImpl, calls } = scriptedFetch(() =>
			jsonResponse(readMineruFixtureJson("pdf/upload.create.json")),
		);
		const client = new MineruClient({ config: testConfig(), fetchImpl });
		await client.createUpload({
			filename: "/Users/someone/data/knowledge/u-1/9f2c.pdf",
			bytes: 10,
			mimeType: "application/pdf",
			sha256sum: "a".repeat(64),
			signal: never,
		});
		expect((calls[0]?.body as { filename: string }).filename).toBe("9f2c.pdf");
	});
});

// ---------------------------------------------------------------------------
// 2. The fake V1 server
// ---------------------------------------------------------------------------

describe("against the fake V1 server", () => {
	let server: FakeMineruServer | null = null;

	afterEach(async () => {
		await server?.close();
		server = null;
	});

	async function start(
		options: FakeMineruServerOptions = {},
	): Promise<{ server: FakeMineruServer; client: MineruClient }> {
		server = await createFakeMineruServer({ fixtureInput: "csv", ...options });
		return {
			server,
			client: new MineruClient({
				config: testConfig({ baseUrl: server.baseUrl }),
			}),
		};
	}

	function sampleFile(): { path: string; bytes: number; sha256: string } {
		const dir = tempDir();
		const path = join(dir, "sample.csv");
		const bytes = readFileSync(join(MINERU_FIXTURE_ROOT, "csv", "sample.csv"));
		writeFileSync(path, bytes);
		return {
			path,
			bytes: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	}

	async function uploadFresh(client: MineruClient, file = sampleFile()) {
		const created = await client.createUpload({
			filename: "sample.csv",
			bytes: file.bytes,
			mimeType: "text/csv",
			sha256sum: file.sha256,
			signal: never,
		});
		if (created.status === "completed") return { upload: created, file };
		await client.putUploadContent({
			upload: created,
			filePathAbsolute: file.path,
			signal: never,
		});
		const completed = await client.completeUpload({
			uploadId: created.id,
			sha256sum: file.sha256,
			signal: never,
		});
		return { upload: completed, file };
	}

	it("runs the whole upload → job → download sequence over real HTTP", async () => {
		const { server: fake, client } = await start({ parseDelayMs: 20 });
		const { upload } = await uploadFresh(client);
		expect(upload.status).toBe("completed");

		const job = await client.createJob({
			fileId: upload.file?.id as string,
			tier: "basic",
			outputFormats: ["markdown", "middle_json", "structured_content", "zip"],
			signal: never,
		});
		const polls: string[] = [];
		const terminal = await client.pollJob({
			jobId: job.job_id,
			signal: never,
			onPoll: (state) => polls.push(state.status),
		});

		expect(terminal.status).toBe("completed");
		expect(polls.length).toBeGreaterThan(1);
		expect(polls.at(-1)).toBe("completed");
		expect(mapMineruJobFailure(terminal)).toBeNull();
		expect([...fake.jobs.values()][0]?.status).toBe("completed");

		const zipRef = terminal.files[0]?.output_files?.zip;
		const destination = join(tempDir(), "result.zip");
		const { bytes } = await client.downloadFile({
			fileId: zipRef?.file_id as string,
			destinationPathAbsolute: destination,
			expectedBytes: zipRef?.bytes as number,
			signal: never,
		});
		expect(bytes).toBe(
			readFileSync(join(MINERU_FIXTURE_ROOT, "csv", "result.zip")).byteLength,
		);

		// The terminal job lists all seven output keys, with nulls.
		expect(Object.keys(terminal.files[0]?.output_files ?? {})).toEqual([
			"markdown",
			"middle_json",
			"structured_content",
			"html",
			"latex",
			"docx",
			"zip",
		]);
	});

	it("dedupes by sha and mints a NEW file id, with no bytes sent", async () => {
		const { server: fake, client } = await start();
		const { file, upload } = await uploadFresh(client);
		fake.resetLog();

		const again = await client.createUpload({
			filename: "sample.csv",
			bytes: file.bytes,
			mimeType: "text/csv",
			sha256sum: file.sha256,
			signal: never,
		});
		expect(again.status).toBe("completed");
		expect(again.upload_url).toBeNull();
		expect(again.file?.id).not.toBe(upload.file?.id);
		expect(fake.requests.filter((request) => request.method === "PUT")).toEqual(
			[],
		);
	});

	it("answers 200 for the wrong bytes and fails only at complete", async () => {
		const { client } = await start();
		const file = sampleFile();
		const created = await client.createUpload({
			filename: "sample.csv",
			bytes: file.bytes,
			mimeType: "text/csv",
			sha256sum: "b".repeat(64),
			signal: never,
		});
		// The PUT of the real bytes succeeds even though the claimed sha is wrong.
		await expect(
			client.putUploadContent({
				upload: created,
				filePathAbsolute: file.path,
				signal: never,
			}),
		).resolves.toBeUndefined();

		const error = await client
			.completeUpload({
				uploadId: created.id,
				sha256sum: "b".repeat(64),
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("file_hash_mismatch");
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("protocol");
		// Worth exactly one more PUT.
		expect(mapping.retryable).toBe(true);
	});

	it("recovers from a MinerU restart: ids are gone, bytes are not", async () => {
		const { server: fake, client } = await start();
		const { upload, file } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});

		fake.restart();

		// R1: the stored job id is gone.
		const jobError = await client
			.getJob({ jobId: job.job_id, signal: never })
			.catch((caught) => caught as MineruApiError);
		expect((jobError as MineruApiError).code).toBe("job_not_found");
		expect(mapMineruError(jobError).disposition).toBe("recover-by-reupload");

		// R4: so is the output file id.
		const fileError = await client
			.downloadFile({
				fileId: upload.file?.id as string,
				destinationPathAbsolute: join(tempDir(), "gone.zip"),
				expectedBytes: 1,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((fileError as MineruApiError).code).toBe("file_not_found");

		// R2: the same sha still dedupes, against a brand new file id.
		const recovered = await client.createUpload({
			filename: "sample.csv",
			bytes: file.bytes,
			mimeType: "text/csv",
			sha256sum: file.sha256,
			signal: never,
		});
		expect(recovered.status).toBe("completed");
		expect(recovered.file?.id).not.toBe(upload.file?.id);
		expect(fake.blobs.get(file.sha256)).toBe(file.bytes);
	});

	it("accepts an unknown file_id with a 202 and fails inside the job", async () => {
		const { client } = await start();
		const job = await client.createJob({
			fileId: "file-nope000000000000",
			outputFormats: ["markdown", "zip"],
			signal: never,
		});
		expect(job.status).toBe("queued");

		const terminal = await client.pollJob({ jobId: job.job_id, signal: never });
		expect(terminal.status).toBe("failed");
		const mapping = mapMineruJobFailure(terminal);
		expect(mapping?.taxonomy).toBe("protocol");
		// The stored handle is poisonous; the ledger must clear it.
		expect(mapping?.handleUnknown).toBe(true);
	});

	it("replays a recorded error fixture on a scripted failure", async () => {
		const { client } = await start({
			failures: [
				{ path: "/v1/parse/jobs", method: "POST", fixture: "tier_standard" },
			],
		});
		const error = await client
			.createJob({
				fileId: "file-1",
				tier: "standard",
				outputFormats: ["markdown"],
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect(mapMineruError(error).taxonomy).toBe("tier_unavailable");
	});

	it("reports a per-file failure inside a completed-looking job", async () => {
		const { client } = await start({ jobOutcome: "file-failed" });
		const { upload } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});
		const terminal = await client.pollJob({ jobId: job.job_id, signal: never });
		expect(mapMineruJobFailure(terminal)?.taxonomy).toBe("job_failed");
	});

	it("treats a partial job as a failure — it is unverified upstream", async () => {
		const { client } = await start({ jobOutcome: "partial" });
		const { upload } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});
		const terminal = await client.pollJob({ jobId: job.job_id, signal: never });
		expect(terminal.status).toBe("partial");
		expect(mapMineruJobFailure(terminal)?.taxonomy).toBe("job_failed");
	});

	it("fails a completed job whose zip is missing", async () => {
		const { client } = await start({ jobOutcome: "completed-without-zip" });
		const { upload } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});
		const terminal = await client.pollJob({ jobId: job.job_id, signal: never });
		expect(terminal.status).toBe("completed");
		const mapping = mapMineruJobFailure(terminal);
		expect(mapping?.taxonomy).toBe("protocol");
		expect(mapping?.rule).toBe("job:missing-output");
	});

	it("swallows a cancel that is merely late", async () => {
		const { client } = await start({ neverFinish: true });
		const { upload } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});

		await expect(
			client.cancelJob({ jobId: job.job_id, signal: never }),
		).resolves.toBeUndefined();
		// 409 job_already_terminal…
		await expect(
			client.cancelJob({ jobId: job.job_id, signal: never }),
		).resolves.toBeUndefined();
		// …and 404 job_not_found.
		await expect(
			client.cancelJob({ jobId: "job_nope0000000000", signal: never }),
		).resolves.toBeUndefined();
	});

	it("stops polling at the whole-job deadline", async () => {
		const { client } = await start({ neverFinish: true });
		const { upload } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});
		const error = await client
			.pollJob({ jobId: job.job_id, signal: never, deadlineMs: 30 })
			.catch((caught) => caught as MineruApiError);
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("timeout");
		expect(mapping.retryable).toBe(true);
	});

	it("aborts in flight when the caller's signal fires", async () => {
		const { client } = await start({ neverFinish: true });
		const { upload } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown"],
			signal: never,
		});
		const controller = new AbortController();
		const polling = client.pollJob({
			jobId: job.job_id,
			signal: controller.signal,
		});
		controller.abort();
		const error = await polling.catch((caught) => caught);
		expect(mapMineruError(error).taxonomy).toBe("canceled");
		expect(mapMineruError(error).retryable).toBe(false);
	});

	it("follows a download redirect, and drops the key when it leaves our origin", async () => {
		const { server: fake } = await start({ redirectDownloads: "cross-origin" });
		const keyedClient = new MineruClient({
			config: testConfig({ baseUrl: fake.baseUrl, apiKey: "testkey" }),
		});
		const { upload } = await uploadFresh(keyedClient);
		const job = await keyedClient.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});
		const terminal = await keyedClient.pollJob({
			jobId: job.job_id,
			signal: never,
		});
		const zipRef = terminal.files[0]?.output_files?.zip;

		fake.resetLog();
		const destination = join(tempDir(), "redirected.zip");
		const { bytes } = await keyedClient.downloadFile({
			fileId: zipRef?.file_id as string,
			destinationPathAbsolute: destination,
			expectedBytes: zipRef?.bytes as number,
			signal: never,
		});
		expect(bytes).toBe(zipRef?.bytes);

		const downloads = fake.requests.filter((request) =>
			request.path.endsWith("/content"),
		);
		expect(downloads).toHaveLength(2);
		// The first hop is ours and carries the key…
		expect(downloads[0]?.headers.authorization).toBe("Bearer testkey");
		// …the redirected hop is a different origin and must not.
		expect(downloads[1]?.headers.host).toContain("localhost");
		expect(downloads[1]?.headers.authorization).toBeUndefined();
	});

	it("rejects a download whose byte count does not match the job", async () => {
		const { client } = await start();
		const { upload } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});
		const terminal = await client.pollJob({ jobId: job.job_id, signal: never });
		const zipRef = terminal.files[0]?.output_files?.zip;
		const destination = join(tempDir(), "short.zip");

		const error = await client
			.downloadFile({
				fileId: zipRef?.file_id as string,
				destinationPathAbsolute: destination,
				expectedBytes: (zipRef?.bytes as number) + 10,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect(mapMineruError(error).taxonomy).toBe("protocol");
		expect(mapMineruError(error).retryable).toBe(true);
		// The partial file is not left behind for a later reader to trust.
		await expect(stat(destination)).rejects.toThrow();
	});

	it("caps a download that exceeds the size it declared", async () => {
		const { client } = await start();
		const { upload } = await uploadFresh(client);
		const job = await client.createJob({
			fileId: upload.file?.id as string,
			outputFormats: ["markdown", "zip"],
			signal: never,
		});
		const terminal = await client.pollJob({ jobId: job.job_id, signal: never });
		const zipRef = terminal.files[0]?.output_files?.zip;

		const error = await client
			.downloadFile({
				fileId: zipRef?.file_id as string,
				destinationPathAbsolute: join(tempDir(), "capped.zip"),
				expectedBytes: 10,
				maxBytes: 10,
				signal: never,
			})
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_download_too_large");
	});

	it("sends the key on a keyed server and fails cleanly without one", async () => {
		const { server: fake } = await start({ apiKey: "testkey" });
		const anonymous = new MineruClient({
			config: testConfig({ baseUrl: fake.baseUrl }),
		});
		const keyed = new MineruClient({
			config: testConfig({ baseUrl: fake.baseUrl, apiKey: "testkey" }),
		});

		// /v1/health stays public even under --api-key.
		await expect(anonymous.getHealth(never)).resolves.toMatchObject({
			version: "4.0.4",
		});

		const error = await anonymous
			.getUsage(never)
			.catch((caught) => caught as MineruApiError);
		expect(mapMineruError(error).taxonomy).toBe("auth_failed");
		expect(mapMineruError(error).retryable).toBe(false);
		expect((error as MineruApiError).message).not.toContain("testkey");

		await expect(keyed.getUsage(never)).resolves.toMatchObject({
			access_level: "registered",
		});
	});

	it("reads the tier list and drops a tier id it does not know", async () => {
		const { server: fake, client } = await start({ tiers: ["flash"] });
		const tiers = await client.getTiers(never);
		expect(tiers.map((tier) => tier.id)).toEqual(["flash"]);
		expect(fake.requests.at(-1)?.path).toBe("/v1/tiers");
	});

	it("rejects a 200 that is not the shape we recorded", async () => {
		const { client } = await start({
			failures: [{ path: "/v1/health", fixture: "auth_valid_key_files" }],
		});
		const error = await client
			.getHealth(never)
			.catch((caught) => caught as MineruApiError);
		expect((error as MineruApiError).code).toBe("client_schema_mismatch");
		const mapping = mapMineruError(error);
		expect(mapping.taxonomy).toBe("protocol");
		expect(mapping.retryable).toBe(true);
	});

	/**
	 * The seam S0 left for this slice: `MineruClient` satisfies
	 * `MineruProbeClient` structurally, so P2-B can route the admin card's
	 * capability read through the real client with one line at module init.
	 * If a signature here ever drifts, this case stops compiling.
	 */
	it("satisfies MineruProbeClient, so the capability read can use it", async () => {
		const { server: fake } = await start();
		const factory: MineruProbeClientFactory = (config) =>
			new MineruClient({ config });
		setMineruProbeClientFactory(factory);
		resetMineruCapabilitiesCacheForTests();
		try {
			const report = await getMineruStatusReport({
				config: testConfig({ baseUrl: fake.baseUrl }),
			});
			expect(report.reachable).toBe(true);
			expect(report.version).toBe("4.0.4");
			expect(report.tiers.map((tier) => tier.id)).toEqual(["flash", "basic"]);
			expect(report.outputFormats).toContain("structured_content");
			expect(report.accessLevel).toBe("anonymous");
			// The origin only — never a key, never a path.
			expect(report.baseUrl).toBe(fake.baseUrl);
		} finally {
			setMineruProbeClientFactory(null);
			resetMineruCapabilitiesCacheForTests();
		}
	});
});
