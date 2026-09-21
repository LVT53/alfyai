// The debris a KILLED process leaves behind.
//
// Every ordinary exit path already cleans up: `extract()` drops its
// per-attempt download directory in a `finally`, `writeMineruParseBundle`
// drops its half-written bundle in a `catch`. A SIGKILL, an OOM kill or a
// power loss does neither, and until this sweep existed nothing ever removed
// either one — the bundle temp directory especially, which lives inside
// `data/`, holds up to MINERU_BUNDLE_MAX_BYTES, and is deliberately skipped by
// `findOrphanFiles` so it was not even reported.
//
// Everything here runs against real directories: what is being asserted is
// which paths a recursive delete is pointed at, which is not a property a mock
// can hold.

import { randomUUID } from "node:crypto";
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINERU_BUNDLE_TMP_INFIX } from "./bundle";
import {
	MINERU_ATTEMPT_TMP_PREFIX,
	MINERU_TEMP_MAX_AGE_MS,
	resetMineruTempSweepForTests,
	scheduleMineruTempSweep,
	sweepMineruTempDirs,
} from "./temp-sweep";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const OLD = NOW - MINERU_TEMP_MAX_AGE_MS - 60_000;
const RECENT = NOW - 60_000;

let tempRoot: string;
let knowledgeRoot: string;

async function seedDir(pathAbsolute: string, ageAt: number): Promise<string> {
	await mkdir(pathAbsolute, { recursive: true });
	await writeFile(join(pathAbsolute, "result.zip"), "bytes");
	const when = new Date(ageAt);
	await utimes(pathAbsolute, when, when);
	return pathAbsolute;
}

function sweep(overrides: Record<string, unknown> = {}) {
	return sweepMineruTempDirs({
		tempRootAbsolute: tempRoot,
		knowledgeRootAbsolute: knowledgeRoot,
		now: () => NOW,
		...overrides,
	});
}

beforeEach(async () => {
	resetMineruTempSweepForTests();
	tempRoot = await mkdtemp(join(tmpdir(), "alfyai-sweeptmp-"));
	knowledgeRoot = await mkdtemp(join(tmpdir(), "alfyai-sweepkn-"));
});

afterEach(() => {
	resetMineruTempSweepForTests();
	vi.restoreAllMocks();
});

describe("sweepMineruTempDirs", () => {
	it("removes a stale per-attempt download directory", async () => {
		const stale = await seedDir(
			join(tempRoot, `${MINERU_ATTEMPT_TMP_PREFIX}${randomUUID()}`),
			OLD,
		);

		expect(await sweep()).toEqual({ scanned: 1, removed: 1 });
		expect(existsSync(stale)).toBe(false);
	});

	it("removes a half-written bundle from inside the data directory", async () => {
		const user = join(knowledgeRoot, randomUUID());
		const artifactId = randomUUID();
		const stale = await seedDir(
			join(user, `${artifactId}${MINERU_BUNDLE_TMP_INFIX}9182-abc123`),
			OLD,
		);

		expect(await sweep()).toEqual({ scanned: 1, removed: 1 });
		expect(existsSync(stale)).toBe(false);
	});

	it("never touches a LIVE bundle, only its temp sibling", async () => {
		// `<id>.parse` is the bundle the figure endpoint serves from and the page
		// index reads. Matching it would delete a working document's figures.
		const user = join(knowledgeRoot, randomUUID());
		const artifactId = randomUUID();
		const live = await seedDir(join(user, `${artifactId}.parse`), OLD);
		const source = await seedDir(join(user, `${artifactId}-bytes`), OLD);
		const temp = await seedDir(
			join(user, `${artifactId}${MINERU_BUNDLE_TMP_INFIX}1-a`),
			OLD,
		);

		expect(await sweep()).toEqual({ scanned: 1, removed: 1 });
		expect(existsSync(live)).toBe(true);
		expect(existsSync(source)).toBe(true);
		expect(existsSync(temp)).toBe(false);
	});

	it("leaves a young directory alone, however it is named", async () => {
		// An attempt running RIGHT NOW — in this process, or in another one
		// sharing the box — must never age out from under itself.
		const attempt = await seedDir(
			join(tempRoot, `${MINERU_ATTEMPT_TMP_PREFIX}${randomUUID()}`),
			RECENT,
		);
		const user = join(knowledgeRoot, randomUUID());
		const bundle = await seedDir(
			join(user, `${randomUUID()}${MINERU_BUNDLE_TMP_INFIX}1-a`),
			RECENT,
		);

		expect(await sweep()).toEqual({ scanned: 2, removed: 0 });
		expect(existsSync(attempt)).toBe(true);
		expect(existsSync(bundle)).toBe(true);
	});

	it("ignores everything else in the temp root", async () => {
		// The sweep shares `os.tmpdir()` with every other process on the box.
		const stranger = await seedDir(join(tempRoot, "someone-elses-work"), OLD);
		const nearMiss = await seedDir(join(tempRoot, "alfyai-mineru3-old"), OLD);

		expect(await sweep()).toEqual({ scanned: 0, removed: 0 });
		expect(existsSync(stranger)).toBe(true);
		expect(existsSync(nearMiss)).toBe(true);
	});

	it("skips a symlink rather than following it into a recursive delete", async () => {
		const victim = await seedDir(join(knowledgeRoot, "precious"), OLD);
		const link = join(tempRoot, `${MINERU_ATTEMPT_TMP_PREFIX}evil`);
		symlinkSync(victim, link, "dir");

		const result = await sweep();
		expect(result.removed).toBe(0);
		expect(existsSync(victim)).toBe(true);
		expect(existsSync(join(victim, "result.zip"))).toBe(true);
	});

	it("is bounded rather than walking an enormous temp directory", async () => {
		for (let index = 0; index < 6; index++) {
			await seedDir(
				join(tempRoot, `${MINERU_ATTEMPT_TMP_PREFIX}${index}`),
				OLD,
			);
		}
		// `maxEntries` bounds the READDIR, so the sweep costs a fixed slice
		// whatever else is in there.
		const result = await sweep({ maxEntries: 2 });
		expect(result.scanned).toBeLessThanOrEqual(2);
	});

	it("never throws on a missing root", async () => {
		await expect(
			sweepMineruTempDirs({
				tempRootAbsolute: join(tempRoot, "nope"),
				knowledgeRootAbsolute: join(knowledgeRoot, "nope"),
				now: () => NOW,
			}),
		).resolves.toEqual({ scanned: 0, removed: 0 });
	});
});

describe("scheduleMineruTempSweep", () => {
	it("runs once and then throttles", async () => {
		const first = join(tempRoot, `${MINERU_ATTEMPT_TMP_PREFIX}one`);
		await seedDir(first, OLD);

		scheduleMineruTempSweep({
			tempRootAbsolute: tempRoot,
			knowledgeRootAbsolute: knowledgeRoot,
			now: () => NOW,
		});
		await vi.waitFor(() => expect(existsSync(first)).toBe(false));

		// A second call inside the window does nothing at all.
		const second = join(tempRoot, `${MINERU_ATTEMPT_TMP_PREFIX}two`);
		await seedDir(second, OLD);
		scheduleMineruTempSweep({
			tempRootAbsolute: tempRoot,
			knowledgeRootAbsolute: knowledgeRoot,
			now: () => NOW + 1_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(existsSync(second)).toBe(true);

		// Past the window it runs again.
		scheduleMineruTempSweep({
			tempRootAbsolute: tempRoot,
			knowledgeRootAbsolute: knowledgeRoot,
			now: () => NOW + MINERU_TEMP_MAX_AGE_MS + 1,
		});
		await vi.waitFor(() => expect(existsSync(second)).toBe(false));
	});
});
