import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";
import { withDatedNativeFacts } from "./curation.test-support";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-dependency-repair");
});
afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});
async function fixture() {
	const { db } = await import("$lib/server/db");
	const s = await import("$lib/server/db/schema");
	const r = await import("./revisions");
	const bank = r.ensureMemoryBank(h.userId, { kind: "personal" });
	db.update(s.memoryAccounts).set({ authority: "hindsight" }).run();
	let n = 0;
	function source(parents: string[] = [], text = "I enjoy hiking") {
		const id = String(++n);
		const row = r.recordMemorySource({
			userId: h.userId,
			bankId: bank.id,
			epoch: 0,
			eventId: id,
			lineageId: id,
			text,
			context: JSON.stringify({
				messages: parents.map((sourceId) => ({
					id: sourceId,
					sourceId,
					role: "user",
				})),
			}),
			assertedAt: new Date("2026-01-01"),
		});
		db.update(s.memorySourceRevisions)
			.set({
				state: "accepted",
				nativeSubmitted: true,
				nativeAcknowledged: true,
			})
			.where(awaitEq(s.memorySourceRevisions.id, row.id))
			.run();
		return row;
	}
	return { db, s, r, bank, source };
}

import { eq as awaitEq } from "drizzle-orm";

/** What each fake bank was last configured with. */
const fakeBankConfigs = new Map<string, unknown>();

it.each([false, true])(
	"recovers an independent reply after late context withdrawal (sibling cleanup: %s)",
	async (siblingCleanup) => {
		const f = await nativeFixture();
		const root = f.source([], "I planted a maple tree.");
		const context = f.source(
			[],
			"My old private collection was named RUSTFINCH.",
		);
		const reply = f.source(
			[root.id, context.id],
			"I keep a community seed library.",
		);
		// The reply's own retain was resubmitted once and its end recorded: that
		// bookkeeping belongs to its operation, never to a replacement (N4).
		f.db
			.update(f.s.memorySourceRevisions)
			.set({
				context: JSON.stringify({
					...JSON.parse(reply.context),
					nativeRetainResubmittedFrom: "failed-operation",
					nativeRetainEnded: {
						operationId: "failed-operation",
						reason: "cancelled",
					},
				}),
			})
			.where(awaitEq(f.s.memorySourceRevisions.id, reply.id))
			.run();
		const survivor = f.source([], "My sister plays the bassoon.");
		for (const source of [root, context, reply, survivor]) f.seed(source);
		const { publishNativeSnapshot, readPublishedMemory } = await import(
			"./publication"
		);
		f.db.transaction((tx) =>
			publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: f.bank.epoch,
				expectedRevision: 0,
				memories: [
					...f.facts.values(),
					{
						id: `observation:fact:${context.id}`,
						fact_type: "observation",
						text: context.text,
						source_memory_ids: [`fact:${context.id}`],
					},
				],
			}),
		);
		let excluded = false;
		const forwarded: unknown[] = [];
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			async (_prompt, payload, _schema, _thinking, assertCurrent) => {
				if (!excluded) {
					if (siblingCleanup) await f.remove(context);
					else {
						f.r.revokeMemorySources(h.userId, [context.id]);
						f.facts.delete(context.id);
					}
					excluded = true;
				}
				assertCurrent?.();
				forwarded.push(payload);
				return { valid: true, issues: [] };
			},
		);
		await f.remove(root);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(excluded).toBe(true);
		const attempted = f.retained[0];
		expect(attempted?.items[0].context).toContain(context.text);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			for (let attempt = 0; attempt < 4; attempt++) {
				vi.setSystemTime(Date.now() + 60_000);
				await h.engine.drain(f.jobs.memoryDeliveryJob);
			}
		} finally {
			vi.useRealTimers();
		}
		expect(JSON.stringify(forwarded)).not.toContain("RUSTFINCH");
		const replacementRows = f.db
			.select()
			.from(f.s.memorySourceRevisions)
			.all()
			.filter(
				(row) => row.lineageId === reply.lineageId && row.id !== reply.id,
			);
		if (!siblingCleanup) expect(replacementRows.length).toBeGreaterThan(0);
		for (const row of replacementRows)
			expect(row.context).not.toContain("nativeRetain");
		const replacements = f.retained.slice(1);
		expect(replacements.length).toBeGreaterThan(0);
		expect(JSON.stringify(replacements)).not.toContain("RUSTFINCH");
		expect(f.deleted).toContain(attempted.items[0].document_id);
		if (!siblingCleanup) {
			expect(replacements).toHaveLength(1);
			expect(replacements[0].items[0].document_id).toBe(
				attempted.items[0].document_id,
			);
			expect(replacements[0].operation_id).not.toBe(attempted.operation_id);
		}
		expect(
			readPublishedMemory(h.userId, f.bank.id)
				.map(({ text }) => text)
				.sort(),
		).toEqual([reply.text, survivor.text].sort());
	},
);

it.each([
	"live carried parent",
	"physical parent withdrawn at dispatch",
	"physical parent withdrawn at publication",
	"missing logical tip",
	"ambiguous logical tip",
] as const)(
	"revalidates context-only carried facts through repair (%s)",
	async (mode) => {
		const f = await nativeFixture();
		const root = f.source([], "I planted a maple tree.");
		const parent = f.source(
			[],
			"My old private collection was named RUSTFINCH.",
		);
		const conversationId = "carried-context-chat";
		f.db
			.insert(f.s.conversations)
			.values({
				id: conversationId,
				title: "Synthetic context",
				userId: h.userId,
			})
			.run();
		f.db
			.update(f.s.memorySourceRevisions)
			.set({ conversationId, messageId: "retired-message" })
			.where(awaitEq(f.s.memorySourceRevisions.id, parent.id))
			.run();
		function recordTip(messageId: string, generation?: string) {
			f.db
				.insert(f.s.messages)
				.values({
					id: messageId,
					conversationId,
					role: "user",
					content: parent.text,
				})
				.run();
			const tip = f.r.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: f.bank.epoch,
				eventId: `message:${messageId}`,
				lineageId: parent.lineageId,
				text: parent.text,
				context: JSON.stringify({ carriedSourceIds: [parent.id] }),
				conversationId,
				messageId,
				predecessorSourceId: parent.id,
				assertedAt: parent.assertedAt,
			});
			f.db
				.update(f.s.memorySourceRevisions)
				.set({ state: "accepted", acceptedGeneration: generation })
				.where(awaitEq(f.s.memorySourceRevisions.id, tip.id))
				.run();
			return tip;
		}
		const tip = recordTip("live-tip");
		const reply = f.source(
			[root.id, tip.id],
			"I keep a community seed library.",
		);
		const survivor = f.source([], "My sister plays the bassoon.");
		for (const source of [root, parent, reply, survivor]) f.seed(source);
		const { publishNativeSnapshot, readPublishedMemory } = await import(
			"./publication"
		);
		const generation = f.db.transaction((tx) =>
			publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: f.bank.epoch,
				expectedRevision: 0,
				memories: [
					...f.facts.values(),
					{
						id: `observation:fact:${parent.id}`,
						fact_type: "observation",
						text: parent.text,
						source_memory_ids: [`fact:${parent.id}`],
					},
				],
			}),
		);
		let changed = false;
		let forwarded: unknown;
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			async (_prompt, payload, _schema, _thinking, assertCurrent) => {
				if (!changed) {
					if (mode === "physical parent withdrawn at dispatch")
						await f.remove(parent);
					else if (mode === "missing logical tip")
						f.db
							.delete(f.s.messages)
							.where(awaitEq(f.s.messages.id, "live-tip"))
							.run();
					else if (mode === "ambiguous logical tip")
						recordTip("competing-tip", generation);
					changed = true;
				}
				assertCurrent?.();
				forwarded = payload;
				if (mode === "physical parent withdrawn at publication")
					await f.remove(parent);
				return { valid: true, issues: [] };
			},
		);
		const work = await f.remove(root);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const result = f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, work.row.id))
			.get();
		expect(f.retained[0]?.items[0].context).toContain(parent.text);
		expect(changed).toBe(true);
		if (
			mode === "live carried parent" ||
			mode === "physical parent withdrawn at publication"
		)
			expect(forwarded).toMatchObject({
				source_assertions: [
					{ priorContext: expect.stringContaining(parent.text) },
				],
			});
		else expect(forwarded).toBeUndefined();
		if (mode === "live carried parent") {
			expect(result?.status).toBe("succeeded");
			expect(
				readPublishedMemory(h.userId, f.bank.id).map(({ text }) => text),
			).toContain(reply.text);
		} else {
			expect(result).toMatchObject({
				status: "queued",
				errorCode: "memory_dependency_context_changed",
			});
			expect(
				readPublishedMemory(h.userId, f.bank.id).map(({ text }) => text),
			).not.toContain(reply.text);
		}
	},
);

it("holds only exact direct and transitive dependents before any native work", async () => {
	const f = await fixture();
	const root = f.source();
	const direct = f.source([root.id]);
	const transitive = f.source([direct.id]);
	const unrelated = f.source();
	const { holdExplicitDependents } = await import("./dependency-plan");
	const found = f.db.transaction((tx) =>
		holdExplicitDependents(tx, h.userId, f.bank.id, 0, [root.id]),
	);
	expect(found.map((s) => s.id)).toEqual([direct.id, transitive.id]);
	const states = new Map(
		f.db
			.select()
			.from(f.s.memorySourceRevisions)
			.all()
			.map((s) => [s.id, s.state]),
	);
	expect(states.get(direct.id)).toBe("repair_held");
	expect(states.get(transitive.id)).toBe("repair_held");
	expect(states.get(unrelated.id)).toBe("accepted");
	expect(states.get(root.id)).toBe("accepted");
});
it("rejects a family larger than the finite bound atomically", async () => {
	const f = await fixture();
	const root = f.source();
	for (let i = 0; i < 65; i++) f.source([root.id]);
	const { holdExplicitDependents } = await import("./dependency-plan");
	expect(() =>
		f.db.transaction((tx) =>
			holdExplicitDependents(tx, h.userId, f.bank.id, 0, [root.id]),
		),
	).toThrow("memory_dependency_limit");
	expect(
		f.db
			.select()
			.from(f.s.memorySourceRevisions)
			.all()
			.every((s) => s.state === "accepted"),
	).toBe(true);
});

it("keeps internal observation receipts out of stored repair model inputs", async () => {
	const f = await fixture();
	const root = f.source();
	const reply = f.source([root.id], "I collect stamps.");
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			acknowledgedFactsJson: JSON.stringify([
				{
					id: "stamps",
					text: reply.text,
					admittedObservation: {
						support: "private-support",
						presentation: "private-presentation",
						timing: "private-timing",
					},
				},
			]),
		})
		.where(awaitEq(f.s.memorySourceRevisions.id, reply.id))
		.run();
	const { createDependencyRepairPlan } = await import("./dependency-plan");
	const plan = f.db.transaction((tx) =>
		createDependencyRepairPlan(tx, h.userId, f.bank.id, f.bank.epoch, [
			root.id,
		]),
	);
	expect(plan.originalFacts).toEqual([
		{ id: "stamps", text: reply.text, sourceId: reply.id },
	]);
});

it.each([
	{ withdrawn: false, unchanged: false },
	{ withdrawn: true, unchanged: false },
	{ withdrawn: true, unchanged: true },
])(
	"dependency replay dispatches a compound action only while every source is authorized (%j)",
	async ({ withdrawn, unchanged }) => {
		const f = await nativeFixture();
		const root = f.source([], "I planted a maple tree.");
		const live = f.source([root.id], "I also like model trains.");
		const marker = "My unrelated old marker was REEDFOX.";
		const sibling = f.source([], marker);
		for (const source of [root, live, sibling]) f.seed(source);
		if (unchanged) {
			f.db
				.insert(f.s.conversations)
				.values({ id: root.id, title: "Replayed chat", userId: h.userId })
				.run();
			f.db
				.insert(f.s.messages)
				.values({
					id: "old-root",
					conversationId: root.id,
					role: "user",
					content: root.text,
				})
				.run();
			f.db
				.update(f.s.memorySourceRevisions)
				.set({ conversationId: root.id, messageId: "old-root" })
				.where(awaitEq(f.s.memorySourceRevisions.id, root.id))
				.run();
		}
		const actionSource = unchanged ? root : live;
		const requestId = randomUUID();
		f.db
			.insert(f.s.memoryActions)
			.values({
				id: randomUUID(),
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "edit",
				requestId,
				generation: "before",
				rowId: "mixed",
				text: actionSource.text,
				previousText: `${actionSource.text} ${marker}`,
				intentJson: JSON.stringify({
					request: {
						kind: "edit",
						requestId,
						text: actionSource.text,
						ref: {
							scope: { kind: "personal" },
							generation: "before",
							rowId: "mixed",
						},
					},
					before: `${actionSource.text} ${marker}`,
					sourceIds: [actionSource.id, sibling.id],
					facts: [
						{
							id: `fact:${actionSource.id}`,
							text: actionSource.text,
							sourceId: actionSource.id,
						},
						{ id: `fact:${sibling.id}`, text: marker, sourceId: sibling.id },
					],
					outcome: "accepted",
					plan: {
						forget: [marker],
						replace: [],
						preserve: [actionSource.text],
					},
				}),
			})
			.run();
		if (withdrawn) {
			await f.remove(sibling);
			await h.engine.drain(f.jobs.memoryDeliveryJob);
		}
		if (unchanged) {
			const { publishNativeSnapshot } = await import("./publication");
			const authorized = [...f.facts.values()];
			f.db.transaction((tx) => {
				const bank = tx
					.select()
					.from(f.s.memoryBanks)
					.where(awaitEq(f.s.memoryBanks.id, f.bank.id))
					.get();
				if (!bank) throw Error("missing synthetic bank");
				publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: bank.id,
					epoch: bank.epoch,
					expectedRevision: bank.revision,
					memories: [
						...authorized,
						...authorized.map((fact) => ({
							id: `observation:${fact.id}`,
							fact_type: "observation" as const,
							text: fact.text,
							source_memory_ids: [fact.id],
						})),
					],
				});
			});
		}
		const payloads: unknown[] = [];
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			vi.fn(async (_prompt, payload) => {
				payloads.push(payload);
				const input = payload as {
					facts?: Array<{ id: string; text: string }>;
				};
				if (input.facts)
					return {
						facts: input.facts.map((fact) =>
							fact.text === marker ? { ...fact, text: "" } : fact,
						),
					};
				return { valid: true, issues: [] };
			}),
		);
		let work: Awaited<ReturnType<typeof f.remove>>;
		if (unchanged) {
			f.r.revokeMemorySources(h.userId, [root.id], "old-root");
			f.db
				.delete(f.s.messages)
				.where(awaitEq(f.s.messages.id, "old-root"))
				.run();
			f.db
				.insert(f.s.messages)
				.values({
					id: "new-root",
					conversationId: root.id,
					role: "user",
					content: root.text,
				})
				.run();
			const same = f.r.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: root.epoch,
				eventId: "message:new-root",
				lineageId: root.lineageId,
				conversationId: root.id,
				messageId: "new-root",
				predecessorSourceId: root.id,
				text: root.text,
				context: root.context,
				assertedAt: root.assertedAt,
			});
			work = await f.jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: root.epoch,
				kind: "source",
				sourceId: same.id,
				requestId: same.id,
			});
		} else {
			work = await f.remove(root);
		}
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const settled = f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, work.row.id))
			.get();
		if (withdrawn) {
			if (unchanged)
				expect(
					f.retained.some((entry) => entry.items[0].content === live.text),
				).toBe(true);
			expect(JSON.stringify(payloads)).not.toContain("REEDFOX");
			expect(settled?.status).not.toBe("succeeded");
		} else {
			expect(JSON.stringify(payloads)).toContain("REEDFOX");
			expect(settled?.status).toBe("succeeded");
		}
	},
);

async function nativeFixture(retainContents = (content: string) => [content]) {
	const f = await fixture();
	const { vi } = await import("vitest");
	const clientModule = await import("./hindsight-client");
	const config = await import("$lib/server/config-store");
	const contracts = await import("./contracts");
	const jobs = await import("./delivery-job");
	const curation = await import("./curation");
	const check = vi.fn(async (_prompt, payload: unknown) => {
		const input = payload as {
			original_facts: Array<{ text: string }>;
			proposed_facts: Array<{ text: string }>;
			displayed_observations: Array<{ text: string }>;
		};
		const absent = input.original_facts.filter(
			({ text }) =>
				!input.proposed_facts.some((fact) => fact.text === text) ||
				!input.displayed_observations.some(
					(observation) => observation.text === text,
				),
		);
		return {
			valid: absent.length === 0,
			issues: absent.map(({ text }) => ({
				id: "preservation",
				problem: text,
			})),
		};
	});
	vi.spyOn(curation, "createCurationModel").mockReturnValue(
		withDatedNativeFacts(check),
	);
	const facts = new Map<
		string,
		{
			id: string;
			text: string;
			document_id: string;
			fact_type: "world";
			consolidated_at: string;
		}
	>();
	const retained: Array<{
		operation_id: string;
		items: Array<{
			content: string;
			context: string;
			timestamp: string;
			document_id: string;
		}>;
	}> = [];
	const deleted: string[] = [];
	let beforeRetain: (() => Promise<void>) | undefined;
	let afterPatch: (() => Promise<void>) | undefined;
	let observationText:
		| ((fact: { id: string; text: string }) => string | null)
		| undefined;
	let resetObservation: ((id: string) => { deleted_count: number }) | undefined;
	let loseAck = false;
	let operationStatus: ((id: string) => string) | undefined;
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
		} else if (path.includes("/documents/") && init?.method === "DELETE") {
			const id = decodeURIComponent(path.split("/documents/")[1]);
			deleted.push(id);
			for (const [key, fact] of facts)
				if (fact.document_id === id) facts.delete(key);
		} else if (path.endsWith("/observations") && init?.method === "DELETE") {
			const id = decodeURIComponent(path.split("/memories/")[1].split("/")[0]);
			data = resetObservation?.(id) ?? { deleted_count: 0 };
		} else if (path.includes("/memories/") && init?.method === "PATCH") {
			const id = decodeURIComponent(path.split("/memories/")[1]);
			const patch = JSON.parse(String(init.body));
			for (const [key, fact] of facts)
				if (fact.id === id) {
					if (patch.state === "invalidated") facts.delete(key);
					else if (typeof patch.text === "string")
						facts.set(key, { ...fact, text: patch.text });
				}
			await afterPatch?.();
		} else if (path.endsWith("/memories") && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			retained.push(body);
			if (beforeRetain) await beforeRetain();
			const item = body.items[0];
			for (const [index, text] of retainContents(item.content).entries()) {
				const key = index ? `${item.document_id}:${index}` : item.document_id;
				facts.set(key, {
					id: `fact:${key}`,
					text,
					document_id: item.document_id,
					fact_type: "world",
					consolidated_at: "2026-01-01T00:00:00Z",
				});
			}
			if (loseAck) {
				loseAck = false;
				throw new Error("simulated response loss");
			}
			data = { operation_id: body.operation_id };
		} else if (path.endsWith("/consolidate"))
			data = { operation_id: "consolidation" };
		else if (path.includes("/operations?")) data = { operations: [] };
		else if (path.includes("/operations/")) {
			const status =
				operationStatus?.(decodeURIComponent(path.split("/operations/")[1])) ??
				"completed";
			if (status === "forgotten")
				return new Response(JSON.stringify({ detail: "Not found" }), {
					status: 404,
				});
			data = { status };
		} else if (path.includes("/memories/list")) {
			const raw = [...facts.values()];
			const items = [
				...raw,
				...raw.flatMap((fact) => {
					const text = observationText ? observationText(fact) : fact.text;
					return text === null
						? []
						: [
								{
									id: `observation:${fact.id}`,
									fact_type: "observation",
									text,
									source_memory_ids: [fact.id],
								},
							];
				}),
			];
			const offset = Number(new URL(path).searchParams.get("offset") ?? 0);
			data = {
				items: items.slice(offset, offset + 100),
				total: items.length,
				offset,
			};
		}
		return new Response(JSON.stringify(data));
	});
	vi.spyOn(config, "getConfig").mockReturnValue({
		...config.getConfig(),
		hindsightWorkerEnabled: true,
		hindsightConcurrency: 1,
	});
	vi.spyOn(clientModule, "configuredNativeBinding").mockReturnValue({
		baseUrl: "http://synthetic",
		credentialHash: "synthetic-hash",
	});
	vi.spyOn(clientModule, "nativeMemoryClient").mockImplementation(
		() =>
			new clientModule.HindsightClient({
				baseUrl: "http://synthetic",
				apiKey: "synthetic",
				bankId: f.bank.id,
				fetcher,
			}),
	);
	function seed(
		source: ReturnType<typeof f.source>,
		text = source.text,
		...additional: string[]
	) {
		const acknowledged = [text, ...additional].map((value, index) => {
			const key = index ? `${source.id}:${index}` : source.id;
			const id = `fact:${key}`;
			facts.set(key, {
				id,
				text: value,
				document_id: source.id,
				fact_type: "world",
				consolidated_at: "2026-01-01T00:00:00Z",
			});
			return { id, text: value };
		});
		f.db
			.update(f.s.memorySourceRevisions)
			.set({
				acknowledgedFactsJson: JSON.stringify(acknowledged),
			})
			.where(awaitEq(f.s.memorySourceRevisions.id, source.id))
			.run();
	}
	async function remove(source: ReturnType<typeof f.source>) {
		f.r.revokeMemorySources(h.userId, [source.id]);
		return jobs.enqueueMemoryDelivery({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			kind: "source_cleanup",
			sourceId: source.id,
			requestId: `remove:${source.id}`,
		});
	}
	return {
		...f,
		jobs,
		facts,
		retained,
		deleted,
		seed,
		remove,
		setBeforeRetain: (fn: () => Promise<void>) => {
			beforeRetain = fn;
		},
		setAfterPatch: (fn: () => Promise<void>) => {
			afterPatch = fn;
		},
		setObservationText: (
			fn: (fact: { id: string; text: string }) => string | null,
		) => {
			observationText = fn;
		},
		setObservationReset: (fn: NonNullable<typeof resetObservation>) => {
			resetObservation = fn;
		},
		loseAck: () => {
			loseAck = true;
		},
		/**
		 * What Hindsight answers when asked about an operation; "completed" by
		 * default, and "forgotten" answers 404, as for an operation it no longer knows.
		 */
		setOperationStatus: (fn: (id: string) => string) => {
			operationStatus = fn;
		},
	};
}

it.each([
	"exact",
	"contradictory",
	"off",
	"newer first",
	"ancestor first",
	"unrelated last",
	"intervening publication",
	"intervening unproven",
	"intervening date drift",
] as const)(
	"source cleanup republishes only a previously accepted independent correction (%s)",
	async (mode) => {
		const f = await nativeFixture();
		const newer = f.source([], "I prefer oolong tea.");
		const maps = f.source([], "I collect paper maps.");
		const intervening = mode.startsWith("intervening");
		const {
			memoryPresentationFingerprint,
			memorySupportFingerprint,
			publishNativeSnapshot,
			readPublishedMemory,
		} = await import("./publication");
		const ancestor =
			mode === "newer first" ||
			mode === "ancestor first" ||
			mode === "unrelated last"
				? f.source([], "Mara plays the oboe.")
				: undefined;
		if (ancestor && mode !== "unrelated last") {
			const chatId = randomUUID();
			f.db
				.insert(f.s.conversations)
				.values({ id: chatId, title: "Synthetic tea chat", userId: h.userId })
				.run();
			f.db
				.update(f.s.memorySourceRevisions)
				.set({ conversationId: chatId })
				.where(awaitEq(f.s.memorySourceRevisions.id, ancestor.id))
				.run();
			f.db
				.update(f.s.memorySourceRevisions)
				.set({
					conversationId: chatId,
					lineageId: ancestor.lineageId,
					predecessorSourceId: ancestor.id,
				})
				.where(awaitEq(f.s.memorySourceRevisions.id, newer.id))
				.run();
		}
		if (ancestor) f.seed(ancestor);
		const authoredAction = randomUUID();
		const manual = f.r.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: `manual:${authoredAction}`,
			lineageId: authoredAction,
			text: "I prefer jasmine tea.",
			context: "",
			assertedAt: new Date("2026-01-01"),
		});
		f.db
			.update(f.s.memorySourceRevisions)
			.set({
				state: "accepted",
				nativeAcknowledged: true,
				nativeSubmitted: true,
			})
			.where(awaitEq(f.s.memorySourceRevisions.id, manual.id))
			.run();
		const requestId = randomUUID();
		f.db
			.insert(f.s.memoryActions)
			.values({
				id: authoredAction,
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: intervening ? "edit" : "add",
				requestId,
				text: manual.text,
				intentJson: JSON.stringify({
					request: {
						kind: intervening ? "edit" : "add",
						scope: { kind: "personal" },
						...(intervening
							? {
									ref: {
										scope: { kind: "personal" },
										generation: "older",
										rowId: "old-tea",
									},
								}
							: {}),
						requestId,
						text: manual.text,
					},
					before: "",
					sourceIds: [manual.id],
					facts: [],
					addedSourceId: manual.id,
					...(intervening && mode !== "intervening unproven"
						? {
								resultSupport: memorySupportFingerprint([
									{ id: `fact:${manual.id}`, text: manual.text },
								]),
								resultPresentation: memoryPresentationFingerprint(
									manual.text,
									manual.text,
								),
								nativeFacts: [
									{
										id: `fact:${manual.id}`,
										text: manual.text,
										assertion_at: manual.assertedAt.toISOString(),
										native_mentioned_at: null,
									},
								],
							}
						: {}),
					outcome: "accepted",
				}),
			})
			.run();
		for (const source of [manual, maps]) f.seed(source);
		const before = f.db.transaction((tx) =>
			publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				expectedRevision: 0,
				memories: [
					...f.facts.values(),
					...Array.from(f.facts.values(), (fact) => ({
						id: `accepted:${fact.id}`,
						fact_type: "observation",
						text: fact.text,
						source_memory_ids: [fact.id],
					})),
				],
			}),
		);
		f.seed(newer);
		const publishMerged = (
			revision: number,
			independent = [] as Array<ReturnType<typeof f.source>>,
		) =>
			f.db.transaction((tx) =>
				publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: f.bank.id,
					epoch: 0,
					expectedRevision: revision,
					memories: [
						...f.facts.values(),
						{
							id: "merged-tea",
							fact_type: "observation",
							text: newer.text,
							source_memory_ids: [`fact:${newer.id}`, `fact:${manual.id}`],
						},
						{
							id: `accepted:fact:${maps.id}`,
							fact_type: "observation",
							text: maps.text,
							source_memory_ids: [`fact:${maps.id}`],
						},
						...(ancestor
							? [
									{
										id: `accepted:fact:${ancestor.id}`,
										fact_type: "observation",
										text: ancestor.text,
										source_memory_ids: [`fact:${ancestor.id}`],
									},
								]
							: []),
						...independent.map((source) => ({
							id: `accepted:fact:${source.id}`,
							fact_type: "observation",
							text: source.text,
							source_memory_ids: [`fact:${source.id}`],
						})),
					],
				}),
			);
		const latest = publishMerged(1);
		expect(latest).not.toBe(before);
		const unrelated = intervening
			? f.source([], "I collect stamps.")
			: undefined;
		if (unrelated) {
			f.seed(unrelated);
			publishMerged(2, [unrelated]);
		}
		if (mode === "intervening date drift") {
			const fact = f.facts.get(manual.id);
			if (!fact) throw Error("missing synthetic fact");
			const drifted = { ...fact, mentioned_at: "2026-01-02T00:00:00Z" };
			f.facts.set(manual.id, drifted);
		}
		if (mode === "contradictory")
			f.setObservationText((fact) =>
				fact.id === `fact:${manual.id}` ? "I dislike jasmine tea." : fact.text,
			);
		const { setMemoryEnabled } = await import("./migration-policy");
		if (mode === "off") await setMemoryEnabled(h.userId, false);
		if (mode === "ancestor first" && ancestor) await f.remove(ancestor);
		const job = await f.remove(newer);
		if ((mode === "newer first" || mode === "unrelated last") && ancestor)
			await f.remove(ancestor);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.deleted).toContain(newer.id);
		expect(f.retained).toEqual([]);
		if (ancestor)
			expect(f.deleted).toEqual(
				mode !== "ancestor first"
					? [newer.id, ancestor.id]
					: [ancestor.id, newer.id],
			);
		if (mode === "off" || mode === "unrelated last") {
			const held = f.db
				.select()
				.from(f.s.memoryDeliveryJobs)
				.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
				.get();
			expect(held?.status).toBe("queued");
			if (mode === "off") await setMemoryEnabled(h.userId, true);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(Date.now() + 10000);
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			vi.useRealTimers();
		}
		const rows = readPublishedMemory(h.userId, f.bank.id);
		const held =
			mode === "contradictory" ||
			mode === "intervening unproven" ||
			mode === "intervening date drift";
		expect(rows.map((row) => row.text).sort()).toEqual(
			[
				maps.text,
				...(unrelated ? [unrelated.text] : []),
				...(held ? [] : [manual.text]),
			].sort(),
		);
		if (!held)
			expect(rows.find((row) => row.text === manual.text)?.updatedAt).toEqual(
				manual.assertedAt,
			);
		else
			expect(
				f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
					.get()?.status,
			).toBe("queued");
	},
);

it.each(["complete", "partial"] as const)(
	"checks the full affected support of a multirow Add after generation rotation (%s)",
	async (mode) => {
		const tea = "I prefer jasmine tea.";
		const jazz = "I play jazz piano.";
		const f = await nativeFixture(() => [tea, jazz]);
		const { submitMemoryAction, getMemoryOperation } = await import(
			"./curation-actions"
		);
		const { parseActionIntent } = await import("./curation-intent");
		const { publishNativeSnapshot, readPublishedMemory } = await import(
			"./publication"
		);
		const add = await submitMemoryAction(h.userId, {
			kind: "add",
			requestId: randomUUID(),
			scope: { kind: "personal" },
			text: `${tea} ${jazz}`,
		});
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(getMemoryOperation(h.userId, { id: add.id })).toMatchObject({
			status: "applied",
			ref: null,
		});
		const action = f.db
			.select()
			.from(f.s.memoryActions)
			.where(awaitEq(f.s.memoryActions.id, add.id))
			.get();
		const intent = parseActionIntent(action?.intentJson ?? null);
		expect(intent.resultRows).toHaveLength(2);
		const added = [...f.facts.values()];
		const newer = f.source(
			[],
			"I now prefer oolong tea and play classical piano.",
		);
		const unrelated = f.source([], "I collect stamps.");
		f.seed(newer);
		const publishMerged = (revision: number) =>
			f.db.transaction((tx) =>
				publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: f.bank.id,
					epoch: f.bank.epoch,
					expectedRevision: revision,
					memories: [
						...f.facts.values(),
						{
							id: "merged",
							fact_type: "observation",
							text: newer.text,
							source_memory_ids: [
								...added.map(({ id }) => id),
								`fact:${newer.id}`,
							],
						},
						...(revision === 2
							? [
									{
										id: `observation:fact:${unrelated.id}`,
										fact_type: "observation" as const,
										text: unrelated.text,
										source_memory_ids: [`fact:${unrelated.id}`],
									},
								]
							: []),
					],
				}),
			);
		publishMerged(1);
		f.seed(unrelated);
		publishMerged(2);
		if (mode === "partial")
			f.setObservationText((fact) => (fact.text === jazz ? null : fact.text));
		const job = await f.remove(newer);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const status = f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status;
		expect(status).toBe(mode === "complete" ? "succeeded" : "queued");
		const rows = readPublishedMemory(h.userId, f.bank.id);
		expect(rows.map(({ text }) => text).sort()).toEqual(
			mode === "complete"
				? [unrelated.text, tea, jazz].sort()
				: [unrelated.text],
		);
		expect(
			[...f.facts.values()].filter(
				(fact) => fact.document_id === intent.addedSourceId,
			),
		).toEqual(added);
	},
);

it.each([
	"imported previous",
	"imported rotated",
	"imported off",
	"other chat rotated",
	"other chat moved",
	"other chat revoked",
	"other chat changed raw",
	"other chat stored proof changed",
	"other chat split",
	"manual in other chat",
	"manual in other chat moved",
] as const)(
	"keeps an independently authorized survivor after deleting a superseding chat (%s)",
	async (mode) => {
		const f = await nativeFixture();
		const tea = "I prefer jasmine tea.";
		const maps = f.source([], "I collect paper maps.");
		f.seed(maps);
		const { submitMemoryAction, getMemoryOperation } = await import(
			"./curation-actions"
		);
		const {
			publishNativeSnapshot,
			readAcknowledgedFacts,
			readPublishedMemory,
		} = await import("./publication");
		const { parseActionIntent } = await import("./curation-intent");
		const isManual = mode.startsWith("manual");
		const chatId = "older-tea-chat";
		let originalId: string;
		if (mode.startsWith("imported")) {
			const date = new Date("2026-01-01");
			const item = "jasmine-imported";
			const id = `authored:${item}:0`;
			f.db
				.insert(f.s.memoryProjectionState)
				.values({ id: "projection", userId: h.userId, resetGeneration: 0 })
				.run();
			f.db
				.insert(f.s.memoryProfileItems)
				.values({
					id: item,
					userId: h.userId,
					projectionStateId: "projection",
					itemKey: "tea",
					category: "about_you",
					statement: tea,
					status: "active",
					metadataJson: '{"origin":"user_authored"}',
					updatedAt: date,
				})
				.run();
			const imported = f.r.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				eventId: id,
				lineageId: id,
				text: tea,
				assertedAt: date,
				context: JSON.stringify({
					migrationAuthoredId: id,
					legacyItemId: item,
				}),
			});
			f.db
				.update(f.s.memorySourceRevisions)
				.set({
					state: "staged",
					nativeSubmitted: true,
					nativeAcknowledged: true,
				})
				.where(awaitEq(f.s.memorySourceRevisions.id, imported.id))
				.run();
			f.seed(imported);
			originalId = imported.id;
		} else {
			f.db
				.insert(f.s.conversations)
				.values({ id: chatId, userId: h.userId, title: "Older tea chat" })
				.run();
			if (isManual) {
				const add = await submitMemoryAction(
					h.userId,
					{
						kind: "add",
						requestId: randomUUID(),
						scope: { kind: "personal" },
						text: tea,
					},
					chatId,
				);
				await h.engine.drain(f.jobs.memoryDeliveryJob);
				expect(getMemoryOperation(h.userId, { id: add.id }).status).toBe(
					"applied",
				);
				const action = f.db
					.select()
					.from(f.s.memoryActions)
					.where(awaitEq(f.s.memoryActions.id, add.id))
					.get();
				const sourceId = parseActionIntent(
					action?.intentJson ?? null,
				).addedSourceId;
				if (!sourceId) throw Error("missing synthetic action source");
				originalId = sourceId;
			} else {
				const original = f.source([], tea);
				const messageId = "original-tea-message";
				f.db
					.insert(f.s.messages)
					.values({
						id: messageId,
						conversationId: chatId,
						role: "user",
						content: tea,
					})
					.run();
				f.db
					.update(f.s.memorySourceRevisions)
					.set({ state: "staged", conversationId: chatId, messageId })
					.where(awaitEq(f.s.memorySourceRevisions.id, original.id))
					.run();
				f.seed(original);
				originalId = original.id;
			}
		}
		const publish = (
			revision: number,
			observations: import("./contracts").NativeMemory[],
		) =>
			f.db.transaction((tx) =>
				publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: f.bank.id,
					epoch: 0,
					expectedRevision: revision,
					sourceIds: [originalId],
					memories: [...f.facts.values(), ...observations],
				}),
			);
		const observation = (sourceId: string, text: string) => ({
			id: `observation:fact:${sourceId}`,
			fact_type: "observation" as const,
			text,
			source_memory_ids: [`fact:${sourceId}`],
		});
		const independent = observation(maps.id, maps.text);
		if (!isManual) {
			const first = observation(originalId, tea);
			publish(0, [
				independent,
				first,
				...(mode === "other chat split"
					? [{ ...first, id: "split", text: "The user likes jasmine." }]
					: []),
			]);
			const source = f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(awaitEq(f.s.memorySourceRevisions.id, originalId))
				.get();
			if (!source) throw Error("missing synthetic source");
			const [stored] = JSON.parse(source.acknowledgedFactsJson);
			if (mode === "other chat split")
				expect(stored.admittedObservation).toBeUndefined();
			else
				expect(stored.admittedObservation).toMatchObject({
					support: expect.any(String),
					presentation: expect.any(String),
					timing: expect.any(String),
				});
			expect(readAcknowledgedFacts(source.acknowledgedFactsJson)).toEqual([
				{ id: stored.id, text: tea },
			]);
			if (mode === "other chat stored proof changed") {
				f.db
					.update(f.s.memorySourceRevisions)
					.set({
						acknowledgedFactsJson: JSON.stringify([
							{
								...stored,
								admittedObservation: {
									...stored.admittedObservation,
									presentation: "wrong",
								},
							},
						]),
					})
					.where(awaitEq(f.s.memorySourceRevisions.id, originalId))
					.run();
			}
		}
		const newer = f.source([], "I prefer oolong tea.");
		f.seed(newer);
		const merged = {
			id: "merged-tea",
			fact_type: "observation" as const,
			text: newer.text,
			source_memory_ids: [`fact:${newer.id}`, `fact:${originalId}`],
		};
		publish(1, [independent, merged]);
		if (mode !== "imported previous") publish(2, [independent, merged]);
		if (mode.endsWith("moved")) {
			f.db
				.insert(f.s.projects)
				.values({ id: "new-project", userId: h.userId, name: "New scope" })
				.run();
			f.db
				.update(f.s.conversations)
				.set({ projectId: "new-project" })
				.where(awaitEq(f.s.conversations.id, chatId))
				.run();
		}
		if (mode === "other chat revoked")
			f.r.revokeMemorySources(h.userId, [originalId]);
		if (mode === "other chat changed raw") {
			const fact = f.facts.get(originalId);
			if (!fact) throw Error("missing synthetic raw fact");
			f.facts.set(originalId, { ...fact, text: "I dislike jasmine tea." });
		}
		const { setMemoryEnabled } = await import("./migration-policy");
		if (mode === "imported off") await setMemoryEnabled(h.userId, false);
		const originalRaw = f.facts.get(originalId);
		const job = await f.remove(newer);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const status = () =>
			f.db
				.select()
				.from(f.s.memoryDeliveryJobs)
				.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
				.get()?.status;
		if (mode === "imported off") {
			expect(status()).toBe("queued");
			await setMemoryEnabled(h.userId, true);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(Date.now() + 10000);
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			vi.useRealTimers();
		}
		expect(f.deleted).toContain(newer.id);
		expect(f.facts.get(originalId)).toEqual(originalRaw);
		const unverified =
			mode === "other chat changed raw" ||
			mode === "other chat stored proof changed" ||
			mode === "other chat split";
		const denied = mode.endsWith("moved") || mode.endsWith("revoked");
		expect(status()).toBe(unverified ? "queued" : "succeeded");
		expect(
			readPublishedMemory(h.userId, f.bank.id)
				.map(({ text }) => text)
				.sort(),
		).toEqual(unverified || denied ? [maps.text] : [maps.text, tea].sort());
	},
);

it.each([false, true])(
	"checks the authorized part of a previous observation with separately withdrawn backing (late: %s)",
	async (late) => {
		const f = await nativeFixture();
		const root = f.source([], "I planted a maple tree.");
		const withdrawn = f.source(
			[],
			"My old private collection was named RUSTFINCH.",
		);
		const survivor = f.source([], "My sister plays the bassoon.");
		const reply = f.source(
			[root.id, survivor.id],
			"I keep a community seed library.",
		);
		for (const source of [root, reply, withdrawn, survivor]) f.seed(source);
		const receiptMarker = "PRIVATE-ADMISSION-RECEIPT";
		for (const source of [reply, survivor])
			f.db
				.update(f.s.memorySourceRevisions)
				.set({
					acknowledgedFactsJson: JSON.stringify([
						{
							id: `fact:${source.id}`,
							text: source.text,
							admittedObservation: {
								support: receiptMarker,
								presentation: receiptMarker,
								timing: receiptMarker,
							},
						},
					]),
				})
				.where(awaitEq(f.s.memorySourceRevisions.id, source.id))
				.run();
		const { publishNativeSnapshot } = await import("./publication");
		f.db.transaction((tx) =>
			publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: f.bank.epoch,
				expectedRevision: 0,
				memories: [
					...f.facts.values(),
					{
						id: "previous-mixed",
						fact_type: "observation",
						text: `${withdrawn.text} ${survivor.text}`,
						source_memory_ids: [`fact:${withdrawn.id}`, `fact:${survivor.id}`],
					},
				],
			}),
		);
		const withdraw = () => {
			// Native can remove this independent source before the generation is replaced.
			f.r.revokeMemorySources(h.userId, [withdrawn.id]);
			f.facts.delete(withdrawn.id);
		};
		if (!late) withdraw();
		const forwarded: unknown[] = [];
		const checker = vi
			.fn<import("./curation").CurationModel>()
			.mockImplementation(
				async (_prompt, payload, _schema, _thinking, assertCurrent) => {
					if (late) withdraw();
					assertCurrent?.();
					forwarded.push(payload);
					return { valid: true, issues: [] };
				},
			);
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			checker,
		);
		const work = await f.remove(root);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(checker).toHaveBeenCalledTimes(1);
		if (late) {
			expect(forwarded).toEqual([]);
			expect(
				f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(awaitEq(f.s.memoryDeliveryJobs.id, work.row.id))
					.get()?.errorCode,
			).toBe("memory_dependency_source_changed");
			return;
		}
		const payload = forwarded[0];
		expect(JSON.stringify(payload)).not.toContain("RUSTFINCH");
		expect(JSON.stringify(payload)).not.toContain(receiptMarker);
		const context = f.retained.find(
			({ items }) => items[0].content === reply.text,
		)?.items[0].context;
		expect(context).toContain(survivor.text);
		expect(context).not.toContain(receiptMarker);
		expect(payload).toMatchObject({
			previous_displayed_observations: expect.arrayContaining([
				expect.objectContaining({
					text: survivor.text,
					sourceFactIds: [`fact:${survivor.id}`],
				}),
			]),
		});
	},
);

it.each(["display", "prior context"] as const)(
	"blocks final dispatch when another action acknowledges removal from %s",
	async (surface) => {
		const f = await nativeFixture();
		const root = f.source([], "I planted a maple tree.");
		const withdrawn = f.source(
			[],
			"My old private collection was named RUSTFINCH.",
		);
		const reply = f.source(
			surface === "prior context" ? [root.id, withdrawn.id] : [root.id],
			"I keep a community seed library.",
		);
		const survivor = f.source([], "My sister plays the bassoon.");
		for (const source of [root, reply, withdrawn, survivor]) f.seed(source);
		const { publishNativeSnapshot } = await import("./publication");
		const rowId =
			surface === "prior context"
				? `observation:fact:${withdrawn.id}`
				: "solo-to-remove";
		const generation = f.db.transaction((tx) =>
			publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: f.bank.epoch,
				expectedRevision: 0,
				memories: [
					...f.facts.values(),
					{
						id: rowId,
						fact_type: "observation",
						text: withdrawn.text,
						source_memory_ids: [`fact:${withdrawn.id}`],
					},
					...(surface === "display"
						? [
								{
									id: "previous-mixed",
									fact_type: "observation",
									text: `${withdrawn.text} ${survivor.text}`,
									source_memory_ids: [
										`fact:${withdrawn.id}`,
										`fact:${survivor.id}`,
									],
								},
							]
						: []),
				],
			}),
		);
		const { submitMemoryAction } = await import("./curation-actions");
		const forwarded: unknown[] = [];
		let removalAcknowledged = false;
		const checker = vi
			.fn<import("./curation").CurationModel>()
			.mockImplementation(
				async (_prompt, payload, _schema, _thinking, assertCurrent) => {
					if (!removalAcknowledged) {
						const operation = await submitMemoryAction(h.userId, {
							kind: "remove",
							requestId: randomUUID(),
							ref: {
								scope: { kind: "personal" },
								generation,
								rowId,
							},
						});
						removalAcknowledged = operation.exclusionAcknowledged;
						assertCurrent?.();
						forwarded.push(payload);
						return { valid: true, issues: [] };
					}
					assertCurrent?.();
					return { valid: true, issues: [] };
				},
			);
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			checker,
		);
		const work = await f.remove(root);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(removalAcknowledged).toBe(true);
		expect(forwarded).toEqual([]);
		expect(
			f.db
				.select()
				.from(f.s.memoryDeliveryJobs)
				.where(awaitEq(f.s.memoryDeliveryJobs.id, work.row.id))
				.get()?.errorCode,
		).toBe("memory_curation_publication_held");
	},
);

it.each([false, true])(
	"cleanup dispatches rebuilt reply assertions only while their sources are current (withdrawn: %s)",
	async (withdrawn) => {
		const f = await nativeFixture();
		const root = f.source([], "I planted a maple tree.");
		const child = f.source([root.id], "I keep a community seed library.");
		f.seed(root);
		f.seed(child);
		let revoked = false;
		if (withdrawn)
			f.setBeforeRetain(async () => {
				if (revoked) return;
				revoked = true;
				await f.remove(child);
			});
		const checker = vi.fn(async (_prompt, _payload: unknown) => ({
			valid: true,
			issues: [],
		}));
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			checker,
		);
		const work = await f.remove(root);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(
			f.retained.some((request) => request.items[0].content === child.text),
		).toBe(true);
		const status = f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, work.row.id))
			.get()?.status;
		const payloads = checker.mock.calls.map(([, payload]) =>
			JSON.stringify(payload),
		);
		if (withdrawn) {
			expect(revoked).toBe(true);
			expect(payloads.join("\n")).not.toContain(child.text);
			expect(status).not.toBe("succeeded");
		} else {
			expect(payloads.join("\n")).toContain(child.text);
			expect(status).toBe("succeeded");
		}
	},
);
it("real cleanup job repairs direct and transitive documents at original dates, retaining independent facts", async () => {
	const f = await nativeFixture();
	const root = f.source([], "removed detail");
	const child = f.source([root.id], "I enjoy hiking");
	const grandchild = f.source([child.id], "I swim too");
	const independent = f.source([], "I play chess");
	for (const source of [root, child, grandchild, independent]) f.seed(source);
	const job = await f.remove(root);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).toBe("succeeded");
	expect(f.retained).toHaveLength(2);
	expect(f.retained[0].items[0].timestamp).toBe(child.assertedAt.toISOString());
	expect(JSON.stringify(f.retained)).not.toContain("removed detail");
	expect(f.retained[1].items[0].context).toContain("I enjoy hiking");
	const { readPublishedMemory } = await import("./publication");
	expect(
		readPublishedMemory(h.userId, f.bank.id)
			.map((r) => r.text)
			.sort(),
	).toEqual(["I enjoy hiking", "I play chess", "I swim too"]);
});
it("disabled cleanup deletes dependent native documents but retains a durable local plan, enable resumes same parent", async () => {
	const f = await nativeFixture();
	const root = f.source([], "removed detail");
	const child = f.source([root.id]);
	f.seed(root);
	f.seed(child);
	const job = await f.remove(root);
	const { setMemoryEnabled } = await import("./migration-policy");
	await setMemoryEnabled(h.userId, false);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.retained).toHaveLength(0);
	expect(f.facts.size).toBe(0);
	const paused = f.db
		.select()
		.from(f.s.memoryDeliveryJobs)
		.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
		.get();
	expect(paused?.checkpoint).toContain(child.id);
	// Exhausted/retryable failure simulates a restarted worker's settled job; the enable boundary owns reactivation.
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({ status: "failed", retryable: true })
		.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
		.run();
	await setMemoryEnabled(h.userId, true);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.retained).toHaveLength(1);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).toBe("succeeded");
});
it("lost acknowledgement retries reuse exact replacement document and native operation identity", async () => {
	const f = await nativeFixture();
	const root = f.source();
	const child = f.source([root.id]);
	f.seed(root);
	f.seed(child);
	f.loseAck();
	const job = await f.remove(root);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const first = f.retained[0];
	expect(first).toBeDefined();
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({ status: "failed", retryable: true })
		.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
		.run();
	await h.engine.retry(f.jobs.memoryDeliveryJob, job.row.id, {
		userId: h.userId,
	});
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.retained).toHaveLength(2);
	expect(f.retained[1].operation_id).toBe(first.operation_id);
	expect(f.retained[1].items[0].document_id).toBe(first.items[0].document_id);
});
it("a replacement retain Hindsight keeps working on waits as a retain, for the retain's wait", async () => {
	const f = await nativeFixture();
	const root = f.source([], "removed detail");
	const child = f.source([root.id], "I enjoy hiking");
	f.seed(root);
	f.seed(child);
	// Hindsight never finishes the replacement's retain, and every read of it
	// moves the clock on six minutes, so each attempt's slice ends after one look.
	vi.useFakeTimers({ toFake: ["Date"] });
	const retains = () => new Set(f.retained.map((body) => body.operation_id));
	f.setOperationStatus((id) => {
		if (!retains().has(id)) return "completed";
		vi.setSystemTime(Date.now() + 6 * 60_000);
		return "processing";
	});
	const { getMemoryNativeWaits } = await import("$lib/server/config-store");
	const waits = getMemoryNativeWaits();
	const started = Date.now();
	const job = await f.remove(root);
	const codes: Array<string | null> = [];
	let waited = 0;
	try {
		for (let round = 0; round < 40; round++) {
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			const row = f.db
				.select()
				.from(f.s.memoryDeliveryJobs)
				.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
				.get();
			codes.push(row?.errorCode ?? null);
			if (row?.status !== "queued") break;
			vi.setSystemTime(Date.now() + 61_000);
		}
		waited = Date.now() - started;
	} finally {
		vi.useRealTimers();
	}
	expect(retains().size).toBe(1);
	expect(codes.slice(0, -1).length).toBeGreaterThan(0);
	expect(codes.slice(0, -1)).toEqual(
		codes.slice(0, -1).map(() => "native_retain_waiting"),
	);
	expect(codes.at(-1)).toBe("native_operation_timeout");
	// Ended by the retain's own wait, not the consolidation's longer one.
	expect(waited).toBeGreaterThanOrEqual(waits.retainMs);
	expect(waited).toBeLessThan(waits.consolidationMs);
}, 60_000);
it("never asks Hindsight about a dependent chat's retain whose end is recorded", async () => {
	const f = await nativeFixture();
	const root = f.source([], "removed detail");
	const child = f.source([root.id], "I enjoy hiking");
	f.seed(root);
	// The later chat's own delivery ended for good: its retain was cancelled,
	// the end recorded on its revision, and Hindsight has since forgotten it.
	const ended = child.nativeOperationId as string;
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			state: "pending",
			nativeAcknowledged: false,
			context: JSON.stringify({
				...JSON.parse(child.context),
				nativeRetainEnded: { operationId: ended, reason: "cancelled" },
			}),
		})
		.where(awaitEq(f.s.memorySourceRevisions.id, child.id))
		.run();
	const asked: string[] = [];
	f.setOperationStatus((id) => {
		if (id !== ended) return "completed";
		asked.push(id);
		return "forgotten";
	});
	const job = await f.remove(root);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	const row = f.db
		.select()
		.from(f.s.memoryDeliveryJobs)
		.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
		.get();
	expect({ status: row?.status, code: row?.errorCode }).toEqual({
		status: "succeeded",
		code: null,
	});
	expect(asked).toEqual([]);
	expect(f.deleted).toContain(child.id);
});
it("a real late native write after reset cannot publish or resume", async () => {
	const f = await nativeFixture();
	const root = f.source();
	const child = f.source([root.id]);
	f.seed(root);
	f.seed(child);
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.setBeforeRetain(async () => {
		entered();
		await wait;
	});
	const job = await f.remove(root);
	const drain = h.engine.drain(f.jobs.memoryDeliveryJob);
	await started;
	f.db.update(f.s.memoryAccounts).set({ epoch: 1 }).run();
	release();
	await drain;
	expect(
		[...f.facts.values()].some(
			(fact) => fact.document_id !== root.id && fact.document_id !== child.id,
		),
	).toBe(true);
	expect(f.db.select().from(f.s.memoryPublishedRows).all()).toEqual([]);
	const { resumeDependencyRepairs } = await import("./delivery-job");
	await resumeDependencyRepairs(h.userId);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).not.toBe("succeeded");
});
it("enable rebinds an automatically queued paused repair without requiring another toggle", async () => {
	const f = await nativeFixture();
	const root = f.source();
	const child = f.source([root.id]);
	f.seed(root);
	f.seed(child);
	const job = await f.remove(root);
	const { setMemoryEnabled } = await import("./migration-policy");
	await setMemoryEnabled(h.userId, false);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).toBe("queued");
	await setMemoryEnabled(h.userId, true);
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({ runAfter: new Date(0) })
		.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
		.run();
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.retained).toHaveLength(1);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).toBe("succeeded");
});
it("late closure overflow fences the bank after root deletion without destroying independent data", async () => {
	const f = await nativeFixture();
	const root = f.source();
	f.seed(root);
	const independent = f.source([], "independent");
	f.seed(independent);
	const job = await f.remove(root);
	for (let i = 0; i < 65; i++) {
		const child = f.source([root.id]);
		f.seed(child);
	}
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.errorCode,
	).toBe("memory_dependency_limit");
	expect(f.db.select().from(f.s.memoryBanks).get()?.status).toBe(
		"repair_blocked",
	);
	expect(f.facts.has(independent.id)).toBe(true);
	const { readPublishedMemory } = await import("./publication");
	expect(() => readPublishedMemory(h.userId, f.bank.id)).toThrow(
		"memory_fence_stale",
	);
});
it("does not elevate an unsent queued assertion into an off-period repair obligation", async () => {
	const f = await fixture();
	const root = f.source();
	const pending = f.source([root.id]);
	f.db
		.update(f.s.memorySourceRevisions)
		.set({ nativeSubmitted: false, state: "pending" })
		.where(awaitEq(f.s.memorySourceRevisions.id, pending.id))
		.run();
	f.r.revokeMemorySources(h.userId, [root.id]);
	expect(
		f.db
			.select()
			.from(f.s.memorySourceRevisions)
			.where(awaitEq(f.s.memorySourceRevisions.id, pending.id))
			.get()?.state,
	).toBe("pending");
});
it("off during an actual replacement write cleans that late document, then resumes with a new stable operation", async () => {
	const f = await nativeFixture();
	const root = f.source();
	const child = f.source([root.id]);
	f.seed(root);
	f.seed(child);
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.setBeforeRetain(async () => {
		entered();
		await wait;
	});
	const job = await f.remove(root);
	const drain = h.engine.drain(f.jobs.memoryDeliveryJob);
	await started;
	const { setMemoryEnabled } = await import("./migration-policy");
	await setMemoryEnabled(h.userId, false);
	release();
	await drain;
	expect(f.facts.size).toBe(0);
	const oldOperation = f.retained[0].operation_id;
	await setMemoryEnabled(h.userId, true);
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({ runAfter: new Date(0) })
		.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
		.run();
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.retained).toHaveLength(2);
	expect(f.retained[1].operation_id).not.toBe(oldOperation);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).toBe("succeeded");
});
it("acknowledged Remove off mid-repair completes cleanup without model calls and resumes its own intent", async () => {
	const f = await nativeFixture();
	const root = f.source([], "green kayak");
	const child = f.source([root.id], "I enjoy hiking");
	f.seed(root);
	f.seed(child);
	f.facts.set("sister", {
		id: "sister",
		text: "sister bicycle",
		document_id: root.id,
		fact_type: "world",
		consolidated_at: "2026-01-01T00:00:00Z",
	});
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			acknowledgedFactsJson: JSON.stringify([
				{ id: `fact:${root.id}`, text: "green kayak" },
				{ id: "sister", text: "sister bicycle" },
			]),
		})
		.where(awaitEq(f.s.memorySourceRevisions.id, root.id))
		.run();
	f.db.update(f.s.memoryBanks).set({ generation: "g" }).run();
	f.db
		.insert(f.s.memoryPublishedRows)
		.values({
			id: "row",
			nativeId: "row",
			bankId: f.bank.id,
			generation: "g",
			epoch: 0,
			text: "green kayak",
			nativeText: "green kayak",
			sourceIdsJson: JSON.stringify([`fact:${root.id}`]),
			sourceFingerprintsJson: JSON.stringify([
				{ id: `fact:${root.id}`, text: "green kayak" },
			]),
			updatedAt: new Date(),
		})
		.run();
	const curation = await import("./curation");
	const model = vi
		.fn()
		.mockResolvedValueOnce({
			forget: ["green kayak"],
			replace: [],
			preserve: ["sister bicycle"],
		})
		.mockResolvedValueOnce({
			facts: [
				{ id: `fact:${root.id}`, text: "" },
				{ id: "sister", text: "sister bicycle" },
			],
		})
		.mockResolvedValue({ valid: true, issues: [] });
	vi.spyOn(curation, "createCurationModel").mockReturnValue(
		withDatedNativeFacts(model),
	);
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.setBeforeRetain(async () => {
		entered();
		await wait;
	});
	const { randomUUID } = await import("node:crypto");
	const { submitMemoryAction } = await import("./curation-actions");
	const op = await submitMemoryAction(h.userId, {
		kind: "remove",
		ref: { scope: { kind: "personal" }, generation: "g", rowId: "row" },
		requestId: randomUUID(),
	});
	const drain = h.engine.drain(f.jobs.memoryDeliveryJob);
	await started;
	const { setMemoryEnabled } = await import("./migration-policy");
	await setMemoryEnabled(h.userId, false);
	release();
	await drain;
	expect(model).toHaveBeenCalledTimes(3);
	expect([...f.facts.values()].map((fact) => fact.text)).toEqual([
		"sister bicycle",
	]);
	const paused = f.db
		.select()
		.from(f.s.memoryDeliveryJobs)
		.where(awaitEq(f.s.memoryDeliveryJobs.actionId, op.id))
		.get();
	expect(paused?.status).not.toBe("cancelled");
	expect(
		f.db
			.select()
			.from(f.s.memoryActions)
			.where(awaitEq(f.s.memoryActions.id, op.id))
			.get(),
	).toMatchObject({ exclusionAcknowledged: true, cleanupPending: true });
	await setMemoryEnabled(h.userId, true);
	f.db
		.update(f.s.memoryDeliveryJobs)
		.set({ runAfter: new Date(0) })
		.where(awaitEq(f.s.memoryDeliveryJobs.actionId, op.id))
		.run();
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.actionId, op.id))
			.get()?.status,
	).toBe("succeeded");
	expect(model).toHaveBeenCalledTimes(4);
});

it("lifecycle regression: source deletion holds a replacement that loses a child’s independent assertion", async () => {
	const f = await nativeFixture();
	const root = f.source([], "The project is teal.");
	const child = f.source([root.id], "That one. Separately, I own a bicycle.");
	const independent = f.source([], "I play chess.");
	f.seed(root);
	f.seed(child, "I own a bicycle.");
	f.seed(independent);
	const publication = await import("./publication");
	const raw = [...f.facts.values()];
	f.db.transaction((tx) =>
		publication.publishNativeSnapshot(tx, {
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			expectedRevision: 0,
			memories: [
				...raw,
				...raw.map((fact) => ({
					id: `observation:${fact.id}`,
					fact_type: "observation" as const,
					text: fact.text,
					source_memory_ids: [fact.id],
				})),
			],
		}),
	);
	// Simulate native returning zero facts for the repaired short reply, a valid retain outcome.
	const set = f.facts.set.bind(f.facts);
	vi.spyOn(f.facts, "set").mockImplementation((key, fact) => {
		if (![root.id, child.id, independent.id].includes(key)) return f.facts;
		return set(key, fact);
	});
	const curation = await import("./curation");
	const model = vi.fn(async (_prompt, input) => ({
		valid: input.proposed_facts.some(({ text }: { text: string }) =>
			text.includes("bicycle"),
		),
		issues: input.proposed_facts.length
			? []
			: [{ id: "bicycle", problem: "Independent bicycle assertion missing" }],
	}));
	vi.spyOn(curation, "createCurationModel").mockReturnValue(
		withDatedNativeFacts(model),
	);
	const job = await f.remove(root);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).not.toBe("succeeded");
	expect(model).toHaveBeenCalledTimes(1);
	expect(model.mock.calls[0][1]).toMatchObject({
		original_facts: [{ text: "I own a bicycle." }],
		proposed_facts: [],
	});
	expect(
		f.db
			.select()
			.from(f.s.memorySourceRevisions)
			.where(awaitEq(f.s.memorySourceRevisions.id, child.id))
			.get()?.state,
	).toBe("repair_held");
	expect(f.retained[0].items[0].content).toContain("bicycle");
	expect(
		(await import("./publication"))
			.readPublishedMemory(h.userId, f.bank.id)
			.map((r) => r.text),
	).toEqual(["I play chess."]);
});

it("lifecycle regression: an older Clear Memory cannot sweep a bank admitted after the second reset", async () => {
	const f = await nativeFixture();
	const knowledge = await import("../knowledge");
	const lifecycle = await import("../account-lifecycle");
	const barrier = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const real = knowledge.getArtifactOwnershipScope;
	const spy = vi
		.spyOn(knowledge, "getArtifactOwnershipScope")
		.mockImplementationOnce(async (...args) => {
			entered.resolve();
			await barrier.promise;
			return real(...args);
		});
	// Slower caller pauses after the committed erasing fence, before deleting local banks.
	const slow = lifecycle.clearMemoryAndKnowledgeForUser(h.userId, {
		artifactScope: "all-owned",
	});
	await entered.promise;
	await lifecycle.clearMemoryAndKnowledgeForUser(h.userId, {
		artifactScope: "all-owned",
	});
	expect(f.r.getMemoryAccount(h.userId)?.lifecycleState).toBe("active");
	const bank = f.r.ensureMemoryBank(h.userId, { kind: "personal" });
	const fresh = f.r.recordMemorySource({
		userId: h.userId,
		bankId: bank.id,
		epoch: bank.epoch,
		eventId: "postreset",
		lineageId: "postreset",
		text: "a new source",
		context: "",
		assertedAt: new Date(),
	});
	await f.jobs.enqueueMemoryDelivery({
		userId: h.userId,
		bankId: bank.id,
		epoch: bank.epoch,
		kind: "source",
		sourceId: fresh.id,
		requestId: "postreset",
	});
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(f.retained.map((r) => r.items[0].content)).toContain("a new source");
	barrier.resolve();
	await slow;
	expect(
		f.db
			.select()
			.from(f.s.memoryBanks)
			.all()
			.some((b) => b.id === bank.id),
	).toBe(true);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.all()
			.some((j) => j.bankId === bank.id && j.kind === "cleanup"),
	).toBe(false);
	expect(f.facts.has(fresh.id)).toBe(true);
	spy.mockRestore();
});

it.each(["memory", "workspace"] as const)(
	"an overlapping %s reset cannot reopen an account erasure fence",
	async (scope) => {
		const f = await nativeFixture();
		f.db
			.update(f.s.memoryBanks)
			.set({
				nativeBaseUrl: "http://synthetic",
				nativeCredentialHash: "synthetic-hash",
			})
			.run();
		const knowledge = await import("../knowledge");
		const lifecycle = await import("../account-lifecycle");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const real = knowledge.getArtifactOwnershipScope;
		vi.spyOn(knowledge, "getArtifactOwnershipScope").mockImplementationOnce(
			async (...args) => {
				entered.resolve();
				await release.promise;
				return real(...args);
			},
		);
		const deletion = lifecycle.eraseUserAccountData(h.userId);
		await entered.promise;
		try {
			if (scope === "memory")
				await lifecycle.clearMemoryAndKnowledgeForUser(h.userId);
			else await lifecycle.purgeUserData(h.userId);
			expect(() =>
				f.r.ensureMemoryBank(h.userId, { kind: "personal" }),
			).toThrow(/erasing/);
			expect(f.db.select().from(f.s.users).get()?.id).toBe(h.userId);
		} finally {
			release.resolve();
			await deletion;
		}
		expect(f.db.select().from(f.s.users).get()).toBeUndefined();
		const jobs = f.db.select().from(f.s.memoryDeliveryJobs).all();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			kind: "cleanup",
			bankId: f.bank.id,
			nativeCredentialHash: "synthetic-hash",
		});
		expect(jobs[0].userId).not.toBe(h.userId);
	},
);

it("a new Clear Memory resumes a durable interrupted reset without advancing the retired epoch twice", async () => {
	const f = await nativeFixture();
	f.db
		.update(f.s.memoryBanks)
		.set({
			nativeBaseUrl: "http://synthetic",
			nativeCredentialHash: "synthetic-hash",
		})
		.run();
	const token = await f.jobs.prepareNativeMemoryErasure(h.userId);
	expect(token).toBeTruthy();
	const second = await h.bootSecondProcess();
	const { clearMemoryAndKnowledgeForUser } = await import(
		"../account-lifecycle"
	);
	await clearMemoryAndKnowledgeForUser(h.userId);
	expect(
		second.sqlite
			.prepare(
				"SELECT epoch,lifecycle_state,erasure_token FROM memory_accounts WHERE user_id=?",
			)
			.get(h.userId),
	).toEqual({
		epoch: 1,
		lifecycle_state: "active",
		erasure_token: null,
	});
	expect(f.db.select().from(f.s.memoryBanks).all()).toEqual([]);
	expect(f.db.select().from(f.s.memoryDeliveryJobs).all()).toHaveLength(1);
});

it.each([false, true])(
	"source deletion admits an empty replacement but rejects context-dependent resurrection (%s)",
	async (resurrected) => {
		const f = await nativeFixture();
		const root = f.source([], "My kayak is green.");
		const child = f.source([root.id], "Yes.");
		f.seed(root);
		f.seed(child, "The kayak is green.");
		const set = f.facts.set.bind(f.facts);
		vi.spyOn(f.facts, "set").mockImplementation((key, fact) => {
			if (key === root.id || key === child.id) return set(key, fact);
			return resurrected
				? set(key, { ...fact, text: "The kayak is green." })
				: f.facts;
		});
		const curation = await import("./curation");
		vi.spyOn(curation, "createCurationModel").mockReturnValue(
			vi.fn(async (_prompt, payload: unknown) => {
				const input = payload as {
					proposed_facts: Array<{ text: string }>;
					source_assertions: Array<{ assertion: string; priorContext: string }>;
				};
				expect(input.source_assertions[0].assertion).toBe("Yes.");
				expect(input.source_assertions[0].priorContext).not.toContain("kayak");
				const leaks = input.proposed_facts.some(({ text }) =>
					text.includes("kayak"),
				);
				return {
					valid: !leaks,
					issues: leaks
						? [{ id: "context", problem: "The deleted assertion returned." }]
						: [],
				};
			}),
		);
		const job = await f.remove(root);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const verdict = f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get();
		expect(verdict?.status).toBe(resurrected ? "queued" : "succeeded");
		const { readPublishedMemory } = await import("./publication");
		expect(readPublishedMemory(h.userId, f.bank.id)).toEqual([]);
	},
);

it("repair retains a short surviving reply with only a verified predecessor’s sanitized native fact", async () => {
	const f = await nativeFixture();
	const root = f.source([], "This is private project context.");
	const parent = f.source([root.id], "My sister owns a red bicycle.");
	const child = f.source([parent.id], "Yes.");
	f.seed(root);
	f.seed(parent);
	f.seed(child, "My sister owns a red bicycle.");
	const set = f.facts.set.bind(f.facts);
	vi.spyOn(f.facts, "set").mockImplementation((key, fact) => {
		if (fact.text !== "Yes.") return set(key, fact);
		const item = f.retained.at(-1)?.items[0];
		if (!item?.context.includes("My sister owns a red bicycle."))
			return f.facts;
		return set(key, { ...fact, text: "My sister owns a red bicycle." });
	});
	const job = await f.remove(root);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get()?.status,
	).toBe("succeeded");
	const short = f.retained.find((event) => event.items[0].content === "Yes.")
		?.items[0];
	expect(short?.timestamp).toBe(child.assertedAt.toISOString());
	expect(JSON.parse(short?.context ?? "")).toMatchObject({
		prior_memory: [
			{
				text: "My sister owns a red bicycle.",
				asserted_at: parent.assertedAt.toISOString(),
			},
		],
	});
	expect(short?.context).not.toContain("private project context");
});

it("cancelled Edit compensation replaces a descendant rebuilt under the interrupted edit", async () => {
	const f = await nativeFixture();
	const root = f.source([], "The kayak is green.");
	const child = f.source([root.id], "Yes.");
	f.seed(root);
	f.seed(child, "The green kayak belongs to me.");
	const { publishNativeSnapshot, readPublishedMemory } = await import(
		"./publication"
	);
	const initial = [...f.facts.values()];
	const generation = f.db.transaction((tx) =>
		publishNativeSnapshot(tx, {
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			expectedRevision: 0,
			memories: [
				...initial,
				...initial.map((fact) => ({
					id: `observation:${fact.id}`,
					fact_type: "observation" as const,
					text: fact.text,
					source_memory_ids: [fact.id],
				})),
			],
		}),
	);
	const { setMemoryEnabled } = await import("./migration-policy");
	let disabledDuringDependent = false;
	f.setBeforeRetain(async () => {
		const item = f.retained.at(-1)?.items[0];
		if (item?.content === "Yes." && !disabledDuringDependent) {
			expect(item.context).toContain("The kayak is purple.");
			disabledDuringDependent = true;
			await setMemoryEnabled(h.userId, false);
		}
	});
	const set = f.facts.set.bind(f.facts);
	vi.spyOn(f.facts, "set").mockImplementation((key, fact) => {
		if (fact.text === "Yes.") {
			const context = f.retained.at(-1)?.items[0].context ?? "";
			return set(key, {
				...fact,
				text: context.includes("The kayak is green.")
					? "The green kayak belongs to me."
					: "The purple kayak belongs to me.",
			});
		}
		if (fact.text.includes('"kind":"source_edit"'))
			return set(key, { ...fact, text: "The kayak is purple." });
		return set(key, fact);
	});
	const curation = await import("./curation");
	const checker = vi
		.fn(async (_prompt, payload: unknown): Promise<unknown> => {
			const input = payload as {
				displayed_observations: Array<{ text: string }>;
			};
			const actual = input.displayed_observations
				.map(({ text }) => text)
				.sort();
			const valid =
				JSON.stringify(actual) ===
				JSON.stringify([
					"The green kayak belongs to me.",
					"The kayak is green.",
				]);
			return {
				valid,
				issues: valid
					? []
					: [
							{
								id: "bad-restore",
								problem: "Prior observations were not restored",
							},
						],
			};
		})
		.mockResolvedValueOnce({
			forget: [],
			replace: ["green to purple"],
			preserve: [],
		})
		.mockResolvedValueOnce({
			facts: [{ id: `fact:${root.id}`, text: "The kayak is purple." }],
		})
		.mockResolvedValueOnce({ valid: true, issues: [] });
	vi.spyOn(curation, "createCurationModel").mockReturnValue(
		withDatedNativeFacts(checker),
	);
	const { submitMemoryAction, getMemoryOperation } = await import(
		"./curation-actions"
	);
	const operation = await submitMemoryAction(h.userId, {
		kind: "edit",
		text: "The kayak is purple.",
		requestId: crypto.randomUUID(),
		ref: {
			scope: { kind: "personal" },
			generation,
			rowId: `observation:fact:${root.id}`,
		},
	});
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(disabledDuringDependent).toBe(true);
	expect(checker).toHaveBeenCalledTimes(3);
	const discarded = f.retained.find(
		(retain) => retain.items[0].content === "Yes.",
	)?.items[0].document_id;
	await setMemoryEnabled(h.userId, true);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(getMemoryOperation(h.userId, { id: operation.id })).toMatchObject({
		status: "failed",
		errorCode: "memory_edit_cancelled",
		cleanupPending: false,
	});
	expect(checker).toHaveBeenCalledTimes(4);
	const replacements = f.retained.filter(
		(retain) => retain.items[0].content === "Yes.",
	);
	expect(replacements).toHaveLength(2);
	expect(replacements[1].items[0]).toMatchObject({
		timestamp: child.assertedAt.toISOString(),
	});
	expect(replacements[1].items[0].document_id).not.toBe(discarded);
	expect(discarded && f.facts.has(discarded)).toBe(false);
	expect(
		readPublishedMemory(h.userId, f.bank.id)
			.map(({ text }) => text)
			.sort(),
	).toEqual(["The green kayak belongs to me.", "The kayak is green."]);
});

it.each([
	"pure dependent",
	"independent survivor",
	"independent loss",
	"all withdrawn",
	"withdrawn child with surviving descendant",
] as const)(
	"cancelled Edit and root deletion complete only a verified dependent recovery (%s)",
	async (mode) => {
		const f = await nativeFixture();
		const root = f.source([], "The kayak is green.");
		const withdrawChild =
			mode === "all withdrawn" ||
			mode === "withdrawn child with surviving descendant";
		const pure = mode === "pure dependent" || withdrawChild;
		const assertion = pure ? "Yes." : "Yes. I ride a bicycle to work.";
		const oldChildFact = pure
			? "The green kayak belongs to me."
			: "The green kayak belongs to me. I ride a bicycle to work.";
		const survivor = "I ride a bicycle to work.";
		const child = f.source([root.id], assertion);
		const descendant =
			mode === "withdrawn child with surviving descendant"
				? f.source([root.id, child.id], survivor)
				: null;
		f.seed(root);
		f.seed(child, oldChildFact);
		if (descendant) f.seed(descendant);
		const { publishNativeSnapshot } = await import("./publication");
		const initial = [...f.facts.values()];
		const generation = f.db.transaction((tx) =>
			publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				expectedRevision: 0,
				memories: [
					...initial,
					...initial.map((fact) => ({
						id: `observation:${fact.id}`,
						fact_type: "observation" as const,
						text: fact.text,
						source_memory_ids: [fact.id],
					})),
				],
			}),
		);
		const { setMemoryEnabled } = await import("./migration-policy");
		let disabledDuringDependent = false;
		f.setBeforeRetain(async () => {
			const item = f.retained.at(-1)?.items[0];
			if (item?.content === assertion && !disabledDuringDependent) {
				expect(item.context).toContain("The kayak is purple.");
				disabledDuringDependent = true;
				await setMemoryEnabled(h.userId, false);
			}
		});
		const set = f.facts.set.bind(f.facts);
		vi.spyOn(f.facts, "set").mockImplementation((key, fact) => {
			if (fact.text === assertion) {
				const context = f.retained.at(-1)?.items[0].context ?? "";
				if (context.includes('"prior_memory":[]'))
					return mode === "independent survivor"
						? set(key, { ...fact, text: survivor })
						: f.facts;
				return set(key, { ...fact, text: "The purple kayak belongs to me." });
			}
			if (fact.text.includes('"kind":"source_edit"'))
				return set(key, { ...fact, text: "The kayak is purple." });
			return set(key, fact);
		});
		const payloads: Array<Record<string, unknown>> = [];
		const checker = vi
			.fn(async (_prompt, payload: unknown): Promise<unknown> => {
				const input = payload as Record<string, unknown>;
				payloads.push(input);
				const sources = input.source_assertions as
					| Array<{
							assertion: string;
							priorContext: string;
							originalSourceId?: string;
					  }>
					| undefined;
				const source = sources?.find(
					(row) =>
						row.assertion === (descendant?.text ?? assertion) &&
						row.originalSourceId === (descendant?.id ?? child.id),
				);
				const facts = input.proposed_facts as Array<{ text: string }>;
				const valid =
					!!source &&
					JSON.parse(source.priorContext).prior_memory.length === 0 &&
					(mode === "pure dependent"
						? facts.length === 0
						: facts.some((fact) => fact.text === survivor));
				return valid
					? { valid: true, issues: [] }
					: {
							valid: false,
							issues: [
								{
									id: "ambiguous",
									problem:
										"Independent child information is missing, or there is no valid withdrawal evidence.",
								},
							],
						};
			})
			.mockResolvedValueOnce({
				forget: [],
				replace: ["green to purple"],
				preserve: [],
			})
			.mockResolvedValueOnce({
				facts: [{ id: `fact:${root.id}`, text: "The kayak is purple." }],
			})
			.mockResolvedValueOnce({ valid: true, issues: [] });
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			withDatedNativeFacts(checker),
		);
		const a = await import("./curation-actions");
		const operation = await a.submitMemoryAction(h.userId, {
			kind: "edit",
			text: "The kayak is purple.",
			requestId: crypto.randomUUID(),
			ref: {
				scope: { kind: "personal" },
				generation,
				rowId: `observation:fact:${root.id}`,
			},
		});
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(disabledDuringDependent).toBe(true);
		const deletion = await f.remove(root);
		const childDeletion = withdrawChild ? await f.remove(child) : null;
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(f.deleted).toContain(root.id);
		if (withdrawChild) expect(f.deleted).toContain(child.id);
		if (mode === "all withdrawn")
			expect(
				f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(
						awaitEq(f.s.memoryDeliveryJobs.id, childDeletion?.row.id ?? ""),
					)
					.get()?.status,
			).toBe("succeeded");
		const deletedAttempt = f.retained.find(
			(retain) => retain.items[0].content === assertion,
		)?.items[0].document_id;
		expect(deletedAttempt).toBeDefined();
		await setMemoryEnabled(h.userId, true);
		const cleanupFirst = descendant ? childDeletion : deletion;
		if (cleanupFirst && (mode === "independent survivor" || descendant)) {
			// The cleanup job can claim first after enable. It keeps its physical
			// deletion progress and leaves reconstruction for the pending rollback.
			const scheduledRetains = f.retained.length;
			f.db
				.update(f.s.memoryDeliveryJobs)
				.set({ runAfter: new Date(Date.now() + 60000) })
				.where(awaitEq(f.s.memoryDeliveryJobs.actionId, operation.id))
				.run();
			f.db
				.update(f.s.memoryDeliveryJobs)
				.set({ runAfter: new Date(0) })
				.where(awaitEq(f.s.memoryDeliveryJobs.id, cleanupFirst.row.id))
				.run();
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			expect(
				f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(awaitEq(f.s.memoryDeliveryJobs.id, cleanupFirst.row.id))
					.get(),
			).toMatchObject({
				status: "queued",
				// A rollback that already retained a replacement is live work in
				// flight: the cleanup waits for it before it captures anything.
				errorCode: descendant
					? "native_bank_busy_waiting"
					: "memory_dependency_restore_pending",
			});
			expect(f.retained).toHaveLength(scheduledRetains);
			f.db
				.update(f.s.memoryDeliveryJobs)
				.set({ runAfter: new Date(0) })
				.where(awaitEq(f.s.memoryDeliveryJobs.actionId, operation.id))
				.run();
		}
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		if (mode === "all withdrawn") expect(payloads).toHaveLength(0);
		else
			expect(payloads.at(-1)).toMatchObject({
				original_facts: expect.arrayContaining([
					expect.objectContaining({
						text: descendant?.text ?? oldChildFact,
						sourceId: descendant?.id ?? child.id,
					}),
				]),
				source_assertions: [
					{
						assertion: descendant?.text ?? assertion,
						originalSourceId: descendant?.id ?? child.id,
					},
				],
				withdrawn_source_ids: withdrawChild
					? expect.arrayContaining([root.id, child.id])
					: [root.id],
				displayed_before: "",
			});
		const args = {
			kind: "add",
			scope: { kind: "personal" },
			text: "I play chess.",
			requestId: crypto.randomUUID(),
		};
		if (mode === "independent loss") {
			expect(
				a.getMemoryOperation(h.userId, { id: operation.id }),
			).toMatchObject({
				cleanupPending: true,
				errorCode: "memory_dependency_check_rejected",
			});
			await expect(a.submitMemoryAction(h.userId, args)).rejects.toMatchObject({
				code: "memory_action_pending",
			});
			return;
		}
		expect(a.getMemoryOperation(h.userId, { id: operation.id })).toMatchObject({
			status: "failed",
			cleanupPending: false,
			errorCode: "memory_edit_cancelled",
		});
		if (withdrawChild) {
			expect(
				f.retained.filter((retain) => retain.items[0].content === assertion),
			).toHaveLength(1);
			expect(f.deleted).toContain(deletedAttempt);
			expect(f.facts.has(child.id)).toBe(false);
			expect(deletedAttempt && f.facts.has(deletedAttempt)).toBe(false);
			expect(
				f.db
					.select()
					.from(f.s.memorySourceRevisions)
					.where(awaitEq(f.s.memorySourceRevisions.id, child.id))
					.get()?.state,
			).toBe("revoked");
		}
		// The deletion job had already checkpointed the same old child. It may
		// settle after compensation without reconstructing the accepted replacement.
		const retainsBefore = f.retained.length;
		const deletions = childDeletion ? [deletion, childDeletion] : [deletion];
		for (const entry of deletions)
			f.db
				.update(f.s.memoryDeliveryJobs)
				.set({ runAfter: new Date(0) })
				.where(awaitEq(f.s.memoryDeliveryJobs.id, entry.row.id))
				.run();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		for (const entry of deletions)
			expect(
				f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(awaitEq(f.s.memoryDeliveryJobs.id, entry.row.id))
					.get()?.status,
			).toBe("succeeded");
		expect(f.retained).toHaveLength(retainsBefore);
		const add = await a.submitMemoryAction(h.userId, args);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(a.getMemoryOperation(h.userId, { id: add.id }).status).toBe(
			"applied",
		);
		const { readPublishedMemory } = await import("./publication");
		expect(
			readPublishedMemory(h.userId, f.bank.id)
				.map(({ text }) => text)
				.sort(),
		).toEqual(
			mode === "pure dependent" || mode === "all withdrawn"
				? ["I play chess."]
				: ["I play chess.", survivor],
		);
	},
);

it.each([
	"surviving fact",
	"lost independent fact",
	"checkpointed descendant",
	"prior terminal attempt",
	"prior terminal attempt without saved plan",
] as const)(
	"rebuilds a withdrawn root's surviving Edit target without restoring dependent text (%s)",
	async (mode) => {
		const keepIndependentFact = mode !== "lost independent fact";
		const f = await nativeFixture();
		const monday = "I teach pottery on Mondays.";
		const friday = "I teach pottery on Fridays.";
		const independent = "I maintain the community seed library.";
		const root = f.source([], monday);
		const child = f.source(
			[root.id],
			"Yes, I do. I maintain the community seed library.",
		);
		const childPottery = "I still teach pottery on Mondays.";
		const descendant =
			mode === "checkpointed descendant"
				? f.source([child.id], "I prefer paper maps.")
				: null;
		f.seed(root);
		f.seed(child, independent, childPottery);
		if (descendant) f.seed(descendant);
		const p = await import("./publication");
		const observationId = "shared-pottery";
		const generation = f.db.transaction((tx) =>
			p.publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				expectedRevision: 0,
				memories: [
					...f.facts.values(),
					{
						id: observationId,
						fact_type: "observation",
						text: monday,
						source_memory_ids: [`fact:${root.id}`, `fact:${child.id}:1`],
					},
					{
						id: `observation:fact:${child.id}`,
						fact_type: "observation",
						text: independent,
						source_memory_ids: [`fact:${child.id}`],
					},
				],
			}),
		);
		const { setMemoryEnabled } = await import("./migration-policy");
		let cancelled = false;
		const cancel = async () => {
			if (cancelled) return;
			expect(f.facts.get(root.id)?.text).toBe(friday);
			cancelled = true;
			await setMemoryEnabled(h.userId, false);
		};
		if (descendant)
			f.setBeforeRetain(async () => {
				if (f.retained.at(-1)?.items[0].content === descendant.text)
					await cancel();
			});
		else f.setAfterPatch(cancel);
		const set = f.facts.set.bind(f.facts);
		vi.spyOn(f.facts, "set").mockImplementation((key, fact) => {
			if (fact.text.includes('"kind":"source_edit"'))
				return set(key, { ...fact, text: friday });
			if (fact.text === child.text) {
				expect(f.retained.at(-1)?.items[0].context).toContain(
					'"prior_memory":[]',
				);
				return keepIndependentFact
					? set(key, { ...fact, text: independent })
					: f.facts;
			}
			return set(key, fact);
		});
		const payloads: Array<Record<string, unknown>> = [];
		let rejectRecovery =
			mode === "prior terminal attempt" ||
			mode === "prior terminal attempt without saved plan";
		const verify = vi
			.fn(async (_prompt, payload: unknown): Promise<unknown> => {
				const input = payload as Record<string, unknown>;
				payloads.push(input);
				const proposed = input.proposed_facts as Array<{ text: string }>;
				return (!rejectRecovery || !input.source_assertions) &&
					proposed.some((f) => f.text === independent)
					? { valid: true, issues: [] }
					: {
							valid: false,
							issues: [
								{ id: "library", problem: "Lost independent evidence." },
							],
						};
			})
			.mockResolvedValueOnce({
				forget: [],
				replace: ["Mondays to Fridays"],
				preserve: [independent],
			})
			.mockResolvedValueOnce({
				facts: [
					{ id: `fact:${root.id}`, text: friday },
					{ id: `fact:${child.id}`, text: independent },
					{ id: `fact:${child.id}:1`, text: friday },
				],
			});
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			withDatedNativeFacts(verify),
		);
		const actions = await import("./curation-actions");
		const request = {
			kind: "edit",
			text: friday,
			requestId: crypto.randomUUID(),
			ref: { scope: { kind: "personal" }, generation, rowId: observationId },
		};
		const edit = await actions.submitMemoryAction(h.userId, request);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(cancelled).toBe(true);
		const deletion = await f.remove(root);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		const before = f.db
			.select()
			.from(f.s.memoryActions)
			.where(awaitEq(f.s.memoryActions.id, edit.id))
			.get();
		expect(JSON.parse(before?.intentJson ?? "{}").sourceIds).toEqual(
			expect.arrayContaining([root.id, child.id]),
		);
		if (descendant)
			expect(
				JSON.parse(before?.intentJson ?? "{}").dependencyRepair.steps,
			).toEqual([expect.objectContaining({ originalId: descendant.id })]);
		expect(f.deleted).toEqual(expect.arrayContaining([root.id, child.id]));
		expect(
			f.db
				.select()
				.from(f.s.memorySourceRevisions)
				.where(awaitEq(f.s.memorySourceRevisions.id, child.id))
				.get(),
		).toMatchObject({ state: "repair_held", acceptedGeneration: generation });
		await setMemoryEnabled(h.userId, true);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		if (rejectRecovery) {
			for (let n = 0; n < 3; n++) {
				const job = f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(awaitEq(f.s.memoryDeliveryJobs.actionId, edit.id))
					.get();
				if (job?.status === "failed") break;
				f.db
					.update(f.s.memoryDeliveryJobs)
					.set({ runAfter: new Date(0) })
					.where(awaitEq(f.s.memoryDeliveryJobs.actionId, edit.id))
					.run();
				await h.engine.drain(f.jobs.memoryDeliveryJob);
			}
			expect(
				f.db
					.select()
					.from(f.s.memoryDeliveryJobs)
					.where(awaitEq(f.s.memoryDeliveryJobs.actionId, edit.id))
					.get(),
			).toMatchObject({ status: "failed", retryable: true, checkpoint: null });
			const action = f.db
				.select()
				.from(f.s.memoryActions)
				.where(awaitEq(f.s.memoryActions.id, edit.id))
				.get();
			const saved = JSON.parse(action?.intentJson ?? "{}");
			const firstRetain = f.retained.find(
				(r) => r.items[0].content === child.text,
			);
			expect(saved.dependencyRepair.steps).toEqual([
				expect.objectContaining({
					originalId: child.id,
					replacementId: firstRetain?.items[0].document_id,
					operationId: firstRetain?.operation_id,
				}),
			]);
			if (mode === "prior terminal attempt without saved plan") {
				// Before recovery plans were included in the action intent, a
				// terminal attempt left only its quarantined native source identity.
				delete saved.dependencyRepair;
				f.db
					.update(f.s.memoryActions)
					.set({ intentJson: JSON.stringify(saved) })
					.where(awaitEq(f.s.memoryActions.id, edit.id))
					.run();
			}
			rejectRecovery = false;
			await actions.submitMemoryAction(h.userId, request);
			await h.engine.drain(f.jobs.memoryDeliveryJob);
			if (mode === "prior terminal attempt without saved plan") {
				const retryRetain = f.retained
					.filter((r) => r.items[0].content === child.text)
					.at(-1);
				expect(retryRetain?.items[0].document_id).toBe(
					firstRetain?.items[0].document_id,
				);
				expect(retryRetain?.operation_id).not.toBe(firstRetain?.operation_id);
			}
		}
		expect(payloads.at(-1)).toMatchObject({
			source_assertions: [
				{
					assertion: child.text,
					originalSourceId: child.id,
					withdrawnContextSourceIds: [root.id],
				},
				...(descendant
					? [{ assertion: descendant.text, originalSourceId: descendant.id }]
					: []),
			],
			withdrawn_source_ids: [root.id],
			original_facts: expect.arrayContaining([
				{ id: `fact:${child.id}`, text: independent, sourceId: child.id },
			]),
		});
		expect(
			f.retained.filter((r) => r.items[0].content === root.text),
		).toHaveLength(0);
		expect(
			f.retained.filter((r) => r.items[0].content === child.text),
		).toHaveLength(
			mode === "prior terminal attempt without saved plan" ? 2 : 1,
		);
		const add = {
			kind: "add",
			scope: { kind: "personal" },
			text: "I play chess.",
			requestId: crypto.randomUUID(),
		};
		if (!keepIndependentFact) {
			expect(
				actions.getMemoryOperation(h.userId, { id: edit.id }),
			).toMatchObject({
				cleanupPending: true,
				errorCode: "memory_dependency_check_rejected",
			});
			await expect(
				actions.submitMemoryAction(h.userId, add),
			).rejects.toMatchObject({ code: "memory_action_pending" });
			return;
		}
		expect(actions.getMemoryOperation(h.userId, { id: edit.id })).toMatchObject(
			{
				status: "failed",
				errorCode: "memory_edit_cancelled",
				cleanupPending: false,
			},
		);
		f.db
			.update(f.s.memoryDeliveryJobs)
			.set({ runAfter: new Date(0) })
			.where(awaitEq(f.s.memoryDeliveryJobs.id, deletion.row.id))
			.run();
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(
			f.db
				.select()
				.from(f.s.memoryDeliveryJobs)
				.where(awaitEq(f.s.memoryDeliveryJobs.id, deletion.row.id))
				.get()?.status,
		).toBe("succeeded");
		const unrelated = await actions.submitMemoryAction(h.userId, add);
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		expect(
			actions.getMemoryOperation(h.userId, { id: unrelated.id }).status,
		).toBe("applied");
		expect(
			p
				.readPublishedMemory(h.userId, f.bank.id)
				.map(({ text }) => text)
				.sort(),
		).toEqual(
			[
				independent,
				"I play chess.",
				...(descendant ? [descendant.text] : []),
			].sort(),
		);
	},
);

it.each([
	"recovered",
	"response lost",
	"unexpected links",
	"already supported",
] as const)(
	"reconsolidates an unsupported acknowledged Edit fact at most once (%s)",
	async (mode) => {
		const oldName = "The touring kayak is named Meridian.";
		const newName = "The touring kayak is named Suncairn.";
		const green = "The touring kayak is green.";
		const f = await nativeFixture((text) =>
			text.includes('"kind":"source_edit"') ? [newName] : [text],
		);
		const original = f.source([], oldName);
		const independent = f.source([], green);
		f.seed(original);
		f.seed(independent);
		const publication = await import("./publication");
		const generation = f.db.transaction((tx) =>
			publication.publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				expectedRevision: 0,
				memories: [
					...f.facts.values(),
					...Array.from(f.facts.values(), (fact) => ({
						id: `observation:${fact.id}`,
						fact_type: "observation",
						text: fact.text,
						source_memory_ids: [fact.id],
					})),
				],
			}),
		);
		const retainedReplacementId = () =>
			`fact:${f.retained[0]?.items[0].document_id}`;
		const retriedFacts: string[] = [];
		f.setObservationText((fact) =>
			fact.id === retainedReplacementId() &&
			mode !== "already supported" &&
			(mode === "response lost" || !retriedFacts.includes(fact.id))
				? null
				: fact.text,
		);
		f.setObservationReset((id) => {
			retriedFacts.push(id);
			if (mode === "response lost")
				throw new Error("synthetic lost acknowledgement");
			return { deleted_count: mode === "unexpected links" ? 1 : 0 };
		});
		const checker = vi
			.fn(async (_prompt, payload: unknown): Promise<unknown> => {
				const input = payload as {
					displayed_observations?: Array<{ text: string }>;
				};
				return {
					valid:
						input.displayed_observations?.some(
							({ text }) => text === newName,
						) ?? true,
					issues: [],
				};
			})
			.mockResolvedValueOnce({
				forget: [],
				replace: ["Meridian to Suncairn"],
				preserve: [],
			})
			.mockResolvedValueOnce({
				facts: [{ id: `fact:${original.id}`, text: "" }],
			});
		vi.spyOn(await import("./curation"), "createCurationModel").mockReturnValue(
			withDatedNativeFacts(checker),
		);
		const { submitMemoryAction, getMemoryOperation } = await import(
			"./curation-actions"
		);
		const operation = await submitMemoryAction(h.userId, {
			kind: "edit",
			text: newName,
			requestId: randomUUID(),
			ref: {
				scope: { kind: "personal" },
				generation,
				rowId: `observation:fact:${original.id}`,
			},
		});
		await h.engine.drain(f.jobs.memoryDeliveryJob);
		if (mode === "response lost") {
			f.db
				.update(f.s.memoryDeliveryJobs)
				.set({ runAfter: new Date(0) })
				.where(awaitEq(f.s.memoryDeliveryJobs.actionId, operation.id))
				.run();
			await h.engine.drain(f.jobs.memoryDeliveryJob);
		}
		expect(retriedFacts).toEqual(
			mode === "already supported" ? [] : [retainedReplacementId()],
		);
		const published = publication
			.readPublishedMemory(h.userId, f.bank.id)
			.map(({ text }) => text);
		if (mode === "response lost" || mode === "unexpected links") {
			expect(published).toEqual(expect.arrayContaining([oldName, green]));
			expect(published).not.toContain(newName);
			expect(
				getMemoryOperation(h.userId, { id: operation.id }).status,
			).not.toBe("applied");
			return;
		}
		expect(getMemoryOperation(h.userId, { id: operation.id })).toMatchObject({
			status: "applied",
			cleanupPending: false,
		});
		expect(published).toEqual(expect.arrayContaining([newName, green]));
		expect(published).not.toContain(oldName);
	},
);

it("refuses to rebuild default history as a dependent, which no forget step could cover", async () => {
	const f = await nativeFixture();
	const root = f.source([], "I planted a maple tree.");
	const dependent = f.source([root.id], "I keep a community seed library.");
	// Preparation never gives default history a context; one that has one
	// is not something a repair may rebuild.
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			context: JSON.stringify({
				...JSON.parse(dependent.context),
				migration: true,
				migrationDefaultHistory: true,
			}),
		})
		.where(awaitEq(f.s.memorySourceRevisions.id, dependent.id))
		.run();
	for (const source of [root, dependent]) f.seed(source);
	const job = await f.remove(root);
	await h.engine.drain(f.jobs.memoryDeliveryJob);
	expect(
		f.db
			.select()
			.from(f.s.memoryDeliveryJobs)
			.where(awaitEq(f.s.memoryDeliveryJobs.id, job.row.id))
			.get(),
	).toMatchObject({
		status: "failed",
		retryable: false,
		errorCode: "memory_dependency_default_history",
	});
	expect(f.retained).toEqual([]);
});
