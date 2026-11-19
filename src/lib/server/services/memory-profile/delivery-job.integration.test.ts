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
				data = { config: native.NATIVE_BANK_CONFIG };
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
		const identities: string[] = [];
		f.fetcher.mockImplementation(async (url, init) => {
			if (String(url).endsWith("/memories") && init?.method === "POST") {
				identities.push(JSON.parse(String(init.body)).operation_id);
				if (failures-- > 0)
					return new Response("lost acknowledgement", { status: 503 });
			}
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
	const { NATIVE_BANK_CONFIG } = await import("./contracts");
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
							config: exactConfigVisible ? NATIVE_BANK_CONFIG : {},
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
