import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_KINDS, type MemoryKind } from "$lib/memory-types";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import { nativeBankConfig } from "./contracts";
import type { CurationModel } from "./curation";
import {
	duplicateCandidates,
	JUDGE_JUNK_REASONS,
	type JudgeEntry,
	type JudgeFixture,
	type JudgeQuestion,
	type JudgeRun,
	type JudgeVerdict,
	judgeAgreement,
	judgeMemoryEntries,
	judgeTotals,
	MEMORY_QUALITY_CONSENT_CHANGED,
	QUALITY_JUDGE_BATCH_SIZE,
	QUALITY_JUDGE_MAX_FAILED_IN_A_ROW,
	QUALITY_JUDGE_PROMPT,
} from "./quality-judge";
import { QUALITY_JUDGE_FIXTURES } from "./quality-judge.eval-fixtures";
import { seedSubjectEntries } from "./subject-read.test-helpers";

/** An entry as the judge is shown it. */
interface Shown {
	id: string;
	text: string;
	event_date: string | null;
	said_date: string | null;
	candidates: Array<{ id: string; text: string }>;
}
const shownOf = (input: unknown) => (input as { entries: Shown[] }).entries;

function entries(n: number): JudgeEntry[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `row-${i}`,
		text: `Synthetic entry ${i}.`,
		kind: "lasting",
		eventAt: null,
		lastMentionedAt: "2026-01-02T10:00:00.000Z",
		candidates: [],
	}));
}

/** A model that calls every entry it is shown useful and lasting, unless `row` says otherwise. */
function answering(
	row: (shown: Shown) => Record<string, unknown> = () => ({}),
) {
	return vi.fn<CurationModel>(async (_prompt, input) => ({
		verdicts: shownOf(input).map((shown) => ({
			id: shown.id,
			quality: "useful",
			kind: "lasting",
			date: shown.event_date ? "plausible" : "no_date",
			duplicate_of: "none",
			...row(shown),
		})),
	}));
}

function verdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
	return {
		useful: true,
		junkReason: null,
		kind: "lasting",
		date: "no_date",
		duplicateOf: null,
		...over,
	};
}

describe("the quality judge", () => {
	it("asks ten entries a call under short ids and maps the verdicts back", async () => {
		const list = entries(23);
		list[2] = {
			...list[2],
			kind: "temporary",
			eventAt: "2026-01-05T00:00:00.000Z",
			candidates: [
				{ id: "cand-a", text: "Candidate A." },
				{ id: "cand-b", text: "Candidate B." },
			],
		};
		const model = answering((shown) =>
			shown.candidates.length ? { duplicate_of: shown.candidates[1].id } : {},
		);
		const run = await judgeMemoryEntries(list, model);
		expect(QUALITY_JUDGE_BATCH_SIZE).toBe(10);
		expect(model).toHaveBeenCalledTimes(3);
		expect(model.mock.calls.map(([, input]) => shownOf(input).length)).toEqual([
			10, 10, 3,
		]);
		const [prompt, input, , thinking] = model.mock.calls[0];
		expect(prompt).toBe(QUALITY_JUDGE_PROMPT);
		expect(thinking).toBe("off");
		expect(shownOf(input)[0]).toEqual({
			id: "E1",
			text: "Synthetic entry 0.",
			event_date: null,
			said_date: "2026-01-02",
			candidates: [],
		});
		expect(shownOf(input)[2]).toEqual({
			id: "E3",
			text: "Synthetic entry 2.",
			event_date: "2026-01-05",
			said_date: "2026-01-02",
			candidates: [
				{ id: "E3-C1", text: "Candidate A." },
				{ id: "E3-C2", text: "Candidate B." },
			],
		});
		expect(shownOf(model.mock.calls[2][1]).map(({ id }) => id)).toEqual([
			"E1",
			"E2",
			"E3",
		]);
		// The stored kind is never shown, and no real id leaves.
		const sent = JSON.stringify(
			model.mock.calls.map(([, sentInput]) => sentInput),
		);
		expect(sent).not.toMatch(/kind|temporary|lasting|row-|cand-/);
		expect(run).toMatchObject({ batches: 3, failedBatches: 0 });
		expect(run.verdicts.size).toBe(23);
		expect(run.verdicts.get("row-2")).toEqual(
			verdict({ date: "plausible", duplicateOf: "cand-b" }),
		);
		expect(run.verdicts.get("row-22")).toEqual(verdict());
	});

	it("sends a strict schema holding the batch's own ids and candidates", async () => {
		const list = entries(3);
		list[1] = {
			...list[1],
			candidates: [{ id: "cand", text: "A candidate." }],
		};
		const model = answering();
		await judgeMemoryEntries(list, model);
		expect(model.mock.calls[0][2]).toEqual({
			type: "object",
			additionalProperties: false,
			required: ["verdicts"],
			properties: {
				verdicts: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						required: ["id", "quality", "kind", "date", "duplicate_of"],
						properties: {
							id: { type: "string", enum: ["E1", "E2", "E3"] },
							quality: {
								type: "string",
								enum: [
									"useful",
									"request_or_task",
									"assistant_content",
									"small_talk_or_vague",
									"passing_event",
									"not_about_the_person",
									"other_junk",
								],
							},
							kind: {
								type: "string",
								enum: ["lasting", "ongoing", "temporary"],
							},
							date: {
								type: "string",
								enum: ["plausible", "implausible", "no_date"],
							},
							duplicate_of: { type: "string", enum: ["none", "E2-C1"] },
						},
					},
				},
			},
		});
	});

	it("drops rows it cannot use, keeps the first usable answer for an entry, and a dated entry's other answers when its date has none", async () => {
		const list = entries(4);
		list[0] = {
			...list[0],
			eventAt: "2026-01-01T00:00:00.000Z",
			candidates: [{ id: "cand-1", text: "Candidate one." }],
		};
		list[2] = { ...list[2], eventAt: "2026-01-03T00:00:00.000Z" };
		const row = (id: string, over: Record<string, unknown> = {}) => ({
			id,
			quality: "useful",
			kind: "lasting",
			date: "plausible",
			duplicate_of: "none",
			...over,
		});
		const model = vi.fn<CurationModel>(async () => ({
			verdicts: [
				"not an object",
				null,
				["E1"],
				row("E9"),
				row("E1", { duplicate_of: "E1-C1" }),
				row("E1", { quality: "passing_event" }),
				// An undated entry is no_date whatever the answer says.
				row("E2", { kind: "ongoing", date: "implausible" }),
				// A dated entry answered no_date keeps its other answers.
				row("E3", { kind: "temporary", date: "no_date" }),
				row("E4", { quality: "brilliant" }),
				row("E4", { kind: "forever" }),
				// Another entry's candidate.
				row("E4", { duplicate_of: "E1-C1" }),
				row("E4", { quality: "other_junk", kind: "temporary" }),
			],
		}));
		const run = await judgeMemoryEntries(list, model);
		expect(run).toMatchObject({ batches: 1, failedBatches: 0 });
		expect(run.verdicts).toEqual(
			new Map([
				["row-0", verdict({ date: "plausible", duplicateOf: "cand-1" })],
				["row-1", verdict({ kind: "ongoing" })],
				["row-2", verdict({ kind: "temporary", date: "unanswered" })],
				[
					"row-3",
					verdict({ useful: false, junkReason: "other", kind: "temporary" }),
				],
			]),
		);
	});

	it("counts an answer with no usable verdict as a failed batch, so a model that answers empty stops", async () => {
		const empty = vi.fn<CurationModel>(async () => ({ verdicts: [] }));
		expect(await judgeMemoryEntries(entries(60), empty)).toEqual({
			verdicts: new Map(),
			batches: 3,
			failedBatches: 3,
			withdrawn: 0,
		});
		expect(empty).toHaveBeenCalledTimes(3);
		const unusable = vi.fn<CurationModel>(async () => ({
			verdicts: [
				{
					id: "E1",
					quality: "brilliant",
					kind: "lasting",
					date: "no_date",
					duplicate_of: "none",
				},
			],
		}));
		expect(await judgeMemoryEntries(entries(60), unusable)).toMatchObject({
			batches: 3,
			failedBatches: 3,
		});
		expect(unusable).toHaveBeenCalledTimes(3);
	});

	it("counts a batch that fails or cannot be read, never asks it again, and goes on", async () => {
		const script = ["throw", "ok", "nothing", "ok", "text", "ok"];
		let call = 0;
		const ok = answering();
		const model = vi.fn<CurationModel>(async (...args) => {
			const step = script[call++];
			if (step === "throw") throw new Error("gateway down");
			if (step === "nothing") return { nothing: true };
			if (step === "text") return "not json";
			return ok(...args);
		});
		const run = await judgeMemoryEntries(entries(60), model);
		expect(model).toHaveBeenCalledTimes(6);
		expect(run).toMatchObject({ batches: 6, failedBatches: 3 });
		expect(run.verdicts.size).toBe(30);
		expect(run.verdicts.has("row-0")).toBe(false);
		expect(run.verdicts.has("row-10")).toBe(true);
		expect(run.verdicts.has("row-29")).toBe(false);
		expect(run.verdicts.has("row-59")).toBe(true);
	});

	it("stops asking after three failed batches in a row", async () => {
		const model = vi.fn<CurationModel>(async () => {
			throw new Error("gateway down");
		});
		const run = await judgeMemoryEntries(entries(60), model);
		expect(QUALITY_JUDGE_MAX_FAILED_IN_A_ROW).toBe(3);
		expect(model).toHaveBeenCalledTimes(3);
		expect(run).toEqual({
			verdicts: new Map(),
			batches: 3,
			failedBatches: 3,
			withdrawn: 0,
		});
	});

	it("starts no batch once aborted", async () => {
		const controller = new AbortController();
		const ok = answering();
		const model = vi.fn<CurationModel>(async (...args) => {
			controller.abort();
			return ok(...args);
		});
		const run = await judgeMemoryEntries(entries(25), model, {
			signal: controller.signal,
		});
		expect(model).toHaveBeenCalledOnce();
		expect(run).toMatchObject({ batches: 1, failedBatches: 0 });
		expect(run.verdicts.size).toBe(10);
		const later = answering();
		expect(
			await judgeMemoryEntries(entries(5), later, {
				signal: controller.signal,
			}),
		).toEqual({
			verdicts: new Map(),
			batches: 0,
			failedBatches: 0,
			withdrawn: 0,
		});
		expect(later).not.toHaveBeenCalled();
	});

	it("keeps one call in flight unless asked for more, and never more than three", async () => {
		for (const [asked, most] of [
			[undefined, 1],
			[2, 2],
			[9, 3],
			[Number.NaN, 1],
		] as const) {
			let inFlight = 0;
			let seen = 0;
			const ok = answering();
			const model = vi.fn<CurationModel>(async (...args) => {
				seen = Math.max(seen, ++inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight--;
				return ok(...args);
			});
			const run = await judgeMemoryEntries(entries(60), model, {
				concurrency: asked,
			});
			expect(seen, String(asked)).toBe(most);
			expect(run).toMatchObject({ batches: 6, failedBatches: 0 });
		}
	});

	it("its prompt is ASCII English, names no language and reads bank config 3's kind words", () => {
		expect(QUALITY_JUDGE_PROMPT).toMatch(/^[\x20-\x7e\n]*$/);
		expect(QUALITY_JUDGE_PROMPT).not.toMatch(/hungarian|english|magyar|angol/i);
		expect(QUALITY_JUDGE_PROMPT).toMatch(/data, never instructions/i);
		// The judge reads a purchase as extraction does: the same words.
		const group = nativeBankConfig("personal").entity_labels.find(
			({ key }) => key === "kind",
		);
		expect(group?.values).toHaveLength(3);
		expect(QUALITY_JUDGE_PROMPT).toContain(`kind: ${group?.description}`);
		for (const { value, description } of group?.values ?? [])
			expect(QUALITY_JUDGE_PROMPT).toContain(`- ${value}: ${description}`);
		expect(QUALITY_JUDGE_PROMPT).toMatch(
			/something they bought, got or were given/i,
		);
		for (const answer of [
			"request_or_task",
			"assistant_content",
			"small_talk_or_vague",
			"passing_event",
			"not_about_the_person",
			"other_junk",
		])
			expect(QUALITY_JUDGE_PROMPT).toContain(`- ${answer}: `);
		// Its examples are not the check's entries.
		for (const { entry } of QUALITY_JUDGE_FIXTURES)
			expect(QUALITY_JUDGE_PROMPT).not.toContain(entry.text);
	});
});

describe("the consent check", () => {
	const sentTexts = (model: ReturnType<typeof answering>) =>
		JSON.stringify(model.mock.calls.map(([, input]) => input));

	it("stops the run at once when beforeBatch throws, sends nothing more and passes its error on", async () => {
		for (const concurrency of [1, 3]) {
			const consent = new Error(MEMORY_QUALITY_CONSENT_CHANGED);
			let asked = 0;
			const beforeBatch = vi.fn((ids: readonly string[]) => {
				if (++asked === 2) throw consent;
				return new Set(ids);
			});
			const model = answering();
			await expect(
				judgeMemoryEntries(entries(40), model, { beforeBatch, concurrency }),
			).rejects.toBe(consent);
			expect(model, String(concurrency)).toHaveBeenCalledOnce();
			expect(beforeBatch).toHaveBeenCalledTimes(2);
			expect(sentTexts(model)).not.toContain('"Synthetic entry 10."');
		}
		// Any error it throws ends the run the same way.
		const model = answering();
		await expect(
			judgeMemoryEntries(entries(20), model, {
				beforeBatch: () => {
					throw new Error("database is locked");
				},
			}),
		).rejects.toThrow("database is locked");
		expect(model).not.toHaveBeenCalled();
	});

	it("never sends a withdrawn entry or candidate, renumbers the rest and counts the entries as withdrawn", async () => {
		const list = entries(25);
		list[1] = {
			...list[1],
			candidates: [
				{ id: "row-0", text: "Synthetic entry 0." },
				{ id: "row-15", text: "Synthetic entry 15." },
			],
		};
		// row-0 is withdrawn, and so is the whole third batch.
		const beforeBatch = vi.fn(
			(ids: readonly string[]) =>
				new Set(ids.filter((id) => id !== "row-0" && !/^row-2[0-4]$/.test(id))),
		);
		const model = answering();
		const run = await judgeMemoryEntries(list, model, { beforeBatch });
		// Each batch asks once, about its entries and then their candidates.
		expect(beforeBatch).toHaveBeenCalledTimes(3);
		expect(beforeBatch.mock.calls[0][0]).toEqual([
			...Array.from({ length: 10 }, (_, i) => `row-${i}`),
			"row-15",
		]);
		// A batch with nothing left is not sent.
		expect(model).toHaveBeenCalledTimes(2);
		const first = shownOf(model.mock.calls[0][1]);
		expect(first.map(({ id }) => id)).toEqual(
			Array.from({ length: 9 }, (_, i) => `E${i + 1}`),
		);
		expect(first[0]).toMatchObject({
			id: "E1",
			text: "Synthetic entry 1.",
			candidates: [{ id: "E1-C1", text: "Synthetic entry 15." }],
		});
		const sent = sentTexts(model);
		expect(sent).not.toContain('"Synthetic entry 0."');
		for (let i = 20; i < 25; i++)
			expect(sent).not.toContain(`"Synthetic entry ${i}."`);
		expect(run).toMatchObject({ batches: 2, failedBatches: 0, withdrawn: 6 });
		expect(run.verdicts.size).toBe(19);
		expect(run.verdicts.has("row-0")).toBe(false);
		expect(judgeTotals(list, run)).toMatchObject({
			entries: 25,
			judged: 19,
			withdrawn: 6,
			notJudged: 0,
		});
	});

	it("passes on a consent error thrown inside a model call instead of counting a failed batch", async () => {
		const consent = new Error(MEMORY_QUALITY_CONSENT_CHANGED);
		const plain = vi.fn<CurationModel>(async () => {
			throw consent;
		});
		await expect(judgeMemoryEntries(entries(30), plain)).rejects.toBe(consent);
		expect(plain).toHaveBeenCalledOnce();
		// As the AI SDK may wrap it: a retry keeps each attempt's error, others a cause.
		for (const wrapped of [
			Object.assign(
				new Error(
					`Failed after 2 attempts with non-retryable error: '${MEMORY_QUALITY_CONSENT_CHANGED}'`,
				),
				{
					errors: [new Error("Cannot connect to API: socket hang up"), consent],
				},
			),
			new Error("request failed", { cause: consent }),
		]) {
			const model = vi.fn<CurationModel>(async () => {
				throw wrapped;
			});
			await expect(judgeMemoryEntries(entries(30), model)).rejects.toBe(
				consent,
			);
			expect(model).toHaveBeenCalledOnce();
		}
		// Only that exact message: anything else is an ordinary failed batch.
		const other = vi.fn<CurationModel>(async () => {
			throw new Error(`upstream: ${MEMORY_QUALITY_CONSENT_CHANGED} maybe`);
		});
		expect(await judgeMemoryEntries(entries(30), other)).toMatchObject({
			batches: 3,
			failedBatches: 3,
		});
	});
});

describe("duplicate candidates", () => {
	it("are the two other entries sharing the most words, above 0.3, ties to the earlier", () => {
		const bank = [
			{ id: "a", text: "alpha beta gamma delta" },
			// 0.8 with a.
			{ id: "b", text: "alpha beta gamma delta epsilon" },
			// 0.5 with a.
			{ id: "c", text: "alpha beta gamma zeta eta" },
			// The same words as a, in other cases and with punctuation.
			{ id: "d", text: "Alpha, BETA; gamma delta!" },
			// 2 of 7 with a and d: 0.29.
			{ id: "e", text: "alpha beta theta iota kappa" },
		];
		const ids = (id: string) =>
			duplicateCandidates(bank)
				.get(id)
				?.map((candidate) => candidate.id);
		expect(ids("a")).toEqual(["d", "b"]);
		expect(ids("b")).toEqual(["a", "d"]);
		expect(ids("c")).toEqual(["a", "d"]);
		expect(ids("d")).toEqual(["a", "b"]);
		expect(ids("e")).toEqual([]);
		expect(duplicateCandidates(bank).get("a")?.[0]).toEqual({
			id: "d",
			text: "Alpha, BETA; gamma delta!",
		});
	});

	it("leaves out a pair at exactly 0.3 and reads accented words whole", () => {
		const atThreshold = duplicateCandidates([
			{ id: "f", text: "one two three four five six" },
			{ id: "g", text: "one two three seven eight nine ten" },
		]);
		expect([...atThreshold.values()]).toEqual([[], []]);
		const accented = duplicateCandidates([
			{ id: "upper", text: "Mazsola ÉS Bors" },
			// The same words with the accent as a combining mark.
			{ id: "combining", text: "mazsola és bors" },
			{ id: "other", text: "mazsola es bors" },
		]);
		expect(accented.get("upper")?.map(({ id }) => id)).toEqual([
			"combining",
			"other",
		]);
		expect(accented.get("other")?.map(({ id }) => id)).toEqual([
			"upper",
			"combining",
		]);
	});

	/** Same seed, same bank: a run is never luckier than the last. */
	function seeded(seed: number) {
		let state = seed;
		return () => {
			state = (state * 1103515245 + 12345) % 2147483648;
			return state / 2147483648;
		};
	}

	function bank(size: number, vocabulary: number, seed: number) {
		const random = seeded(seed);
		const text = (min: number, spread: number) =>
			Array.from(
				{ length: min + Math.floor(random() * spread) },
				() => `w${Math.floor(random() * vocabulary)}`,
			).join(" ");
		// Now and then an entry with no word at all.
		const list = Array.from({ length: size }, (_, i) => ({
			id: `e${i}`,
			text: i % 37 === 5 ? "?!" : `The user ${text(1, 18)}`,
		}));
		// Near repeats, so there are candidates to find.
		for (let i = 0; i + 1 < size; i += 10)
			list[i + 1] = { id: `e${i + 1}`, text: `${list[i].text} again` };
		return list;
	}

	/** Every pair compared, sorted in full: slow and plainly right. */
	function everyPair(entries: ReadonlyArray<{ id: string; text: string }>) {
		const words = entries.map(
			({ text }) =>
				new Set(
					text
						.normalize("NFC")
						.toLowerCase()
						.match(/[\p{L}\p{M}\p{N}]+/gu),
				),
		);
		return new Map(
			entries.map((entry, i) => [
				entry.id,
				entries
					.flatMap((_, j) => {
						const a = words[i];
						const b = words[j];
						if (j === i || !a.size || !b.size) return [];
						let shared = 0;
						for (const word of a) if (b.has(word)) shared++;
						const score = shared / (a.size + b.size - shared);
						return score > 0.3 ? [{ j, score }] : [];
					})
					.sort((x, y) => y.score - x.score || x.j - y.j)
					.slice(0, 2)
					.map(({ j }) => ({ id: entries[j].id, text: entries[j].text })),
			]),
		);
	}

	it("are the ones comparing every pair finds, ties and all", () => {
		// A small vocabulary: many pairs pass, many tie, sizes from 3 to 20 words.
		for (const seed of [1, 2, 3]) {
			const small = bank(400, 25, seed);
			expect(duplicateCandidates(small)).toEqual(everyPair(small));
		}
	});

	it("take a few seconds at most for 3,000 entries", () => {
		const large = bank(3000, 600, 7);
		const started = performance.now();
		const candidates = duplicateCandidates(large);
		const elapsed = performance.now() - started;
		expect(candidates.size).toBe(3000);
		expect(candidates.get("e0")?.map(({ id }) => id)).toContain("e1");
		expect(elapsed).toBeLessThan(5000);
	});
});

describe("the entries a judge reads", () => {
	let h: EngineHarness;
	beforeEach(async () => {
		h = await bootEngine("memory-quality-judge");
	});
	afterEach(() => h.cleanup());

	const NOW = new Date("2026-11-24T12:00:00Z");
	const CATS = "The user keeps two cats named Mazsola and Bors.";
	const CATS_AGAIN = "The user keeps two cats called Mazsola and Bors at home.";
	const NURSE = "The user works as a nurse in Szeged.";

	it("are every ready bank's entries as the page shows them, with event dates and same-bank candidates", async () => {
		const { db } = await import("$lib/server/db");
		const s = await import("$lib/server/db/schema");
		db.insert(s.projects)
			.values([
				{ id: "garden", userId: h.userId, name: "Garden" },
				{ id: "old", userId: h.userId, name: "Old" },
			])
			.run();
		const personal = await seedSubjectEntries(h.userId, { kind: "personal" }, [
			{
				id: "cats",
				text: CATS,
				said: "2026-11-20",
				kind: "lasting",
				subject: "home_family",
			},
			{
				id: "again",
				text: CATS_AGAIN,
				said: "2026-11-10",
				kind: null,
				subject: null,
			},
			{
				id: "nurse",
				text: NURSE,
				said: "2026-11-01",
				kind: "temporary",
				subject: "work_study",
			},
		]);
		// The same words in another bank are never a candidate.
		const garden = await seedSubjectEntries(
			h.userId,
			{ kind: "project", projectId: "garden" },
			[
				{
					id: "cats",
					text: CATS,
					said: "2026-11-15",
					kind: "lasting",
					subject: "people",
				},
			],
		);
		const old = await seedSubjectEntries(
			h.userId,
			{ kind: "project", projectId: "old" },
			[
				{
					id: "gone",
					text: "A retired bank's entry.",
					said: "2026-11-15",
					kind: "lasting",
					subject: "other",
				},
			],
		);
		db.update(s.memoryBanks)
			.set({ status: "retired" })
			.where(eq(s.memoryBanks.id, old.id))
			.run();
		const eventAt = (factId: string, at: string) =>
			db
				.update(s.memoryFactLabels)
				.set({ eventAt: new Date(at) })
				.where(
					and(
						eq(s.memoryFactLabels.bankId, personal.id),
						eq(s.memoryFactLabels.nativeFactId, factId),
					),
				)
				.run();
		eventAt("f-cats", "2026-01-01T00:00:00Z");
		eventAt("f-nurse", "2026-03-01T00:00:00Z");
		// The cats entry rests on the nurse's fact too: its date is the later one,
		// though that fact comes first.
		const facts = [
			{ id: "f-nurse", text: "Synthetic fact nurse" },
			{ id: "f-cats", text: "Synthetic fact cats" },
		];
		db.update(s.memoryPublishedRows)
			.set({
				sourceIdsJson: JSON.stringify(facts.map(({ id }) => id)),
				sourceFingerprintsJson: JSON.stringify(facts),
			})
			.where(eq(s.memoryPublishedRows.id, `r-${personal.id}-cats`))
			.run();

		const { judgeEntriesFor } = await import("./quality-judge");
		const { readScopeEntries } = await import("./subject-read");
		const page = readScopeEntries(h.userId, { kind: "personal" }, NOW).entries;
		const gardenPage = readScopeEntries(
			h.userId,
			{ kind: "project", projectId: "garden" },
			NOW,
		).entries;
		expect(page.map(({ text }) => text)).toEqual([CATS, CATS_AGAIN, NURSE]);
		const said = (at: number) => page[at].lastMentionedAt;
		expect(judgeEntriesFor(h.userId, NOW)).toEqual([
			{
				id: `r-${personal.id}-cats`,
				text: CATS,
				kind: "lasting",
				eventAt: "2026-03-01T00:00:00.000Z",
				lastMentionedAt: said(0),
				candidates: [{ id: `r-${personal.id}-again`, text: CATS_AGAIN }],
			},
			{
				id: `r-${personal.id}-again`,
				text: CATS_AGAIN,
				kind: null,
				eventAt: null,
				lastMentionedAt: said(1),
				candidates: [{ id: `r-${personal.id}-cats`, text: CATS }],
			},
			{
				id: `r-${personal.id}-nurse`,
				text: NURSE,
				kind: "temporary",
				eventAt: "2026-03-01T00:00:00.000Z",
				lastMentionedAt: said(2),
				candidates: [],
			},
			{
				id: `r-${garden.id}-cats`,
				text: CATS,
				kind: "lasting",
				eventAt: null,
				lastMentionedAt: gardenPage[0].lastMentionedAt,
				candidates: [],
			},
		]);
		expect(said(0)).not.toBeNull();
	});

	it("are none when Memory is off", async () => {
		await seedSubjectEntries(h.userId, { kind: "personal" }, [
			{
				id: "cats",
				text: CATS,
				said: "2026-11-20",
				kind: "lasting",
				subject: "home_family",
			},
		]);
		const { judgeEntriesFor } = await import("./quality-judge");
		expect(judgeEntriesFor(h.userId, NOW)).toHaveLength(1);
		const { db } = await import("$lib/server/db");
		const { users } = await import("$lib/server/db/schema");
		db.update(users).set({ memoryEnabled: false }).run();
		expect(judgeEntriesFor(h.userId, NOW)).toEqual([]);
	});

	// Every transaction takes the write lock (db/write-lock.ts): the read opens
	// only the ones the page's own read opens, and reads rows and labels plainly.
	it("open no transaction beside the page's own", async () => {
		const { db } = await import("$lib/server/db");
		const s = await import("$lib/server/db/schema");
		db.insert(s.projects)
			.values({ id: "garden", userId: h.userId, name: "Garden" })
			.run();
		await seedSubjectEntries(h.userId, { kind: "personal" }, [
			{
				id: "cats",
				text: CATS,
				said: "2026-11-20",
				kind: "lasting",
				subject: "home_family",
			},
			{
				id: "nurse",
				text: NURSE,
				said: "2026-11-01",
				kind: "temporary",
				subject: "work_study",
			},
		]);
		await seedSubjectEntries(
			h.userId,
			{ kind: "project", projectId: "garden" },
			[
				{
					id: "cats",
					text: CATS,
					said: "2026-11-15",
					kind: "lasting",
					subject: "people",
				},
			],
		);
		const { judgeEntriesFor } = await import("./quality-judge");
		const { readScopeEntries } = await import("./subject-read");
		const transaction = vi.spyOn(db, "transaction");
		readScopeEntries(h.userId, { kind: "personal" }, NOW);
		readScopeEntries(h.userId, { kind: "project", projectId: "garden" }, NOW);
		const pageOnly = transaction.mock.calls.length;
		transaction.mockClear();
		expect(judgeEntriesFor(h.userId, NOW)).toHaveLength(3);
		expect(pageOnly).toBeGreaterThan(0);
		expect(transaction).toHaveBeenCalledTimes(pageOnly);
		transaction.mockRestore();
	});
});

describe("the totals", () => {
	const MARKER = "ZEBRAQUARTZ";
	const entry = (id: string, kind: MemoryKind | null): JudgeEntry => ({
		id,
		text: `${MARKER} private entry text ${id}`,
		kind,
		eventAt: null,
		lastMentionedAt: null,
		candidates: [{ id: `cand-of-${id}`, text: `${MARKER} candidate text` }],
	});
	const list = [
		// Shown no candidate.
		{ ...entry("id-a", "lasting"), candidates: [] },
		entry("id-b", "temporary"),
		entry("id-c", "temporary"),
		entry("id-d", null),
		entry("id-e", "ongoing"),
		entry("id-f", "ongoing"),
		entry("id-g", "lasting"),
		entry("id-h", "lasting"),
		entry("id-i", "lasting"),
	];
	const run: JudgeRun = {
		batches: 2,
		failedBatches: 1,
		// One entry the consent check withdrew: not part of not judged.
		withdrawn: 1,
		verdicts: new Map([
			["id-a", verdict()],
			["id-b", verdict({ date: "plausible" })],
			[
				"id-c",
				verdict({
					useful: false,
					junkReason: "passing_event",
					kind: "temporary",
					date: "plausible",
				}),
			],
			[
				"id-d",
				verdict({
					useful: false,
					junkReason: "request_or_task",
					kind: "temporary",
				}),
			],
			// One pair, said from both sides.
			[
				"id-e",
				verdict({ kind: "ongoing", date: "implausible", duplicateOf: "id-f" }),
			],
			["id-f", verdict({ kind: "ongoing", duplicateOf: "id-e" })],
			// A repeat of an entry the run did not judge; dated, with no date verdict.
			["id-g", verdict({ duplicateOf: "id-h", date: "unanswered" })],
			// Not among the entries: left out.
			["id-stray", verdict({ useful: false, junkReason: "other" })],
		]),
	};

	it("count each answer, by stored kind, with the kind confusion and the repeats", () => {
		expect(judgeTotals(list, run)).toEqual({
			entries: 9,
			judged: 7,
			notJudged: 1,
			withdrawn: 1,
			batches: 2,
			failedBatches: 1,
			useful: 5,
			junk: 2,
			junkShare: 0.286,
			junkByReason: {
				request_or_task: 1,
				assistant_content: 0,
				small_talk_or_vague: 0,
				passing_event: 1,
				not_about_the_person: 0,
				other: 0,
			},
			byStoredKind: {
				lasting: { judged: 2, useful: 2, junk: 0 },
				ongoing: { judged: 2, useful: 2, junk: 0 },
				temporary: { judged: 2, useful: 1, junk: 1 },
				unlabelled: { judged: 1, useful: 0, junk: 1 },
			},
			kind: {
				labelled: 6,
				agree: 5,
				agreement: 0.833,
				usefulLabelled: 5,
				usefulAgree: 4,
				usefulAgreement: 0.8,
				confusion: {
					lasting: { lasting: 2, ongoing: 0, temporary: 0 },
					ongoing: { lasting: 0, ongoing: 2, temporary: 0 },
					temporary: { lasting: 1, ongoing: 0, temporary: 1 },
					unlabelled: { lasting: 0, ongoing: 0, temporary: 1 },
				},
			},
			date: {
				plausible: 2,
				implausible: 1,
				noDate: 3,
				unanswered: 1,
				implausibleShare: 0.333,
			},
			duplicates: {
				withCandidates: 6,
				flagged: 3,
				pairs: 2,
				redundant: 2,
				redundantShare: 0.286,
			},
		});
	});

	it("carry no text, no marker word and no id", () => {
		const json = JSON.stringify(judgeTotals(list, run));
		expect(json).not.toContain(MARKER);
		expect(json).not.toMatch(/private|candidate text|id-|cand-of|stray/);
		for (const { id, text, candidates } of list) {
			expect(json).not.toContain(id);
			expect(json).not.toContain(text);
			for (const candidate of candidates)
				expect(json).not.toContain(candidate.id);
		}
	});

	it("are zero shares of nothing when nothing was judged", () => {
		const totals = judgeTotals(list, {
			verdicts: new Map(),
			batches: 1,
			failedBatches: 1,
			withdrawn: 0,
		});
		expect(totals).toMatchObject({
			judged: 0,
			notJudged: 9,
			junkShare: null,
			kind: { agreement: null, usefulAgreement: null },
			date: { implausibleShare: null },
			duplicates: { withCandidates: 0, redundant: 0, redundantShare: null },
		});
	});
});

describe("the agreement with a synthetic set", () => {
	const fixture = (
		name: string,
		expected: JudgeVerdict,
		entry: Partial<JudgeEntry> = {},
		lenient?: JudgeQuestion[],
	): JudgeFixture => ({
		name,
		language: "en",
		entry: {
			id: name,
			text: name,
			kind: null,
			eventAt: null,
			lastMentionedAt: null,
			candidates: [],
			...entry,
		},
		expect: expected,
		...(lenient ? { lenient } : {}),
	});

	it("counts each question where it applies, all and clear, with the confusion and the misses", () => {
		const fixtures = [
			fixture("one", verdict()),
			fixture(
				"two",
				verdict({
					useful: false,
					junkReason: "passing_event",
					kind: "temporary",
					date: "plausible",
				}),
				{ eventAt: "2025-01-01T00:00:00.000Z" },
				["kind"],
			),
			fixture("three", verdict({ duplicateOf: "c3" }), {
				candidates: [{ id: "c3", text: "c" }],
			}),
			fixture("four", verdict()),
			fixture("five", verdict({ date: "plausible" }), {
				eventAt: "2025-02-01T00:00:00.000Z",
			}),
		];
		const agreement = judgeAgreement(fixtures, {
			batches: 1,
			failedBatches: 0,
			withdrawn: 0,
			verdicts: new Map([
				["one", verdict()],
				[
					"two",
					verdict({
						useful: false,
						junkReason: "request_or_task",
						kind: "lasting",
						date: "plausible",
					}),
				],
				["three", verdict()],
				// Dated, and the model gave no date verdict: a date miss.
				["five", verdict({ date: "unanswered" })],
			]),
		});
		expect(agreement).toEqual({
			fixtures: 5,
			judged: 4,
			questions: {
				useful: {
					all: { matched: 4, of: 4, share: 1 },
					clear: { matched: 4, of: 4, share: 1 },
				},
				junkReason: {
					all: { matched: 0, of: 1, share: 0 },
					clear: { matched: 0, of: 1, share: 0 },
				},
				kind: {
					all: { matched: 3, of: 4, share: 0.75 },
					clear: { matched: 3, of: 3, share: 1 },
				},
				date: {
					all: { matched: 1, of: 2, share: 0.5 },
					clear: { matched: 1, of: 2, share: 0.5 },
				},
				duplicateOf: {
					all: { matched: 0, of: 1, share: 0 },
					clear: { matched: 0, of: 1, share: 0 },
				},
			},
			dateUnanswered: 1,
			useful: {
				usefulAsUseful: 3,
				usefulAsJunk: 0,
				junkAsUseful: 0,
				junkAsJunk: 1,
			},
			misses: [
				{
					name: "two",
					question: "junkReason",
					expected: "passing_event",
					judged: "request_or_task",
					lenient: false,
				},
				{
					name: "two",
					question: "kind",
					expected: "temporary",
					judged: "lasting",
					lenient: true,
				},
				{
					name: "three",
					question: "duplicateOf",
					expected: "c3",
					judged: "null",
					lenient: false,
				},
				{
					name: "five",
					question: "date",
					expected: "plausible",
					judged: "unanswered",
					lenient: false,
				},
			],
		});
	});
});

describe("the synthetic set", () => {
	const set = QUALITY_JUDGE_FIXTURES;

	it("covers every junk reason in both languages, every kind, each date answer and true and false repeats", () => {
		const english = set.filter(({ language }) => language === "en");
		const hungarian = set.filter(({ language }) => language === "hu");
		expect(set.length).toBeGreaterThanOrEqual(40);
		expect(english.length).toBe(hungarian.length);
		for (const [language, fixtures] of [
			["en", english],
			["hu", hungarian],
		] as const) {
			for (const reason of JUDGE_JUNK_REASONS)
				expect(
					fixtures.some(({ expect: answer }) => answer.junkReason === reason),
					`${language} ${reason}`,
				).toBe(true);
			for (const kind of MEMORY_KINDS)
				expect(
					fixtures.some(
						({ expect: answer }) => answer.useful && answer.kind === kind,
					),
					`${language} ${kind}`,
				).toBe(true);
			for (const date of ["plausible", "implausible", "no_date"])
				expect(
					fixtures.some(({ expect: answer }) => answer.date === date),
					`${language} ${date}`,
				).toBe(true);
			expect(fixtures.some(({ expect: answer }) => answer.duplicateOf)).toBe(
				true,
			);
			expect(
				fixtures.some(
					({ entry, expect: answer }) =>
						entry.candidates.length && !answer.duplicateOf,
				),
			).toBe(true);
		}
		expect(set.some(({ lenient }) => lenient?.length)).toBe(true);
	});

	it("holds only answers a verdict can give", () => {
		expect(new Set(set.map(({ name }) => name)).size).toBe(set.length);
		expect(new Set(set.map(({ entry }) => entry.text)).size).toBe(set.length);
		for (const { name, entry, expect: answer } of set) {
			expect(entry.id, name).toBe(name);
			expect(answer.junkReason === null, name).toBe(answer.useful);
			expect(answer.date === "no_date", name).toBe(entry.eventAt === null);
			// A known answer is a verdict, never the lack of one.
			expect(answer.date, name).not.toBe("unanswered");
			expect(entry.candidates.length, name).toBeLessThanOrEqual(2);
			if (answer.duplicateOf)
				expect(
					entry.candidates.map(({ id }) => id),
					name,
				).toContain(answer.duplicateOf);
		}
	});

	it("agrees on every question with a model that gives every expected answer", async () => {
		const byText = new Map(set.map((item) => [item.entry.text, item]));
		const oracle = vi.fn<CurationModel>(async (_prompt, input) => ({
			verdicts: shownOf(input).map((shown) => {
				const item = byText.get(shown.text);
				if (!item) throw new Error("an entry the set does not hold");
				const repeat = item.entry.candidates.findIndex(
					({ id }) => id === item.expect.duplicateOf,
				);
				return {
					id: shown.id,
					quality: item.expect.useful
						? "useful"
						: item.expect.junkReason === "other"
							? "other_junk"
							: item.expect.junkReason,
					kind: item.expect.kind,
					date: item.expect.date,
					duplicate_of: repeat < 0 ? "none" : shown.candidates[repeat].id,
				};
			}),
		}));
		const run = await judgeMemoryEntries(
			set.map(({ entry }) => entry),
			oracle,
		);
		const agreement = judgeAgreement(set, run);
		expect(agreement.judged).toBe(set.length);
		expect(agreement.misses).toEqual([]);
		for (const { all, clear } of Object.values(agreement.questions)) {
			expect(all.share).toBe(1);
			expect(clear.share).toBe(1);
		}
		const totals = judgeTotals(
			set.map(({ entry }) => entry),
			run,
		);
		expect(totals.useful).toBe(
			set.filter(({ expect: answer }) => answer.useful).length,
		);
		expect(totals.duplicates.flagged).toBe(
			set.filter(({ expect: answer }) => answer.duplicateOf).length,
		);
	});
});
