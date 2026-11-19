import assert from "node:assert/strict";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const scratch = mkdtempSync(join(tmpdir(), "alfyai-paired-migration-"));
chmodSync(scratch, 0o700);
const marker = "alfyai-memory-synthetic-v1";
writeFileSync(join(scratch, ".alfyai-memory-synthetic"), marker, {
	mode: 0o600,
});
process.env.DATABASE_PATH = join(scratch, "rehearsal.db");
assert.equal(process.argv.length, 2);
const fixtureBytes = readFileSync(new URL("fixture.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString()) as {
	sources: Array<{ scope: string; day: string; text: string }>;
	questions: Array<{ id: string; scope: string; text: string }>;
};
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const write = (name: string, data: unknown) =>
	writeFileSync(join(scratch, name), JSON.stringify(data, null, 2) + "\n", {
		mode: 0o600,
		flag: "wx",
	});

const { db, sqlite } = await import("../../../../src/lib/server/db/index");
const schema = await import("../../../../src/lib/server/db/schema");
const { getConfig, refreshConfig } = await import(
	"../../../../src/lib/server/config-store"
);
migrate(db, { migrationsFolder: resolve("drizzle") });
chmodSync(process.env.DATABASE_PATH, 0o600);
await refreshConfig();
const config = getConfig();
const model = config.model1;
assert.equal(config.memoryJudgeModel, "model1");
assert.equal(config.memoryJudgeDryRun, false);
assert.equal(config.hindsightWorkerEnabled, true);
assert.equal(config.hindsightRestoreHold, false);
assert.equal(config.hindsightUrl, "http://127.0.0.1:18894");
assert.ok(model.apiKey, "Synthetic local provider key is unavailable");
const modelUrl = new URL(
	model.baseUrl.replace(/\/+$/, "") + "/chat/completions",
);
assert.equal(modelUrl.href, "http://192.168.1.96:30000/v1/chat/completions");
assert.equal(model.modelName, "qwen3-6-27b");
assert.ok(!modelUrl.username && !modelUrl.password);
const userId = `paired-memory-${randomUUID()}`;
const email = `${userId}@test.invalid`;
db.insert(schema.users)
	.values({
		id: userId,
		email,
		passwordHash: "synthetic-no-login",
		memoryEnabled: true,
	})
	.run();
assert.deepEqual(
	db
		.select({ id: schema.users.id, email: schema.users.email })
		.from(schema.users)
		.all(),
	[{ id: userId, email }],
);
const { runMemoryJudgeOnSegment } = await import(
	"../../../../src/lib/server/services/memory-judge/index"
);
const { getMemoryContext } = await import(
	"../../../../src/lib/server/services/memory-context"
);
const { recordHistoryImportChoice } = await import(
	"../../../../src/lib/server/services/memory-profile/migration-policy"
);
const {
	inspectMemoryMigration,
	prepareMemoryMigration,
	verifyMemoryMigration,
	cutoverMemoryMigration,
} = await import(
	"../../../../src/lib/server/services/memory-profile/migration"
);
const { memoryDeliveryJob } = await import(
	"../../../../src/lib/server/services/memory-profile/delivery-job"
);
const { nativeMemoryClient } = await import(
	"../../../../src/lib/server/services/memory-profile/hindsight-client"
);
const { drain } = await import("../../../../src/lib/server/services/jobs");

const projectByScope = new Map(
	["cedar", "birch"].map((scope) => {
		const id = randomUUID();
		db.insert(schema.projects).values({ id, userId, name: scope }).run();
		return [scope, id] as const;
	}),
);
function chat(scope: string, title: string): string {
	const id = randomUUID();
	db.insert(schema.conversations)
		.values({
			id,
			title,
			userId,
			projectId: projectByScope.get(scope) ?? null,
			memoryIncognito: scope === "incognito",
		})
		.run();
	return id;
}

const judge = [];
for (const [index, source] of fixture.sources.entries()) {
	const conversationId = chat(source.scope, `Synthetic assertion ${index + 1}`);
	const assertedAt = new Date(`${source.day}T12:00:00Z`);
	db.insert(schema.messages)
		.values([
			{
				id: randomUUID(),
				conversationId,
				role: "user",
				messageSequence: 1,
				content: source.text,
				createdAt: assertedAt,
			},
			{
				id: randomUUID(),
				conversationId,
				role: "assistant",
				messageSequence: 2,
				content: "Understood.",
				createdAt: assertedAt,
			},
		])
		.run();
	const result = await runMemoryJudgeOnSegment({
		userId,
		conversationId,
		trigger: "explicit",
	});
	judge.push({ scope: source.scope, result });
	if (source.scope === "incognito") assert.equal(result.status, "empty");
	else assert.equal(result.status, "ran", "Real legacy intake did not finish");
}
await recordHistoryImportChoice(userId, {
	choice: "include",
	requestId: "synthetic-consent",
});
const probes = new Map(
	fixture.questions.map(({ id, scope }) => [
		id,
		chat(scope, `Synthetic probe ${id}`),
	]),
);
const tables = sqlite
	.prepare(
		"select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
	)
	.all() as Array<{ name: string }>;
function fingerprint(): string {
	return hash(
		tables.map(({ name }) => [
			name,
			sqlite.prepare(`select * from "${name.replaceAll('"', '""')}"`).all(),
		]),
	);
}

async function nativeFingerprint(): Promise<string> {
	const account = db
		.select()
		.from(schema.memoryAccounts)
		.where(eq(schema.memoryAccounts.userId, userId))
		.get();
	assert.ok(account?.authority === "hindsight");
	const banks = db
		.select()
		.from(schema.memoryBanks)
		.where(eq(schema.memoryBanks.userId, userId))
		.all();
	return hash(
		await Promise.all(
			banks.map(async ({ id }) => {
				const client = nativeMemoryClient(
					id,
					account.tenantId,
					AbortSignal.timeout(30_000),
				);
				const pending = await client.pendingOperations();
				assert.deepEqual(pending, []);
				const rows = (await client.list()).sort((a, b) =>
					a.id.localeCompare(b.id),
				);
				return { id, rows };
			}),
		),
	);
}

const settings = { temperature: 0, top_p: 1, max_tokens: 400 };
const answerInstruction =
	"Answer in the language of the question from the provided current Memory evidence only. State explicitly when a requested fact is unknown. Preserve the subject, time, polarity and project scope of each fact. Distinguish current information from earlier information and personal facts from what applies only within a project. A similar named object is not the same object. Keep the answer concise.";
async function answer(prompt: string, scope: string, evidence: string | null) {
	const started = performance.now();
	const response = await fetch(modelUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${model.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: model.modelName,
			...settings,
			chat_template_kwargs: { enable_thinking: false },
			messages: [
				{ role: "system", content: answerInstruction },
				{
					role: "user",
					content: JSON.stringify({ currentScope: scope, evidence, prompt }),
				},
			],
		}),
		redirect: "error",
		signal: AbortSignal.timeout(180_000),
	});
	assert.ok(response.ok, `Answer provider HTTP ${response.status}`);
	const data = await response.json();
	const output = data.choices?.[0]?.message?.content;
	assert.ok(typeof output === "string" && output.trim());
	return {
		output,
		latencyMs: Math.round(performance.now() - started),
		finish: data.choices[0].finish_reason,
		usage: data.usage,
	};
}

async function probe(arm: "legacy" | "native") {
	const before = fingerprint();
	const nativeBefore = arm === "native" ? await nativeFingerprint() : null;
	const answers = [];
	for (const { id, text, scope } of fixture.questions) {
		const conversationId = probes.get(id);
		assert.ok(conversationId);
		const started = performance.now();
		// Keep application telemetry/expiry and reset-row housekeeping uncommitted.
		// Only one probe uses this dedicated process/connection at a time.
		sqlite.exec("BEGIN");
		let memory;
		try {
			memory = await getMemoryContext({
				userId,
				conversationId,
				mode: "persona",
				query: text,
			});
		} finally {
			sqlite.exec("ROLLBACK");
		}
		const retrievalMs = Math.round(performance.now() - started);
		assert.equal(memory.mode, "persona");
		assert.equal(
			memory.source,
			arm === "legacy" ? "active_memory_profile" : "hindsight",
		);
		assert.notEqual(memory.status, "error");
		assert.equal(
			fingerprint(),
			before,
			"A recall probe persisted an application change",
		);
		answers.push({
			id,
			scope,
			recallStatus: memory.status,
			retrievalMs,
			evidence: memory.content,
			candidates: memory.evidenceCandidates,
			...(await answer(text, scope, memory.content)),
		});
	}
	const after = fingerprint();
	assert.equal(after, before);
	const nativeAfter = arm === "native" ? await nativeFingerprint() : null;
	assert.equal(
		nativeAfter,
		nativeBefore,
		"Native inventory changed while answering",
	);
	return { answers, before, after, nativeBefore, nativeAfter };
}

const inventory = inspectMemoryMigration(userId);
const eligibility = {
	eligible: inventory.sources.filter(
		(source) => source.eligibility === "eligible",
	).length,
	excluded: inventory.sources.filter(
		(source) => source.eligibility === "excluded",
	).length,
	uncertain: inventory.sources.filter(
		(source) => source.eligibility === "uncertain",
	).length,
};
assert.equal(eligibility.eligible, 4);
assert.equal(eligibility.uncertain, 0);
console.log(
	JSON.stringify({ phase: "legacy-baseline", scratch, eligibility, judge }),
);
const legacy = await probe("legacy");
write("legacy.private.json", legacy);
const prepared = await prepareMemoryMigration(userId);
console.log(JSON.stringify({ phase: "prepared", manifest: prepared.id }));
const deadline = Date.now() + 360_000;
let verified = verifyMemoryMigration(userId, prepared.id);
while (!verified.ready && Date.now() < deadline) {
	await drain(memoryDeliveryJob);
	verified = verifyMemoryMigration(userId, prepared.id);
	if (!verified.ready) await wait(500);
}
assert.equal(verified.ready, true, JSON.stringify(verified));
cutoverMemoryMigration(userId, prepared.id);
const native = await probe("native");
write("native.private.json", native);

const order = [];
const key: Record<string, string> = {};
for (const { id } of fixture.questions) {
	const pair = [
		legacy.answers.find((item) => item.id === id),
		native.answers.find((item) => item.id === id),
	] as const;
	assert.ok(pair[0] && pair[1]);
	const first = randomInt(2);
	const tokenA = randomUUID();
	const tokenB = randomUUID();
	order.push({
		id,
		answers: [
			{ token: tokenA, text: pair[first]?.output },
			{ token: tokenB, text: pair[1 - first]?.output },
		],
	});
	key[tokenA] = first === 0 ? "legacy" : "native";
	key[tokenB] = first === 0 ? "native" : "legacy";
}
write("blind-answers.json", order);
write("blind-key.private.json", key);
const report = {
	fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
	model: model.modelName,
	settings,
	eligibility,
	judge,
	manifest: prepared.id,
	cases: fixture.questions.length,
	persistedProbeMessages: db
		.select()
		.from(schema.messages)
		.all()
		.filter((row) => [...probes.values()].includes(row.conversationId)).length,
	unchangedApplication:
		legacy.before === legacy.after && native.before === native.after,
	unchangedNativeInventoryDuringNativeProbes:
		native.nativeBefore === native.nativeAfter,
};
assert.equal(report.persistedProbeMessages, 0);
write("receipt.json", report);
console.log(JSON.stringify({ phase: "complete", scratch, ...report }));
sqlite.close();
