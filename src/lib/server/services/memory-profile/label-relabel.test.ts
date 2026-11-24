import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryKind, MemorySubject } from "$lib/memory-types";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import type { NativeMemory } from "./contracts";
import type { CurationModel } from "./curation";

// The default model is the admission-gated memory path; tests that hand the
// relabel no model of their own see which admission it asked for.
const curationCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("./curation", async (importOriginal) => ({
	...(await importOriginal<typeof import("./curation")>()),
	createCurationModel: (...args: unknown[]) => {
		curationCalls.push(args);
		return (async (_prompt: string, input: unknown) =>
			answer(input)) as CurationModel;
	},
}));

// The default Hindsight client: every method asked for is recorded, only `list` answers.
const clientCalls = vi.hoisted(() => [] as string[]);
const listedByDefault = vi.hoisted(() => new Map<string, unknown[]>());
vi.mock("./hindsight-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("./hindsight-client")>()),
	nativeMemoryClient: (bankId: string) =>
		new Proxy(
			{},
			{
				get: (_target, method) => async () => {
					clientCalls.push(`${bankId} ${String(method)}`);
					if (method !== "list") throw new Error("not a list");
					return listedByDefault.get(bankId) ?? [];
				},
			},
		),
}));

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-label-relabel");
	curationCalls.length = 0;
	clientCalls.length = 0;
	listedByDefault.clear();
});
afterEach(() => h.cleanup());

async function modules() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const revisions = await import("./revisions");
	const verified = await import("./labels-verified");
	const relabel = await import("./label-relabel");
	return { db, schema, revisions, verified, relabel };
}

/**
 * The new wording's verdict for a synthetic fact: something bought is lasting,
 * something ordered is ongoing, anything else (an exam, the flu) stays temporary.
 */
function answer(input: unknown) {
	const facts = (input as { facts: { id: string; text: string }[] }).facts;
	return {
		labels: facts.map(({ id, text }) => ({
			id,
			kind: text.includes("bought")
				? "lasting"
				: text.includes("ordered")
					? "ongoing"
					: "temporary",
			subject: text.includes("bought") ? "about_you" : "other",
		})),
	};
}

interface Fake {
	facts: Map<string, NativeMemory[]>;
	listed: string[];
	batches: string[][];
	listFacts: (bankId: string) => Promise<NativeMemory[]>;
	model: (userId: string, signal: AbortSignal) => CurationModel;
}

function fakeNative(reply = answer as (input: unknown) => unknown): Fake {
	const fake: Fake = {
		facts: new Map(),
		listed: [],
		batches: [],
		listFacts: async (bankId) => {
			fake.listed.push(bankId);
			return fake.facts.get(bankId) ?? [];
		},
		model: () => async (_prompt, input) => {
			fake.batches.push(
				(input as { facts: { text: string }[] }).facts.map(({ text }) => text),
			);
			return reply(input);
		},
	};
	return fake;
}

interface SeedFact {
	id: string;
	text: string;
	kind: MemoryKind | null;
	subject?: MemorySubject | null;
	origin?: "extraction" | "classifier";
}

/** `count` temporary facts that are no purchase, ids `<prefix>-flu-<i>`. */
function temporaryFacts(prefix: string, count: number): SeedFact[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${prefix}-flu-${i}`,
		text: `had the flu ${i}`,
		kind: "temporary" as const,
		subject: "health" as const,
		origin: "classifier" as const,
	}));
}

/**
 * A synthetic account on native Memory whose labels exist: verified by the
 * label migration (the default), or a new account that never needed it.
 */
async function seedAccount(
	userId: string,
	facts: Fake["facts"],
	seed: SeedFact[],
	options: {
		excluded?: boolean;
		labels?: "verified" | "new" | "unverified";
	} = {},
) {
	const { db, schema, revisions, verified } = await modules();
	const { eq } = await import("drizzle-orm");
	if (userId !== h.userId) h.fixture.seedUser(userId);
	const bank = revisions.ensureMemoryBank(userId, { kind: "personal" });
	db.update(schema.memoryAccounts)
		.set({ authority: "hindsight" })
		.where(eq(schema.memoryAccounts.userId, userId))
		.run();
	db.update(schema.users)
		.set({ memoryMigrationExcluded: options.excluded ?? false })
		.where(eq(schema.users.id, userId))
		.run();
	const mode = options.labels ?? "verified";
	if (mode !== "new")
		db.transaction((tx) => {
			verified.markMemoryLabelsUnverified(tx, userId, 0);
			if (mode === "verified") verified.markMemoryLabelsVerified(tx, userId, 0);
		});
	facts.set(bank.id, [
		...seed.map(({ id, text }) => ({ id, text, fact_type: "world" })),
		{ id: `${userId}-obs`, text: "an observation", fact_type: "observation" },
	]);
	db.update(schema.memoryBanks)
		.set({ generation: "g1", nativeConfigVersion: "alfyai-bank-config-3" })
		.where(eq(schema.memoryBanks.id, bank.id))
		.run();
	// A published entry that rests on the first fact, said long ago: the person
	// sees it, and while that fact is temporary it is Earlier.
	const first = seed[0];
	db.insert(schema.memoryPublishedRows)
		.values({
			id: `${userId}-row`,
			bankId: bank.id,
			generation: "g1",
			epoch: 0,
			nativeId: `${userId}-obs`,
			text: "An entry",
			nativeText: "An entry",
			sourceIdsJson: JSON.stringify([first.id]),
			sourceFingerprintsJson: JSON.stringify([
				{ id: first.id, text: first.text },
			]),
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		})
		.run();
	h.sqlite
		.prepare(
			"INSERT INTO memory_source_revisions (id, bank_id, user_id, epoch, event_id, lineage_id, text, context, text_hash, asserted_at, state, acknowledged_facts_json) VALUES (?, ?, ?, 0, ?, ?, 'synthetic', '{}', 'hash', 1767225600, 'accepted', ?)",
		)
		.run(
			`${userId}-said`,
			bank.id,
			userId,
			`${userId}-event`,
			`${userId}-lineage`,
			JSON.stringify([{ id: first.id, text: first.text }]),
		);
	for (const fact of seed)
		if (fact.kind)
			db.insert(schema.memoryFactLabels)
				.values({
					bankId: bank.id,
					nativeFactId: fact.id,
					kind: fact.kind,
					subject: fact.subject ?? "other",
					origin: fact.origin ?? "classifier",
					eventAt: new Date("2026-02-01T00:00:00Z"),
				})
				.run();
	return bank;
}

/** Every row of every table, as the relabel must leave them but for the labels and its record. */
function snapshot(except: string[] = []) {
	const tables = h.sqlite
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as { name: string }[];
	return Object.fromEntries(
		tables
			.filter(({ name }) => !except.includes(name))
			.map(({ name }) => [
				name,
				h.sqlite.prepare(`SELECT * FROM "${name}"`).all(),
			]),
	);
}
const LABEL_TABLES = ["memory_fact_labels", "memory_label_relabels"];

function labelRows(bankId: string) {
	return h.sqlite
		.prepare(
			"SELECT native_fact_id, kind, subject, origin, event_at FROM memory_fact_labels WHERE bank_id = ? ORDER BY native_fact_id",
		)
		.all(bankId) as {
		native_fact_id: string;
		kind: string | null;
		subject: string | null;
		origin: string;
		event_at: number | null;
	}[];
}
function records(bankId: string) {
	return h.sqlite
		.prepare(
			"SELECT native_fact_id, previous_kind, previous_subject, previous_origin, kind, subject, changed FROM memory_label_relabels WHERE bank_id = ? ORDER BY native_fact_id",
		)
		.all(bankId) as {
		native_fact_id: string;
		previous_kind: string | null;
		previous_subject: string | null;
		previous_origin: string;
		kind: string | null;
		subject: string | null;
		changed: number;
	}[];
}
function accountMarks(userId: string) {
	return h.sqlite
		.prepare(
			"SELECT epoch, labels_unverified_epoch AS unverified, labels_verified_epoch AS verified FROM memory_accounts WHERE user_id = ?",
		)
		.get(userId);
}

const PHONE: SeedFact = {
	id: "phone",
	text: "bought a new phone",
	kind: "temporary",
	subject: "interests",
	origin: "classifier",
};
const DESK: SeedFact = {
	id: "desk",
	text: "ordered a standing desk",
	kind: "temporary",
	subject: "other",
	origin: "extraction",
};
const TEA: SeedFact = {
	id: "tea",
	text: "likes tea",
	kind: "lasting",
	subject: "interests",
};
const THESIS: SeedFact = {
	id: "thesis",
	text: "writes a thesis",
	kind: "ongoing",
	subject: "work_study",
};

describe("the label relabel", () => {
	it("dry run: counts only, the tester skipped and never read, nothing written", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, [
			PHONE,
			DESK,
			TEA,
			THESIS,
			...temporaryFacts("a", 24),
		]);
		const tester = await seedAccount(
			"user-2",
			fake.facts,
			[PHONE, ...temporaryFacts("b", 3)],
			{ excluded: true },
		);
		const before = snapshot();
		const { relabel } = await modules();
		const report = await relabel.runLabelRelabel(
			{ execute: false },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.outcome).toBe("dry_run");
		expect(report.totals).toMatchObject({
			accounts: 2,
			skipped: { excluded: 1 },
			banks: 1,
			facts: 28,
			temporary: 26,
			alreadyRelabelled: 0,
			toRelabel: 26,
			estimatedCalls: 2,
			calls: 0,
			relabelled: 0,
		});
		expect(report.accounts[0]).toMatchObject({
			userId: "user-1",
			outcome: "dry_run",
			facts: 28,
			temporary: 26,
			toRelabel: 26,
		});
		expect(fake.listed).not.toContain(tester.id);
		expect(fake.batches).toEqual([]);
		expect(snapshot()).toEqual(before);
	});

	it("asks only about facts whose label is temporary, moves the ones the new words call lasting or ongoing, and records what it did", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, [
			PHONE,
			DESK,
			TEA,
			THESIS,
			...temporaryFacts("a", 3),
		]);
		const before = snapshot(LABEL_TABLES);
		const labelsBefore = labelRows(bank.id);
		const { relabel, verified } = await modules();
		const report = await relabel.runLabelRelabel(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.outcome).toBe("done");
		// Only temporary facts are sent: not the lasting, not the ongoing, not the observation.
		expect(fake.batches.flat().sort()).toEqual(
			[
				"bought a new phone",
				"ordered a standing desk",
				"had the flu 0",
				"had the flu 1",
				"had the flu 2",
			].sort(),
		);
		expect(report.accounts[0]).toMatchObject({
			outcome: "relabelled",
			temporary: 5,
			toRelabel: 5,
			calls: 1,
			reclassified: 5,
			moved: { lasting: 1, ongoing: 1 },
			stillTemporary: 3,
			verification: {
				factsAccounted: true,
				factsUnchanged: true,
				publishedRowsUnchanged: true,
				fewUnanswered: true,
				plausible: true,
			},
		});
		const rows = Object.fromEntries(
			labelRows(bank.id).map((row) => [row.native_fact_id, row]),
		);
		// The moved facts: the classifier's new label, the fact's event date kept.
		expect(rows.phone).toMatchObject({
			kind: "lasting",
			subject: "about_you",
			origin: "classifier",
			event_at: new Date("2026-02-01T00:00:00Z").getTime(),
		});
		expect(rows.desk).toMatchObject({
			kind: "ongoing",
			subject: "other",
			origin: "classifier",
		});
		// A fact that stays temporary keeps its row exactly as it was; so do the rest.
		for (const id of ["a-flu-0", "a-flu-1", "a-flu-2", "tea", "thesis"])
			expect(rows[id]).toEqual(
				labelsBefore.find((row) => row.native_fact_id === id),
			);
		// Each asked fact has a record with the label it held before.
		expect(records(bank.id)).toEqual([
			...["a-flu-0", "a-flu-1", "a-flu-2"].map((id) => ({
				native_fact_id: id,
				previous_kind: "temporary",
				previous_subject: "health",
				previous_origin: "classifier",
				kind: "temporary",
				subject: "health",
				changed: 0,
			})),
			{
				native_fact_id: "desk",
				previous_kind: "temporary",
				previous_subject: "other",
				previous_origin: "extraction",
				kind: "ongoing",
				subject: "other",
				changed: 1,
			},
			{
				native_fact_id: "phone",
				previous_kind: "temporary",
				previous_subject: "interests",
				previous_origin: "classifier",
				kind: "lasting",
				subject: "about_you",
				changed: 1,
			},
		]);
		// Nothing else changed: not the published rows, not a source, not the account's marks.
		expect(snapshot(LABEL_TABLES)).toEqual(before);
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
		expect(accountMarks("user-1")).toEqual({
			epoch: 0,
			unverified: null,
			verified: 0,
		});
	});

	it("reports the account before and after: the entry its moved fact held leaves Earlier", async () => {
		const fake = fakeNative();
		// The published entry rests on the first fact, said in January 2026.
		await seedAccount("user-1", fake.facts, [PHONE, ...temporaryFacts("a", 2)]);
		const { relabel } = await modules();
		const deps = { listFacts: fake.listFacts, model: fake.model };
		const dry = await relabel.runLabelRelabel({ execute: false }, deps);
		expect(dry.accounts[0].whole).toMatchObject({
			factsByKind: { temporary: 3 },
			entries: 1,
			entriesByKind: { temporary: 1 },
			earlierEntries: 1,
		});
		const report = await relabel.runLabelRelabel({ execute: true }, deps);
		expect(report.accounts[0].before).toMatchObject({
			entries: 1,
			earlierEntries: 1,
		});
		expect(report.accounts[0].whole).toMatchObject({
			factsByKind: { lasting: 1, temporary: 2 },
			entries: 1,
			entriesByKind: { lasting: 1 },
			earlierEntries: 0,
		});
		expect(report.totals).toMatchObject({ entries: 1, earlierEntries: 0 });
	});

	it("a re-run asks nothing again, a fact that stayed temporary included; a new temporary fact is asked", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, [
			PHONE,
			...temporaryFacts("a", 2),
		]);
		const { relabel } = await modules();
		const deps = { listFacts: fake.listFacts, model: fake.model };
		await relabel.runLabelRelabel({ execute: true }, deps);
		fake.batches.length = 0;
		const again = await relabel.runLabelRelabel({ execute: true }, deps);
		expect(fake.batches).toEqual([]);
		expect(again.accounts[0]).toMatchObject({
			outcome: "skipped",
			skipped: "nothing_to_relabel",
			temporary: 2,
			alreadyRelabelled: 2,
			toRelabel: 0,
		});
		// A temporary label that arrives later (a new fact) is asked, and only it.
		h.sqlite
			.prepare(
				"INSERT INTO memory_fact_labels (bank_id, native_fact_id, kind, subject, origin) VALUES (?, 'bought-later', 'temporary', 'other', 'extraction')",
			)
			.run(bank.id);
		fake.facts.get(bank.id)?.push({
			id: "bought-later",
			text: "bought a bike",
			fact_type: "world",
		});
		const later = await relabel.runLabelRelabel({ execute: true }, deps);
		expect(fake.batches).toEqual([["bought a bike"]]);
		expect(later.accounts[0]).toMatchObject({
			outcome: "relabelled",
			toRelabel: 1,
			alreadyRelabelled: 2,
			moved: { lasting: 1 },
		});
	});

	it("only takes accounts whose labels exist: the label migration comes first", async () => {
		const fake = fakeNative();
		const waiting = await seedAccount("user-1", fake.facts, [PHONE], {
			labels: "unverified",
		});
		await seedAccount("user-2", fake.facts, [PHONE], { labels: "new" });
		const { relabel, db } = await modules();
		const { eq } = await import("drizzle-orm");
		const { users } = await import("$lib/server/db/schema");
		h.fixture.seedUser("user-3");
		db.update(users)
			.set({ memoryEnabled: false })
			.where(eq(users.id, "user-3"))
			.run();
		const report = await relabel.runLabelRelabel(
			{ execute: false },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		const byUser = Object.fromEntries(
			report.accounts.map((a) => [a.userId, a]),
		);
		expect(byUser["user-1"]).toMatchObject({
			outcome: "skipped",
			skipped: "labels_not_verified",
		});
		// A new account that never needed the migration has labels from extraction.
		expect(byUser["user-2"]).toMatchObject({
			outcome: "dry_run",
			toRelabel: 1,
		});
		expect(fake.listed).not.toContain(waiting.id);
	});

	it("never sends a fact the person removed: a revoked source's, or one a revocation names", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, [
			PHONE,
			...temporaryFacts("a", 2),
		]);
		const removed: SeedFact[] = [
			{ id: "gone-of-source", text: "removed one", kind: "temporary" },
			{ id: "gone-by-name", text: "removed two", kind: "temporary" },
		];
		for (const fact of removed) {
			fake.facts.get(bank.id)?.push({
				id: fact.id,
				text: fact.text,
				fact_type: "world",
				document_id: fact.id === "gone-of-source" ? "revoked-source" : null,
			});
			h.sqlite
				.prepare(
					"INSERT INTO memory_fact_labels (bank_id, native_fact_id, kind, subject, origin) VALUES (?, ?, 'temporary', 'other', 'classifier')",
				)
				.run(bank.id, fact.id);
		}
		h.sqlite
			.prepare(
				"INSERT INTO memory_source_revisions (id, bank_id, user_id, epoch, event_id, lineage_id, text, context, text_hash, asserted_at, state, acknowledged_facts_json) VALUES ('revoked-source', ?, 'user-1', 0, 'event-b', 'lineage-b', 'synthetic', '{}', 'hash', 1767225600, 'revoked', ?)",
			)
			.run(
				bank.id,
				JSON.stringify([{ id: "gone-of-source", text: "removed one" }]),
			);
		h.sqlite
			.prepare(
				"INSERT INTO memory_revocations (id, user_id, bank_id, epoch, source_id, native_fact_id) VALUES ('revocation-b', 'user-1', ?, 0, NULL, 'gone-by-name')",
			)
			.run(bank.id);
		const { relabel } = await modules();
		const dry = await relabel.runLabelRelabel(
			{ execute: false },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(dry.accounts[0]).toMatchObject({
			facts: 3,
			removed: 2,
			temporary: 3,
			toRelabel: 3,
		});
		await relabel.runLabelRelabel(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(fake.batches.flat().sort()).toEqual(
			["bought a new phone", "had the flu 0", "had the flu 1"].sort(),
		);
		expect(records(bank.id).map((row) => row.native_fact_id)).not.toContain(
			"gone-by-name",
		);
	});
});

describe("the label relabel writes nothing unless it verifies", () => {
	async function failing(
		reply: (input: unknown) => unknown,
		count = 3,
		options: Partial<Parameters<typeof relabelDeps>[1]> = {},
	) {
		const fake = fakeNative(reply);
		const bank = await seedAccount("user-1", fake.facts, [
			PHONE,
			...temporaryFacts("a", count),
		]);
		const before = snapshot();
		const { relabel } = await modules();
		const report = await relabel.runLabelRelabel(
			{ execute: true },
			relabelDeps(fake, options),
		);
		return { fake, bank, before, report };
	}
	function relabelDeps(
		fake: Fake,
		options: {
			listFacts?: (bankId: string) => Promise<NativeMemory[]>;
			model?: Fake["model"];
		},
	) {
		return {
			listFacts: options.listFacts ?? fake.listFacts,
			model: options.model ?? fake.model,
		};
	}

	it("a fact whose text changes between the two listings fails the account and writes nothing", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, [PHONE, ...temporaryFacts("a", 2)]);
		const before = snapshot();
		const { relabel } = await modules();
		let listings = 0;
		const report = await relabel.runLabelRelabel(
			{ execute: true },
			{
				listFacts: async (bankId) => {
					const facts = await fake.listFacts(bankId);
					return listings++ === 0
						? facts
						: facts.map((fact) =>
								fact.id === "phone" ? { ...fact, text: "sold a phone" } : fact,
							);
				},
				model: fake.model,
			},
		);
		expect(report.outcome).toBe("stopped");
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "facts_changed",
			verification: { factsUnchanged: false },
		});
		expect(snapshot()).toEqual(before);
	});

	it("published rows that change during the run fail it and write nothing", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, [PHONE, ...temporaryFacts("a", 2)]);
		const { relabel } = await modules();
		const model: Fake["model"] =
			(userId, signal) =>
			async (...args) => {
				h.sqlite
					.prepare(
						"UPDATE memory_published_rows SET text = 'Another entry' WHERE id = 'user-1-row'",
					)
					.run();
				return fake.model(userId, signal)(...args);
			};
		const before = snapshot(["memory_published_rows"]);
		const report = await relabel.runLabelRelabel(
			{ execute: true },
			{ listFacts: fake.listFacts, model },
		);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "published_rows_changed",
			verification: { publishedRowsUnchanged: false },
		});
		expect(snapshot(["memory_published_rows"])).toEqual(before);
	});

	it("a model that is down fails the account and writes nothing", async () => {
		const { report, before } = await failing(() => {
			throw new Error("model down");
		});
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "model_unavailable",
		});
		expect(snapshot()).toEqual(before);
	});

	it("more than one fact in 20 left unanswered fails the account and writes nothing; a later run asks again", async () => {
		const answered = (input: unknown) => {
			const reply = answer(input) as { labels: { id: string }[] };
			// The model leaves every other fact out.
			return { labels: reply.labels.filter((_, i) => i % 2 === 0) };
		};
		const { report, before, fake } = await failing(answered, 5);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "too_many_unanswered",
			verification: { fewUnanswered: false },
		});
		expect(snapshot()).toEqual(before);
		const { relabel } = await modules();
		fake.batches.length = 0;
		const retry = await relabel.runLabelRelabel(
			{ execute: true },
			{
				listFacts: fake.listFacts,
				model: () => async (_p, input) => answer(input),
			},
		);
		expect(retry.accounts[0]).toMatchObject({ outcome: "relabelled" });
	});

	it("a model that calls nearly everything lasting is implausible: the account fails and nothing is written", async () => {
		const allLasting = (input: unknown) => ({
			labels: (input as { facts: { id: string }[] }).facts.map(({ id }) => ({
				id,
				kind: "lasting",
				subject: "other",
			})),
		});
		const { report, before } = await failing(allLasting, 25);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "implausible_relabel",
			verification: { plausible: false },
		});
		expect(snapshot()).toEqual(before);
	});

	it("a small account may move every fact: the share is judged from 20 answered facts", async () => {
		const allLasting = (input: unknown) => ({
			labels: (input as { facts: { id: string }[] }).facts.map(({ id }) => ({
				id,
				kind: "lasting",
				subject: "other",
			})),
		});
		const { report } = await failing(allLasting, 3);
		expect(report.accounts[0]).toMatchObject({
			outcome: "relabelled",
			moved: { lasting: 4 },
		});
	});

	/** The first model call changes the account, as a person or the operator could. */
	async function changedMidRun(change: () => void) {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, [
			PHONE,
			...temporaryFacts("a", 2),
		]);
		const before = snapshot();
		const { relabel } = await modules();
		let calls = 0;
		const report = await relabel.runLabelRelabel(
			{ execute: true },
			{
				listFacts: fake.listFacts,
				model:
					(userId, signal) =>
					async (...args) => {
						calls++;
						change();
						return fake.model(userId, signal)(...args);
					},
			},
		);
		return { report, calls, bank, before };
	}

	it("the tester flag set mid-run: nothing is written", async () => {
		const { report, before } = await changedMidRun(() =>
			h.sqlite
				.prepare(
					"UPDATE users SET memory_migration_excluded = 1 WHERE id = 'user-1'",
				)
				.run(),
		);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "memory_migration_excluded",
		});
		// The flag is the one change; every other table is as it was.
		const { users: _flag, ...unchanged } = before;
		const { users: _now, ...now } = snapshot();
		expect(now).toEqual(unchanged);
	});

	it.each([
		[
			"Memory turned off",
			"UPDATE users SET memory_enabled = 0 WHERE id = 'user-1'",
			"users",
		],
		[
			"Clear Memory (a new epoch)",
			"UPDATE memory_accounts SET epoch = 1 WHERE user_id = 'user-1'",
			"memory_accounts",
		],
		[
			"erasure",
			"UPDATE memory_accounts SET lifecycle_state = 'erasing' WHERE user_id = 'user-1'",
			"memory_accounts",
		],
	])(
		"%s mid-run: the answers are not written",
		async (_name, change, table) => {
			const { report, before } = await changedMidRun(() =>
				h.sqlite.exec(change),
			);
			expect(report.accounts[0]).toMatchObject({
				outcome: "failed",
				failure: "memory_fence_stale",
			});
			const { [table]: _changed, ...unchanged } = before;
			const { [table]: _now, ...now } = snapshot();
			expect(now).toEqual(unchanged);
		},
	);

	it("the write itself is fenced: a flag set after the model answered, before the write, writes nothing", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, [PHONE, ...temporaryFacts("a", 2)]);
		const { relabel } = await modules();
		let listings = 0;
		const report = await relabel.runLabelRelabel(
			{ execute: true },
			{
				listFacts: async (bankId) => {
					// The second listing is the verification's, after every answer is in.
					if (listings++ === 1)
						h.sqlite
							.prepare(
								"UPDATE users SET memory_migration_excluded = 1 WHERE id = 'user-1'",
							)
							.run();
					return fake.listFacts(bankId);
				},
				model: fake.model,
			},
		);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "memory_migration_excluded",
		});
		expect(
			h.sqlite.prepare("SELECT COUNT(*) AS n FROM memory_label_relabels").get(),
		).toEqual({ n: 0 });
		expect(
			h.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM memory_fact_labels WHERE kind = 'lasting'",
				)
				.get(),
		).toEqual({ n: 0 });
	});
});

describe("the label relabel's rollback", () => {
	async function relabelled() {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, [
			PHONE,
			DESK,
			TEA,
			...temporaryFacts("a", 2),
		]);
		const original = labelRows(bank.id);
		const { relabel } = await modules();
		await relabel.runLabelRelabel(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		return { fake, bank, original, relabel };
	}

	it("puts back exactly what the relabel changed, the label each fact held, and forgets the record", async () => {
		const { bank, original, relabel } = await relabelled();
		expect(labelRows(bank.id)).not.toEqual(original);
		const dry = relabel.rollbackLabelRelabel({
			userId: "user-1",
			execute: false,
		});
		expect(dry).toMatchObject({
			outcome: "dry_run",
			banks: 1,
			changed: 2,
			toRestore: 2,
			leftAlone: 0,
			lookedAt: 2,
		});
		expect(labelRows(bank.id)).not.toEqual(original);
		const done = relabel.rollbackLabelRelabel({
			userId: "user-1",
			execute: true,
		});
		expect(done).toMatchObject({ outcome: "done", restored: 2, leftAlone: 0 });
		// The extraction-origin fact is back with its origin, the classifier's with its own.
		expect(labelRows(bank.id)).toEqual(original);
		expect(records(bank.id)).toEqual([]);
	});

	it("leaves a label someone changed since, and the facts are asked again by the next run", async () => {
		const { bank, fake, relabel } = await relabelled();
		// The phone was relabelled again by hand after the relabel.
		h.sqlite
			.prepare(
				"UPDATE memory_fact_labels SET kind = 'ongoing' WHERE bank_id = ? AND native_fact_id = 'phone'",
			)
			.run(bank.id);
		const done = relabel.rollbackLabelRelabel({
			userId: "user-1",
			execute: true,
		});
		expect(done).toMatchObject({ outcome: "done", restored: 1, leftAlone: 1 });
		expect(
			labelRows(bank.id).find((row) => row.native_fact_id === "phone"),
		).toMatchObject({ kind: "ongoing" });
		expect(
			labelRows(bank.id).find((row) => row.native_fact_id === "desk"),
		).toMatchObject({
			kind: "temporary",
			origin: "extraction",
			subject: "other",
		});
		expect(records(bank.id)).toEqual([]);
		fake.batches.length = 0;
		await relabel.runLabelRelabel(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		// The desk and the two flu facts are asked again; the phone is no longer temporary.
		expect(fake.batches.flat().sort()).toEqual(
			["ordered a standing desk", "had the flu 0", "had the flu 1"].sort(),
		);
	});

	it("works with Memory off", async () => {
		const { bank, original, relabel } = await relabelled();
		h.sqlite
			.prepare("UPDATE users SET memory_enabled = 0 WHERE id = 'user-1'")
			.run();
		const done = relabel.rollbackLabelRelabel({
			userId: "user-1",
			execute: true,
		});
		expect(done.outcome).toBe("done");
		expect(labelRows(bank.id)).toEqual(original);
	});

	it("refuses an account the relabel never ran on, the tester, and a Memory with no native account", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, [PHONE]);
		await seedAccount("tester", fake.facts, [PHONE], { excluded: true });
		const { relabel } = await modules();
		expect(
			relabel.rollbackLabelRelabel({ userId: "user-1", execute: true }),
		).toMatchObject({ outcome: "refused", code: "label_relabel_not_run" });
		expect(
			relabel.rollbackLabelRelabel({ userId: "tester", execute: true }),
		).toMatchObject({ outcome: "refused", code: "memory_migration_excluded" });
		expect(
			relabel.rollbackLabelRelabel({ userId: "nobody", execute: true }),
		).toMatchObject({ outcome: "refused" });
	});

	it("does not touch the account's verification or any other table", async () => {
		const { relabel } = await relabelled();
		const before = snapshot(LABEL_TABLES);
		relabel.rollbackLabelRelabel({ userId: "user-1", execute: true });
		expect(snapshot(LABEL_TABLES)).toEqual(before);
		expect(accountMarks("user-1")).toEqual({
			epoch: 0,
			unverified: null,
			verified: 0,
		});
	});
});

describe("the label relabel's edges", () => {
	it("with no client of its own it only lists from Hindsight, and asks the memory model path at background priority, in the account's tenant lane", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, [
			PHONE,
			...temporaryFacts("a", 2),
		]);
		listedByDefault.set(bank.id, fake.facts.get(bank.id) ?? []);
		const { relabel, db, schema } = await modules();
		const { tenantId } = db.select().from(schema.memoryAccounts).get() ?? {};
		const report = await relabel.runLabelRelabel({ execute: true });
		expect(report.accounts[0]).toMatchObject({ outcome: "relabelled" });
		// The first listing, then verification's: nothing but `list`.
		expect(clientCalls).toEqual([`${bank.id} list`, `${bank.id} list`]);
		expect(curationCalls).toEqual([
			[
				expect.any(AbortSignal),
				undefined,
				{ priority: "background", tenantId },
			],
		]);
	});

	it("labels with several calls in flight, never more than asked", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, temporaryFacts("a", 100));
		let inFlight = 0;
		let peak = 0;
		const { relabel } = await modules();
		await relabel.runLabelRelabel(
			{ execute: true },
			{
				concurrency: 2,
				listFacts: fake.listFacts,
				model: () => async (_prompt, input) => {
					peak = Math.max(peak, ++inFlight);
					await new Promise((resolve) => setTimeout(resolve, 5));
					inFlight--;
					return answer(input);
				},
			},
		);
		expect(peak).toBe(2);
	});

	it("one named account only; the tester named alone is skipped untouched", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, [PHONE]);
		const tester = await seedAccount("tester", fake.facts, [PHONE], {
			excluded: true,
		});
		const { relabel } = await modules();
		const report = await relabel.runLabelRelabel(
			{ execute: true, userId: "tester" },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.accounts).toHaveLength(1);
		expect(report.accounts[0]).toMatchObject({
			outcome: "skipped",
			skipped: "excluded",
		});
		expect(fake.listed).not.toContain(tester.id);
		expect(fake.batches).toEqual([]);
	});

	it("exactly the accounts listed, in that order", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, [PHONE]);
		await seedAccount("user-2", fake.facts, [PHONE]);
		const { relabel } = await modules();
		const report = await relabel.runLabelRelabel(
			{ execute: true, userIds: ["user-2"] },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.accounts.map((a) => a.userId)).toEqual(["user-2"]);
		expect(report.totals.relabelled).toBe(1);
	});
});
