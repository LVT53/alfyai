/**
 * The label relabel's local acceptance, synthetic data only.
 *
 * A fresh app database built by the app's own migrations (146 included), three
 * synthetic accounts: A (labels from the label migration, classifier origin),
 * C (a new account, extraction's labels) and a tester-flagged one. The facts
 * are the ones config 2's extraction wrote for part 2's fixtures and for this
 * round's purchases (`results/extraction-raw.json` and part 2's recorded run),
 * each labelled as that extraction labelled it, so a purchase config 2 called
 * temporary is temporary here, and every entry rests on one fact, said long
 * ago, so a temporary fact's entry is Earlier. Hindsight is an in-process
 * stand-in that can only list; the model is Flash-Next through the shared
 * bridge (no key here), three calls at most. Prints and writes counts only: a
 * dry run, the run, every table but the label tables compared before and
 * after, the tester untouched, a resumed run, the labels against what each
 * fact is, and the rollback restoring the original rows exactly.
 *
 *   node --import tsx docs/plans/hindsight-memory/part-2-acceptance/config-3/relabel-acceptance.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../../..");
const BRIDGE = process.env.CONFIG3_BRIDGE ?? "http://127.0.0.1:18891/v1";
const IN_FLIGHT = 3;

interface Item {
	id: string;
	markers: string[];
	kind: string;
}
interface Draft {
	text: string;
	entities: string[];
}
const own = JSON.parse(readFileSync(join(HERE, "fixtures.json"), "utf8")) as {
	purchase: Item[];
};
const part2 = JSON.parse(
	readFileSync(join(HERE, "../fixtures.json"), "utf8"),
) as Record<"lasting" | "ongoing" | "temporary", Item[]>;
const raw3 = JSON.parse(
	readFileSync(join(HERE, "results/extraction-raw.json"), "utf8"),
) as Record<string, { facts?: Draft[] }>;
const raw2 = JSON.parse(
	readFileSync(join(HERE, "../results/extraction-raw.json"), "utf8"),
) as Record<string, { facts?: Draft[] }>;

const dir = mkdtempSync(join(tmpdir(), "alfyai-relabel-"));
const path = join(dir, "chat.db");
{
	const sqlite = new Database(path);
	migrate(drizzle(sqlite), { migrationsFolder: join(ROOT, "drizzle") });
	sqlite.close();
}
process.env.DATABASE_PATH = path;
const { db, sqlite } = await import("../../../../../src/lib/server/db");
const schema = await import("../../../../../src/lib/server/db/schema");
const { runLabelRelabel, rollbackLabelRelabel } = await import(
	"../../../../../src/lib/server/services/memory-profile/label-relabel"
);
const { labelsFromNativeTags } = await import(
	"../../../../../src/lib/server/services/memory-profile/fact-labels"
);
const { memoryLabelsVerified } = await import(
	"../../../../../src/lib/server/services/memory-profile/labels-verified"
);
const { NATIVE_BANK_CONFIG_2_VERSION } = await import(
	"../../../../../src/lib/server/services/memory-profile/contracts"
);

const mentions = (text: string, markers: string[]) =>
	markers.some((marker) => text.toLowerCase().includes(marker.toLowerCase()));

/** What each fact is, by id: its fixture set and the kind the fixture says. */
const truth = new Map<string, { set: string; kind: string }>();
interface Seed {
	text: string;
	kind: string | null;
	subject: string | null;
	set: string;
	fixtureKind: string;
}
const seeds: Seed[] = [];
for (const set of ["lasting", "ongoing", "temporary"] as const)
	for (const item of part2[set])
		for (const fact of raw2[`v2:${set}:${item.id}:0`]?.facts ?? [])
			if (mentions(fact.text, item.markers)) {
				const labels = labelsFromNativeTags(fact.entities, "personal");
				seeds.push({ text: fact.text, ...labels, set, fixtureKind: item.kind });
			}
for (const item of own.purchase)
	for (const fact of raw3[`v2:purchase:${item.id}:0`]?.facts ?? [])
		if (mentions(fact.text, item.markers)) {
			const labels = labelsFromNativeTags(fact.entities, "personal");
			seeds.push({ text: fact.text, ...labels, set: "purchase", fixtureKind: "lasting" });
		}

const listed = new Map<string, { id: string; text: string; fact_type: string }[]>();
const reads: string[] = [];

function seedAccount(
	email: string,
	origin: "classifier" | "extraction",
	options: { excluded?: boolean } = {},
) {
	const userId = randomUUID();
	db.insert(schema.users)
		.values({
			id: userId,
			email,
			passwordHash: "synthetic",
			memoryMigrationExcluded: options.excluded ?? false,
		})
		.run();
	db.insert(schema.memoryAccounts)
		.values({
			userId,
			tenantId: randomUUID(),
			authority: "hindsight",
			// A: the label migration verified it; C: a new account that never needed it.
			labelsVerifiedEpoch: origin === "classifier" ? 0 : null,
		})
		.run();
	const bankId = randomUUID();
	db.insert(schema.memoryBanks)
		.values({
			id: bankId,
			userId,
			scopeKey: "personal",
			epoch: 0,
			generation: "g1",
			nativeConfigVersion: NATIVE_BANK_CONFIG_2_VERSION,
		})
		.run();
	const facts = seeds.map((seed) => {
		const id = randomUUID();
		truth.set(id, { set: seed.set, kind: seed.fixtureKind });
		return { id, text: seed.text, fact_type: "world", seed };
	});
	listed.set(bankId, [
		...facts.map(({ id, text, fact_type }) => ({ id, text, fact_type })),
		{ id: randomUUID(), text: "observation", fact_type: "observation" },
	]);
	for (const { id, text, seed } of facts) {
		// One entry per fact, said in September: temporary ones are Earlier now.
		db.insert(schema.memoryPublishedRows)
			.values({
				id: randomUUID(),
				bankId,
				generation: "g1",
				epoch: 0,
				nativeId: randomUUID(),
				text,
				nativeText: text,
				sourceIdsJson: JSON.stringify([id]),
				sourceFingerprintsJson: JSON.stringify([{ id, text }]),
				updatedAt: new Date("2026-10-01T00:00:00Z"),
			})
			.run();
		db.insert(schema.memorySourceRevisions)
			.values({
				id: randomUUID(),
				bankId,
				userId,
				epoch: 0,
				eventId: `event-${id}`,
				lineageId: `lineage-${id}`,
				text: "synthetic",
				context: "{}",
				textHash: "hash",
				assertedAt: new Date("2026-09-01T00:00:00Z"),
				state: "accepted",
				acknowledgedFactsJson: JSON.stringify([{ id, text }]),
			})
			.run();
		db.insert(schema.memoryFactLabels)
			.values({
				bankId,
				nativeFactId: id,
				kind: seed.kind,
				subject: seed.subject,
				origin,
				eventAt: null,
			})
			.run();
	}
	return { userId, bankId };
}

const a = seedAccount("synthetic-a@example.invalid", "classifier");
const c = seedAccount("synthetic-c@example.invalid", "extraction");
const tester = seedAccount("synthetic-tester@example.invalid", "classifier", {
	excluded: true,
});

function snapshot(except: string[]): string {
	const tables = sqlite
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as { name: string }[];
	return JSON.stringify(
		tables
			.filter(({ name }) => !except.includes(name))
			.map(({ name }) => [name, sqlite.prepare(`SELECT * FROM "${name}"`).all()]),
	);
}
const LABEL_TABLES = ["memory_fact_labels", "memory_label_relabels"];
const labelRows = (bankId: string) =>
	JSON.stringify(
		sqlite
			.prepare(
				"SELECT native_fact_id AS id, kind, subject, origin, event_at FROM memory_fact_labels WHERE bank_id = ? ORDER BY native_fact_id",
			)
			.all(bankId),
	);

let inFlight = 0;
let maxInFlight = 0;
let calls = 0;
const model = () => async (
	prompt: string,
	input: unknown,
	schemaFor: Record<string, unknown>,
) => {
	calls++;
	inFlight++;
	maxInFlight = Math.max(maxInFlight, inFlight);
	try {
		const response = await fetch(`${BRIDGE}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "qwen3-6-27b",
				messages: [
					{ role: "system", content: prompt },
					{ role: "user", content: JSON.stringify(input) },
				],
				temperature: 0,
				max_tokens: 8192,
				response_format: {
					type: "json_schema",
					json_schema: { name: "memory_labels", schema: schemaFor, strict: true },
				},
				chat_template_kwargs: { enable_thinking: false },
			}),
			signal: AbortSignal.timeout(300_000),
		});
		if (!response.ok) throw new Error(`model_${response.status}`);
		const body = (await response.json()) as {
			choices: Array<{ message: { content: string } }>;
		};
		return JSON.parse(body.choices[0].message.content);
	} finally {
		inFlight--;
	}
};
const deps = {
	listFacts: async (bankId: string) => {
		reads.push(bankId);
		return listed.get(bankId) ?? [];
	},
	model,
	concurrency: IN_FLIGHT,
};

const labelsBeforeA = labelRows(a.bankId);
const labelsBeforeC = labelRows(c.bankId);
const testerBefore = labelRows(tester.bankId);
const dry = await runLabelRelabel({ execute: false }, deps);
const before = snapshot(LABEL_TABLES);
const started = Date.now();
const run = await runLabelRelabel({ execute: true }, deps);
const seconds = Math.round((Date.now() - started) / 1000);
const unchanged = snapshot(LABEL_TABLES) === before;
const callsAfterRun = calls;
const again = await runLabelRelabel({ execute: true }, deps);
const resumedCalls = calls - callsAfterRun;

// Which facts moved, against what each fact is.
const moved = { purchase: [0, 0], temporaryFixtures: [0, 0], other: [0, 0] };
/** The facts that were temporary and are not now: fixture set, what the fixture says, the new kind. */
const movedDetail: Record<string, number> = {};
for (const bankId of [a.bankId, c.bankId])
	for (const row of JSON.parse(labelRows(bankId)) as {
		id: string;
		kind: string;
		origin: string;
	}[]) {
		const was = JSON.parse(bankId === a.bankId ? labelsBeforeA : labelsBeforeC).find(
			(r: { id: string }) => r.id === row.id,
		);
		if (was.kind !== "temporary") continue;
		const set = truth.get(row.id)?.set;
		const bucket =
			set === "purchase"
				? moved.purchase
				: set === "temporary"
					? moved.temporaryFixtures
					: moved.other;
		bucket[1]++;
		if (row.kind !== "temporary") {
			bucket[0]++;
			const key = `${set} (fixture says ${truth.get(row.id)?.kind}) -> ${row.kind}`;
			movedDetail[key] = (movedDetail[key] ?? 0) + 1;
		}
	}
const rollbackDry = rollbackLabelRelabel({ userId: a.userId, execute: false });
const rollback = rollbackLabelRelabel({ userId: a.userId, execute: true });
const restoredExactly = labelRows(a.bankId) === labelsBeforeA;
const rollbackTwice = rollbackLabelRelabel({ userId: a.userId, execute: true });
const rerun = await runLabelRelabel({ execute: true, userId: a.userId }, deps);

const summary = (r: Awaited<ReturnType<typeof runLabelRelabel>>) => ({
	outcome: r.outcome,
	totals: r.totals,
	accounts: r.accounts.map(
		({ outcome, skipped, failure, facts, temporary, toRelabel, calls, reclassified, moved, stillTemporary, unanswered, before, whole, verification }) => ({
			outcome,
			skipped,
			failure,
			facts,
			temporary,
			toRelabel,
			calls,
			reclassified,
			moved,
			stillTemporary,
			unanswered,
			before: before && { entries: before.entries, earlierEntries: before.earlierEntries },
			after: whole && { entries: whole.entries, earlierEntries: whole.earlierEntries },
			verification,
		}),
	),
});
const result = {
	facts: seeds.length,
	dryRun: summary(dry),
	run: { ...summary(run), seconds, modelCalls: callsAfterRun, maxInFlight },
	everyOtherTableUnchanged: unchanged,
	// [moved, of those that were temporary] by what the fact truly is.
	temporaryFactsMoved: moved,
	movedDetail,
	tester: {
		read: reads.includes(tester.bankId),
		labelsUnchanged: labelRows(tester.bankId) === testerBefore,
		verifiedStillAsSeeded: memoryLabelsVerified(tester.userId),
	},
	resumed: { skipped: again.totals.skipped, modelCalls: resumedCalls },
	rollback: {
		dryRun: rollbackDry,
		done: rollback,
		restoredExactly,
		secondTime: { outcome: rollbackTwice.outcome, code: rollbackTwice.code },
		cLabelsStillRelabelled: labelRows(c.bankId) !== labelsBeforeC,
		rerunAfterRollback: summary(rerun).accounts[0],
	},
};
writeFileSync(
	join(HERE, "results/relabel-acceptance.json"),
	`${JSON.stringify(result, null, "\t")}\n`,
);
console.log(JSON.stringify(result, null, 2));
sqlite.close();
rmSync(dir, { recursive: true, force: true });
