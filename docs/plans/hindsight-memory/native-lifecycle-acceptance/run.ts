import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type {
	MemoryAction,
	MemoryDetail,
	MemoryOperation,
	MemoryPage,
	MemoryRef,
	MemoryScope,
} from "../../../../src/lib/memory-types";
import { startRelay } from "./relay";

const native = "http://127.0.0.1:18890";
const mode = process.argv[2];
const portion = process.argv[3] ?? "first";
assert.match(
	mode,
	/^(en|hu|cancel|privacy|faults|carry-en|carry-hu|er-hu-regression|er-en-fresh|er-hu-fresh|er-remove)$/,
);
assert.match(
	portion,
	/^(first|continue|resume|after-replay|after-restart|recover|persistent-fault)$/,
);
const run = process.env.ALFYAI_LIFECYCLE_RUN ?? "main";
assert.match(run, /^[a-z0-9-]+$/);
const scratch = join("/tmp/alfyai-lifecycle-acceptance", run);
mkdirSync(scratch, { recursive: true });
const file = join(scratch, mode + ".json");
const database = join(scratch, mode + ".db");
assert.equal(existsSync(file), portion !== "first");
assert.equal(existsSync(database), portion !== "first");
const prior =
	portion === "first" ? null : JSON.parse(readFileSync(file, "utf8"));
const originalRelay = prior ? new URL(prior.steps[0].relay) : null;
const relay = ["cancel", "privacy", "faults", "carry-en", "carry-hu"].includes(
	mode,
)
	? await startRelay(Number(originalRelay?.port ?? 0), prior?.relay)
	: null;
const base = relay?.base ?? native;
const library = "../../../../src/lib/server/services";
const sourceFiles = [
	...execFileSync(
		"rg",
		[
			"--files",
			"src/lib/server/services/memory-profile",
			"src/lib/server/services/jobs",
			"deploy/hindsight",
		],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(
			(name) => !name.endsWith(".test.ts") && !name.includes("__pycache__"),
		),
	"src/lib/server/db/schema.ts",
	"src/lib/server/services/messages.ts",
	"src/lib/server/services/conversations.ts",
	"src/lib/server/services/memory-context/persona.ts",
	"drizzle/meta/_journal.json",
	"src/lib/server/services/account-lifecycle/index.ts",
].sort();
const hashes = Object.fromEntries(
	sourceFiles.map((p) => [
		p,
		createHash("sha256").update(readFileSync(p)).digest("hex"),
	]),
);
const identity = {
	git: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	nativeCommit: readFileSync("deploy/hindsight/engine-commit", "utf8").trim(),
	hashes,
};
const dir = "docs/plans/hindsight-memory/native-lifecycle-acceptance";
const fixtures = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf8"));
const fixtureKey =
	mode === "carry-en" && process.env.ALFYAI_LIFECYCLE_CARRY_TEA === "true"
		? "carry-en-tea"
		: mode === "faults"
			? "cancel"
			: mode;
// The edit/remove holdout (edit-remove-followup/, 2026-11-18) ran a prototype editor
// on four frozen cases. Its `er-*` modes run the same cases through the app's own
// chat delivery and Edit/Remove actions (regression run of 2026-11-24).
const editRemoveCase = mode.startsWith("er-")
	? JSON.parse(
			readFileSync(
				"docs/plans/hindsight-memory/edit-remove-followup/final-frozen.json",
				"utf8",
			),
		).cases.find(({ id }: { id: string }) => id === mode.slice(3))
	: undefined;
assert.ok(!mode.startsWith("er-") || editRemoveCase);
const defaultFixture = editRemoveCase
	? { query: editRemoveCase.q }
	: fixtures[fixtureKey];
const fixture =
	mode === "carry-en" && process.env.ALFYAI_LIFECYCLE_CARRY_METRONOME === "true"
		? {
				...defaultFixture,
				authored: fixtures.en.root,
				corrected: fixtures.en.edited,
				target: fixtures.en.target,
				question: "Do you keep your metronome on your desk?",
				query: fixtures.en.query,
			}
		: defaultFixture;

type State = {
	mode: string;
	userId: string;
	secondId: string;
	identity: typeof identity;
	steps: Record<string, unknown>[];
	ids: Record<string, any>;
	failures: string[];
	relay?: unknown[];
	final?: string;
};
const state: State =
	portion === "first"
		? {
				mode,
				userId: randomUUID(),
				secondId: randomUUID(),
				identity,
				steps: [],
				ids: {},
				failures: [],
			}
		: prior;
const changed = Object.keys(identity.hashes).filter(
	(name) => identity.hashes[name] !== state.identity.hashes[name],
);
assert.equal(identity.git, state.identity.git);
assert.equal(identity.nativeCommit, state.identity.nativeCommit);
assert.ok(
	!changed.length || process.env.ALFYAI_LIFECYCLE_ALLOW_SOURCE_DRIFT === "true",
	`Product fingerprint changed since the earlier process: ${changed.join(", ")}`,
);
const sourceDrift = Object.fromEntries(
	changed.map((name) => [
		name,
		{ previous: state.identity.hashes[name], current: identity.hashes[name] },
	]),
);
const userId = state.userId;
const lang =
	mode === "hu" || mode === "carry-hu" || mode.startsWith("er-hu-") ? "hu" : "en";
const personal = { kind: "personal" } as const;
const password = "synthetic-lifecycle-route-only";
const query =
	fixture.query ??
	"What personal information, class schedules, project names, studio addresses, and reference details do you know about me?";
Object.assign(process.env, {
	DATABASE_PATH: database,
	SESSION_SECRET: "synthetic-lifecycle-memory-only",
	HINDSIGHT_URL: base,
	HINDSIGHT_ALLOWED_URLS: [native, base].join(","),
	HINDSIGHT_TENANT_KEYS: "{}",
	HINDSIGHT_TENANT_MASTER_KEYS: JSON.stringify({ synthetic: "ab".repeat(32) }),
	HINDSIGHT_TENANT_ACTIVE_KEY: "synthetic",
	HINDSIGHT_WORKER_ENABLED: "true",
	HINDSIGHT_NEW_ACCOUNTS_ENABLED: "true",
	HINDSIGHT_RESTORE_HOLD: "false",
	HINDSIGHT_CONCURRENCY: "1",
	HINDSIGHT_CURATION_MODEL: "model2",
	MODEL_1_NAME: "qwen3-6-27b",
	MODEL_1_BASEURL: "http://127.0.0.1:18891/v1",
	MODEL_1_API_KEY: "synthetic-local-proxy",
	MODEL_2_ENABLED: "true",
	MODEL_2_NAME: "qwen3-6-27b",
	MODEL_2_BASEURL: `${base}/ext/alfyai/inference/v1`,
	MODEL_2_API_KEY: "synthetic-admission",
	TZ: "UTC",
});

const WallDate = Date;
let date = WallDate.parse("2026-08-01T12:00:00Z");
let wall = WallDate.now();
class FixtureDate extends WallDate {
	constructor(...args: ConstructorParameters<DateConstructor> | []) {
		super(...((args.length ? args : [FixtureDate.now()]) as [number]));
	}
	static now() {
		return date + WallDate.now() - wall;
	}
}
globalThis.Date = FixtureDate as DateConstructor;
function clock(day: number) {
	date = WallDate.parse(`2026-08-${String(day).padStart(2, "0")}T12:00:00Z`);
	wall = WallDate.now();
}
const { db, sqlite } = await import("../../../../src/lib/server/db/index");
const schema = await import("../../../../src/lib/server/db/schema");
const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
migrate(db, { migrationsFolder: resolve("drizzle") });
sqlite.function("unixepoch", () => Math.floor(Date.now() / 1000));
const { createConversation } = await import(`${library}/conversations`);
const { createMessage, deleteMessages } = await import(`${library}/messages`);
const { initializeNewMemoryAccount } = await import(
	`${library}/memory-profile/migration`
);
const { getMemoryAccount } = await import(
	`${library}/memory-profile/revisions`
);
const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } =
	await import(`${library}/memory-profile/chat-delivery`);
const { memoryDeliveryJob } = await import(
	`${library}/memory-profile/delivery-job`
);
const { readPublishedMemory } = await import(
	`${library}/memory-profile/publication`
);
const { nativeMemoryClient } = await import(
	`${library}/memory-profile/hindsight-client`
);
const { drain, retry } = await import(`${library}/jobs`);
const { getMemoryContext } = await import(`${library}/memory-context`);
const { getNativeMemoryCleanupStatus } = await import(
	`${library}/memory-controls`
);
const { POST: actionRoute } = await import(
	"../../../../src/routes/api/knowledge/memory/actions/+server"
);
const { GET: operationRoute } = await import(
	"../../../../src/routes/api/knowledge/memory/operations/[operationId]/+server"
);
const { GET: listRoute } = await import(
	"../../../../src/routes/api/knowledge/memory/+server"
);
const { GET: detailRoute } = await import(
	"../../../../src/routes/api/knowledge/memory/[itemId]/+server"
);
const { PATCH: preferencesRoute } = await import(
	"../../../../src/routes/api/settings/preferences/+server"
);
const { POST: clearRoute } = await import(
	"../../../../src/routes/api/settings/account/clear-memory/+server"
);
const { DELETE: messagesRoute } = await import(
	"../../../../src/routes/api/conversations/[id]/messages/+server"
);
const { hash } = await import("bcryptjs");
const {
	users,
	projects,
	conversations,
	messages,
	memoryAccounts,
	memoryBanks,
	memoryActions,
	memoryDeliveryAttempts,
	memoryDeliveryJobs,
	memorySourceRevisions,
	memoryRevocations,
} = schema;
const allAccounts = () => db.select().from(memoryAccounts).all();
const accountBanks = (owner = userId) =>
	db.select().from(memoryBanks).where(eq(memoryBanks.userId, owner)).all();
const allJobs = () => db.select().from(memoryDeliveryJobs).all();
const allSources = () => db.select().from(memorySourceRevisions).all();
const allActions = () => db.select().from(memoryActions).all();
const sourceFor = (messageId: string) =>
	allSources().find((row) => row.messageId === messageId);
const nativeFor = (bank: typeof memoryBanks.$inferSelect) =>
	nativeMemoryClient(bank.id, getMemoryAccount(bank.userId).tenantId);
type Endpoint = (event: any) => Response | Promise<Response>;

function save() {
	if (relay) state.relay = relay.events;
	writeFileSync(file + ".tmp", JSON.stringify(state, null, 2) + "\n");
	renameSync(file + ".tmp", file);
}
function record(name: string, data: Record<string, unknown> = {}) {
	state.steps.push({
		name,
		process: process.pid,
		at: new WallDate().toISOString(),
		...data,
	});
	save();
	console.log(mode, name);
}
async function call<T>(
	handler: Endpoint,
	path: string,
	options: {
		owner?: string;
		params?: Record<string, string>;
		method?: string;
		body?: unknown;
	} = {},
): Promise<{ status: number; body: T }> {
	const url = new URL("http://localhost" + path);
	const response = await handler({
		url,
		params: options.params ?? {},
		request: new Request(url, {
			method: options.method ?? "GET",
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			headers:
				options.body === undefined
					? undefined
					: { "content-type": "application/json" },
		}),
		locals: { user: { id: options.owner ?? userId } },
	});
	return { status: response.status, body: await response.json() };
}
function params(scope: MemoryScope) {
	const q = new URLSearchParams({ scope: scope.kind });
	if (scope.kind === "project") q.set("projectId", scope.projectId);
	return q;
}
async function list(owner = userId, scope: MemoryScope = personal) {
	return call<MemoryPage>(listRoute, "/api/knowledge/memory?" + params(scope), {
		owner,
	});
}
async function detail(ref: MemoryRef, owner = userId) {
	const q = params(ref.scope);
	q.set("generation", ref.generation);
	return call<MemoryDetail>(
		detailRoute,
		`/api/knowledge/memory/${ref.rowId}?${q}`,
		{
			owner,
			params: { itemId: ref.rowId },
		},
	);
}
async function pendingAction(
	input:
		| Omit<Extract<MemoryAction, { kind: "add" }>, "requestId">
		| Omit<Extract<MemoryAction, { kind: "edit" }>, "requestId">
		| Omit<Extract<MemoryAction, { kind: "remove" }>, "requestId">,
) {
	const body = { ...input, requestId: randomUUID() };
	const op = await call<MemoryOperation>(
		actionRoute,
		"/api/knowledge/memory/actions",
		{ method: "POST", body },
	);
	record(`submit-${input.kind}`, { request: body, operation: op });
	assert.equal(op.status, 200);
	assert.equal(op.body.status, "queued");
	return op.body;
}
async function status(id: string) {
	return call<MemoryOperation>(
		operationRoute,
		"/api/knowledge/memory/operations/" + id,
		{ params: { operationId: id } },
	);
}
async function enable(memoryEnabled: boolean) {
	const result = await call(preferencesRoute, "/api/settings/preferences", {
		method: "PATCH",
		body: { memoryEnabled },
	});
	assert.equal(result.status, 200);
	return result;
}
async function enroll(owner: string) {
	const passwordHash = await hash(password, 4);
	db.transaction((tx) => {
		tx.insert(users)
			.values({
				id: owner,
				email: `${owner}@example.invalid`,
				passwordHash,
				memoryEnabled: true,
				uiLanguage: lang,
				timeZone: "Europe/Dublin",
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
		initializeNewMemoryAccount(tx, owner);
	});
	assert.equal(getMemoryAccount(owner).authority, "hindsight");
}
async function chat(owner = userId, projectId?: string) {
	return createConversation(owner, "Synthetic native lifecycle", { projectId });
}
type Turn = {
	owner: string;
	chatId: string;
	userMessageId: string;
	assistantMessageId: string;
	payload: Parameters<typeof deliverCompletedMemoryTurn>[0];
};
async function turn(
	text: string,
	options: {
		chatId?: string;
		owner?: string;
		projectId?: string;
		assistant?: string;
		previous?: Turn;
		editSourceMessageId?: string;
		routeDeletion?: boolean;
		deleteAlongside?: string[];
		settled?: boolean;
		deliver?: boolean;
	} = {},
): Promise<Turn> {
	const owner = options.owner ?? userId;
	const chatId =
		options.chatId ??
		options.previous?.chatId ??
		(await chat(owner, options.projectId)).id;
	const editSourceMessageId =
		options.previous?.userMessageId ?? options.editSourceMessageId;
	if (options.previous) {
		const ids = [
			options.previous.userMessageId,
			options.previous.assistantMessageId,
			...(options.deleteAlongside ?? []),
		];
		if (options.routeDeletion)
			await deleteTurnMessages(chatId, ids, editSourceMessageId);
		else await deleteMessages(ids, { editSourceMessageId });
	}
	const memoryAcceptance = captureMemoryTurnAcceptance(owner, chatId);
	const authored = await createMessage(chatId, "user", text);
	const assistant = await createMessage(
		chatId,
		"assistant",
		options.assistant ?? "Acknowledged.",
	);
	const payload = {
		userId: owner,
		conversationId: chatId,
		userMessageId: authored.id,
		assistantMessageId: assistant.id,
		memoryAcceptance,
		...(editSourceMessageId
			? { turnOrigin: "edit_resend", editSourceMessageId }
			: {}),
	};
	if (options.deliver !== false) await deliverCompletedMemoryTurn(payload);
	const result = {
		owner,
		chatId,
		userMessageId: authored.id,
		assistantMessageId: assistant.id,
		payload,
	};
	if (options.settled !== false && options.deliver !== false) await settle();
	return result;
}
async function settle() {
	const started = WallDate.now();
	const due = () =>
		allJobs().some(
			(job) =>
				job.status === "running" ||
				(job.status === "queued" &&
					(!job.runAfter || job.runAfter.getTime() <= Date.now() + 60_000)),
		);
	while (due()) {
		await drain(memoryDeliveryJob);
		if (WallDate.now() - started > 390_000)
			throw Error("Memory queue exceeded 390-second harness budget");
		if (due()) await wait(450);
	}
}
async function recall(owner = userId, projectId?: string) {
	const key = `recall:${owner}:${projectId ?? "personal"}`;
	state.ids[key] ??= (await chat(owner, projectId)).id;
	const conversationId = state.ids[key];
	assert.ok(
		!db
			.select()
			.from(messages)
			.where(eq(messages.conversationId, conversationId))
			.get(),
	);
	return getMemoryContext({
		userId: owner,
		conversationId,
		mode: "persona",
		query,
	});
}
async function inspect(
	name: string,
	extra: Record<string, unknown> = {},
	owner = userId,
) {
	const banks = await Promise.all(
		accountBanks(owner).map(async (bank) => {
			const scope =
				bank.scopeKey === "personal"
					? personal
					: { kind: "project" as const, projectId: bank.scopeKey.slice(8) };
			const lookup = await list(owner, scope);
			const details = await Promise.all(
				(lookup.body.rows ?? []).map((row) => detail(row.ref, owner)),
			);
			const nativeClient = nativeFor(bank);
			const exists = await nativeClient.bankExists();
			const memories = exists ? await nativeClient.list() : [];
			const inFlight = exists ? await nativeClient.pendingOperations() : [];
			let published: ReturnType<typeof readPublishedMemory> = [];
			let publicationError: string | undefined;
			try {
				published = readPublishedMemory(owner, bank.id);
			} catch (error) {
				if (!(error instanceof Error) || error.message !== "memory_fence_stale")
					throw error;
				publicationError = error.message;
			}
			return {
				scope,
				bank,
				raw: memories.filter((row) => row.fact_type !== "observation"),
				observations: memories.filter((row) => row.fact_type === "observation"),
				inFlight,
				published,
				publicationError,
				lookup,
				details,
			};
		}),
	);
	const actions = allActions()
		.filter((row) => row.userId === owner)
		.map(({ intentJson, ...row }) => ({
			...row,
			intent: JSON.parse(intentJson ?? "{}"),
		}));
	const jobs = allJobs();
	const sources = allSources().filter((row) => row.userId === owner);
	const sourceMessages = sources.flatMap((source) => {
		if (!source.messageId) return [];
		const message = db
			.select({ id: messages.id, content: messages.content })
			.from(messages)
			.where(eq(messages.id, source.messageId))
			.get();
		return [
			{
				sourceId: source.id,
				messageId: source.messageId,
				exists: !!message,
				sameText: message?.content === source.text,
			},
		];
	});
	record(name, {
		...extra,
		owner,
		accounts: allAccounts(),
		banks,
		applicationRecall: await recall(owner),
		jobs,
		attempts: db.select().from(memoryDeliveryAttempts).all(),
		actions,
		sources: sources.map(({ acknowledgedFactsJson, ...row }) => ({
			...row,
			facts: JSON.parse(acknowledgedFactsJson),
		})),
		sourceMessages,
		revocations: db
			.select()
			.from(memoryRevocations)
			.where(eq(memoryRevocations.userId, owner))
			.all(),
	});
}
async function target(regex: RegExp) {
	const page = await list();
	assert.equal(page.status, 200);
	const rows = page.body.rows.filter((r) => regex.test(r.text));
	assert.equal(
		rows.length,
		1,
		`Expected one displayed target for ${regex}; got ${JSON.stringify(page.body.rows)}`,
	);
	return rows[0];
}
async function act(name: string, input: Parameters<typeof pendingAction>[0]) {
	const op = await pendingAction(input);
	await settle();
	const operation = await status(op.id);
	await inspect(name, { operation });
	return operation.body;
}

async function deleteTurnMessages(
	conversationId: string,
	messageIds: string[],
	editSourceMessageId?: string,
) {
	const result = await call<{ deleted: number }>(
		messagesRoute,
		`/api/conversations/${conversationId}/messages`,
		{
			method: "DELETE",
			params: { id: conversationId },
			body: {
				messageIds,
				...(editSourceMessageId ? { editSourceMessageId } : {}),
			},
		},
	);
	assert.equal(result.status, 200);
	assert.equal(result.body.deleted, messageIds.length);
	return result;
}

async function exactCarryLifecycle() {
	assert.ok(relay && portion === "first");
	const removeMode = process.env.ALFYAI_LIFECYCLE_CARRY_REMOVE;
	assert.ok(!removeMode || ["carried", "late-correction"].includes(removeMode));
	const capture = (start: number) => {
		const through = relay.events.length;
		const events = relay.events.slice(start, through);
		return {
			from: start,
			through,
			retains: events.filter(
				({ path, method }) => method === "POST" && path.endsWith("/memories"),
			),
			docDeletes: events.filter(
				({ path, method }) =>
					method === "DELETE" && path.includes("/documents/"),
			),
		};
	};
	await enroll(userId);
	clock(2);
	const initial = await turn(fixture.authored, { assistant: fixture.question });
	const origin = sourceFor(initial.userMessageId);
	assert.ok(origin);
	await inspect("carry-authored", {
		turn: initial,
		sourceId: origin.id,
		wire: capture(0),
	});
	const correct = async (name: string) => {
		const row = await target(new RegExp(fixture.target, "i"));
		const correctionStart = relay.events.length;
		const action = await pendingAction({
			kind: "edit",
			ref: row.ref,
			text: fixture.corrected,
		});
		await settle();
		const operation = await status(action.id);
		await inspect(name, {
			operation,
			wire: capture(correctionStart),
		});
		return operation;
	};
	clock(4);
	if (
		removeMode ||
		process.env.ALFYAI_LIFECYCLE_CARRY_NO_CORRECTION === "true"
	)
		await inspect("carry-before-exact");
	else await correct("carry-manual-correction");

	clock(6);
	const exactStart = relay.events.length;
	const exact = await turn(fixture.authored, {
		previous: initial,
		assistant: fixture.question,
		routeDeletion: true,
	});
	await inspect("carry-exact-resend", {
		turn: exact,
		sourceId: sourceFor(exact.userMessageId)?.id,
		sourceBefore: origin.id,
		wire: capture(exactStart),
	});
	if (removeMode === "late-correction") {
		clock(7);
		const correction = await correct("carry-late-manual-correction");
		assert.equal(correction.body.status, "applied");
	}

	clock(8);
	const dependentStart = relay.events.length;
	const dependent = await turn(fixture.reply, { chatId: exact.chatId });
	await inspect("carry-dependent-reply", {
		turn: dependent,
		sourceId: sourceFor(dependent.userMessageId)?.id,
		wire: capture(dependentStart),
	});

	clock(10);
	if (removeMode) {
		const pattern =
			removeMode === "late-correction" ? fixture.correctedTarget : fixture.target;
		assert.ok(typeof pattern === "string" && pattern);
		const row = await target(new RegExp(pattern, "i"));
		const start = relay.events.length;
		const operation = await pendingAction({ kind: "remove", ref: row.ref });
		await inspect("carry-remove-acknowledged", {
			operation,
			wire: capture(start),
		});
		await settle();
		await inspect("carry-remove-settled", {
			operation: await status(operation.id),
			wire: capture(start),
		});
		return;
	}
	const changedStart = relay.events.length;
	const dependentIds = [dependent.userMessageId, dependent.assistantMessageId];
	const removeReply = process.env.ALFYAI_LIFECYCLE_CARRY_TRIM_REPLY === "true";
	const reassertOnly = process.env.ALFYAI_LIFECYCLE_CARRY_REASSERT_ONLY === "true";
	const changedText = reassertOnly ? fixture.reassertedWithReason : fixture.authored + " " + fixture.append;
	assert.equal(typeof changedText, "string");
	const changedTurn = await turn(changedText, {
		previous: exact,
		routeDeletion: true,
		deleteAlongside: removeReply ? dependentIds : undefined,
	});
	await inspect(reassertOnly ? "carry-reasserted-preference" : "carry-changed-append", {
		turn: changedTurn,
		sourceId: sourceFor(changedTurn.userMessageId)?.id,
		deletedTail: removeReply ? dependentIds : [],
		wire: capture(changedStart),
	});
	let activeTurn = changedTurn;
	if (!reassertOnly && process.env.ALFYAI_LIFECYCLE_CARRY_REASSERT === "true") {
		assert.equal(typeof fixture.reasserted, "string");
		clock(11);
		const reassertedStart = relay.events.length;
		activeTurn = await turn(fixture.reasserted, {
			previous: changedTurn,
			routeDeletion: true,
		});
		await inspect("carry-reasserted-preference", {
			turn: activeTurn,
			sourceId: sourceFor(activeTurn.userMessageId)?.id,
			wire: capture(reassertedStart),
		});
	}
	const rotatePublication =
		process.env.ALFYAI_LIFECYCLE_CARRY_ROTATE_PUBLICATION === "true";
	if (rotatePublication) {
		assert.ok(mode === "carry-en" && reassertOnly);
		clock(11);
		const added = await act("carry-unrelated-publication", {
			kind: "add",
			scope: personal,
			text: "I collect Finnish postage stamps.",
		});
		assert.equal(added.status, "applied");
	}

	clock(12);
	const removeStart = relay.events.length;
	const deletion = await deleteTurnMessages(activeTurn.chatId, [
		activeTurn.userMessageId,
		activeTurn.assistantMessageId,
		...(removeReply ? [] : dependentIds),
	]);
	await inspect("carry-plain-deletion-before-drain", {
		deletion,
		wire: capture(removeStart),
	});
	await settle();
	await inspect("carry-plain-deletion", {
		deletion,
		wire: capture(removeStart),
	});
	if (rotatePublication) return;

	clock(14);
	const staleStart = relay.events.length;
	const oldPointer = await turn(fixture.authored, {
		chatId: activeTurn.chatId,
		editSourceMessageId: activeTurn.userMessageId,
	});
	await inspect("carry-stale-edit-pointer", {
		turn: oldPointer,
		sourceId: sourceFor(oldPointer.userMessageId)?.id,
		wire: capture(staleStart),
	});

	clock(16);
	const unsentStart = relay.events.length;
	const unsent = await turn(fixture.first, { settled: false });
	const unsentSource = sourceFor(unsent.userMessageId);
	assert.ok(unsentSource);
	await inspect("carry-unsubmitted", {
		turn: unsent,
		sourceId: unsentSource.id,
		wire: capture(unsentStart),
	});
	clock(18);
	const firstStart = relay.events.length;
	const first = await turn(fixture.first, {
		previous: unsent,
		routeDeletion: true,
	});
	await inspect("carry-unsubmitted-first-retain", {
		turn: first,
		sourceId: sourceFor(first.userMessageId)?.id,
		wire: capture(firstStart),
	});
}

async function mainLifecycle() {
	const prop = new RegExp(fixture.target, "i");
	if (portion === "first" || portion === "continue") {
		if (portion === "first") {
			await enroll(userId);
			clock(2);
			await act("add", { kind: "add", scope: personal, text: fixture.add });
			clock(3);
			const root = await turn(fixture.root);
			state.ids.root = root;
			await inspect("original", {
				authoredTurn: root,
				source: sourceFor(root.userMessageId)?.id,
			});
			clock(5);
			const row = await target(prop);
			const edit = await act("edit", {
				kind: "edit",
				ref: row.ref,
				text: fixture.edited,
			});
			if (edit.status !== "applied")
				record("edit-rejected-before-partial", { errorCode: edit.errorCode });
		}
		const root = state.ids.root as Turn;
		clock(7);
		if (!state.steps.some(({ name }) => name === "partial-remove")) {
			const alreadySubmitted = state.steps.findLast(
				({ name }) => name === "submit-edit",
			);
			if (
				alreadySubmitted &&
				(alreadySubmitted.request as MemoryAction & { text: string }).text ===
					fixture.partial
			) {
				await settle();
				const op = (alreadySubmitted.operation as { body: MemoryOperation })
					.body;
				await inspect("partial-remove", { operation: await status(op.id) });
			} else {
				const rows = (await list()).body.rows.filter((r) => prop.test(r.text));
				const material =
					mode === "hu"
						? /alum[ií]nium|alumin[ui]m|réz|copper/i
						: /walnut|bronze/i;
				const edited =
					rows.length === 1 ? rows[0] : rows.find((r) => material.test(r.text));
				assert.ok(edited, "The finish to omit was not displayed.");
				await act("partial-remove", {
					kind: "edit",
					ref: edited.ref,
					text: fixture.partial,
				});
			}
		}
		if (process.env.ALFYAI_LIFECYCLE_EDITS_ONLY === "true") return;
		clock(9);
		const old = sourceFor(root.userMessageId);
		const resumed =
			old &&
			allSources().find(
				(candidate) =>
					candidate.predecessorSourceId === old.id &&
					candidate.text === fixture.root &&
					candidate.state !== "revoked",
			);
		const identical: Turn = resumed
			? ({
					owner: userId,
					chatId: resumed.conversationId!,
					userMessageId: resumed.messageId!,
					assistantMessageId: db
						.select()
						.from(messages)
						.where(eq(messages.conversationId, resumed.conversationId!))
						.all()
						.find(({ role }) => role === "assistant")!.id,
					payload: {},
				} as Turn)
			: await turn(fixture.root, { previous: root });
		await settle();
		state.ids.identical = identical;
		await inspect("unchanged-resend", { authoredTurn: identical });
		clock(11);
		const changed = await turn(fixture.root + " " + fixture.append, {
			previous: identical,
		});
		state.ids.changed = changed;
		await inspect("forced-native-reextraction", { authoredTurn: changed });
		return;
	}
	if (portion === "resume") {
		clock(13);
		await inspect("app-process-restart");
		return;
	}
	assert.ok(portion === "after-restart" || portion === "after-replay");
	clock(15);
	await inspect(
		portion === "after-restart"
			? "native-api-and-app-restart"
			: "app-restart-after-replay",
	);
	clock(17);
	for (let index = 0; index < 4; index++) {
		const row = (await list()).body.rows.find((r) => prop.test(r.text));
		if (!row) break;
		const op = await pendingAction({ kind: "remove", ref: row.ref });
		await inspect("whole-remove-acknowledged-before-drain", {
			index,
			operation: await status(op.id),
			priorDetail: await detail(row.ref),
		});
		await settle();
		const operation = await status(op.id);
		await inspect("whole-remove", {
			index,
			operation,
			priorDetail: await detail(row.ref),
		});
		if (operation.body.status !== "applied") break;
	}
	clock(18);
	const previous = state.ids.changed as Turn;
	const resend = await turn(fixture.root + " " + fixture.append, { previous });
	await inspect("post-remove-unchanged-resend", { authoredTurn: resend });
	clock(19);
	await turn(fixture.newer);
	await inspect("newer-assertion");
}
async function cancelledEdit() {
	assert.ok(relay);
	let root: Turn;
	let op: MemoryOperation;
	let cancellation: unknown;
	if (portion === "first") {
		await enroll(userId);
		clock(2);
		root = await turn(fixture.root, { assistant: fixture.assistant });
		clock(3);
		const child = await turn(fixture.child, { chatId: root.chatId });
		clock(4);
		await turn(fixture.unrelated);
		await inspect("dependent-baseline", { root, child });
		clock(6);
		const row = await target(/pottery/i);
		relay.arm({
			match: ({ method, path }) =>
				method === "PATCH" && /\/memories\/[^/]+$/.test(path),
			remaining: 1,
			after: async (event) => {
				assert.equal(event.response, 200);
				cancellation = await enable(false);
			},
		});
		op = await pendingAction({
			kind: "edit",
			ref: row.ref,
			text:
				process.env.ALFYAI_LIFECYCLE_CANCEL_OMISSION === "true"
					? "I teach a pottery class."
					: fixture.draft,
		});
	} else {
		const baseline = state.steps.find(
			({ name }) => name === "dependent-baseline",
		);
		const submission = state.steps.find(({ name }) => name === "submit-edit");
		assert.ok(baseline && submission);
		root = baseline.root as Turn;
		op = (submission.operation as { body: MemoryOperation }).body;
		assert.equal(
			db.select().from(users).where(eq(users.id, userId)).get()?.memoryEnabled,
			false,
		);
		assert.ok(
			relay.events.some(
				({ method, path, response }) =>
					method === "PATCH" &&
					/\/memories\/[^/]+$/.test(path) &&
					response === 200,
			),
		);
		cancellation = { resumedFromConfirmedOffState: true };
		clock(6);
	}
	await settle();
	await inspect("after-dirty-cancellation", {
		operation: await status(op.id),
		cancellation,
		faultUnused: relay.remaining(),
	});
	if (!cancellation) return;
	clock(8);
	await deleteMessages([root.userMessageId, root.assistantMessageId]);
	await settle();
	await inspect("source-deleted-while-off", { operation: await status(op.id) });
	clock(10);
	await enable(true);
	await settle();
	await inspect("reenabled-dependent-repair", {
		operation: await status(op.id),
	});
	clock(12);
	await turn(fixture.following);
	await inspect("unrelated-publication-after-cancellation", {
		operation: await status(op.id),
	});
	clock(13);
	await unrelatedAddAfterCancellation(op.id);
}
async function unrelatedAddAfterCancellation(operationId: string) {
	const request = {
		kind: "add",
		scope: personal,
		text: "I collect brass thimbles.",
		requestId: randomUUID(),
	};
	const submission = await call<MemoryOperation>(
		actionRoute,
		"/api/knowledge/memory/actions",
		{
			method: "POST",
			body: request,
		},
	);
	await settle();
	await inspect("unrelated-add-after-cancellation", {
		submission,
		operation:
			submission.status === 200 ? await status(submission.body.id) : null,
		previousOperation: await status(operationId),
	});
}
async function recoverOriginalCancellation() {
	assert.ok(relay);
	const submitted = state.steps.find(({ name }) => name === "submit-edit");
	assert.ok(submitted);
	const op = (submitted.operation as { body: MemoryOperation }).body;
	const exactRequest = submitted.request as MemoryAction;
	const priorRestarts = state.steps.filter(
		({ name }) => name === "original-cancellation-after-recovery",
	).length;
	const recoveryDay = 13 + 2 * priorRestarts;
	clock(recoveryDay);
	await inspect("original-cancellation-before-recovery", {
		operation: await status(op.id),
	});
	const resubmitted = await call<MemoryOperation>(
		actionRoute,
		"/api/knowledge/memory/actions",
		{
			method: "POST",
			body: exactRequest,
		},
	);
	assert.equal(resubmitted.status, 200);
	assert.equal(resubmitted.body.id, op.id);
	// The current app's enable route resumes outstanding dependent cleanup, including
	// a surviving operation whose interrupted action already reached failed.
	const enabled = await enable(true);
	await settle();
	await inspect("original-cancellation-after-recovery", {
		operation: await status(op.id),
		resubmitted,
		enabled,
	});
	clock(recoveryDay + 1);
	await unrelatedAddAfterCancellation(op.id);
}
async function privacy() {
	assert.ok(relay);
	await enroll(userId);
	await enroll(state.secondId);
	const [a, b] = [randomUUID(), randomUUID()];
	for (const [id, name] of [
		[a, "Cedar"],
		[b, "Elm"],
	])
		db.insert(projects)
			.values({
				id,
				name,
				userId,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();
	clock(2);
	await turn(fixture.settled);
	await turn(fixture.projectA, { projectId: a });
	await turn(fixture.projectB, { projectId: b });
	await turn(fixture.other, { owner: state.secondId });
	const firstProject = (await list(userId, { kind: "project", projectId: a }))
		.body.rows[0];
	await inspect("scope-isolation", {
		projectA: await recall(userId, a),
		projectB: await recall(userId, b),
		otherUser: await recall(state.secondId),
		deniedProject: await list(state.secondId, {
			kind: "project",
			projectId: a,
		}),
		foreignDetail: firstProject
			? await detail(firstProject.ref, state.secondId)
			: null,
	});
	let off;
	relay.arm({
		match: ({ method, path }) => method === "POST" && /\/memories$/.test(path),
		remaining: 1,
		after: async (event) => {
			assert.equal(event.response, 200);
			off = await enable(false);
		},
	});
	clock(4);
	const offLate = await turn(fixture.offLate);
	await inspect("disabled-during-native-retain", {
		off,
		offLate,
		unused: relay.remaining(),
	});
	const staleOff = await turn("I keep the spare key in Juniper Vault.", {
		deliver: false,
	});
	await enable(true);
	await deliverCompletedMemoryTurn(staleOff.payload);
	await settle();
	await inspect("reenabled-after-late-native-retain", { staleOff });
	const retired = accountBanks().map((bank) => ({
		id: bank.id,
		client: nativeFor(bank),
		scope: bank.scopeKey,
		existed: bank.generation !== "",
	}));
	const old = (await list()).body.rows[0];
	let reset;
	relay.arm({
		match: ({ method, path }) => method === "POST" && /\/memories$/.test(path),
		remaining: 1,
		after: async (event) => {
			assert.equal(event.response, 200);
			reset = await call(clearRoute, "/api/settings/account/clear-memory", {
				method: "POST",
				body: { password },
			});
		},
	});
	clock(6);
	const resetLate = await turn(fixture.resetLate, { settled: false });
	await settle();
	const physical = await Promise.all(
		retired.map(async ({ id, client, scope, existed }) => ({
			id,
			scope,
			previouslyKnown: existed,
			existsAfter: await client.bankExists(),
		})),
	);
	await deliverCompletedMemoryTurn(resetLate.payload);
	await settle();
	await inspect("reset-during-native-retain", {
		reset,
		physical,
		resetLate,
		unused: relay.remaining(),
		oldDetail: old ? await detail(old.ref) : null,
		cleanup: await getNativeMemoryCleanupStatus(userId),
		secondUserAfterReset: await recall(state.secondId),
		survivingChat: db
			.select()
			.from(conversations)
			.where(eq(conversations.id, resetLate.chatId))
			.get()?.id,
	});
}
// Today's consolidation keeps one facet per card, so after an edit the typewriter's
// colour and its place on the desk can be two cards; the fault edits target the colour.
async function typewriterColourCard() {
	const rows = (await list()).body.rows.filter((r) => /typewriter/i.test(r.text));
	const coloured = rows.filter((r) =>
		/orange|teal|lilac|burgundy|mint/i.test(r.text),
	);
	const pick = rows.length === 1 ? rows : coloured;
	assert.equal(
		pick.length,
		1,
		`Expected one typewriter colour card; got ${JSON.stringify(rows)}`,
	);
	return pick[0];
}
// The edit a person would type on that card: the recorded fixture's sentence when the
// card holds the desk too, the colour alone when the desk is a card of its own.
function colourEdit(card: { text: string }, colour: string) {
	return /desk/i.test(card.text)
		? `I keep a ${colour} typewriter on my desk.`
		: `My typewriter is ${colour}.`;
}
async function faults() {
	assert.ok(relay);
	const curation = ({ path }: { path: string }) =>
		path === "/ext/alfyai/inference/v1/chat/completions";
	if (portion === "first") {
		await enroll(userId);
		clock(2);
		await turn(
			"I keep an orange typewriter on my desk. My sister Maja studies beetles.",
		);
		await inspect("fault-baseline");
		const row = await typewriterColourCard();
		relay.arm({ match: curation, before: "unavailable", remaining: 40 });
		const unavailable = await act("curation-outage", {
			kind: "edit",
			ref: row.ref,
			text: "I keep a teal typewriter on my desk.",
		});
		record("outage-fault-count", { remaining: relay.remaining() });
		const failedJob = allJobs().find((job) => job.actionId === unavailable.id);
		assert.ok(failedJob);
		if (failedJob.retryable) {
			relay.arm({ match: curation, before: "slow", remaining: 1 });
			await retry(memoryDeliveryJob, failedJob.id, { userId });
			await settle();
			await inspect("outage-retry-with-slow-response", {
				operation: await status(unavailable.id),
				unused: relay.remaining(),
			});
		}
		const next = await typewriterColourCard();
		relay.arm({ match: curation, before: "malformed", remaining: 1 });
		await act("malformed-curation-output", {
			kind: "edit",
			ref: next.ref,
			text: "I keep a lilac typewriter on my desk.",
		});
	} else {
		clock(3);
	}
	if (portion === "persistent-fault") {
		await inspect("persistent-dirty-fault-baseline");
		// The recorded run's burgundy edit had applied; when it was refused, the
		// typewriter's current colour card is the target instead.
		const row = await typewriterColourCard();
		const offset = relay.events.length;
		relay.arm({
			match: ({ path, body }) =>
				curation({ path }) &&
				relay.events
					.slice(offset)
					.some(
						({ path, method }) =>
							method === "PATCH" && /\/memories\/[^/]+$/.test(path),
					) &&
				JSON.stringify(body).includes("Check factual correctness"),
			before: "malformed",
			remaining: 30,
		});
		const action = await act("persistent-dirty-fault-exhaustion", {
			kind: "edit",
			ref: row.ref,
			text: colourEdit(row, "mint"),
		});
		record("persistent-dirty-fault-fired", { remaining: relay.remaining() });
		if (action.retryable) {
			relay.arm({ match: () => false, remaining: 0 });
			const job = allJobs().find(
				(candidate) => candidate.actionId === action.id,
			);
			assert.ok(job);
			await retry(memoryDeliveryJob, job.id, { userId });
			await settle();
			await inspect("persistent-dirty-fault-retry", {
				operation: await status(action.id),
			});
		}
		return;
	}
	const candidates = (await list()).body.rows.filter((row) =>
		/typewriter/i.test(row.text),
	);
	const dirty =
		candidates.length === 1
			? candidates[0]
			: candidates.find((row) =>
					/(?:lilac|teal|orange) typewriter|typewriter is (?:lilac|teal|orange)/i.test(
						row.text,
					),
				);
	assert.ok(
		dirty,
		"The current typewriter finish must have an unambiguous card.",
	);
	const dirtyBoundary = relay.events.length;
	relay.arm({
		match: ({ path, body }) =>
			curation({ path }) &&
			relay.events
				.slice(dirtyBoundary)
				.some(
					({ path, method }) =>
						method === "PATCH" && /\/memories\/[^/]+$/.test(path),
				) &&
			JSON.stringify(body).includes("Check factual correctness"),
		before: "malformed",
		remaining: 1,
	});
	await act("dirty-edit-final-check-fault", {
		kind: "edit",
		ref: dirty.ref,
		text: colourEdit(dirty, "burgundy"),
	});
	record("dirty-fault-fired", { unused: relay.remaining() });
	await turn("I restore wind-up kitchen timers.");
	await inspect("fault-recovery-unrelated-turn");
}

/**
 * The edit/remove holdout through the app. `first`: enroll, the original chat
 * (August 1) and the restating chat (August 3), then a record of the cards.
 * `continue`: the operator's edits from ALFYAI_LIFECYCLE_ER_EDITS (a JSON list of
 * {card, action: "edit" | "remove", text?}, each `card` a displayed card's exact
 * text), written by reading the cards as a person would, then an unchanged resend
 * of the original chat (the replay), a changed resend of it (a forced native
 * re-extraction) and the case's later statement (August 23).
 */
async function editRemoveHoldout() {
	const c = editRemoveCase;
	if (portion === "first") {
		await enroll(userId);
		clock(2);
		const original = await turn(c.before);
		clock(3);
		const repeat = await turn(c.repeat);
		state.ids.original = original;
		state.ids.repeat = repeat;
		await inspect("er-sources", { original, repeat });
		return;
	}
	assert.equal(portion, "continue");
	const editsPath = process.env.ALFYAI_LIFECYCLE_ER_EDITS;
	assert.ok(editsPath, "Set ALFYAI_LIFECYCLE_ER_EDITS to the operator's edits");
	const edits = JSON.parse(readFileSync(editsPath, "utf8")) as {
		card: string;
		action: "edit" | "remove";
		text?: string;
	}[];
	record("er-operator-edits", { edits });
	clock(5);
	for (const [index, edit] of edits.entries()) {
		const page = await list();
		const row = page.body.rows.find((r) => r.text === edit.card);
		if (!row) {
			record("er-card-missing", { index, edit, rows: page.body.rows });
			continue;
		}
		await act(`er-${edit.action}-${index}`, {
			...(edit.action === "remove"
				? { kind: "remove" as const, ref: row.ref }
				: { kind: "edit" as const, ref: row.ref, text: edit.text ?? "" }),
		});
	}
	await inspect("er-edit");
	clock(7);
	const original = state.ids.original as Turn;
	const replay = await turn(c.before, { previous: original });
	state.ids.replay = replay;
	await inspect("er-replay", { authoredTurn: replay });
	clock(9);
	const appended =
		lang === "hu"
			? "Szeretem a kerti teraszon a reggeli kávét."
			: "I enjoy my morning coffee on the garden terrace.";
	const reprocess = await turn(`${c.before} ${appended}`, { previous: replay });
	await inspect("er-reprocess", { authoredTurn: reprocess, appended });
	clock(23);
	await turn(c.later.replace(/^User: /, ""));
	await inspect("er-new-explicit");
}

try {
	record("process-start", {
		portion,
		appDatabase: database,
		relay: base,
		model: "qwen3-6-27b",
		sourceDrift,
	});
	if (editRemoveCase) await editRemoveHoldout();
	else if (mode === "carry-en" || mode === "carry-hu") await exactCarryLifecycle();
	else if (mode === "en" || mode === "hu") await mainLifecycle();
	else if (mode === "cancel") {
		if (portion === "recover") await recoverOriginalCancellation();
		else await cancelledEdit();
	} else if (mode === "privacy") await privacy();
	else await faults();
	state.final = portion;
	save();
	console.log(mode, portion, "RECORDED");
} catch (error) {
	state.failures.push(String(error instanceof Error ? error.stack : error));
	save();
	throw error;
} finally {
	relay?.close();
	sqlite.close();
}
