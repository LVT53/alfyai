/**
 * The upload never materialises the file, and the download never materialises
 * the zip.
 *
 * A 180 MB PDF is inside MinerU's own limits (`max_file_size_bytes` is 200 MB),
 * so "read it into a Buffer and POST it" is not a shortcut, it is an
 * out-of-memory error on a box that also runs the model. These cases prove the
 * bytes move a chunk at a time, in both directions, and that `Content-Length`
 * is the `stat` size rather than something derived from a buffer.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeMineruFileReader,
	MineruClient,
	type MineruFileReader,
} from "./client";
import type { MineruConfig } from "./config";
import type { MineruUpload } from "./schemas";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	MINERU_FIXTURE_ROOT,
} from "./testing/fake-server";

const never = new AbortController().signal;

function testConfig(patch: Partial<MineruConfig> = {}): MineruConfig {
	return {
		baseUrl: "http://127.0.0.1:8765",
		apiKey: "",
		defaultTier: "auto",
		ocrMode: "auto",
		jobTimeoutMs: 5000,
		pollMinMs: 1,
		pollMaxMs: 5,
		requestTimeoutMs: 2000,
		transferTimeoutMs: 10000,
		capabilitiesTtlMs: 0,
		bundleMaxBytes: 33554432,
		structureChunking: true,
		...patch,
	};
}

interface CountingReader extends MineruFileReader {
	streamCalls: number;
	chunksProduced: number;
	statCalls: number;
}

/**
 * A reader with NO way to read the whole file: it exposes `stat`, `stream` and
 * `sha256` and nothing else, so a client that wanted to buffer the upload
 * could not, even by accident.
 */
function countingReader(size: number, chunkSize = 64 * 1024): CountingReader {
	const reader: CountingReader = {
		streamCalls: 0,
		chunksProduced: 0,
		statCalls: 0,
		async stat() {
			reader.statCalls += 1;
			return { size };
		},
		stream() {
			reader.streamCalls += 1;
			let sent = 0;
			return new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent >= size) {
						controller.close();
						return;
					}
					const length = Math.min(chunkSize, size - sent);
					sent += length;
					reader.chunksProduced += 1;
					controller.enqueue(new Uint8Array(length).fill(65));
				},
			});
		},
		async sha256() {
			return "c".repeat(64);
		},
	};
	return reader;
}

let server: FakeMineruServer | null = null;
let tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mineru-stream-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await server?.close();
	server = null;
	tempDirs = [];
});

describe("putUploadContent streams", () => {
	it("sends stat's size as Content-Length and never buffers the file", async () => {
		server = await createFakeMineruServer();
		const size = 3 * 1024 * 1024 + 7;
		const reader = countingReader(size);
		const client = new MineruClient({
			config: testConfig({ baseUrl: server.baseUrl }),
			fileReader: reader,
		});

		const upload = (await client.createUpload({
			filename: "big.pdf",
			bytes: size,
			mimeType: "application/pdf",
			sha256sum: "d".repeat(64),
			signal: never,
		})) as MineruUpload;
		expect(upload.status).toBe("pending");

		await client.putUploadContent({
			upload,
			filePathAbsolute: "/absolute/path/big.pdf",
			signal: never,
		});

		const put = server.requests.find((request) => request.method === "PUT");
		expect(put?.headers["content-length"]).toBe(String(size));
		expect(put?.bodyBytes).toBe(size);

		expect(reader.statCalls).toBe(1);
		expect(reader.streamCalls).toBe(1);
		// Many chunks, not one 3 MB blob.
		expect(reader.chunksProduced).toBeGreaterThan(40);
	});

	it("hands out a FRESH stream for a re-PUT after a hash mismatch", async () => {
		server = await createFakeMineruServer();
		const reader = countingReader(1024);
		const client = new MineruClient({
			config: testConfig({ baseUrl: server.baseUrl }),
			fileReader: reader,
		});
		const upload = await client.createUpload({
			filename: "small.pdf",
			bytes: 1024,
			mimeType: "application/pdf",
			sha256sum: "e".repeat(64),
			signal: never,
		});

		await client.putUploadContent({
			upload,
			filePathAbsolute: "/absolute/path/small.pdf",
			signal: never,
		});
		await client.putUploadContent({
			upload,
			filePathAbsolute: "/absolute/path/small.pdf",
			signal: never,
		});
		// A single stream cannot be consumed twice; a re-PUT must ask again.
		expect(reader.streamCalls).toBe(2);
	});

	it("does not read the upload through node:fs in client.ts", () => {
		const source = readFileSync(join(__dirname, "client.ts"), "utf8");
		const code = source
			.split("\n")
			.filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
			.join("\n");
		// `createReadStream` is allowed; the whole-file reads are not.
		expect(code).not.toContain("readFileSync");
		expect(code).not.toMatch(/\breadFile\(/);
		expect(code).toContain("createReadStream");
	});
});

describe("the default node file reader", () => {
	it("stats, streams and digests a real file without buffering it", async () => {
		const reader = createNodeMineruFileReader();
		const path = join(MINERU_FIXTURE_ROOT, "docx", "sample.docx");
		const bytes = readFileSync(path);

		expect((await reader.stat(path)).size).toBe(bytes.byteLength);
		expect(await reader.sha256(path)).toBe(
			createHash("sha256").update(bytes).digest("hex"),
		);

		let streamed = 0;
		const stream = reader.stream(path);
		const walker = stream.getReader();
		for (;;) {
			const { done, value } = await walker.read();
			if (done) break;
			streamed += value?.byteLength ?? 0;
		}
		expect(streamed).toBe(bytes.byteLength);
	});

	it("matches the sha256 the fixtures recorded, which is the dedupe key", async () => {
		const reader = createNodeMineruFileReader();
		const recorded = JSON.parse(
			readFileSync(
				join(MINERU_FIXTURE_ROOT, "docx", "upload.create.json"),
				"utf8",
			),
		) as { sha256sum: string };
		expect(
			await reader.sha256(join(MINERU_FIXTURE_ROOT, "docx", "sample.docx")),
		).toBe(recorded.sha256sum);
	});
});

describe("downloadFile streams to disk", () => {
	it("writes a multi-megabyte payload without holding it in memory", async () => {
		const dir = tempDir();
		const payload = Buffer.alloc(2 * 1024 * 1024, 7);
		const source = join(dir, "payload.bin");
		writeFileSync(source, payload);

		// A tiny server whose only job is to stream the payload back.
		const { createServer } = await import("node:http");
		const http = createServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": payload.byteLength,
			});
			res.end(payload);
		});
		await new Promise<void>((resolve) => {
			http.listen(0, "127.0.0.1", resolve);
		});
		const port = (http.address() as { port: number }).port;

		try {
			const client = new MineruClient({
				config: testConfig({ baseUrl: `http://127.0.0.1:${port}` }),
			});
			const destination = join(dir, "downloaded.bin");
			const { bytes } = await client.downloadFile({
				fileId: "file-big",
				destinationPathAbsolute: destination,
				expectedBytes: payload.byteLength,
				signal: never,
			});
			expect(bytes).toBe(payload.byteLength);
			expect(statSync(destination).size).toBe(payload.byteLength);
			expect(readFileSync(destination).equals(payload)).toBe(true);
		} finally {
			await new Promise<void>((resolve) => {
				http.close(() => {
					resolve();
				});
			});
		}
	});
});
