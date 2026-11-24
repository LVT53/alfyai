import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import { withDatedNativeFacts } from "./curation.test-support";

/** What each fake bank was last configured with. */
const fakeBankConfigs = new Map<string, unknown>();

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-actions");
});
afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});
async function setup() {
	const { db } = await import("$lib/server/db");
	const s = await import("$lib/server/db/schema");
	const r = await import("./revisions");
	const bank = r.ensureMemoryBank(h.userId, { kind: "personal" });
	db.update(s.memoryAccounts).set({ authority: "hindsight" }).run();
	const source = r.recordMemorySource({
		userId: h.userId,
		bankId: bank.id,
		epoch: 0,
		eventId: "e",
		lineageId: "l",
		text: "green kayak and sister's bicycle",
		context: "",
		assertedAt: new Date(),
	});
	db.update(s.memorySourceRevisions)
		.set({
			state: "accepted",
			acknowledgedFactsJson: JSON.stringify([
				{ id: "kayak", text: "green kayak" },
				{ id: "sister", text: "sister bicycle" },
			]),
		})
		.run();
	db.update(s.memoryBanks).set({ generation: "g" }).run();
	for (const id of ["kayak", "sister"])
		db.insert(s.memoryPublishedRows)
			.values({
				id,
				nativeId: id,
				bankId: bank.id,
				generation: "g",
				epoch: 0,
				text: id,
				nativeText: id,
				sourceIdsJson: JSON.stringify([id]),
				sourceFingerprintsJson: JSON.stringify([
					{ id, text: id === "kayak" ? "green kayak" : "sister bicycle" },
				]),
				updatedAt: new Date(),
			})
			.run();
	return { db, s, bank, source };
}
it("remove revokes target immediately but not unrelated source facts and retries are same intent", async () => {
	const f = await setup();
	const a = await import("./curation-actions");
	const pub = await import("./publication");
	const input = {
		kind: "remove" as const,
		ref: {
			scope: { kind: "personal" as const },
			generation: "g",
			rowId: "kayak",
		},
		requestId: randomUUID(),
	};
	const first = await a.submitMemoryAction(h.userId, input);
	expect(first.exclusionAcknowledged).toBe(true);
	expect(
		pub.readPublishedMemory(h.userId, f.bank.id).map((r) => r.nativeId),
	).toEqual(["sister"]);
	expect((await a.submitMemoryAction(h.userId, input)).id).toBe(first.id);
	expect(f.db.select().from(f.s.memoryActions).all()).toHaveLength(1);
});
it("rejects reused request with different payload and stale edits without writing", async () => {
	const f = await setup();
	const a = await import("./curation-actions");
	const id = randomUUID();
	await a.submitMemoryAction(h.userId, {
		kind: "add",
		scope: { kind: "personal" },
		text: "I paddle",
		requestId: id,
	});
	await expect(
		a.submitMemoryAction(h.userId, {
			kind: "add",
			scope: { kind: "personal" },
			text: "I fly",
			requestId: id,
		}),
	).rejects.toThrow("request_conflict");
	await expect(
		a.submitMemoryAction(h.userId, {
			kind: "edit",
			ref: { scope: { kind: "personal" }, generation: "old", rowId: "kayak" },
			text: "purple",
			requestId: randomUUID(),
		}),
	).rejects.toThrow("stale");
	expect(f.db.select().from(f.s.memoryActions).all()).toHaveLength(1);
});
it("operation lookup cannot expose another user's request", async () => {
	await setup();
	const a = await import("./curation-actions");
	const id = randomUUID();
	const op = await a.submitMemoryAction(h.userId, {
		kind: "add",
		scope: { kind: "personal" },
		text: "kayak",
		requestId: id,
	});
	expect(a.getMemoryOperation(h.userId, { requestId: id }).id).toBe(op.id);
	expect(() => a.getMemoryOperation("other", { id: op.id })).toThrow(
		"not_found",
	);
});

async function nativeFixture(
	f: Awaited<ReturnType<typeof setup>>,
	modelResults: unknown[],
) {
	const { vi } = await import("vitest");
	const client = await import("./hindsight-client");
	const cfg = await import("$lib/server/config-store");
	const curation = await import("./curation");
	const contracts = await import("./contracts");
	vi.spyOn(cfg, "getConfig").mockReturnValue({
		...cfg.getConfig(),
		hindsightWorkerEnabled: true,
	});
	const model = vi.fn().mockImplementation(async () => {
		if (!modelResults.length) throw Error("unexpected model call");
		return modelResults.shift();
	});
	vi.spyOn(curation, "createCurationModel").mockReturnValue(
		withDatedNativeFacts(model),
	);
	let facts = [
		{
			id: "kayak",
			text: "green kayak",
			fact_type: "world",
			document_id: f.source.id,
			consolidated_at: "2026-11-01",
		},
		{
			id: "sister",
			text: "sister bicycle",
			fact_type: "world",
			document_id: f.source.id,
			consolidated_at: "2026-11-01",
		},
	];
	const patches: string[] = [];
	const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const path = String(url);
		let data: unknown = {};
		if (path.endsWith("/config")) {
			// A bank answers with the config it was last sent (config 2 is per bank kind).
			const bank = new URL(path).pathname.split("/")[4];
			if (init?.method === "PATCH")
				fakeBankConfigs.set(bank, JSON.parse(String(init.body)).updates);
			data = {
				config:
					fakeBankConfigs.get(bank) ?? contracts.nativeBankConfig("personal"),
			};
		} else if (path.includes("/operations?")) data = { operations: [] };
		else if (path.includes("/operations/")) data = { status: "completed" };
		else if (path.endsWith("/memories") && init?.method === "POST")
			data = { operation_id: JSON.parse(String(init.body)).operation_id };
		else if (path.endsWith("/observations") && init?.method === "DELETE")
			data = { deleted_count: 0 };
		else if (path.endsWith("/consolidate"))
			data = { operation_id: "consolidation" };
		else if (path.includes("/memories/") && init?.method === "PATCH") {
			const id = path.split("/").at(-1);
			const patch = JSON.parse(String(init.body));
			patches.push(id ?? "");
			facts =
				patch.state === "invalidated"
					? facts.filter((f) => f.id !== id)
					: facts.map((f) => (f.id === id ? { ...f, text: patch.text } : f));
		} else if (path.includes("/memories/list")) {
			const rows = [
				...facts,
				...facts.map((f) => ({
					id: `observation-${f.id}`,
					text: f.text,
					fact_type: "observation",
					source_memory_ids: [f.id],
				})),
			];
			data = { items: rows, total: rows.length, offset: 0 };
		}
		return new Response(JSON.stringify(data));
	});
	vi.spyOn(client, "configuredNativeBinding").mockReturnValue({
		baseUrl: "http://synthetic",
		credentialHash: "key-hash",
	});
	vi.spyOn(client, "nativeMemoryClient").mockImplementation(
		() =>
			new client.HindsightClient({
				baseUrl: "http://synthetic",
				apiKey: "key",
				bankId: f.bank.id,
				fetcher,
			}),
	);
	return {
		patches,
		model,
		fetcher,
		setFacts: (
			next: Array<{ id: string; text: string; document_id?: string }>,
		) => {
			facts = next.map((fact) => ({
				...fact,
				document_id: fact.document_id ?? f.source.id,
				fact_type: "world",
				consolidated_at: "2026-11-01",
			}));
		},
	};
}
it("real job engine removes a compound memory without losing independent facts", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["kayak"], replace: [], preserve: ["sister bicycle"] },
		{
			facts: [
				{ id: "kayak", text: "" },
				{ id: "sister", text: "sister bicycle" },
			],
		},
		{ valid: true, issues: [] },
		ckOkay,
	]);
	const a = await import("./curation-actions");
	const job = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: { scope: { kind: "personal" }, generation: "g", rowId: "kayak" },
		requestId: randomUUID(),
	});
	await h.engine.drain(job.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "applied",
		exclusionAcknowledged: true,
		cleanupPending: false,
	});
	const pub = await import("./publication");
	expect(
		pub.readPublishedMemory(h.userId, f.bank.id).map((r) => r.text),
	).toEqual(["sister bicycle"]);
	expect(fixture.model).toHaveBeenCalledTimes(4);
});
it("a remove waits out a consolidation Hindsight takes 25 minutes over, spending no attempt (acceptance)", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["kayak"], replace: [], preserve: ["sister bicycle"] },
		{
			facts: [
				{ id: "kayak", text: "" },
				{ id: "sister", text: "sister bicycle" },
			],
		},
		{ valid: true, issues: [] },
		ckOkay,
	]);
	// The model is held busy: the consolidation of the removal runs 25 minutes of
	// faked time, and every status read moves the clock on by six. A consolidation
	// asked for later has nothing left to do and ends at once, as in Hindsight.
	vi.useFakeTimers({ toFake: ["Date"] });
	const inner = fixture.fetcher.getMockImplementation();
	if (!inner) throw Error("Missing fixture fetch");
	const started = new Map<string, number>();
	let consolidations = 0;
	const running = (id: string) =>
		id === "slow-consolidation-1" &&
		Date.now() - (started.get(id) ?? 0) < 25 * 60_000;
	fixture.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.endsWith("/consolidate")) {
			const id = `slow-consolidation-${++consolidations}`;
			started.set(id, Date.now());
			return new Response(JSON.stringify({ operation_id: id }));
		}
		if (path.includes("/operations?"))
			return new Response(
				JSON.stringify({
					operations: path.includes("status=processing")
						? [...started.keys()]
								.filter(running)
								.map((id) => ({ id, status: "processing" }))
						: [],
				}),
			);
		const op = path.split("/operations/")[1];
		if (op?.startsWith("slow-consolidation")) {
			vi.setSystemTime(Date.now() + 6 * 60_000);
			return new Response(
				JSON.stringify({ status: running(op) ? "processing" : "completed" }),
			);
		}
		return inner(url, init);
	});
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: { scope: { kind: "personal" }, generation: "g", rowId: "kayak" },
		requestId: randomUUID(),
	});
	const codes: Array<string | null> = [];
	for (let round = 0; round < 40; round++) {
		await h.engine.drain(jobs.memoryDeliveryJob);
		const row = f.db.select().from(f.s.memoryDeliveryJobs).get();
		codes.push(row?.errorCode ?? null);
		if (row?.status !== "queued") break;
		vi.setSystemTime(Date.now() + 61_000);
	}
	vi.useRealTimers();
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "applied",
		exclusionAcknowledged: true,
		cleanupPending: false,
	});
	// It waited, and only waited: never a failure, never a timeout.
	expect(codes.slice(0, -1).length).toBeGreaterThan(0);
	expect(
		codes.slice(0, -1).every((code) => code === "native_consolidation_waiting"),
	).toBe(true);
	const row = f.db.select().from(f.s.memoryDeliveryJobs).get();
	const { parseDeliveryRetryState } = await import("./delivery-policy");
	expect(
		(row?.attemptCount ?? 0) -
			parseDeliveryRetryState(JSON.parse(row?.retryState ?? "null")).waits,
	).toBe(1);
	const pub = await import("./publication");
	expect(
		pub.readPublishedMemory(h.userId, f.bank.id).map((r) => r.text),
	).toEqual(["sister bicycle"]);
	// The model was asked exactly what an unhurried remove asks it.
	expect(fixture.model).toHaveBeenCalledTimes(4);
}, 60_000);
it("an Add whose retain Hindsight keeps working on waits as a retain, for the retain's wait", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	// Hindsight never finishes the Add's retain, and every read of it moves the
	// clock on six minutes, so each attempt's five-minute slice ends after one look.
	vi.useFakeTimers({ toFake: ["Date"] });
	const inner = fixture.fetcher.getMockImplementation();
	if (!inner) throw Error("Missing fixture fetch");
	const retains = new Set<string>();
	fixture.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.endsWith("/memories") && init?.method === "POST")
			retains.add(JSON.parse(String(init.body)).operation_id);
		const op = path.split("/operations/")[1];
		if (op && retains.has(decodeURIComponent(op))) {
			vi.setSystemTime(Date.now() + 6 * 60_000);
			return new Response(JSON.stringify({ status: "processing" }));
		}
		return inner(url, init);
	});
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const { getMemoryNativeWaits } = await import("$lib/server/config-store");
	const waits = getMemoryNativeWaits();
	const started = Date.now();
	await a.submitMemoryAction(h.userId, {
		kind: "add",
		scope: { kind: "personal" },
		text: "I paddle a green kayak",
		requestId: randomUUID(),
	});
	const actionJob = () =>
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.all()
			.find((row) => row.kind === "action");
	const codes: Array<string | null> = [];
	for (let round = 0; round < 40; round++) {
		await h.engine.drain(jobs.memoryDeliveryJob);
		const row = actionJob();
		codes.push(row?.errorCode ?? null);
		if (row?.status !== "queued") break;
		vi.setSystemTime(Date.now() + 61_000);
	}
	const waited = Date.now() - started;
	vi.useRealTimers();
	expect(retains.size).toBe(1);
	expect(codes.slice(0, -1).length).toBeGreaterThan(0);
	expect(codes.slice(0, -1)).toEqual(
		codes.slice(0, -1).map(() => "native_retain_waiting"),
	);
	expect(codes.at(-1)).toBe("native_operation_timeout");
	// Ended by the retain's own wait, not the consolidation's longer one.
	expect(waited).toBeGreaterThanOrEqual(waits.retainMs);
	expect(waited).toBeLessThan(waits.consolidationMs);
	expect(fixture.model).not.toHaveBeenCalled();
}, 60_000);
it("rejected edit cleans its staged delta without patching accepted facts", async () => {
	const f = await setup();
	const bad = {
		facts: [
			{ id: "kayak", text: "" },
			{ id: "sister", text: "" },
		],
	};
	const reject = {
		valid: false,
		issues: [{ id: "sister", problem: "collateral loss" }],
	};
	const fixture = await nativeFixture(f, [
		{ forget: ["green"], replace: [], preserve: ["kayak", "sister bicycle"] },
		bad,
		reject,
		bad,
		reject,
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: { scope: { kind: "personal" }, generation: "g", rowId: "kayak" },
		text: "kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("failed");
	expect(fixture.patches).toEqual([]);
	const pub = await import("./publication");
	expect(pub.readPublishedMemory(h.userId, f.bank.id)).toHaveLength(2);
});
it("uncertain PATCH retry reuses saved verified intent and preserves accepted view until complete", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: [], replace: ["green to purple"], preserve: ["sister bicycle"] },
		{
			facts: [
				{ id: "kayak", text: "purple kayak" },
				{ id: "sister", text: "sister bicycle" },
			],
		},
		{ valid: true, issues: [] },
		ckOkay,
	]);
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("fixture");
	let dropped = false;
	fixture.fetcher.mockImplementation(async (url, init) => {
		const response = await original(url, init);
		if (
			init?.method === "PATCH" &&
			String(url).includes("/memories/") &&
			!dropped
		) {
			dropped = true;
			return new Response("lost after write", { status: 503 });
		}
		return response;
	});
	const a = await import("./curation-actions");
	const job = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: { scope: { kind: "personal" }, generation: "g", rowId: "kayak" },
		text: "purple kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(job.memoryDeliveryJob);
	const pub = await import("./publication");
	expect(
		pub.readPublishedMemory(h.userId, f.bank.id).map((r) => r.text),
	).toEqual(["kayak", "sister"]);
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("queued");
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + 10000);
	await h.engine.drain(job.memoryDeliveryJob);
	vi.useRealTimers();
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("applied");
	expect(fixture.model).toHaveBeenCalledTimes(4);
	expect(fixture.patches).toEqual(["kayak"]);
});
it("native source-edit omission preserves sanitized predecessor facts at the old assertion date", async () => {
	const f = await setup();
	await nativeFixture(f, [
		{
			forget: ["kayak colour"],
			replace: [],
			preserve: ["kayak", "sister bicycle"],
		},
		{
			facts: [
				{ id: "kayak", text: "kayak" },
				{ id: "sister", text: "sister bicycle" },
			],
		},
		{ valid: true, issues: [] },
		ckOkay,
	]);
	const rev = await import("./revisions");
	rev.revokeMemorySources(h.userId, [f.source.id]);
	const next = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "edit",
		lineageId: f.source.lineageId,
		predecessorSourceId: f.source.id,
		text: "kayak and sister bicycle",
		context: "source edit",
		assertedAt: f.source.assertedAt,
		explicitEditAt: new Date(f.source.assertedAt.getTime() + 100000),
	});
	const jobs = await import("./delivery-job");
	const queued = await jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: next.id,
		requestId: "edit-delivery",
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	const { eq } = await import("drizzle-orm");
	const result = f.db
		.select()
		.from(f.s.memoryDeliveryJobs)
		.where(eq(f.s.memoryDeliveryJobs.id, queued.row.id))
		.get();
	expect(result?.status).toBe("succeeded");
	const pub = await import("./publication");
	const rows = pub.readPublishedMemory(h.userId, f.bank.id);
	expect(rows.map((r) => r.text)).toEqual(["kayak", "sister bicycle"]);
	expect(
		rows.every((r) => r.updatedAt.getTime() === f.source.assertedAt.getTime()),
	).toBe(true);
});
it("forced source re-extraction reuses saved intent across the known source family", async () => {
	const f = await setup();
	const rev = await import("./revisions");
	const { eq } = await import("drizzle-orm");
	const second = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "repeat",
		lineageId: "repeat",
		text: "green kayak and birdwatching",
		context: "",
		assertedAt: f.source.assertedAt,
	});
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			state: "accepted",
			acknowledgedFactsJson: JSON.stringify([
				{ id: "repeat-kayak", text: "green kayak" },
				{ id: "hobby", text: "birdwatching" },
			]),
		})
		.where(eq(f.s.memorySourceRevisions.id, second.id))
		.run();
	f.db
		.update(f.s.memoryPublishedRows)
		.set({
			sourceIdsJson: JSON.stringify(["kayak", "repeat-kayak"]),
			sourceFingerprintsJson: JSON.stringify([
				{ id: "kayak", text: "green kayak" },
				{ id: "repeat-kayak", text: "green kayak" },
			]),
		})
		.where(eq(f.s.memoryPublishedRows.nativeId, "kayak"))
		.run();
	const fixture = await nativeFixture(f, [
		{
			forget: ["kayak"],
			replace: [],
			preserve: ["sister bicycle", "birdwatching"],
		},
		{
			facts: [
				{ id: "kayak", text: "" },
				{ id: "sister", text: "sister bicycle" },
				{ id: "repeat-kayak", text: "" },
				{ id: "hobby", text: "birdwatching" },
			],
		},
		{ valid: true, issues: [] },
		ckOkay,
		{
			facts: [
				{ id: "new-kayak", text: "" },
				{ id: "new-sister", text: "sister bicycle" },
				{ id: "hobby", text: "birdwatching" },
			],
		},
		{ valid: true, issues: [] },
		ckOkay,
	]);
	fixture.setFacts([
		{ id: "kayak", text: "green kayak" },
		{ id: "sister", text: "sister bicycle" },
		{ id: "repeat-kayak", text: "green kayak", document_id: second.id },
		{ id: "hobby", text: "birdwatching", document_id: second.id },
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: { scope: { kind: "personal" }, generation: "g", rowId: "kayak" },
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("applied");
	fixture.setFacts([
		{ id: "new-kayak", text: "green kayak" },
		{ id: "new-sister", text: "sister bicycle" },
		{ id: "hobby", text: "birdwatching", document_id: second.id },
	]);
	const delivery = await jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: f.source.id,
		requestId: "forced-reextract",
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(eq(f.s.memoryDeliveryJobs.id, delivery.row.id))
			.get()?.status,
	).toBe("succeeded");
	const pub = await import("./publication");
	expect(
		pub
			.readPublishedMemory(h.userId, f.bank.id)
			.map((r) => r.text)
			.sort(),
	).toEqual(["birdwatching", "sister bicycle"]);
	expect(fixture.model).toHaveBeenCalledTimes(7);
});

const ckRef = {
	scope: { kind: "personal" as const },
	generation: "g",
	rowId: "kayak",
};
const ckPlan = {
	forget: [],
	replace: ["green to purple"],
	preserve: ["sister bicycle"],
};
const ckProposal = (id: string, target: string, sister = "sister") => ({
	facts: [
		{ id, text: target },
		{ id: sister, text: "sister bicycle" },
	],
});
const ckOkay = { valid: true, issues: [] };
const ckReject = { valid: false, issues: [{ id: "sister", problem: "loss" }] };

it.each([false, true])(
	"binds a regenerated correction to the saved Edit only with unique support (split: %s)",
	async (split) => {
		const f = await setup();
		const replies: unknown[] = [
			ckPlan,
			ckProposal("kayak", ""),
			ckOkay,
			ckOkay,
		];
		const fixture = await nativeFixture(f, replies);
		f.db
			.insert(f.s.conversations)
			.values({ id: "original-chat", userId: h.userId, title: "Paddling" })
			.run();
		f.db
			.insert(f.s.messages)
			.values({
				id: "original-message",
				conversationId: "original-chat",
				role: "user",
				content: f.source.text,
			})
			.run();
		f.db
			.update(f.s.memorySourceRevisions)
			.set({
				conversationId: "original-chat",
				messageId: "original-message",
				assertedAt: new Date(f.source.assertedAt.getTime() - 86_400_000),
			})
			.run();
		const fetch = fixture.fetcher.getMockImplementation();
		if (!fetch) throw Error("missing native fixture");
		fixture.fetcher.mockImplementation(async (url, init) => {
			const path = String(url);
			if (path.endsWith("/memories") && init?.method === "POST") {
				const item = JSON.parse(String(init.body)).items[0];
				fixture.setFacts([
					{ id: "kayak", text: "green kayak" },
					{ id: "sister", text: "sister bicycle" },
					{
						id: "correction",
						text: "purple kayak",
						document_id: item.document_id,
					},
					...(split
						? [
								{
									id: "second-correction",
									text: "purple boat",
									document_id: item.document_id,
								},
							]
						: []),
				]);
			}
			return fetch(url, init);
		});
		const actions = await import("./curation-actions");
		const reads = await import("./native-read");
		const jobs = await import("./delivery-job");
		const op = await actions.submitMemoryAction(h.userId, {
			kind: "edit",
			ref: ckRef,
			text: "I paddle a purple kayak",
			requestId: randomUUID(),
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		const operation = actions.getMemoryOperation(h.userId, { id: op.id });
		expect(operation.status).toBe("applied");
		const page = reads.listMemory(h.userId, { scope: ckRef.scope });
		const corrected = page.rows.find((row) => row.text === "purple kayak");
		if (!corrected) throw Error("missing corrected memory");
		const detail = reads.getMemoryDetail(h.userId, corrected.ref);
		if (split) {
			expect(operation.ref).toBeNull();
			expect(detail.versions).toEqual([]);
		} else {
			expect(operation.ref).toEqual(corrected.ref);
			expect(corrected.sourceCount).toBe(1);
			expect(detail).toMatchObject({
				origin: "conversation",
				versions: [{ text: "kayak" }],
				sources: [
					{
						title: "Paddling",
						quote: "green kayak and sister's bicycle",
						messageId: "original-message",
						available: true,
					},
				],
			});
			const { eq } = await import("drizzle-orm");
			f.db
				.update(f.s.memoryPublishedRows)
				.set({ nativeId: "regenerated-correction" })
				.where(eq(f.s.memoryPublishedRows.nativeId, corrected.ref.rowId))
				.run();
			const regenerated = { ...corrected.ref, rowId: "regenerated-correction" };
			expect(reads.getMemoryDetail(h.userId, regenerated).versions).toEqual(
				detail.versions,
			);

			replies.push(
				{ forget: ["purple"], replace: [], preserve: ["kayak ownership"] },
				{ facts: [{ id: "correction", text: "kayak" }] },
				{
					...ckOkay,
					changed_proposal_origins: [
						{
							id: "correction",
							relation: "same_source",
							supporting_fact_ids: ["correction"],
						},
					],
				},
				ckOkay,
			);
			const omitted = await actions.submitMemoryAction(h.userId, {
				kind: "edit",
				ref: regenerated,
				text: "I paddle a kayak",
				requestId: randomUUID(),
			});
			await h.engine.drain(jobs.memoryDeliveryJob);
			const afterOmission = actions.getMemoryOperation(h.userId, {
				id: omitted.id,
			});
			if (!afterOmission.ref) throw Error("missing edited result");
			expect(reads.getMemoryDetail(h.userId, afterOmission.ref)).toMatchObject({
				origin: "conversation",
				versions: [{ text: "purple kayak" }, { text: "kayak" }],
				sources: [
					{ quote: "green kayak and sister's bicycle", available: true },
				],
			});
			f.db.update(f.s.conversations).set({ memoryIncognito: true }).run();
			expect(reads.getMemoryDetail(h.userId, afterOmission.ref).origin).toBe(
				"conversation",
			);
			expect(
				reads.getMemoryDetail(h.userId, afterOmission.ref).sources,
			).not.toContainEqual(expect.objectContaining({ available: true }));
			f.db.update(f.s.conversations).set({ memoryIncognito: false }).run();
			const rev = await import("./revisions");
			const correctionSource = f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(eq(f.s.memorySourceRevisions.eventId, `manual:${op.id}`))
				.get();
			if (!correctionSource) throw Error("missing accepted correction source");
			const appended = `${f.source.text}. I play chess.`;
			f.db
				.insert(f.s.messages)
				.values({
					id: "appended-message",
					conversationId: "original-chat",
					role: "user",
					content: appended,
				})
				.run();
			rev.revokeMemorySources(h.userId, [f.source.id]);
			const resend = rev.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				eventId: "chat-append",
				lineageId: f.source.lineageId,
				conversationId: "original-chat",
				messageId: "appended-message",
				predecessorSourceId: f.source.id,
				text: appended,
				context: "",
				assertedAt: f.source.assertedAt,
				explicitEditAt: new Date(f.source.assertedAt.getTime() + 60_000),
			});
			fixture.fetcher.mockImplementation(async (url, init) => {
				if (String(url).endsWith("/memories") && init?.method === "POST")
					fixture.setFacts([
						{ id: "sister", text: "sister bicycle" },
						{
							id: "correction",
							text: "kayak",
							document_id: correctionSource.id,
						},
						{ id: "chess", text: "I play chess.", document_id: resend.id },
					]);
				return fetch(url, init);
			});
			let finalVerification: unknown;
			fixture.model.mockImplementation(async (_prompt, payload) => {
				if ("facts" in payload)
					return { facts: [{ id: "sister", text: "sister bicycle" }] };
				if ("displayed_observations" in payload) {
					finalVerification = payload;
					return payload.ordered_edits?.some(
						(edit: { before: string }) => edit.before === "purple kayak",
					) &&
						payload.proposed_facts.some(
							(fact: { id: string; text: string }) =>
								fact.id === "correction" && fact.text === "kayak",
						)
						? ckOkay
						: ckReject;
				}
				if ("original_facts" in payload) return ckOkay;
				return {
					forget: [],
					replace: ["I play chess"],
					preserve: ["sister bicycle"],
				};
			});
			const resendJob = await jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source",
				sourceId: resend.id,
				requestId: "chat-append",
			});
			await h.engine.drain(jobs.memoryDeliveryJob);
			expect(finalVerification).toMatchObject({
				ordered_edits: [
					expect.objectContaining({
						after: "I paddle a purple kayak",
						sources: expect.arrayContaining([correctionSource.id]),
					}),
					expect.objectContaining({
						after: "I paddle a kayak",
						sources: [correctionSource.id],
					}),
					expect.objectContaining({ after: appended }),
				],
				proposed_facts: expect.arrayContaining([
					expect.objectContaining({
						id: "correction",
						text: "kayak",
						sourceId: correctionSource.id,
					}),
					expect.objectContaining({ id: "chess", text: "I play chess." }),
				]),
			});
			expect(
				f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(eq(f.s.memoryDeliveryJobs.id, resendJob.row.id))
					.get()?.status,
			).toBe("succeeded");
			expect(
				reads
					.listMemory(h.userId, { scope: ckRef.scope })
					.rows.map(({ text }) => text)
					.sort(),
			).toEqual(["I play chess.", "kayak", "sister bicycle"]);
		}
	},
);

it("a removal-only Edit keeps the retained claim at its original date without a new native assertion", async () => {
	const f = await setup();
	const plan = {
		forget: ["green"],
		replace: [],
		preserve: ["kayak ownership"],
	};
	const fixture = await nativeFixture(f, []);
	fixture.model.mockImplementation(async (_prompt, payload) => {
		if (!("facts" in payload) && !("original_facts" in payload)) return plan;
		if ("facts" in payload) return ckProposal("kayak", "kayak");
		const historical = payload.proposed_facts.find((fact: { text: string }) =>
			fact.text.includes("green"),
		);
		return historical
			? {
					valid: false,
					issues: [{ id: historical.id, problem: historical.text }],
				}
			: ckOkay;
	});
	const fetch = fixture.fetcher.getMockImplementation();
	if (!fetch) throw Error("missing native fixture");
	fixture.fetcher.mockImplementation(async (url, init) => {
		if (String(url).endsWith("/memories") && init?.method === "POST") {
			const item = JSON.parse(String(init.body)).items[0];
			fixture.setFacts([
				{ id: "kayak", text: "green kayak" },
				{ id: "sister", text: "sister bicycle" },
				{
					id: "historical",
					text: "The earlier green detail was removed.",
					document_id: item.document_id,
				},
			]);
		}
		return fetch(url, init);
	});
	const actions = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await actions.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: ckRef,
		text: "I own a kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(actions.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "applied",
		ref: { rowId: "observation-kayak" },
	});
	const { rows } = (await import("./native-read")).listMemory(h.userId, {
		scope: ckRef.scope,
	});
	expect(rows).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				text: "kayak",
				updatedAt: f.source.assertedAt.toISOString(),
			}),
			expect.objectContaining({ text: "sister bicycle" }),
		]),
	);
	expect(rows).toHaveLength(2);
	expect(f.db.select().from(f.s.memorySourceRevisions).all()).toHaveLength(1);
});

it.each(["rewritten", "unchanged", "independent later"] as const)(
	"keeps exact assertion dates after chained omission (%s)",
	async (mode) => {
		const f = await setup();
		const { eq } = await import("drizzle-orm");
		const { recordMemorySource } = await import("./revisions");
		const { publishNativeSnapshot } = await import("./publication");
		const olderDate = new Date("2026-08-03T12:00:00Z");
		const laterDate = new Date("2026-08-05T12:00:00Z");
		const acceptedAction = randomUUID();
		const ownership = "The user owns a kayak.";
		const laterClaim = "The user paddles on Mondays.";
		const independent = mode === "independent later";
		const material = `The user's kayak is purple.${independent ? ` ${laterClaim}` : ""}`;
		const manual = recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: `manual:${acceptedAction}`,
			lineageId: acceptedAction,
			text: independent
				? "I own a purple kayak. I paddle on Mondays."
				: "I own a purple kayak.",
			context: "",
			assertedAt: laterDate,
		});
		f.db
			.update(f.s.memorySourceRevisions)
			.set({
				assertedAt: olderDate,
				acknowledgedFactsJson: JSON.stringify([
					{ id: "kayak", text: ownership },
				]),
			})
			.where(eq(f.s.memorySourceRevisions.id, f.source.id))
			.run();
		f.db
			.update(f.s.memorySourceRevisions)
			.set({
				state: "accepted",
				acknowledgedFactsJson: JSON.stringify([
					{ id: "delta", text: material },
				]),
			})
			.where(eq(f.s.memorySourceRevisions.id, manual.id))
			.run();
		const requestId = randomUUID();
		f.db
			.insert(f.s.memoryActions)
			.values({
				id: acceptedAction,
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "edit",
				requestId,
				text: manual.text,
				previousText: "The user owns a green kayak.",
				intentJson: JSON.stringify({
					request: { kind: "edit", requestId, ref: ckRef, text: manual.text },
					before: "The user owns a green kayak.",
					outcome: "accepted",
					sourceIds: [f.source.id],
					addedSourceId: manual.id,
					facts: [
						{
							id: "kayak",
							text:
								mode === "rewritten"
									? "The user owns a green kayak."
									: ownership,
							sourceId: f.source.id,
						},
						...(mode === "rewritten"
							? []
							: [
									{
										id: "old-color",
										text: "The user's kayak is green.",
										sourceId: f.source.id,
									},
								]),
					],
					proposal: [
						{ id: "kayak", text: ownership },
						...(mode === "rewritten" ? [] : [{ id: "old-color", text: "" }]),
					],
					nativeFacts: [{ id: "delta", text: material }],
				}),
			})
			.run();
		const raw = [
			{ id: "kayak", text: ownership, document_id: f.source.id },
			{ id: "delta", text: material, document_id: manual.id },
		];
		const generation = f.db.transaction((tx) =>
			publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				expectedRevision: 0,
				memories: [
					...raw.map((fact) => ({
						...fact,
						fact_type: "world",
						consolidated_at: "2026-08-05",
					})),
					...raw.map((fact) => ({
						id: `observation-${fact.id}`,
						text: fact.text,
						fact_type: "observation",
						source_memory_ids: [fact.id],
					})),
				],
			}),
		);
		const fixture = await nativeFixture(f, []);
		fixture.setFacts(raw);
		fixture.model.mockImplementation(async (_prompt, payload) => {
			if ("displayed_observations" in payload) return ckOkay;
			if ("facts" in payload) {
				expect(payload.earlier_preserved_facts).toMatchObject([
					{
						id: "kayak",
						sourceId: f.source.id,
						assertion_at: olderDate.toISOString(),
					},
				]);
				return {
					facts: [
						{
							id: "delta",
							text: independent
								? laterClaim
								: payload.repair_issues
									? ""
									: ownership,
						},
					],
				};
			}
			if ("original_facts" in payload) {
				const removed =
					payload.proposed_facts.find(
						(fact: { id: string }) => fact.id === "delta",
					).text === "";
				return {
					...ckOkay,
					changed_proposal_origins: [
						{
							id: "delta",
							relation: independent
								? "same_source"
								: removed
									? "empty"
									: "earlier",
							supporting_fact_ids: independent
								? ["delta"]
								: removed
									? []
									: ["kayak"],
						},
					],
				};
			}
			return {
				forget: ["purple"],
				replace: [],
				preserve: independent ? [ownership, laterClaim] : [ownership],
			};
		});
		const actions = await import("./curation-actions");
		const jobs = await import("./delivery-job");
		const op = await actions.submitMemoryAction(h.userId, {
			kind: "edit",
			ref: { ...ckRef, generation, rowId: "observation-delta" },
			text: independent
				? "I own a kayak. I paddle on Mondays."
				: "I own a kayak.",
			requestId: randomUUID(),
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		expect(actions.getMemoryOperation(h.userId, { id: op.id }).status).toBe(
			"applied",
		);
		expect(fixture.patches).toEqual(["delta"]);
		const { rows } = (await import("./native-read")).listMemory(h.userId, {
			scope: ckRef.scope,
		});
		expect(rows.map(({ text, updatedAt }) => ({ text, updatedAt }))).toEqual([
			...(independent
				? [{ text: laterClaim, updatedAt: laterDate.toISOString() }]
				: []),
			{ text: ownership, updatedAt: olderDate.toISOString() },
		]);
	},
);

it("the authoritative Edit check rejects a new assertion missed by a removal-only plan", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	fixture.model.mockImplementation(async (prompt, payload) => {
		if (!("facts" in payload) && !("original_facts" in payload))
			return { forget: ["green"], replace: [], preserve: ["kayak ownership"] };
		if ("facts" in payload) return ckProposal("kayak", "kayak");
		expect(payload.user_saved_after).toBe("I own a kayak. It is not red.");
		expect(prompt).toContain(
			"The authoritative edit is displayed_before -> user_saved_after",
		);
		expect(payload.proposed_facts).not.toContainEqual(
			expect.objectContaining({
				text: expect.stringContaining("not red"),
			}),
		);
		return {
			valid: false,
			issues: [
				{
					id: "kayak",
					problem: "Missing the explicit claim that the kayak is not red",
				},
			],
		};
	});
	const actions = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await actions.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: ckRef,
		text: "I own a kayak. It is not red.",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(actions.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "failed",
		ref: null,
	});
	expect(fixture.patches).toHaveLength(0);
	expect(f.db.select().from(f.s.memorySourceRevisions).all()).toHaveLength(1);
	expect(f.db.select().from(f.s.memoryBanks).get()?.generation).toBe("g");
});

async function ckRebuild(
	f: Awaited<ReturnType<typeof setup>>,
	fixture: Awaited<ReturnType<typeof nativeFixture>>,
) {
	const { enqueueMemoryDelivery, memoryDeliveryJob } = await import(
		"./delivery-job"
	);
	fixture.setFacts([
		{ id: "new-kayak", text: "green kayak" },
		{ id: "new-sister", text: "sister bicycle" },
	]);
	await enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: f.source.id,
		requestId: "ck-rebuild",
	});
	await h.engine.drain(memoryDeliveryJob);
	return (await import("./publication"))
		.readPublishedMemory(h.userId, f.bank.id)
		.map((r) => r.text)
		.sort();
}
it("rejected edit never becomes authoritative during re-extraction", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		ckPlan,
		ckProposal("kayak", ""),
		ckReject,
		ckProposal("kayak", ""),
		ckReject,
		ckProposal("new-kayak", "purple kayak", "new-sister"),
		ckOkay,
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		text: "purple kayak",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("failed");
	expect(await ckRebuild(f, fixture)).toEqual([
		"green kayak",
		"sister bicycle",
	]);
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("failed");
});
it("acknowledged removal holds replacement IDs through a retryable planner outage", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "queued",
		retryable: true,
		exclusionAcknowledged: true,
	});
	// Exhausted retry history must not make the source reprocessing path bypass exclusion.
	f.db.update(f.s.memoryDeliveryJobs).set({ status: "failed" }).run();
	expect(await ckRebuild(f, fixture)).toEqual(["sister"]);
});
it("replay refuses a successful PATCH that did not take effect", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["kayak"], replace: [], preserve: ["sister"] },
		ckProposal("kayak", ""),
		ckOkay,
		ckOkay,
		ckProposal("new-kayak", "", "new-sister"),
		ckOkay,
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("applied");
	const fetcher = fixture.fetcher.getMockImplementation();
	if (!fetcher) throw Error("missing fixture");
	fixture.fetcher.mockImplementation(async (u, i) =>
		i?.method === "PATCH" && String(u).endsWith("/new-kayak")
			? new Response("{}")
			: fetcher(u, i),
	);
	expect(await ckRebuild(f, fixture)).toEqual(["sister bicycle"]);
});
it("overlapping removal is refused before acknowledgement", async () => {
	const f = await setup();
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const fixture = await nativeFixture(f, [
		ckPlan,
		ckProposal("kayak", "purple kayak"),
		ckOkay,
		ckOkay,
	]);
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("missing fixture");
	let removeId = "";
	fixture.fetcher.mockImplementation(async (u, i) => {
		if (!removeId && i?.method === "PATCH") {
			removeId = "attempted";
			await expect(
				a.submitMemoryAction(h.userId, {
					kind: "remove",
					ref: ckRef,
					requestId: randomUUID(),
				}),
			).rejects.toThrow("memory_action_pending");
		}
		return original(u, i);
	});
	const e = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: ckRef,
		text: "purple kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: e.id }).status).toBe("applied");
	expect(f.db.select().from(f.s.memoryActions).all()).toHaveLength(1);
	expect(
		(await import("./publication"))
			.readPublishedMemory(h.userId, f.bank.id)
			.map((r) => r.text),
	).toContain("purple kayak");
});
it("add without a visible observation never reports applied", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const orig = fixture.fetcher.getMockImplementation();
	if (!orig) throw Error("missing fixture");
	let doc = "";
	fixture.fetcher.mockImplementation(async (u, i) => {
		if (i?.method === "DELETE" && String(u).includes("/documents/")) doc = "";
		if (String(u).endsWith("/memories") && i?.method === "POST")
			doc = JSON.parse(String(i.body)).items[0].document_id;
		if (doc && String(u).includes("/memories/list")) {
			const base = await (await orig(u, i)).json();
			const items = [
				...base.items,
				{
					id: "new-fact",
					text: "I paddle",
					fact_type: "world",
					document_id: doc,
					consolidated_at: "2026-11-01",
				},
			];
			return new Response(
				JSON.stringify({ items, total: items.length, offset: 0 }),
			);
		}
		return orig(u, i);
	});
	const op = await a.submitMemoryAction(h.userId, {
		kind: "add",
		text: "I paddle",
		scope: { kind: "personal" },
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "failed",
		ref: null,
	});
	expect(
		(await import("./native-read")).listMemory(h.userId, {
			scope: { kind: "personal" },
			query: "I paddle",
		}).rows,
	).toHaveLength(0);
});
it("new native delta participates in the same bounded mixed Edit check", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{
			forget: ["green"],
			replace: ["sails on Tuesdays"],
			preserve: ["kayak", "sister"],
		},
		ckProposal("kayak", "kayak"),
		ckReject,
		ckProposal("kayak", "kayak"),
		ckReject,
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const orig = fixture.fetcher.getMockImplementation();
	if (!orig) throw Error("missing fixture");
	let doc = "";
	fixture.fetcher.mockImplementation(async (u, i) => {
		if (i?.method === "DELETE" && String(u).includes("/documents/")) doc = "";
		if (String(u).endsWith("/memories") && i?.method === "POST")
			doc = JSON.parse(String(i.body)).items[0].document_id;
		if (doc && String(u).includes("/memories/list")) {
			const base = await (await orig(u, i)).json();
			const items = [
				...base.items,
				{
					id: "wrong-native",
					text: "green kayak",
					fact_type: "world",
					document_id: doc,
					consolidated_at: "2026-11-01",
				},
				{
					id: "wrong-observation",
					text: "green kayak",
					fact_type: "observation",
					source_memory_ids: ["wrong-native"],
				},
			];
			return new Response(
				JSON.stringify({ items, total: items.length, offset: 0 }),
			);
		}
		return orig(u, i);
	});
	const op = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		text: "I own a kayak and sail on Tuesdays.",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("failed");
	expect(fixture.model).toHaveBeenCalledTimes(5);
	expect(fixture.model.mock.calls[2][1]).toMatchObject({
		new_facts: [
			{
				id: "wrong-native",
				text: "green kayak",
				assertion_at: expect.any(String),
				native_mentioned_at: null,
			},
		],
		proposed_facts: expect.arrayContaining([
			expect.objectContaining({
				id: "wrong-native",
				text: "green kayak",
				assertion_at: expect.any(String),
				native_mentioned_at: null,
			}),
		]),
	});
	expect(
		(await import("./publication"))
			.readPublishedMemory(h.userId, f.bank.id)
			.map((r) => r.text),
	).not.toContain("green kayak");
});

it.each([false, true])(
	"rejected Edit recovery republishes a regenerated observation only when its accepted support and text match (changed: %s)",
	async (changed) => {
		const f = await setup();
		const fixture = await nativeFixture(f, [
			ckPlan,
			ckProposal("kayak", "purple kayak"),
			ckReject,
			ckProposal("kayak", "purple kayak"),
			ckReject,
		]);
		const { eq } = await import("drizzle-orm");
		for (const [id, text] of [
			["kayak", "green kayak"],
			["sister", "sister bicycle"],
		])
			f.db
				.update(f.s.memoryPublishedRows)
				.set({ text, nativeText: text, nativeId: `observation-${id}` })
				.where(eq(f.s.memoryPublishedRows.id, id))
				.run();
		const fetch = fixture.fetcher.getMockImplementation();
		if (!fetch) throw Error("missing native fixture");
		let deleted = false;
		fixture.fetcher.mockImplementation(async (url, init) => {
			const path = String(url);
			if (init?.method === "DELETE" && path.includes("/documents/"))
				deleted = true;
			if (path.endsWith("/memories/recall"))
				return new Response(
					JSON.stringify({
						results: [
							{
								id: "renumbered-kayak",
								text: changed ? "the kayak was green" : "green kayak",
								type: "observation",
								source_fact_ids: ["kayak"],
							},
							{
								id: "observation-sister",
								text: "sister bicycle",
								type: "observation",
								source_fact_ids: ["sister"],
							},
						],
					}),
				);
			const response = await fetch(url, init);
			if (!deleted || !path.includes("/memories/list")) return response;
			const list = await response.json();
			const observation = list.items.find(
				(row: { id: string }) => row.id === "observation-kayak",
			);
			observation.id = "renumbered-kayak";
			if (changed) observation.text = "the kayak was green";
			return new Response(JSON.stringify(list));
		});
		const actions = await import("./curation-actions");
		const jobs = await import("./delivery-job");
		const op = await actions.submitMemoryAction(h.userId, {
			kind: "edit",
			text: "I paddle a purple kayak",
			ref: { ...ckRef, rowId: "observation-kayak" },
			requestId: randomUUID(),
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		expect(actions.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
			status: "failed",
			cleanupPending: false,
		});
		const rows = (await import("./native-read")).listMemory(h.userId, {
			scope: ckRef.scope,
		}).rows;
		expect(rows).toHaveLength(2);
		expect(rows.find(({ text }) => text === "green kayak")?.ref.rowId).toBe(
			changed ? "observation-kayak" : "renumbered-kayak",
		);
		f.db
			.insert(f.s.conversations)
			.values({ id: "recall-only", userId: h.userId, title: "Recall" })
			.run();
		const { recallMemory } = await import("../memory-context/native");
		const recalled = await recallMemory(h.userId, {
			conversationId: "recall-only",
			query: "kayak and bicycle",
			tokenBudget: 500,
		});
		expect(recalled.map(({ text }) => text)).toEqual(
			changed ? ["sister bicycle"] : ["green kayak", "sister bicycle"],
		);
	},
);
it("queued remember never dispatches after chat becomes Incognito", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	f.db
		.insert(f.s.conversations)
		.values({ id: "draft", userId: h.userId, title: "draft" })
		.run();
	await a.submitRememberNote(h.userId, {
		text: "private note",
		requestId: randomUUID(),
		conversationId: "draft",
	});
	const chats = await import("../conversations");
	await chats.setConversationMemoryIncognito(h.userId, "draft");
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(
		fixture.fetcher.mock.calls.some(
			([u, i]) =>
				String(u).endsWith("/memories") &&
				i?.method === "POST" &&
				JSON.parse(String(i.body)).items[0].content === "private note",
		),
	).toBe(false);
});

it("a completed Edit preserves verified history through refresh, job pruning and disabled owner export", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		ckPlan,
		ckProposal("kayak", "purple kayak"),
		ckOkay,
		ckOkay,
	]);
	const { eq } = await import("drizzle-orm");
	f.db
		.update(f.s.memoryPublishedRows)
		.set({ nativeId: "observation-kayak" })
		.where(eq(f.s.memoryPublishedRows.id, "kayak"))
		.run();
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: { ...ckRef, rowId: "observation-kayak" },
		text: "I now paddle a purple kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("applied");
	f.db.delete(f.s.memoryDeliveryJobs).run();
	expect(a.getMemoryOperation(h.userId, { id: op.id }).status).toBe("applied");
	const read = await import("./native-read");
	const refreshed = read.listMemory(h.userId, { scope: { kind: "personal" } });
	const row = refreshed.rows.find((r) => r.text === "purple kayak");
	expect(row?.ref.rowId).toBe("observation-kayak");
	expect(
		read.verifiedMemoryHistory(h.userId, f.bank.id, 0, "observation-kayak"),
	).toHaveLength(1);
	// This row is historical action feedback, not outstanding background repair.
	f.db
		.insert(f.s.memoryDeliveryJobs)
		.values({
			id: randomUUID(),
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			kind: "action",
			actionId: op.id,
			requestId: randomUUID(),
			status: "failed",
			errorCode: "memory_edit_rejected",
		})
		.run();
	expect(
		read.listMemory(h.userId, { scope: { kind: "personal" } }).status,
	).toBe("ready");
	const { setMemoryEnabled } = await import("./migration-policy");
	await setMemoryEnabled(h.userId, false);
	const bcrypt = await import("bcryptjs");
	const password = "synthetic-test-password";
	f.db
		.update(f.s.users)
		.set({ passwordHash: await bcrypt.default.hash(password, 4) })
		.where(eq(f.s.users.id, h.userId))
		.run();
	const { createAccountDataArchive } = await import("../account-data-archive");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { default: JSZip } = await import("jszip");
	const rootDir = await mkdtemp(join(tmpdir(), "hindsight-curation-export-"));
	try {
		const exportMemory = async () => {
			const archive = await createAccountDataArchive(h.userId, {
				password,
				db: f.db,
				rootDir,
			});
			if (archive.status !== "ok") throw Error(archive.status);
			const files = await JSZip.loadAsync(
				await new Response(archive.zipStream).arrayBuffer(),
			);
			return files.file("Memory/Memory.html")?.async("string");
		};
		const html = await exportMemory();
		expect(html).toContain("I now paddle a purple kayak");
		expect(html).toContain("purple kayak");
		(await import("./revisions")).revokeMemorySources(h.userId, [f.source.id]);
		const revoked = await exportMemory();
		expect(revoked).not.toContain("purple kayak");
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
	expect(fixture.model).toHaveBeenCalledTimes(4);
});

it("rejected delta cleanup retries without re-extracting or replaying the failed edit", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		ckPlan,
		ckProposal("kayak", ""),
		ckReject,
		ckProposal("kayak", ""),
		ckReject,
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("missing fixture");
	let failures = 1;
	fixture.fetcher.mockImplementation(async (u, i) =>
		i?.method === "DELETE" && failures-- > 0
			? new Response("unavailable", { status: 503 })
			: original(u, i),
	);
	const op = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: ckRef,
		text: "purple kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "queued",
		cleanupPending: true,
	});
	const { eq } = await import("drizzle-orm");
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({ runAfter: new Date(0) })
		.where(eq(f.s.memoryDeliveryJobs.actionId, op.id))
		.run();
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "failed",
		cleanupPending: false,
	});
	expect(fixture.model).toHaveBeenCalledTimes(5);
	expect(
		fixture.fetcher.mock.calls.filter(
			([u, i]) => String(u).endsWith("/memories") && i?.method === "POST",
		),
	).toHaveLength(1);
	expect(await ckRebuild(f, fixture)).toEqual([
		"green kayak",
		"sister bicycle",
	]);
});

it("does not admit a new raw fact inserted after the bounded proposal check", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["kayak"], replace: [], preserve: ["sister"] },
		ckProposal("kayak", ""),
		ckOkay,
	]);
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("missing fixture");
	let patched = false;
	fixture.fetcher.mockImplementation(async (u, i) => {
		if (i?.method === "PATCH") patched = true;
		const result = await original(u, i);
		if (patched && String(u).includes("/memories/list")) {
			const body = await result.json();
			const items = [
				...body.items,
				{
					id: "surprise",
					text: "green kayak",
					fact_type: "world",
					document_id: f.source.id,
					consolidated_at: "2026-11-01",
				},
				{
					id: "surprise-observation",
					text: "green kayak",
					fact_type: "observation",
					source_memory_ids: ["surprise"],
				},
			];
			return new Response(
				JSON.stringify({ items, total: items.length, offset: 0 }),
			);
		}
		return result;
	});
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "failed",
		exclusionAcknowledged: true,
		cleanupPending: true,
	});
	expect(
		(await import("./publication"))
			.readPublishedMemory(h.userId, f.bank.id)
			.map((r) => r.text),
	).toEqual(["sister"]);
});

it("uses the existing configured binding after the active key changes", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["kayak"], replace: [], preserve: ["sister bicycle"] },
		{
			facts: [
				{ id: "kayak", text: "" },
				{ id: "sister", text: "sister bicycle" },
			],
		},
		{ valid: true, issues: [] },
		ckOkay,
	]);
	const { HINDSIGHT_ENGINE_COMMIT } = await import("./contracts");
	f.db
		.update(f.s.memoryBanks)
		.set({
			nativeBaseUrl: "http://synthetic",
			nativeCredentialHash: "retained-key-hash",
			nativeConfigVersion: HINDSIGHT_ENGINE_COMMIT,
		})
		.run();
	const actions = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await actions.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: { scope: { kind: "personal" }, generation: "g", rowId: "kayak" },
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(actions.getMemoryOperation(h.userId, { id: op.id }).status).toBe(
		"applied",
	);
	expect(
		fixture.fetcher.mock.calls.some(([, init]) => init?.method === "PUT"),
	).toBe(false);
	expect(f.db.select().from(f.s.memoryBanks).get()?.nativeCredentialHash).toBe(
		"retained-key-hash",
	);
});

it("records the first action binding before sending native bank creation", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	const { NATIVE_BANK_CONFIG_PENDING } = await import("./contracts");
	const original = fixture.fetcher.getMockImplementation();
	let bindingAtConfigure: typeof f.s.memoryBanks.$inferSelect | undefined;
	fixture.fetcher.mockImplementation(async (url, init) => {
		if (String(url).endsWith("/config") && init?.method === "PATCH") {
			bindingAtConfigure = f.db.select().from(f.s.memoryBanks).get();
			return new Response("synthetic lost acknowledgement", { status: 503 });
		}
		return original?.(url, init) ?? new Response();
	});
	const actions = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	await actions.submitMemoryAction(h.userId, {
		kind: "add",
		scope: { kind: "personal" },
		text: "I own a purple kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(bindingAtConfigure).toMatchObject({
		nativeBaseUrl: "http://synthetic",
		nativeCredentialHash: "key-hash",
		nativeConfigVersion: NATIVE_BANK_CONFIG_PENDING,
	});
});

it("lifecycle regression: Remove withholds a stale displayed observation despite clean raw facts", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["green kayak"], replace: [], preserve: ["sister bicycle"] },
		ckProposal("kayak", "", "sister"),
		ckOkay,
	]);
	fixture.model
		.mockImplementationOnce(async () => ({
			forget: ["green kayak"],
			replace: [],
			preserve: ["sister bicycle"],
		}))
		.mockResolvedValueOnce(ckProposal("kayak", "", "sister"))
		.mockResolvedValueOnce(ckOkay)
		.mockImplementation(async (_prompt, input) =>
			input.displayed_observations?.some(({ text }: { text: string }) =>
				text.includes("green kayak"),
			)
				? ckReject
				: ckOkay,
		);
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("missing native fixture");
	fixture.fetcher.mockImplementation(async (u, i) => {
		const res = await original(u, i);
		if (!String(u).includes("/memories/list")) return res;
		const body = await res.json();
		for (const m of body.items)
			if (m.id === "observation-sister")
				m.text = "green kayak and sister bicycle";
		return new Response(JSON.stringify(body));
	});
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		exclusionAcknowledged: true,
		cleanupPending: true,
		errorCode: "memory_dependency_check_rejected",
	});
	expect(
		(await import("./native-read"))
			.listMemory(h.userId, { scope: { kind: "personal" } })
			.rows.map((r) => r.text),
	).toEqual(["sister"]);
	expect(fixture.model.mock.calls.at(-1)?.[1]).toMatchObject({
		displayed_observations: [{ text: "green kayak and sister bicycle" }],
	});
	expect(fixture.model).toHaveBeenCalledTimes(4);
});

it("settles the retained Edit’s native consolidation before requesting a proposal", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	let deltaId: string | undefined;
	let consolidationPending = false;
	const settlement = vi.fn();
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("missing native fixture");
	fixture.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.endsWith("/memories") && init?.method === "POST") {
			deltaId = JSON.parse(String(init.body)).items[0].document_id;
			consolidationPending = true;
		}
		if (path.includes("/operations?status=pending") && consolidationPending)
			return Response.json({
				operations: [{ id: "native-retain-consolidation", status: "pending" }],
			});
		if (path.endsWith("/operations/native-retain-consolidation")) {
			settlement();
			consolidationPending = false;
			return Response.json({ status: "completed" });
		}
		const response = await original(url, init);
		if (!deltaId || !path.includes("/memories/list")) return response;
		const body = await response.json();
		body.items.push(
			{
				id: "edited-purple",
				text: "purple kayak",
				document_id: deltaId,
				fact_type: "world",
				consolidated_at: "2026-11-01",
			},
			{
				id: "observation-purple",
				text: "purple kayak",
				fact_type: "observation",
				source_memory_ids: ["edited-purple"],
			},
		);
		body.total = body.items.length;
		return Response.json(body);
	});
	fixture.model
		.mockResolvedValueOnce(ckPlan)
		.mockImplementationOnce(async () => {
			if (consolidationPending) throw Error("Memory inference budget busy");
			return ckProposal("kayak", "", "sister");
		})
		.mockResolvedValue(ckOkay);
	const actions = await import("./curation-actions");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const operation = await actions.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: ckRef,
		text: "purple kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(memoryDeliveryJob);
	expect(
		actions.getMemoryOperation(h.userId, { id: operation.id }),
	).toMatchObject({
		status: "applied",
		cleanupPending: false,
	});
	expect(settlement).toHaveBeenCalledOnce();
	expect(fixture.model).toHaveBeenCalledTimes(4);
});

it("lifecycle regression: Edit withholds a candidate missing its requested visible change", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	fixture.model
		.mockResolvedValueOnce(ckPlan)
		.mockResolvedValueOnce(ckProposal("kayak", "", "sister"))
		.mockResolvedValueOnce(ckOkay)
		.mockImplementation(async (_prompt, input) =>
			input.displayed_observations?.some(({ text }: { text: string }) =>
				text.includes("purple kayak"),
			)
				? ckOkay
				: ckReject,
		);
	let deltaId: string | undefined;
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("missing native fixture");
	fixture.fetcher.mockImplementation(async (u, i) => {
		if (String(u).endsWith("/memories") && i?.method === "POST")
			deltaId = JSON.parse(String(i.body)).items[0].document_id;
		const res = await original(u, i);
		if (!String(u).includes("/memories/list")) return res;
		const body = await res.json();
		if (deltaId)
			body.items.push({
				id: "edited-purple",
				text: "purple kayak",
				document_id: deltaId,
				fact_type: "world",
				consolidated_at: "2026-11-01",
			});
		body.items = body.items.filter(
			(m: { id: string }) => m.id !== "observation-kayak",
		);
		body.total = body.items.length;
		return new Response(JSON.stringify(body));
	});
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: ckRef,
		text: "purple kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "queued",
		cleanupPending: true,
		retryable: true,
	});
	expect(
		(await import("./native-read"))
			.listMemory(h.userId, { scope: { kind: "personal" } })
			.rows.map((r) => r.text)
			.sort(),
	).toEqual(["kayak", "sister"]);
	expect(fixture.model.mock.calls.at(-1)?.[1]).toMatchObject({
		displayed_observations: [{ text: "sister bicycle" }],
	});
	expect(fixture.model).toHaveBeenCalledTimes(4);
});

it("lifecycle regression: Memory off during Remove APPLY bars the next checker dispatch", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	const { setMemoryEnabled } = await import("./migration-policy");
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const afterOff: unknown[] = [];
	let n = 0;
	fixture.model.mockImplementation(async (_prompt, input) => {
		if (n++ === 0)
			return { forget: ["kayak"], replace: [], preserve: ["sister bicycle"] };
		if (n === 2) {
			await setMemoryEnabled(h.userId, false); // A real off transaction while the APPLY response is outstanding.
			return ckProposal("kayak", "", "sister");
		}
		if (f.db.select().from(f.s.users).get()?.memoryEnabled === false)
			afterOff.push(input);
		return ckOkay;
	});
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(afterOff).toHaveLength(0);
	expect(fixture.model).toHaveBeenCalledTimes(2);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		exclusionAcknowledged: true,
		cleanupPending: true,
	});
});

it("lifecycle regression: an unchanged edit resend keeps the predecessor’s saved Remove effective", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["green kayak"], replace: [], preserve: ["sister bicycle"] },
		ckProposal("kayak", "", "sister"),
		ckOkay,
		ckOkay,
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const rev = await import("./revisions");
	const pub = await import("./publication");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "applied",
		cleanupPending: false,
	});
	expect(
		pub.readPublishedMemory(h.userId, f.bank.id).map((r) => r.text),
	).toEqual(["sister bicycle"]);
	rev.revokeMemorySources(h.userId, [f.source.id]);
	const next = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "unchanged",
		lineageId: f.source.lineageId,
		predecessorSourceId: f.source.id,
		text: f.source.text,
		context: "",
		assertedAt: f.source.assertedAt,
	});
	const requestsBefore = fixture.fetcher.mock.calls.length;
	const modelCallsBefore = fixture.model.mock.calls.length;
	const queued = await jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: next.id,
		requestId: "unchanged",
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	const { eq } = await import("drizzle-orm");
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(eq(f.s.memoryDeliveryJobs.id, queued.row.id))
			.get()?.status,
	).toBe("succeeded");
	expect(fixture.model).toHaveBeenCalledTimes(modelCallsBefore);
	expect(
		fixture.fetcher.mock.calls
			.slice(requestsBefore)
			.filter(
				([url, init]) =>
					String(url).endsWith("/memories") && init?.method === "POST",
			),
	).toEqual([]);
	expect(
		pub.readPublishedMemory(h.userId, f.bank.id).map((r) => r.text),
	).toEqual(["sister bicycle"]);
});

it("an unchanged edit resend never asks Hindsight about its own retain whose end is recorded", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["green kayak"], replace: [], preserve: ["sister bicycle"] },
		ckProposal("kayak", "", "sister"),
		ckOkay,
		ckOkay,
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const rev = await import("./revisions");
	const pub = await import("./publication");
	const { eq } = await import("drizzle-orm");
	await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	rev.revokeMemorySources(h.userId, [f.source.id]);
	const next = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "unchanged",
		lineageId: f.source.lineageId,
		predecessorSourceId: f.source.id,
		text: f.source.text,
		context: "",
		assertedAt: f.source.assertedAt,
	});
	// An earlier attempt sent the resend's retain, saw it cancelled and recorded
	// that end, then was lost before its failure was written; Hindsight has since
	// forgotten the operation.
	const ended = next.nativeOperationId as string;
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			nativeSubmitted: true,
			nativeAcknowledged: false,
			context: JSON.stringify({
				nativeRetainEnded: { operationId: ended, reason: "cancelled" },
			}),
		})
		.where(eq(f.s.memorySourceRevisions.id, next.id))
		.run();
	const asked: string[] = [];
	const inner = fixture.fetcher.getMockImplementation();
	if (!inner) throw Error("Missing fixture fetch");
	fixture.fetcher.mockImplementation(async (url, init) => {
		const op = String(url).split("/operations/")[1];
		if (op && decodeURIComponent(op) === ended) {
			asked.push(ended);
			return new Response("missing", { status: 404 });
		}
		return inner(url, init);
	});
	const queued = await jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: next.id,
		requestId: "unchanged",
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	const row = f.db
		.select()
		.from(f.s.memoryDeliveryJobs)
		.where(eq(f.s.memoryDeliveryJobs.id, queued.row.id))
		.get();
	expect({ status: row?.status, code: row?.errorCode }).toEqual({
		status: "succeeded",
		code: null,
	});
	expect(asked).toEqual([]);
	expect(
		pub.readPublishedMemory(h.userId, f.bank.id).map((r) => r.text),
	).toEqual(["sister bicycle"]);
});

it("an unrelated delivery cannot publish a previously refused Remove observation", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["green kayak"], replace: [], preserve: ["sister bicycle"] },
		ckProposal("kayak", ""),
		ckOkay,
		ckReject,
	]);
	let stale = true;
	let chessId: string | undefined;
	const transport = fixture.fetcher.getMockImplementation();
	if (!transport) throw Error("missing fixture");
	fixture.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.endsWith("/memories") && init?.method === "POST" && chessId) {
			fixture.setFacts([
				{ id: "sister", text: "sister bicycle" },
				{ id: "chess", text: "I play chess.", document_id: chessId },
			]);
		}
		if (path.endsWith("/memories/recall"))
			return new Response(
				JSON.stringify({
					results: [
						{
							id: "observation-sister",
							type: "observation",
							text: "green kayak and sister bicycle",
						},
					],
				}),
			);
		const response = await transport(url, init);
		if (!String(url).includes("/memories/list")) return response;
		const body = await response.json();
		for (const row of body.items)
			if (stale && row.id === "observation-sister")
				row.text = "green kayak and sister bicycle";
		return new Response(JSON.stringify(body));
	});
	const actions = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await actions.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(actions.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		errorCode: "memory_dependency_check_rejected",
		cleanupPending: true,
	});
	const { recordMemorySource } = await import("./revisions");
	const chess = recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "chess",
		lineageId: "chess",
		text: "I play chess.",
		context: "",
		assertedAt: new Date(),
	});
	chessId = chess.id;
	const delivery = await jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: chess.id,
		requestId: "chess",
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	const { eq } = await import("drizzle-orm");
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(eq(f.s.memoryDeliveryJobs.id, delivery.row.id))
			.get()?.status,
	).not.toBe("succeeded");
	const { readPublishedMemory } = await import("./publication");
	expect(
		readPublishedMemory(h.userId, f.bank.id).map((row) => row.text),
	).toEqual(["sister"]);
	expect(
		fixture.fetcher.mock.calls.some(
			([url, init]) =>
				String(url).endsWith("/memories") && init?.method === "POST",
		),
	).toBe(false);
	const chatId = "unrelated-recall";
	f.db
		.insert(f.s.conversations)
		.values({ id: chatId, userId: h.userId, title: "Recall fixture" })
		.run();
	const { recallMemory } = await import("../memory-context/native");
	const recalled = await recallMemory(h.userId, {
		conversationId: chatId,
		query: "green kayak",
		tokenBudget: 500,
	});
	expect(recalled.map((item) => item.text)).not.toContain(
		"green kayak and sister bicycle",
	);

	// The same Remove can retry once the native consolidated wording settles.
	stale = false;
	fixture.model.mockResolvedValueOnce(ckOkay);
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({ runAfter: new Date(0) })
		.where(eq(f.s.memoryDeliveryJobs.actionId, op.id))
		.run();
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(actions.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "applied",
		cleanupPending: false,
		exclusionAcknowledged: true,
	});
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({ runAfter: new Date(0) })
		.where(eq(f.s.memoryDeliveryJobs.id, delivery.row.id))
		.run();
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(
		readPublishedMemory(h.userId, f.bank.id)
			.map(({ text }) => text)
			.sort(),
	).toEqual(["I play chess.", "sister bicycle"]);
});

it.each([
	{
		repeated: true,
		after: "green kayak and sister's bicycle. I play chess.",
		extracted: "green kayak",
	},
	{
		repeated: false,
		after: "I bought a blue kayak. My sister has a bicycle.",
		extracted: "blue kayak",
	},
])(
	"changed resend distinguishes an unchanged removed detail from a deliberate new assertion ($extracted)",
	async ({ repeated, after, extracted }) => {
		const f = await setup();
		const fixture = await nativeFixture(f, [
			{ forget: ["green kayak"], replace: [], preserve: ["sister bicycle"] },
			ckProposal("kayak", ""),
			ckOkay,
			ckOkay,
		]);
		const actions = await import("./curation-actions");
		const jobs = await import("./delivery-job");
		const revisions = await import("./revisions");
		const { readPublishedMemory } = await import("./publication");
		const op = await actions.submitMemoryAction(h.userId, {
			kind: "remove",
			ref: ckRef,
			requestId: randomUUID(),
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		expect(actions.getMemoryOperation(h.userId, { id: op.id }).status).toBe(
			"applied",
		);
		revisions.revokeMemorySources(h.userId, [f.source.id]);
		const next = revisions.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "deliberate",
			lineageId: f.source.lineageId,
			predecessorSourceId: f.source.id,
			text: after,
			context: "",
			assertedAt: f.source.assertedAt,
			explicitEditAt: new Date(f.source.assertedAt.getTime() + 120_000),
		});
		const transport = fixture.fetcher.getMockImplementation();
		if (!transport) throw Error("missing fixture");
		fixture.fetcher.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/memories") && init?.method === "POST") {
				const content = JSON.parse(
					JSON.parse(String(init.body)).items[0].content,
				);
				expect(content).toMatchObject({
					kind: "source_edit",
					before: f.source.text,
					after,
				});
				fixture.setFacts([
					{ id: "sister", text: "sister bicycle", document_id: f.source.id },
					{ id: "changed-kayak", text: extracted, document_id: next.id },
				]);
			}
			return transport(url, init);
		});
		fixture.model
			.mockResolvedValueOnce({
				forget: [],
				replace: repeated ? [] : ["blue kayak"],
				preserve: ["sister bicycle"],
			})
			.mockResolvedValueOnce({
				facts: [{ id: "sister", text: "sister bicycle" }],
			})
			.mockResolvedValueOnce(ckOkay)
			.mockImplementation(async (_prompt, input) => {
				const beforeAndAfter = input.ordered_edits?.at(-1);
				const previouslyRemoved =
					input.ordered_edits?.[0]?.intent.forget.includes("green kayak");
				const isUnchangedGreen =
					beforeAndAfter?.before.includes("green kayak") &&
					beforeAndAfter?.after.includes("green kayak");
				return previouslyRemoved &&
					isUnchangedGreen &&
					input.displayed_observations.some(
						({ text }: { text: string }) => text === "green kayak",
					)
					? ckReject
					: ckOkay;
			});
		const job = await jobs.enqueueMemoryDelivery({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			kind: "source",
			sourceId: next.id,
			requestId: "deliberate",
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		const { eq } = await import("drizzle-orm");
		const result = f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(eq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get();
		const rows = readPublishedMemory(h.userId, f.bank.id);
		if (repeated) {
			expect(result?.errorCode).toBe("memory_dependency_check_rejected");
			expect(rows.map((row) => row.text)).not.toContain("green kayak");
		} else {
			expect(result?.status).toBe("succeeded");
			expect(rows.map((row) => row.text).sort()).toEqual([
				"blue kayak",
				"sister bicycle",
			]);
			expect(rows.find((row) => row.text === "blue kayak")?.updatedAt).toEqual(
				next.explicitEditAt,
			);
			expect(
				rows.find((row) => row.text === "sister bicycle")?.updatedAt,
			).toEqual(f.source.assertedAt);
		}
		expect(fixture.model.mock.calls.at(-1)?.[1]).toMatchObject({
			ordered_edits: [
				{ intent: { forget: ["green kayak"] } },
				{ before: f.source.text, after },
			],
		});
	},
);

it.each([false, true])(
	"turning Memory on compensates a cancelled Edit before unrelated delivery (lost restore response %s)",
	async (loseResponse) => {
		const f = await setup();
		const fixture = await nativeFixture(f, [
			ckPlan,
			ckProposal("kayak", "purple kayak"),
			ckOkay,
		]);
		const { setMemoryEnabled } = await import("./migration-policy");
		const actions = await import("./curation-actions");
		const jobs = await import("./delivery-job");
		const { recordMemorySource } = await import("./revisions");
		const { readPublishedMemory } = await import("./publication");
		const { eq } = await import("drizzle-orm");
		const transport = fixture.fetcher.getMockImplementation();
		if (!transport) throw Error("missing native fixture");
		const nativeText = new Map([
			["kayak", "green kayak"],
			["sister", "sister bicycle"],
		]);
		let setOff = false;
		let chessId: string | undefined;
		let lost = false;
		let deltaId: string | undefined;
		let discardedDelta = false;
		const syncFacts = () =>
			fixture.setFacts([
				...[...nativeText].map(([id, text]) => ({ id, text })),
				...(deltaId && !discardedDelta
					? [
							{
								id: "cancelled-delta",
								text: "purple kayak",
								document_id: deltaId,
							},
						]
					: []),
				...(chessId
					? [{ id: "chess", text: "I play chess.", document_id: chessId }]
					: []),
			]);
		fixture.fetcher.mockImplementation(async (url, init) => {
			const pathname = String(url);
			if (init?.method === "POST" && pathname.endsWith("/memories")) {
				if (!chessId)
					deltaId = JSON.parse(String(init.body)).items[0].document_id;
				syncFacts();
			}
			if (
				deltaId &&
				init?.method === "DELETE" &&
				pathname.endsWith(`/documents/${deltaId}`)
			) {
				discardedDelta = true;
				syncFacts();
			}
			const response = await transport(url, init);
			if (init?.method === "PATCH" && pathname.endsWith("/kayak")) {
				const body = JSON.parse(String(init.body));
				nativeText.set("kayak", body.text);
				if (body.text === "purple kayak" && !setOff) {
					setOff = true;
					await setMemoryEnabled(h.userId, false);
				}
				if (body.text === "green kayak" && loseResponse && !lost) {
					lost = true;
					return new Response("restore applied, response lost", {
						status: 503,
					});
				}
			}
			return response;
		});
		const op = await actions.submitMemoryAction(h.userId, {
			kind: "edit",
			ref: ckRef,
			text: "purple kayak",
			requestId: randomUUID(),
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.s.users).get()?.memoryEnabled).toBe(false);
		expect(nativeText.get("kayak")).toBe("purple kayak");
		expect(fixture.model).toHaveBeenCalledTimes(3);
		// Rollback VERIFICATION is read-only and receives the original accepted wording.
		fixture.model.mockImplementation(async (_prompt, input) => {
			const restored =
				input.proposed_facts.some(
					({ text }: { text: string }) => text === "green kayak",
				) &&
				input.displayed_observations.some(
					({ text }: { text: string }) => text === "green kayak",
				);
			return restored ? ckOkay : ckReject;
		});
		await setMemoryEnabled(h.userId, true);
		await h.engine.drain(jobs.memoryDeliveryJob);
		if (loseResponse) {
			expect(lost).toBe(true);
			expect(nativeText.get("kayak")).toBe("green kayak");
			f.db
				.update(f.s.memoryDeliveryJobs)
				.set({ runAfter: new Date(0) })
				.where(eq(f.s.memoryDeliveryJobs.actionId, op.id))
				.run();
			await h.engine.drain(jobs.memoryDeliveryJob);
		}
		expect(actions.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
			status: "failed",
			errorCode: "memory_edit_cancelled",
			cleanupPending: false,
		});
		expect(nativeText.get("kayak")).toBe("green kayak");
		expect(fixture.patches.filter((id) => id === "kayak")).toHaveLength(2);
		expect(deltaId).toBeDefined();
		expect(discardedDelta).toBe(true);
		const { verifiedMemoryHistory } = await import("./native-read");
		expect(
			verifiedMemoryHistory(h.userId, f.bank.id, 0, "observation-kayak"),
		).toEqual([]);
		const chess = recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "rollback-chess",
			lineageId: "rollback-chess",
			text: "I play chess.",
			context: "",
			assertedAt: new Date(),
		});
		chessId = chess.id;
		const delivery = await jobs.enqueueMemoryDelivery({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			kind: "source",
			sourceId: chess.id,
			requestId: "rollback-chess",
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		expect(
			f.db
				.select()
				.from(f.s.memoryDeliveryJobs)
				.where(eq(f.s.memoryDeliveryJobs.id, delivery.row.id))
				.get()?.status,
		).toBe("succeeded");
		expect(
			readPublishedMemory(h.userId, f.bank.id)
				.map(({ text }) => text)
				.sort(),
		).toEqual(["I play chess.", "green kayak", "sister bicycle"]);
	},
);

it.each([
	"readback mismatch",
	"retry exhaustion",
	"older exhausted job",
	"restore interruption",
	"ambiguous native failure",
	"archive provenance mismatch",
	"archive revoked before dispatch",
])(
	"a dirty Edit reaches a safe outcome after a failure (%s)",
	async (scenario) => {
		const f = await setup();
		const fixture = await nativeFixture(f, []);
		const wrongArchive = scenario === "archive provenance mismatch";
		const revokedArchive = scenario === "archive revoked before dispatch";
		const readbackMismatch =
			wrongArchive || revokedArchive || scenario === "readback mismatch";
		if (revokedArchive) {
			const { HindsightClient } = await import("./hindsight-client");
			const editFact = HindsightClient.prototype.editFact;
			vi.spyOn(HindsightClient.prototype, "editFact").mockImplementation(
				function (this: InstanceType<typeof HindsightClient>, ...args) {
					if (args[1].state === "valid")
						f.db
							.insert(f.s.memoryRevocations)
							.values({
								id: randomUUID(),
								userId: h.userId,
								bankId: f.bank.id,
								epoch: 0,
								nativeFactId: "kayak",
							})
							.run();
					return editFact.apply(this, args);
				},
			);
		}
		let rejectRestoration = scenario === "restore interruption";
		fixture.model
			.mockResolvedValueOnce(ckPlan)
			.mockResolvedValueOnce(ckProposal("kayak", "", "sister"))
			.mockResolvedValueOnce(ckOkay)
			.mockImplementation(async (_prompt, input) =>
				input.displayed_observations &&
				(input.user_saved_after === "purple kayak" || rejectRestoration)
					? ckReject
					: ckOkay,
			);
		let deltaId: string | undefined;
		let invalidated = false;
		let deltaDeleted = false;
		let addId: string | undefined;
		const original = fixture.fetcher.getMockImplementation();
		if (!original) throw Error("missing native fixture");
		fixture.fetcher.mockImplementation(async (url, init) => {
			const path = String(url);
			if (path.endsWith("/memories") && init?.method === "POST") {
				const item = JSON.parse(String(init.body)).items[0];
				if (item.content === "I play chess.") addId = item.document_id;
				else deltaId = item.document_id;
			}
			if (path.endsWith("/memories/kayak") && init?.method === "PATCH") {
				const patch = JSON.parse(String(init.body));
				if (invalidated && patch.text !== undefined)
					return new Response("Cannot edit an invalidated memory", {
						status: 400,
					});
				invalidated = patch.state === "invalidated";
				if (patch.state === "valid") {
					fixture.setFacts([
						{ id: "kayak", text: "green kayak" },
						{ id: "sister", text: "sister bicycle" },
					]);
					fixture.patches.push("kayak");
					return new Response("{}");
				}
			}
			if (path.endsWith("/memories/kayak") && init?.method === "GET")
				return new Response(
					JSON.stringify({
						id: "kayak",
						text: "green kayak",
						type: "world",
						state: "invalidated",
						document_id: wrongArchive ? "different-source" : f.source.id,
					}),
				);
			if (
				scenario === "ambiguous native failure" &&
				invalidated &&
				path.endsWith("/consolidate")
			)
				return new Response("consolidation response lost", { status: 503 });
			if (
				deltaId &&
				path.endsWith(`/documents/${deltaId}`) &&
				init?.method === "DELETE"
			)
				deltaDeleted = true;
			const response = await original(url, init);
			if (!path.includes("/memories/list")) return response;
			const body = await response.json();
			const appendFact = (
				id: string,
				text: string,
				document_id: string,
				observe = false,
			) => {
				body.items.push({
					id,
					text,
					document_id,
					fact_type: "world",
					consolidated_at: "2026-11-01",
				});
				if (observe)
					body.items.push({
						id: `observation-${id}`,
						text,
						fact_type: "observation",
						source_memory_ids: [id],
					});
			};
			if (deltaId && !deltaDeleted)
				appendFact("purple", "purple kayak", deltaId);
			if (deltaId && invalidated && !deltaDeleted && readbackMismatch)
				appendFact("drift", "duplicate native raw fact", deltaId);
			if (addId) appendFact("chess", "I play chess.", addId, true);
			body.total = body.items.length;
			return new Response(JSON.stringify(body));
		});
		const a = await import("./curation-actions");
		const jobs = await import("./delivery-job");
		const list = await import("./native-read");
		const texts = () =>
			list
				.listMemory(h.userId, { scope: { kind: "personal" } })
				.rows.map(({ text }) => text)
				.sort();
		const request = {
			kind: "edit" as const,
			ref: ckRef,
			text: "purple kayak",
			requestId: randomUUID(),
		};
		const op = await a.submitMemoryAction(h.userId, request);
		const deliveries = f.s.memoryDeliveryJobs;
		const { eq } = await import("drizzle-orm");
		const editJob = eq(deliveries.actionId, op.id);
		const drain = () => h.engine.drain(jobs.memoryDeliveryJob);
		const operation = () => a.getMemoryOperation(h.userId, { id: op.id });
		const advanceRetry = () =>
			f.db
				.update(deliveries)
				.set({ runAfter: new Date(0) })
				.where(editJob)
				.run();
		await drain();
		if (wrongArchive || revokedArchive) {
			expect(operation()).toMatchObject({
				status: "queued",
				errorCode: wrongArchive
					? "memory_edit_restore_unavailable"
					: "memory_edit_restore_source_changed",
				cleanupPending: true,
			});
			expect(fixture.patches).toEqual(["kayak"]);
			expect(deltaDeleted).toBe(false);
			expect(texts()).toEqual(wrongArchive ? ["kayak", "sister"] : ["sister"]);
			return;
		}
		if (!readbackMismatch) {
			for (const attemptCount of [1, 2]) {
				expect(
					f.db.select().from(deliveries).where(editJob).get(),
				).toMatchObject({
					attemptCount,
					status: "queued",
				});
				expect(operation()).toMatchObject({ cleanupPending: true });
				expect(deltaDeleted).toBe(false);
				expect(texts()).toEqual(["kayak", "sister"]);
				if (attemptCount === 1) {
					advanceRetry();
					await drain();
				}
			}
			if (scenario === "older exhausted job") {
				// Model a pre-fix receipt whose last attempt ended with the proposal still staged.
				const job = f.db.select().from(deliveries).where(editJob).get();
				const attempts = f.s.memoryDeliveryAttempts;
				const previous = f.db
					.select()
					.from(attempts)
					.where(eq(attempts.jobId, job?.id ?? ""))
					.all()
					.find((attempt) => attempt.attemptNumber === 2);
				if (!previous) throw Error("expected second attempt");
				f.db
					.insert(attempts)
					.values({
						...previous,
						id: randomUUID(),
						attemptNumber: 3,
					})
					.run();
				f.db
					.update(deliveries)
					.set({
						status: "failed",
						attemptCount: 3,
						retryable: true,
						errorCode: "memory_dependency_check_rejected",
					})
					.where(editJob)
					.run();
				expect((await a.submitMemoryAction(h.userId, request)).id).toBe(op.id);
			} else advanceRetry();
			await drain();
			if (scenario === "ambiguous native failure") {
				expect(operation()).toMatchObject({
					status: "failed",
					errorCode: "native_unavailable",
					cleanupPending: true,
					retryable: true,
				});
				expect((await a.submitMemoryAction(h.userId, request)).id).toBe(op.id);
				await drain();
				expect(deltaDeleted).toBe(false);
				expect(fixture.patches).toEqual(["kayak"]);
				expect(texts()).toEqual(["kayak", "sister"]);
				return;
			}
			if (scenario === "restore interruption") {
				expect(operation()).toMatchObject({
					status: "failed",
					errorCode: "memory_dependency_check_rejected",
					cleanupPending: true,
				});
				expect(deltaDeleted).toBe(true);
				rejectRestoration = false;
				expect((await a.submitMemoryAction(h.userId, request)).id).toBe(op.id);
				await drain();
			}
		}
		expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
			status: "failed",
			errorCode: readbackMismatch
				? "memory_edit_readback_mismatch"
				: "memory_dependency_check_rejected",
			cleanupPending: false,
		});
		if (scenario === "older exhausted job")
			expect(
				fixture.model.mock.calls.filter(
					([, input]) =>
						input.displayed_observations &&
						input.user_saved_after === "purple kayak",
				),
			).toHaveLength(2);
		expect(fixture.patches).toEqual(["kayak", "kayak"]);
		expect(deltaDeleted).toBe(true);
		expect(
			f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(eq(f.s.memorySourceRevisions.id, deltaId ?? ""))
				.get(),
		).toMatchObject({
			state: "revoked",
			acknowledgedFactsJson: "[]",
		});
		expect(texts()).toEqual(["green kayak", "sister bicycle"]);
		const add = await a.submitMemoryAction(h.userId, {
			kind: "add",
			scope: { kind: "personal" },
			text: "I play chess.",
			requestId: randomUUID(),
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		expect(a.getMemoryOperation(h.userId, { id: add.id })?.status).toBe(
			"applied",
		);
		expect(texts()).toEqual(["I play chess.", "green kayak", "sister bicycle"]);
	},
);

it("removes both name paraphrases while preserving another observation sharing their raw fact", async () => {
	const f = await setup();
	const { eq } = await import("drizzle-orm");
	const name = "A felhasználó macskájának neve Szederliget.";
	const paraphrase = "Szederliget a felhasználó macskájának a neve.";
	const coat = "A felhasználó macskájának bundája fehér.";
	const fact = {
		id: "cat",
		text: "A felhasználó macskájának neve Szederliget, és fehér a bundája.",
	};
	const fingerprint = JSON.stringify([fact]);
	const independent = { id: "chess", text: "A felhasználó sakkozik." };
	const { recordMemorySource } = await import("./revisions");
	const otherSource = recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "chess",
		lineageId: "chess",
		text: independent.text,
		context: "",
		assertedAt: new Date(),
	});
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			state: "accepted",
			acknowledgedFactsJson: JSON.stringify([independent]),
		})
		.where(eq(f.s.memorySourceRevisions.id, otherSource.id))
		.run();
	f.db
		.update(f.s.memorySourceRevisions)
		.set({ acknowledgedFactsJson: fingerprint })
		.where(eq(f.s.memorySourceRevisions.id, f.source.id))
		.run();
	f.db
		.delete(f.s.memoryPublishedRows)
		.where(eq(f.s.memoryPublishedRows.bankId, f.bank.id))
		.run();
	for (const [id, text, facts] of [
		["name", name, [fact]],
		["paraphrase", paraphrase, [fact]],
		["coat", coat, [fact]],
		["mixed", `${name} ${independent.text}`, [fact, independent]],
		["observation-chess", independent.text, [independent]],
	] as const) {
		f.db
			.insert(f.s.memoryPublishedRows)
			.values({
				id,
				nativeId: id,
				bankId: f.bank.id,
				generation: "g",
				epoch: 0,
				text,
				nativeText: text,
				sourceIdsJson: JSON.stringify(facts.map(({ id }) => id)),
				sourceFingerprintsJson: JSON.stringify(facts),
				updatedAt: new Date(),
			})
			.run();
	}
	const siblings = [
		{ id: "coat", text: coat, sourceFactIds: ["cat"] },
		{ id: "paraphrase", text: paraphrase, sourceFactIds: ["cat"] },
	];
	const fixture = await nativeFixture(f, []);
	fixture.setFacts([fact, { ...independent, document_id: otherSource.id }]);
	fixture.model.mockImplementation(async (prompt, input) => {
		if (input.displayed_observations) {
			expect(input.displayed_observations).toEqual([
				{ id: "observation-cat", text: coat, sourceFactIds: ["cat"] },
			]);
			return ckOkay;
		}
		expect(input.shared_support_observations).toEqual(siblings);
		expect(prompt).toContain("A sibling may paraphrase the selected detail");
		if (input.facts) return { facts: [{ id: "cat", text: coat }] };
		if (input.proposed_facts) {
			expect(input.proposed_facts).toEqual([{ id: "cat", text: coat }]);
			return ckOkay;
		}
		return {
			forget: ["cat's name"],
			replace: [],
			preserve: ["cat's white coat"],
		};
	});
	const actions = await import("./curation-actions");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const op = await actions.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: { ...ckRef, rowId: "name" },
		requestId: randomUUID(),
	});
	await h.engine.drain(memoryDeliveryJob);
	expect(actions.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "applied",
		cleanupPending: false,
		exclusionAcknowledged: true,
	});
	expect(fixture.patches).toEqual(["cat"]);
	expect(
		(await import("./native-read"))
			.listMemory(h.userId, { scope: ckRef.scope })
			.rows.map(({ text }) => text)
			.sort(),
	).toEqual([coat, independent.text].sort());
});

it("lifecycle re-review: a Remove checks new stale observations backed by other accepted sources", async () => {
	const f = await setup();
	const rev = await import("./revisions");
	const independent = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "other",
		lineageId: "other",
		text: "I play chess.",
		context: "",
		assertedAt: new Date(),
	});
	const { eq } = await import("drizzle-orm");
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			state: "accepted",
			acknowledgedFactsJson: JSON.stringify([
				{ id: "chess", text: "I play chess." },
			]),
		})
		.where(eq(f.s.memorySourceRevisions.id, independent.id))
		.run();
	f.db
		.insert(f.s.memoryPublishedRows)
		.values({
			id: "old-chess",
			nativeId: "old-chess",
			bankId: f.bank.id,
			generation: "g",
			epoch: 0,
			text: "I play chess.",
			nativeText: "I play chess.",
			sourceIdsJson: '["chess"]',
			sourceFingerprintsJson: '[{"id":"chess","text":"I play chess."}]',
			updatedAt: new Date(),
		})
		.run();
	const fixture = await nativeFixture(f, []);
	fixture.setFacts([
		{ id: "kayak", text: "green kayak" },
		{ id: "sister", text: "sister bicycle" },
		{ id: "chess", text: "I play chess.", document_id: independent.id },
	]);
	fixture.model
		.mockResolvedValueOnce({
			forget: ["green kayak"],
			replace: [],
			preserve: ["sister bicycle"],
		})
		.mockResolvedValueOnce(ckProposal("kayak", "", "sister"))
		.mockResolvedValueOnce(ckOkay)
		.mockImplementation(async (_prompt, input) =>
			input.displayed_observations.some(({ text }: { text: string }) =>
				text.includes("green kayak"),
			)
				? ckReject
				: ckOkay,
		);
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("missing native fixture");
	fixture.fetcher.mockImplementation(async (url, init) => {
		const response = await original(url, init);
		if (!String(url).includes("/memories/list")) return response;
		const body = await response.json();
		if (!body.items.some(({ id }: { id: string }) => id === "kayak"))
			body.items.push({
				id: "new-misassociated",
				text: "green kayak and I play chess.",
				fact_type: "observation",
				source_memory_ids: ["chess"],
			});
		body.total = body.items.length;
		return new Response(JSON.stringify(body));
	});
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(fixture.patches).toEqual(["kayak"]);
	expect(fixture.model.mock.calls.at(-1)?.[1]).toMatchObject({
		displayed_observations: expect.arrayContaining([
			{
				id: "new-misassociated",
				text: "green kayak and I play chess.",
				sourceFactIds: ["chess"],
			},
		]),
	});
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "queued",
		exclusionAcknowledged: true,
		cleanupPending: true,
	});
	expect(
		(await import("./native-read"))
			.listMemory(h.userId, { scope: { kind: "personal" } })
			.rows.map(({ text }) => text),
	).not.toContain("green kayak and I play chess.");
});

it("lifecycle re-review: deleting a cancelled Edit root lets rollback verify the remaining bank", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		ckPlan,
		ckProposal("kayak", "", "sister"),
		ckOkay,
	]);
	const { eq } = await import("drizzle-orm");
	const chatId = randomUUID();
	const messageId = randomUUID();
	f.db
		.insert(f.s.conversations)
		.values({ id: chatId, userId: h.userId, title: "Synthetic chat" })
		.run();
	f.db
		.insert(f.s.messages)
		.values({
			id: messageId,
			conversationId: chatId,
			role: "user",
			content: f.source.text,
		})
		.run();
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			conversationId: chatId,
			messageId,
			nativeSubmitted: true,
			nativeAcknowledged: true,
		})
		.where(eq(f.s.memorySourceRevisions.id, f.source.id))
		.run();
	const policy = await import("./migration-policy");
	let disabled = false;
	const original = fixture.fetcher.getMockImplementation();
	if (!original) throw Error("missing native fixture");
	fixture.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.endsWith("/memories") && init?.method === "POST") {
			const item = JSON.parse(String(init.body)).items[0];
			if (item.content === "I play chess.")
				fixture.setFacts([
					{
						id: "new-chess",
						text: "I play chess.",
						document_id: item.document_id,
					},
				]);
		}
		const response = await original(url, init);
		if (
			path.endsWith("/memories/kayak") &&
			init?.method === "PATCH" &&
			!disabled
		) {
			disabled = true;
			await policy.setMemoryEnabled(h.userId, false);
		}
		if (path.endsWith(`/documents/${f.source.id}`) && init?.method === "DELETE")
			fixture.setFacts([]);
		return response;
	});
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "edit",
		ref: ckRef,
		text: "purple kayak",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(disabled).toBe(true);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "failed",
		cleanupPending: true,
	});
	await (await import("./chat-delivery")).revokeDeletedMemoryMessages([
		messageId,
	]);
	f.db.delete(f.s.messages).where(eq(f.s.messages.id, messageId)).run();
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(
				eq(f.s.memoryDeliveryJobs.requestId, `source-cleanup:${f.source.id}`),
			)
			.get()?.status,
	).toBe("succeeded");
	await policy.setMemoryEnabled(h.userId, true);
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "failed",
		cleanupPending: false,
		errorCode: "memory_edit_cancelled",
	});
	const addition = await a.submitMemoryAction(h.userId, {
		kind: "add",
		scope: { kind: "personal" },
		text: "I play chess.",
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(a.getMemoryOperation(h.userId, { id: addition.id }).status).toBe(
		"applied",
	);
	expect(
		(await import("./native-read"))
			.listMemory(h.userId, { scope: { kind: "personal" } })
			.rows.map(({ text }) => text),
	).toEqual(["I play chess."]);
	expect(fixture.model).toHaveBeenCalledTimes(3);
});

it.each([
	{
		name: "unrelated chess append",
		acceptedText: "I play chess.",
		missing: false,
	},
	{
		name: "newer deliberate reassertion",
		acceptedText: "I bought a new green kayak today.",
		missing: false,
	},
	{
		name: "missing independent fact",
		acceptedText: "I play chess.",
		missing: true,
	},
])(
	"lifecycle re-review: unchanged resend retains accepted lineage ($name)",
	async ({ acceptedText, missing }) => {
		const f = await setup();
		const rev = await import("./revisions");
		const fixture = await nativeFixture(f, []);
		const { eq } = await import("drizzle-orm");
		f.db
			.update(f.s.memorySourceRevisions)
			.set({ nativeSubmitted: true, nativeAcknowledged: true })
			.where(eq(f.s.memorySourceRevisions.id, f.source.id))
			.run();
		const before = f.source.text;
		const after =
			acceptedText === "I play chess."
				? `${before}. ${acceptedText}`
				: `${acceptedText} My sister still owns her bicycle.`;
		const removePlan = {
			forget: ["green kayak"],
			replace: [],
			preserve: ["sister bicycle"],
		};
		const unchangedFacts = [
			{ id: "sister", text: "sister bicycle", document_id: f.source.id },
		];
		const payloads: Array<Record<string, unknown>> = [];
		fixture.model.mockImplementation(
			async (_prompt, input: Record<string, unknown>) => {
				payloads.push(input);
				if ("facts" in input) {
					const plan = input.edit_plan as typeof removePlan;
					const facts = input.facts as Array<{ id: string; text: string }>;
					return {
						facts: facts.map(({ id, text }) => ({
							id,
							text:
								plan.forget.includes("green kayak") && text === "green kayak"
									? ""
									: text,
						})),
					};
				}
				if ("proposed_facts" in input) {
					const hasRemove = JSON.stringify(input).includes(
						'"forget":["green kayak"]',
					);
					const display = input.displayed_observations as
						| Array<{ text: string }>
						| undefined;
					if (
						hasRemove &&
						display?.some(
							({ text }) =>
								text.includes("green kayak") && text !== acceptedText,
						)
					)
						return ckReject;
					if (
						Array.isArray(input.new_facts) &&
						input.new_facts.some(({ text }) => text === "green kayak")
					)
						return ckReject;
					return ckOkay;
				}
				return input.user_saved_after === ""
					? removePlan
					: {
							forget: [],
							replace: [],
							preserve: ["sister bicycle"],
						};
			},
		);
		const original = fixture.fetcher.getMockImplementation();
		if (!original) throw Error("missing native fixture");
		let changedId: string | undefined;
		let predecessorDeleted = false;
		const retained: string[] = [];
		fixture.fetcher.mockImplementation(async (url, init) => {
			const nativePath = String(url);
			if (nativePath.endsWith("/memories") && init?.method === "POST") {
				const item = JSON.parse(String(init.body)).items[0];
				retained.push(item.document_id);
				expect(JSON.parse(item.content).kind).toBe("source_edit");
				changedId = item.document_id;
				fixture.setFacts([
					...unchangedFacts,
					{ id: "chess", text: acceptedText, document_id: item.document_id },
				]);
			}
			if (
				changedId &&
				nativePath.endsWith(`/documents/${changedId}`) &&
				init?.method === "DELETE"
			)
				predecessorDeleted = true;
			return original(url, init);
		});
		const a = await import("./curation-actions");
		const jobs = await import("./delivery-job");
		const list = await import("./native-read");
		const texts = () =>
			list
				.listMemory(h.userId, { scope: { kind: "personal" } })
				.rows.map(({ text }) => text)
				.sort();
		const remove = await a.submitMemoryAction(h.userId, {
			kind: "remove",
			ref: ckRef,
			requestId: randomUUID(),
		});
		await h.engine.drain(jobs.memoryDeliveryJob);
		expect(a.getMemoryOperation(h.userId, { id: remove.id }).status).toBe(
			"applied",
		);
		const resubmit = async (
			previousId: string,
			eventId: string,
			explicitEditAt?: Date,
		) => {
			rev.revokeMemorySources(h.userId, [previousId]);
			const source = rev.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				eventId,
				lineageId: f.source.lineageId,
				predecessorSourceId: previousId,
				text: after,
				context: "",
				assertedAt: f.source.assertedAt,
				explicitEditAt,
			});
			const queued = await jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source",
				sourceId: source.id,
				requestId: eventId,
			});
			await h.engine.drain(jobs.memoryDeliveryJob);
			return {
				id: source.id,
				job: f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(eq(f.s.memoryDeliveryJobs.id, queued.row.id))
					.get(),
			};
		};
		const changed = await resubmit(
			f.source.id,
			"changed",
			new Date(f.source.assertedAt.getTime() + 120_000),
		);
		expect(changed.job?.status).toBe("succeeded");
		expect(texts()).toEqual([acceptedText, "sister bicycle"]);
		expect(
			payloads.some((p) =>
				JSON.stringify(p.ordered_edits ?? []).includes("green kayak"),
			),
		).toBe(true);
		const marker = payloads.length;
		if (missing) fixture.setFacts(unchangedFacts);
		const identical = await resubmit(changed.id, "identical");
		if (missing) {
			expect(identical.job).toMatchObject({
				status: "queued",
				errorCode: "memory_unchanged_source_fact_missing",
			});
			expect(predecessorDeleted).toBe(false);
			expect(texts()).toEqual(["sister bicycle"]);
			return;
		}
		expect(identical.job?.status).toBe("succeeded");
		expect(predecessorDeleted).toBe(false);
		expect(retained).toEqual([changed.id]);
		expect(payloads).toHaveLength(marker);
		expect(texts()).toEqual([acceptedText, "sister bicycle"]);
		const { readPublishedMemory } = await import("./publication");
		expect(
			readPublishedMemory(h.userId, f.bank.id).find(
				(r) => r.text === acceptedText,
			)?.updatedAt,
		).toEqual(new Date(f.source.assertedAt.getTime() + 120_000));
	},
);

it.each([
	"unsubmitted",
	"accepted carried",
	"repeated exact resend while queued",
	"accepted carried next edit",
	"changed carry checks a surviving dependent",
	"removed carried fact with a dependent reply",
	"remove after dependent exact resend",
	"remove after dependent exact resend in a moved project",
	"remove after separately deleting the dependent exact tip",
	"remove after deleting the dependent exact tip in a moved project",
	"dependent exact tip withdrawn during Remove",
	"removed correction saved before exact carry",
	"removed correction added after exact carry",
	"changed carry supplies original context",
	"extra observation on exact resend",
	"changed native date on exact resend",
	"re-rendered observation on exact resend",
	"deleted queued successor",
	"deferred cleanup before successor",
	"deferred cleanup with queued successor",
	"accepted carried correction",
	"carried correction followed by an unrelated append",
	"carried correction followed by a genuinely new assertion",
	"correction after alias",
	"competing resends",
	"ordinary withdrawal before resend",
	"accepted-empty",
	"wrong-generation",
	"ambiguous-submitted",
] as const)(
	"identical resend treats predecessor admission truthfully (%s)",
	async (mode) => {
		const f = await setup();
		const movedProject =
			mode === "remove after dependent exact resend in a moved project" ||
			mode ===
				"remove after deleting the dependent exact tip in a moved project";
		const projects = movedProject ? await import("../projects") : undefined;
		const originProject = await projects?.createProject(
			h.userId,
			"Original project",
		);
		const destinationProject = await projects?.createProject(
			h.userId,
			"Destination project",
		);
		const scope = originProject
			? ({ kind: "project", projectId: originProject.id } as const)
			: ({ kind: "personal" } as const);
		f.db.delete(f.s.memoryPublishedRows).run();
		f.db.delete(f.s.memorySourceRevisions).run();
		f.db
			.update(f.s.memoryBanks)
			.set({
				generation: null,
				scopeKey: originProject ? `project:${originProject.id}` : "personal",
			})
			.run();
		const fixture = await nativeFixture(f, []);
		fixture.setFacts([]);
		const original = fixture.fetcher.getMockImplementation();
		if (!original) throw Error("missing native fixture");
		const drink = "I prefer decaf in the afternoon.";
		const tea = "I prefer black tea in the afternoon.";
		const independent = "My bike tyres are tubeless.";
		const newAssertion =
			mode === "carried correction followed by a genuinely new assertion";
		const appendAfterCorrection =
			newAssertion ||
			mode === "carried correction followed by an unrelated append";
		const freshFact = newAssertion
			? "I now prefer green tea in the afternoon."
			: "I bake rye bread on Sundays.";
		const thirdText = newAssertion ? freshFact : `${drink} ${freshFact}`;
		const removeLateCorrection =
			mode === "removed correction added after exact carry";
		const removeEarlyCorrection =
			mode === "removed correction saved before exact carry";
		const removeCorrection = removeEarlyCorrection || removeLateCorrection;
		const removeCarried =
			mode === "removed carried fact with a dependent reply" ||
			mode === "remove after dependent exact resend" ||
			mode === "remove after separately deleting the dependent exact tip" ||
			mode === "dependent exact tip withdrawn during Remove" ||
			movedProject;
		const removeTarget = removeCorrection ? tea : drink;
		const hasIndependentFact =
			mode === "accepted carried next edit" ||
			mode === "changed carry checks a surviving dependent" ||
			mode === "changed carry supplies original context" ||
			removeCarried;
		const assertion = hasIndependentFact ? `${drink} ${independent}` : drink;
		const corrected = hasIndependentFact ? `${tea} ${independent}` : tea;
		const appendFact = "I collect maps.";
		const appended = `${corrected} ${appendFact}`;
		const reply = "Yes, I do. I also sort stamps.";
		let retains: Array<{
			content: string;
			context: string;
			timestamp: string;
			document_id: string;
		}> = [];
		let initialEmpty = mode === "accepted-empty" || mode === "wrong-generation";
		let driftAfterWithdrawal = false;
		const derived = removeCorrection
			? "Afternoon serving preference is black tea."
			: "Afternoon serving preference is decaf.";
		const carried =
			mode === "repeated exact resend while queued" ||
			mode === "accepted carried" ||
			mode === "accepted carried next edit" ||
			mode === "changed carry checks a surviving dependent" ||
			mode === "changed carry supplies original context" ||
			mode === "extra observation on exact resend" ||
			mode === "changed native date on exact resend" ||
			mode === "re-rendered observation on exact resend" ||
			mode === "deleted queued successor" ||
			mode === "deferred cleanup before successor" ||
			mode === "deferred cleanup with queued successor" ||
			removeCarried ||
			removeCorrection ||
			mode === "accepted carried correction" ||
			appendAfterCorrection ||
			mode === "correction after alias" ||
			mode === "competing resends" ||
			mode === "ordinary withdrawal before resend";
		let nativeFacts: Array<{ id: string; text: string; document_id: string }> =
			[];
		const nativeDeletes: string[] = [];
		fixture.fetcher.mockImplementation(async (url, init) => {
			const path = String(url);
			if (path.endsWith("/memories") && init?.method === "POST") {
				const item = JSON.parse(String(init.body)).items[0];
				retains.push(item);
				if (item.content === assertion)
					nativeFacts = initialEmpty
						? []
						: [
								{ id: "decaf", text: drink, document_id: item.document_id },
								...(hasIndependentFact
									? [
											{
												id: "tyres",
												text: independent,
												document_id: item.document_id,
											},
										]
									: []),
							];
				else if (item.content === reply) {
					if (
						(removeCarried || removeCorrection) &&
						item.context.includes(removeTarget)
					)
						nativeFacts.push({
							id: "derived-decaf",
							text: derived,
							document_id: item.document_id,
						});
					nativeFacts.push({
						id: "stamps",
						text: "I sort stamps.",
						document_id: item.document_id,
					});
				} else {
					const frame = JSON.parse(item.content);
					if (
						mode === "changed carry supplies original context" &&
						frame.after === appended
					) {
						expect(frame).toMatchObject({
							kind: "source_edit",
							before: corrected,
							after: appended,
						});
						nativeFacts.push({
							id: "maps",
							text: appendFact,
							document_id: item.document_id,
						});
					} else {
						expect(frame).toMatchObject({
							kind: "source_edit",
							before: assertion,
							after:
								appendAfterCorrection && frame.after !== corrected
									? thirdText
									: corrected,
						});
						nativeFacts.push(
							frame.after === corrected
								? { id: "tea", text: tea, document_id: item.document_id }
								: {
										id: "new-assertion",
										text: freshFact,
										document_id: item.document_id,
									},
						);
					}
				}
				fixture.setFacts(nativeFacts);
			}
			if (path.includes("/documents/") && init?.method === "DELETE") {
				const id = decodeURIComponent(path.split("/documents/")[1]);
				nativeDeletes.push(id);
				nativeFacts = nativeFacts.filter((fact) => fact.document_id !== id);
				fixture.setFacts(nativeFacts);
			}
			if (path.includes("/memories/") && init?.method === "PATCH") {
				const id = path.split("/").at(-1);
				const patch = JSON.parse(String(init.body));
				nativeFacts =
					patch.state === "invalidated"
						? nativeFacts.filter((fact) => fact.id !== id)
						: nativeFacts.map((fact) =>
								fact.id === id ? { ...fact, text: patch.text } : fact,
							);
			}
			const response = await original(url, init);
			if (driftAfterWithdrawal && path.includes("/memories/list")) {
				const list = await response.json();
				if (mode === "extra observation on exact resend")
					list.items.push({
						id: "unverified-extra",
						text: "The user dislikes decaf.",
						fact_type: "observation",
						source_memory_ids: ["decaf"],
					});
				else if (mode === "re-rendered observation on exact resend") {
					// Hindsight rebuilt the observation after an unrelated cleanup:
					// a new id and new wording over exactly the same fact.
					const rendered = list.items.find(
						(item: { id: string }) => item.id === "observation-decaf",
					);
					rendered.id = "observation-decaf-rebuilt";
					rendered.text = "I prefer decaf in the afternoon, it says.";
				} else
					list.items.find(
						(item: { id: string }) => item.id === "decaf",
					).mentioned_at = "2026-11-18T00:00:00.000Z";
				list.total = list.items.length;
				return new Response(JSON.stringify(list));
			}
			if (
				!newAssertion ||
				!path.includes("/memories/list") ||
				!nativeFacts.some((fact) => fact.id === "new-assertion")
			)
				return response;
			const list = await response.json();
			list.items = list.items.filter(
				(item: { id: string }) => item.id !== "observation-tea",
			);
			list.items
				.find((item: { id: string }) => item.id === "observation-new-assertion")
				.source_memory_ids.push("tea");
			list.total = list.items.length;
			return new Response(JSON.stringify(list));
		});
		const { eq, inArray } = await import("drizzle-orm");
		const chat = await import("./chat-delivery");
		const job = await import("./delivery-job");
		const chatId = randomUUID();
		f.db
			.insert(f.s.memoryControlIntervals)
			.values({
				id: randomUUID(),
				userId: h.userId,
				epoch: 0,
				enabled: true,
				startedAt: new Date(Date.now() - 60_000),
			})
			.run();
		f.db
			.insert(f.s.conversations)
			.values({
				id: chatId,
				title: "Synthetic chat",
				userId: h.userId,
				projectId: originProject?.id,
			})
			.run();
		let sequence = 0;
		const persist = async (
			prefix: string,
			previous?: string,
			text = assertion,
		) => {
			const memoryAcceptance = chat.captureMemoryTurnAcceptance(
				h.userId,
				chatId,
			);
			const createdAt = new Date(Date.now() + (previous ? 20000 : 0));
			f.db
				.insert(f.s.messages)
				.values([
					{
						id: prefix,
						conversationId: chatId,
						role: "user",
						content: text,
						messageSequence: ++sequence,
						createdAt,
					},
					{
						id: `${prefix}-assistant`,
						conversationId: chatId,
						role: "assistant",
						content: "Understood.",
						messageSequence: ++sequence,
						createdAt,
					},
				])
				.run();
			await chat.deliverCompletedMemoryTurn({
				memoryAcceptance,
				userId: h.userId,
				conversationId: chatId,
				userMessageId: prefix,
				assistantMessageId: `${prefix}-assistant`,
				...(previous
					? { turnOrigin: "edit_resend", editSourceMessageId: previous }
					: {}),
			});
			const source = f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(eq(f.s.memorySourceRevisions.messageId, prefix))
				.get();
			if (!source) throw Error("missing recorded source");
			return source;
		};
		const previous = await persist("before");
		expect(previous).toMatchObject({
			state: "pending",
			nativeSubmitted: false,
			acknowledgedFactsJson: "[]",
		});
		if (initialEmpty || carried) {
			await h.engine.drain(job.memoryDeliveryJob);
			const { publishNativeSnapshot } = await import("./publication");
			for (let i = 0; initialEmpty && i < 2; i++) {
				f.db.transaction((tx) => {
					const bank = tx.select().from(f.s.memoryBanks).get();
					if (!bank) throw Error("missing bank");
					publishNativeSnapshot(tx, {
						userId: h.userId,
						bankId: bank.id,
						epoch: bank.epoch,
						expectedRevision: bank.revision,
						memories: [],
					});
				});
			}
			const accepted = f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(eq(f.s.memorySourceRevisions.id, previous.id))
				.get();
			expect(accepted).toMatchObject({
				state: "accepted",
				acceptedGeneration: f.db.select().from(f.s.memoryBanks).get()
					?.generation,
			});
			// The accepted-empty receipt must outlive the job.
			f.db
				.delete(f.s.memoryDeliveryJobs)
				.where(eq(f.s.memoryDeliveryJobs.sourceId, previous.id))
				.run();
			initialEmpty = false;
			retains = [];
		}
		const saveCorrection = async () => {
			fixture.model.mockImplementation(
				async (_prompt, input: Record<string, unknown>) => {
					if ("facts" in input) return { facts: [{ id: "decaf", text: "" }] };
					if ("original_facts" in input) return ckOkay;
					return { forget: [], replace: ["decaf to black tea"], preserve: [] };
				},
			);
			const read = await import("./native-read");
			const actions = await import("./curation-actions");
			const card = read.listMemory(h.userId, { scope: { kind: "personal" } })
				.rows[0];
			const edit = await actions.submitMemoryAction(h.userId, {
				kind: "edit",
				text: corrected,
				ref: card.ref,
				requestId: randomUUID(),
			});
			await h.engine.drain(job.memoryDeliveryJob);
			expect(actions.getMemoryOperation(h.userId, { id: edit.id }).status).toBe(
				"applied",
			);
			retains = [];
		};
		if (
			mode === "accepted carried correction" ||
			appendAfterCorrection ||
			removeEarlyCorrection
		)
			await saveCorrection();
		if (mode === "ordinary withdrawal before resend")
			await chat.revokeDeletedMemoryMessages(["before"]);
		await chat.revokeDeletedMemoryMessages(["before"], {
			editSourceMessageId: "before",
		});
		f.db.delete(f.s.messages).where(eq(f.s.messages.id, "before")).run();
		if (mode === "ordinary withdrawal before resend") {
			await expect(persist("after", "before")).rejects.toThrow(
				"missing recorded source",
			);
			await h.engine.drain(job.memoryDeliveryJob);
			expect(nativeDeletes).toContain(previous.id);
			expect(retains).toEqual([]);
			return;
		}
		if (mode === "wrong-generation")
			f.db
				.update(f.s.memorySourceRevisions)
				.set({ acceptedGeneration: "unrelated-generation" })
				.where(eq(f.s.memorySourceRevisions.id, previous.id))
				.run();
		if (mode === "ambiguous-submitted")
			f.db
				.update(f.s.memorySourceRevisions)
				.set({ nativeSubmitted: true, nativeAcknowledged: true })
				.where(eq(f.s.memorySourceRevisions.id, previous.id))
				.run();
		if (
			mode === "deferred cleanup before successor" ||
			mode === "deferred cleanup with queued successor"
		)
			f.db
				.update(f.s.memoryDeliveryJobs)
				.set({ runAfter: new Date(Date.now() - 1000) })
				.where(eq(f.s.memoryDeliveryJobs.sourceId, previous.id))
				.run();
		if (mode === "deferred cleanup before successor") {
			await h.engine.drain(job.memoryDeliveryJob);
			expect(nativeDeletes).toContain(previous.id);
			await expect(persist("after", "before")).rejects.toThrow(
				"missing recorded source",
			);
			expect(retains).toEqual([]);
			return;
		}
		driftAfterWithdrawal =
			mode === "extra observation on exact resend" ||
			mode === "changed native date on exact resend" ||
			mode === "re-rendered observation on exact resend";
		const generationBeforeResend = f.db
			.select()
			.from(f.s.memoryBanks)
			.get()?.generation;
		const next = await persist("after", "before");
		if (mode === "repeated exact resend while queued") {
			const { deleteMessages } = await import("../messages");
			await deleteMessages(["after", "after-assistant"], {
				editSourceMessageId: "after",
			});
			const newest = await persist("newest", "after");
			f.db
				.update(f.s.memoryDeliveryJobs)
				.set({ runAfter: new Date(Date.now() - 1000) })
				.where(eq(f.s.memoryDeliveryJobs.sourceId, previous.id))
				.run();
			await h.engine.drain(job.memoryDeliveryJob);
			const delivery = f.db
				.select()
				.from(f.s.memoryDeliveryJobs)
				.where(eq(f.s.memoryDeliveryJobs.sourceId, newest.id))
				.get();
			expect(delivery?.status).toBe("succeeded");
			const read = await import("./native-read");
			expect(
				read
					.listMemory(h.userId, { scope: { kind: "personal" } })
					.rows.map(({ text }) => text),
			).toEqual([assertion]);
			expect(retains).toEqual([]);
			expect(nativeDeletes).not.toContain(previous.id);
			expect(nativeFacts.map((fact) => fact.document_id)).toEqual([
				previous.id,
			]);
			await expect(persist("stale-ancestor", "before")).rejects.toThrow(
				"missing recorded source",
			);
			await expect(persist("stale-intermediate", "after")).rejects.toThrow(
				"missing recorded source",
			);
			return;
		}
		if (mode === "deleted queued successor") {
			const { deleteMessages } = await import("../messages");
			await deleteMessages(["after"]);
			await h.engine.drain(job.memoryDeliveryJob);
			expect(nativeDeletes).toContain(previous.id);
			await expect(persist("stale-successor", "before")).rejects.toThrow(
				"missing recorded source",
			);
			expect(retains).toEqual([]);
			return;
		}
		const competing =
			mode === "competing resends"
				? await persist("competing", "before")
				: null;
		expect(next.predecessorSourceId).toBe(previous.id);
		const successorMessage = f.db
			.select()
			.from(f.s.messages)
			.where(eq(f.s.messages.id, "after"))
			.get();
		expect(successorMessage?.createdAt.getTime()).toBeGreaterThan(
			previous.assertedAt.getTime(),
		);
		await h.engine.drain(job.memoryDeliveryJob);
		const delivery = f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(eq(f.s.memoryDeliveryJobs.sourceId, next.id))
			.get();
		const texts = (await import("./native-read"))
			.listMemory(h.userId, {
				scope,
			})
			.rows.map(({ text }) => text);
		if (driftAfterWithdrawal) {
			// A resend that changes nothing never takes away what was published,
			// and never publishes a display nobody checked: the chat's facts are
			// admitted again under the generation the person already saw.
			expect(delivery?.status).toBe("succeeded");
			expect(texts).toEqual([drink]);
			expect(f.db.select().from(f.s.memoryBanks).get()?.generation).toBe(
				generationBeforeResend,
			);
			const receipts = f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(inArray(f.s.memorySourceRevisions.id, [previous.id, next.id]))
				.all();
			expect(receipts.map(({ state }) => state)).toEqual([
				"accepted",
				"accepted",
			]);
			expect(
				receipts.every(
					(source) => source.acceptedGeneration === generationBeforeResend,
				),
			).toBe(true);
			expect(
				receipts.find(({ id }) => id === next.id)?.acknowledgedFactsJson,
			).toBe("[]");
			expect(retains).toEqual([]);
			expect(nativeDeletes).not.toContain(previous.id);
			return;
		}
		if (mode === "deferred cleanup with queued successor") {
			expect(delivery?.status).toBe("succeeded");
			expect(nativeDeletes).not.toContain(previous.id);
			expect(texts).toEqual([drink]);
			expect(retains).toEqual([]);
			return;
		}
		if (competing) {
			const other = f.db
				.select()
				.from(f.s.memoryDeliveryJobs)
				.where(eq(f.s.memoryDeliveryJobs.sourceId, competing.id))
				.get();
			expect([delivery?.status, other?.status].sort()).toEqual([
				"failed",
				"succeeded",
			]);
			expect([delivery?.errorCode, other?.errorCode]).toContain(
				"memory_predecessor_invalid",
			);
			expect(retains).toEqual([]);
			expect(texts).toEqual([assertion]);
			await expect(persist("late", "before")).rejects.toThrow(
				"missing recorded source",
			);
			return;
		}
		if (mode === "wrong-generation" || mode === "ambiguous-submitted") {
			expect(delivery).toMatchObject({
				status: "queued",
				errorCode: "memory_unchanged_source_unverified",
			});
		} else {
			expect(delivery?.status).toBe("succeeded");
		}
		if (mode === "unsubmitted") {
			expect(retains).toHaveLength(1);
			expect(retains[0]).toMatchObject({
				content: assertion,
				timestamp: previous.assertedAt.toISOString(),
			});
			expect(retains[0].context).toContain("Understood.");
			expect(texts).toEqual([assertion]);
		} else if (carried) {
			expect(retains).toHaveLength(0);
			let remembered =
				mode === "accepted carried correction" ||
				appendAfterCorrection ||
				removeEarlyCorrection
					? corrected
					: drink;
			expect([...texts].sort()).toEqual(
				hasIndependentFact ? [remembered, independent] : [remembered],
			);
			expect(
				f.db
					.select()
					.from(f.s.memorySourceRevisions)
					.where(eq(f.s.memorySourceRevisions.id, next.id))
					.get(),
			).toMatchObject({ state: "accepted", nativeSubmitted: false });
			const read = await import("./native-read");
			const item = read.listMemory(h.userId, { scope }).rows[0];
			if (
				mode !== "accepted carried correction" &&
				!appendAfterCorrection &&
				!removeEarlyCorrection
			)
				expect(read.getMemoryDetail(h.userId, item.ref).sources).toEqual([
					expect.objectContaining({
						id: previous.id,
						available: false,
						quote: "",
					}),
				]);
			const { deleteMessages } = await import("../messages");
			if (appendAfterCorrection) {
				const correction = nativeFacts.find(({ id }) => id === "tea");
				if (!correction)
					throw Error("missing independently authored correction");
				const textBeforeEdit = correction.text;
				fixture.model.mockImplementation(
					async (_prompt, input: Record<string, unknown>) => {
						if ("facts" in input)
							return {
								facts: (input.facts as Array<{ id: string; text: string }>).map(
									({ id, text }) => ({
										id,
										text: id === "tea" ? drink : text,
									}),
								),
							};
						if ("original_facts" in input) return ckOkay;
						return { forget: [], replace: [freshFact], preserve: [drink] };
					},
				);
				await deleteMessages(["after"], { editSourceMessageId: "after" });
				const changed = await persist("edited", "after", thirdText);
				await h.engine.drain(job.memoryDeliveryJob);
				const retainedContext = retains.find(
					(item) => item.document_id === changed.id,
				)?.context;
				expect(retainedContext).toContain(
					"exclude editorial commentary, superseded values, and omitted details",
				);
				expect(retainedContext).toContain(
					"Keep causal reasons and other details that the user actually asserts",
				);
				expect(fixture.patches).not.toContain("tea");
				expect(nativeFacts.find(({ id }) => id === "tea")).toEqual({
					...correction,
					text: textBeforeEdit,
				});
				expect(
					nativeFacts.find(({ id }) => id === "new-assertion"),
				).toMatchObject({
					text: freshFact,
					document_id: changed.id,
				});
				expect(
					read
						.listMemory(h.userId, { scope })
						.rows.map(({ text }) => text)
						.sort(),
				).toEqual((newAssertion ? [freshFact] : [tea, freshFact]).sort());
				return;
			}
			if (mode === "correction after alias" || removeLateCorrection) {
				await saveCorrection();
				remembered = corrected;
			}
			if (
				mode === "accepted carried next edit" ||
				mode === "changed carry checks a surviving dependent" ||
				mode === "changed carry supplies original context"
			) {
				fixture.model.mockImplementation(
					async (_prompt, input: Record<string, unknown>) => {
						if ("facts" in input)
							return {
								facts: [
									{ id: "decaf", text: "" },
									{ id: "tyres", text: independent },
								],
							};
						if ("original_facts" in input) return ckOkay;
						return {
							forget: [],
							replace: ["decaf to black tea"],
							preserve: [],
						};
					},
				);
				const dependent =
					mode === "changed carry checks a surviving dependent"
						? await persist("dependent", undefined, reply)
						: null;
				if (dependent) await h.engine.drain(job.memoryDeliveryJob);
				await deleteMessages(
					["after", ...(dependent ? ["after-assistant"] : [])],
					{ editSourceMessageId: "after" },
				);
				const edited = await persist("edited", "after", corrected);
				await h.engine.drain(job.memoryDeliveryJob);
				expect(fixture.patches).toContain("decaf");
				expect(
					read
						.listMemory(h.userId, { scope })
						.rows.map(({ text }) => text)
						.sort(),
				).toEqual(
					dependent ? [tea, "I sort stamps.", independent] : [tea, independent],
				);
				if (dependent) {
					const verified = fixture.model.mock.calls.find(
						([, input]) => "source_assertions" in input,
					);
					expect(verified?.[0]).toContain("explicit user edit");
					expect(verified?.[0]).toContain("currently authorized priorContext");
					expect(verified?.[1].source_assertions).toEqual([
						expect.objectContaining({
							originalSourceId: dependent.id,
							assertion: reply,
							priorContext: retains.at(-1)?.context,
						}),
					]);
					expect(verified?.[3]).toBeUndefined();
				}
				const published = (await import("./publication")).readPublishedMemory(
					h.userId,
					f.bank.id,
				);
				expect(
					published.find((row) => row.text === independent)?.updatedAt,
				).toEqual(previous.assertedAt);
				expect(published.find((row) => row.text === tea)?.updatedAt).toEqual(
					edited.explicitEditAt,
				);
				if (mode === "changed carry supplies original context") {
					vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
					await persist("dependent-after-change", undefined, reply);
					await h.engine.drain(job.memoryDeliveryJob);
					expect(retains.at(-1)?.context).toContain(tea);
					expect(retains.at(-1)?.context).toContain(independent);
					fixture.model
						.mockReset()
						.mockImplementation(
							async (_prompt, input: Record<string, unknown>) => {
								if ("facts" in input) return { facts: input.facts };
								if ("original_facts" in input) return ckOkay;
								return { forget: [], replace: [appendFact], preserve: [] };
							},
						);
					await deleteMessages(["edited", "dependent-after-change"], {
						editSourceMessageId: "edited",
					});
					await persist("appended", "edited", appended);
					await h.engine.drain(job.memoryDeliveryJob);
					const proposal = fixture.model.mock.calls.find(
						([, input]) => "facts" in input,
					);
					expect(proposal?.[1].facts).toEqual(
						expect.arrayContaining([
							{ id: "tea", text: tea },
							{ id: "tyres", text: independent },
						]),
					);
					expect(
						read
							.listMemory(h.userId, { scope })
							.rows.map(({ text }) => text)
							.sort(),
					).toEqual([appendFact, tea, independent]);
				}
				return;
			}
			await persist("dependent", undefined, reply);
			await h.engine.drain(job.memoryDeliveryJob);
			expect(retains).toHaveLength(1);
			expect(retains[0].content).toBe(reply);
			expect(retains[0].context).toContain(remembered);
			expect(retains[0].context).not.toContain("carriedSourceIds");
			if (removeCarried || removeCorrection) {
				const deletedTip =
					mode === "remove after separately deleting the dependent exact tip" ||
					mode ===
						"remove after deleting the dependent exact tip in a moved project";
				const withdrawTipDuringRemove =
					mode === "dependent exact tip withdrawn during Remove";
				const dependentDocument = retains[0].document_id;
				if (
					mode === "remove after dependent exact resend" ||
					deletedTip ||
					withdrawTipDuringRemove ||
					movedProject
				) {
					await deleteMessages(["dependent", "dependent-assistant"], {
						editSourceMessageId: "dependent",
					});
					const alias = await persist("dependent-exact", "dependent", reply);
					await h.engine.drain(job.memoryDeliveryJob);
					expect(
						f.db
							.select()
							.from(f.s.memorySourceRevisions)
							.where(eq(f.s.memorySourceRevisions.id, alias.id))
							.get(),
					).toMatchObject({ state: "accepted", nativeSubmitted: false });
					expect(retains).toHaveLength(1);
					if (destinationProject) {
						const { moveConversationToProject } = await import(
							"../conversations"
						);
						expect(
							await moveConversationToProject(
								h.userId,
								chatId,
								destinationProject.id,
							),
						).toMatchObject({ projectId: destinationProject.id });
						expect(
							read.listMemory(h.userId, {
								scope: { kind: "project", projectId: destinationProject.id },
							}).rows,
						).toEqual([]);
					}
					if (deletedTip) {
						await deleteMessages([
							"dependent-exact",
							"dependent-exact-assistant",
						]);
						await h.engine.drain(job.memoryDeliveryJob);
						expect(nativeDeletes).toContain(dependentDocument);
					}
				}
				const actions = await import("./curation-actions");
				const list = () => read.listMemory(h.userId, { scope }).rows;
				const target = list().find((row) => row.text === removeTarget);
				if (!target) throw Error("missing carried Remove target");
				if (!deletedTip)
					expect(list().map((row) => row.text)).toContain(derived);
				fixture.model.mockImplementation(
					async (_prompt, input: Record<string, unknown>) => {
						if ("facts" in input)
							return {
								facts: removeCorrection
									? [{ id: "tea", text: "" }]
									: [
											{ id: "decaf", text: "" },
											{ id: "tyres", text: independent },
										],
							};
						if ("original_facts" in input) return ckOkay;
						return { forget: [removeTarget], replace: [], preserve: [] };
					},
				);
				const action = await actions.submitMemoryAction(h.userId, {
					kind: "remove",
					ref: target.ref,
					requestId: randomUUID(),
				});
				expect(action.exclusionAcknowledged).toBe(true);
				expect(list().map((row) => row.text)).not.toContain(derived);
				if (withdrawTipDuringRemove)
					await deleteMessages([
						"dependent-exact",
						"dependent-exact-assistant",
					]);
				await h.engine.drain(job.memoryDeliveryJob);
				expect(
					actions.getMemoryOperation(h.userId, { id: action.id }).status,
				).toBe("applied");
				expect(
					list()
						.map((row) => row.text)
						.sort(),
				).toEqual(
					deletedTip || withdrawTipDuringRemove
						? [independent]
						: removeCorrection
							? ["I sort stamps."]
							: ["I sort stamps.", independent],
				);
				if (destinationProject)
					expect(
						read.listMemory(h.userId, {
							scope: { kind: "project", projectId: destinationProject.id },
						}).rows,
					).toEqual([]);
				if (withdrawTipDuringRemove) {
					const checked = fixture.model.mock.calls.find(
						([, input]) => "withdrawn_source_ids" in input,
					);
					expect(checked?.[1].withdrawn_source_ids).toEqual([
						dependentDocument,
					]);
					expect(JSON.stringify(checked?.[1])).not.toContain(reply);
				}
				if (deletedTip || withdrawTipDuringRemove) {
					expect(retains).toHaveLength(1);
					return;
				}
				if (mode === "remove after dependent exact resend" || movedProject) {
					expect(nativeDeletes).toContain(dependentDocument);
					const repaired = f.db
						.select()
						.from(f.s.memorySourceRevisions)
						.where(eq(f.s.memorySourceRevisions.id, retains[1].document_id))
						.get();
					expect(repaired).toMatchObject({
						state: "accepted",
						bankId: f.bank.id,
						messageId: "dependent-exact",
					});
					const checked = fixture.model.mock.calls.find(
						([, input]) => "source_assertions" in input,
					);
					expect(checked?.[1].source_assertions).toEqual([
						{
							id: repaired?.id,
							originalSourceId: dependentDocument,
							assertion: reply,
							priorContext: retains[1].context,
							withdrawnContextSourceIds: [],
						},
					]);
					expect(checked?.[3]).toBe("on");
				}
				expect(retains).toHaveLength(2);
				expect(retains.at(-1)?.context).not.toContain(removeTarget);
				if (removeCarried)
					expect(retains.at(-1)?.context).toContain(independent);
				return;
			}
			await deleteMessages(["dependent", "after"]);
			expect(
				read.listMemory(h.userId, { scope }).rows.map(({ text }) => text),
			).toEqual(
				mode === "accepted carried correction" ||
					mode === "correction after alias"
					? [corrected]
					: [],
			);
			await h.engine.drain(job.memoryDeliveryJob);
			expect(nativeDeletes).toContain(previous.id);
			await expect(persist("stale", "after")).rejects.toThrow(
				"missing recorded source",
			);
			expect(retains).toHaveLength(1);
		} else {
			expect(retains).toHaveLength(0);
			expect(texts).toEqual([]);
		}
	},
);

it.each(["carry", "missing receipt", "changed current message"] as const)(
	"curates only verified carried facts from an edited chat (%s)",
	async (mode) => {
		const f = await setup();
		const { eq } = await import("drizzle-orm");
		const fixture = await nativeFixture(f, []);
		const chat = await import("./chat-delivery");
		const { deleteMessages } = await import("../messages");
		const { memoryDeliveryJob } = await import("./delivery-job");
		const actions = await import("./curation-actions");
		const read = await import("./native-read");
		const conversationId = randomUUID();
		const originalMessageId = randomUUID();
		const currentMessageId = randomUUID();
		const responseId = randomUUID();
		const after = `${f.source.text}. I play chess.`;
		const scope = { kind: "personal" } as const;
		f.db
			.insert(f.s.conversations)
			.values({
				id: conversationId,
				title: "Curation source",
				userId: h.userId,
			})
			.run();
		f.db
			.insert(f.s.messages)
			.values({
				id: originalMessageId,
				conversationId,
				role: "user",
				content: f.source.text,
				messageSequence: 1,
			})
			.run();
		f.db
			.update(f.s.memorySourceRevisions)
			.set({
				conversationId,
				messageId: originalMessageId,
				nativeSubmitted: true,
				nativeAcknowledged: true,
			})
			.where(eq(f.s.memorySourceRevisions.id, f.source.id))
			.run();
		await deleteMessages([originalMessageId], {
			editSourceMessageId: originalMessageId,
		});
		const acceptance = chat.captureMemoryTurnAcceptance(
			h.userId,
			conversationId,
		);
		f.db
			.insert(f.s.messages)
			.values([
				{
					id: currentMessageId,
					conversationId,
					messageSequence: 2,
					role: "user",
					content: after,
					createdAt: new Date(f.source.assertedAt.getTime() + 60000),
				},
				{
					id: responseId,
					conversationId,
					messageSequence: 3,
					role: "assistant",
					content: "Understood.",
				},
			])
			.run();
		let successorId: string | undefined;
		const retained = [
			{ id: "kayak", text: "green kayak", document_id: f.source.id },
			{ id: "sister", text: "sister bicycle", document_id: f.source.id },
		];
		const originalFetcher = fixture.fetcher.getMockImplementation();
		if (!originalFetcher) throw Error("missing native fixture");
		fixture.fetcher.mockImplementation(async (url, init) => {
			const path = String(url);
			if (path.endsWith("/memories") && init?.method === "POST") {
				const item = JSON.parse(String(init.body)).items[0];
				if (JSON.parse(item.content).kind === "source_edit") {
					successorId = item.document_id;
					retained.push({
						id: "chess",
						text: "I play chess.",
						document_id: item.document_id,
					});
					fixture.setFacts(retained);
				}
			}
			if (path.includes("/documents/") && init?.method === "DELETE") {
				const id = decodeURIComponent(path.split("/documents/")[1]);
				for (let index = retained.length - 1; index >= 0; index--)
					if (retained[index].document_id === id) retained.splice(index, 1);
				fixture.setFacts(retained);
			}
			return originalFetcher(url, init);
		});
		fixture.model.mockImplementation(
			async (_prompt, input: Record<string, unknown>) => {
				const removing = input.user_saved_after === "";
				if ("facts" in input)
					return {
						facts: (input.facts as Array<{ id: string; text: string }>).map(
							(fact) =>
								removing && fact.id === "kayak" ? { ...fact, text: "" } : fact,
						),
					};
				if ("original_facts" in input) return ckOkay;
				return removing
					? {
							forget: ["green kayak"],
							replace: [],
							preserve: ["sister bicycle"],
						}
					: {
							forget: [],
							replace: ["I play chess."],
							preserve: [f.source.text],
						};
			},
		);
		await chat.deliverCompletedMemoryTurn({
			userId: h.userId,
			conversationId,
			memoryAcceptance: acceptance,
			userMessageId: currentMessageId,
			assistantMessageId: responseId,
			turnOrigin: "edit_resend",
			editSourceMessageId: originalMessageId,
		});
		await h.engine.drain(memoryDeliveryJob);
		expect(successorId).toBeDefined();
		const carried = f.db
			.select()
			.from(f.s.memorySourceRevisions)
			.where(eq(f.s.memorySourceRevisions.id, f.source.id))
			.get();
		const current = read.listMemory(h.userId, { scope });
		const ref = {
			scope,
			rowId: "observation-kayak",
			generation: current.rows[0].ref.generation,
		};
		expect(carried).toMatchObject({
			state: "accepted",
			acceptedGeneration: ref.generation,
		});
		expect(read.getMemoryDetail(h.userId, ref).sources).toEqual([
			expect.objectContaining({ available: false, messageId: null, quote: "" }),
		]);
		if (mode === "missing receipt")
			f.db
				.delete(f.s.memoryActions)
				.where(eq(f.s.memoryActions.requestId, successorId ?? ""))
				.run();
		if (mode === "changed current message")
			f.db
				.update(f.s.messages)
				.set({ content: "A different assertion." })
				.where(eq(f.s.messages.id, currentMessageId))
				.run();
		const modelCalls = fixture.model.mock.calls.length;
		const remove = await actions.submitMemoryAction(h.userId, {
			kind: "remove",
			ref,
			requestId: randomUUID(),
		});
		await h.engine.drain(memoryDeliveryJob);
		if (mode !== "carry") {
			expect(
				actions.getMemoryOperation(h.userId, { id: remove.id }),
			).toMatchObject({
				status: "failed",
				cleanupPending: true,
			});
			expect(fixture.model).toHaveBeenCalledTimes(modelCalls);
			expect(fixture.patches).toEqual([]);
			return;
		}
		expect(
			actions.getMemoryOperation(h.userId, { id: remove.id }),
		).toMatchObject({
			status: "applied",
			cleanupPending: false,
		});
		expect(fixture.patches).toEqual(["kayak"]);
		expect(
			read
				.listMemory(h.userId, { scope })
				.rows.map(({ text }) => text)
				.sort(),
		).toEqual(["I play chess.", "sister bicycle"]);
		await deleteMessages([currentMessageId]);
		expect(read.listMemory(h.userId, { scope }).rows).toEqual([]);
		await h.engine.drain(memoryDeliveryJob);
		expect(
			f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(eq(f.s.memorySourceRevisions.id, f.source.id))
				.get()?.state,
		).toBe("revoked");
		expect(retained).toEqual([]);
	},
);

const scope = { kind: "personal" } as const;
const claim = { scope, generation: "g", rowId: "kayak" };
const yes = { valid: true, issues: [] };
const plan = { forget: ["green"], replace: ["purple"], preserve: ["bicycle"] };

it("re-review: a regenerated row with a changed date cannot alter an accepted display", async () => {
	const f = await setup();
	const pub = await import("./publication");
	const raw = [
		{
			id: "kayak",
			text: "green kayak",
			fact_type: "world",
			consolidated_at: "2026-11-18T00:00:00Z",
			document_id: f.source.id,
			mentioned_at: "2026-08-03T12:00:00Z",
		},
		{
			id: "sister",
			text: "sister bicycle",
			fact_type: "world",
			consolidated_at: "2026-11-18T00:00:00Z",
			document_id: f.source.id,
		},
	];
	const observations = [
		{
			id: "obs1",
			fact_type: "observation",
			text: "green kayak (2026-08-03 12:00: green kayak)",
			source_memory_ids: ["kayak"],
		},
		{
			id: "obs2",
			fact_type: "observation",
			text: "sister bicycle",
			source_memory_ids: ["sister"],
		},
	];
	const input = { userId: h.userId, bankId: f.bank.id, epoch: 0 };
	const generation = f.db.transaction((tx) =>
		pub.publishNativeSnapshot(tx, {
			...input,
			expectedRevision: 0,
			memories: [...raw, ...observations],
		}),
	);
	expect(
		pub
			.readPublishedMemory(h.userId, f.bank.id)
			.find((r) => r.nativeId === "obs1")?.text,
	).toBe("green kayak");
	const laterRaw = [
		{ ...raw[0], mentioned_at: "2026-08-04T12:00:00Z" },
		raw[1],
	];
	f.db.transaction((tx) =>
		pub.republishRenumberedNativeObservations(tx, {
			...input,
			expectedRevision: 1,
			generation,
			actionId: "failed-edit",
			memories: [
				...laterRaw,
				{ ...observations[0], id: "obs3" },
				observations[1],
			],
		}),
	);
	expect(pub.readPublishedMemory(h.userId, f.bank.id)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				nativeId: "obs1",
				text: "green kayak",
				generation,
			}),
		]),
	);
});

it.each([
	"unrelated",
	"unrelated attached",
	"newer assertion",
	"newer replaces native support",
	"comparison source withdrawn at dispatch",
	"comparison source withdrawn at publication",
] as const)(
	"re-review: only an actually supported newer assertion can supersede a checked edit (%s)",
	async (kind) => {
		const withdrawAtDispatch =
			kind === "comparison source withdrawn at dispatch";
		const withdrawAtPublication =
			kind === "comparison source withdrawn at publication";
		const newer =
			kind === "newer assertion" ||
			kind === "newer replaces native support" ||
			withdrawAtDispatch ||
			withdrawAtPublication;
		const extraSupport = kind !== "unrelated";
		const newAssertion = newer ? "I own a blue kayak now." : "lamp";
		const f = await setup();
		const fixture = await nativeFixture(f, [
			plan,
			{
				facts: [
					{ id: "kayak", text: "" },
					{ id: "sister", text: "sister bicycle" },
				],
			},
			yes,
			yes,
		]);
		f.db
			.insert(f.s.conversations)
			.values({ id: "paddling", userId: h.userId, title: "Paddling" })
			.run();
		f.db
			.insert(f.s.messages)
			.values({
				id: "original",
				conversationId: "paddling",
				role: "user",
				content: f.source.text,
			})
			.run();
		f.db
			.update(f.s.memorySourceRevisions)
			.set({ conversationId: "paddling", messageId: "original" })
			.run();
		const fetch = fixture.fetcher.getMockImplementation();
		if (!fetch) throw Error("fixture");
		let correctionSource: string | undefined;
		let flip = false;
		fixture.fetcher.mockImplementation(async (url, init) => {
			const path = String(url);
			if (path.endsWith("/memories") && init?.method === "POST") {
				const item = JSON.parse(String(init.body)).items[0];
				if (!correctionSource) {
					correctionSource = item.document_id;
					fixture.setFacts([
						{ id: "kayak", text: "green kayak" },
						{ id: "sister", text: "sister bicycle" },
						{
							id: "correction",
							text: "purple kayak",
							document_id: correctionSource,
						},
					]);
				} else {
					fixture.setFacts([
						{ id: "sister", text: "sister bicycle" },
						{
							id: "correction",
							text: "purple kayak",
							document_id: correctionSource,
						},
						{
							id: "incoming",
							text: newAssertion,
							document_id: item.document_id,
						},
					]);
				}
			}
			if (flip && path.endsWith("/memories/recall"))
				return new Response(
					JSON.stringify({
						results: [
							{
								id: "regenerated",
								text: newer ? "blue kayak" : "green kayak",
								type: "observation",
								source_fact_ids:
									kind === "newer replaces native support"
										? ["incoming"]
										: extraSupport
											? ["correction", "incoming"]
											: ["correction"],
							},
						],
					}),
				);
			const response = await fetch(url, init);
			if (!flip || !path.includes("/memories/list")) return response;
			const list = await response.json();
			const row = list.items.find(
				(r: { id: string }) => r.id === "observation-correction",
			);
			row.id = "regenerated";
			row.text = newer ? "blue kayak" : "green kayak";
			if (kind === "newer replaces native support") {
				row.source_memory_ids = ["incoming"];
				list.items = list.items.filter(
					(item: { id: string }) => item.id !== "observation-incoming",
				);
				list.total = list.items.length;
			} else if (extraSupport) row.source_memory_ids.push("incoming");
			return new Response(JSON.stringify(list));
		});
		const actions = await import("./curation-actions");
		const jobs = await import("./delivery-job");
		const reads = await import("./native-read");
		const edit = await actions.submitMemoryAction(
			h.userId,
			{
				kind: "edit",
				ref: claim,
				text: "purple kayak",
				requestId: randomUUID(),
			},
			withdrawAtDispatch || withdrawAtPublication ? "paddling" : undefined,
		);
		await h.engine.drain(jobs.memoryDeliveryJob);
		const corrected = actions.getMemoryOperation(h.userId, { id: edit.id }).ref;
		if (!corrected) throw Error("no correction");
		expect(reads.getMemoryDetail(h.userId, corrected)).toMatchObject({
			versions: [{ text: "kayak" }],
			sources: [{ quote: f.source.text, available: true }],
		});
		flip = true;
		let verification: unknown;
		let withdrew = false;
		if (withdrawAtDispatch || withdrawAtPublication) {
			const { revokeConversationMemory } = await import("./chat-delivery");
			const withdraw = async () => {
				await revokeConversationMemory(h.userId, ["paddling"]);
				const source = f.db
					.select()
					.from(f.s.memorySourceRevisions)
					.all()
					.find((source) => source.id === correctionSource);
				expect(source?.state).toBe("revoked");
				withdrew = true;
			};
			vi.spyOn(
				await import("./curation"),
				"createCurationModel",
			).mockReturnValue(
				async (_prompt, payload, _schema, _thinking, assertCurrent) => {
					if (withdrawAtDispatch) await withdraw();
					assertCurrent?.();
					verification = payload;
					if (withdrawAtPublication) await withdraw();
					return yes;
				},
			);
		} else {
			fixture.model.mockImplementationOnce(async (_prompt, payload) => {
				verification = payload;
				return newer ? yes : ckReject;
			});
		}
		const add = await actions.submitMemoryAction(h.userId, {
			kind: "add",
			scope,
			text: newAssertion,
			requestId: randomUUID(),
		});
		const { eq } = await import("drizzle-orm");
		f.db
			.update(f.s.memoryActions)
			.set({ createdAt: new Date(Date.now() + 60_000) })
			.where(eq(f.s.memoryActions.id, add.id))
			.run();
		await h.engine.drain(jobs.memoryDeliveryJob);
		const operation = actions.getMemoryOperation(h.userId, { id: add.id });
		if (withdrawAtDispatch || withdrawAtPublication) {
			expect(withdrew).toBe(true);
			if (withdrawAtDispatch) expect(verification).toBeUndefined();
			else
				expect(verification).toMatchObject({
					previous_displayed_observations: [{ text: "purple kayak" }],
				});
			expect(operation).toMatchObject({
				status: "queued",
				errorCode: "memory_dependency_source_changed",
			});
			expect(reads.listMemory(h.userId, { scope }).rows).not.toContainEqual(
				expect.objectContaining({ text: "blue kayak" }),
			);
			return;
		}
		if (extraSupport)
			expect(verification).toMatchObject({
				new_assertion: { text: newAssertion, assertedAt: expect.any(String) },
				previous_displayed_observations: [{ text: "purple kayak" }],
				displayed_observations: [
					{ text: newer ? "blue kayak" : "green kayak" },
				],
			});
		else expect(verification).toBeUndefined();
		const rows = reads.listMemory(h.userId, { scope }).rows;
		expect(rows).not.toContainEqual(
			expect.objectContaining({ text: "green kayak" }),
		);
		expect(reads.getMemoryDetail(h.userId, corrected)).toMatchObject({
			row: { text: "purple kayak" },
			versions: [{ text: "kayak" }],
		});
		const { recallMemory } = await import("../memory-context/native");
		const recalled = await recallMemory(h.userId, {
			conversationId: "paddling",
			query: "kayak",
			tokenBudget: 500,
		});
		if (newer) {
			expect(operation.status).toBe("applied");
			expect(rows).toContainEqual(
				expect.objectContaining({ text: "blue kayak" }),
			);
			expect(recalled.map((row) => row.text)).toContain("blue kayak");
		} else {
			expect(operation.status).not.toBe("applied");
			expect(recalled.map((row) => row.text)).not.toContain("green kayak");
		}
	},
);

it("re-review: revocation cannot turn a captured split into a verified history", async () => {
	const f = await setup();
	const pub = await import("./publication");
	const reads = await import("./native-read");
	const { eq } = await import("drizzle-orm");
	const rev = await import("./revisions");
	const source2 = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "b",
		lineageId: "b",
		text: "A bird",
		context: "",
		assertedAt: new Date(),
	});
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			state: "accepted",
			acknowledgedFactsJson: '[{"id":"bird","text":"bird"}]',
		})
		.where(eq(f.s.memorySourceRevisions.id, source2.id))
		.run();
	const mem = [
		{
			id: "kayak",
			text: "green kayak",
			fact_type: "world",
			document_id: f.source.id,
			consolidated_at: "2026-11-18",
		},
		{
			id: "sister",
			text: "sister bicycle",
			fact_type: "world",
			document_id: f.source.id,
			consolidated_at: "2026-11-18",
		},
		{
			id: "bird",
			text: "bird",
			fact_type: "world",
			document_id: source2.id,
			consolidated_at: "2026-11-18",
		},
		{
			id: "only-kayak",
			text: "kayak",
			fact_type: "observation",
			source_memory_ids: ["kayak"],
		},
		{
			id: "also-kayak",
			text: "kayak and bird",
			fact_type: "observation",
			source_memory_ids: ["kayak", "bird"],
		},
	];
	const generation = f.db.transaction((tx) =>
		pub.publishNativeSnapshot(tx, {
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			expectedRevision: 0,
			memories: mem,
		}),
	);
	f.db
		.insert(f.s.memoryActions)
		.values({
			id: "accepted-edit",
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			requestId: "edit",
			kind: "edit",
			generation: "g",
			rowId: "kayak",
			previousText: "Old kayak",
			text: "green kayak",
			resultRowId: "prior-unique",
			intentJson: JSON.stringify({
				request: {
					kind: "edit",
					requestId: randomUUID(),
					ref: claim,
					text: "green kayak",
				},
				before: "Old kayak",
				facts: [],
				sourceIds: [],
				outcome: "accepted",
				resultSupport: pub.memorySupportFingerprint([
					{ id: "kayak", text: "green kayak" },
				]),
				resultPresentation: pub.memoryPresentationFingerprint("kayak", "kayak"),
			}),
		})
		.run();
	const ref = { scope, generation, rowId: "only-kayak" };
	expect(reads.getMemoryDetail(h.userId, ref).versions).toEqual([]);
	rev.revokeMemorySources(h.userId, [source2.id]);
	// Filtering revoked rows does not change the split in the captured generation.
	expect(reads.getMemoryDetail(h.userId, ref).versions).toEqual([]);
	expect(
		reads.verifiedMemoryHistory(h.userId, f.bank.id, 0, "only-kayak"),
	).toEqual([]);
});

it("re-review: an edited chat never sends withdrawn sibling wording to the checker", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	const { eq } = await import("drizzle-orm");
	const rev = await import("./revisions");
	f.db
		.insert(f.s.conversations)
		.values([
			{ id: "chat-a", userId: h.userId, title: "Paddling" },
			{ id: "chat-b", userId: h.userId, title: "Companion chat" },
		])
		.run();
	const privateText =
		"My partner shared the synthetic private treatment marker BROWNOWL.";
	f.db
		.insert(f.s.messages)
		.values([
			{
				id: "message-a",
				conversationId: "chat-a",
				role: "user",
				content: f.source.text,
			},
			{
				id: "message-b",
				conversationId: "chat-b",
				role: "user",
				content: privateText,
			},
		])
		.run();
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			conversationId: "chat-a",
			messageId: "message-a",
			acknowledgedFactsJson: '[{"id":"sister","text":"sister bicycle"}]',
		})
		.where(eq(f.s.memorySourceRevisions.id, f.source.id))
		.run();
	const marker = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "source-b",
		conversationId: "chat-b",
		messageId: "message-b",
		lineageId: "b",
		text: privateText,
		context: "{}",
		assertedAt: f.source.assertedAt,
	});
	f.db
		.update(f.s.memorySourceRevisions)
		.set({ state: "accepted" })
		.where(eq(f.s.memorySourceRevisions.id, marker.id))
		.run();
	const manualActionId = randomUUID();
	const correction = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: `manual:${manualActionId}`,
		lineageId: manualActionId,
		text: "purple kayak",
		context: "{}",
		assertedAt: f.source.assertedAt,
	});
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			state: "accepted",
			acknowledgedFactsJson: '[{"id":"correction","text":"purple kayak"}]',
		})
		.where(eq(f.s.memorySourceRevisions.id, correction.id))
		.run();
	const prior = {
		request: {
			kind: "edit",
			ref: claim,
			text: "purple kayak",
			requestId: randomUUID(),
		},
		before: `green kayak. ${privateText}`,
		facts: [
			{ id: "kayak", text: "green kayak", sourceId: f.source.id },
			{ id: "private", text: privateText, sourceId: marker.id },
		],
		sourceIds: [f.source.id, marker.id],
		plan,
		addedSourceId: correction.id,
		outcome: "accepted",
	};
	f.db
		.insert(f.s.memoryActions)
		.values({
			id: manualActionId,
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			kind: "edit",
			requestId: prior.request.requestId,
			generation: "g",
			rowId: "kayak",
			text: "purple kayak",
			previousText: prior.before,
			intentJson: JSON.stringify(prior),
		})
		.run();
	rev.revokeMemorySources(h.userId, [marker.id]);
	f.db.delete(f.s.messages).where(eq(f.s.messages.id, "message-b")).run();
	const appended = `${f.source.text}. I play chess.`;
	f.db
		.insert(f.s.messages)
		.values({
			id: "append",
			conversationId: "chat-a",
			role: "user",
			content: appended,
		})
		.run();
	rev.revokeMemorySources(h.userId, [f.source.id]);
	const current = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "append",
		conversationId: "chat-a",
		messageId: "append",
		lineageId: f.source.lineageId,
		predecessorSourceId: f.source.id,
		text: appended,
		context: "{}",
		assertedAt: f.source.assertedAt,
		explicitEditAt: new Date(f.source.assertedAt.getTime() + 60_000),
	});
	const fetch = fixture.fetcher.getMockImplementation();
	if (!fetch) throw Error("fixture");
	fixture.fetcher.mockImplementation((url, init) => {
		if (String(url).endsWith("/memories") && init?.method === "POST")
			fixture.setFacts([
				{ id: "sister", text: "sister bicycle" },
				{ id: "correction", text: "purple kayak", document_id: correction.id },
				{ id: "chess", text: "I play chess.", document_id: current.id },
			]);
		return fetch(url, init);
	});
	let final: unknown;
	fixture.model.mockImplementation(async (_prompt, payload) => {
		if ("facts" in payload)
			return { facts: [{ id: "sister", text: "sister bicycle" }] };
		if ("displayed_observations" in payload) final = payload;
		if ("original_facts" in payload) return yes;
		return {
			forget: [],
			replace: ["I play chess"],
			preserve: ["sister bicycle"],
		};
	});
	const jobs = await import("./delivery-job");
	const job = await jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: current.id,
		requestId: "append",
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(eq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).toBe("succeeded");
	expect(JSON.stringify(final)).not.toContain("BROWNOWL");
	expect(final).toMatchObject({
		proposed_facts: expect.arrayContaining([
			expect.objectContaining({ text: "purple kayak" }),
			expect.objectContaining({ text: "I play chess." }),
		]),
	});
});

it.each([
	"pending-only",
	"mixed-support",
	"stale-source",
	"prior-observation-id",
] as const)(
	"Remove publication handles overlapping retain receipt: %s",
	async (shape) => {
		const f = await setup();
		const fixture = await nativeFixture(f, [
			{ forget: ["kayak"], replace: [], preserve: ["sister bicycle"] },
			{
				facts: [
					{ id: "kayak", text: "" },
					{ id: "sister", text: "sister bicycle" },
				],
			},
			ckOkay,
			ckOkay,
		]);
		const { eq } = await import("drizzle-orm");
		const { recordMemorySource } = await import("./revisions");
		const jobs = await import("./delivery-job");
		const actions = await import("./curation-actions");
		const { readPublishedMemory } = await import("./publication");
		const chatId = randomUUID();
		const messageId = randomUUID();
		const text = "My favorite exercise is fencing.";
		const at = new Date();
		f.db
			.insert(f.s.conversations)
			.values({
				id: chatId,
				userId: h.userId,
				title: "Separate retained source",
			})
			.run();
		f.db
			.insert(f.s.messages)
			.values({
				id: messageId,
				conversationId: chatId,
				role: "user",
				content: text,
				createdAt: at,
			})
			.run();
		const pending = recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: `message:${messageId}`,
			lineageId: messageId,
			conversationId: chatId,
			messageId,
			text,
			context: "",
			assertedAt: at,
		});
		const nativeOperationId = randomUUID();
		const delivery = await jobs.enqueueMemoryDelivery({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			kind: "source",
			sourceId: pending.id,
			requestId: `source:${pending.id}`,
		});
		f.db
			.update(f.s.memorySourceRevisions)
			.set({
				nativeAcknowledged: true,
				nativeSubmitted: true,
				nativeOperationId,
			})
			.where(eq(f.s.memorySourceRevisions.id, pending.id))
			.run();
		f.db
			.update(f.s.memoryDeliveryJobs)
			.set({
				status: "failed",
				retryable: true,
				errorCode: "memory_curation_publication_held",
			})
			.where(eq(f.s.memoryDeliveryJobs.id, delivery.row.id))
			.run();
		fixture.setFacts([
			{ id: "kayak", text: "green kayak" },
			{ id: "sister", text: "sister bicycle" },
			{ id: "pending-support", text, document_id: pending.id },
		]);
		if (shape === "stale-source") {
			f.db
				.update(f.s.messages)
				.set({ content: "Changed after native acknowledgment." })
				.where(eq(f.s.messages.id, messageId))
				.run();
		}
		if (shape === "prior-observation-id") {
			f.db
				.update(f.s.memoryPublishedRows)
				.set({ nativeId: "existing-published-id" })
				.where(eq(f.s.memoryPublishedRows.id, "sister"))
				.run();
		}
		if (shape === "mixed-support" || shape === "prior-observation-id") {
			const transport = fixture.fetcher.getMockImplementation();
			if (!transport) throw Error("missing fixture");
			fixture.fetcher.mockImplementation(async (url, init) => {
				const response = await transport(url, init);
				if (!String(url).includes("/memories/list")) return response;
				const body = await response.json();
				for (const row of body.items) {
					if (row.id !== "observation-pending-support") continue;
					if (shape === "mixed-support") row.source_memory_ids.push("sister");
					else row.id = "existing-published-id";
				}
				return Response.json(body);
			});
		}
		const op = await actions.submitMemoryAction(h.userId, {
			kind: "remove",
			ref: ckRef,
			requestId: randomUUID(),
		});
		expect(op.exclusionAcknowledged).toBe(true);
		await h.engine.drain(jobs.memoryDeliveryJob);
		const current = actions.getMemoryOperation(h.userId, { id: op.id });
		expect(current).toMatchObject({
			status: shape === "pending-only" ? "applied" : "failed",
			exclusionAcknowledged: true,
			cleanupPending: shape !== "pending-only",
		});
		const personal = readPublishedMemory(h.userId, f.bank.id);
		expect(personal).toHaveLength(1);
		expect(personal[0].text).toContain("sister");
		expect(personal[0].text).not.toContain("kayak");
		expect(fixture.patches).toEqual(["kayak"]);
		expect(
			f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(eq(f.s.memorySourceRevisions.id, pending.id))
				.get(),
		).toMatchObject({
			state: "pending",
			nativeAcknowledged: true,
			acknowledgedFactsJson: "[]",
		});
		if (shape === "pending-only") {
			const { retry } = await import("../jobs/ledger");
			expect(
				retry(jobs.memoryDeliveryJob, delivery.row.id, { userId: h.userId }),
			).not.toBeNull();
			await h.engine.drain(jobs.memoryDeliveryJob);
			expect(
				f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(eq(f.s.memoryDeliveryJobs.id, delivery.row.id))
					.get()?.status,
			).toBe("succeeded");
			expect(
				readPublishedMemory(h.userId, f.bank.id)
					.map((row) => row.text)
					.sort(),
			).toEqual([text, "sister bicycle"].sort());
			const retainOperations = fixture.fetcher.mock.calls.flatMap(
				([url, init]) =>
					String(url).endsWith("/memories") && init?.method === "POST"
						? [JSON.parse(String(init.body)).operation_id]
						: [],
			);
			// The retain was acknowledged before the job failed: the retry
			// continues from there and never sends it, or any new operation, again.
			expect(retainOperations).toEqual([]);
			expect(nativeOperationId).toBeTruthy();
		}
	},
);

/**
 * A later, unrelated source delivered through the real job engine: the fake
 * Hindsight learns it as one fact beside `live()` when its retain arrives.
 */
async function deliverLaterSource(
	f: Awaited<ReturnType<typeof setup>>,
	fixture: Awaited<ReturnType<typeof nativeFixture>>,
	live: () => Array<{ id: string; text: string; document_id?: string }>,
	learned: { id: string; text: string },
) {
	const rev = await import("./revisions");
	const jobs = await import("./delivery-job");
	const { eq } = await import("drizzle-orm");
	const source = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: `later:${learned.id}`,
		lineageId: `later:${learned.id}`,
		text: learned.text,
		context: "",
		assertedAt: new Date(),
	});
	const transport = fixture.fetcher.getMockImplementation();
	if (!transport) throw Error("missing native fixture");
	fixture.fetcher.mockImplementation(async (url, init) => {
		if (
			String(url).endsWith("/memories") &&
			init?.method === "POST" &&
			JSON.parse(String(init.body)).items[0]?.document_id === source.id
		)
			fixture.setFacts([...live(), { ...learned, document_id: source.id }]);
		return transport(url, init);
	});
	const queued = await jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: source.id,
		requestId: `source:${source.id}`,
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	return f.db
		.select()
		.from(f.s.memoryDeliveryJobs)
		.where(eq(f.s.memoryDeliveryJobs.id, queued.row.id))
		.get();
}

/** Every text the person and the model can read for the personal scope. */
async function readableMemory(f: Awaited<ReturnType<typeof setup>>) {
	const read = await import("./native-read");
	const { recallMemory } = await import("../memory-context/native");
	const { writeMemoryOverview } = await import("./overview");
	const page = read
		.listMemory(h.userId, { scope: { kind: "personal" } })
		.rows.map(({ text }) => text)
		.sort();
	const chatId = `recall-${randomUUID()}`;
	f.db
		.insert(f.s.conversations)
		.values({ id: chatId, userId: h.userId, title: "Synthetic recall chat" })
		.run();
	const recall = (
		await recallMemory(h.userId, {
			conversationId: chatId,
			query: "kayak canoe maps bicycle",
			tokenBudget: 4000,
		})
	).map(({ text }) => text);
	let overviewInput = "";
	await writeMemoryOverview(
		h.userId,
		{ kind: "personal" },
		{
			rewrite: true,
			model: async (_prompt, input) => {
				overviewInput = JSON.stringify(input);
				return { overview: "Synthetic overview." };
			},
		},
	);
	return { page, recall, overviewInput };
}

it("a refused Remove keeps its card out of every read while later learning publishes", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, [
		{ forget: ["green kayak"], replace: [], preserve: ["sister bicycle"] },
		ckProposal("kayak", ""),
		ckReject,
		ckProposal("kayak", ""),
		ckReject,
	]);
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	// The review refused every proposal before any native write: Hindsight
	// still holds the kayak and its observation.
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "failed",
		exclusionAcknowledged: true,
	});
	expect(fixture.patches).toEqual([]);
	const live = () => [
		{ id: "kayak", text: "green kayak" },
		{ id: "sister", text: "sister bicycle" },
	];
	const later = await deliverLaterSource(f, fixture, live, {
		id: "maps",
		text: "I collect maps.",
	});
	expect(later).toMatchObject({ status: "succeeded", errorCode: null });
	const { page, recall, overviewInput } = await readableMemory(f);
	expect(page).toEqual(["I collect maps.", "sister bicycle"]);
	expect(recall.sort()).toEqual(["I collect maps.", "sister bicycle"]);
	expect(overviewInput).toContain("I collect maps.");
	for (const text of [...page, ...recall, overviewInput])
		expect(text).not.toContain("kayak");
	const bank = f.db.select().from(f.s.memoryBanks).get();
	const { eq } = await import("drizzle-orm");
	expect(
		f.db
			.select()
			.from(f.s.memoryPublishedRows)
			.where(eq(f.s.memoryPublishedRows.generation, bank?.generation ?? ""))
			.all()
			.some(({ sourceIdsJson }) => sourceIdsJson.includes('"kayak"')),
	).toBe(false);
	// The bank takes curation again: another card can be removed.
	const next = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: {
			scope: { kind: "personal" },
			generation: bank?.generation ?? "",
			rowId: "observation-maps",
		},
		requestId: randomUUID(),
	});
	expect(next.exclusionAcknowledged).toBe(true);
});

it("a Remove refused after its native write keeps the observations rebuilt around it out", async () => {
	const f = await setup();
	const { eq } = await import("drizzle-orm");
	// The kayak has its own card and shares a second one with a canoe.
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			acknowledgedFactsJson: JSON.stringify([
				{ id: "kayak", text: "green kayak" },
				{ id: "canoe", text: "red canoe" },
				{ id: "sister", text: "sister bicycle" },
			]),
		})
		.run();
	f.db
		.insert(f.s.memoryPublishedRows)
		.values({
			id: "boats",
			nativeId: "boats",
			bankId: f.bank.id,
			generation: "g",
			epoch: 0,
			text: "green kayak and red canoe",
			nativeText: "green kayak and red canoe",
			sourceIdsJson: JSON.stringify(["kayak", "canoe"]),
			sourceFingerprintsJson: JSON.stringify([
				{ id: "kayak", text: "green kayak" },
				{ id: "canoe", text: "red canoe" },
			]),
			updatedAt: new Date(),
		})
		.run();
	const fixture = await nativeFixture(f, []);
	let live = [
		{ id: "kayak", text: "green kayak" },
		{ id: "canoe", text: "red canoe" },
		{ id: "sister", text: "sister bicycle" },
	];
	fixture.setFacts(live);
	const transport = fixture.fetcher.getMockImplementation();
	if (!transport) throw Error("missing native fixture");
	fixture.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.includes("/memories/") && init?.method === "PATCH")
			live = live.filter((fact) => fact.id !== path.split("/").at(-1));
		const response = await transport(url, init);
		if (!path.includes("/memories/list")) return response;
		const body = await response.json();
		// Hindsight rebuilt the canoe's observation once the kayak was gone, and
		// kept the removed colour in its wording.
		for (const item of body.items)
			if (
				item.id === "observation-canoe" &&
				!live.some((f) => f.id === "kayak")
			)
				item.text = "red canoe, earlier beside a green kayak";
		return Response.json(body);
	});
	fixture.model.mockImplementation(async (_prompt, input) => {
		if ("facts" in input)
			return {
				facts: [
					{ id: "kayak", text: "" },
					{ id: "canoe", text: "red canoe" },
					{ id: "sister", text: "sister bicycle" },
				],
			};
		// The final check refuses what Hindsight rebuilt, on every attempt.
		if ("displayed_observations" in input) return ckReject;
		if ("original_facts" in input) return ckOkay;
		return { forget: ["green kayak"], replace: [], preserve: ["red canoe"] };
	});
	const a = await import("./curation-actions");
	const jobs = await import("./delivery-job");
	const op = await a.submitMemoryAction(h.userId, {
		kind: "remove",
		ref: ckRef,
		requestId: randomUUID(),
	});
	vi.useFakeTimers({ toFake: ["Date"] });
	for (let round = 0; round < 12; round++) {
		await h.engine.drain(jobs.memoryDeliveryJob);
		if (a.getMemoryOperation(h.userId, { id: op.id }).status === "failed")
			break;
		vi.setSystemTime(Date.now() + 10 * 60_000);
	}
	expect(a.getMemoryOperation(h.userId, { id: op.id })).toMatchObject({
		status: "failed",
		errorCode: "memory_dependency_check_rejected",
		exclusionAcknowledged: true,
	});
	expect(fixture.patches).toEqual(["kayak"]);
	const later = await deliverLaterSource(f, fixture, () => live, {
		id: "maps",
		text: "I collect maps.",
	});
	expect(later).toMatchObject({ status: "succeeded", errorCode: null });
	vi.useRealTimers();
	const { page, recall, overviewInput } = await readableMemory(f);
	expect(page).toEqual(["I collect maps.", "sister bicycle"]);
	expect(recall.sort()).toEqual(["I collect maps.", "sister bicycle"]);
	for (const text of [...page, ...recall, overviewInput])
		expect(text).not.toContain("kayak");
	const bank = f.db.select().from(f.s.memoryBanks).get();
	expect(
		f.db
			.select()
			.from(f.s.memoryPublishedRows)
			.where(eq(f.s.memoryPublishedRows.generation, bank?.generation ?? ""))
			.all()
			.map(({ nativeId }) => nativeId)
			.sort(),
	).toEqual(["observation-maps", "observation-sister"]);
});

it("a source refused by its own check does not hold later learning", async () => {
	const f = await setup();
	const fixture = await nativeFixture(f, []);
	const rev = await import("./revisions");
	const jobs = await import("./delivery-job");
	const { eq } = await import("drizzle-orm");
	// A changed resend whose final check refused it: its facts sit in Hindsight unaccepted.
	const held = rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "held-resend",
		lineageId: "held-resend",
		text: "I drink coffee on the terrace.",
		context: "",
		assertedAt: new Date(),
	});
	const delivery = await jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		kind: "source",
		sourceId: held.id,
		requestId: `source:${held.id}`,
	});
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			nativeSubmitted: true,
			nativeAcknowledged: true,
			nativeOperationId: randomUUID(),
		})
		.where(eq(f.s.memorySourceRevisions.id, held.id))
		.run();
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({
			status: "failed",
			retryable: true,
			errorCode: "memory_dependency_check_rejected",
		})
		.where(eq(f.s.memoryDeliveryJobs.id, delivery.row.id))
		.run();
	const live = () => [
		{ id: "kayak", text: "green kayak" },
		{ id: "sister", text: "sister bicycle" },
		{ id: "terrace", text: "coffee on the terrace", document_id: held.id },
	];
	fixture.setFacts(live());
	const later = await deliverLaterSource(f, fixture, live, {
		id: "maps",
		text: "I collect maps.",
	});
	expect(later).toMatchObject({ status: "succeeded", errorCode: null });
	const read = await import("./native-read");
	expect(
		read
			.listMemory(h.userId, { scope: { kind: "personal" } })
			.rows.map(({ text }) => text)
			.sort(),
	).toEqual(["I collect maps.", "green kayak", "sister bicycle"]);
	expect(
		f.db
			.select()
			.from(f.s.memorySourceRevisions)
			.where(eq(f.s.memorySourceRevisions.id, held.id))
			.get()?.state,
	).toBe("pending");
});
