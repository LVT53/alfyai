import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { and, eq } from "drizzle-orm";

type Session = { day: string; project: string | null; text: string };
type Check = { day: string; project: string | null; query: string };
type Profile = { id: string; lang: string; sessions: Session[]; checks: Check[] };
type SessionEvent = Session & { kind: "source"; index: number };
type CheckEvent = Check & { kind: "check"; index: number };

// The 2026-11-24 regression run used its own scratch folder and a Hindsight on another port.
const scratch = process.env.ALFYAI_BENCH_SCRATCH ?? "/tmp/alfyai-integrated-memory";
const benchmark = "docs/plans/hindsight-memory/integrated-native-benchmark";
const baseline = "docs/plans/hindsight-memory/alfyai-baseline";
const id = process.argv[2] ?? "";
assert.match(id, /^p0[1-6]$/);
assert.equal(process.argv.length, 3);
mkdirSync(scratch, { recursive: true });
const dbPath = path.join(scratch, `${id}.db`);
assert.ok(!existsSync(dbPath) || lstatSync(dbPath).isFile());
Object.assign(process.env, {
	DATABASE_PATH: dbPath,
	SESSION_SECRET: "integrated-synthetic-memory-benchmark-only",
	HINDSIGHT_URL: process.env.ALFYAI_BENCH_HINDSIGHT_URL ?? "http://127.0.0.1:18890",
	HINDSIGHT_ALLOWED_URLS: "",
	HINDSIGHT_TENANT_KEYS: "{}",
	HINDSIGHT_TENANT_MASTER_KEYS: JSON.stringify({ synthetic: "ab".repeat(32) }),
	HINDSIGHT_TENANT_ACTIVE_KEY: "synthetic",
	HINDSIGHT_WORKER_ENABLED: "true",
	HINDSIGHT_NEW_ACCOUNTS_ENABLED: "true",
	HINDSIGHT_RESTORE_HOLD: "false",
	HINDSIGHT_CONCURRENCY: "1",
	HINDSIGHT_CURATION_MODEL: "",
	MODEL_1_NAME: "qwen3-6-27b",
	MODEL_1_BASEURL: "http://127.0.0.1:18891/v1",
	MODEL_1_API_KEY: "synthetic-local-proxy",
	MODEL_2_ENABLED: "false",
	TZ: "UTC",
});

const caseBuffer = readFileSync(path.join(baseline, "cases.json"));
const fixtureHash = createHash("sha256").update(caseBuffer).digest("hex");
const frozen = (JSON.parse(caseBuffer.toString()) as Profile[]).find((p) => p.id === id);
assert.ok(frozen);
// Construct a gold-free input before preparing any event or request.
const profile: Profile = {
	id, lang: frozen.lang,
	sessions: frozen.sessions.map(({ day, project, text }) => ({ day, project, text })),
	checks: frozen.checks.map(({ day, project, query }) => ({ day, project, query })),
};
const events = [
	...profile.sessions.map((s, index): SessionEvent => ({ ...s, kind: "source", index })),
	...profile.checks.map((c, index): CheckEvent => ({ ...c, kind: "check", index })),
].sort((a, b) => a.day.localeCompare(b.day) ||
	(a.kind === b.kind ? a.index - b.index : a.kind === "source" ? -1 : 1));

const WallDate = Date;
let virtual = WallDate.parse("2026-08-31T12:00:00Z");
let wallStarted = WallDate.now();
class BenchDate extends WallDate {
	constructor(...args: ConstructorParameters<DateConstructor> | []) {
		super(...(args.length ? args : [BenchDate.now()]) as [number]);
	}
	static now() {
		return virtual + WallDate.now() - wallStarted;
	}
}
globalThis.Date = BenchDate as DateConstructor;
function clock(iso: string) {
	virtual = WallDate.parse(iso);
	wallStarted = WallDate.now();
}

const { db, sqlite } = await import("../../../../src/lib/server/db/index");
const schema = await import("../../../../src/lib/server/db/schema");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
migrate(db, { migrationsFolder: path.resolve("drizzle") });
sqlite.function("unixepoch", () => Math.floor(Date.now() / 1000));
const { createConversation } = await import("../../../../src/lib/server/services/conversations");
const { createMessage } = await import("../../../../src/lib/server/services/messages");
const { initializeNewMemoryAccount } = await import("../../../../src/lib/server/services/memory-profile/migration");
const { getMemoryAccount } = await import("../../../../src/lib/server/services/memory-profile/revisions");
const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } = await import("../../../../src/lib/server/services/memory-profile/chat-delivery");
const { isHistoricalMemorySourceEligible } = await import("../../../../src/lib/server/services/memory-profile/history-eligibility");
const { memoryDeliveryJob } = await import("../../../../src/lib/server/services/memory-profile/delivery-job");
const { readPublishedMemory } = await import("../../../../src/lib/server/services/memory-profile/publication");
const { drain } = await import("../../../../src/lib/server/services/jobs");
const { getMemoryContext } = await import("../../../../src/lib/server/services/memory-context");
const { answer } = await import("../alfyai-baseline/answer.cjs");

const {
	users, projects, conversations, messages, memoryBanks, memoryControlIntervals,
	memoryDeliveryJobs, memoryDeliveryAttempts, memorySourceRevisions, memoryActions,
} = schema;
const userId = `integrated-bench-${id}`;
const projectId = (project: string) => `${userId}-${project}`;
const resultPath = path.join(scratch, `${id}-results.json`);
const retained = "Acknowledged."; // The completed-turn seam requires a persisted assistant response.
const sourceHashes = JSON.parse(readFileSync(path.join(benchmark, "source-fingerprint.json"), "utf8"));
const result = existsSync(resultPath)
	? JSON.parse(readFileSync(resultPath, "utf8"))
	: { id, lang: profile.lang, fixtureHash, sourceHashes, events: [], interruptions: [] };
assert.equal(result.fixtureHash, fixtureHash);
assert.deepEqual(result.sourceHashes, sourceHashes);

function save() {
	const temporary = `${resultPath}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(result, null, 2) + "\n");
	renameSync(temporary, resultPath);
}

function enroll() {
	db.transaction((tx) => {
		const present = tx.select().from(users).where(eq(users.id, userId)).get();
		if (present) return;
		tx.insert(users).values({
			id: userId,
			email: `${userId}@example.invalid`,
			passwordHash: "synthetic-no-login",
			memoryEnabled: true,
			uiLanguage: profile.lang,
			timeZone: "Europe/Dublin",
			createdAt: new Date(),
			updatedAt: new Date(),
		}).run();
		initializeNewMemoryAccount(tx, userId);
		for (const name of ["Cedar", "Atlas"]) {
			tx.insert(projects).values({
				id: projectId(name.toLowerCase()), userId, name,
				createdAt: new Date(), updatedAt: new Date(),
			}).run();
		}
	});
	const account = getMemoryAccount(userId);
	assert.equal(account?.authority, "hindsight");
	assert.equal(account.lifecycleState, "active");
	const intervals = db.select().from(memoryControlIntervals)
		.where(eq(memoryControlIntervals.userId, userId)).all();
	assert.equal(intervals.length, 1);
	assert.equal(intervals[0].enabled, true);
	assert.ok(events.every(({ day }) =>
		intervals[0].startedAt <= new Date(`${day}T12:00:00Z`)));
	return { tenantId: account.tenantId, intervals };
}

function snapshot() {
	return db.select().from(memoryBanks).where(eq(memoryBanks.userId, userId))
		.all().map(({ id: bankId, scopeKey, generation, revision, status }) => ({
			bankId, scopeKey, generation, revision, status,
			published: readPublishedMemory(userId, bankId).map((row) => ({
				id: row.nativeId,
				text: row.text,
				fingerprints: JSON.parse(row.sourceFingerprintsJson),
			})),
		}));
}

async function chatFor(event: SessionEvent | CheckEvent) {
	const title = `Synthetic ${id} ${event.kind} ${event.index}`;
	const expectedProject = event.project ? projectId(event.project) : null;
	const existing = db.select().from(conversations).where(and(
		eq(conversations.userId, userId), eq(conversations.title, title),
	)).get();
	assert.ok(!existing || existing.projectId === expectedProject);
	return existing ?? await createConversation(userId, title, { projectId: expectedProject });
}

async function retain(event: SessionEvent) {
	const started = WallDate.now();
	const chat = await chatFor(event);
	assert.equal(chat.projectId, event.project ? projectId(event.project) : null);
	const existing = db.select().from(messages)
		.where(eq(messages.conversationId, chat.id)).all();
	const existingUser = existing.find((row) => row.role === "user");
	const existingAssistant = existing.find((row) => row.role === "assistant");
	assert.ok(existing.length <= 2);
	assert.ok(!existingUser || existingUser.content === event.text);
	assert.ok(!existingAssistant || existingAssistant.content === retained);
	const stamp = captureMemoryTurnAcceptance(userId, chat.id);
	assert.equal(stamp?.eligible, true);
	const user = existingUser ?? await createMessage(chat.id, "user", event.text);
	const assistant = existingAssistant ?? await createMessage(chat.id, "assistant", retained);
	const getSource = () => db.select().from(memorySourceRevisions)
		.where(eq(memorySourceRevisions.messageId, user.id)).get();
	if (!getSource()) {
		assert.ok(!existingUser,
			"Interrupted before enqueue. Restart with a fresh isolated profile directory.");
		await deliverCompletedMemoryTurn({
			userId, conversationId: chat.id, userMessageId: user.id,
			assistantMessageId: assistant.id, memoryAcceptance: stamp,
		});
	}
	const first = getSource();
	assert.ok(first, "No source was enqueued by the completed-turn seam.");
	assert.equal(first.text, event.text);
	assert.equal(first.assertedAt.toISOString().slice(0, 10), event.day);
	assert.ok(isHistoricalMemorySourceEligible({
		userId, assertedAt: first.assertedAt, incognito: false,
	}));
	const readJob = () => db.select().from(memoryDeliveryJobs)
		.where(eq(memoryDeliveryJobs.sourceId, first.id)).get();
	let job = readJob();
	assert.ok(job);
	const deadline = WallDate.now() + 360_000;
	while (job.status === "queued" || job.status === "running") {
		if (WallDate.now() >= deadline) throw Error(`Job ${job.id} still ${job.status}`);
		await drain(memoryDeliveryJob);
		job = readJob();
		assert.ok(job);
		if (job.status === "queued" || job.status === "running") await wait(1000);
	}
	const attempts = db.select().from(memoryDeliveryAttempts)
		.where(eq(memoryDeliveryAttempts.jobId, job.id)).all();
	const source = getSource();
	assert.ok(source);
	const { acknowledgedFactsJson, text: _text, ...details } = source;
	return {
		kind: event.kind, index: event.index, day: event.day, project: event.project,
		chatId: chat.id, userMessageId: user.id, assistantMessageId: assistant.id,
		job, attempts, source: { ...details, facts: JSON.parse(acknowledgedFactsJson) },
		published: snapshot(), ms: WallDate.now() - started,
	};
}

async function check(event: CheckEvent) {
	const chat = await chatFor(event);
	assert.equal(db.select().from(messages).where(eq(messages.conversationId, chat.id)).all().length, 0);
	const started = WallDate.now();
	const tool = await getMemoryContext({
		userId, conversationId: chat.id, mode: "persona", query: event.query,
	});
	const recallMs = WallDate.now() - started;
	assert.equal(tool.mode, "persona");
	assert.equal(tool.source, "hindsight");
	const published = snapshot();
	const allowed = ["personal", ...(event.project ? [`project:${projectId(event.project)}`] : [])];
	const scopeViolations = tool.evidenceCandidates.flatMap(({ id, metadata }) => {
		const rowId = id.replace(/^memory-fact:/, "");
		const owners = published.filter((bank) =>
			bank.generation === metadata?.generation && bank.published.some((row) => row.id === rowId));
		return owners.length === 1 && allowed.includes(owners[0].scopeKey) ? [] : [rowId];
	});
	assert.deepEqual(scopeViolations, [], "Memory recall admitted out-of-scope or unlinked rows.");
	let response;
	let answerError;
	try {
		response = await answer(
			{ lang: profile.lang },
			{ day: event.day, project: event.project, query: event.query },
			{ content: tool.content },
			"alfyai-integrated-native",
		);
	} catch (error) {
		answerError = String(error);
	}
	assert.equal(db.select().from(messages).where(eq(messages.conversationId, chat.id)).all().length, 0);
	return {
		kind: event.kind, index: event.index, day: event.day, project: event.project,
		query: event.query, chatId: chat.id, tool, published, scopeViolations,
		recallMs, response, answerError,
	};
}

try {
	result.enrollment = enroll();
	save();
	for (const [position, event] of events.entries()) {
		if (result.events[position]) {
			assert.equal(result.events[position].kind, event.kind);
			assert.equal(result.events[position].index, event.index);
			continue;
		}
		// Source and query share the original corpus date. Within that date the
		// source array order is stable and already represents the capture order.
		clock(`${event.day}T12:00:${String(position).padStart(2, "0")}Z`);
		const outcome = event.kind === "source" ? await retain(event) : await check(event);
		result.events.push(outcome);
		save();
		console.log(id, event.kind, event.index, "job" in outcome
			? outcome.job.status : outcome.answerError ?? outcome.response?.text);
	}
	result.memoryActionCount = db.select().from(memoryActions)
		.where(eq(memoryActions.userId, userId)).all().length;
	result.complete = true;
	save();
	console.log(id, "COMPLETE");
} catch (error) {
	result.interruptions.push({ wallTime: new WallDate().toISOString(), error: String(error) });
	save();
	throw error;
} finally {
	sqlite.close();
}
