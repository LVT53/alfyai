// Bug B2, the sweep half: nothing ever removed an abandoned `.incoming` entry,
// so a chunked upload whose final part never arrived stayed on disk forever.

import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetKnowledgeUploadTempSweepForTests,
	scheduleKnowledgeUploadTempSweep,
	sweepKnowledgeUploadTempFiles,
	UPLOAD_TEMP_MAX_AGE_MS,
} from "./upload-temp-sweep";

const now = Date.parse("2026-09-20T12:00:00Z");
let knowledgeRoot: string;

async function seedEntry(params: {
	userId: string;
	name: string;
	ageMs: number;
	directory?: boolean;
}): Promise<string> {
	const incoming = join(knowledgeRoot, params.userId, ".incoming");
	await mkdir(incoming, { recursive: true });
	const target = join(incoming, params.name);
	if (params.directory) {
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "part-000000"), "bytes");
	} else {
		await writeFile(target, "bytes");
	}
	const stamp = new Date(now - params.ageMs);
	await utimes(target, stamp, stamp);
	return target;
}

async function incomingNames(userId: string): Promise<string[]> {
	return (
		await readdir(join(knowledgeRoot, userId, ".incoming")).catch(() => [])
	).sort();
}

describe("sweepKnowledgeUploadTempFiles", () => {
	beforeEach(async () => {
		knowledgeRoot = await mkdtemp(join(tmpdir(), "alfyai-sweep-"));
		resetKnowledgeUploadTempSweepForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes an abandoned raw temp file and an abandoned part directory", async () => {
		await seedEntry({
			userId: "user-1",
			name: "trace-old.upload",
			ageMs: UPLOAD_TEMP_MAX_AGE_MS + 60_000,
		});
		await seedEntry({
			userId: "user-1",
			name: "trace-old-chunks",
			ageMs: UPLOAD_TEMP_MAX_AGE_MS + 60_000,
			directory: true,
		});

		const result = await sweepKnowledgeUploadTempFiles({
			knowledgeRootAbsolute: knowledgeRoot,
			now,
		});

		expect(result).toEqual({ scanned: 2, removed: 2 });
		expect(await incomingNames("user-1")).toEqual([]);
	});

	it("never touches an upload that could still be in flight", async () => {
		// A chunked upload keeps touching its part directory, so an active
		// transfer can never age out from under itself.
		await seedEntry({
			userId: "user-1",
			name: "trace-live",
			ageMs: 30_000,
			directory: true,
		});
		await seedEntry({
			userId: "user-1",
			name: "trace-nearly-old.upload",
			ageMs: UPLOAD_TEMP_MAX_AGE_MS - 60_000,
		});

		const result = await sweepKnowledgeUploadTempFiles({
			knowledgeRootAbsolute: knowledgeRoot,
			now,
		});

		expect(result.removed).toBe(0);
		expect(await incomingNames("user-1")).toEqual([
			"trace-live",
			"trace-nearly-old.upload",
		]);
	});

	it("sweeps every user, and only one when asked", async () => {
		const old = UPLOAD_TEMP_MAX_AGE_MS + 60_000;
		await seedEntry({ userId: "user-1", name: "a.upload", ageMs: old });
		await seedEntry({ userId: "user-2", name: "b.upload", ageMs: old });

		const scoped = await sweepKnowledgeUploadTempFiles({
			knowledgeRootAbsolute: knowledgeRoot,
			userId: "user-1",
			now,
		});
		expect(scoped.removed).toBe(1);
		expect(await incomingNames("user-2")).toEqual(["b.upload"]);

		const all = await sweepKnowledgeUploadTempFiles({
			knowledgeRootAbsolute: knowledgeRoot,
			now,
		});
		expect(all.removed).toBe(1);
		expect(await incomingNames("user-2")).toEqual([]);
	});

	it("reports nothing rather than throwing when there is no directory", async () => {
		await expect(
			sweepKnowledgeUploadTempFiles({
				knowledgeRootAbsolute: join(knowledgeRoot, "not-here"),
				now,
			}),
		).resolves.toEqual({ scanned: 0, removed: 0 });
	});

	it("honours an explicit max age", async () => {
		await seedEntry({ userId: "user-1", name: "a.upload", ageMs: 120_000 });

		const result = await sweepKnowledgeUploadTempFiles({
			knowledgeRootAbsolute: knowledgeRoot,
			maxAgeMs: 60_000,
			now,
		});

		expect(result.removed).toBe(1);
	});
});

describe("scheduleKnowledgeUploadTempSweep", () => {
	it("stays inert under test, so an upload route never sweeps real data", () => {
		// The routes call this on every upload; the throttle and this guard are
		// what make that safe.
		resetKnowledgeUploadTempSweepForTests();
		expect(() => scheduleKnowledgeUploadTempSweep()).not.toThrow();
	});
});
