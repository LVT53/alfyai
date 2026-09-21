// What a MALICIOUS or broken MinerU server can do to this process.
//
// Everything `result.ts` and `client.ts` read is attacker-influenced the
// moment MINERU_API_URL points at something hostile, at a compromised box, or
// at a plain-http origin with a man in the middle. The zip reader already
// refuses traversals, symlinks and duplicate names; these are the two numbers
// it was still trusting — a declared page count and a declared output size —
// both of which are single JSON fields that can be made arbitrarily large.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MineruClient } from "./client";
import { MINERU_MAX_DOWNLOAD_BYTES, type MineruConfig } from "./config";
import {
	buildStructuredExtractionResult,
	DEFAULT_MINERU_ZIP_LIMITS,
	MAX_STRUCTURED_PAGE_COUNT,
	parseStructuredContent,
} from "./result";

function structuredContentWithPageCount(pageCount: number) {
	return parseStructuredContent(
		JSON.stringify({
			pages: [
				{
					page_idx: 0,
					blocks: [{ type: "text", content: "Only one real page of text." }],
				},
			],
			metadata: {
				producer: { name: "mineru", version: "4.0.4" },
				document: { page_count: pageCount, page_count_kind: "physical" },
			},
			extensions: { mineru: { tier: "basic", parse_mode: "txt" } },
			is_full_document: true,
		}),
	);
}

describe("a lying metadata.document.page_count", () => {
	it("does not materialise one page-offset row per declared page", () => {
		// 50 million is one JSON integer. Before the cap this allocated fifty
		// million objects inside `buildStructuredExtractionResult`, which on the
		// single production Node process is an out-of-memory kill, not a slow
		// extraction. One document is enough to take the whole server down.
		const started = Date.now();
		const result = buildStructuredExtractionResult({
			content: structuredContentWithPageCount(50_000_000),
			sourceFilename: "sample.pdf",
		});

		expect(result.pages.length).toBeLessThanOrEqual(MAX_STRUCTURED_PAGE_COUNT);
		expect(result.pageCount).toBeLessThanOrEqual(MAX_STRUCTURED_PAGE_COUNT);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("still honours a plausible declared count", () => {
		const result = buildStructuredExtractionResult({
			content: structuredContentWithPageCount(3),
			sourceFilename: "sample.pdf",
		});
		expect(result.pageCount).toBe(3);
		expect(result.pages.map((page) => page.page)).toEqual([1, 2, 3]);
	});
});

function testConfig(overrides: Partial<MineruConfig> = {}): MineruConfig {
	return {
		baseUrl: "http://mineru.test",
		apiKey: "",
		defaultTier: "auto",
		ocrMode: "auto",
		jobTimeoutMs: 300_000,
		pollMinMs: 1,
		pollMaxMs: 2,
		requestTimeoutMs: 1_000,
		transferTimeoutMs: 1_000,
		capabilitiesTtlMs: 1_000,
		bundleMaxBytes: 1_024,
		bundleUserQuotaBytes: 0,
		structureChunking: true,
		...overrides,
	} as MineruConfig;
}

describe("a lying output_files.zip.bytes", () => {
	it("refuses a declared size past the ceiling before a byte moves", async () => {
		// `expectedBytes` is the server's own claim about its own output, and the
		// cap was `max(expectedBytes, bundleMaxBytes)` — so the server chose the
		// cap. Declare ten gigabytes, stream ten gigabytes, fill the disk;
		// MINERU_BUNDLE_MAX_BYTES bounded only what was KEPT.
		const fetchImpl = vi.fn(
			async () => new Response(new Uint8Array(0), { status: 200 }),
		) as unknown as typeof fetch;
		const client = new MineruClient({
			config: testConfig({ bundleMaxBytes: 1_024 }),
			fetchImpl,
		});

		await expect(
			client.downloadFile({
				fileId: "file_x",
				destinationPathAbsolute: "/dev/null",
				expectedBytes: 10_000_000_000,
				signal: AbortSignal.timeout(10_000),
			}),
		).rejects.toMatchObject({ code: "client_download_too_large" });

		// Not one request. A zip that big could never be opened by the reader, so
		// fetching it could never produce a parse.
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(MINERU_MAX_DOWNLOAD_BYTES).toBe(
			DEFAULT_MINERU_ZIP_LIMITS.maxCompressedBytes,
		);
	});

	it("still allows a legitimate zip larger than the bundle budget", async () => {
		// The bundle budget bounds what is kept on disk after filtering; the zip
		// also carries middle_json, model_output and every image, so it is
		// routinely bigger. Clamping the download to it would break real parses.
		const payload = new Uint8Array(4_096);
		const fetchImpl = vi.fn(
			async () => new Response(payload, { status: 200 }),
		) as unknown as typeof fetch;
		const client = new MineruClient({
			config: testConfig({ bundleMaxBytes: 1_024 }),
			fetchImpl,
		});

		const destination = join(
			await mkdtemp(join(tmpdir(), "alfyai-mineru-dl-")),
			"result.zip",
		);
		await expect(
			client.downloadFile({
				fileId: "file_x",
				destinationPathAbsolute: destination,
				expectedBytes: payload.byteLength,
				signal: AbortSignal.timeout(10_000),
			}),
		).resolves.toEqual({ bytes: payload.byteLength });
		await rm(dirname(destination), { recursive: true, force: true });
	});
});
