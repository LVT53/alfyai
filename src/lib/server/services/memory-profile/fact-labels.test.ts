import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import type { NativeMemory } from "./contracts";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-labels");
});
afterEach(() => h.cleanup());

async function fixture() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const revisions = await import("./revisions");
	const labels = await import("./fact-labels");
	const bank = revisions.ensureMemoryBank(h.userId, { kind: "personal" });
	const fact = (
		id: string,
		tags: string[] | undefined,
		occurred: { start?: string | null; end?: string | null } = {},
	): NativeMemory => ({
		id,
		text: `Fact ${id}`,
		fact_type: "world",
		consolidated_at: "2026-11-01T00:00:00Z",
		...(tags ? { tags } : {}),
		occurred_start: occurred.start ?? null,
		occurred_end: occurred.end ?? null,
	});
	const observation: NativeMemory = {
		id: "o1",
		text: "Observation",
		fact_type: "observation",
		tags: ["kind:temporary"],
	};
	const record = (memories: NativeMemory[]) =>
		db.transaction((tx) =>
			labels.recordNativeFactLabels(tx, bank.id, "personal", memories),
		);
	const read = () => labels.readFactLabels(db, bank.id);
	return { db, schema, bank, labels, fact, observation, record, read };
}

describe("labels from a fact's tags", () => {
	it("keeps only known labels for the bank's kind", async () => {
		const { labels } = await import("./fact-labels").then((labels) => ({
			labels,
		}));
		expect(
			labels.labelsFromNativeTags(
				["src-1", "kind:temporary", "subject:health"],
				"personal",
			),
		).toEqual({ kind: "temporary", subject: "health" });
		// Hindsight checks a label against its list without regard to case.
		for (const tags of [
			["kind:Lasting", "subject:Health"],
			["kind: lasting", "subject:health "],
		])
			expect(labels.labelsFromNativeTags(tags, "personal")).toEqual({
				kind: "lasting",
				subject: "health",
			});
		for (const tags of [
			["kind:forever", "subject:pets"],
			["subject:goals_decisions"],
			["kindlasting", "health"],
			[],
			undefined,
		])
			expect(labels.labelsFromNativeTags(tags, "personal")).toEqual({
				kind: null,
				subject: null,
			});
		expect(
			labels.labelsFromNativeTags(
				["kind:lasting", "subject:goals_decisions"],
				"project",
			),
		).toEqual({ kind: "lasting", subject: "goals_decisions" });
		expect(
			labels.labelsFromNativeTags(["subject:health"], "project").subject,
		).toBeNull();
	});

	it("takes the first known value when a fact carries two of a group", async () => {
		const labels = await import("./fact-labels");
		expect(
			labels.labelsFromNativeTags(
				["kind:bogus", "kind:ongoing", "kind:temporary"],
				"personal",
			).kind,
		).toBe("ongoing");
	});
});

describe("the fact label store", () => {
	it("records a published fact's labels and event date, and only raw facts", async () => {
		const f = await fixture();
		f.record([
			f.fact("a", ["kind:temporary", "subject:work_study"], {
				start: "2027-01-14T09:00:00+00:00",
				end: "2027-01-14T11:00:00+00:00",
			}),
			f.fact("b", ["kind:lasting"], { start: "2020-05-01T00:00:00Z" }),
			f.fact("c", undefined),
			f.observation,
		]);
		const stored = f.read();
		expect(stored.get("a")).toEqual({
			kind: "temporary",
			subject: "work_study",
			eventAt: "2027-01-14T11:00:00.000Z",
			origin: "extraction",
		});
		expect(stored.get("b")).toEqual({
			kind: "lasting",
			subject: null,
			eventAt: "2020-05-01T00:00:00.000Z",
			origin: "extraction",
		});
		expect(stored.get("c")).toEqual({
			kind: null,
			subject: null,
			eventAt: null,
			origin: "extraction",
		});
		expect(stored.has("o1")).toBe(false);
	});

	it("keeps a classifier's labels when the fact is published again", async () => {
		const f = await fixture();
		f.record([f.fact("a", undefined, { start: "2026-12-01T00:00:00Z" })]);
		f.db.transaction((tx) =>
			f.labels.recordClassifiedFactLabels(
				tx,
				f.bank.id,
				new Map([["a", { kind: "ongoing", subject: "projects" }]]),
			),
		);
		f.record([
			f.fact("a", ["kind:temporary", "subject:health"], {
				start: "2026-12-02T00:00:00Z",
			}),
		]);
		expect(f.read().get("a")).toEqual({
			kind: "ongoing",
			subject: "projects",
			eventAt: "2026-12-02T00:00:00.000Z",
			origin: "classifier",
		});
	});

	it("a classifier writes a fact the store has not seen, and keeps the event date it has", async () => {
		const f = await fixture();
		f.record([f.fact("a", undefined, { start: "2026-12-01T00:00:00Z" })]);
		f.db.transaction((tx) =>
			f.labels.recordClassifiedFactLabels(
				tx,
				f.bank.id,
				new Map([
					["a", { kind: "temporary", subject: "health" }],
					["new", { kind: "lasting", subject: "about_you" }],
				]),
			),
		);
		expect(f.read().get("a")).toMatchObject({
			kind: "temporary",
			eventAt: "2026-12-01T00:00:00.000Z",
			origin: "classifier",
		});
		expect(f.read().get("new")).toEqual({
			kind: "lasting",
			subject: "about_you",
			eventAt: null,
			origin: "classifier",
		});
	});

	it("removes labels of facts gone from the snapshot", async () => {
		const f = await fixture();
		f.record([f.fact("a", ["kind:lasting"]), f.fact("b", ["kind:ongoing"])]);
		f.record([f.fact("b", ["kind:ongoing"])]);
		expect([...f.read().keys()]).toEqual(["b"]);
	});

	it("reads a stored value off the lists as no label", async () => {
		const f = await fixture();
		f.db
			.insert(f.schema.memoryFactLabels)
			.values({
				bankId: f.bank.id,
				nativeFactId: "odd",
				kind: "forever",
				subject: "pets",
				origin: "classifier",
			})
			.run();
		expect(f.read().get("odd")).toEqual({
			kind: null,
			subject: null,
			eventAt: null,
			origin: "classifier",
		});
	});

	it("labels go with their bank", async () => {
		const f = await fixture();
		f.record([f.fact("a", ["kind:lasting"])]);
		const { eq } = await import("drizzle-orm");
		f.db
			.delete(f.schema.memoryBanks)
			.where(eq(f.schema.memoryBanks.id, f.bank.id))
			.run();
		expect(f.db.select().from(f.schema.memoryFactLabels).all()).toEqual([]);
	});
});

describe("an entry's labels", () => {
	const labels = (
		rows: Record<
			string,
			{ kind?: string | null; subject?: string | null; eventAt?: string | null }
		>,
	) =>
		new Map(
			Object.entries(rows).map(([id, row]) => [
				id,
				{
					kind: (row.kind ?? null) as never,
					subject: (row.subject ?? null) as never,
					eventAt: row.eventAt ?? null,
					origin: "extraction" as const,
				},
			]),
		);

	it("takes the newest fact's labels, each group on its own", async () => {
		const { entryLabels } = await import("./fact-labels");
		expect(
			entryLabels(
				[
					{ id: "old", saidAtMs: 1_000, authored: false },
					{ id: "new", saidAtMs: 2_000, authored: false },
					{ id: "newest", saidAtMs: 3_000, authored: false },
				],
				labels({
					old: {
						kind: "temporary",
						subject: "health",
						eventAt: "2027-01-01T00:00:00.000Z",
					},
					new: { kind: "lasting", subject: "home_family" },
					newest: {
						subject: null,
						kind: null,
						eventAt: "2026-02-01T00:00:00.000Z",
					},
				}),
			),
		).toEqual({
			kind: "lasting",
			subject: "home_family",
			eventAt: "2027-01-01T00:00:00.000Z",
			authored: false,
		});
	});

	it("breaks a tie by fact id, so the answer never depends on order", async () => {
		const { entryLabels } = await import("./fact-labels");
		const rows = labels({ a: { kind: "temporary" }, b: { kind: "ongoing" } });
		const facts = [
			{ id: "a", saidAtMs: 5, authored: false },
			{ id: "b", saidAtMs: 5, authored: false },
		];
		expect(entryLabels(facts, rows).kind).toBe(
			entryLabels([...facts].reverse(), rows).kind,
		);
	});

	it("is unlabelled with no labelled fact, and authored when any fact is", async () => {
		const { entryLabels } = await import("./fact-labels");
		expect(
			entryLabels(
				[
					{ id: "x", saidAtMs: 1, authored: false },
					{ id: "y", saidAtMs: 2, authored: true },
				],
				new Map(),
			),
		).toEqual({ kind: null, subject: null, eventAt: null, authored: true });
	});

	it("knows the person's own sources", async () => {
		const { isAuthoredMemorySource } = await import("./fact-labels");
		expect(isAuthoredMemorySource({ eventId: "manual:a1", context: "" })).toBe(
			true,
		);
		expect(
			isAuthoredMemorySource({
				eventId: "authored-legacy",
				context: JSON.stringify({ migrationAuthoredId: "x" }),
			}),
		).toBe(true);
		expect(
			isAuthoredMemorySource({ eventId: "message:m1:h", context: "{}" }),
		).toBe(false);
		expect(
			isAuthoredMemorySource({ eventId: "message:m1:h", context: "not json" }),
		).toBe(false);
	});
});
