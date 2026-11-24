import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import type { NativeMemory } from "./contracts";
import type { CurationModel } from "./curation";

// The default model is the admission-gated memory path; tests that do not
// hand the migration a model of their own see which admission it asked for.
const curationCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock("./curation", async (importOriginal) => ({
	...(await importOriginal<typeof import("./curation")>()),
	createCurationModel: (...args: unknown[]) => {
		curationCalls.push(args);
		return (async (_prompt: string, input: unknown) =>
			labelAll(input)) as CurationModel;
	},
}));

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-label-migration");
	curationCalls.length = 0;
});
afterEach(() => h.cleanup());

async function modules() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const revisions = await import("./revisions");
	const verified = await import("./labels-verified");
	const migration = await import("./label-migration");
	return { db, schema, revisions, verified, migration };
}

/** Every fact of a batch labelled by a word in its synthetic text. */
function labelAll(input: unknown) {
	const facts = (input as { facts: { id: string; text: string }[] }).facts;
	return {
		labels: facts.map(({ id, text }) => ({
			id,
			kind: text.includes("flu")
				? "temporary"
				: text.includes("thesis")
					? "ongoing"
					: "lasting",
			subject: text.includes("flu") ? "health" : "other",
		})),
	};
}

interface Fake {
	/** Raw facts and observations per bank, as Hindsight would list them. */
	facts: Map<string, NativeMemory[]>;
	listed: string[];
	batches: string[][];
	listFacts: (bankId: string) => Promise<NativeMemory[]>;
	model: (userId: string, signal: AbortSignal) => CurationModel;
}

function fakeNative(answer = labelAll as (input: unknown) => unknown): Fake {
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
			return answer(input);
		},
	};
	return fake;
}

function rawFacts(prefix: string, count: number, text = "likes tea") {
	return Array.from({ length: count }, (_, i) => ({
		id: `${prefix}-fact-${i}`,
		text: `${text} ${i}`,
		fact_type: "world",
	}));
}

/** A synthetic account on native Memory whose epoch waits for its labels. */
async function seedAccount(
	userId: string,
	facts: Fake["facts"],
	options: { count?: number; excluded?: boolean; text?: string } = {},
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
	db.transaction((tx) => verified.markMemoryLabelsUnverified(tx, userId, 0));
	const raw = rawFacts(userId, options.count ?? 3, options.text);
	facts.set(bank.id, [
		...raw,
		{ id: `${userId}-obs`, text: "an observation", fact_type: "observation" },
	]);
	// A published entry and a dated label, which the migration must leave as they are.
	db.update(schema.memoryBanks)
		.set({ generation: "g1", nativeConfigVersion: "alfyai-bank-config-2" })
		.where(eq(schema.memoryBanks.id, bank.id))
		.run();
	db.insert(schema.memoryPublishedRows)
		.values({
			id: `${userId}-row`,
			bankId: bank.id,
			generation: "g1",
			epoch: 0,
			nativeId: `${userId}-obs`,
			text: "Likes tea",
			nativeText: "Likes tea",
			sourceIdsJson: JSON.stringify([raw[0].id]),
			sourceFingerprintsJson: JSON.stringify([
				{ id: raw[0].id, text: raw[0].text },
			]),
			updatedAt: new Date("2026-01-01T00:00:00Z"),
		})
		.run();
	db.insert(schema.memoryFactLabels)
		.values({
			bankId: bank.id,
			nativeFactId: raw[0].id,
			kind: null,
			subject: null,
			origin: "extraction",
			eventAt: new Date("2026-02-01T00:00:00Z"),
		})
		.run();
	return bank;
}

/**
 * Every row of every table, the label store and the two account columns the
 * migration may change (`labels_unverified_epoch`, `labels_verified_epoch`)
 * left out: `accountMarks` reads those.
 */
function snapshot() {
	const tables = h.sqlite
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as { name: string }[];
	return Object.fromEntries(
		tables
			.filter(({ name }) => name !== "memory_fact_labels")
			.map(({ name }) => [
				name,
				(
					h.sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<
						string,
						unknown
					>[]
				).map((row) => {
					if (name !== "memory_accounts") return row;
					const {
						labels_unverified_epoch: _unverified,
						labels_verified_epoch: _verified,
						...rest
					} = row;
					return rest;
				}),
			]),
	);
}

/** The two account columns the migration and its rollback may change. */
function accountMarks(userId: string) {
	return h.sqlite
		.prepare(
			"SELECT epoch, labels_unverified_epoch AS unverified, labels_verified_epoch AS verified FROM memory_accounts WHERE user_id = ?",
		)
		.get(userId) as {
		epoch: number;
		unverified: number | null;
		verified: number | null;
	};
}

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

describe("the label migration", () => {
	it("dry run: counts only, the tester skipped and never read, nothing written", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, { count: 25 });
		await seedAccount("user-2", fake.facts, { count: 3 });
		const tester = await seedAccount("user-3", fake.facts, {
			count: 5,
			excluded: true,
		});
		const before = snapshot();
		const { migration } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: false },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.outcome).toBe("dry_run");
		expect(report.totals).toMatchObject({
			accounts: 3,
			skipped: { excluded: 1 },
			banks: 2,
			facts: 28,
			alreadyLabelled: 0,
			toLabel: 28,
			estimatedCalls: 3,
		});
		expect(
			report.accounts.map(({ userId, outcome }) => [userId, outcome]),
		).toEqual([
			["user-1", "dry_run"],
			["user-2", "dry_run"],
			["user-3", "skipped"],
		]);
		expect(fake.listed).not.toContain(tester.id);
		expect(fake.batches).toEqual([]);
		expect(snapshot()).toEqual(before);
	});

	it("labels every account but the tester, verifies each and changes nothing else", async () => {
		const fake = fakeNative();
		const first = await seedAccount("user-1", fake.facts, {
			count: 25,
			text: "had the flu",
		});
		// A lasting minority, as any real bank holds: the kind mix is plausible.
		fake.facts.get(first.id)?.push(...rawFacts("user-1-tea", 5));
		const second = await seedAccount("user-2", fake.facts, { count: 3 });
		const tester = await seedAccount("user-3", fake.facts, {
			count: 5,
			excluded: true,
		});
		const before = snapshot();
		const { migration, verified } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.outcome).toBe("done");
		expect(report.totals).toMatchObject({
			accounts: 3,
			skipped: { excluded: 1 },
			verified: 2,
			failed: 0,
		});
		const one = report.accounts.find(({ userId }) => userId === "user-1");
		expect(one).toMatchObject({
			outcome: "verified",
			labelled: 30,
			byKind: { temporary: 25, lasting: 5 },
			bySubject: { health: 25, other: 5 },
			unlabelled: {},
			calls: 2,
			verification: {
				factsAccounted: true,
				factsUnchanged: true,
				publishedRowsUnchanged: true,
				fewUnlabelled: true,
				labelsPlausible: true,
			},
		});
		// Every raw fact labelled by the classifier; the observation never sent.
		expect(labelRows(first.id).map(({ origin }) => origin)).toEqual(
			Array(30).fill("classifier"),
		);
		expect(fake.batches.flat()).not.toContain("an observation");
		// The fact's event date is kept.
		expect(labelRows(first.id)[0]).toMatchObject({
			native_fact_id: "user-1-fact-0",
			kind: "temporary",
			event_at: new Date("2026-02-01T00:00:00Z").getTime(),
		});
		expect(labelRows(second.id)).toHaveLength(3);
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
		expect(verified.memoryLabelsVerified("user-2")).toBe(true);
		// The tester: never read, never labelled, still on today's page.
		expect(fake.listed).not.toContain(tester.id);
		expect(labelRows(tester.id)).toEqual([
			{
				native_fact_id: "user-3-fact-0",
				kind: null,
				subject: null,
				origin: "extraction",
				event_at: new Date("2026-02-01T00:00:00Z").getTime(),
			},
		]);
		expect(verified.memoryLabelsVerified("user-3")).toBe(false);
		// The account columns it may change: the mark cleared and the epoch
		// recorded as verified, for the two it verified; the tester's as it was.
		expect(accountMarks("user-1")).toEqual({
			epoch: 0,
			unverified: null,
			verified: 0,
		});
		expect(accountMarks("user-2")).toEqual({
			epoch: 0,
			unverified: null,
			verified: 0,
		});
		expect(accountMarks("user-3")).toEqual({
			epoch: 0,
			unverified: 0,
			verified: null,
		});
		// Text, support, dates and visibility: every other table as it was.
		expect(snapshot()).toEqual(before);
	});

	it("a re-run labels nothing and calls no model", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, { count: 4 });
		const { migration } = await modules();
		const deps = { listFacts: fake.listFacts, model: fake.model };
		await migration.runLabelMigration({ execute: true }, deps);
		const labels = labelRows(bank.id);
		fake.batches.length = 0;
		const again = await migration.runLabelMigration({ execute: true }, deps);
		expect(again.outcome).toBe("done");
		expect(again.totals).toMatchObject({
			skipped: { already_verified: 1 },
			verified: 0,
		});
		expect(fake.batches).toEqual([]);
		expect(labelRows(bank.id)).toEqual(labels);
	});

	it("an interrupted run keeps what it wrote, and the next run labels only the rest", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, { count: 45 });
		const { migration, verified } = await modules();
		const controller = new AbortController();
		const stopping = {
			listFacts: fake.listFacts,
			model: (userId: string, signal: AbortSignal) => {
				const model = fake.model(userId, signal);
				return (async (...args: Parameters<CurationModel>) => {
					const answer = await model(...args);
					controller.abort();
					return answer;
				}) as CurationModel;
			},
			signal: controller.signal,
		};
		const first = await migration.runLabelMigration(
			{ execute: true },
			stopping,
		);
		expect(first.outcome).toBe("stopped");
		expect(first.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "label_migration_aborted",
		});
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(20);
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
		fake.batches.length = 0;
		const second = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(second.outcome).toBe("done");
		expect(second.accounts[0]).toMatchObject({
			outcome: "verified",
			alreadyLabelled: 20,
			labelled: 25,
		});
		expect(fake.batches.flat()).toHaveLength(25);
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
	});

	/** Labels every fact but the one with this text, which it gives a kind off the list. */
	const unusableFor = (text: string) => (input: unknown) => {
		const answer = labelAll(input);
		const facts = (input as { facts: { id: string; text: string }[] }).facts;
		for (const label of answer.labels)
			if (facts.find(({ id }) => id === label.id)?.text === text)
				label.kind = "forever";
		return answer;
	};

	it("a fact the model gives no usable label is listed with its reason, and the account is verified", async () => {
		const fake = fakeNative(unusableFor("likes tea 0"));
		const bank = await seedAccount("user-1", fake.facts, { count: 25 });
		const { migration, verified } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		// One in 25 is under one in 20.
		expect(report.accounts[0]).toMatchObject({
			outcome: "verified",
			labelled: 24,
			unlabelled: { no_label: 1 },
		});
		// Asked twice: once in its batch, once more on its own.
		expect(fake.batches).toHaveLength(3);
		expect(fake.batches[2]).toEqual(["likes tea 0"]);
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(24);
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
	});

	it("a later run asks again for a verified account's facts left without a label", async () => {
		const fake = fakeNative(unusableFor("likes tea 0"));
		const bank = await seedAccount("user-1", fake.facts, { count: 25 });
		const { migration, verified } = await modules();
		await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
		const working = fakeNative();
		working.facts = fake.facts;
		const dry = await migration.runLabelMigration(
			{ execute: false },
			{ listFacts: working.listFacts, model: working.model },
		);
		expect(dry.accounts[0]).toMatchObject({
			outcome: "dry_run",
			alreadyLabelled: 24,
			toLabel: 1,
		});
		const again = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: working.listFacts, model: working.model },
		);
		expect(again.accounts[0]).toMatchObject({
			outcome: "verified",
			alreadyLabelled: 24,
			labelled: 1,
			unlabelled: {},
		});
		expect(working.batches).toEqual([["likes tea 0"]]);
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(25);
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
	});

	it("more than one fact in 20 without a usable label fails the account, and a later run asks again", async () => {
		// Every answer unusable: the facts were looked at, none was labelled.
		const fake = fakeNative((input) => {
			const answer = labelAll(input);
			for (const label of answer.labels) label.kind = "forever";
			return answer;
		});
		const bank = await seedAccount("user-1", fake.facts, { count: 25 });
		await seedAccount("user-2", fake.facts, { count: 3 });
		const { migration, verified } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.outcome).toBe("stopped");
		expect(report.accounts).toHaveLength(1);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "too_many_unlabelled",
			labelled: 0,
			unlabelled: { no_label: 25 },
			verification: { factsAccounted: true, fewUnlabelled: false },
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
		// The next run asks for every one of them again.
		const working = fakeNative();
		working.facts = fake.facts;
		const again = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: working.listFacts, model: working.model },
		);
		expect(again.accounts[0]).toMatchObject({
			outcome: "verified",
			labelled: 25,
		});
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(25);
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
	});

	it("an implausible kind mix fails the account: a model that calls everything temporary", async () => {
		const fake = fakeNative((input) => {
			const answer = labelAll(input);
			for (const label of answer.labels) label.kind = "temporary";
			return answer;
		});
		await seedAccount("user-1", fake.facts, { count: 25 });
		const { migration, verified } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "implausible_labels",
			byKind: { temporary: 25 },
			verification: { labelsPlausible: false },
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
	});

	it("a small account may be all temporary: the kind mix is judged from 20 labelled facts", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, { count: 19, text: "had the flu" });
		const { migration, verified } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.accounts[0]).toMatchObject({
			outcome: "verified",
			byKind: { temporary: 19 },
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
	});

	it("an account whose model calls fail is not verified, and the run stops before the next account", async () => {
		const fake = fakeNative(() => {
			throw new Error("busy");
		});
		await seedAccount("user-1", fake.facts, { count: 3 });
		const next = await seedAccount("user-2", fake.facts, { count: 3 });
		const { migration, verified } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(report.outcome).toBe("stopped");
		expect(report.stoppedAt).toBe("user-1");
		expect(report.accounts).toHaveLength(1);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "model_unavailable",
			unlabelled: { model_unavailable: 3 },
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
		expect(fake.listed).not.toContain(next.id);
	});

	it("never sends a fact the person removed: a revoked source's, or one a revocation names", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, { count: 3 });
		const removed = [
			{
				id: "fact-of-deleted-chat",
				text: "removed one",
				fact_type: "world",
				document_id: "deleted-chat-source",
			},
			{ id: "fact-removed-by-name", text: "removed two", fact_type: "world" },
			{
				id: "fact-of-revoked-source",
				text: "removed three",
				fact_type: "world",
				document_id: "revoked-source",
			},
		];
		fake.facts.get(bank.id)?.push(...removed);
		const insertSource = h.sqlite.prepare(
			"INSERT INTO memory_source_revisions (id, bank_id, user_id, epoch, event_id, lineage_id, text, context, text_hash, asserted_at, state, acknowledged_facts_json) VALUES (?, ?, 'user-1', 0, ?, ?, 'synthetic', '{}', 'hash', 1767225600, ?, ?)",
		);
		insertSource.run(
			"deleted-chat-source",
			bank.id,
			"event-a",
			"lineage-a",
			"accepted",
			JSON.stringify([{ id: "fact-of-deleted-chat", text: "removed one" }]),
		);
		insertSource.run(
			"revoked-source",
			bank.id,
			"event-b",
			"lineage-b",
			"revoked",
			JSON.stringify([{ id: "fact-of-revoked-source", text: "removed three" }]),
		);
		const revoke = h.sqlite.prepare(
			"INSERT INTO memory_revocations (id, user_id, bank_id, epoch, source_id, native_fact_id) VALUES (?, 'user-1', ?, 0, ?, ?)",
		);
		revoke.run("revocation-a", bank.id, "deleted-chat-source", null);
		revoke.run("revocation-b", bank.id, null, "fact-removed-by-name");
		const { migration, verified } = await modules();
		const dry = await migration.runLabelMigration(
			{ execute: false },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(dry.accounts[0]).toMatchObject({ facts: 3, removed: 3, toLabel: 3 });
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(fake.batches.flat()).toEqual([
			"likes tea 0",
			"likes tea 1",
			"likes tea 2",
		]);
		expect(report.accounts[0]).toMatchObject({
			outcome: "verified",
			facts: 3,
			removed: 3,
			labelled: 3,
		});
		expect(
			labelRows(bank.id).map(({ native_fact_id }) => native_fact_id),
		).not.toContain("fact-removed-by-name");
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
	});

	it("stops calling the model after three batches in a row fail", async () => {
		const fake = fakeNative(() => {
			throw new Error("busy");
		});
		await seedAccount("user-1", fake.facts, { count: 100 });
		const { migration, verified } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		// Five batches, each asked twice, without the stop: ten calls.
		expect(fake.batches).toHaveLength(3);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "model_unavailable",
			unlabelled: { model_unavailable: 100 },
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
	});

	/** A model whose first call lets `change` happen before the next one is due. */
	async function changedMidRun(change: () => void | Promise<void>) {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, { count: 45 });
		const { migration, verified } = await modules();
		let calls = 0;
		const report = await migration.runLabelMigration(
			{ execute: true },
			{
				listFacts: fake.listFacts,
				model:
					(userId, signal) =>
					async (...args) => {
						calls++;
						const answer = await fake.model(userId, signal)(...args);
						if (calls === 1) await change();
						return answer;
					},
			},
		);
		return { report, calls, bank, verified };
	}

	it("the tester flag set mid-run: no further fact of the account is sent", async () => {
		const { report, calls, verified } = await changedMidRun(() => {
			h.sqlite
				.prepare(
					"UPDATE users SET memory_migration_excluded = 1 WHERE id = 'user-1'",
				)
				.run();
		});
		expect(calls).toBe(1);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "memory_migration_excluded",
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
	});

	it("Memory turned off mid-run: the batch answered is not written, and nothing more is sent", async () => {
		const { report, calls, bank, verified } = await changedMidRun(() => {
			h.sqlite
				.prepare("UPDATE users SET memory_enabled = 0 WHERE id = 'user-1'")
				.run();
		});
		expect(calls).toBe(1);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "memory_fence_stale",
		});
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(0);
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
	});

	it("Clear Memory mid-run (a new epoch): nothing more is sent or written", async () => {
		const { report, calls, bank } = await changedMidRun(() => {
			h.sqlite
				.prepare(
					"UPDATE memory_accounts SET epoch = 1 WHERE user_id = 'user-1'",
				)
				.run();
		});
		expect(calls).toBe(1);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "memory_fence_stale",
		});
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(0);
	});

	it("erasure mid-run: nothing more is sent or written", async () => {
		const { report, calls, bank } = await changedMidRun(() => {
			h.sqlite
				.prepare(
					"UPDATE memory_accounts SET lifecycle_state = 'erasing' WHERE user_id = 'user-1'",
				)
				.run();
		});
		expect(calls).toBe(1);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "memory_fence_stale",
		});
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(0);
	});

	it("published rows that change during the run fail verification", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, { count: 3 });
		const { migration, verified } = await modules();
		const report = await migration.runLabelMigration(
			{ execute: true },
			{
				listFacts: fake.listFacts,
				model:
					(userId, signal) =>
					async (...args) => {
						h.sqlite
							.prepare(
								"UPDATE memory_published_rows SET text = 'Likes coffee' WHERE id = 'user-1-row'",
							)
							.run();
						return fake.model(userId, signal)(...args);
					},
			},
		);
		expect(report.outcome).toBe("stopped");
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "published_rows_changed",
			verification: { factsAccounted: true, publishedRowsUnchanged: false },
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
	});

	it("a chat during the run (a new pending source) does not fail verification", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, { count: 3 });
		const { migration, verified } = await modules();
		let chats = 0;
		const report = await migration.runLabelMigration(
			{ execute: true },
			{
				listFacts: fake.listFacts,
				model:
					(userId, signal) =>
					async (...args) => {
						// What a turn records while the Memory workers are paused.
						h.sqlite
							.prepare(
								"INSERT INTO memory_source_revisions (id, bank_id, user_id, epoch, event_id, lineage_id, text, context, text_hash, asserted_at, state) VALUES (?, ?, 'user-1', 0, ?, ?, 'synthetic', '{}', 'hash', 1767225600, ?)",
							)
							.run(
								`chat-${chats}`,
								bank.id,
								`chat-event-${chats}`,
								`chat-lineage-${chats}`,
								chats++ ? "staged" : "pending",
							);
						return fake.model(userId, signal)(...args);
					},
			},
		);
		expect(chats).toBe(1);
		expect(report.accounts[0]).toMatchObject({
			outcome: "verified",
			verification: { publishedRowsUnchanged: true },
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
	});

	it("a labelled fact whose text changes between the two listings fails the account", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, { count: 3 });
		const { migration, verified } = await modules();
		let listings = 0;
		const report = await migration.runLabelMigration(
			{ execute: true },
			{
				listFacts: async (bankId) => {
					const facts = await fake.listFacts(bankId);
					// The second listing (verification's) holds new wording for one.
					return listings++ === 0
						? facts
						: facts.map((fact) =>
								fact.id === "user-1-fact-1"
									? { ...fact, text: "likes green tea" }
									: fact,
							);
				},
				model: fake.model,
			},
		);
		expect(listings).toBe(2);
		expect(report.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "facts_changed",
			verification: { factsUnchanged: false },
		});
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(3);
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
	});

	it("one named account only; the tester named alone is skipped untouched", async () => {
		const fake = fakeNative();
		const first = await seedAccount("user-1", fake.facts, { count: 3 });
		await seedAccount("user-2", fake.facts, { count: 3 });
		const tester = await seedAccount("user-3", fake.facts, {
			count: 3,
			excluded: true,
		});
		const { migration } = await modules();
		const deps = { listFacts: fake.listFacts, model: fake.model };
		const one = await migration.runLabelMigration(
			{ execute: true, userId: "user-2" },
			deps,
		);
		expect(one.accounts.map(({ userId }) => userId)).toEqual(["user-2"]);
		expect(fake.listed).not.toContain(first.id);
		const refused = await migration.runLabelMigration(
			{ execute: true, userId: "user-3" },
			deps,
		);
		expect(refused.accounts).toEqual([
			expect.objectContaining({ outcome: "skipped", skipped: "excluded" }),
		]);
		expect(fake.listed).not.toContain(tester.id);
		const unknown = await migration.runLabelMigration(
			{ execute: true, userId: "nobody" },
			deps,
		);
		expect(unknown.accounts[0]).toMatchObject({ skipped: "unknown_account" });
	});

	it("labels a config-1 bank like any other, and verifies only once every bank of the epoch is labelled", async () => {
		const fake = fakeNative();
		const personal = await seedAccount("user-1", fake.facts, { count: 3 });
		const { db, schema, revisions, verified, migration } = await modules();
		const { eq } = await import("drizzle-orm");
		const { HINDSIGHT_ENGINE_COMMIT } = await import("./contracts");
		db.insert(schema.projects)
			.values({ id: "synthetic-project", userId: "user-1", name: "Garden" })
			.run();
		const project = revisions.ensureMemoryBank("user-1", {
			kind: "project",
			projectId: "synthetic-project",
		});
		// Still on config 1: its next delivery would upgrade it, not this run.
		db.update(schema.memoryBanks)
			.set({ nativeConfigVersion: HINDSIGHT_ENGINE_COMMIT })
			.where(eq(schema.memoryBanks.id, project.id))
			.run();
		fake.facts.set(project.id, rawFacts("project", 2, "project plan"));
		// The config-1 bank's calls fail: the account must not be verified.
		const failing = await migration.runLabelMigration(
			{ execute: true },
			{
				listFacts: fake.listFacts,
				model: () => async (_prompt, input) => {
					const facts = (input as { facts: { text: string }[] }).facts;
					if (facts.some(({ text }) => text.startsWith("project")))
						throw new Error("busy");
					return labelAll(input);
				},
			},
		);
		expect(failing.accounts[0]).toMatchObject({
			outcome: "failed",
			failure: "model_unavailable",
			banks: 2,
			configOneBanks: 1,
			labelled: 3,
		});
		expect(labelRows(personal.id).filter(({ kind }) => kind)).toHaveLength(3);
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
		const done = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		expect(done.accounts[0]).toMatchObject({
			outcome: "verified",
			alreadyLabelled: 3,
			labelled: 2,
			configOneBanks: 1,
		});
		expect(labelRows(project.id).map(({ origin }) => origin)).toEqual([
			"classifier",
			"classifier",
		]);
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
		// The migration never upgrades a bank: that would write to Hindsight.
		expect(
			db
				.select({ version: schema.memoryBanks.nativeConfigVersion })
				.from(schema.memoryBanks)
				.where(eq(schema.memoryBanks.id, project.id))
				.get()?.version,
		).toBe(HINDSIGHT_ENGINE_COMMIT);
	});

	it("asks the memory model path at background priority, in the account's tenant lane", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, { count: 2 });
		const { db, schema, migration } = await modules();
		const { tenantId } = db.select().from(schema.memoryAccounts).get() ?? {};
		const report = await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts },
		);
		expect(report.accounts[0].outcome).toBe("verified");
		expect(curationCalls).toEqual([
			[
				expect.any(AbortSignal),
				undefined,
				{ priority: "background", tenantId },
			],
		]);
	});
});

describe("the label migration's rollback", () => {
	it("returns the classifier's labels to unlabelled with their dates, and the account to today's page", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, { count: 3 });
		const { migration, verified } = await modules();
		await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		const dry = migration.rollbackLabelMigration({
			userId: "user-1",
			execute: false,
		});
		expect(dry).toMatchObject({
			outcome: "dry_run",
			labels: 3,
			epochVerified: true,
		});
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
		const done = migration.rollbackLabelMigration({
			userId: "user-1",
			execute: true,
		});
		expect(done).toMatchObject({ outcome: "done", labels: 3 });
		expect(labelRows(bank.id)).toEqual([
			{
				native_fact_id: "user-1-fact-0",
				kind: null,
				subject: null,
				origin: "extraction",
				event_at: new Date("2026-02-01T00:00:00Z").getTime(),
			},
			...[1, 2].map((i) => ({
				native_fact_id: `user-1-fact-${i}`,
				kind: null,
				subject: null,
				origin: "extraction",
				event_at: null,
			})),
		]);
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
		// Truly today's page: the verification is forgotten too, so nothing
		// of it sticks (an in-place upgrade would mark the epoch again).
		expect(accountMarks("user-1")).toEqual({
			epoch: 0,
			unverified: 0,
			verified: null,
		});
	});

	it("works with Memory off: the labels and the verification are taken back", async () => {
		const fake = fakeNative();
		const bank = await seedAccount("user-1", fake.facts, { count: 3 });
		const { migration, verified } = await modules();
		await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		h.sqlite
			.prepare("UPDATE users SET memory_enabled = 0 WHERE id = 'user-1'")
			.run();
		expect(
			migration.rollbackLabelMigration({ userId: "user-1", execute: true }),
		).toMatchObject({ outcome: "done", labels: 3 });
		expect(labelRows(bank.id).filter(({ kind }) => kind)).toHaveLength(0);
		expect(verified.memoryLabelsVerified("user-1")).toBe(false);
	});

	it("refuses an epoch the migration never ran on, and leaves its page as it is", async () => {
		const fake = fakeNative();
		await seedAccount("user-1", fake.facts, { count: 3 });
		const { migration, verified } = await modules();
		// Marked, never migrated: nothing to undo.
		expect(
			migration.rollbackLabelMigration({ userId: "user-1", execute: true }),
		).toMatchObject({ outcome: "refused", code: "label_migration_not_run" });
		expect(accountMarks("user-1")).toEqual({
			epoch: 0,
			unverified: 0,
			verified: null,
		});
		// A new epoch (Clear Memory) reads verified with no labels of the
		// migration's: a rollback must not send it to today's page.
		await migration.runLabelMigration(
			{ execute: true },
			{ listFacts: fake.listFacts, model: fake.model },
		);
		h.sqlite
			.prepare("UPDATE memory_accounts SET epoch = 1 WHERE user_id = 'user-1'")
			.run();
		expect(
			migration.rollbackLabelMigration({ userId: "user-1", execute: true }),
		).toMatchObject({ outcome: "refused", code: "label_migration_not_run" });
		expect(verified.memoryLabelsVerified("user-1")).toBe(true);
	});

	it("refuses the tester", async () => {
		const fake = fakeNative();
		await seedAccount("user-3", fake.facts, { count: 1, excluded: true });
		const { migration } = await modules();
		expect(
			migration.rollbackLabelMigration({ userId: "user-3", execute: true }),
		).toMatchObject({ outcome: "refused", code: "memory_migration_excluded" });
	});
});
