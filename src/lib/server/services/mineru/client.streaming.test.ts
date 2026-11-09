/**
 * The upload never materialises the file, and the download never materialises
 * the ZIP.
 *
 * A 180 MB PDF is inside MinerU's own limits, so "read it into a Buffer and PUT
 * it" is not a shortcut, it is an out-of-memory error on a box that also runs
 * the model. These cases prove the bytes move a chunk at a time, in both
 * directions, and that `Content-Length` is the `stat` size rather than something
 * derived from a buffer.
 */

import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeMineruFileReader,
	MineruClient,
	type MineruFileReader,
} from "./client";
import type { MineruConfig } from "./config";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	MINERU_PROTOCOL_FIXTURE_ROOT,
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
		bundleUserQuotaBytes: 0,
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
 * could not, even by accident. The stream is `size` bytes of "A".
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
			return createHash("sha256").update(Buffer.alloc(size, 65)).digest("hex");
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
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

/** A task for `size` bytes of "A" on a fake server, and a client reading them from a counting reader. */
async function taskFor(size: number) {
	server = await createFakeMineruServer();
	const reader = countingReader(size);
	const client = new MineruClient({
		config: testConfig({ baseUrl: server.baseUrl }),
		fileReader: reader,
	});
	const receipt = await client.createTask({
		fileName: "document.pdf",
		bytes: size,
		sha256sum: await reader.sha256("/absolute/path/document.pdf"),
		signal: never,
	});
	const upload = receipt.files[0]?.upload;
	if (!upload) throw new Error("expected an upload link");
	return { client, reader, upload, receipt };
}

describe("putTaskFile streams", () => {
	it("sends stat's size as Content-Length and never buffers the file", async () => {
		const size = 3 * 1024 * 1024 + 7;
		const { client, reader, upload } = await taskFor(size);

		const answer = await client.putTaskFile({
			upload,
			filePathAbsolute: "/absolute/path/document.pdf",
			signal: never,
		});
		expect(answer.status).toBe("pending");

		const put = server?.requests.find((request) => request.method === "PUT");
		expect(put?.headers["content-length"]).toBe(String(size));
		expect(put?.bodyBytes).toBe(size);

		// One stat for the declared size (createTask got it from the caller), and
		// one stream for the body.
		expect(reader.statCalls).toBe(1);
		expect(reader.streamCalls).toBe(1);
		// Many chunks, not one 3 MB blob.
		expect(reader.chunksProduced).toBeGreaterThan(40);
	});

	it("hands out a FRESH stream for every PUT, because a stream cannot be read twice", async () => {
		const { client, reader, upload } = await taskFor(1024);

		await client.putTaskFile({
			upload,
			filePathAbsolute: "/absolute/path/document.pdf",
			signal: never,
		});
		// A repeat PUT is harmless (200), and still asks for its own stream.
		await client.putTaskFile({
			upload,
			filePathAbsolute: "/absolute/path/document.pdf",
			signal: never,
		});
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
	const real = join(MINERU_PROTOCOL_FIXTURE_ROOT, "zips", "v41-docx.zip");

	it("stats, streams and digests a real file without buffering it", async () => {
		const reader = createNodeMineruFileReader();
		const bytes = readFileSync(real);

		expect((await reader.stat(real)).size).toBe(bytes.byteLength);
		expect(await reader.sha256(real)).toBe(
			createHash("sha256").update(bytes).digest("hex"),
		);

		let streamed = 0;
		const stream = reader.stream(real);
		const walker = stream.getReader();
		for (;;) {
			const { done, value } = await walker.read();
			if (done) break;
			streamed += value?.byteLength ?? 0;
		}
		expect(streamed).toBe(bytes.byteLength);
	});

	it("uploads a real file from disk and the server receives it intact", async () => {
		server = await createFakeMineruServer();
		const client = new MineruClient({
			config: testConfig({ baseUrl: server.baseUrl }),
		});
		const receipt = await client.createTask({
			fileName: "document.docx",
			bytes: (await client.statFile(real)).size,
			sha256sum: await client.sha256(real),
			signal: never,
		});
		const upload = receipt.files[0]?.upload;
		if (!upload) throw new Error("expected an upload link");
		await client.putTaskFile({ upload, filePathAbsolute: real, signal: never });
		// The server verified the digest of what it received against the one we
		// declared, so a 'pending' file means every byte arrived.
		const task = await client.getTask({
			taskId: receipt.task_id,
			signal: never,
		});
		expect(task.files[0]?.status).not.toBe("waiting-file");
		expect([...(server?.blobs.values() ?? [])]).toEqual([statSync(real).size]);
	});
});

describe("downloadFile streams to disk", () => {
	async function serving(
		payload: Buffer,
		announce: boolean,
	): Promise<{ origin: string; close: () => Promise<void> }> {
		const http = createServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/zip",
				...(announce ? { "content-length": payload.byteLength } : {}),
			});
			// Several writes, so a server that does not announce a length streams chunked.
			const half = Math.floor(payload.byteLength / 2);
			res.write(payload.subarray(0, half));
			res.end(payload.subarray(half));
		});
		await new Promise<void>((resolve) => {
			http.listen(0, "127.0.0.1", resolve);
		});
		const port = (http.address() as { port: number }).port;
		return {
			origin: `http://127.0.0.1:${port}`,
			close: () =>
				new Promise<void>((resolve) => {
					http.close(() => {
						resolve();
					});
				}),
		};
	}

	it.each([
		["announcing its length", true],
		["streaming chunked, with no length at all", false],
	])("writes a multi-megabyte payload %s without holding it in memory", async (_label, announce) => {
		const dir = tempDir();
		const payload = Buffer.alloc(2 * 1024 * 1024, 7);
		const origin = await serving(payload, announce);

		try {
			const client = new MineruClient({
				config: testConfig({ baseUrl: origin.origin }),
			});
			const destination = join(dir, "downloaded.bin");
			const { bytes } = await client.downloadFile({
				resultUrl: `${origin.origin}/v1/files/file-big/content`,
				destinationPathAbsolute: destination,
				signal: never,
			});
			expect(bytes).toBe(payload.byteLength);
			expect(statSync(destination).size).toBe(payload.byteLength);
			expect(readFileSync(destination).equals(payload)).toBe(true);
		} finally {
			await origin.close();
		}
	});

	it("leaves the destination alone when the result cannot be downloaded", async () => {
		const dir = tempDir();
		const destination = join(dir, "precious.zip");
		writeFileSync(destination, "keep me");
		server = await createFakeMineruServer();
		const client = new MineruClient({
			config: testConfig({ baseUrl: server.baseUrl }),
		});
		const error = await client
			.downloadFile({
				resultUrl: `${server.baseUrl}/v1/files/file-${"0".repeat(24)}/content`,
				destinationPathAbsolute: destination,
				signal: never,
			})
			.catch((caught) => caught);
		expect((error as { code: string }).code).toBe("file_not_found");
		expect(readFileSync(destination, "utf8")).toBe("keep me");
	});
});
