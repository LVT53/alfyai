/**
 * The label migration's local acceptance, synthetic data only.
 *
 * A fresh app database built by the app's own migrations, three synthetic
 * accounts (two ordinary, one tester-flagged) whose banks hold part 2's
 * synthetic statements as raw facts, published rows and dated labels.
 * Hindsight is an in-process stand-in that can only list (the part 2 local
 * engine is not installed on this Mac any more, and the migration only
 * lists); the model is Flash-Next itself, called directly with ALFY_API_KEY
 * (read from ~/.dsh/.env, never printed), at most three calls in flight.
 * Prints and writes counts only: a dry run, the run, every table but the
 * label store compared before and after, the tester untouched, a resumed run,
 * and the labels against the fixtures' expected kind and subject.
 *
 *   node --import tsx docs/plans/hindsight-memory/label-migration-acceptance/run.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../../..");
const IN_FLIGHT = 3;

interface Item {
	id: string;
	lang: "en" | "hu";
	user: string;
	kind: string;
	subject: string;
}
const fixtures = JSON.parse(
	readFileSync(join(HERE, "../part-2-acceptance/fixtures.json"), "utf8"),
) as Record<"lasting" | "ongoing" | "temporary" | "project", Item[]>;

function alfyKey(): string {
	for (const line of readFileSync(join(homedir(), ".dsh/.env"), "utf8").split(
		"\n",
	))
		if (line.startsWith("ALFY_API_KEY="))
			return line
				.slice("ALFY_API_KEY=".length)
				.trim()
				.replace(/^["']|["']$/g, "");
	throw new Error("ALFY_API_KEY missing");
}

const dir = mkdtempSync(join(tmpdir(), "alfyai-label-migration-"));
const path = join(dir, "chat.db");
{
	const sqlite = new Database(path);
	migrate(drizzle(sqlite), { migrationsFolder: join(ROOT, "drizzle") });
	sqlite.close();
}
process.env.DATABASE_PATH = path;
const { db, sqlite } = await import("../../../../src/lib/server/db");
const schema = await import("../../../../src/lib/server/db/schema");
const { runLabelMigration } = await import(
	"../../../../src/lib/server/services/memory-profile/label-migration"
);
const { memoryLabelsVerified } = await import(
	"../../../../src/lib/server/services/memory-profile/labels-verified"
);
const { HINDSIGHT_ENGINE_COMMIT, NATIVE_BANK_CONFIG_VERSION } = await import(
	"../../../../src/lib/server/services/memory-profile/contracts"
);

/** Raw facts per bank, as the stand-in lists them, and what each should be. */
const listed = new Map<string, { id: string; text: string; fact_type: string }[]>();
const expected = new Map<string, { kind: string; subject: string }>();
const reads: string[] = [];

function seedAccount(
	email: string,
	items: { set: keyof typeof fixtures; indices: number[] }[],
	options: { excluded?: boolean; project?: number[] } = {},
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
			labelsUnverifiedEpoch: 0,
		})
		.run();
	const bank = (scopeKey: string, version: string, facts: Item[]) => {
		const bankId = randomUUID();
		db.insert(schema.memoryBanks)
			.values({
				id: bankId,
				userId,
				scopeKey,
				epoch: 0,
				generation: "g1",
				nativeConfigVersion: version,
			})
			.run();
		const raw = facts.map((item) => {
			const id = randomUUID();
			expected.set(id, { kind: item.kind, subject: item.subject });
			return { id, text: item.user, fact_type: "world" };
		});
		listed.set(bankId, [
			...raw,
			{ id: randomUUID(), text: "observation", fact_type: "observation" },
		]);
		// One published entry per three facts, and a dated label on the first.
		for (let i = 0; i < raw.length; i += 3) {
			const support = raw.slice(i, i + 3);
			db.insert(schema.memoryPublishedRows)
				.values({
					id: randomUUID(),
					bankId,
					generation: "g1",
					epoch: 0,
					nativeId: randomUUID(),
					text: support.map(({ text }) => text).join(" "),
					nativeText: support.map(({ text }) => text).join(" "),
					sourceIdsJson: JSON.stringify(support.map(({ id }) => id)),
					sourceFingerprintsJson: JSON.stringify(
						support.map(({ id, text }) => ({ id, text })),
					),
					updatedAt: new Date("2026-10-01T00:00:00Z"),
				})
				.run();
		}
		db.insert(schema.memoryFactLabels)
			.values({
				bankId,
				nativeFactId: raw[0].id,
				kind: null,
				subject: null,
				origin: "extraction",
				eventAt: new Date("2026-10-05T00:00:00Z"),
			})
			.run();
		return bankId;
	};
	const personal = items.flatMap(({ set, indices }) =>
		indices.map((i) => fixtures[set][i]),
	);
	const banks = [bank("personal", NATIVE_BANK_CONFIG_VERSION, personal)];
	if (options.project) {
		const projectId = randomUUID();
		db.insert(schema.projects)
			.values({ id: projectId, userId, name: "Synthetic project" })
			.run();
		// A bank no delivery has upgraded yet: config 1.
		banks.push(
			bank(
				`project:${projectId}`,
				HINDSIGHT_ENGINE_COMMIT,
				options.project.map((i) => fixtures.project[i]),
			),
		);
	}
	return { userId, banks };
}

const half = (start: number) => [
	start,
	start + 1,
	start + 2,
	start + 3,
	start + 4,
	start + 10,
	start + 11,
	start + 12,
	start + 13,
	start + 14,
];
const a = seedAccount(
	"synthetic-a@example.invalid",
	[
		{ set: "lasting", indices: half(0) },
		{ set: "ongoing", indices: half(0) },
		{ set: "temporary", indices: half(0) },
	],
	{ project: half(0) },
);
const b = seedAccount("synthetic-b@example.invalid", [
	{ set: "lasting", indices: half(5) },
	{ set: "ongoing", indices: half(5) },
	{ set: "temporary", indices: half(5) },
]);
const tester = seedAccount(
	"synthetic-tester@example.invalid",
	[{ set: "lasting", indices: half(0) }],
	{ excluded: true },
);

/** Every table but the label store, the labels mark left out. */
function snapshot(): string {
	const tables = sqlite
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'memory_fact_labels' ORDER BY name",
		)
		.all() as { name: string }[];
	return JSON.stringify(
		tables.map(({ name }) => [
			name,
			(
				sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<
					string,
					unknown
				>[]
			).map(({ labels_unverified_epoch: _mark, ...row }) => row),
		]),
	);
}
const labelRows = (bankId: string) =>
	sqlite
		.prepare(
			"SELECT native_fact_id AS id, kind, subject, origin FROM memory_fact_labels WHERE bank_id = ?",
		)
		.all(bankId) as {
		id: string;
		kind: string | null;
		subject: string | null;
		origin: string;
	}[];

const key = alfyKey();
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
		const response = await fetch(
			"https://inference.alfycomms.com/v1/chat/completions",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${key}`,
				},
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
			},
		);
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

const started = Date.now();
const dry = await runLabelMigration({ execute: false }, deps);
const before = snapshot();
const testerLabelsBefore = JSON.stringify(labelRows(tester.banks[0]));
const run = await runLabelMigration({ execute: true }, deps);
const runMs = Date.now() - started;
const unchanged = snapshot() === before;
const callsAfterRun = calls;
const again = await runLabelMigration({ execute: true }, deps);

// The labels against what the fixtures say each statement is.
let kindRight = 0;
let subjectRight = 0;
let labelled = 0;
let lastingMislabelled = 0;
let lastingTotal = 0;
for (const bankId of [...a.banks, ...b.banks])
	for (const row of labelRows(bankId)) {
		const want = expected.get(row.id);
		if (!want || !row.kind) continue;
		labelled++;
		if (row.kind === want.kind) kindRight++;
		if (row.subject === want.subject) subjectRight++;
		if (want.kind === "lasting") {
			lastingTotal++;
			if (row.kind !== "lasting") lastingMislabelled++;
		}
	}
const result = {
	dryRun: { outcome: dry.outcome, totals: dry.totals },
	run: {
		outcome: run.outcome,
		totals: run.totals,
		accounts: run.accounts.map(
			({ outcome, skipped, failure, banks, configOneBanks, facts, labelled, byKind, bySubject, unlabelled, verification }) => ({
				outcome,
				skipped,
				failure,
				banks,
				configOneBanks,
				facts,
				labelled,
				byKind,
				bySubject,
				unlabelled,
				verification,
			}),
		),
		seconds: Math.round(runMs / 1000),
		modelCalls: callsAfterRun,
		maxInFlight,
	},
	everyOtherTableUnchanged: unchanged,
	tester: {
		read: reads.some((bankId) => tester.banks.includes(bankId)),
		labelsUnchanged: JSON.stringify(labelRows(tester.banks[0])) === testerLabelsBefore,
		verified: memoryLabelsVerified(tester.userId),
	},
	verified: {
		a: memoryLabelsVerified(a.userId),
		b: memoryLabelsVerified(b.userId),
	},
	resumed: {
		outcome: again.outcome,
		skipped: again.totals.skipped,
		modelCalls: calls - callsAfterRun,
		labelled: again.totals.labelled,
	},
	accuracy: {
		labelled,
		kindRight,
		subjectRight,
		lastingTotal,
		lastingMislabelled,
	},
};
writeFileSync(join(HERE, "results.json"), `${JSON.stringify(result, null, "\t")}\n`);
console.log(JSON.stringify(result, null, 2));
sqlite.close();
rmSync(dir, { recursive: true, force: true });
