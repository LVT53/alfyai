import { afterEach, beforeEach, expect, it } from "vitest";
import {
	MEMORY_KINDS,
	type MemoryScope,
	PERSONAL_MEMORY_SUBJECTS,
} from "$lib/memory-types";
import { estimateTokenCount } from "$lib/utils/tokens";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import type { CurationModel } from "./curation";
import { seedSubjectEntries } from "./subject-read.test-helpers";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-subject-size");
});
afterEach(() => h.cleanup());

const NOW = new Date("2026-11-24T12:00:00Z");
const PERSONAL: MemoryScope = { kind: "personal" };
const ENTRIES = 5_000;

/**
 * The spec's size target (Calls I made 9): a synthetic bank of 5,000 entries,
 * spread over the subjects and kinds and over two years of mentions. Logs what
 * the page's reads cost, so the build notes can report it.
 */
it("reads a 5,000-entry bank's index and its largest subject in time", async () => {
	await seedSubjectEntries(
		h.userId,
		PERSONAL,
		Array.from({ length: ENTRIES }, (_, i) => ({
			id: `e${i}`,
			text: `Synthetic remembered detail number ${i}, about one plain everyday thing.`,
			said: new Date(NOW.getTime() - (i % 730) * 86_400_000).toISOString(),
			kind: MEMORY_KINDS[i % MEMORY_KINDS.length],
			subject: PERSONAL_MEMORY_SUBJECTS[i % PERSONAL_MEMORY_SUBJECTS.length],
		})),
	);
	const { readMemorySubjectIndex, listMemorySubject } = await import(
		"./subject-read"
	);
	let started = performance.now();
	const index = readMemorySubjectIndex(h.userId, PERSONAL, NOW);
	const indexMs = performance.now() - started;
	const largest = [...index.subjects].sort((a, b) => b.count - a.count)[0];
	started = performance.now();
	const subject = listMemorySubject(
		h.userId,
		{ scope: PERSONAL, subject: largest.subject, state: "current" },
		NOW,
	);
	const subjectMs = performance.now() - started;
	started = performance.now();
	const earlier = listMemorySubject(
		h.userId,
		{ scope: PERSONAL, subject: "all", state: "earlier" },
		NOW,
	);
	const earlierMs = performance.now() - started;
	const sizes = {
		indexBytes: JSON.stringify(index).length,
		subjectPageBytes: JSON.stringify(subject).length,
		earlierPageBytes: JSON.stringify(earlier).length,
	};
	console.info("[MEMORY_PAGE_SIZE]", {
		entries: ENTRIES,
		current: index.currentCount,
		earlier: index.earlier.count,
		largestSubject: largest.count,
		indexMs: Math.round(indexMs),
		subjectMs: Math.round(subjectMs),
		earlierMs: Math.round(earlierMs),
		...sizes,
	});
	expect(index.currentCount + index.earlier.count).toBe(ENTRIES);
	expect(subject.entries).toHaveLength(100);
	expect(indexMs).toBeLessThan(2_000);
	expect(sizes.indexBytes).toBeLessThan(20_000);

	// The Overview on the same bank, with an instant fake model: what the app
	// itself spends around the one call, and what the call is given.
	const { readMemoryOverview, writeMemoryOverview } = await import(
		"./overview"
	);
	let given = "";
	const model: CurationModel = async (prompt, input) => {
		given = prompt + JSON.stringify(input);
		return { overview: "A synthetic overview." };
	};
	started = performance.now();
	const written = await writeMemoryOverview(h.userId, PERSONAL, {
		rewrite: true,
		model,
		now: NOW,
	});
	const overviewWriteMs = performance.now() - started;
	started = performance.now();
	const kept = readMemoryOverview(h.userId, PERSONAL, NOW);
	const overviewReadMs = performance.now() - started;
	console.info("[MEMORY_OVERVIEW_SIZE]", {
		current: written.currentCount,
		writtenFrom: written.writtenFrom,
		requestChars: given.length,
		requestTokens: estimateTokenCount(given),
		appMsAroundTheCall: Math.round(overviewWriteMs),
		keptReadMs: Math.round(overviewReadMs),
	});
	expect(written.writtenFrom).toBeLessThan(written.currentCount);
	expect(kept.state).toBe("written");
	expect(overviewReadMs).toBeLessThan(2_000);
}, 60_000);
