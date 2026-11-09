// @vitest-environment node
//
// A HEIC or HEIF photo through MinerU 4.1: the real job engine, the real
// extraction handler, the real extractor registry and an in-process 4.1 server on
// a real socket. Nothing is stubbed between the engine's `drain` and the wire
// except the persist sink.
//
// What the two halves of this release promise each other. MinerU 4.1.7 routes a
// file by its extension and has never accepted .heic or .heif (the guard in
// `extractors/mineru4.test.ts` holds the registry against its list), and the
// extraction handler hands the document reader a PNG of such a photo for the
// length of one attempt (`extraction/reader-input.ts`). So what reaches the
// server is a PNG, told as `document.png` (S3) at an explicit tier (S4), and the
// photo the person uploaded is the file they get back.
//
// A file of its own because the real HEIC decoder refuses a Node Buffer under the
// repo's default jsdom environment, which `integration.test.ts` runs in, and takes
// it under Node, as the server does. The harness is that file's, cut to what
// these cases need.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractionErrorMessage } from "$lib/server/services/extraction/contracts";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";
import { runExtractionOnce } from "$lib/server/services/extraction/testing/run-once";
import { resetSeams } from "$lib/server/services/extraction/testing/runner-seams";
import type { Artifact } from "$lib/server/services/knowledge/types";
import {
	createFakeMineruServer,
	type FakeMineruServer,
	type FakeMineruServerOptions,
} from "./testing/fake-server";

type Ledger = typeof import("$lib/server/services/extraction/extraction-job");

// `vision/__fixtures__/tiny.heic` is 64x42, brand `ftypheic`; how it was made is
// written in `vision/prepare-image.test.ts`.
const here = dirname(fileURLToPath(import.meta.url));
const tinyHeic = readFileSync(
	join(here, "..", "vision", "__fixtures__", "tiny.heic"),
);
const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

let fixture: LedgerFixture;
let server: FakeMineruServer;
let ledger: Ledger;
let storageDir: string;
let userId: string;
/** Every `data/knowledge/<userId>` this test wrote, removed in afterEach. */
const writtenKnowledgeDirs = new Set<string>();
const persisted: Array<Record<string, unknown>> = [];

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The configuration arrives the way it does in production: through the environment. */
async function boot(options: FakeMineruServerOptions = {}): Promise<void> {
	server = await createFakeMineruServer(options);

	process.env.DATABASE_PATH = fixture.dbPath;
	process.env.MINERU_API_URL = server.baseUrl;
	process.env.MINERU_API_KEY = "";
	// The floor the admin registry clamps to. Two or three polls per job.
	process.env.MINERU_POLL_MIN_MS = "250";
	process.env.MINERU_POLL_MAX_MS = "1000";
	process.env.MINERU_REQUEST_TIMEOUT_MS = "5000";
	process.env.MINERU_TRANSFER_TIMEOUT_MS = "10000";
	process.env.MINERU_CAPABILITIES_TTL_MS = "0";

	vi.resetModules();
	resetSeams();
	ledger = await import("$lib/server/services/extraction/extraction-job");
	const capabilities = await import("./capabilities");
	capabilities.resetMineruCapabilitiesCacheForTests();
}

/** The persist sink belongs to a different slice. Here it only records what reached it. */
function persistSink() {
	return (async (params: Record<string, unknown>) => {
		persisted.push(params);
		const id = fixture.seedArtifact({
			userId: params.userId as string,
			type: "normalized_document",
			name: `normalized-${randomUUID()}.md`,
		});
		return { id, metadata: {} } as unknown as Artifact;
	}) as never;
}

/**
 * A stored photo and its queued extraction job, the way an upload leaves them:
 * the artifact holds the photo's own digest, which is not the digest of the PNG
 * MinerU is given.
 */
async function seedPhotoJob(photo: {
	fileName: string;
	mimeType: string | null;
	bytes: Buffer;
}) {
	const storedPath = join(storageDir, `${randomUUID()}-${photo.fileName}`);
	await writeFile(storedPath, photo.bytes);

	const artifactId = randomUUID();
	fixture.seedArtifact({
		id: artifactId,
		userId,
		name: photo.fileName,
		mimeType: photo.mimeType,
		sizeBytes: photo.bytes.byteLength,
		storagePath: relative(process.cwd(), storedPath),
		binaryHash: sha256(photo.bytes),
	});
	const { job } = await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: photo.fileName,
		mimeType: photo.mimeType,
		sizeBytes: photo.bytes.byteLength,
		sourceArtifactId: artifactId,
	});
	writtenKnowledgeDirs.add(join(process.cwd(), "data", "knowledge", userId));
	return { jobId: job.id, artifactId, storedPath };
}

function run() {
	return runExtractionOnce(fixture.sqlite, { persistResult: persistSink() });
}

function createBody() {
	return server.requests.find(
		(entry) => entry.method === "POST" && entry.path === "/v1/tasks",
	)?.json as
		| {
				files: Array<{ file_name: string; bytes: number; sha256sum: string }>;
				tier?: string;
		  }
		| undefined;
}

function puts() {
	return server.requests.filter((entry) => entry.method === "PUT");
}

/**
 * What the client is told to upload, read when it is told: the PNG the handler
 * made, which is gone once the attempt is over. Laid over the client of the
 * module graph `boot` just made, so call it after `boot`.
 */
async function captureUploads() {
	const { MineruClient } = await import("./client");
	const upload = MineruClient.prototype.putTaskFile;
	const uploads: Array<{ path: string; bytes: Buffer }> = [];
	vi.spyOn(MineruClient.prototype, "putTaskFile").mockImplementation(
		async function (this: InstanceType<typeof MineruClient>, input) {
			uploads.push({
				path: input.filePathAbsolute,
				bytes: await readFile(input.filePathAbsolute),
			});
			return upload.call(this, input);
		},
	);
	return uploads;
}

beforeEach(async () => {
	persisted.length = 0;
	userId = `u${randomUUID().replace(/-/g, "")}`;
	fixture = createLedgerFixture("mineru4-heic");
	fixture.seedUser(userId);
	storageDir = join(tmpdir(), `alfyai-m4heic-${randomUUID()}`);
	await mkdir(storageDir, { recursive: true });
});

afterEach(async () => {
	await server?.close();
	fixture.cleanup();
	await rm(storageDir, { recursive: true, force: true });
	for (const dir of writtenKnowledgeDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	writtenKnowledgeDirs.clear();
	vi.restoreAllMocks();
});

describe("a HEIC or HEIF photo reaches MinerU 4.1 as a PNG", () => {
	it.each([
		["a .HEIC with its own type", "IMG_0042.HEIC", "image/heic", "IMG_0042"],
		[
			"a .heic a browser sent as octet-stream",
			"IMG_0042.heic",
			"application/octet-stream",
			"IMG_0042",
		],
		["a .heic sent with no type", "IMG_0042.heic", null, "IMG_0042"],
		["a .heif", "shot.heif", "image/heif", "shot"],
	])("%s: told document.png at an explicit tier, uploaded as PNG bytes, the original untouched", async (_label, fileName, mimeType, stem) => {
		await boot({ fixtureInput: "png" });
		const uploads = await captureUploads();
		const { jobId, artifactId, storedPath } = await seedPhotoJob({
			fileName,
			mimeType,
			bytes: tinyHeic,
		});

		expect(await run()).toEqual({ jobId, status: "succeeded" });

		// What MinerU was told: the PNG's canonical name, never document.heic, and
		// the tier an image is always given (S3, S4).
		const create = createBody();
		expect(create?.files).toHaveLength(1);
		expect(create?.files[0].file_name).toBe("document.png");
		expect(create?.tier).toBe("standard");

		// What it was sent: one upload, and it is a PNG of the photo, whole.
		expect(uploads).toHaveLength(1);
		const png = uploads[0].bytes;
		expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
		expect(png.readUInt32BE(16)).toBe(64);
		expect(png.readUInt32BE(20)).toBe(42);
		// The task declares the PNG, not the photo whose digest the artifact holds,
		// and the server checked the bytes against that declaration before it
		// accepted them (a mismatch is a 400 and the file keeps waiting).
		expect(create?.files[0].sha256sum).toBe(sha256(png));
		expect(create?.files[0].sha256sum).not.toBe(sha256(tinyHeic));
		expect(create?.files[0].bytes).toBe(png.length);
		expect(puts()).toHaveLength(1);
		expect(puts()[0].bodyBytes).toBe(png.length);
		expect(server.blobs.get(sha256(png))).toBe(png.length);

		// It completed, and the text is attached to the photo under its own name.
		expect(persisted).toHaveLength(1);
		const call = persisted[0];
		expect(String(call.text).length).toBeGreaterThan(0);
		expect(call.sourceArtifactId).toBe(artifactId);
		expect(call.sourceName).toBe(fileName);
		expect(call.normalizedName).toBe(`${stem}.md`);
		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.status).toBe("succeeded");
		expect(row?.errorCode).toBeNull();

		// The photo is as it was uploaded, and the PNG did not outlive the attempt.
		expect(await readFile(storedPath)).toEqual(tinyHeic);
		expect(existsSync(uploads[0].path)).toBe(false);
	});
});

describe("an original that has gone from storage", () => {
	// What the job stores is what the browser is sent, and the raw text of a Node file
	// error is an absolute path. A PDF is the control: it is read by the MinerU
	// extractor itself, which answers an error it does not know with `unavailable`.
	// The photo, read by the helper before the extractor runs, must end the same way.
	it.each([
		["a HEIC photo", "IMG_0042.heic", "image/heic", tinyHeic],
		["a PDF", "report.pdf", "application/pdf", Buffer.from("%PDF-1.7\n")],
	])("%s: waits as the document service being unavailable, and the message holds no path", async (_label, fileName, mimeType, bytes) => {
		await boot({ fixtureInput: "png" });
		const { jobId, storedPath } = await seedPhotoJob({
			fileName,
			mimeType,
			bytes,
		});
		await rm(storedPath);

		const ran = await run();

		const row = await ledger.getExtractionJobRow(jobId);
		const sentence = extractionErrorMessage("unavailable", "");
		expect(row?.errorMessage).not.toContain(storageDir);
		expect(row?.errorMessage).toBe(sentence);
		expect(row?.errorCode).toBe("unavailable");
		// An outage code waits and tries again; it does not fail the document.
		expect(ran).toEqual({ jobId, status: "queued" });
		const [attempt] = await ledger.listExtractionJobAttempts(jobId);
		expect(attempt?.errorMessage).toBe(sentence);
		// The raw text is kept where an operator reads it.
		expect(attempt?.diagnosticsJson).toContain(storedPath);
		expect(persisted).toEqual([]);
	});
});

describe("a photo that cannot be decoded", () => {
	it("fails once as an unreadable document, and MinerU is never asked", async () => {
		await boot({ fixtureInput: "png" });
		const { jobId } = await seedPhotoJob({
			fileName: "broken.heic",
			mimeType: "image/heic",
			bytes: Buffer.from("not a photo"),
		});

		expect(await run()).toEqual({ jobId, status: "failed" });

		const row = await ledger.getExtractionJobRow(jobId);
		expect(row?.errorCode).toBe("document_unreadable");
		// The same bytes can never be read, so no second attempt and no Retry.
		expect(row?.retryable).toBe(false);
		expect(await ledger.listExtractionJobAttempts(jobId)).toHaveLength(1);
		// Not the capability read, not a task: nothing left the process.
		expect(server.requests).toEqual([]);
		expect(persisted).toEqual([]);
	});
});
