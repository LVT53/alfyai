import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-delivery");
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	h.cleanup();
});
async function setup() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const rev = await import("./revisions");
	const jobs = await import("./delivery-job");
	const clientModule = await import("./hindsight-client");
	const config = await import("$lib/server/config-store");
	const bank = rev.ensureMemoryBank(h.userId, { kind: "personal" });
	db.update(schema.memoryAccounts).set({ authority: "hindsight" }).run();
	const source = rev.recordMemorySource({
		userId: h.userId,
		bankId: bank.id,
		epoch: 0,
		eventId: "event",
		lineageId: "message",
		text: "My kayak is green",
		context: "User statement",
		assertedAt: new Date("2026-11-18"),
	});
	const base = config.getConfig();
	vi.spyOn(config, "getConfig").mockReturnValue({
		...base,
		hindsightWorkerEnabled: true,
		hindsightConcurrency: 1,
	});
	const native = await import("./contracts");
	let calls = 0;
	let deleted = false;
	const fetcher = vi.fn(
		async (url: RequestInfo | URL, options?: RequestInit) => {
			const path = String(url);
			if (options?.method === "DELETE" && !path.includes("/documents/"))
				deleted = true;
			if (
				deleted &&
				options?.method === "GET" &&
				path.endsWith(`${bank.id}/config`)
			)
				return new Response("missing", { status: 404 });
			calls++;
			let data: unknown = {};
			if (path.endsWith("/config"))
				data = { config: native.nativeBankConfig("personal") };
			else if (path.endsWith("/memories") && options?.method === "POST")
				data = { operation_id: JSON.parse(String(options?.body)).operation_id };
			else if (path.endsWith("/consolidate"))
				data = { operation_id: "consolidate-op" };
			else if (path.includes("/operations?")) data = { operations: [] };
			else if (path.includes("/operations/")) data = { status: "completed" };
			else if (path.includes("/memories/list"))
				data = {
					total: 2,
					offset: 0,
					items: [
						{
							id: "f",
							text: "Green kayak",
							fact_type: "world",
							consolidated_at: "2026-11-18T00:00:00Z",
							document_id: source.id,
						},
						{
							id: "o",
							text: "Green kayak",
							fact_type: "observation",
							source_memory_ids: ["f"],
						},
					],
				};
			return new Response(JSON.stringify(data));
		},
	);
	vi.spyOn(clientModule, "configuredNativeBinding").mockReturnValue({
		baseUrl: "http://synthetic",
		credentialHash: "synthetic-hash",
	});
	vi.spyOn(clientModule, "nativeMemoryClient").mockImplementation(
		() =>
			new clientModule.HindsightClient({
				baseUrl: "http://synthetic",
				apiKey: "synthetic",
				bankId: bank.id,
				fetcher,
			}),
	);
	const enqueue = () =>
		jobs.enqueueMemoryDelivery({
			userId: h.userId,
			bankId: bank.id,
			epoch: 0,
			kind: "source",
			sourceId: source.id,
			requestId: "request",
		});
	return {
		db,
		schema,
		rev,
		jobs,
		bank,
		source,
		fetcher,
		enqueue,
		getCalls: () => calls,
		clientModule,
	};
}
describe("Memory delivery through real job engine", () => {
	it("delivers for an account the migration guard excludes: delivery is not a migration", async () => {
		const f = await setup();
		const { eq } = await import("drizzle-orm");
		f.db
			.update(f.schema.users)
			.set({ memoryMigrationExcluded: true })
			.where(eq(f.schema.users.id, h.userId))
			.run();
		const { memoryMigrationGuard } = await import("./migration-guard");
		expect(memoryMigrationGuard(h.userId)).toEqual({
			allowed: false,
			reason: "excluded",
		});
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		const pub = await import("./publication");
		expect(pub.readPublishedMemory(h.userId, f.bank.id)[0].text).toBe(
			"Green kayak",
		);
	});
	it("deduplicates enqueue and publishes only after native completion", async () => {
		const f = await setup();
		const a = await f.enqueue();
		const b = await f.enqueue();
		expect(b.row.id).toBe(a.row.id);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const job = f.db.select().from(f.schema.memoryDeliveryJobs).get();
		expect(job?.status).toBe("succeeded");
		const pub = await import("./publication");
		expect(pub.readPublishedMemory(h.userId, f.bank.id)[0].text).toBe(
			"Green kayak",
		);
		expect(
			f.fetcher.mock.calls.filter(
				([url, init]) =>
					String(url).endsWith("/memories") && init?.method === "POST",
			),
		).toHaveLength(1);
	});
	it("late remote response cannot publish after cancellation/reset", async () => {
		const f = await setup();
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const waiting = new Promise<void>((r) => (entered = r));
		const pending = new Promise<void>((r) => (release = r));
		const original = f.fetcher.getMockImplementation();
		if (!original) throw new Error("Missing fixture fetch");
		f.fetcher.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/memories") && init?.method === "POST") {
				entered();
				await pending;
			}
			return original(url, init);
		});
		const job = await f.enqueue();
		const drain = h.engine.drain(f.jobs.memoryDeliveryJob);
		await waiting;
		await h.engine.cancel(f.jobs.memoryDeliveryJob, job.row.id, {
			userId: h.userId,
		});
		f.db.update(f.schema.memoryAccounts).set({ epoch: 1 }).run();
		release();
		await drain;
		expect(f.db.select().from(f.schema.memoryPublishedRows).all()).toEqual([]);
	});
	it("erasure tombstone survives local account deletion with no text", async () => {
		const f = await setup();
		const { HINDSIGHT_ENGINE_COMMIT } = await import("./contracts");
		f.db
			.update(f.schema.memoryBanks)
			.set({
				nativeBaseUrl: "http://synthetic",
				nativeCredentialHash: "synthetic-hash",
				nativeConfigVersion: HINDSIGHT_ENGINE_COMMIT,
			})
			.run();
		await f.jobs.prepareNativeMemoryErasure(h.userId);
		f.db.delete(f.schema.users).run();
		const job = f.db.select().from(f.schema.memoryDeliveryJobs).get();
		expect(job?.kind).toBe("cleanup");
		expect(job?.userId).not.toBe(h.userId);
		expect(JSON.stringify(job)).not.toContain("kayak");
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
	});
	it("retains the same native identity after acknowledgement loss and terminal retry", async () => {
		const f = await setup();
		const original = f.fetcher.getMockImplementation();
		if (!original) throw new Error("fixture");
		let failures = 3;
		let received = false;
		const identities: string[] = [];
		f.fetcher.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/memories") && init?.method === "POST") {
				identities.push(JSON.parse(String(init.body)).operation_id);
				if (failures-- > 0)
					return new Response("lost acknowledgement", { status: 503 });
				received = true;
			}
			// Hindsight never received the lost ones: it does not know the operation,
			// so each try asks and then sends the same ID again.
			if (
				!received &&
				String(url).includes("/operations/") &&
				!String(url).includes("consolidate-op")
			)
				return new Response(JSON.stringify({ status: "not_found" }));
			return original(url, init);
		});
		const job = await f.enqueue();
		vi.useFakeTimers();
		for (let i = 0; i < 3; i++) {
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			vi.setSystemTime(Date.now() + 61000);
		}
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"failed",
		);
		await h.engine.retry(f.jobs.memoryDeliveryJob, job.row.id, {
			userId: h.userId,
		});
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(new Set(identities).size).toBe(1);
		expect(identities).toHaveLength(4);
	});
	it("does not transmit a revoked source after blocked configuration", async () => {
		const f = await setup();
		const original = f.fetcher.getMockImplementation();
		if (!original) throw new Error("fixture");
		f.fetcher.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/config") && init?.method === "PATCH")
				f.rev.revokeMemorySources(h.userId, [f.source.id]);
			return original(url, init);
		});
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(
			f.fetcher.mock.calls.some(
				([url, init]) =>
					String(url).endsWith("/memories") && init?.method === "POST",
			),
		).toBe(false);
	});
	it("cleans a source while memory is off", async () => {
		const f = await setup();
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({ nativeSubmitted: true, nativeAcknowledged: true })
			.run();
		f.rev.revokeMemorySources(h.userId, [f.source.id]);
		f.db.update(f.schema.users).set({ memoryEnabled: false }).run();
		const original = f.fetcher.getMockImplementation();
		if (!original) throw new Error("fixture");
		f.fetcher.mockImplementation(async (url, init) =>
			String(url).includes("/memories/list")
				? new Response(JSON.stringify({ items: [], total: 0, offset: 0 }))
				: original(url, init),
		);
		await f.jobs.enqueueMemoryDelivery({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			kind: "source_cleanup",
			sourceId: f.source.id,
			requestId: "cleanup",
		});
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(
			f.fetcher.mock.calls.some(
				([url, init]) =>
					String(url).includes("/documents/") && init?.method === "DELETE",
			),
		).toBe(true);
	});
	it("rejects conflicting idempotency reuse", async () => {
		const f = await setup();
		await f.enqueue();
		await expect(
			f.jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source_cleanup",
				sourceId: f.source.id,
				requestId: "request",
			}),
		).rejects.toThrow("memory_request_conflict");
	});
	it("rolls domain epoch back when atomic cleanup enqueue fails", async () => {
		const f = await setup();
		await expect(
			h.engine.enqueueAtomic(f.jobs.memoryDeliveryJob, (tx) => {
				tx.update(f.schema.memoryAccounts).set({ epoch: 99 }).run();
				return [
					{
						values: {
							userId: h.userId,
							bankId: f.bank.id,
							epoch: 0,
							kind: "cleanup",
							requestId: "collision",
						},
					},
					{
						values: {
							userId: h.userId,
							bankId: f.bank.id,
							epoch: 0,
							kind: "cleanup",
							requestId: "collision",
						},
					},
				];
			}),
		).rejects.toThrow();
		expect(f.db.select().from(f.schema.memoryAccounts).get()?.epoch).toBe(0);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).all()).toEqual([]);
	});
});

it("erases a bank after completed retain receipts have been pruned", async () => {
	const f = await setup();
	await f.enqueue();
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.db.select().from(f.schema.memorySourceRevisions).get()?.state).toBe(
		"accepted",
	);
	const original = f.fetcher.getMockImplementation();
	if (!original) throw new Error("missing fixture transport");
	f.fetcher.mockImplementation(async (url, init) =>
		String(url).includes("/operations/")
			? new Response(JSON.stringify({ status: "not_found" }))
			: original(url, init),
	);
	await f.jobs.prepareNativeMemoryErasure(h.userId);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const cleanup = f.db.select().from(f.schema.memoryDeliveryJobs).get();
	expect(cleanup?.status).toBe("succeeded");
	expect(
		f.fetcher.mock.calls.some(([, init]) => init?.method === "DELETE"),
	).toBe(true);
});

it("keeps a durable write fence throughout reset and advances both authorities atomically", async () => {
	const f = await setup();
	await f.jobs.prepareNativeMemoryErasure(h.userId);
	const second = await h.bootSecondProcess();
	expect(
		second.sqlite
			.prepare(
				"SELECT lifecycle_state,epoch FROM memory_accounts WHERE user_id=?",
			)
			.get(h.userId),
	).toEqual({ lifecycle_state: "erasing", epoch: 1 });
	expect(
		second.sqlite
			.prepare(
				"SELECT reset_generation FROM memory_reset_generations WHERE user_id=?",
			)
			.get(h.userId),
	).toEqual({ reset_generation: 1 });
	expect(() => f.rev.ensureMemoryBank(h.userId, { kind: "personal" })).toThrow(
		/erasing/,
	);
	await f.jobs.prepareNativeMemoryErasure(h.userId);
	expect(f.db.select().from(f.schema.memoryAccounts).get()?.epoch).toBe(1);
});

it("does not send a cached context message whose source was revoked after enqueue", async () => {
	const f = await setup();
	const prior = f.rev.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "prior",
		lineageId: "prior",
		text: "Secret old address",
		context: "",
		assertedAt: new Date(),
	});
	f.db
		.update(f.schema.memorySourceRevisions)
		.set({
			context: JSON.stringify({
				messages: [
					{
						id: "old",
						role: "user",
						text: "Secret old address",
						sourceId: prior.id,
						textHash: prior.textHash,
					},
				],
			}),
		})
		.where(
			(await import("drizzle-orm")).eq(
				f.schema.memorySourceRevisions.id,
				f.source.id,
			),
		)
		.run();
	await f.enqueue();
	f.rev.revokeMemorySources(h.userId, [prior.id]);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const retain = f.fetcher.mock.calls.find(
		([url, init]) =>
			String(url).endsWith("/memories") && init?.method === "POST",
	);
	expect(retain).toBeDefined();
	expect(JSON.parse(String(retain?.[1]?.body)).items[0].context).not.toContain(
		"Secret old address",
	);
});

it("rolls back source creation when its atomic engine intent cannot commit", async () => {
	const f = await setup();
	await expect(
		f.jobs.enqueueMemoryMutation(() => {
			f.rev.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				eventId: "crash-source",
				lineageId: "crash-source",
				text: "Must not be stranded",
				context: "",
				assertedAt: new Date(),
			});
			throw Error("simulated interruption before intent insertion");
		}),
	).rejects.toThrow(/simulated interruption/);
	expect(
		f.db
			.select()
			.from(f.schema.memorySourceRevisions)
			.all()
			.some((s) => s.eventId === "crash-source"),
	).toBe(false);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).all()).toEqual([]);
});

it("cannot bind an old source to a new control revision merely by re-enqueueing", async () => {
	const f = await setup();
	f.db.update(f.schema.memoryAccounts).set({ controlRevision: 2 }).run();
	await f.enqueue();
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(
		f.fetcher.mock.calls.some(
			([url, init]) =>
				String(url).endsWith("/memories") && init?.method === "POST",
		),
	).toBe(false);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
		"failed",
	);
});

it.each(["uncurated", "curated", "changed question"])(
	"resolves a short reply’s stored question only from an unchanged uncurated source (%s)",
	async (mode) => {
		const f = await setup();
		const { eq } = await import("drizzle-orm");
		const chat = "short-reply-chat";
		await f.db
			.insert(f.schema.conversations)
			.values({ id: chat, userId: h.userId, title: "Short reply" });
		const question = "Is your sister the one who owns the bicycle?";
		await f.db.insert(f.schema.messages).values([
			{
				id: "short-prior",
				conversationId: chat,
				role: "user",
				messageSequence: 1,
				content: "Someone in my family owns a bicycle.",
			},
			{
				id: "short-question",
				conversationId: chat,
				role: "assistant",
				messageSequence: 2,
				content:
					mode === "changed question" ? "Unrelated replacement" : question,
			},
			{
				id: "short-yes",
				conversationId: chat,
				role: "user",
				messageSequence: 3,
				content: "Yes.",
			},
		]);
		const prior = f.rev.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "short-prior",
			lineageId: "short-prior",
			conversationId: chat,
			messageId: "short-prior",
			text: "Someone in my family owns a bicycle.",
			context: "",
			assertedAt: new Date("2026-11-12"),
		});
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({
				state: "accepted",
				acknowledgedFactsJson: JSON.stringify([
					{ id: "short-fact", text: "A family member owns a bicycle." },
				]),
			})
			.where(eq(f.schema.memorySourceRevisions.id, prior.id))
			.run();
		if (mode === "curated") {
			f.db
				.insert(f.schema.memoryActions)
				.values({
					id: "short-curation",
					userId: h.userId,
					bankId: f.bank.id,
					epoch: 0,
					requestId: "short-curation",
					kind: "remove",
					exclusionAcknowledged: true,
					intentJson: JSON.stringify({
						sourceIds: [prior.id],
						outcome: "accepted",
					}),
				})
				.run();
		}
		const context = JSON.stringify({
			messages: [
				{
					id: "short-prior",
					role: "user",
					sourceId: prior.id,
					textHash: prior.textHash,
				},
				{
					id: "short-question",
					role: "assistant",
					sourceId: prior.id,
					textHash: prior.textHash,
					messageTextHash: f.rev.memoryTextHash(question),
				},
			],
		});
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({
				conversationId: chat,
				messageId: "short-yes",
				text: "Yes.",
				textHash: f.rev.memoryTextHash("Yes."),
				context,
			})
			.where(eq(f.schema.memorySourceRevisions.id, f.source.id))
			.run();
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const retain = f.fetcher.mock.calls.find(
			([url, init]) =>
				String(url).endsWith("/memories") && init?.method === "POST",
		);
		const payload = JSON.parse(String(retain?.[1]?.body)).items[0];
		expect(payload.content).toBe("Yes.");
		expect(payload.context).toContain("A family member owns a bicycle.");
		expect(payload.context.includes(question)).toBe(mode === "uncurated");
		expect(payload.context).not.toContain("Unrelated replacement");
	},
);

it("waits for a late configuration commit before completing reset cleanup", async () => {
	const f = await setup();
	const actions = await import("./curation-actions");
	const clients = await import("./hindsight-client");
	const { nativeBankConfig } = await import("./contracts");
	let bankExists = false;
	let exactConfigVisible = false;
	let finishRemoteWrite: (() => void) | undefined;
	let notifySubmission!: () => void;
	const submitted = new Promise<void>((resolve) => {
		notifySubmission = resolve;
	});
	vi.mocked(clients.nativeMemoryClient).mockImplementation(
		(bankId, _tenantId, signal) =>
			new clients.HindsightClient({
				baseUrl: "http://synthetic",
				apiKey: "synthetic",
				bankId,
				signal,
				fetcher: f.fetcher,
			}),
	);
	f.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (init?.method === "PUT") return new Response("{}");
		if (path.endsWith("/config") && init?.method === "PATCH") {
			finishRemoteWrite = () => {
				bankExists = true;
			};
			notifySubmission();
			await new Promise<void>((_resolve, reject) =>
				init.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true },
				),
			);
		}
		if (path.endsWith("/config") && init?.method === "GET")
			return bankExists
				? new Response(
						JSON.stringify({
							config: exactConfigVisible ? nativeBankConfig("personal") : {},
						}),
					)
				: new Response("missing", { status: 404 });
		if (path.includes("/operations?"))
			return new Response(JSON.stringify({ operations: [] }));
		if (init?.method === "DELETE") {
			bankExists = false;
			return new Response("{}");
		}
		throw Error("unexpected synthetic native call");
	});
	await actions.submitMemoryAction(h.userId, {
		kind: "add",
		scope: { kind: "personal" },
		text: "My synthetic cup is violet.",
		requestId: "1e989f87-c08f-4752-b423-f2a40266ffc9",
	});
	const draining = h.engine.drain(f.jobs.memoryDeliveryJob);
	await Promise.race([
		submitted,
		draining.then(() => {
			if (!finishRemoteWrite)
				throw Error("first action finished before configuration dispatch");
		}),
	]);
	await f.jobs.prepareNativeMemoryErasure(h.userId);
	await draining;
	const beforeCommit = f.db.select().from(f.schema.memoryDeliveryJobs).get();
	expect(beforeCommit).toMatchObject({
		kind: "cleanup",
		status: "queued",
		errorCode: "native_config_unconfirmed",
	});
	expect(bankExists).toBe(false);
	finishRemoteWrite?.();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.now() + 6000);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()).toMatchObject({
		status: "queued",
		errorCode: "native_config_unconfirmed",
	});
	expect(bankExists).toBe(true);
	expect(
		f.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE"),
	).toHaveLength(0);
	exactConfigVisible = true;
	vi.setSystemTime(Date.now() + 11000);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
		"succeeded",
	);
	expect(bankExists).toBe(false);
	expect(
		f.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH"),
	).toHaveLength(1);
	expect(
		f.fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE"),
	).toHaveLength(1);
	expect(
		f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
	).toHaveLength(0);
});

it("keeps an unconfirmed checkpoint after a lost first submission and never resends it", async () => {
	const f = await setup();
	const { NATIVE_BANK_CONFIG_PENDING } = await import("./contracts");
	vi.mocked(
		(await import("./hindsight-client")).nativeMemoryClient,
	).mockImplementation(
		(bankId, _tenantId, signal) =>
			new f.clientModule.HindsightClient({
				baseUrl: "http://synthetic",
				apiKey: "synthetic",
				bankId,
				signal,
				fetcher: f.fetcher,
			}),
	);
	f.fetcher.mockImplementation(async (url, init) => {
		if (String(url).endsWith("/config") && init?.method === "PATCH")
			throw Error("synthetic loss before native received the request");
		return new Response("missing", { status: 404 });
	});
	await f.enqueue();
	vi.useFakeTimers({ toFake: ["Date"] });
	for (let i = 0; i < 3; i++) {
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		vi.setSystemTime(Date.now() + 16000);
	}
	expect(
		f.db.select().from(f.schema.memoryBanks).get()?.nativeConfigVersion,
	).toBe(NATIVE_BANK_CONFIG_PENDING);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()).toMatchObject({
		status: "failed",
		retryable: true,
		errorCode: "native_config_unconfirmed",
	});
	expect(
		f.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH"),
	).toHaveLength(1);
	expect(
		f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
	).toHaveLength(0);
	await f.jobs.prepareNativeMemoryErasure(h.userId);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()).toMatchObject({
		kind: "cleanup",
		status: "queued",
		errorCode: "native_config_unconfirmed",
		nativeOperationIdsJson: JSON.stringify([NATIVE_BANK_CONFIG_PENDING]),
	});
});

it("publishing a snapshot records its facts' labels and event dates", async () => {
	const f = await setup();
	const original = f.fetcher.getMockImplementation();
	if (!original) throw Error("fixture");
	f.fetcher.mockImplementation(async (url, init) => {
		if (String(url).includes("/memories/list"))
			return Response.json({
				total: 2,
				offset: 0,
				items: [
					{
						id: "f",
						text: "Green kayak",
						fact_type: "world",
						consolidated_at: "2026-11-18T00:00:00Z",
						document_id: f.source.id,
						tags: [f.source.id, "kind:lasting", "subject:interests"],
						occurred_start: null,
						occurred_end: null,
					},
					{
						id: "o",
						text: "Green kayak",
						fact_type: "observation",
						source_memory_ids: ["f"],
					},
				],
			});
		return original(url, init);
	});
	await f.enqueue();
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
		"succeeded",
	);
	const { readFactLabels } = await import("./fact-labels");
	expect(readFactLabels(f.db, f.bank.id).get("f")).toEqual({
		kind: "lasting",
		subject: "interests",
		eventAt: null,
		origin: "extraction",
	});
});

describe("bank configuration 2 reaches every bank", () => {
	async function boundAt(version: string, live: unknown) {
		const f = await setup();
		f.db
			.update(f.schema.memoryBanks)
			.set({
				nativeBaseUrl: "http://synthetic",
				nativeCredentialHash: "synthetic-hash",
				nativeConfigVersion: version,
			})
			.run();
		const state = {
			live,
			versionAtPatch: undefined as string | null | undefined,
		};
		const original = f.fetcher.getMockImplementation();
		if (!original) throw Error("fixture");
		let deleted = false;
		f.fetcher.mockImplementation(async (url, init) => {
			const path = String(url);
			if (init?.method === "DELETE" && !path.includes("/documents/"))
				deleted = true;
			if (path.endsWith("/config") && deleted)
				return new Response("missing", { status: 404 });
			if (path.endsWith("/config") && init?.method === "PATCH") {
				state.versionAtPatch = f.db
					.select()
					.from(f.schema.memoryBanks)
					.get()?.nativeConfigVersion;
				state.live = JSON.parse(String(init.body)).updates;
				return Response.json({ config: state.live });
			}
			if (path.endsWith("/config") && init?.method !== "DELETE")
				return Response.json({ config: state.live });
			return original(url, init);
		});
		const patches = () =>
			f.fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH");
		return { f, state, patches };
	}

	it("upgrades a bank configured by the previous release with one PATCH, and no sentinel", async () => {
		const native = await import("./contracts");
		const { f, state, patches } = await boundAt(
			native.HINDSIGHT_ENGINE_COMMIT,
			native.PREVIOUS_NATIVE_BANK_CONFIG,
		);
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(patches()).toHaveLength(1);
		expect(JSON.parse(String(patches()[0][1]?.body)).updates).toEqual(
			native.nativeBankConfig("personal"),
		);
		// The bank holds the person's data, so it stays at config 1 until the
		// readback proves config 2: nothing can hold it in between.
		expect(state.versionAtPatch).toBe(native.HINDSIGHT_ENGINE_COMMIT);
		expect(
			f.db.select().from(f.schema.memoryBanks).get()?.nativeConfigVersion,
		).toBe(native.NATIVE_BANK_CONFIG_VERSION);
	});

	it("marks the epoch's labels unverified when it upgrades a config-1 bank", async () => {
		const native = await import("./contracts");
		const { memoryLabelsVerified } = await import("./labels-verified");
		const { f } = await boundAt(
			native.HINDSIGHT_ENGINE_COMMIT,
			native.PREVIOUS_NATIVE_BANK_CONFIG,
		);
		expect(memoryLabelsVerified(h.userId)).toBe(true);
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(memoryLabelsVerified(h.userId)).toBe(false);
	});

	it("keeps an epoch the label migration verified verified when it upgrades a config-1 bank", async () => {
		const native = await import("./contracts");
		const labels = await import("./labels-verified");
		const { f } = await boundAt(
			native.HINDSIGHT_ENGINE_COMMIT,
			native.PREVIOUS_NATIVE_BANK_CONFIG,
		);
		// What migration 143 and then the label migration did before this
		// delivery reached the bank: every fact in it predates the upgrade.
		f.db.transaction((tx) => {
			labels.markMemoryLabelsUnverified(tx, h.userId, f.bank.epoch);
			expect(labels.markMemoryLabelsVerified(tx, h.userId, f.bank.epoch)).toBe(
				true,
			);
		});
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(
			f.db.select().from(f.schema.memoryBanks).get()?.nativeConfigVersion,
		).toBe(native.NATIVE_BANK_CONFIG_VERSION);
		expect(labels.memoryLabelsVerified(h.userId)).toBe(true);
	});

	it("marks a verified epoch again when a creation the previous release sent landed as config 1", async () => {
		const native = await import("./contracts");
		const labels = await import("./labels-verified");
		const { f } = await boundAt(
			native.NATIVE_BANK_CONFIG_PENDING,
			native.PREVIOUS_NATIVE_BANK_CONFIG,
		);
		f.db.transaction((tx) => {
			labels.markMemoryLabelsUnverified(tx, h.userId, f.bank.epoch);
			labels.markMemoryLabelsVerified(tx, h.userId, f.bank.epoch);
		});
		expect(labels.memoryLabelsVerified(h.userId)).toBe(true);
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(labels.memoryLabelsVerified(h.userId)).toBe(false);
	});

	it("marks them when a creation the previous release sent landed as config 1", async () => {
		const native = await import("./contracts");
		const { memoryLabelsVerified } = await import("./labels-verified");
		const { f } = await boundAt(
			native.NATIVE_BANK_CONFIG_PENDING,
			native.PREVIOUS_NATIVE_BANK_CONFIG,
		);
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(memoryLabelsVerified(h.userId)).toBe(false);
	});

	it("leaves them verified for a bank created at config 2", async () => {
		const { memoryLabelsVerified } = await import("./labels-verified");
		const f = await setup();
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(memoryLabelsVerified(h.userId)).toBe(true);
	});

	it("verifies a bank already on config 2 without a PATCH", async () => {
		const native = await import("./contracts");
		const { f, patches } = await boundAt(
			native.NATIVE_BANK_CONFIG_VERSION,
			native.nativeBankConfig("personal"),
		);
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(patches()).toHaveLength(0);
	});

	it("refuses a bank on config 2 whose live config is another kind's", async () => {
		const native = await import("./contracts");
		const { f, patches } = await boundAt(
			native.NATIVE_BANK_CONFIG_VERSION,
			native.nativeBankConfig("project"),
		);
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()).toMatchObject(
			{ errorCode: "native_config_mismatch" },
		);
		expect(patches()).toHaveLength(0);
	});

	it("settles a creation the previous release left pending, then upgrades it", async () => {
		const native = await import("./contracts");
		const { f, state, patches } = await boundAt(
			native.NATIVE_BANK_CONFIG_PENDING,
			native.PREVIOUS_NATIVE_BANK_CONFIG,
		);
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(patches()).toHaveLength(1);
		expect(state.versionAtPatch).toBe(native.HINDSIGHT_ENGINE_COMMIT);
		expect(
			f.db.select().from(f.schema.memoryBanks).get()?.nativeConfigVersion,
		).toBe(native.NATIVE_BANK_CONFIG_VERSION);
	});

	/** The first upgrade PATCH is lost before Hindsight reads it. */
	async function lostUpgrade() {
		const native = await import("./contracts");
		const bound = await boundAt(
			native.HINDSIGHT_ENGINE_COMMIT,
			native.PREVIOUS_NATIVE_BANK_CONFIG,
		);
		const upgrading = bound.f.fetcher.getMockImplementation();
		if (!upgrading) throw Error("fixture");
		let lose = true;
		bound.f.fetcher.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/config") && init?.method === "PATCH" && lose) {
				lose = false;
				throw Error("synthetic loss before native received the request");
			}
			return upgrading(url, init);
		});
		return { ...bound, native };
	}

	it("sends an upgrade again when its PATCH did not land, until it does", async () => {
		const { f, patches, native } = await lostUpgrade();
		await f.enqueue();
		vi.useFakeTimers({ toFake: ["Date"] });
		for (let i = 0; i < 3; i++) {
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			vi.setSystemTime(Date.now() + 16000);
		}
		expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()?.status).toBe(
			"succeeded",
		);
		expect(patches()).toHaveLength(2);
		expect(
			f.db.select().from(f.schema.memoryBanks).get()?.nativeConfigVersion,
		).toBe(native.NATIVE_BANK_CONFIG_VERSION);
	});

	it("a reset deletes a bank whose upgrade did not land", async () => {
		const { f } = await lostUpgrade();
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		await f.jobs.prepareNativeMemoryErasure(h.userId);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const cleanup = f.db
			.select()
			.from(f.schema.memoryDeliveryJobs)
			.all()
			.find((job) => job.kind === "cleanup");
		expect(cleanup?.status).toBe("succeeded");
		expect(
			f.fetcher.mock.calls.filter(
				([url, init]) =>
					init?.method === "DELETE" && !String(url).includes("/documents/"),
			),
		).toHaveLength(1);
	});
});

it("does not treat an older bound but unversioned configuration as settled", async () => {
	const f = await setup();
	const { NATIVE_BANK_CONFIG_LEGACY_UNKNOWN } = await import("./contracts");
	f.db
		.update(f.schema.memoryBanks)
		.set({
			nativeBaseUrl: "http://synthetic",
			nativeCredentialHash: "synthetic-hash",
		})
		.run();
	await f.jobs.prepareNativeMemoryErasure(h.userId);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.db.select().from(f.schema.memoryDeliveryJobs).get()).toMatchObject({
		kind: "cleanup",
		status: "queued",
		errorCode: "native_config_unconfirmed",
		nativeOperationIdsJson: JSON.stringify([NATIVE_BANK_CONFIG_LEGACY_UNKNOWN]),
	});
	expect(f.fetcher).not.toHaveBeenCalled();
});

type Fixture = Awaited<ReturnType<typeof setup>>;
type RetainEnd = "completed" | "failed" | "cancelled";

/**
 * A Hindsight whose retain operations end as the test says. A POST of an
 * operation ID it already knows changes nothing (it is idempotent on
 * `operation_id`), an ID it has never seen is `not_found`, and what a completed
 * retain wrote is listed from then on.
 */
function fakeRetains(
	f: Fixture,
	options: {
		/** How the nth new operation ends. Completed unless said. */
		endOf?: (nth: number) => RetainEnd;
		/** Operations that exist before the test starts. */
		known?: Record<string, RetainEnd>;
		/** A failed operation left a fact under the document. */
		leftBehind?: boolean;
		/** Answer an operation it has never seen with a 404, not a `not_found` status. */
		unknownIs404?: boolean;
		/** Runs as a POST arrives, before Hindsight answers it. */
		onPost?: (operationId: string) => void;
		/** Runs as the facts are listed. */
		onList?: () => void;
		/** Until a retain completes, the bank holds one fact, under another document. */
		otherDocument?: boolean;
	} = {},
) {
	const original = f.fetcher.getMockImplementation();
	if (!original) throw new Error("Missing fixture fetch");
	const operations = new Map<string, string>(
		Object.entries(options.known ?? {}),
	);
	const calls: string[] = [];
	const bodies: Array<{
		operation_id: string;
		items: Array<Record<string, unknown>>;
	}> = [];
	let created = 0;
	f.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.endsWith("/memories") && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			calls.push(`POST ${body.operation_id}`);
			bodies.push(body);
			options.onPost?.(body.operation_id);
			if (!operations.has(body.operation_id))
				operations.set(
					body.operation_id,
					options.endOf?.(created++) ?? "completed",
				);
			return new Response(JSON.stringify({ operation_id: body.operation_id }));
		}
		if (path.includes("/operations/")) {
			const id = decodeURIComponent(path.split("/operations/")[1]);
			if (id === "consolidate-op") return original(url, init);
			calls.push(`GET ${id}`);
			if (options.unknownIs404 && !operations.has(id))
				return new Response("missing", { status: 404 });
			return new Response(
				JSON.stringify({ status: operations.get(id) ?? "not_found" }),
			);
		}
		if (path.includes("/memories/list")) {
			options.onList?.();
			if (
				!options.leftBehind &&
				![...operations.values()].includes("completed")
			)
				return new Response(
					JSON.stringify(
						options.otherDocument
							? {
									total: 1,
									offset: 0,
									items: [
										{
											id: "other-fact",
											text: "Another chat's fact",
											fact_type: "world",
											consolidated_at: "2026-11-18T00:00:00Z",
											document_id: "another-source",
										},
									],
								}
							: { total: 0, offset: 0, items: [] },
					),
				);
		}
		return original(url, init);
	});
	return {
		calls,
		bodies,
		posted: () => bodies.map((body) => body.operation_id),
		/** Hindsight forgets an operation, as it does once a receipt expires. */
		forget: (id: string) => operations.delete(id),
	};
}

describe("Memory delivery when Hindsight reports a retain failed", () => {
	const revision = (f: Fixture) =>
		f.db.select().from(f.schema.memorySourceRevisions).get();
	const job = (f: Fixture) =>
		f.db.select().from(f.schema.memoryDeliveryJobs).get();
	/** What the release before the resubmission left: sent, never acknowledged, the job failed for good. */
	async function failedByEarlierRelease(f: Fixture) {
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({ nativeSubmitted: true })
			.run();
		const queued = await f.enqueue();
		f.db
			.update(f.schema.memoryDeliveryJobs)
			.set({
				status: "failed",
				errorCode: "native_operation_failed",
				errorMessage: "Memory preparation could not complete.",
				retryable: false,
				attemptCount: 3,
			})
			.run();
		return queued.row.id;
	}
	const reopen = (f: Fixture, jobId: string) =>
		h.engine.reopen(f.jobs.memoryDeliveryJob, jobId, {
			userId: h.userId,
			from: ["failed"],
		});
	/**
	 * Drains, lets the one-minute hold-back before a resubmission pass, and
	 * drains again. Needs `vi.useFakeTimers({ toFake: ["Date"] })`.
	 */
	async function drainPastHoldBack(f: Fixture) {
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		vi.setSystemTime(Date.now() + 61_000);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
	}
	const ended = (f: Fixture) =>
		JSON.parse(revision(f)?.context ?? "{}").nativeRetainEnded;

	it("holds a failed retain back a minute, then resubmits it once under a new operation ID", async () => {
		const f = await setup();
		vi.useFakeTimers({ toFake: ["Date"] });
		const fake = fakeRetains(f, {
			endOf: (nth) => (nth === 0 ? "failed" : "completed"),
		});
		await f.enqueue();
		const failedAt = Date.now();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		// S1: nothing is rotated or sent until the refusal that failed it has had a minute to pass.
		expect(fake.posted()).toEqual([f.source.nativeOperationId]);
		expect(job(f)).toMatchObject({
			status: "queued",
			errorCode: "native_retain_resubmit_due",
			retryable: true,
		});
		// run_after is kept in whole seconds.
		expect(job(f)?.runAfter?.getTime()).toBeGreaterThanOrEqual(
			Math.floor((failedAt + 60_000) / 1000) * 1000,
		);
		expect(revision(f)).toMatchObject({
			nativeOperationId: f.source.nativeOperationId,
			context: "User statement",
		});
		vi.setSystemTime(Date.now() + 61_000);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const [failed, fresh] = fake.posted();
		expect(fake.posted()).toHaveLength(2);
		expect(fresh).not.toBe(failed);
		// The same source goes out again: only its operation ID is new.
		expect(fake.bodies[1].items).toEqual(fake.bodies[0].items);
		expect(job(f)).toMatchObject({ status: "succeeded", attemptCount: 2 });
		// The hold-back was a wait: no attempt of the job's three was spent on it.
		const { parseDeliveryRetryState } = await import("./delivery-policy");
		expect(
			parseDeliveryRetryState(JSON.parse(job(f)?.retryState ?? "null")).waits,
		).toBe(1);
		expect(revision(f)).toMatchObject({
			state: "accepted",
			nativeAcknowledged: true,
			nativeOperationId: fresh,
		});
		expect(JSON.parse(revision(f)?.context ?? "")).toEqual({
			nativeRetainResubmittedFrom: failed,
		});
	});

	it("ends for good when the resubmitted retain fails too, and records that end", async () => {
		const f = await setup();
		vi.useFakeTimers({ toFake: ["Date"] });
		const fake = fakeRetains(f, { endOf: () => "failed" });
		await f.enqueue();
		await drainPastHoldBack(f);
		expect(fake.posted()).toHaveLength(2);
		// N1: its own code, so an operator never mistakes a failed consolidation for it.
		expect(job(f)).toMatchObject({
			status: "failed",
			errorCode: "native_retain_resubmit_failed",
			retryable: false,
			attemptCount: 2,
		});
		expect(revision(f)).toMatchObject({
			nativeSubmitted: true,
			nativeAcknowledged: false,
			nativeOperationId: fake.posted()[1],
		});
		// S2: the end is on the revision, whatever Hindsight later remembers.
		expect(ended(f)).toEqual({
			operationId: fake.posted()[1],
			reason: "resubmit_failed",
		});
	});

	it.each(["remembers", "has forgotten"])(
		"sends no third operation when that failed job is reopened and Hindsight %s the resubmitted one",
		async (memory) => {
			const f = await setup();
			vi.useFakeTimers({ toFake: ["Date"] });
			const fake = fakeRetains(f, { endOf: () => "failed" });
			const queued = await f.enqueue();
			await drainPastHoldBack(f);
			expect(job(f)?.status).toBe("failed");
			if (memory === "has forgotten") fake.forget(fake.posted()[1]);
			const callsBefore = fake.calls.length;
			await reopen(f, queued.row.id);
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			expect(job(f)).toMatchObject({
				status: "failed",
				errorCode: "native_retain_resubmit_failed",
			});
			// S2: the recorded end decides before Hindsight is asked anything.
			expect(fake.calls.slice(callsBefore)).toEqual([]);
			expect(new Set(fake.posted()).size).toBe(2);
			expect(fake.posted()).toHaveLength(2);
			expect(revision(f)?.nativeOperationId).toBe(fake.posted()[1]);
		},
	);

	it("resubmits although the bank holds another document's facts", async () => {
		const f = await setup();
		vi.useFakeTimers({ toFake: ["Date"] });
		const fake = fakeRetains(f, {
			endOf: (nth) => (nth === 0 ? "failed" : "completed"),
			otherDocument: true,
		});
		await f.enqueue();
		await drainPastHoldBack(f);
		// N2: only a fact under this source's own document stops the resubmission.
		expect(fake.posted()).toHaveLength(2);
		expect(job(f)?.status).toBe("succeeded");
	});

	it("accepts a sent retain Hindsight reports completed without sending it again", async () => {
		const f = await setup();
		const id = f.source.nativeOperationId as string;
		const fake = fakeRetains(f, { known: { [id]: "completed" } });
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({ nativeSubmitted: true })
			.run();
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		// N3: the answer to the GET is enough; no POST of a finished operation.
		expect(fake.calls).toEqual([`GET ${id}`]);
		expect(fake.posted()).toEqual([]);
		expect(job(f)?.status).toBe("succeeded");
		expect(revision(f)).toMatchObject({
			state: "accepted",
			nativeAcknowledged: true,
		});
	});

	it("stays terminal when the failed operation left a fact under the document", async () => {
		const f = await setup();
		vi.useFakeTimers({ toFake: ["Date"] });
		const fake = fakeRetains(f, { endOf: () => "failed", leftBehind: true });
		await f.enqueue();
		await drainPastHoldBack(f);
		expect(fake.posted()).toEqual([f.source.nativeOperationId]);
		expect(job(f)).toMatchObject({
			status: "failed",
			errorCode: "native_retain_left_facts",
			retryable: false,
		});
		// Nothing was rotated: only the end is recorded (S2).
		expect(revision(f)?.nativeOperationId).toBe(f.source.nativeOperationId);
		expect(JSON.parse(revision(f)?.context ?? "{}")).toEqual({
			nativeRetainEnded: {
				operationId: f.source.nativeOperationId,
				reason: "facts_left_behind",
			},
		});
	});

	it("resubmits once for a job reopened after the earlier release failed it", async () => {
		const f = await setup();
		const failed = f.source.nativeOperationId as string;
		const fake = fakeRetains(f, { known: { [failed]: "failed" } });
		const jobId = await failedByEarlierRelease(f);
		await reopen(f, jobId);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		// The failed operation is not sent again: one new ID goes out, and completes.
		expect(fake.posted()).toHaveLength(1);
		expect(fake.posted()[0]).not.toBe(failed);
		expect(job(f)?.status).toBe("succeeded");
		expect(revision(f)).toMatchObject({
			state: "accepted",
			nativeAcknowledged: true,
			nativeOperationId: fake.posted()[0],
		});
	});

	it("never resubmits twice when the process dies after the new ID is stored and before it is sent", async () => {
		const f = await setup();
		const failed = f.source.nativeOperationId as string;
		let stored: { id: string | null; context: string } | undefined;
		const fake = fakeRetains(f, {
			endOf: (nth) => (nth === 0 ? "failed" : "completed"),
			onPost: (operationId) => {
				if (operationId === failed || stored) return;
				const current = revision(f);
				stored = {
					id: current?.nativeOperationId ?? null,
					context: current?.context ?? "",
				};
				throw Error("The process died as the call went out");
			},
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		await f.enqueue();
		await drainPastHoldBack(f);
		// The new ID and the marker were already committed when the call went out.
		expect(stored?.id).toBeTruthy();
		expect(stored?.id).not.toBe(failed);
		expect(JSON.parse(stored?.context ?? "")).toEqual({
			nativeRetainResubmittedFrom: failed,
		});
		expect(job(f)).toMatchObject({ status: "queued", retryable: true });
		vi.setSystemTime(Date.now() + 61000);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(job(f)?.status).toBe("succeeded");
		expect(fake.posted()).toEqual([failed, stored?.id, stored?.id]);
		expect(revision(f)?.nativeOperationId).toBe(stored?.id);
	});

	it.each(["first attempt", "reopened job"])(
		"keeps a cancelled operation terminal (%s)",
		async (when) => {
			const f = await setup();
			const failed = f.source.nativeOperationId as string;
			const fake = fakeRetains(
				f,
				when === "first attempt"
					? { endOf: () => "cancelled" }
					: { known: { [failed]: "cancelled" } },
			);
			if (when === "first attempt") await f.enqueue();
			else await reopen(f, await failedByEarlierRelease(f));
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			// N3: a reopened job asks first and sends nothing to a cancelled operation.
			expect(fake.posted()).toEqual(when === "first attempt" ? [failed] : []);
			expect(job(f)).toMatchObject({
				status: "failed",
				errorCode: "native_retain_cancelled",
				retryable: false,
			});
			expect(revision(f)?.nativeOperationId).toBe(failed);
			expect(ended(f)).toEqual({ operationId: failed, reason: "cancelled" });
		},
	);

	it("does not resubmit a source withdrawn while its failed operation is checked", async () => {
		const f = await setup();
		const failed = f.source.nativeOperationId as string;
		const fake = fakeRetains(f, {
			endOf: () => "failed",
			onList: () => f.rev.revokeMemorySources(h.userId, [f.source.id]),
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		await f.enqueue();
		await drainPastHoldBack(f);
		expect(fake.posted()).toEqual([failed]);
		expect(job(f)?.status).toBe("failed");
		expect(revision(f)).toMatchObject({
			state: "revoked",
			nativeOperationId: failed,
			context: "User statement",
		});
	});

	it.each([
		{ sent: false, acknowledged: false, first: "POST" },
		// Acknowledged: the retain finished, and nothing about it is sent or asked again.
		{ sent: true, acknowledged: true, first: null },
		{ sent: true, acknowledged: false, first: "GET" },
	])(
		"asks about the operation first only for a sent, unacknowledged retain, and never sends an acknowledged one (sent $sent, acknowledged $acknowledged)",
		async ({ sent, acknowledged, first }) => {
			const f = await setup();
			const id = f.source.nativeOperationId as string;
			const fake = fakeRetains(f, { known: sent ? { [id]: "completed" } : {} });
			f.db
				.update(f.schema.memorySourceRevisions)
				.set({ nativeSubmitted: sent, nativeAcknowledged: acknowledged })
				.run();
			await f.enqueue();
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			expect(fake.calls[0] ?? null).toBe(first && `${first} ${id}`);
			expect(job(f)?.status).toBe("succeeded");
			expect(revision(f)?.nativeOperationId).toBe(id);
		},
	);

	it("never sends an acknowledged retain again, even once Hindsight has forgotten its operation", async () => {
		const f = await setup();
		const id = f.source.nativeOperationId as string;
		// Hindsight no longer knows the operation: a POST would retain the source anew.
		const fake = fakeRetains(f);
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({ nativeSubmitted: true, nativeAcknowledged: true })
			.run();
		await f.enqueue();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(fake.posted()).toEqual([]);
		expect(fake.calls).toEqual([]);
		expect(job(f)?.status).toBe("succeeded");
		expect(revision(f)).toMatchObject({
			state: "accepted",
			nativeOperationId: id,
		});
	});

	it.each(["a not_found status", "a 404"])(
		"sends a retry's own ID again when Hindsight does not know the operation yet (%s)",
		async (answer) => {
			const f = await setup();
			const id = f.source.nativeOperationId as string;
			const fake = fakeRetains(f, { unknownIs404: answer === "a 404" });
			f.db
				.update(f.schema.memorySourceRevisions)
				.set({ nativeSubmitted: true })
				.run();
			await f.enqueue();
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			expect(fake.calls.slice(0, 2)).toEqual([`GET ${id}`, `POST ${id}`]);
			expect(job(f)?.status).toBe("succeeded");
			expect(revision(f)).toMatchObject({
				nativeOperationId: id,
				context: "User statement",
			});
		},
	);

	it("does not resubmit while a removal still has to clean up the bank", async () => {
		const f = await setup();
		const failed = f.source.nativeOperationId as string;
		const fake = fakeRetains(f, {
			endOf: () => "failed",
			onList: () =>
				f.db
					.insert(f.schema.memoryActions)
					.values({
						id: "pending-removal",
						userId: h.userId,
						bankId: f.bank.id,
						epoch: 0,
						requestId: "pending-removal",
						kind: "remove",
						exclusionAcknowledged: true,
						cleanupPending: true,
						intentJson: JSON.stringify({ sourceIds: [] }),
					})
					.onConflictDoNothing()
					.run(),
		});
		vi.useFakeTimers({ toFake: ["Date"] });
		await f.enqueue();
		await drainPastHoldBack(f);
		expect(fake.posted()).toEqual([failed]);
		expect(job(f)).toMatchObject({
			status: "queued",
			errorCode: "memory_curation_publication_held",
		});
		expect(revision(f)).toMatchObject({
			nativeOperationId: failed,
			context: "User statement",
		});
	});

	describe("with a real chat context envelope", () => {
		/**
		 * The source as a chat delivers it: the envelope chat-delivery.ts writes,
		 * with the assistant's reply as context, in a real conversation.
		 */
		async function chatSource(f: Fixture) {
			const { memoryTextHash } = await import("./revisions");
			f.db
				.insert(f.schema.conversations)
				.values({ id: "chat", userId: h.userId, title: "Synthetic chat" })
				.run();
			f.db
				.insert(f.schema.messages)
				.values([
					{
						id: "user-message",
						conversationId: "chat",
						role: "user",
						content: "My kayak is green",
						messageSequence: 1,
					},
					{
						id: "reply",
						conversationId: "chat",
						role: "assistant",
						content: "A green kayak sounds lovely.",
						messageSequence: 2,
					},
				])
				.run();
			const envelope = {
				messageSequence: 1,
				conversationId: "chat",
				sourceRole: "user",
				guidance:
					"Only the source user message is a new assertion. Other messages are context for attribution and dependent replies; assistant claims are not user facts.",
				messages: [
					{
						id: "reply",
						role: "assistant",
						sourceId: "$current",
						textHash: memoryTextHash("My kayak is green"),
						messageTextHash: memoryTextHash("A green kayak sounds lovely."),
					},
				],
			};
			f.db
				.update(f.schema.memorySourceRevisions)
				.set({
					conversationId: "chat",
					messageId: "user-message",
					context: JSON.stringify(envelope),
				})
				.run();
			return envelope;
		}

		it("keeps every key of the envelope through a resubmission and adds only its marker", async () => {
			const f = await setup();
			const envelope = await chatSource(f);
			vi.useFakeTimers({ toFake: ["Date"] });
			const fake = fakeRetains(f, {
				endOf: (nth) => (nth === 0 ? "failed" : "completed"),
			});
			await f.enqueue();
			await drainPastHoldBack(f);
			expect(job(f)?.status).toBe("succeeded");
			const [failed] = fake.posted();
			expect(JSON.parse(revision(f)?.context ?? "{}")).toEqual({
				...envelope,
				nativeRetainResubmittedFrom: failed,
			});
		});

		it("sends the same context both times, the reply included, and never the marker", async () => {
			const f = await setup();
			await chatSource(f);
			vi.useFakeTimers({ toFake: ["Date"] });
			const fake = fakeRetains(f, {
				endOf: (nth) => (nth === 0 ? "failed" : "completed"),
			});
			await f.enqueue();
			await drainPastHoldBack(f);
			const [first, second] = fake.bodies.map(
				(body) => body.items[0].context as string,
			);
			expect(second).toBe(first);
			// The resolved context is real: the assistant's reply reached Hindsight.
			expect(first).toContain("A green kayak sounds lovely.");
			expect(first).not.toContain("nativeRetain");
		});

		it("records a cancelled retain's end without losing the envelope", async () => {
			const f = await setup();
			const envelope = await chatSource(f);
			fakeRetains(f, { endOf: () => "cancelled" });
			await f.enqueue();
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			expect(job(f)?.errorCode).toBe("native_retain_cancelled");
			expect(JSON.parse(revision(f)?.context ?? "{}")).toEqual({
				...envelope,
				nativeRetainEnded: {
					operationId: f.source.nativeOperationId,
					reason: "cancelled",
				},
			});
		});
	});

	describe("for what else reads the operation ID of a resubmitted retain", () => {
		const fresh = "d4b6f0a2-3c1e-4b7a-9d52-6a8e1f3c7b90";
		/** A source whose retain was resubmitted and whose process died before it was acknowledged. */
		function resubmittedAndUnacknowledged(f: Fixture) {
			f.db
				.update(f.schema.memorySourceRevisions)
				.set({
					nativeSubmitted: true,
					nativeOperationId: fresh,
					context: JSON.stringify({
						nativeRetainResubmittedFrom: f.source.nativeOperationId,
					}),
				})
				.run();
		}

		it("settles the new operation, never the failed one, before cleaning up a withdrawn source", async () => {
			const f = await setup();
			const failed = f.source.nativeOperationId as string;
			const fake = fakeRetains(f, { known: { [fresh]: "completed" } });
			const inner = f.fetcher.getMockImplementation();
			if (!inner) throw new Error("Missing fixture fetch");
			f.fetcher.mockImplementation(async (url, init) =>
				String(url).includes("/memories/list")
					? new Response(JSON.stringify({ items: [], total: 0, offset: 0 }))
					: inner(url, init),
			);
			resubmittedAndUnacknowledged(f);
			f.rev.revokeMemorySources(h.userId, [f.source.id]);
			f.db.update(f.schema.users).set({ memoryEnabled: false }).run();
			await f.jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source_cleanup",
				sourceId: f.source.id,
				requestId: "cleanup",
			});
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			expect(job(f)?.status).toBe("succeeded");
			expect(fake.calls).toEqual([`GET ${fresh}`]);
			expect(fake.calls).not.toContain(`GET ${failed}`);
			expect(
				f.fetcher.mock.calls.some(
					([url, init]) =>
						String(url).endsWith(`/documents/${f.source.id}`) &&
						init?.method === "DELETE",
				),
			).toBe(true);
		});

		it("does not wait on a retain whose end is recorded, even once Hindsight has forgotten it", async () => {
			const f = await setup();
			const ended = f.source.nativeOperationId as string;
			// Hindsight no longer knows the ended operation: asking about it would be unanswerable.
			const fake = fakeRetains(f);
			f.db
				.update(f.schema.memorySourceRevisions)
				.set({
					nativeSubmitted: true,
					context: JSON.stringify({
						nativeRetainEnded: {
							operationId: ended,
							reason: "resubmit_failed",
						},
					}),
				})
				.run();
			const other = f.rev.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				eventId: "other-event",
				lineageId: "other-message",
				text: "My oar is red",
				context: "User statement",
				assertedAt: new Date("2026-11-19"),
			});
			await f.jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source",
				sourceId: other.id,
				requestId: "other-request",
			});
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			// The other chat's retain goes out; the ended one is never asked about.
			expect(fake.calls).toContain(`POST ${other.nativeOperationId}`);
			expect(fake.calls).not.toContain(`GET ${ended}`);
		});

		it("waits for the new operation, never the failed one, before another source of the bank is sent", async () => {
			const f = await setup();
			const failed = f.source.nativeOperationId as string;
			const fake = fakeRetains(f, { known: { [fresh]: "completed" } });
			resubmittedAndUnacknowledged(f);
			const other = f.rev.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				eventId: "other-event",
				lineageId: "other-message",
				text: "My oar is red",
				context: "User statement",
				assertedAt: new Date("2026-11-19"),
			});
			await f.jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source",
				sourceId: other.id,
				requestId: "other-request",
			});
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			const sentOther = fake.calls.indexOf(`POST ${other.nativeOperationId}`);
			expect(sentOther).toBeGreaterThan(-1);
			expect(fake.calls.slice(0, sentOther)).toEqual([`GET ${fresh}`]);
			expect(fake.calls).not.toContain(`GET ${failed}`);
		});
	});
});

/**
 * A Hindsight that takes its time, on a faked clock: every status read of an
 * operation moves the clock on by `stepMs`, and an operation is done once the
 * clock passes its time. The pending list shows the consolidation while it runs.
 */
function slowHindsight(
	f: Fixture,
	options: {
		stepMs: number;
		retainDoneAt: number;
		consolidationDoneAt: number;
	},
) {
	const original = f.fetcher.getMockImplementation();
	if (!original) throw new Error("Missing fixture fetch");
	const posted: string[] = [];
	let consolidations = 0;
	const status = (id: string) =>
		id.startsWith("slow-consolidation")
			? Date.now() >= options.consolidationDoneAt
				? "completed"
				: "processing"
			: Date.now() >= options.retainDoneAt
				? "completed"
				: "processing";
	f.fetcher.mockImplementation(async (url, init) => {
		const path = String(url);
		if (path.endsWith("/memories") && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			posted.push(body.operation_id);
			return new Response(JSON.stringify({ operation_id: body.operation_id }));
		}
		if (path.endsWith("/consolidate"))
			return new Response(
				JSON.stringify({
					operation_id: `slow-consolidation-${++consolidations}`,
				}),
			);
		if (path.includes("/operations?")) {
			const running = [...Array(consolidations).keys()]
				.map((n) => `slow-consolidation-${n + 1}`)
				.filter((id) => status(id) !== "completed");
			return new Response(
				JSON.stringify({
					operations: path.includes("status=processing")
						? running.map((id) => ({ id, status: "processing" }))
						: [],
				}),
			);
		}
		if (path.includes("/operations/")) {
			const id = decodeURIComponent(path.split("/operations/")[1]);
			vi.setSystemTime(Date.now() + options.stepMs);
			return new Response(JSON.stringify({ status: status(id) }));
		}
		return original(url, init);
	});
	return { posted };
}

describe("Memory delivery waits for Hindsight without spending attempts", () => {
	const job = (f: Fixture) =>
		f.db.select().from(f.schema.memoryDeliveryJobs).get();
	/** Drains, moving the clock past each requeue's delay, until the job settles. */
	async function untilSettled(f: Fixture, rounds = 40) {
		const seen: Array<{ status: string; code: string | null }> = [];
		for (let i = 0; i < rounds; i++) {
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			const row = job(f);
			if (!row) throw new Error("Missing job");
			seen.push({ status: row.status, code: row.errorCode });
			if (row.status === "succeeded" || row.status === "failed") return seen;
			vi.setSystemTime(Date.now() + 61_000);
		}
		throw new Error("The job never settled");
	}

	it("keeps waiting while Hindsight works on a retain, past the attempt limit, and then delivers", async () => {
		const f = await setup();
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		const fake = slowHindsight(f, {
			stepMs: 3 * 60_000,
			retainDoneAt: start + 27 * 60_000,
			consolidationDoneAt: 0,
		});
		await f.enqueue();
		const seen = await untilSettled(f);
		expect(seen.at(-1)).toEqual({ status: "succeeded", code: null });
		// Every handback was a wait, never a failure.
		expect(
			seen.slice(0, -1).every((s) => s.code === "native_retain_waiting"),
		).toBe(true);
		const row = job(f);
		const { NATIVE_DELIVERY_ATTEMPT_LIMIT } = await import("./contracts");
		expect(row?.attemptCount).toBeGreaterThan(NATIVE_DELIVERY_ATTEMPT_LIMIT);
		// The one operation was sent again only under its own ID.
		expect(new Set(fake.posted)).toEqual(new Set([f.source.nativeOperationId]));
	});

	it("acceptance: under a busy model no delivery ends native_operation_timeout while Hindsight works, and waiting spends no attempt", async () => {
		const f = await setup();
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		// The model is held busy: the retain takes 20 minutes and the consolidation
		// another 40, each well past the old 180-second wait.
		slowHindsight(f, {
			stepMs: 4 * 60_000,
			retainDoneAt: start + 20 * 60_000,
			consolidationDoneAt: start + 60 * 60_000,
		});
		await f.enqueue();
		const seen: Array<{ status: string; code: string | null }> = [];
		for (let round = 0; round < 60; round++) {
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			const row = job(f);
			if (!row) throw new Error("Missing job");
			seen.push({ status: row.status, code: row.errorCode });
			if (row.status !== "queued") break;
			vi.setSystemTime(Date.now() + 61_000);
		}
		expect(seen.at(-1)).toEqual({ status: "succeeded", code: null });
		// Never failed, never timed out: every handback was a wait on Hindsight.
		expect(seen.some((s) => s.code === "native_operation_timeout")).toBe(false);
		expect(seen.some((s) => s.status === "failed")).toBe(false);
		expect(new Set(seen.slice(0, -1).map((s) => s.code))).toEqual(
			new Set(["native_retain_waiting", "native_consolidation_waiting"]),
		);
		const row = job(f);
		const { parseDeliveryRetryState } = await import("./delivery-policy");
		const waits = parseDeliveryRetryState(
			JSON.parse(row?.retryState ?? "null"),
		).waits;
		// Every attempt but the one that finished was a wait: none was counted.
		expect((row?.attemptCount ?? 0) - waits).toBe(1);
	}, 60_000);

	it("ends a delivery native_operation_timeout only once the consolidation's whole wait has passed", async () => {
		const f = await setup();
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		slowHindsight(f, {
			stepMs: 6 * 60_000,
			retainDoneAt: 0,
			consolidationDoneAt: Number.POSITIVE_INFINITY,
		});
		await f.enqueue();
		const seen = await untilSettled(f);
		const last = seen.at(-1);
		expect(last).toEqual({
			status: "failed",
			code: "native_operation_timeout",
		});
		expect(job(f)?.retryable).toBe(true);
		// The default consolidation wait is an hour: nothing ended before it.
		expect(Date.now() - start).toBeGreaterThanOrEqual(60 * 60_000);
		expect(
			seen.slice(0, -1).every((s) => s.code === "native_consolidation_waiting"),
		).toBe(true);
	});
});
