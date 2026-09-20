import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractDocumentRequest } from "../contracts";
import { isDocumentExtractionError } from "../contracts";
import { createDirectTextExtractor } from "./direct-text";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "alfyai-direct-text-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function writeFixture(name: string, content: string): Promise<string> {
	const filePath = join(dir, name);
	await writeFile(filePath, content, "utf8");
	return filePath;
}

function request(
	overrides: Partial<ExtractDocumentRequest> & { filePathAbsolute: string },
): ExtractDocumentRequest {
	return {
		fileName: "notes.txt",
		mimeType: "text/plain",
		sizeBytes: 0,
		intakeRoute: "direct-text",
		signal: new AbortController().signal,
		onProgress: () => undefined,
		...overrides,
	};
}

async function capture(promise: Promise<unknown>) {
	try {
		await promise;
		throw new Error("expected a throw");
	} catch (error) {
		if (!isDocumentExtractionError(error)) throw error;
		return error;
	}
}

describe("directTextExtractor", () => {
	it("reads a text file, trimming and normalising CRLF", async () => {
		// Matches `task-state/chunk-sync.ts` so a Windows-authored file and its
		// Unix twin chunk identically and therefore embed identically.
		const filePathAbsolute = await writeFixture(
			"notes.txt",
			"\r\nline one\r\nline two\r\n\r\n",
		);
		const extractor = createDirectTextExtractor({ maxBytes: 1024 });

		const result = await extractor.extract(request({ filePathAbsolute }));
		expect(result.text).toBe("line one\nline two");
		expect(result.normalizedName).toBe("notes.md");
		expect(result.mimeType).toBe("text/markdown");
	});

	it("reports the parsing phase", async () => {
		const filePathAbsolute = await writeFixture("notes.txt", "hello");
		const phases: string[] = [];
		await createDirectTextExtractor({ maxBytes: 1024 }).extract(
			request({
				filePathAbsolute,
				onProgress: (progress) => phases.push(progress.phase),
			}),
		);
		expect(phases).toContain("parsing");
	});

	it("throws too_large, non-retryable, over the cap", async () => {
		const filePathAbsolute = await writeFixture("big.txt", "x".repeat(200));
		const error = await capture(
			createDirectTextExtractor({ maxBytes: 100 }).extract(
				request({ filePathAbsolute, fileName: "big.txt" }),
			),
		);

		expect(error.code).toBe("too_large");
		expect(error.retryable).toBe(false);
		expect(error.details).toMatchObject({ sizeBytes: 200, maxBytes: 100 });
	});

	it("measures the file itself, not the caller's claimed size", async () => {
		// The raw upload route records a size before the body finished arriving;
		// a cap that can be talked past by a wrong number is not a cap.
		const filePathAbsolute = await writeFixture("big.txt", "x".repeat(200));
		const error = await capture(
			createDirectTextExtractor({ maxBytes: 100 }).extract(
				request({ filePathAbsolute, sizeBytes: 1 }),
			),
		);
		expect(error.code).toBe("too_large");
	});

	it("throws empty_result, non-retryable, for a blank file", async () => {
		const filePathAbsolute = await writeFixture("empty.txt", "   \n\n  ");
		const error = await capture(
			createDirectTextExtractor({ maxBytes: 1024 }).extract(
				request({ filePathAbsolute }),
			),
		);

		expect(error.code).toBe("empty_result");
		// Same bytes, same answer: retrying it is a promise the code cannot keep.
		expect(error.retryable).toBe(false);
	});

	it("throws internal for a file that is not there", async () => {
		const error = await capture(
			createDirectTextExtractor({ maxBytes: 1024 }).extract(
				request({ filePathAbsolute: join(dir, `${randomUUID()}.txt`) }),
			),
		);
		expect(error.code).toBe("internal");
		expect(error.retryable).toBe(false);
	});

	it("refuses to start on an already-aborted signal", async () => {
		const filePathAbsolute = await writeFixture("notes.txt", "hello");
		const controller = new AbortController();
		controller.abort();

		const error = await capture(
			createDirectTextExtractor({ maxBytes: 1024 }).extract(
				request({ filePathAbsolute, signal: controller.signal }),
			),
		);
		expect(error.code).toBe("canceled");
	});

	it("never resumes, and so is never handed a handle", () => {
		expect(createDirectTextExtractor().supportsResume).toBe(false);
	});

	it("reads the cap from configuration when none is injected", async () => {
		// The injected `maxBytes` is a test seam only; production resolves the
		// admin-editable key per call, which is what makes it a "live" setting.
		const { getExtractionConfig } = await import("../config");
		const configured = getExtractionConfig().maxDirectTextBytes;
		expect(configured).toBe(8 * 1024 * 1024);

		const filePathAbsolute = await writeFixture("small.txt", "hello");
		const result = await createDirectTextExtractor().extract(
			request({ filePathAbsolute }),
		);
		expect(result.text).toBe("hello");
	});
});
