import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-migration");
});
afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});
async function seed() {
	const { db } = await import("$lib/server/db");
	const s = await import("$lib/server/db/schema");
	db.insert(s.conversations)
		.values({ id: "chat", userId: h.userId, title: "Synthetic" })
		.run();
	db.insert(s.messages)
		.values({
			id: "m",
			conversationId: "chat",
			role: "user",
			content: "My bicycle is blue. My dog is Rex.",
			createdAt: new Date("2020-01-01"),
		})
		.run();
	return { db, s };
}
it("inspect is read only when the enabled master switch permits older history", async () => {
	const { db, s } = await seed();
	const { inspectMemoryMigration } = await import("./migration");
	const report = inspectMemoryMigration(h.userId);
	expect(report.sources[0].eligibility).toBe("eligible");
	expect(db.select().from(s.memoryAccounts).all()).toHaveLength(0);
	expect(db.select().from(s.memoryMigrationManifests).all()).toHaveLength(0);
});
it("preparation checkpoints source jobs once, preserves dates, and refuses premature cutover", async () => {
	const { db, s } = await seed();
	const m = await import("./migration");
	const first = await m.prepareMemoryMigration(h.userId);
	await m.prepareMemoryMigration(h.userId);
	expect(db.select().from(s.memorySourceRevisions).all()).toHaveLength(1);
	expect(db.select().from(s.memoryDeliveryJobs).all()).toHaveLength(1);
	expect(db.select().from(s.memoryHistoryChoices).all()).toEqual([]);
	expect(db.select().from(s.memoryAccounts).get()?.historyChoice).toBeNull();
	expect(
		db.select().from(s.memorySourceRevisions).get()?.assertedAt.toISOString(),
	).toBe("2020-01-01T00:00:00.000Z");
	expect(() => m.cutoverMemoryMigration(h.userId, first.id)).toThrow(
		"memory_migration_not_ready",
	);
});
it("legacy writes cannot resume after the native authority switch", async () => {
	const { db, s } = await seed();
	const store = await import("./projection-store");
	const item = await store.createMemoryProfileItem({
		userId: h.userId,
		category: "about_you",
		scope: { type: "global" },
		statement: "Old",
	});
	db.insert(s.memoryAccounts)
		.values({ userId: h.userId, tenantId: "opaque", authority: "hindsight" })
		.run();
	await expect(
		store.updateMemoryProfileItemWithRevision({
			userId: h.userId,
			itemId: item.id,
			expectedProjectionRevision: item.projectionRevision,
			patch: { statement: "Late model output" },
		}),
	).rejects.toThrow("memory_legacy_authority_changed");
	await expect(
		store.mergeMemoryProfileItemMetadata({
			userId: h.userId,
			itemId: item.id,
			patch: { origin: "bad" },
		}),
	).rejects.toThrow("memory_legacy_authority_changed");
	expect(db.select().from(s.memoryProfileItems).get()?.statement).toBe("Old");
});
async function legacyItem(status = "suppressed", metadataJson = "{}") {
	const { db, s } = await seed();
	db.insert(s.memoryProjectionState)
		.values({ id: "projection", userId: h.userId, resetGeneration: 0 })
		.run();
	db.insert(s.memoryProfileItems)
		.values({
			id: "item",
			userId: h.userId,
			projectionStateId: "projection",
			itemKey: "key",
			category: "about_you",
			statement: "My bicycle is blue",
			status,
			metadataJson,
			suppressedAt: status === "suppressed" ? new Date("2021-01-01") : null,
			updatedAt: new Date("2021-01-01"),
		})
		.run();
	db.insert(s.memoryProfileItemProvenance)
		.values({
			id: "provenance",
			userId: h.userId,
			itemId: "item",
			sourceType: "conversation",
			sourceId: "chat",
			label: "Chat",
		})
		.run();
	return { db, s };
}
it("keeps a known withdrawal out of default historical inference", async () => {
	const { db, s } = await legacyItem();
	const migration = await import("./migration");
	expect(migration.inspectMemoryMigration(h.userId).sources).toContainEqual(
		expect.objectContaining({
			id: "m",
			eligibility: "excluded",
			reason: "known_withdrawal",
		}),
	);
	await migration.prepareMemoryMigration(h.userId);
	expect(db.select().from(s.memorySourceRevisions).all()).toEqual([]);
});

it("maps known indirect exclusions and retains unrelated source content for bounded native curation", async () => {
	const { db, s } = await legacyItem();
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const m = await import("./migration");
	const inventory = m.inspectMemoryMigration(h.userId);
	expect(inventory.actions[0].sourceIds).toEqual(["m"]);
	expect(inventory.holdHistory).toBe(false);
	await m.prepareMemoryMigration(h.userId);
	const action = db.select().from(s.memoryActions).get();
	expect(action?.previousText).toBe("My bicycle is blue");
	expect(action?.exclusionAcknowledged).toBe(true);
	expect(db.select().from(s.memorySourceRevisions).get()?.text).toContain(
		"My dog is Rex",
	);
});
it("review-only removal with unknown provenance holds history, never claims an empty successful import", async () => {
	const { db, s } = await seed();
	db.insert(s.memoryReviewItems)
		.values({
			id: "review",
			userId: h.userId,
			subjectKey: "k",
			subjectLabel: "s",
			question: "q",
			reason: "r",
			affectedItemIdsJson: '["missing"]',
		})
		.run();
	db.insert(s.memoryReviewResolutions)
		.values({
			id: "resolution",
			userId: h.userId,
			reviewItemId: "review",
			resolutionType: "do_not_remember",
		})
		.run();
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const m = await import("./migration");
	expect(m.inspectMemoryMigration(h.userId).holdHistory).toBe(true);
	await m.prepareMemoryMigration(h.userId);
	expect(db.select().from(s.memorySourceRevisions).all()).toHaveLength(0);
	expect(db.select().from(s.memoryAccounts).get()?.historyStatus).toBe("held");
});
it("a new exclusion after preparation creates a new source replay checkpoint", async () => {
	const { db, s } = await legacyItem("active");
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const m = await import("./migration");
	await m.prepareMemoryMigration(h.userId);
	db.update(s.memoryProfileItems)
		.set({ status: "suppressed", suppressedAt: new Date("2022-01-01") })
		.run();
	await m.prepareMemoryMigration(h.userId);
	expect(db.select().from(s.memoryDeliveryJobs).all()).toHaveLength(2);
});
/** Deterministic wire fixture, not evidence of native semantic quality. */
async function nativeFixture(
	options: {
		/** Strip a deleted document's facts from listed observations, as Hindsight does. */
		followDeletes?: boolean;
		/** Called for each observation that loses support but keeps some. */
		onSupportLost?: (observation: {
			text: string;
			source_memory_ids: string[];
		}) => void;
	} = {},
) {
	const fixtureOptions = options;
	const client = await import("./hindsight-client");
	const config = await import("$lib/server/config-store");
	const contracts = await import("./contracts");
	const curation = await import("./curation");
	vi.spyOn(config, "getConfig").mockReturnValue({
		...config.getConfig(),
		hindsightWorkerEnabled: true,
		hindsightConcurrency: 1,
	});
	const facts = new Map<
		string,
		{
			id: string;
			text: string;
			bank: string;
			fact_type: string;
			document_id: string;
			consolidated_at: string;
			mentioned_at?: string;
		}
	>();
	// Mention dates for the facts of the given documents, set when retained.
	const mentions = new Map<string, string>();
	const retained: string[] = [];
	const archived = new Map(facts);
	let interruptArchive = false;
	const hideObservation = new Set<string>();
	const extraObservations: Array<{
		id: string;
		text: string;
		fact_type: "observation";
		source_memory_ids: string[];
	}> = [];
	const deletedBanks = new Set<string>();
	const fetcher = vi.fn(
		async (url: RequestInfo | URL, options?: RequestInit) => {
			const path = String(url);
			const segments = new URL(path).pathname.split("/");
			const bank = segments[4];
			if (deletedBanks.has(bank)) return new Response("{}", { status: 404 });
			let data: unknown = {};
			if (options?.method === "DELETE" && segments.length === 5) {
				deletedBanks.add(bank);
				for (const [key, f] of facts) if (f.bank === bank) facts.delete(key);
			} else if (path.endsWith("/config"))
				data = { config: contracts.NATIVE_BANK_CONFIG };
			else if (path.endsWith("/memories") && options?.method === "POST") {
				const body = JSON.parse(String(options.body));
				for (const item of body.items) {
					retained.push(item.timestamp);
					facts.set(`${item.document_id}:fact`, {
						id: `${item.document_id}:fact`,
						text: item.content,
						bank,
						fact_type: "world",
						document_id: item.document_id,
						consolidated_at: "2026-11-18T00:00:00Z",
						...(mentions.has(item.document_id)
							? { mentioned_at: mentions.get(item.document_id) }
							: {}),
					});
				}
				data = { operation_id: body.operation_id };
			} else if (path.endsWith("/consolidate") && options?.method === "POST")
				data = { operation_id: "consolidate" };
			else if (path.includes("/operations?")) data = { operations: [] };
			else if (path.includes("/operations/")) data = { status: "completed" };
			else if (
				path.includes("/memories/list") ||
				path.endsWith("/memories/recall")
			) {
				const rows = [...facts.values()].filter((fact) => fact.bank === bank);
				const derived = rows
					.filter(
						(f) =>
							!hideObservation.has(f.id) &&
							!extraObservations.some((o) => o.id === `${f.id}:observation`),
					)
					.map((f) => ({
						id: `${f.id}:observation`,
						text: f.text,
						fact_type: "observation",
						source_memory_ids: [f.id],
					}));
				const items = [...rows, ...extraObservations, ...derived];
				data = path.endsWith("/memories/recall")
					? {
							results: [...extraObservations, ...derived]
								.filter((row) => row.id !== "unranked-new-family-overlap")
								.map((row) => ({
									id: row.id,
									text: row.text,
									type: row.fact_type,
									source_fact_ids: row.source_memory_ids,
								})),
						}
					: { total: items.length, offset: 0, items };
			} else if (options?.method === "PATCH" && path.includes("/memories/")) {
				const id = decodeURIComponent(path.split("/").at(-1) ?? "");
				const f = facts.get(id);
				if (f?.bank === bank) {
					const patch = JSON.parse(String(options.body));
					if (patch.state === "invalidated") {
						archived.set(id, f);
						facts.delete(id);
						for (let i = extraObservations.length - 1; i >= 0; i--)
							if (extraObservations[i].source_memory_ids.includes(id))
								extraObservations.splice(i, 1);
						if (interruptArchive) {
							interruptArchive = false;
							throw Error("synthetic_interruption_after_native_archive");
						}
					} else if (typeof patch.text === "string") f.text = patch.text;
				}
			} else if (path.includes("/memories/") && options?.method === "GET") {
				const id = decodeURIComponent(path.split("/").at(-1) ?? "");
				const archivedFact = archived.get(id);
				if (!archivedFact || archivedFact.bank !== bank)
					return new Response("{}", { status: 404 });
				data = {
					...archivedFact,
					state: "invalidated",
					type: archivedFact.fact_type,
				};
			} else if (options?.method === "DELETE" && path.includes("/documents/")) {
				const id = decodeURIComponent(path.split("/").at(-1) ?? "");
				for (const [key, f] of facts)
					if (f.bank === bank && f.document_id === id) {
						facts.delete(key);
						if (!fixtureOptions.followDeletes) continue;
						for (let i = extraObservations.length - 1; i >= 0; i--) {
							const o = extraObservations[i];
							if (!o.source_memory_ids.includes(key)) continue;
							o.source_memory_ids = o.source_memory_ids.filter(
								(x) => x !== key,
							);
							if (o.source_memory_ids.length) fixtureOptions.onSupportLost?.(o);
							if (!o.source_memory_ids.length) extraObservations.splice(i, 1);
						}
					}
			}
			return new Response(JSON.stringify(data));
		},
	);
	vi.spyOn(client, "configuredNativeBinding").mockReturnValue({
		baseUrl: "http://synthetic",
		credentialHash: "synthetic",
	});
	vi.spyOn(client, "nativeMemoryClient").mockImplementation(
		(bankId) =>
			new client.HindsightClient({
				baseUrl: "http://synthetic",
				apiKey: "synthetic",
				bankId,
				fetcher,
			}),
	);
	const curationInputs: unknown[] = [];
	vi.spyOn(curation, "createCurationModel").mockReturnValue(
		async (_prompt, input, schema) => {
			curationInputs.push(input);
			const v = input as Record<string, unknown>;
			const props = schema.properties as Record<string, unknown>;
			if (props.forget)
				return { forget: ["blue bicycle"], replace: [], preserve: ["dog"] };
			if (props.valid) return { valid: true, issues: [] };
			return {
				facts: (v.facts as { id: string; text: string }[]).map((f) => ({
					...f,
					text: f.text.replace(
						"My bicycle is blue. ",
						typeof v.user_saved_after === "string" && v.user_saved_after
							? `${v.user_saved_after}. `
							: "",
					),
				})),
			};
		},
	);
	return {
		facts,
		retained,
		fetcher,
		curationInputs,
		extraObservations,
		archived,
		hideObservation,
		mentions,
		deletedBanks,
		interruptNextArchive: () => {
			interruptArchive = true;
		},
	};
}
it("runs legacy exclusion through the real job engine and shared bounded curation before atomic cutover", async () => {
	const { db, s } = await legacyItem();
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const f = await nativeFixture();
	const m = await import("./migration");
	const manifest = await m.prepareMemoryMigration(h.userId);
	const jobs = await import("./delivery-job");
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(db.select().from(s.memoryDeliveryJobs).get()?.status).toBe(
		"succeeded",
	);
	expect(f.retained).toEqual(["2020-01-01T00:00:00.000Z"]);
	expect(db.select().from(s.memoryPublishedRows).get()?.text).toBe(
		"My dog is Rex.",
	);
	expect(m.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(true);
	m.cutoverMemoryMigration(h.userId, manifest.id);
	expect(db.select().from(s.memoryAccounts).get()?.authority).toBe("hindsight");
});

async function keepPriorHistoryDecline() {
	const { recordHistoryImportChoice } = await import("./migration-policy");
	await recordHistoryImportChoice(h.userId, {
		choice: "decline",
		requestId: "prior-decline",
	});
}

it("allows empty native cutover while an earlier decline still holds chat history", async () => {
	const { db, s } = await seed();
	await keepPriorHistoryDecline();
	await nativeFixture();
	const m = await import("./migration");
	const manifest = await m.prepareMemoryMigration(h.userId);
	const { getHistoryImportStatus } = await import("./migration-policy");
	expect((await getHistoryImportStatus(h.userId)).available).toBe(true);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	expect(m.verifyMemoryMigration(h.userId, manifest.id).uncertain).toBe(1);
	m.cutoverMemoryMigration(h.userId, manifest.id);
	expect(db.select().from(s.memoryAccounts).get()?.historyStatus).toBe("held");
	expect(db.select().from(s.memorySourceRevisions).all()).toHaveLength(0);
});
it("permission withdrawal after enqueue prevents historical dispatch", async () => {
	const { db, s } = await seed();
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "include",
	});
	const f = await nativeFixture();
	const m = await import("./migration");
	await m.prepareMemoryMigration(h.userId);
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "decline",
		requestId: "decline",
	});
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	expect(f.retained).toHaveLength(0);
	expect(db.select().from(s.memorySourceRevisions).get()?.state).toBe(
		"revoked",
	);
});

it.each(["prepare", "first toggle on", "off then on"] as const)(
	"uses persisted second boundaries for historical permission after %s",
	async (boundary) => {
		const { db, s } = await seed();
		const m = await import("./migration");
		const policy = await import("./migration-policy");
		const { memoryDeliveryJob } = await import("./delivery-job");
		const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } =
			await import("./chat-delivery");
		const native = await migrationReplayNative();
		const boundaryAt = Date.parse("2026-01-01T12:00:00.000Z");
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(boundaryAt - 1_000);
			if (boundary === "off then on")
				await policy.setMemoryEnabled(h.userId, false);
			if (boundary === "first toggle on")
				db.update(s.users).set({ memoryEnabled: false }).run();
			db.update(s.messages)
				.set({ createdAt: new Date(boundaryAt + 100) })
				.run();
			vi.setSystemTime(boundaryAt + 900);
			if (boundary !== "prepare") await policy.setMemoryEnabled(h.userId, true);
			await m.prepareMemoryMigration(h.userId);
			expect(db.select().from(s.messages).get()?.createdAt.getTime()).toBe(
				boundaryAt,
			);
			expect(
				db
					.select()
					.from(s.memoryControlIntervals)
					.all()
					.at(-1)
					?.startedAt.getTime(),
			).toBe(boundaryAt);
			const historicalSource = () =>
				m.inspectMemoryMigration(h.userId).sources.find(({ id }) => id === "m");
			expect
				.soft(historicalSource())
				.toMatchObject(
					boundary === "off then on"
						? { eligibility: "excluded", reason: "known_off" }
						: { eligibility: "uncertain", reason: "unknown_history" },
				);
			expect
				.soft((await policy.getHistoryImportStatus(h.userId)).shouldPrompt)
				.toBe(boundary !== "off then on");
			await h.engine.drain(memoryDeliveryJob);
			expect.soft(native.requests).toHaveLength(0);

			if (boundary === "prepare") {
				db.insert(s.conversations)
					.values({ id: "live", userId: h.userId, title: "Synthetic live" })
					.run();
				const stamp = captureMemoryTurnAcceptance(h.userId, "live");
				db.insert(s.messages)
					.values([
						{
							id: "live-user",
							conversationId: "live",
							messageSequence: 1,
							role: "user",
							content: "I restore fountain pens.",
							createdAt: new Date(),
						},
						{
							id: "live-assistant",
							conversationId: "live",
							messageSequence: 2,
							role: "assistant",
							content: "Understood.",
							createdAt: new Date(),
						},
					])
					.run();
				await deliverCompletedMemoryTurn({
					userId: h.userId,
					conversationId: "live",
					memoryAcceptance: stamp,
					userMessageId: "live-user",
					assistantMessageId: "live-assistant",
				});
				await h.engine.drain(memoryDeliveryJob);
				expect(native.requests.map(({ item }) => item.content)).toContain(
					"I restore fountain pens.",
				);
			}

			vi.setSystemTime(boundaryAt + 2_000);
			db.insert(s.messages)
				.values({
					id: "later",
					conversationId: "chat",
					role: "user",
					content: "I paint garden signs.",
					createdAt: new Date(boundaryAt + 1_000),
				})
				.run();
			await m.prepareMemoryMigration(h.userId);
			await h.engine.drain(memoryDeliveryJob);
			const retainedText = () =>
				native.requests.map(({ item }) => item.content);
			expect(retainedText()).toContain("I paint garden signs.");
			expect
				.soft(JSON.stringify(native.requests))
				.not.toContain("My dog is Rex.");
			await policy.recordHistoryImportChoice(h.userId, {
				choice: "include",
				requestId: "explicit-include-boundary",
			});
			await h.engine.drain(memoryDeliveryJob);
			if (boundary === "off then on")
				expect(JSON.stringify(native.requests)).not.toContain("My dog is Rex.");
			else
				expect(retainedText()).toContain("My bicycle is blue. My dog is Rex.");
		} finally {
			vi.useRealTimers();
		}
	},
);

it.each([
	"enabled",
	"disabled",
	"disabled before preparation",
	"interrupted older decline",
] as const)(
	"withdraws only optional imported history before follow-up preparation (%s)",
	async (mode) => {
		const { db, s } = await legacyItem("active", '{"origin":"user_authored"}');
		const { eq } = await import("drizzle-orm");
		const m = await import("./migration");
		const policy = await import("./migration-policy");
		const { memoryDeliveryJob } = await import("./delivery-job");
		const { getMemoryDetail, listMemory } = await import("./native-read");
		const { readPublishedMemory } = await import("./publication");
		const { recallMemory } = await import("../memory-context/native");
		const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } =
			await import("./chat-delivery");
		const { createMessage } = await import("../messages");
		const native = await migrationReplayNative();
		const knownOn = "I catalogue river stones.";
		const live = "I restore fountain pens.";
		const authored = "I maintain a seed archive.";
		const unknown = "My dog is Rex.";
		const scope = { kind: "personal" } as const;
		db.delete(s.memoryProfileItemProvenance).run();
		db.update(s.memoryProfileItems).set({ statement: authored }).run();
		db.insert(s.memoryControlIntervals)
			.values({
				id: "known-on",
				userId: h.userId,
				enabled: true,
				epoch: 0,
				startedAt: new Date("2021-01-01"),
			})
			.run();
		db.insert(s.conversations)
			.values([
				{ id: "known", userId: h.userId, title: "Synthetic known on" },
				{ id: "live", userId: h.userId, title: "Synthetic live" },
			])
			.run();
		db.insert(s.messages)
			.values({
				id: "known-on-user",
				conversationId: "known",
				role: "user",
				content: knownOn,
				createdAt: new Date("2022-01-01"),
			})
			.run();
		await policy.recordHistoryImportChoice(h.userId, {
			choice: "include",
			requestId: "first-include",
		});
		const prepared = await m.prepareMemoryMigration(h.userId);
		await h.engine.drain(memoryDeliveryJob);
		expect(m.cutoverMemoryMigration(h.userId, prepared.id).ready).toBe(true);
		const page = () => listMemory(h.userId, { scope });
		const accepted = page().rows.find(({ text }) => text === unknown);
		const sources = () => db.select().from(s.memorySourceRevisions).all();
		const original = sources().find(({ messageId }) => messageId === "m");
		if (!accepted || !original) throw Error("included source was not accepted");
		const stamp = captureMemoryTurnAcceptance(h.userId, "live");
		const user = await createMessage("live", "user", live);
		const assistant = await createMessage("live", "assistant", "Understood.");
		await deliverCompletedMemoryTurn({
			userId: h.userId,
			conversationId: "live",
			userMessageId: user.id,
			assistantMessageId: assistant.id,
			memoryAcceptance: stamp,
		});
		await h.engine.drain(memoryDeliveryJob);
		const recall = async () =>
			(
				await recallMemory(h.userId, {
					conversationId: "live",
					query: "Memory",
					tokenBudget: 200,
				})
			).map(({ text }) => text);
		expect(page().rows.map(({ text }) => text)).toEqual(
			expect.arrayContaining([unknown, knownOn, live, authored]),
		);
		expect(await recall()).toContain(unknown);
		expect(getMemoryDetail(h.userId, accepted.ref).row.text).toBe(unknown);
		expect(page().generation).not.toBe(accepted.ref.generation);
		const survivingIds = () =>
			sources()
				.filter(
					({ state, text }) =>
						state === "accepted" && [knownOn, live, authored].includes(text),
				)
				.map(({ id }) => id)
				.sort();
		const originalSurvivors = survivingIds();
		expect(originalSurvivors).toHaveLength(3);
		const decline = {
			choice: "decline",
			requestId: "withdraw-optional-history",
		} as const;
		const paused =
			mode === "disabled" || mode === "disabled before preparation";
		const retainedBeforePause = native.requests.length;
		if (mode === "disabled") {
			const previouslyAccepted = sources()
				.filter(({ state }) => state === "accepted")
				.map(({ id }) => id);
			await policy.setMemoryEnabled(h.userId, false);
			await m.prepareMemoryMigration(h.userId);
			expect
				.soft(
					sources()
						.filter(({ state }) => state === "accepted")
						.map(({ id }) => id),
				)
				.toEqual(previouslyAccepted);
		}
		if (mode === "interrupted older decline") {
			const now = new Date();
			db.insert(s.memoryHistoryChoices)
				.values({
					id: "older-receipt",
					userId: h.userId,
					requestId: decline.requestId,
					choice: decline.choice,
					cutoff: now,
					decidedAt: now,
					policyVersion: "1",
					epoch: 0,
				})
				.run();
			db.update(s.memoryAccounts)
				.set({
					historyChoice: "decline",
					historyCutoff: now,
					historyDecidedAt: now,
					historyPolicyVersion: "1",
				})
				.run();
		}
		const prepareMigration = m.prepareMemoryMigration;
		const prepare = vi.spyOn(m, "prepareMemoryMigration");
		if (mode === "disabled before preparation") {
			prepare.mockImplementationOnce(async (userId) => {
				await policy.setMemoryEnabled(userId, false);
				return prepareMigration(userId);
			});
		}
		if (paused) {
			await expect(
				policy.recordHistoryImportChoice(h.userId, decline),
			).resolves.toMatchObject({ choice: "decline" });
		} else {
			prepare.mockRejectedValueOnce(
				new Error("synthetic interruption after choice"),
			);
			await expect(
				policy.recordHistoryImportChoice(h.userId, decline),
			).rejects.toThrow("synthetic interruption after choice");
		}
		const cleanup = () =>
			db
				.select()
				.from(s.memoryDeliveryJobs)
				.where(
					eq(s.memoryDeliveryJobs.requestId, `source-cleanup:${original.id}`),
				)
				.get();
		expect
			.soft(db.select().from(s.memoryAccounts).get()?.historyChoice)
			.toBe("decline");
		expect
			.soft(sources().find(({ id }) => id === original.id)?.state)
			.toBe("revoked");
		expect.soft(cleanup()).toMatchObject({
			kind: "source_cleanup",
			sourceId: original.id,
			bankId: original.bankId,
			status: "queued",
		});
		expect
			.soft(
				sources()
					.filter(({ state }) => state === "accepted")
					.map(({ text }) => text),
			)
			.toEqual(expect.arrayContaining([knownOn, live, authored]));
		if (!paused) {
			expect
				.soft(
					page()
						.rows.map(({ text }) => text)
						.sort(),
				)
				.toEqual([knownOn, live, authored].sort());
			expect
				.soft(() => getMemoryDetail(h.userId, accepted.ref))
				.toThrow("stale_memory");
			expect
				.soft(
					readPublishedMemory(
						h.userId,
						original.bankId,
						accepted.ref.generation,
					).map(({ text }) => text),
				)
				.not.toContain(unknown);
			expect
				.soft((await recall()).sort())
				.toEqual([knownOn, live, authored].sort());
		}
		// Check cleanup before a successful retry in the interrupted cases.
		await h.engine.drain(memoryDeliveryJob);
		expect.soft(cleanup()?.status).toBe("succeeded");
		expect
			.soft(
				[...(native.banks.get(original.bankId)?.values() ?? [])].some(
					({ document_id }) => document_id === original.id,
				),
			)
			.toBe(false);
		if (paused) {
			expect.soft(native.requests).toHaveLength(retainedBeforePause);
			await policy.setMemoryEnabled(h.userId, true);
			expect
				.soft(
					page()
						.rows.map(({ text }) => text)
						.sort(),
				)
				.toEqual([knownOn, live, authored].sort());
			expect
				.soft((await recall()).sort())
				.toEqual([knownOn, live, authored].sort());
		}
		prepare.mockRestore();
		await policy.recordHistoryImportChoice(h.userId, decline);
		await h.engine.drain(memoryDeliveryJob);
		expect.soft(survivingIds()).toEqual(originalSurvivors);
		expect
			.soft((await recall()).sort())
			.toEqual([knownOn, live, authored].sort());
		if (paused) expect.soft(native.requests).toHaveLength(retainedBeforePause);
		expect.soft(db.select().from(s.memoryHistoryChoices).all()).toHaveLength(2);
		expect
			.soft(
				db
					.select()
					.from(s.memoryDeliveryJobs)
					.all()
					.filter(
						({ requestId }) => requestId === `source-cleanup:${original.id}`,
					),
			)
			.toHaveLength(1);
	},
);

it("rolls back history decline if its cleanup cannot be durably queued", async () => {
	const { db, s } = await seed();
	const m = await import("./migration");
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "initial-include",
	});
	await m.prepareMemoryMigration(h.userId);
	h.sqlite.exec(`CREATE TRIGGER fail_history_cleanup BEFORE INSERT ON memory_delivery_jobs
		WHEN NEW.kind = 'source_cleanup' BEGIN SELECT RAISE(ABORT, 'synthetic cleanup insert failure'); END`);
	await expect(
		policy.recordHistoryImportChoice(h.userId, {
			choice: "decline",
			requestId: "atomic-decline",
		}),
	).rejects.toThrow("synthetic cleanup insert failure");
	expect
		.soft(db.select().from(s.memoryAccounts).get()?.historyChoice)
		.toBe("include");
	expect
		.soft(
			db
				.select()
				.from(s.memoryHistoryChoices)
				.all()
				.map(({ choice }) => choice),
		)
		.toEqual(["include"]);
	expect(db.select().from(s.memorySourceRevisions).get()?.state).toBe(
		"pending",
	);
	expect(db.select().from(s.memoryRevocations).all()).toHaveLength(0);
});
it("rollback refuses to revive legacy state after a post-cutover removal", async () => {
	const { db, s } = await seed();
	await nativeFixture();
	const m = await import("./migration");
	const manifest = await m.prepareMemoryMigration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	m.cutoverMemoryMigration(h.userId, manifest.id);
	const bank = db.select().from(s.memoryBanks).get();
	if (!bank) throw Error("fixture");
	db.insert(s.memoryRevocations)
		.values({
			id: "revoked",
			userId: h.userId,
			bankId: bank.id,
			epoch: 0,
			nativeFactId: "native",
		})
		.run();
	m.cutoverMemoryMigration(h.userId, manifest.id); // idempotent; must not reset the rollback privacy baseline.
	expect(m.rollbackMemoryMigration(h.userId, manifest.id)).toEqual({
		available: false,
	});
	expect(db.select().from(s.memoryAccounts).get()?.authority).toBe("hindsight");
	expect(db.select().from(s.memoryAccounts).get()?.lifecycleState).toBe(
		"rollback_blocked",
	);
});
it("preserves authored standalone statements but never seeds generated endorsements", async () => {
	const { db, s } = await legacyItem("active", '{"origin":"user_authored"}');
	await keepPriorHistoryDecline();
	db.delete(s.memoryProfileItemProvenance).run();
	db.insert(s.memoryProfileItems)
		.values({
			id: "generated",
			userId: h.userId,
			projectionStateId: "projection",
			itemKey: "generated",
			category: "about_you",
			statement: "Generated portrait",
			metadataJson: '{"origin":"judge","endorsement":"user_accepted"}',
		})
		.run();
	const m = await import("./migration");
	await m.prepareMemoryMigration(h.userId);
	const sources = db.select().from(s.memorySourceRevisions).all();
	expect(sources).toHaveLength(1);
	expect(sources[0].text).toBe("My bicycle is blue");
	expect(sources[0].assertedAt.toISOString()).toBe("2021-01-01T00:00:00.000Z");
});
it("detects catch-up source deletion and a changed snapshot before cutover", async () => {
	const { db, s } = await seed();
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const m = await import("./migration");
	const f = await nativeFixture();
	const manifest = await m.prepareMemoryMigration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	db.delete(s.messages).run();
	expect(m.verifyMemoryMigration(h.userId, manifest.id).changed).toBe(true);
	expect(() => m.cutoverMemoryMigration(h.userId, manifest.id)).toThrow(
		"memory_migration_not_ready",
	);
	await m.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(db.select().from(s.memorySourceRevisions).get()?.state).toBe(
		"revoked",
	);
	expect(f.facts.size).toBe(0);
});
it("rejects another user's manifest and missing native capability attestation", async () => {
	const { db, s } = await seed();
	const m = await import("./migration");
	const manifest = await m.prepareMemoryMigration(h.userId);
	expect(() => m.verifyMemoryMigration("other", manifest.id)).toThrow(
		"memory_migration_missing",
	);
	// No native configuration or capability check has run.
	expect(() => m.cutoverMemoryMigration(h.userId, manifest.id)).toThrow(
		"memory_migration_not_ready",
	);
	expect(db.select().from(s.memoryAccounts).get()?.authority).toBe("preparing");
});
it("fork copies and known off/incognito sources never enter prepared banks", async () => {
	const { db, s } = await seed();
	db.insert(s.messages)
		.values({
			id: "fork",
			conversationId: "chat",
			role: "user",
			content: "My bicycle is blue.",
			createdAt: new Date("2022-01-01"),
			metadataJson: JSON.stringify({ forkCopy: { sourceMessageId: "m" } }),
		})
		.run();
	db.insert(s.memoryControlIntervals)
		.values({
			id: "off",
			userId: h.userId,
			enabled: false,
			epoch: 0,
			startedAt: new Date("2019-01-01"),
			endedAt: new Date("2021-01-01"),
		})
		.run();
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const m = await import("./migration");
	const report = m.inspectMemoryMigration(h.userId);
	expect(report.sources.map((x) => x.reason)).toEqual([
		"known_off",
		"fork_copy",
	]);
	await m.prepareMemoryMigration(h.userId);
	expect(db.select().from(s.memorySourceRevisions).all()).toHaveLength(0);
});
it("real-mode execution guards run against an isolated synthetic database only", async () => {
	const { execFileSync } = await import("node:child_process");
	await seed();
	const args = [
		"--import",
		"tsx",
		"scripts/memory-backfill.ts",
		"--database",
		h.fixture.dbPath,
		"--user",
		h.userId,
		"--mode",
		"prepare",
	];
	expect(() =>
		execFileSync(process.execPath, args, { stdio: "pipe" }),
	).toThrow();
	const result = execFileSync(
		process.execPath,
		[
			...args,
			"--execute",
			"yes",
			"--operator-ack",
			"approved-per-user-migration",
		],
		{ encoding: "utf8", stdio: "pipe" },
	);
	expect(JSON.parse(result)).toMatchObject({ uncertain: 0, ready: false });
});
it("rollout provisions only genuinely new accounts atomically, even while the native worker is paused", async () => {
	const { db, s } = await seed();

	const config = await import("$lib/server/config-store");
	vi.spyOn(config, "getConfig").mockReturnValue({
		...config.getConfig(),
		hindsightNewAccountsEnabled: true,
		hindsightWorkerEnabled: false,
	});
	const { createManagedUser } = await import("../user-admin");
	const created = await createManagedUser({
		email: "new-native@test.invalid",
		password: "synthetic-password-123",
	});
	expect(
		db
			.select()
			.from(s.memoryAccounts)
			.all()
			.find((a) => a.userId === created.id)?.authority,
	).toBe("hindsight");
	expect(
		db
			.select()
			.from(s.memoryControlIntervals)
			.all()
			.find((a) => a.userId === created.id)?.enabled,
	).toBe(true);
	expect(
		db
			.select()
			.from(s.memoryAccounts)
			.all()
			.find((a) => a.userId === h.userId),
	).toBeUndefined();
});
it("missing edit dates hold only the edited source and survive resume", async () => {
	const { db, s } = await seed();
	const p = await import("./migration-policy");
	await p.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const m = await import("./migration");
	await m.prepareMemoryMigration(h.userId);
	db.update(s.messages).set({ content: "My bicycle is green." }).run();
	expect(m.inspectMemoryMigration(h.userId).sources[0].eligibility).toBe(
		"held",
	);
	await m.prepareMemoryMigration(h.userId);
	expect(
		m
			.inspectMemoryMigration(h.userId)
			.exceptions.some((e) => e.reason === "unknown_source_edit_date"),
	).toBe(true);
});
it("reset after enqueue fences old history at the final native boundary", async () => {
	await seed();
	const p = await import("./migration-policy");
	await p.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const f = await nativeFixture();
	const m = await import("./migration");
	await m.prepareMemoryMigration(h.userId);
	const { advanceMemoryResetGeneration } = await import("./reset-generation");
	await advanceMemoryResetGeneration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	expect(f.retained).toHaveLength(0);
	expect(m.inspectMemoryMigration(h.userId).sources[0].reason).toBe(
		"pre_reset",
	);
});
it("a new explicit statement after a known removal is not a permanent topic ban", async () => {
	const { db, s } = await legacyItem();
	db.insert(s.messages)
		.values({
			id: "new",
			conversationId: "chat",
			role: "user",
			content: "My bicycle is blue again",
			createdAt: new Date("2022-01-01"),
		})
		.run();
	const p = await import("./migration-policy");
	await p.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const m = await import("./migration");
	const inventory = m.inspectMemoryMigration(h.userId);
	expect(inventory.actions[0].sourceIds).toEqual(["m"]);
	expect(inventory.sources.find((s) => s.id === "new")?.eligibility).toBe(
		"eligible",
	);
});
it("project-only source preparation also provisions the empty personal scope for cutover", async () => {
	const { db, s } = await seed();
	db.insert(s.projects)
		.values({ id: "project", userId: h.userId, name: "Synthetic project" })
		.run();
	db.update(s.conversations).set({ projectId: "project" }).run();
	const p = await import("./migration-policy");
	await p.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	const m = await import("./migration");
	await m.prepareMemoryMigration(h.userId);
	const banks = db.select().from(s.memoryBanks).all();
	const jobs = db.select().from(s.memoryDeliveryJobs).all();
	expect(jobs.find((j) => j.kind === "provision")?.bankId).toBe(
		banks.find((b) => b.scopeKey === "personal")?.id,
	);
	expect(jobs.find((j) => j.kind === "source")?.bankId).toBe(
		banks.find((b) => b.scopeKey === "project:project")?.id,
	);
});
it("review evidence resolves indirect provenance IDs without semantic guessing", async () => {
	const { db, s } = await legacyItem("active");
	db.insert(s.memoryReviewItems)
		.values({
			id: "review",
			userId: h.userId,
			subjectKey: "k",
			subjectLabel: "s",
			question: "q",
			reason: "r",
			affectedItemIdsJson: '["item"]',
			evidenceJson: '[{"sourceId":"provenance"}]',
		})
		.run();
	db.insert(s.memoryReviewResolutions)
		.values({
			id: "resolution",
			userId: h.userId,
			reviewItemId: "review",
			resolutionType: "do_not_remember",
		})
		.run();
	const m = await import("./migration");
	const inventory = m.inspectMemoryMigration(h.userId);
	expect(
		inventory.actions.find((a) => a.id === "review:resolution")?.sourceIds,
	).toEqual(["m"]);
	expect(inventory.holdHistory).toBe(false);
});
it("a known deleted source is a bounded exception rather than a whole-user history hold", async () => {
	const { db, s } = await legacyItem();
	db.update(s.memoryProfileItemProvenance)
		.set({ sourceId: "deleted-chat" })
		.run();
	const m = await import("./migration");
	const inventory = m.inspectMemoryMigration(h.userId);
	expect(inventory.exceptions[0].reason).toBe("missing_source");
	expect(inventory.holdHistory).toBe(false);
});

it("invalid native tenant capability never activates an account", async () => {
	const { db, s } = await seed();
	await nativeFixture();
	const client = await import("./hindsight-client");
	vi.spyOn(client, "nativeMemoryClient").mockImplementation(() => {
		throw new client.NativeMemoryError("native_capability_mismatch", false);
	});
	const m = await import("./migration");
	const manifest = await m.prepareMemoryMigration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	expect(() => m.cutoverMemoryMigration(h.userId, manifest.id)).toThrow(
		"memory_migration_not_ready",
	);
	expect(db.select().from(s.memoryAccounts).get()?.authority).toBe("preparing");
});
it("a paused real legacy judge cannot write its late model result after cutover", async () => {
	const { db, s } = await seed();
	await nativeFixture();
	const control = await import("../memory-control-model");
	let release: () => void = () => {};
	let entered: () => void = () => {};
	const paused = new Promise<void>((r) => (release = r));
	const waiting = new Promise<void>((r) => (entered = r));
	vi.spyOn(control, "callMemoryControlModel").mockImplementation(async () => {
		entered();
		await paused;
		return {
			text: JSON.stringify({
				decisions: [
					{
						action: "add",
						statement: "My bicycle is blue.",
						category: "about_you",
						scope: "global",
						confidence: "stated",
						expiryClass: "durable",
						sourceQuote: "My bicycle is blue",
					},
				],
			}),
			data: null,
			modelId: "model1",
			modelDisplayName: "Synthetic",
		};
	});
	const { runMemoryJudgeOnSegment } = await import("../memory-judge");
	const old = runMemoryJudgeOnSegment({
		userId: h.userId,
		conversationId: "chat",
		trigger: "explicit",
		segmentOverride: [{ role: "user", content: "My bicycle is blue" }],
	}).catch((error) => error);
	await waiting;
	const m = await import("./migration");
	const manifest = await m.prepareMemoryMigration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	m.cutoverMemoryMigration(h.userId, manifest.id);
	release();
	const outcome = await old;
	expect(outcome).toMatchObject({ message: "memory_legacy_authority_changed" });
	expect(db.select().from(s.memoryProfileItems).all()).toHaveLength(0);
	const { usesNativeMemory } = await import("./chat-delivery");
	expect(usesNativeMemory(h.userId)).toBe(true);
});

it("review-authored corrections retain their original action date and bounded source edit", async () => {
	const { db, s } = await legacyItem("retired");
	db.insert(s.memoryReviewItems)
		.values({
			id: "review",
			userId: h.userId,
			subjectKey: "k",
			subjectLabel: "s",
			question: "q",
			reason: "r",
			affectedItemIdsJson: '["item"]',
		})
		.run();
	db.insert(s.memoryReviewResolutions)
		.values({
			id: "resolution",
			userId: h.userId,
			reviewItemId: "review",
			resolutionType: "edit_fact",
			editedStatement: "My bicycle is green",
			createdAt: new Date("2021-01-01"),
		})
		.run();
	const p = await import("./migration-policy");
	await p.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	await nativeFixture();
	const m = await import("./migration");
	await m.prepareMemoryMigration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	const sources = db.select().from(s.memorySourceRevisions).all();
	expect(
		sources
			.find((x) => x.eventId === "authored:review:resolution")
			?.assertedAt.toISOString(),
	).toBe("2021-01-01T00:00:00.000Z");
	expect(
		db
			.select()
			.from(s.memoryPublishedRows)
			.all()
			.some((x) => x.text.includes("My dog is Rex")),
	).toBe(true);
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.all()
			.every((j) => j.status === "succeeded"),
	).toBe(true);
});
it("holds a review-only edit without current support while reconciling an inactive migration", async () => {
	const { db, s } = await legacyItem("retired");
	const expiresAt = new Date(Date.now() + 60_000);
	db.insert(s.projects)
		.values({ id: "other-project", userId: h.userId, name: "Other project" })
		.run();
	db.insert(s.memoryProfileItems)
		.values([
			{
				id: "older-current",
				userId: h.userId,
				projectionStateId: "projection",
				itemKey: "older-current",
				category: "about_you",
				statement: "My bicycle is green",
				expiresAt,
			},
			{
				id: "wrong-scope-match",
				userId: h.userId,
				projectionStateId: "projection",
				itemKey: "wrong-scope-match",
				category: "about_you",
				statement: "My bicycle is green",
				scopeType: "project",
				scopeId: "other-project",
			},
			{
				id: "newer-current",
				userId: h.userId,
				projectionStateId: "projection",
				itemKey: "newer-current",
				category: "about_you",
				statement: "My dog is Rex",
			},
		])
		.run();
	for (const [id, editedStatement] of [
		["older", "My bicycle is green"],
		["newer", "My dog is Rex"],
		["unlocated", null],
	] as const) {
		db.insert(s.memoryReviewItems)
			.values({
				id,
				userId: h.userId,
				subjectKey: id,
				subjectLabel: id,
				question: "Review",
				reason: "Synthetic",
				affectedItemIdsJson: id === "unlocated" ? '["missing"]' : '["item"]',
			})
			.run();
		db.insert(s.memoryReviewResolutions)
			.values({
				id,
				userId: h.userId,
				reviewItemId: id,
				resolutionType: editedStatement ? "edit_fact" : "do_not_remember",
				editedStatement,
				createdAt: new Date("2021-01-02"),
			})
			.run();
	}
	await allowMigrationHistory();
	const f = await nativeFixture();
	const m = await import("./migration");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const { readPublishedMemory } = await import("./publication");
	const manifest = await m.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(m.inspectMemoryMigration(h.userId).holdHistory).toBe(true);
	expect(m.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(true);
	const bank = db.select().from(s.memoryBanks).get();
	if (!bank) throw new Error("Missing synthetic bank");
	const published = () =>
		readPublishedMemory(h.userId, bank.id).map((row) => row.text);
	expect(published()).toEqual(
		expect.arrayContaining(["My bicycle is green", "My dog is Rex"]),
	);

	vi.spyOn(Date, "now").mockReturnValue(expiresAt.getTime());
	expect(m.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(false);
	expect(() => m.cutoverMemoryMigration(h.userId, manifest.id)).toThrow(
		"memory_migration_not_ready",
	);
	expect(m.inspectMemoryMigration(h.userId).exceptions).toContainEqual(
		expect.objectContaining({
			id: "authored:review:older",
			reason: "review_current_support_missing",
		}),
	);
	expect((await m.prepareMemoryMigration(h.userId)).id).toBe(manifest.id);
	expect(m.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(false);
	await h.engine.drain(memoryDeliveryJob);
	expect(db.select().from(s.memorySourceRevisions).all()).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				eventId: "authored:review:older",
				state: "revoked",
			}),
			expect.objectContaining({
				eventId: "authored:review:newer",
				state: "accepted",
			}),
		]),
	);
	expect([...f.facts.values()].map(({ text }) => text)).toEqual([
		"My dog is Rex",
	]);
	expect(published()).toEqual(["My dog is Rex"]);
	expect(m.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(true);
});
it("missing accepted source checkpoints cannot be called a complete migration", async () => {
	const { db, s } = await seed();
	const p = await import("./migration-policy");
	await p.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "yes",
	});
	await nativeFixture();
	const m = await import("./migration");
	const manifest = await m.prepareMemoryMigration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	db.delete(s.memorySourceRevisions).run();
	expect(m.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(false);
	expect(() => m.cutoverMemoryMigration(h.userId, manifest.id)).toThrow(
		"memory_migration_not_ready",
	);
});
it("empty-bank provisioning retains an existing native service binding", async () => {
	const { db, s } = await seed();
	await keepPriorHistoryDecline();
	const { NATIVE_BANK_CONFIG_PENDING } = await import("./contracts");
	const f = await nativeFixture();
	const m = await import("./migration");
	const manifest = await m.prepareMemoryMigration(h.userId);
	db.update(s.memoryBanks)
		.set({
			nativeBaseUrl: "http://original-synthetic",
			nativeCredentialHash: "original-hash",
			nativeConfigVersion: NATIVE_BANK_CONFIG_PENDING,
		})
		.run();
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	expect(db.select().from(s.memoryBanks).get()?.nativeBaseUrl).toBe(
		"http://original-synthetic",
	);
	expect(f.retained).toHaveLength(0);
	expect(m.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(true);
});

async function allowMigrationHistory() {
	const policy = await import("./migration-policy");
	await policy.recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "include",
	});
}

async function seedLegacyReviewCorrection() {
	const { db, s } = await legacyItem("review_needed");
	const projection = await import("./projection-store");
	db.insert(s.memoryReviewItems)
		.values({
			id: "review",
			userId: h.userId,
			subjectKey: "bicycle",
			subjectLabel: "Bicycle",
			question: "Which colour?",
			reason: "manual review",
			affectedItemIdsJson: '["item"]',
		})
		.run();
	const corrected = await projection.applyReviewItemProjectionMutation({
		userId: h.userId,
		resetGeneration: 0,
		projectionStateId: "projection",
		expectedProjectionRevision: 0,
		now: new Date("2022-01-01"),
		upsert: {
			itemKey: "corrected",
			category: "about_you",
			scope: { type: "global" },
			statement: "My bicycle is green",
			acceptExpiresAt: null,
			replaceItemIds: ["item"],
			retiredReason: "review_edited",
			metadataPatch: { origin: "user_authored", reviewResolution: "edited" },
		},
		suppressItemIds: [],
		resolveRows: [
			{
				reviewItemId: "review",
				resolutionType: "edit_fact",
				editedStatement: "My bicycle is green",
			},
		],
	});
	if (corrected.status !== "updated" || !corrected.itemId)
		throw Error("fixture correction failed");
	return { db, s, projection, corrected, itemId: corrected.itemId };
}

it.each(["deleted", "suppressed"] as const)(
	"excludes a legacy review correction after the user makes it %s",
	async (status) => {
		const { db, s, projection, corrected, itemId } =
			await seedLegacyReviewCorrection();
		const { eq } = await import("drizzle-orm");
		await projection.updateMemoryProfileItemWithRevision({
			userId: h.userId,
			itemId,
			expectedProjectionRevision: corrected.projectionRevision,
			patch: { status },
		});
		expect(
			db
				.select()
				.from(s.memoryProfileItems)
				.where(eq(s.memoryProfileItems.id, itemId))
				.get()?.status,
		).toBe(status);
		await allowMigrationHistory();
		const f = await nativeFixture();
		const migration = await import("./migration");
		const prepared = await migration.prepareMemoryMigration(h.userId);
		const { memoryDeliveryJob } = await import("./delivery-job");
		await h.engine.drain(memoryDeliveryJob);
		const published = db
			.select()
			.from(s.memoryPublishedRows)
			.all()
			.map((row) => row.text);
		expect
			.soft(
				f.fetcher.mock.calls
					.filter(
						([url, options]) =>
							String(url).endsWith("/memories") && options?.method === "POST",
					)
					.flatMap(([, options]) =>
						JSON.parse(String(options?.body)).items.map(
							(item: { content: string }) => item.content,
						),
					),
			)
			.not.toContain("My bicycle is green");
		expect.soft(published.join(" ")).not.toContain("My bicycle is green");
		expect
			.soft(JSON.stringify(f.curationInputs))
			.not.toContain("My bicycle is green");
		expect(published.join(" ")).toContain("My dog is Rex");
		expect(migration.verifyMemoryMigration(h.userId, prepared.id).ready).toBe(
			true,
		);
	},
);

it.each(["before packing", "after packing"] as const)(
	"excludes a known-off assistant reply when its disabled interval is recorded %s",
	async (when) => {
		const { db, s } = await seed();
		const { eq } = await import("drizzle-orm");
		db.update(s.messages)
			.set({ messageSequence: 1 })
			.where(eq(s.messages.id, "m"))
			.run();
		db.insert(s.messages)
			.values([
				{
					id: "assistant-off",
					conversationId: "chat",
					role: "assistant",
					content: "Private text from a disabled period.",
					createdAt: new Date("2020-01-03"),
					messageSequence: 2,
				},
				{
					id: "new-user",
					conversationId: "chat",
					role: "user",
					content: "My plant is healthy.",
					createdAt: new Date("2020-01-05"),
					messageSequence: 3,
				},
			])
			.run();
		const recordDisabledInterval = () =>
			db
				.insert(s.memoryControlIntervals)
				.values({
					id: "off",
					userId: h.userId,
					enabled: false,
					startedAt: new Date("2020-01-02"),
					endedAt: new Date("2020-01-04"),
					epoch: 0,
				})
				.run();
		if (when === "before packing") recordDisabledInterval();
		await allowMigrationHistory();
		const f = await nativeFixture();
		const migration = await import("./migration");
		await migration.prepareMemoryMigration(h.userId);
		const packed = db
			.select()
			.from(s.memorySourceRevisions)
			.where(eq(s.memorySourceRevisions.messageId, "new-user"))
			.get()?.context;
		if (when === "before packing")
			expect(packed).not.toContain("assistant-off");
		else {
			expect(packed).toContain("assistant-off");
			recordDisabledInterval();
		}
		const { memoryDeliveryJob } = await import("./delivery-job");
		await h.engine.drain(memoryDeliveryJob);
		const payloads = f.fetcher.mock.calls
			.filter(
				([url, options]) =>
					String(url).endsWith("/memories") && options?.method === "POST",
			)
			.map(([, options]) => String(options?.body));
		expect(payloads).toHaveLength(2);
		expect(payloads.join(" ")).not.toContain(
			"Private text from a disabled period.",
		);
	},
);

it("holds default historical input when its original scope differs from the current project", async () => {
	const { db, s } = await seed();
	db.insert(s.projects)
		.values({ id: "project", userId: h.userId, name: "Project" })
		.run();
	const { moveConversationToProject } = await import("../conversations");
	await moveConversationToProject(h.userId, "chat", "project");
	const migration = await import("./migration");
	const inventory = migration.inspectMemoryMigration(h.userId);
	expect(inventory.sources).toContainEqual(
		expect.objectContaining({
			id: "m",
			eligibility: "held",
			reason: "historical_scope_changed",
		}),
	);
	expect(inventory.exceptions).toContainEqual(
		expect.objectContaining({ sourceIds: ["m"] }),
	);
	await migration.prepareMemoryMigration(h.userId);
	expect(db.select().from(s.memorySourceRevisions).all()).toEqual([]);
});

it("catch-up moves prepared messages to their new project scope", async () => {
	const { db, s } = await legacyItem();
	const { eq } = await import("drizzle-orm");
	db.insert(s.projects)
		.values({ id: "project", userId: h.userId, name: "Project" })
		.run();
	await allowMigrationHistory();
	const fixture = await nativeFixture();
	const migration = await import("./migration");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const first = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	const { moveConversationToProject } = await import("../conversations");
	expect(
		(await moveConversationToProject(h.userId, "chat", "project"))?.projectId,
	).toBe("project");
	expect(migration.verifyMemoryMigration(h.userId, first.id).changed).toBe(
		true,
	);
	const second = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	const sources = () =>
		db
			.select({
				scope: s.memoryBanks.scopeKey,
				state: s.memorySourceRevisions.state,
				assertedAt: s.memorySourceRevisions.assertedAt,
			})
			.from(s.memorySourceRevisions)
			.innerJoin(
				s.memoryBanks,
				eq(s.memoryBanks.id, s.memorySourceRevisions.bankId),
			)
			.orderBy(s.memoryBanks.scopeKey, s.memorySourceRevisions.state)
			.all();
	const assertedAt = new Date("2020-01-01");
	expect(sources()).toEqual([
		{ scope: "personal", state: "revoked", assertedAt },
		{ scope: "project:project", state: "accepted", assertedAt },
	]);
	expect([...fixture.facts.values()].map((fact) => fact.text)).toEqual([
		"My dog is Rex.",
	]);
	expect(migration.verifyMemoryMigration(h.userId, second.id).ready).toBe(true);
	expect(
		(await moveConversationToProject(h.userId, "chat", null))?.projectId,
	).toBeNull();
	const third = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(sources()).toEqual([
		{ scope: "personal", state: "accepted", assertedAt },
		{ scope: "personal", state: "revoked", assertedAt },
		{ scope: "project:project", state: "accepted", assertedAt },
	]);
	expect([...fixture.facts.values()].map((fact) => fact.text)).toEqual([
		"My dog is Rex.",
		"My dog is Rex.",
	]);
	expect(migration.verifyMemoryMigration(h.userId, third.id).ready).toBe(true);
});

it("a superseded terminal job does not block cutover of the new checkpoint", async () => {
	const { db, s } = await seed();
	const { eq } = await import("drizzle-orm");
	const client = await import("./hindsight-client");
	await allowMigrationHistory();
	await nativeFixture();
	const native = vi.mocked(client.nativeMemoryClient).getMockImplementation();
	vi.mocked(client.nativeMemoryClient).mockImplementation(() => {
		throw new Error("synthetic terminal submission error");
	});
	const migration = await import("./migration");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const first = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	const failed = db.select().from(s.memoryDeliveryJobs).get();
	expect(failed?.status).toBe("failed");
	expect(migration.verifyMemoryMigration(h.userId, first.id)).toMatchObject({
		ready: false,
		changed: false,
		failed: 1,
		pending: 1,
	});
	await migration.prepareMemoryMigration(h.userId);
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.all()
			.map((job) => job.id),
	).toEqual([failed?.id]);
	expect(db.select().from(s.memoryAccounts).get()?.historyStatus).toBe(
		"failed",
	);
	if (!native) throw Error("fixture native mock missing");
	vi.mocked(client.nativeMemoryClient).mockImplementation(native);
	db.delete(s.messages).where(eq(s.messages.id, "m")).run();
	const second = await migration.prepareMemoryMigration(h.userId);
	expect(second.id).toBe(first.id);
	expect(migration.verifyMemoryMigration(h.userId, second.id)).toMatchObject({
		ready: false,
		changed: false,
		failed: 0,
		pending: 2,
	});
	await h.engine.drain(memoryDeliveryJob);
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.where(eq(s.memoryDeliveryJobs.id, failed?.id ?? ""))
			.get()?.status,
	).toBe("failed");
	expect(db.select().from(s.memorySourceRevisions).get()?.state).toBe(
		"revoked",
	);
	expect(migration.verifyMemoryMigration(h.userId, second.id)).toMatchObject({
		ready: true,
		changed: false,
		pending: 0,
	});
});

it.each([
	["review_item_expired", "review_needed"],
	["review_item_no_longer_pending", "retired"],
] as const)(
	"keeps %s out of the legacy deliberate-exclusion inventory",
	async (reason, status) => {
		const { db, s } = await legacyItem(status);
		const { eq } = await import("drizzle-orm");
		db.insert(s.memoryReviewItems)
			.values({
				id: "review",
				userId: h.userId,
				subjectKey: "bicycle",
				subjectLabel: "Bicycle",
				question: "Which colour?",
				reason: "manual review",
				affectedItemIdsJson: '["item"]',
			})
			.run();
		if (status === "review_needed") {
			db.update(s.memoryProfileItems)
				.set({ expiresAt: new Date("2021-06-01") })
				.where(eq(s.memoryProfileItems.id, "item"))
				.run();
			const { expireOverdueReviewMemoryProfileItems } = await import(
				"./projection-store"
			);
			expect(
				await expireOverdueReviewMemoryProfileItems({
					userId: h.userId,
					resetGeneration: 0,
					projectionStateId: "projection",
					now: new Date("2022-01-01"),
				}),
			).toBe(1);
		} else {
			db.update(s.memoryReviewItems)
				.set({ subjectKey: "judge:bicycle" })
				.where(eq(s.memoryReviewItems.id, "review"))
				.run();
			const { listOpenReviewQueueRows } = await import("./review");
			expect(
				await listOpenReviewQueueRows({ userId: h.userId, resetGeneration: 0 }),
			).toEqual([]);
		}
		expect(db.select().from(s.memoryReviewResolutions).get()).toMatchObject({
			resolutionType: "do_not_remember",
			metadataJson: JSON.stringify({ reason }),
		});
		await allowMigrationHistory();
		const fixture = await nativeFixture();
		const migration = await import("./migration");
		const manifest = await migration.prepareMemoryMigration(h.userId);
		const { memoryDeliveryJob } = await import("./delivery-job");
		await h.engine.drain(memoryDeliveryJob);
		expect(migration.inspectMemoryMigration(h.userId)).toMatchObject({
			actions: [],
			holdHistory: false,
		});
		expect(db.select().from(s.memoryActions).all()).toHaveLength(0);
		expect([...fixture.facts.values()].map((f) => f.text)).toEqual([
			"My bicycle is blue. My dog is Rex.",
		]);
		expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
			true,
		);
	},
);

it("preparing an already cut-over account does not issue an authority write", async () => {
	const { db, s } = await seed();
	await nativeFixture();
	const migration = await import("./migration");
	const manifest = await migration.prepareMemoryMigration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	migration.cutoverMemoryMigration(h.userId, manifest.id);
	h.sqlite.exec(`
		CREATE TRIGGER ignore_repeated_prepare_authority
		BEFORE UPDATE OF authority ON memory_accounts
		WHEN OLD.authority = 'hindsight'
		BEGIN
			SELECT RAISE(ABORT, 'unnecessary_authority_write');
		END
	`);
	const prepared = await migration.prepareMemoryMigration(h.userId);
	expect(prepared.id).toBe(manifest.id);
	expect(db.select().from(s.memoryAccounts).get()?.authority).toBe("hindsight");
	expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
		true,
	);
});

it("retains an active legacy review correction once without chat import consent", async () => {
	const { db, s } = await seedLegacyReviewCorrection();
	await keepPriorHistoryDecline();
	const fixture = await nativeFixture();
	const migration = await import("./migration");
	const manifest = await migration.prepareMemoryMigration(h.userId);
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	expect(fixture.retained).toEqual(["2022-01-01T00:00:00.000Z"]);
	expect([...fixture.facts.values()].map((fact) => fact.text)).toEqual([
		"My bicycle is green",
	]);
	expect(db.select().from(s.memorySourceRevisions).all()).toHaveLength(1);
	expect(migration.verifyMemoryMigration(h.userId, manifest.id)).toMatchObject({
		ready: true,
		uncertain: 1,
	});
});

it("fails closed when the user deletes a queued authored correction before delivery", async () => {
	const { db, s, projection, corrected, itemId } =
		await seedLegacyReviewCorrection();
	await keepPriorHistoryDecline();
	const fixture = await nativeFixture();
	const migration = await import("./migration");
	const manifest = await migration.prepareMemoryMigration(h.userId);
	expect(
		await projection.updateMemoryProfileItemWithRevision({
			userId: h.userId,
			itemId,
			expectedProjectionRevision: corrected.projectionRevision,
			patch: { status: "deleted" },
		}),
	).toMatchObject({ status: "updated" });
	const { memoryDeliveryJob } = await import("./delivery-job");
	await h.engine.drain(memoryDeliveryJob);
	expect(fixture.retained).toEqual([]);
	expect(db.select().from(s.memoryPublishedRows).all()).toEqual([]);
	expect(migration.verifyMemoryMigration(h.userId, manifest.id).changed).toBe(
		true,
	);
	const resumed = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(migration.verifyMemoryMigration(h.userId, resumed.id).ready).toBe(
		true,
	);
});

type ReplayFixtureFact = {
	id: string;
	document_id: string;
	text: string;
	fact_type: "world";
	consolidated_at: string;
	mentioned_at: string;
};
type ReplayFixtureItem = {
	content: string;
	document_id: string;
	timestamp: string;
	metadata: { lineage?: string };
};
const replayOldBicycle = "My bicycle is blue.";
const replayCorrectedBicycle = "My bicycle is green.";
const replayIndependentDog = "My dog is Rex.";
const replayProjectOnlyFact = "My project uses cobalt.";

async function migrationReplayNative() {
	const transport = await import("./hindsight-client");
	const cfg = await import("$lib/server/config-store");
	const { NATIVE_BANK_CONFIG } = await import("./contracts");
	const curation = await import("./curation");
	vi.spyOn(cfg, "getConfig").mockReturnValue({
		...cfg.getConfig(),
		hindsightWorkerEnabled: true,
		hindsightConcurrency: 1,
	});
	const banks = new Map<string, Map<string, ReplayFixtureFact>>();
	const requests: Array<{ bank: string; item: ReplayFixtureItem }> = [];
	let combineNextSource = false;
	const applications: Array<{
		before: unknown;
		after: unknown;
		facts: Array<{ id: string; text: string }>;
	}> = [];
	const fetcher = async (url: RequestInfo | URL, options?: RequestInit) => {
		const path = new URL(String(url));
		const [, , , , bank, leaf, encodedId] = path.pathname.split("/");
		const id = decodeURIComponent(encodedId ?? "");
		expect(bank).toBeTruthy();
		const facts = banks.get(bank) ?? new Map<string, ReplayFixtureFact>();
		banks.set(bank, facts);
		const body = options?.body ? JSON.parse(String(options.body)) : {};
		let data: unknown = {};
		if (leaf === "config") data = { config: NATIVE_BANK_CONFIG };
		else if (leaf === "operations")
			data = id ? { status: "completed" } : { operations: [] };
		else if (leaf === "consolidate") data = { operation_id: "consolidate" };
		else if (leaf === "memories" && options?.method === "POST") {
			for (const item of body.items as ReplayFixtureItem[]) {
				requests.push({ bank, item });
				const sentences = (text: string) =>
					text.match(/[^.]+\./g)?.map((s) => s.trim()) ?? [text];
				const edit = item.content.startsWith("{")
					? JSON.parse(item.content)
					: null;
				const texts =
					combineNextSource && !edit
						? [item.content]
						: edit
							? sentences(edit.after).filter(
									(text) => !sentences(edit.before).includes(text),
								)
							: sentences(item.content);
				combineNextSource = false;
				for (const [index, text] of texts.entries()) {
					const factId = `${item.document_id}:fact:${index}`;
					facts.set(factId, {
						id: factId,
						document_id: item.document_id,
						text,
						fact_type: "world",
						consolidated_at: "2026-11-18T00:00:00Z",
						mentioned_at: item.timestamp,
					});
				}
			}
			data = { operation_id: body.operation_id };
		} else if (leaf === "memories" && id === "recall") {
			data = {
				results: [...facts.values()].map((fact) => ({
					id: `obs:${fact.id}`,
					text: fact.text,
					type: "observation",
					source_fact_ids: [fact.id],
				})),
			};
		} else if (leaf === "memories" && id === "list") {
			const raw = [...facts.values()];
			const items = [
				...raw,
				...raw.map((fact) => ({
					id: `obs:${fact.id}`,
					text: fact.text,
					fact_type: "observation",
					source_memory_ids: [fact.id],
				})),
			];
			data = { total: items.length, offset: 0, items };
		} else if (leaf === "memories" && options?.method === "PATCH") {
			const fact = facts.get(id);
			if (fact && body.state === "invalidated") facts.delete(id);
			else if (fact) {
				if (typeof body.text === "string") fact.text = body.text;
				if (typeof body.mentioned_at === "string")
					fact.mentioned_at = body.mentioned_at;
			}
		} else if (leaf === "documents" && options?.method === "DELETE") {
			for (const [key, fact] of facts)
				if (fact.document_id === id) facts.delete(key);
		}
		return new Response(JSON.stringify(data));
	};
	vi.spyOn(transport, "configuredNativeBinding").mockReturnValue({
		baseUrl: "http://synthetic",
		credentialHash: "synthetic",
	});
	vi.spyOn(transport, "nativeMemoryClient").mockImplementation(
		(bankId) =>
			new transport.HindsightClient({
				baseUrl: "http://synthetic",
				apiKey: "synthetic",
				bankId,
				fetcher,
			}),
	);
	vi.spyOn(curation, "createCurationModel").mockReturnValue(
		async (_prompt, input, schema) => {
			const properties = schema.properties as Record<string, unknown>;
			const v = input as {
				displayed_before: string;
				user_saved_after: string;
				facts: Array<{ id: string; text: string }>;
				new_facts?: Array<{ id: string; text: string }>;
				original_facts?: Array<{ id: string; text: string }>;
				proposed_facts?: Array<{ id: string; text: string }>;
			};
			if (properties.forget)
				return {
					forget: [replayOldBicycle],
					replace: [],
					preserve: [replayIndependentDog],
				};
			if (
				properties.corrected_fact_ids &&
				v.proposed_facts?.some(
					(fact) =>
						fact.text.includes(replayCorrectedBicycle) &&
						fact.text.includes(replayIndependentDog),
				)
			)
				return {
					valid: false,
					issues: [
						{ id: "mixed", problem: "The two assertions need separate dates." },
					],
					corrected_fact_ids: [],
				};
			if (properties.valid)
				return {
					valid: true,
					issues: [],
					...(properties.corrected_fact_ids
						? {
								corrected_fact_ids: (v.proposed_facts ?? [])
									.filter(
										(fact) =>
											fact.text === v.user_saved_after &&
											fact.text &&
											v.original_facts?.some(
												(original) =>
													original.id === fact.id &&
													original.text !== fact.text,
											),
									)
									.map((fact) => fact.id),
							}
						: {}),
				};
			applications.push({
				before: v.displayed_before,
				after: v.user_saved_after,
				facts: v.facts,
			});
			return {
				facts: v.facts.map((fact) => ({
					...fact,
					text:
						fact.text === v.displayed_before
							? v.new_facts?.some((f) => f.text === v.user_saved_after)
								? ""
								: v.user_saved_after
							: fact.text.includes(replayOldBicycle) &&
									fact.text.includes(replayIndependentDog)
								? fact.text.replace(replayOldBicycle, v.user_saved_after)
								: fact.text,
				})),
			};
		},
	);
	return {
		requests,
		applications,
		banks,
		combineNextAssertion: () => {
			combineNextSource = true;
		},
	};
}
function migrationReplayEvent(
	url: string,
	method: string,
	body: object,
	params = {},
) {
	return {
		url: new URL(url, "http://synthetic"),
		request: new Request(`http://synthetic${url}`, {
			method,
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
		locals: { user: { id: h.userId } },
		params,
	};
}

it.each([
	["remove", "consent"],
	["edit", "consent"],
	["remove", "scope"],
	["edit", "scope"],
	["edit", "mixed scope"],
	["edit-then-remove", "consent"],
] as const)(
	"post-cutover replay preserves native %s during %s replay",
	async (kind, replay) => {
		const { db, s } = await seed();
		const { randomUUID } = await import("node:crypto");
		const { recordHistoryImportChoice } = await import("./migration-policy");
		const actions = await import(
			"../../../../routes/api/knowledge/memory/actions/+server"
		);
		const operation = await import(
			"../../../../routes/api/knowledge/memory/operations/[operationId]/+server"
		);
		const conversation = await import(
			"../../../../routes/api/conversations/[id]/+server"
		);
		const { readPublishedMemory } = await import("./publication");
		const { memoryDeliveryJob } = await import("./delivery-job");
		const migration = await import("./migration");
		const fixture = await migrationReplayNative();

		if (replay !== "consent") {
			db.insert(s.projects)
				.values({ id: "project", userId: h.userId, name: "Project" })
				.run();
			db.insert(s.conversations)
				.values({
					id: "unmoved",
					userId: h.userId,
					title: "Independent project chat",
					projectId: "project",
				})
				.run();
			db.insert(s.messages)
				.values({
					id: "private-project-message",
					conversationId: "unmoved",
					role: "user",
					content: replayProjectOnlyFact,
					createdAt: new Date("2020-01-01"),
				})
				.run();
		}
		await keepPriorHistoryDecline();
		const prepared = await migration.prepareMemoryMigration(h.userId);
		async function consent(choice: "include" | "decline") {
			const result = await recordHistoryImportChoice(h.userId, {
				choice,
				requestId: randomUUID(),
			});
			expect(result).toMatchObject({ choice });
			await h.engine.drain(memoryDeliveryJob);
		}
		await consent("include");
		expect(migration.cutoverMemoryMigration(h.userId, prepared.id).ready).toBe(
			true,
		);
		const bank = (scope: string) =>
			db
				.select()
				.from(s.memoryBanks)
				.all()
				.find((row) => row.scopeKey === scope);
		const published = (scope: string) => {
			const destination = bank(scope);
			return destination ? readPublishedMemory(h.userId, destination.id) : [];
		};
		const personal = bank("personal");
		const row = published("personal").find(
			(row) => row.text === replayOldBicycle,
		);
		if (!personal || !row) throw Error("fixture personal Memory is missing");
		expect(published("personal").map((row) => row.text)).toContain(
			replayIndependentDog,
		);
		const accepted = await actions.POST(
			migrationReplayEvent("/api/knowledge/memory/actions", "POST", {
				kind: kind === "remove" ? "remove" : "edit",
				requestId: randomUUID(),
				ref: {
					scope: { kind: "personal" },
					generation: personal.generation,
					rowId: row.nativeId,
				},
				...(kind !== "remove" ? { text: replayCorrectedBicycle } : {}),
			}) as Parameters<typeof actions.POST>[0],
		);
		const action = await accepted.json();
		expect({ status: accepted.status, error: action.error }).toEqual({
			status: 200,
			error: undefined,
		});
		await h.engine.drain(memoryDeliveryJob);
		const status = await operation.GET({
			locals: { user: { id: h.userId } },
			params: { operationId: action.id },
		} as Parameters<typeof operation.GET>[0]);
		expect(await status.json()).toMatchObject({ status: "applied" });
		expect(
			published("personal")
				.map((row) => row.text)
				.sort(),
		).toEqual(
			[kind !== "remove" ? replayCorrectedBicycle : null, replayIndependentDog]
				.filter(Boolean)
				.sort(),
		);
		if (kind === "edit-then-remove") {
			const currentBank = bank("personal");
			const correction = published("personal").find(
				(entry) => entry.text === replayCorrectedBicycle,
			);
			if (!currentBank || !correction)
				throw Error("fixture accepted correction is missing");
			const removed = await actions.POST(
				migrationReplayEvent("/api/knowledge/memory/actions", "POST", {
					kind: "remove",
					requestId: randomUUID(),
					ref: {
						scope: { kind: "personal" },
						generation: currentBank.generation,
						rowId: correction.nativeId,
					},
				}) as Parameters<typeof actions.POST>[0],
			);
			expect(removed.status).toBe(200);
			await h.engine.drain(memoryDeliveryJob);
			expect(published("personal").map((row) => row.text)).toEqual([
				replayIndependentDog,
			]);
		}
		const independentNote = "I prefer printed maps.";
		const added = await actions.POST(
			migrationReplayEvent("/api/knowledge/memory/actions", "POST", {
				kind: "add",
				scope: { kind: "personal" },
				text: independentNote,
				requestId: randomUUID(),
			}) as Parameters<typeof actions.POST>[0],
		);
		expect(added.status).toBe(200);
		await h.engine.drain(memoryDeliveryJob);
		expect(published("personal").map((row) => row.text)).toContain(
			independentNote,
		);
		const original = db
			.select()
			.from(s.memorySourceRevisions)
			.all()
			.find((row) => row.messageId === "m");
		const originalAction = db
			.select()
			.from(s.memoryActions)
			.all()
			.find((row) => row.id === action.id);
		if (!original || !originalAction)
			throw Error("fixture source or action is missing");
		const beforeReplayChecks = fixture.applications.length;
		expect(beforeReplayChecks).toBeGreaterThan(0);
		const assertReplay = (scope: string) => {
			const active = db
				.select()
				.from(s.memorySourceRevisions)
				.all()
				.find(
					(row) =>
						row.messageId === "m" &&
						row.bankId === bank(scope)?.id &&
						row.state === "accepted",
				);
			if (!active) throw Error("fixture destination source is missing");
			expect(active.id).not.toBe(original.id);
			expect(active).toMatchObject({
				lineageId: original.lineageId,
				textHash: original.textHash,
				assertedAt: original.assertedAt,
			});
			expect(
				fixture.requests.findLast(({ item }) => item.document_id === active.id),
			).toMatchObject({
				bank: active.bankId,
				item: {
					timestamp: original.assertedAt.toISOString(),
					metadata: { lineage: original.lineageId },
				},
			});
			expect(migration.verifyMemoryMigration(h.userId, prepared.id).ready).toBe(
				true,
			);
			const aliases = db
				.select()
				.from(s.memoryActions)
				.all()
				.filter((row) => {
					const intent = JSON.parse(row.intentJson ?? "{}");
					return (
						intent.replayOriginActionId === originalAction.id &&
						intent.sourceIds.includes(active.id)
					);
				});
			expect(aliases).toHaveLength(1);
			expect(aliases[0]).toMatchObject({
				bankId: active.bankId,
				createdAt: originalAction.createdAt,
			});
			expect(JSON.parse(aliases[0].intentJson ?? "{}")).toMatchObject({
				sourceIds: [active.id],
				facts: [],
			});
			if (kind === "edit-then-remove")
				expect(
					fixture.applications
						.slice(beforeReplayChecks)
						.filter((call) =>
							call.facts.some((fact) => fact.id.startsWith(`${active.id}:`)),
						)
						.map(({ before, after }) => [before, after]),
				).toEqual([
					[replayOldBicycle, replayCorrectedBicycle],
					[replayCorrectedBicycle, ""],
				]);
			const visible = published(scope)
				.map((row) => row.text)
				.sort();
			expect
				.soft(visible, `${scope} replay publication`)
				.toEqual(
					[
						replayIndependentDog,
						...(kind === "edit" ? [replayCorrectedBicycle] : []),
						...(scope.startsWith("project:")
							? [replayProjectOnlyFact]
							: [independentNote]),
					].sort(),
				);
			expect
				.soft(
					fixture.applications
						.slice(beforeReplayChecks)
						.some((call) =>
							call.facts.some((fact) => fact.id.startsWith(`${active.id}:`)),
						),
					`${scope} bounded replay checks`,
				)
				.toBe(true);
		};
		if (replay === "consent") {
			await consent("decline");
			expect(
				db
					.select()
					.from(s.memorySourceRevisions)
					.all()
					.find((row) => row.id === original.id)?.state,
			).toBe("revoked");
			expect(published("personal").map((row) => row.text)).not.toContain(
				replayIndependentDog,
			);
			await consent("include");
			assertReplay("personal");
		} else {
			async function move(projectId: string | null) {
				const reply = await conversation.PATCH(
					migrationReplayEvent(
						"/api/conversations/chat",
						"PATCH",
						{ projectId },
						{ id: "chat" },
					) as Parameters<typeof conversation.PATCH>[0],
				);
				expect(reply.status).toBe(200);
				expect(await reply.json()).toMatchObject({ projectId });
				await migration.prepareMemoryMigration(h.userId);
				await h.engine.drain(memoryDeliveryJob);
			}
			if (replay === "mixed scope") fixture.combineNextAssertion();
			await move("project");
			if (replay === "mixed scope") {
				const project = bank("project:project");
				if (!project) throw Error("fixture project bank is missing");
				const raw = [...(fixture.banks.get(project.id)?.values() ?? [])];
				expect(
					raw.find(
						(fact) =>
							fact.text.includes(replayOldBicycle) &&
							fact.text.includes(replayIndependentDog),
					)?.mentioned_at,
				).toBe(original.assertedAt.toISOString());
				expect(published("project:project").map((item) => item.text)).toEqual([
					replayProjectOnlyFact,
				]);
				expect(
					migration.verifyMemoryMigration(h.userId, prepared.id),
				).toMatchObject({ ready: false, failed: 1 });
				return;
			}
			assertReplay("project:project");
			if (kind === "edit") {
				const project = bank("project:project");
				if (!project) throw Error("fixture project bank is missing");
				const assertCorrectionDates = () => {
					const raw = [...(fixture.banks.get(project.id)?.values() ?? [])];
					expect(
						raw.find((fact) => fact.text === replayCorrectedBicycle)
							?.mentioned_at,
					).toBe(originalAction.createdAt.toISOString());
					expect(
						raw.find((fact) => fact.text === replayIndependentDog)
							?.mentioned_at,
					).toBe(original.assertedAt.toISOString());
					expect(
						published("project:project").find(
							(item) => item.text === replayCorrectedBicycle,
						)?.updatedAt,
					).toEqual(originalAction.createdAt);
					expect(
						published("project:project").find(
							(item) => item.text === replayIndependentDog,
						)?.updatedAt,
					).toEqual(original.assertedAt);
				};
				assertCorrectionDates();
				db.insert(s.messages)
					.values({
						id: "later-project-message",
						conversationId: "unmoved",
						role: "user",
						content: "My project also uses an atlas.",
						createdAt: new Date("2020-01-02"),
					})
					.run();
				await migration.prepareMemoryMigration(h.userId);
				await h.engine.drain(memoryDeliveryJob);
				expect(bank("project:project")?.generation).not.toBe(
					project.generation,
				);
				assertCorrectionDates();
			}
			expect(published("personal").map((row) => row.text)).not.toContain(
				replayIndependentDog,
			);
			expect(published("personal").map((row) => row.text)).not.toContain(
				replayCorrectedBicycle,
			);
			expect(published("personal").map((row) => row.text)).toContain(
				independentNote,
			);
			await move(null);
			assertReplay("personal");
			expect(
				published("project:project")
					.map((row) => row.text)
					.sort(),
			).toEqual(
				[
					replayProjectOnlyFact,
					replayIndependentDog,
					...(kind === "edit" ? [replayCorrectedBicycle] : []),
					...(kind === "edit" ? ["My project also uses an atlas."] : []),
				].sort(),
			);
			expect(published("personal").map((row) => row.text)).not.toContain(
				replayProjectOnlyFact,
			);
		}
	},
);

it("post-cutover replay does not bind prior choices to a genuinely newer explicit assertion", async () => {
	const { db, s } = await seed();
	const { randomUUID } = await import("node:crypto");
	const actions = await import(
		"../../../../routes/api/knowledge/memory/actions/+server"
	);
	const messagesRoute = await import(
		"../../../../routes/api/conversations/[id]/messages/+server"
	);
	const { createMessage } = await import("../messages");
	const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } =
		await import("./chat-delivery");
	const { readPublishedMemory } = await import("./publication");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const migration = await import("./migration");
	const fixture = await migrationReplayNative();
	await allowMigrationHistory();
	const prepared = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(migration.cutoverMemoryMigration(h.userId, prepared.id).ready).toBe(
		true,
	);
	const bank = db.select().from(s.memoryBanks).get();
	const original = db.select().from(s.memorySourceRevisions).get();
	if (!bank || !original) throw Error("fixture bank or source is missing");
	const published = () => readPublishedMemory(h.userId, bank.id);
	const row = published().find((row) => row.text === replayOldBicycle);
	if (!row) throw Error("fixture observation is missing");
	const remove = await actions.POST(
		migrationReplayEvent("/api/knowledge/memory/actions", "POST", {
			kind: "remove",
			requestId: randomUUID(),
			ref: {
				scope: { kind: "personal" },
				generation: bank.generation,
				rowId: row.nativeId,
			},
		}) as Parameters<typeof actions.POST>[0],
	);
	expect(remove.status).toBe(200);
	await h.engine.drain(memoryDeliveryJob);
	expect(published().map((row) => row.text)).toEqual([replayIndependentDog]);

	const deleted = await messagesRoute.DELETE(
		migrationReplayEvent(
			"/api/conversations/chat/messages",
			"DELETE",
			{ messageIds: ["m"], editSourceMessageId: "m" },
			{ id: "chat" },
		) as Parameters<typeof messagesRoute.DELETE>[0],
	);
	expect(await deleted.json()).toEqual({ deleted: 1 });
	const acceptance = captureMemoryTurnAcceptance(h.userId, "chat");
	const newBicycle = "My bicycle is blue with white stripes.";
	const editedUser = await createMessage(
		"chat",
		"user",
		`${newBicycle} ${replayIndependentDog}`,
	);
	const reply = await createMessage("chat", "assistant", "Understood.");
	await deliverCompletedMemoryTurn({
		userId: h.userId,
		conversationId: "chat",
		memoryAcceptance: acceptance,
		userMessageId: editedUser.id,
		assistantMessageId: reply.id,
		turnOrigin: "edit_resend",
		editSourceMessageId: "m",
	});
	await h.engine.drain(memoryDeliveryJob);
	const newSource = db
		.select()
		.from(s.memorySourceRevisions)
		.all()
		.find((source) => source.messageId === editedUser.id);
	if (!newSource?.explicitEditAt)
		throw Error("fixture edited source is missing");
	const explicitEditAt = newSource.explicitEditAt;
	expect(newSource).toMatchObject({
		predecessorSourceId: original.id,
		lineageId: original.lineageId,
		assertedAt: original.assertedAt,
		state: "accepted",
	});
	expect(explicitEditAt.getTime()).toBeGreaterThan(
		original.assertedAt.getTime(),
	);
	const request = fixture.requests.find(
		({ item }) => item.document_id === newSource.id,
	);
	if (!request) throw Error("fixture retain request is missing");
	expect(request.item.timestamp).toBe(explicitEditAt.toISOString());
	expect(JSON.parse(request.item.content)).toEqual({
		kind: "source_edit",
		before: original.text,
		after: newSource.text,
		explicit_edit_at: explicitEditAt.toISOString(),
		original_asserted_at: original.assertedAt.toISOString(),
	});
	expect(
		published()
			.map((row) => row.text)
			.sort(),
	).toEqual([newBicycle, replayIndependentDog].sort());
	const { eq } = await import("drizzle-orm");
	const conversation = await import(
		"../../../../routes/api/conversations/[id]/+server"
	);
	const updatedBank = db
		.select()
		.from(s.memoryBanks)
		.where(eq(s.memoryBanks.id, bank.id))
		.get();
	const updatedRow = published().find((row) => row.text === newBicycle);
	if (!updatedBank || !updatedRow)
		throw Error("fixture edited assertion is absent");
	const removeEdited = await actions.POST(
		migrationReplayEvent("/api/knowledge/memory/actions", "POST", {
			kind: "remove",
			requestId: randomUUID(),
			ref: {
				scope: { kind: "personal" },
				generation: updatedBank.generation,
				rowId: updatedRow.nativeId,
			},
		}) as Parameters<typeof actions.POST>[0],
	);
	expect(removeEdited.status).toBe(200);
	await h.engine.drain(memoryDeliveryJob);
	db.insert(s.projects)
		.values({ id: "project", userId: h.userId, name: "Project" })
		.run();
	const moved = await conversation.PATCH(
		migrationReplayEvent(
			"/api/conversations/chat",
			"PATCH",
			{ projectId: "project" },
			{ id: "chat" },
		) as Parameters<typeof conversation.PATCH>[0],
	);
	expect(moved.status).toBe(200);
	const resumed = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	const destination = db
		.select()
		.from(s.memoryBanks)
		.where(eq(s.memoryBanks.scopeKey, "project:project"))
		.get();
	if (!destination) throw Error("fixture destination is absent");
	expect(
		readPublishedMemory(h.userId, destination.id).map((row) => row.text),
	).toEqual([replayIndependentDog]);
	expect(
		db
			.select()
			.from(s.memorySourceRevisions)
			.all()
			.find((source) => source.bankId === destination.id),
	).toMatchObject({
		lineageId: newSource.lineageId,
		assertedAt: newSource.assertedAt,
		explicitEditAt: newSource.explicitEditAt,
		state: "accepted",
	});
	expect(migration.verifyMemoryMigration(h.userId, resumed.id).ready).toBe(
		true,
	);
});

it.each(["delete source", "decline history"] as const)(
	"keeps learned Memory in the original project until %s",
	async (withdraw) => {
		const { db, s } = await seed();
		const { eq } = await import("drizzle-orm");
		const { recallMemory } = await import("../memory-context/native");
		const messagesRoute = await import(
			"../../../../routes/api/conversations/[id]/messages/+server"
		);
		const { recordHistoryImportChoice } = await import("./migration-policy");
		const { readPublishedMemory } = await import("./publication");
		db.insert(s.projects)
			.values([
				{ id: "project", userId: h.userId, name: "Original project" },
				{ id: "destination", userId: h.userId, name: "Other project" },
			])
			.run();
		db.update(s.conversations)
			.set({ projectId: "project" })
			.where(eq(s.conversations.id, "chat"))
			.run();
		db.insert(s.conversations)
			.values([
				{
					id: "original-chat",
					userId: h.userId,
					title: "Stays",
					projectId: "project",
				},
				{ id: "personal-chat", userId: h.userId, title: "Personal" },
			])
			.run();
		const personal = "I prefer printed maps.";
		db.insert(s.messages)
			.values({
				id: "personal-message",
				conversationId: "personal-chat",
				role: "user",
				content: personal,
				createdAt: new Date("2020-01-01"),
			})
			.run();
		const independentChild = "I maintain a seed library.";
		const independentGrandchild = "My library has a seed press.";
		if (withdraw === "delete source")
			db.insert(s.messages)
				.values([
					{
						id: "project-child",
						conversationId: "chat",
						messageSequence: 2,
						role: "user",
						content: independentChild,
						createdAt: new Date("2020-01-02"),
					},
					{
						id: "project-grandchild",
						conversationId: "chat",
						messageSequence: 3,
						role: "user",
						content: independentGrandchild,
						createdAt: new Date("2020-01-03"),
					},
				])
				.run();
		const fixture = await migrationReplayNative();
		const migration = await import("./migration");
		const { memoryDeliveryJob } = await import("./delivery-job");
		const { moveConversationToProject } = await import("../conversations");
		await allowMigrationHistory();
		const prepared = await migration.prepareMemoryMigration(h.userId);
		await h.engine.drain(memoryDeliveryJob);
		expect(migration.cutoverMemoryMigration(h.userId, prepared.id).ready).toBe(
			true,
		);
		const original = db
			.select()
			.from(s.memorySourceRevisions)
			.where(eq(s.memorySourceRevisions.messageId, "m"))
			.get();
		if (!original) throw Error("fixture project source is missing");
		const originalNativeIds = () =>
			[...(fixture.banks.get(original.bankId)?.keys() ?? [])].sort();
		const beforeMoveIds = originalNativeIds();
		const includesChild = withdraw === "delete source";
		expect(beforeMoveIds).toHaveLength(includesChild ? 4 : 2);
		const recall = async (conversationId: string) =>
			(
				await recallMemory(h.userId, {
					conversationId,
					query: "Memory",
					tokenBudget: 100,
				})
			)
				.map(({ text }) => text)
				.sort();
		const originalRecall = [
			personal,
			replayOldBicycle,
			replayIndependentDog,
			...(includesChild ? [independentChild, independentGrandchild] : []),
		].sort();
		expect(
			(await moveConversationToProject(h.userId, "chat", null))?.projectId,
		).toBeNull();
		expect.soft(await recall("original-chat")).toEqual(originalRecall);
		expect.soft(await recall("chat")).toEqual([personal]);
		expect(
			(await moveConversationToProject(h.userId, "chat", "destination"))
				?.projectId,
		).toBe("destination");
		expect.soft(await recall("original-chat")).toEqual(originalRecall);
		expect.soft(await recall("chat")).toEqual([personal]);
		await migration.prepareMemoryMigration(h.userId);
		await h.engine.drain(memoryDeliveryJob);
		expect.soft(await recall("original-chat")).toEqual(originalRecall);
		expect.soft(await recall("chat")).toEqual([personal]);
		expect.soft(originalNativeIds()).toEqual(beforeMoveIds);
		expect(
			fixture.requests.filter(({ item }) =>
				item.content.includes(replayOldBicycle),
			),
		).toEqual([expect.objectContaining({ bank: original.bankId })]);
		expect(migration.inspectMemoryMigration(h.userId).exceptions).toEqual(
			expect.arrayContaining(
				[{ reason: "native_curation_scope_unresolved", sourceIds: ["m"] }].map(
					(exception) => expect.objectContaining(exception),
				),
			),
		);
		if (withdraw === "delete source") {
			const response = await messagesRoute.DELETE(
				migrationReplayEvent(
					"/api/conversations/chat/messages",
					"DELETE",
					{
						messageIds: ["m"],
					},
					{ id: "chat" },
				) as Parameters<typeof messagesRoute.DELETE>[0],
			);
			expect(await response.json()).toEqual({ deleted: 1 });
		} else {
			await recordHistoryImportChoice(h.userId, {
				choice: "decline",
				requestId: "withdraw-history",
			});
		}
		expect(readPublishedMemory(h.userId, original.bankId)).toEqual([]);
		await h.engine.drain(memoryDeliveryJob);
		expect(
			[...(fixture.banks.get(original.bankId)?.values() ?? [])].map(
				(fact) => fact.text,
			),
		).toEqual(includesChild ? [independentChild, independentGrandchild] : []);
		expect(await recall("original-chat")).toEqual(
			includesChild
				? [personal, independentChild, independentGrandchild].sort()
				: [],
		);
	},
);

it.each(["before cutover", "through two recorded moves"] as const)(
	"migration holds project-origin text %s",
	async (scenario) => {
		const { db, s } = await seed();
		const { randomUUID } = await import("node:crypto");
		const { eq } = await import("drizzle-orm");
		const { recordHistoryImportChoice } = await import("./migration-policy");
		const conversation = await import(
			"../../../../routes/api/conversations/[id]/+server"
		);
		const { readPublishedMemory } = await import("./publication");
		const { memoryDeliveryJob } = await import("./delivery-job");
		const migration = await import("./migration");
		const fixture = await migrationReplayNative();
		db.insert(s.projects)
			.values([
				{ id: "origin", userId: h.userId, name: "Origin" },
				{ id: "destination", userId: h.userId, name: "Destination" },
			])
			.run();
		db.update(s.conversations)
			.set({ projectId: "origin" })
			.where(eq(s.conversations.id, "chat"))
			.run();
		if (scenario === "before cutover") await allowMigrationHistory();
		else await keepPriorHistoryDecline();
		const prepared = await migration.prepareMemoryMigration(h.userId);
		await h.engine.drain(memoryDeliveryJob);
		if (scenario === "before cutover") {
			const bank = db
				.select()
				.from(s.memoryBanks)
				.where(eq(s.memoryBanks.scopeKey, "project:origin"))
				.get();
			if (!bank) throw Error("fixture origin bank is missing");
			expect(fixture.requests).toHaveLength(1);
			expect(
				readPublishedMemory(h.userId, bank.id).map((row) => row.text),
			).toContain(replayOldBicycle);
		} else {
			expect(fixture.requests).toHaveLength(0);
			expect(
				migration.cutoverMemoryMigration(h.userId, prepared.id).ready,
			).toBe(true);
		}
		for (const projectId of scenario === "before cutover"
			? [null]
			: [null, "destination"]) {
			const moved = await conversation.PATCH(
				migrationReplayEvent(
					"/api/conversations/chat",
					"PATCH",
					{ projectId },
					{ id: "chat" },
				) as Parameters<typeof conversation.PATCH>[0],
			);
			expect(moved.status).toBe(200);
			expect(await moved.json()).toMatchObject({ projectId });
		}
		const moves = db
			.select()
			.from(s.memoryEvents)
			.where(eq(s.memoryEvents.eventType, "memory_scope_moved"))
			.all();
		expect(
			moves.map(({ conversationId, subjectId, relatedId, payloadJson }) => ({
				conversationId,
				subjectId,
				relatedId,
				payload: JSON.parse(payloadJson ?? "{}"),
			})),
		).toEqual([
			{
				conversationId: "chat",
				subjectId: "project:origin",
				relatedId: "personal",
				payload: { epoch: 0 },
			},
			...(scenario === "before cutover"
				? []
				: [
						{
							conversationId: "chat",
							subjectId: "personal",
							relatedId: "project:destination",
							payload: { epoch: 0 },
						},
					]),
		]);
		const resumed = await recordHistoryImportChoice(h.userId, {
			choice: "include",
			requestId: randomUUID(),
		});
		expect(resumed.choice).toBe("include");
		await h.engine.drain(memoryDeliveryJob);
		const scope =
			scenario === "before cutover" ? "personal" : "project:destination";
		const bank = db
			.select()
			.from(s.memoryBanks)
			.where(eq(s.memoryBanks.scopeKey, scope))
			.get();
		expect
			.soft(
				fixture.requests.filter(({ bank: wireBank }) => wireBank === bank?.id),
				"project-origin text in destination retains",
			)
			.toEqual([]);
		expect
			.soft(
				bank
					? readPublishedMemory(h.userId, bank.id).map((row) => row.text)
					: [],
				"project-origin text in destination publication",
			)
			.not.toContain(replayOldBicycle);
		expect
			.soft(migration.inspectMemoryMigration(h.userId).sources[0])
			.toMatchObject({
				eligibility: "held",
			});
	},
);

it("keeps a standalone legacy authored item in its learned project after a chat move", async () => {
	const { db, s } = await seed();
	await keepPriorHistoryDecline();
	const { eq } = await import("drizzle-orm");
	const migration = await import("./migration");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const { moveConversationToProject } = await import("../conversations");
	const { readPublishedMemory } = await import("./publication");
	const fixture = await migrationReplayNative();
	db.insert(s.projects)
		.values({ id: "project", userId: h.userId, name: "Original project" })
		.run();
	db.update(s.conversations)
		.set({ projectId: "project" })
		.where(eq(s.conversations.id, "chat"))
		.run();
	db.insert(s.memoryProjectionState)
		.values({ id: "projection", userId: h.userId, resetGeneration: 0 })
		.run();
	const statement = "My project uses a green seal.";
	db.insert(s.memoryProfileItems)
		.values({
			id: "authored-item",
			userId: h.userId,
			projectionStateId: "projection",
			itemKey: "green-seal",
			category: "about_you",
			scopeType: "conversation",
			scopeId: "chat",
			statement,
			status: "active",
			metadataJson: '{"origin":"user_authored"}',
			updatedAt: new Date("2021-01-01"),
		})
		.run();
	const prepared = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(migration.cutoverMemoryMigration(h.userId, prepared.id).ready).toBe(
		true,
	);
	const original = fixture.requests.find(
		({ item }) => item.content === statement,
	);
	if (!original) throw Error("fixture authored source is missing");
	expect(
		(await moveConversationToProject(h.userId, "chat", null))?.projectId,
	).toBeNull();
	await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect
		.soft(fixture.requests.filter(({ item }) => item.content === statement))
		.toEqual([original]);
	expect(
		readPublishedMemory(h.userId, original.bank).map(({ text }) => text),
	).toEqual([statement]);
});

it.each(["packing", "dispatch"] as const)(
	"keeps a project-origin assistant reply out of personal historical %s",
	async (stage) => {
		const { db, s } = await seed();
		const { eq } = await import("drizzle-orm");
		const { moveConversationToProject } = await import("../conversations");
		db.insert(s.projects)
			.values({ id: "origin", userId: h.userId, name: "Origin" })
			.run();
		db.update(s.messages)
			.set({ messageSequence: 1 })
			.where(eq(s.messages.id, "m"))
			.run();
		const privateText = "Confidential line from the project reply.";
		const publicText = "Later personal reply in the same chat.";
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2020-01-02"));
			expect(
				(await moveConversationToProject(h.userId, "chat", "origin"))
					?.projectId,
			).toBe("origin");
			db.insert(s.messages)
				.values({
					id: "project-assistant",
					conversationId: "chat",
					role: "assistant",
					content: privateText,
					createdAt: new Date("2020-01-03"),
					messageSequence: 2,
				})
				.run();
			vi.setSystemTime(new Date("2020-01-04"));
			expect(
				(await moveConversationToProject(h.userId, "chat", null))?.projectId,
			).toBeNull();
		} finally {
			vi.useRealTimers();
		}
		db.insert(s.messages)
			.values([
				{
					id: "personal-assistant",
					conversationId: "chat",
					role: "assistant",
					content: publicText,
					createdAt: new Date("2020-01-04T12:00:00Z"),
					messageSequence: 3,
				},
				{
					id: "later-personal",
					conversationId: "chat",
					role: "user",
					content: "I use painted envelopes.",
					createdAt: new Date("2020-01-05"),
					messageSequence: 4,
				},
			])
			.run();
		await allowMigrationHistory();
		const fixture = await nativeFixture();
		const migration = await import("./migration");
		await migration.prepareMemoryMigration(h.userId);
		const source = db
			.select()
			.from(s.memorySourceRevisions)
			.where(eq(s.memorySourceRevisions.messageId, "later-personal"))
			.get();
		if (!source) throw Error("fixture later source is missing");
		if (stage === "packing") {
			expect(source.context).not.toContain("project-assistant");
		} else {
			// Reconstruct the pre-fix packed context. The worker must fence a durable
			// reference from an earlier prepare even when its user parent is eligible.
			const parent = db
				.select()
				.from(s.memorySourceRevisions)
				.where(eq(s.memorySourceRevisions.messageId, "m"))
				.get();
			if (!parent) throw Error("fixture preceding source is missing");
			const { memoryTextHash } = await import("./revisions");
			const context = JSON.parse(source.context);
			context.messages.unshift({
				id: "project-assistant",
				role: "assistant",
				sourceId: parent.id,
				textHash: parent.textHash,
				messageTextHash: memoryTextHash(privateText),
			});
			db.update(s.memorySourceRevisions)
				.set({ context: JSON.stringify(context) })
				.where(eq(s.memorySourceRevisions.id, source.id))
				.run();
		}
		const { memoryDeliveryJob } = await import("./delivery-job");
		await h.engine.drain(memoryDeliveryJob);
		const retain = fixture.fetcher.mock.calls
			.filter(
				([url, options]) =>
					String(url).endsWith("/memories") && options?.method === "POST",
			)
			.find(([, options]) =>
				String(options?.body).includes("I use painted envelopes."),
			);
		expect(retain).toBeDefined();
		expect(String(retain?.[1]?.body)).not.toContain(privateText);
		expect(String(retain?.[1]?.body)).toContain(publicText);
	},
);

async function seedProjectRetentionHistory() {
	const { db, s } = await seed();
	db.insert(s.projects)
		.values([
			{ id: "origin", userId: h.userId, name: "Original" },
			{ id: "destination", userId: h.userId, name: "Destination" },
		])
		.run();
	db.update(s.conversations).set({ projectId: "origin" }).run();
	return { db, s };
}

it("keeps project history out of personal Memory after project deletion with no Memory account", async () => {
	const { db, s } = await seedProjectRetentionHistory();
	const { eq } = await import("drizzle-orm");
	const { deleteProject } = await import("../projects");
	const { createMessage } = await import("../messages");
	const { readPublishedMemory } = await import("./publication");
	const { memoryDeliveryJob, prepareNativeMemoryErasure } = await import(
		"./delivery-job"
	);
	const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } =
		await import("./chat-delivery");
	const migration = await import("./migration");
	const fixture = await migrationReplayNative();
	const projectOnlyContext = "Project assistant note about a private trail.";
	db.insert(s.messages)
		.values({
			id: "project-assistant",
			conversationId: "chat",
			messageSequence: 2,
			role: "assistant",
			content: projectOnlyContext,
			createdAt: new Date("2020-01-01"),
		})
		.run();
	expect(db.select().from(s.memoryAccounts).all()).toEqual([]);
	expect(db.select().from(s.memoryBanks).all()).toEqual([]);

	// Put the real detachment and the later turn in distinct persisted seconds.
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		vi.setSystemTime(Date.now() - 5000);
		expect(await deleteProject(h.userId, "origin")).toBe(true);
	} finally {
		vi.useRealTimers();
	}
	const scopeEvents = db.select().from(s.memoryEvents).all();
	expect.soft(scopeEvents).toMatchObject([
		{
			conversationId: "chat",
			subjectId: "project:origin",
			relatedId: "personal",
			payloadJson: '{"epoch":0}',
		},
	]);
	expect(db.select().from(s.conversations).get()?.projectId).toBeNull();
	expect(db.select().from(s.memoryAccounts).all()).toEqual([]);

	await allowMigrationHistory();
	expect
		.soft(migration.inspectMemoryMigration(h.userId).sources[0])
		.toMatchObject({
			id: "m",
			eligibility: "held",
		});
	const prepared = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(migration.cutoverMemoryMigration(h.userId, prepared.id).ready).toBe(
		true,
	);
	const personalBank = db
		.select()
		.from(s.memoryBanks)
		.where(eq(s.memoryBanks.scopeKey, "personal"))
		.get();
	if (!personalBank) throw Error("fixture personal bank is missing");
	const published = () =>
		readPublishedMemory(h.userId, personalBank.id).map(({ text }) => text);
	expect.soft(published()).toEqual([]);

	const stamp = captureMemoryTurnAcceptance(h.userId, "chat");
	const personal = "I collect pencil maps.";
	const message = await createMessage("chat", "user", personal);
	const reply = await createMessage(
		"chat",
		"assistant",
		"Thanks for telling me.",
	);
	await deliverCompletedMemoryTurn({
		userId: h.userId,
		conversationId: "chat",
		memoryAcceptance: stamp,
		userMessageId: message.id,
		assistantMessageId: reply.id,
	});
	await h.engine.drain(memoryDeliveryJob);
	expect(
		migration
			.inspectMemoryMigration(h.userId)
			.sources.find(({ id }) => id === message.id)?.eligibility,
	).toBe("eligible");
	await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	const retained = fixture.requests.filter(
		({ bank }) => bank === personalBank.id,
	);
	expect.soft(retained.map(({ item }) => item.content)).toEqual([personal]);
	expect.soft(JSON.stringify(retained)).not.toContain(projectOnlyContext);
	expect.soft(published()).toEqual([personal]);

	await prepareNativeMemoryErasure(h.userId);
	const afterReset = migration.inspectMemoryMigration(h.userId);
	expect(afterReset.epoch).toBe(1);
	expect(afterReset.sources.map(({ reason }) => reason)).toEqual([
		"pre_reset",
		"pre_reset",
	]);
});

it("rolls project deletion back if its scope history cannot be recorded", async () => {
	const { db, s } = await seedProjectRetentionHistory();
	const { eq } = await import("drizzle-orm");
	const { deleteProject } = await import("../projects");
	h.sqlite.exec(`
		CREATE TRIGGER reject_detached_scope
		BEFORE INSERT ON memory_events
		WHEN NEW.event_type = 'memory_scope_moved'
		BEGIN
			SELECT RAISE(ABORT, 'synthetic_scope_history_unavailable');
		END
	`);
	await expect(deleteProject(h.userId, "origin")).rejects.toThrow(
		"synthetic_scope_history_unavailable",
	);
	expect(
		db.select().from(s.projects).where(eq(s.projects.id, "origin")).get()?.id,
	).toBe("origin");
	expect(db.select().from(s.conversations).get()?.projectId).toBe("origin");
	expect(db.select().from(s.memoryEvents).all()).toEqual([]);
});

it("reuses the accepted project source when history is included again after a round-trip move and Memory toggle", async () => {
	const { db, s } = await seedProjectRetentionHistory();
	const { eq } = await import("drizzle-orm");
	const { recallMemory } = await import("../memory-context/native");
	const { moveConversationToProject } = await import("../conversations");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const { setMemoryEnabled, recordHistoryImportChoice } = await import(
		"./migration-policy"
	);
	const { readPublishedMemory } = await import("./publication");
	const migration = await import("./migration");
	const fixture = await migrationReplayNative();
	await allowMigrationHistory();
	const prepared = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(migration.cutoverMemoryMigration(h.userId, prepared.id).ready).toBe(
		true,
	);
	const source = db
		.select()
		.from(s.memorySourceRevisions)
		.where(eq(s.memorySourceRevisions.messageId, "m"))
		.get();
	if (!source) throw Error("fixture project source is missing");
	const published = () =>
		readPublishedMemory(h.userId, source.bankId).map(
			({ nativeId, text, updatedAt }) => ({ nativeId, text, updatedAt }),
		);
	const original = published();
	expect(original.map(({ text }) => text).sort()).toEqual(
		[replayOldBicycle, replayIndependentDog].sort(),
	);

	await setMemoryEnabled(h.userId, false);
	expect(
		await recallMemory(h.userId, {
			conversationId: "chat",
			query: "Memory",
			tokenBudget: 100,
		}),
	).toEqual([]);
	expect(
		(await moveConversationToProject(h.userId, "chat", null))?.projectId,
	).toBeNull();
	expect(
		(await moveConversationToProject(h.userId, "chat", "destination"))
			?.projectId,
	).toBe("destination");
	await setMemoryEnabled(h.userId, true);
	await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(published()).toEqual(original);
	expect(
		(await moveConversationToProject(h.userId, "chat", "origin"))?.projectId,
	).toBe("origin");

	await recordHistoryImportChoice(h.userId, {
		choice: "include",
		requestId: "include-again",
	});
	expect.soft(published()).toEqual(original);
	await h.engine.drain(memoryDeliveryJob);
	expect(published()).toEqual(original);
	expect(fixture.requests).toEqual([
		expect.objectContaining({
			bank: source.bankId,
			item: expect.objectContaining({
				document_id: source.id,
				timestamp: source.assertedAt.toISOString(),
			}),
		}),
	]);
});

it("withdraws a queued old-project source before retain when its chat moves away", async () => {
	const { db, s } = await seedProjectRetentionHistory();
	const { moveConversationToProject } = await import("../conversations");
	const { memoryDeliveryJob } = await import("./delivery-job");
	const migration = await import("./migration");
	const fixture = await migrationReplayNative();
	await allowMigrationHistory();
	await migration.prepareMemoryMigration(h.userId);
	expect(db.select().from(s.memorySourceRevisions).get()?.state).toBe(
		"pending",
	);
	expect(
		(await moveConversationToProject(h.userId, "chat", null))?.projectId,
	).toBeNull();
	expect(
		(await moveConversationToProject(h.userId, "chat", "destination"))
			?.projectId,
	).toBe("destination");
	await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(memoryDeliveryJob);
	expect(fixture.requests).toEqual([]);
	expect(
		db
			.select()
			.from(s.memorySourceRevisions)
			.all()
			.map(({ state }) => state),
	).toEqual(["revoked"]);
});

it("keeps a recorded decline after switching master Memory off and on and rejects cached choice writes", async () => {
	const { db, s } = await seed();
	await keepPriorHistoryDecline();
	const policy = await import("./migration-policy");
	await policy.setMemoryEnabled(h.userId, false);
	await policy.setMemoryEnabled(h.userId, true);
	const migration = await import("./migration");
	await migration.prepareMemoryMigration(h.userId);
	const route = await import(
		"../../../../routes/api/knowledge/memory/history-import/+server"
	);
	const post = await route.POST(
		migrationReplayEvent("/api/knowledge/memory/history-import", "POST", {
			choice: "include",
			requestId: "stale-browser",
		}) as Parameters<typeof route.POST>[0],
	);
	expect(post.status).toBe(410);
	const get = await route.GET(
		migrationReplayEvent(
			"/api/knowledge/memory/history-import",
			"POST",
			{},
		) as Parameters<typeof route.GET>[0],
	);
	expect(await get.json()).toMatchObject({
		available: false,
		shouldPrompt: false,
		choice: "decline",
	});
	expect(
		db
			.select()
			.from(s.memoryHistoryChoices)
			.all()
			.map((choice) => choice.choice),
	).toEqual(["decline"]);
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.all()
			.map((job) => job.kind),
	).toEqual(["provision"]);
});

it("excludes imported author turns and does not use imported assistant replies as context", async () => {
	const { db, s } = await seed();
	const { eq } = await import("drizzle-orm");
	db.update(s.messages)
		.set({ messageSequence: 1 })
		.where(eq(s.messages.id, "m"))
		.run();
	const at = new Date("2020-01-02T00:00:00Z");
	db.insert(s.messages)
		.values([
			{
				id: "external-answer",
				conversationId: "chat",
				role: "assistant",
				content: "Imported assistant content",
				importSource: "external",
				createdAt: at,
				messageSequence: 2,
			},
			{
				id: "local-later",
				conversationId: "chat",
				role: "user",
				content: "I live in a blue house.",
				createdAt: at,
				messageSequence: 3,
			},
			{
				id: "external-turn",
				conversationId: "chat",
				role: "user",
				content: "Imported user content",
				importSource: "external",
				createdAt: at,
				messageSequence: 4,
			},
		])
		.run();
	const migration = await import("./migration");
	expect(migration.inspectMemoryMigration(h.userId).sources).toContainEqual(
		expect.objectContaining({
			id: "external-turn",
			eligibility: "excluded",
			reason: "imported_message",
		}),
	);
	await migration.prepareMemoryMigration(h.userId);
	const rows = db.select().from(s.memorySourceRevisions).all();
	expect(rows.map((row) => row.messageId).sort()).toEqual(["local-later", "m"]);
	expect(
		JSON.parse(
			rows.find((row) => row.messageId === "local-later")?.context ?? "{}",
		),
	).toMatchObject({
		migrationDefaultHistory: true,
		messages: [],
	});
	const original = rows.find((row) => row.messageId === "m");
	if (!original) throw Error("first test source missing");
	db.update(s.messages)
		.set({ importSource: "external" })
		.where(eq(s.messages.id, "m"))
		.run();
	const { assertMemorySourceCurrent } = await import("./revisions");
	expect(() =>
		db.transaction((tx) =>
			assertMemorySourceCurrent(tx, original.id, h.userId, original.bankId),
		),
	).toThrow("memory_source_changed");
});

it("recovers two completed retains without accepting either alone or sending them again", async () => {
	const { db, s } = await seed();
	db.insert(s.messages)
		.values({
			id: "second",
			conversationId: "chat",
			role: "user",
			content: "I prefer quiet meeting rooms.",
			createdAt: new Date("2020-01-02"),
		})
		.run();
	const f = await nativeFixture();
	const migration = await import("./migration");
	const jobs = await import("./delivery-job");
	const manifest = await migration.prepareMemoryMigration(h.userId);
	const sources = db.select().from(s.memorySourceRevisions).all();
	expect(sources).toHaveLength(2);
	for (const source of sources) {
		const id = `${source.id}:fact`;
		f.facts.set(id, {
			id,
			text: source.text,
			bank: source.bankId,
			fact_type: "world",
			document_id: source.id,
			consolidated_at: "2026-11-18T00:00:00Z",
		});
	}
	f.extraObservations.push({
		id: "mixed",
		text: "Two independently asserted preferences.",
		fact_type: "observation",
		source_memory_ids: sources.map((source) => `${source.id}:fact`),
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.all()
			.map((j) => j.errorCode),
	).toEqual(["memory_preparation_failed", "memory_preparation_failed"]);
	expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
		false,
	);
	const retainedBefore = f.retained.length;
	const bank = db.select().from(s.memoryBanks).get();
	const config = await import("$lib/server/config-store");
	vi.mocked(config.getConfig).mockReturnValue({
		...config.getConfig(),
		hindsightWorkerEnabled: false,
		hindsightNewAccountsEnabled: false,
	});
	const { recoverAcknowledgedHistoricalMigration } = await import(
		"./migration-recovery"
	);
	const recover = () =>
		recoverAcknowledgedHistoricalMigration({
			userId: h.userId,
			manifestId: manifest.id,
			bankId: bank?.id ?? "",
		});
	f.extraObservations.push({
		id: "unknown",
		text: "Unknown support",
		fact_type: "observation",
		source_memory_ids: ["unknown-fact"],
	});
	await expect(recover()).rejects.toThrow("memory_candidate_unaccepted");
	expect(db.select().from(s.memoryPublishedRows).all()).toEqual([]);
	expect(
		db
			.select()
			.from(s.memorySourceRevisions)
			.all()
			.map((source) => source.state),
	).toEqual(["pending", "pending"]);
	f.extraObservations.pop();
	await expect(recover()).resolves.toMatchObject({ reopened: 2 });
	expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
		false,
	);
	expect(db.select().from(s.memoryPublishedRows).all()).toHaveLength(3);
	vi.mocked(config.getConfig).mockReturnValue({
		...config.getConfig(),
		hindsightWorkerEnabled: true,
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
		true,
	);
	expect(f.retained).toHaveLength(retainedBefore);
	expect(db.select().from(s.memoryAccounts).get()?.authority).toBe("preparing");
});

it("holds surgical rewind until the exact unpublished drift contributors are proved", async () => {
	const { db, s } = await seed();
	const recovery = await import("./migration-pending-rewind");
	const migration = await import("./migration");
	const manifest = await migration.prepareMemoryMigration(h.userId);
	const bank = db.select().from(s.memoryBanks).get();
	await expect(
		recovery.rewindUnpublishedMigrationSources({
			userId: h.userId,
			manifestId: manifest.id,
			bankId: bank?.id ?? "",
			sourceIds: ["foreign-source"],
			manifestHash: "0".repeat(64),
		}),
	).rejects.toThrow("memory_migration_rewind_unverified");
	expect(db.select().from(s.memoryRevocations).all()).toEqual([]);
	expect(db.select().from(s.memorySourceRevisions).get()?.state).toBe(
		"pending",
	);
});

it("keeps a surgical rewind bank unclaimable after its manifest reports failure", async () => {
	const { db, s } = await seed();
	const f = await nativeFixture();
	const migration = await import("./migration");
	const jobs = await import("./delivery-job");
	await migration.prepareMemoryMigration(h.userId);
	const bank = db.select().from(s.memoryBanks).get();
	const manifest = db.select().from(s.memoryMigrationManifests).get();
	if (!bank || !manifest) throw Error("seeded_migration_missing");
	db.update(s.memoryMigrationManifests)
		.set({
			status: "failed",
			checkpointJson: JSON.stringify({
				...JSON.parse(manifest.checkpointJson ?? "{}"),
				migrationRewind: { bankId: bank.id },
			}),
		})
		.run();
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(db.select().from(s.memoryDeliveryJobs).get()?.status).toBe("queued");
	expect(f.fetcher).not.toHaveBeenCalled();
});

it("keeps only the exact original covered by a confirmed later correction on hold", async () => {
	const { db, s } = await seed();
	db.insert(s.messages)
		.values({
			id: "independent",
			conversationId: "chat",
			role: "user",
			content: "I prefer quiet meeting rooms.",
			createdAt: new Date("2020-03-01"),
		})
		.run();
	const { inspectMemoryMigration, prepareMemoryMigration } = await import(
		"./migration"
	);
	const { memoryTextHash } = await import("./revisions");
	await prepareMemoryMigration(h.userId);
	const manifest = db.select().from(s.memoryMigrationManifests).get();
	if (!manifest) throw Error("seeded_migration_missing");
	db.update(s.memoryMigrationManifests)
		.set({
			checkpointJson: JSON.stringify({
				...JSON.parse(manifest.checkpointJson ?? "{}"),
				migrationCorrectionHolds: [
					{
						messageId: "m",
						textHash: memoryTextHash("My bicycle is blue. My dog is Rex."),
						assertedAt: "2020-01-01T00:00:00.000Z",
						scopeKey: "personal",
					},
				],
			}),
		})
		.run();
	const held = inspectMemoryMigration(h.userId);
	expect(held.sources).toEqual([
		expect.objectContaining({
			id: "m",
			eligibility: "held",
			reason: "held_conflict_with_later_correction",
		}),
		expect.objectContaining({ id: "independent", eligibility: "eligible" }),
	]);
	await prepareMemoryMigration(h.userId);
	expect(
		inspectMemoryMigration(h.userId).sources.find((source) => source.id === "m")
			?.eligibility,
	).toBe("held");
	expect(db.select().from(s.messages).all()).toHaveLength(2);
});

it("blocks withdrawn wording generated by default history even when the source body is eligible", async () => {
	const { db, s } = await legacyItem();
	db.update(s.memoryProfileItemProvenance)
		.set({ sourceId: "unavailable-chat" })
		.run();
	db.update(s.messages).set({ content: "My dog is Rex." }).run();
	const f = await nativeFixture();
	const migration = await import("./migration");
	const jobs = await import("./delivery-job");
	const inventory = migration.inspectMemoryMigration(h.userId);
	expect(inventory.sources[0]).toMatchObject({ eligibility: "eligible" });
	expect(inventory.exceptions).toContainEqual(
		expect.objectContaining({ reason: "missing_source" }),
	);
	const manifest = await migration.prepareMemoryMigration(h.userId);
	const source = db.select().from(s.memorySourceRevisions).get();
	if (!source) throw Error("seeded_source_missing");
	f.extraObservations.push({
		id: "withdrawn-generated",
		text: "My bicycle is blue.",
		fact_type: "observation",
		source_memory_ids: [`${source.id}:fact`],
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(db.select().from(s.memoryPublishedRows).all()).toEqual([]);
	expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
		false,
	);
	expect(db.select().from(s.memoryAccounts).get()?.authority).toBe("preparing");
});

it("publishes only the exact reviewed ordinary merge without re-retaining", async () => {
	const { db, s } = await legacyItem();
	db.update(s.memoryProfileItemProvenance)
		.set({ sourceId: "missing-chat" })
		.run();
	db.update(s.messages).set({ content: "I prefer quiet meeting rooms." }).run();
	const f = await nativeFixture();
	const migration = await import("./migration");
	const jobs = await import("./delivery-job");
	const manifest = await migration.prepareMemoryMigration(h.userId);
	await h.engine.drain(jobs.memoryDeliveryJob);
	const old = db.select().from(s.memorySourceRevisions).get();
	if (old?.state !== "accepted") throw Error("old_source_not_accepted");
	db.insert(s.messages)
		.values({
			id: "second-supported",
			conversationId: "chat",
			role: "user",
			content: "I usually close the door during meetings.",
			createdAt: new Date("2020-01-02"),
		})
		.run();
	await migration.prepareMemoryMigration(h.userId);
	const next = db
		.select()
		.from(s.memorySourceRevisions)
		.all()
		.find((row) => row.messageId === "second-supported");
	if (!next) throw Error("new_source_missing");
	const merged = {
		id: `${old.id}:fact:observation`,
		text: "I prefer quiet meeting rooms and usually close the door during meetings.",
		fact_type: "observation" as const,
		source_memory_ids: [`${old.id}:fact`, `${next.id}:fact`],
	};
	f.extraObservations.push(merged);
	await h.engine.drain(jobs.memoryDeliveryJob);
	const retainedCount = f.retained.length;
	const config = await import("$lib/server/config-store");
	vi.mocked(config.getConfig).mockReturnValue({
		...config.getConfig(),
		hindsightWorkerEnabled: false,
		hindsightNewAccountsEnabled: false,
	});
	const { recoverAcknowledgedHistoricalMigration } = await import(
		"./migration-recovery"
	);
	const scope = {
		userId: h.userId,
		manifestId: manifest.id,
		bankId: old.bankId,
	};
	const originalPublished = db.select().from(s.memoryPublishedRows).all();
	await expect(recoverAcknowledgedHistoricalMigration(scope)).rejects.toThrow(
		"memory_migration_withdrawal_boundary",
	);
	const inspect = () =>
		recoverAcknowledgedHistoricalMigration({
			...scope,
			reviewedMerge: { sourceId: next.id, inspectOnly: true },
		});
	f.extraObservations.push({ ...merged, id: "second-unreviewed-merge" });
	await expect(inspect()).rejects.toThrow(
		"memory_migration_recovery_unverified",
	);
	f.extraObservations.pop();

	const inspected = await inspect();
	expect(inspected.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
	const recover = () =>
		recoverAcknowledgedHistoricalMigration({
			...scope,
			reviewedMerge: {
				sourceId: next.id,
				snapshotHash: inspected.snapshotHash ?? "",
			},
		});
	merged.text += " This changes the reviewed snapshot.";
	await expect(recover()).rejects.toThrow(
		"memory_migration_recovery_unverified",
	);
	expect(db.select().from(s.memoryPublishedRows).all()).toEqual(
		originalPublished,
	);
	merged.text =
		"I prefer quiet meeting rooms and usually close the door during meetings.";
	await expect(recover()).resolves.toMatchObject({ reopened: 1 });
	await expect(recover()).rejects.toThrow(
		"memory_migration_recovery_unverified",
	);
	vi.mocked(config.getConfig).mockReturnValue({
		...config.getConfig(),
		hindsightWorkerEnabled: true,
	});
	await h.engine.drain(jobs.memoryDeliveryJob);
	expect(f.retained).toHaveLength(retainedCount);
	expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
		true,
	);
	expect(db.select().from(s.memoryAccounts).get()?.authority).toBe("preparing");
});

it.each([
	[0, false],
	[1, false],
	[2, false],
	[2, true],
])(
	"resumes an interrupted selective archive with %i exact companions and support growth %s without re-retaining",
	async (companionCount, growsSupport) => {
		const { db, s } = await seed();
		db.update(s.messages).set({ content: "My radio code is OLD." }).run();
		db.insert(s.memoryProjectionState)
			.values({ id: "projection", userId: h.userId, resetGeneration: 0 })
			.run();
		if (growsSupport)
			db.insert(s.messages)
				.values({
					id: "prior-ordinary",
					conversationId: "chat",
					role: "user",
					content: "My independent trail is Cedar.",
					createdAt: new Date("2019-02-01"),
				})
				.run();
		const authored = "The current radio code is NEW.";
		db.insert(s.memoryProfileItems)
			.values({
				id: "approved",
				userId: h.userId,
				projectionStateId: "projection",
				itemKey: "correction",
				category: "about_you",
				scopeType: "global",
				scopeId: "global",
				status: "active",
				statement: authored,
				metadataJson: JSON.stringify({
					origin: "user_authored",
					reviewResolution: "edited",
				}),
				updatedAt: new Date("2021-01-01"),
			})
			.run();
		const f = await nativeFixture();
		const migration = await import("./migration");
		const jobs = await import("./delivery-job");
		const manifest = await migration.prepareMemoryMigration(h.userId);
		const { eq } = await import("drizzle-orm");
		const { claimNext } = await import("../jobs/ledger");
		const { runAttempt } = await import("../jobs/runner");
		const workerId = "selective-test";
		const claim = async (id: string) => {
			const job = claimNext(jobs.memoryDeliveryJob, { workerId, jobId: id });
			if (!job) throw Error("test_claim_missing");
			await runAttempt(jobs.memoryDeliveryJob, job, { workerId });
		};
		const sources = db.select().from(s.memorySourceRevisions).all();
		const [authority] = sources.filter((row) => row.messageId === null);
		const [old] = sources.filter((row) => row.messageId === "m");
		const jobFor = (id: string) =>
			db
				.select()
				.from(s.memoryDeliveryJobs)
				.where(eq(s.memoryDeliveryJobs.sourceId, id))
				.get();
		const authoredJob = jobFor(authority.id);
		const oldJob = jobFor(old.id);
		if (!authoredJob || !oldJob) throw Error("test_job_missing");
		const support = `${authority.id}:fact`;
		const companions = Array.from({ length: companionCount }, (_, i) => ({
			id: `published-companion-${i}`,
			text: `Exact existing radio observation ${i}.`,
			fact_type: "observation" as const,
			source_memory_ids: [support],
		}));
		const historical = sources.find(
			(row) => row.messageId === "prior-ordinary",
		);
		const oldIndependent = historical && `${historical.id}:fact`;
		const historicalJob = historical && jobFor(historical.id);
		if (historicalJob && historical) {
			await claim(historicalJob.id);
			expect(jobFor(historical.id)).toMatchObject({ status: "succeeded" });
		}
		f.extraObservations.push(...companions);
		await claim(authoredJob.id);
		const bank = db.select().from(s.memoryBanks).get();
		const prior = db
			.select()
			.from(s.memoryPublishedRows)
			.where(eq(s.memoryPublishedRows.nativeId, `${support}:observation`))
			.get();
		if (!bank || !prior) throw Error("test_publication_missing");
		expect(prior.text).toBe(authored);
		const conflict = `${old.id}:fact`;
		const independent = `${old.id}:accompanying`;
		f.hideObservation.add(conflict);
		f.facts.set(independent, {
			id: independent,
			text: "My independent trail is Cedar.",
			bank: old.bankId,
			fact_type: "world",
			document_id: old.id,
			consolidated_at: "2026-11-18T00:00:00Z",
		});
		f.extraObservations.push({
			id: prior.nativeId,
			text: "The radio code is OLD.",
			fact_type: "observation",
			source_memory_ids: [`${authority.id}:fact`, conflict],
		});
		if (oldIndependent) {
			f.hideObservation.add(independent);
			f.hideObservation.add(oldIndependent);
			f.extraObservations.push({
				id: `${oldIndependent}:observation`,
				text: "My independent trail is Cedar.",
				fact_type: "observation",
				source_memory_ids: [oldIndependent, independent],
			});
		}
		await claim(oldJob.id);
		expect(jobFor(old.id)?.errorCode).toBe("memory_preparation_failed");
		expect(
			db
				.select()
				.from(s.memorySourceRevisions)
				.where(eq(s.memorySourceRevisions.id, old.id))
				.get()?.nativeAcknowledged,
		).toBe(true);
		const retained = f.retained.length;
		const config = await import("$lib/server/config-store");
		vi.mocked(config.getConfig).mockReturnValue({
			...config.getConfig(),
			hindsightWorkerEnabled: false,
			hindsightNewAccountsEnabled: false,
		});
		const { recoverAcknowledgedHistoricalMigration } = await import(
			"./migration-recovery"
		);
		const scope = {
			userId: h.userId,
			bankId: bank.id,
			manifestId: manifest.id,
		};
		const target = { sourceId: old.id, nativeFactId: conflict };
		const inspect = () =>
			recoverAcknowledgedHistoricalMigration({
				...scope,
				selectiveRepair: { ...target, inspectOnly: true },
			});
		f.extraObservations.push({
			id: "unapproved-overlap",
			text: "A separate competing protected presentation",
			fact_type: "observation",
			source_memory_ids: [`${authority.id}:fact`],
		});
		await expect(inspect()).rejects.toThrow(
			"memory_migration_recovery_unverified",
		);
		expect(f.archived.size).toBe(0);
		f.extraObservations.pop();
		if (companionCount === 1) {
			await expect(inspect()).rejects.toThrow(
				"memory_migration_recovery_unverified",
			);
			expect(f.archived.size).toBe(0);
			return;
		}
		if (companionCount === 2) {
			const unchangedText = companions[0].text;
			companions[0].text = "Changed protected companion";
			await expect(inspect()).rejects.toThrow(
				"memory_migration_recovery_unverified",
			);
			expect(f.archived.size).toBe(0);
			companions[0].text = unchangedText;
		}
		if (growsSupport) {
			const expanded = f.extraObservations.at(-1);
			if (!expanded) throw Error("test_expected_expansion");
			expanded.text = "Rephrased trail.";
			await expect(inspect()).rejects.toThrow(
				"memory_migration_recovery_unverified",
			);
			expect(f.archived.size).toBe(0);
			expanded.text = "My independent trail is Cedar.";
			for (const source_memory_ids of [
				[independent],
				["not-an-admitted-raw"],
				[],
			]) {
				f.extraObservations.push({
					id: "unsupported-new-presentation",
					text: "A second unexpected observation.",
					fact_type: "observation",
					source_memory_ids,
				});
				await expect(inspect()).rejects.toThrow(
					"memory_migration_recovery_unverified",
				);
				expect(f.archived.size).toBe(0);
				f.extraObservations.pop();
			}
		}
		const result = await inspect();
		expect(result.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
		const apply = (hash = result.snapshotHash ?? "") =>
			recoverAcknowledgedHistoricalMigration({
				...scope,
				selectiveRepair: { ...target, snapshotHash: hash },
			});
		await expect(apply("0".repeat(64))).rejects.toThrow(
			"memory_migration_recovery_unverified",
		);
		expect(f.archived.size).toBe(0);
		f.facts.set("unknown-raw", {
			id: "unknown-raw",
			text: "Unadmitted synthetic scope",
			bank: bank.id,
			fact_type: "world",
			document_id: "foreign-document",
			consolidated_at: "2026-11-18T00:00:00Z",
		});
		await expect(apply()).rejects.toThrow(
			"memory_migration_recovery_unverified",
		);
		expect(f.archived.size).toBe(0);
		f.facts.delete("unknown-raw");
		f.interruptNextArchive();
		await expect(apply()).rejects.toThrow();
		expect(f.archived.has(conflict)).toBe(true);
		await expect(recoverAcknowledgedHistoricalMigration(scope)).rejects.toThrow(
			"memory_migration_recovery_unverified",
		);
		await expect(migration.prepareMemoryMigration(h.userId)).rejects.toThrow(
			"memory_migration_recovery_unverified",
		);
		expect(
			db
				.select()
				.from(s.memoryPublishedRows)
				.where(eq(s.memoryPublishedRows.nativeId, prior.nativeId))
				.get()?.text,
		).toBe(authored);
		expect(jobFor(old.id)?.status).toBe("failed");
		await expect(apply()).resolves.toMatchObject({ reopened: 1, sources: 1 });
		f.hideObservation.add(independent);
		if (!growsSupport)
			f.extraObservations.push({
				id: "rekeyed-independent",
				text: "My independent trail is Cedar.",
				fact_type: "observation",
				source_memory_ids: [independent],
			});

		vi.mocked(config.getConfig).mockReturnValue({
			...config.getConfig(),
			hindsightWorkerEnabled: true,
		});
		await claim(oldJob.id);
		expect(jobFor(old.id)?.status).toBe("succeeded");
		expect(f.retained.length).toBe(retained);
		expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
			true,
		);
		const { readPublishedMemory } = await import("./publication");
		const visible = readPublishedMemory(h.userId, bank.id);
		expect(visible.map((row) => row.text).sort()).toEqual(
			[
				authored,
				"My independent trail is Cedar.",
				...companions.map((row) => row.text),
			].sort(),
		);
		expect(visible.find((row) => row.text.includes("Cedar"))?.nativeId).toBe(
			growsSupport ? `${oldIndependent}:observation` : "rekeyed-independent",
		);
		migration.cutoverMemoryMigration(h.userId, manifest.id);
		const { publishNativeSnapshot } = await import("./publication");
		const { nativeMemoryClient } = await import("./hindsight-client");
		const terminalBank = db
			.select()
			.from(s.memoryBanks)
			.where(eq(s.memoryBanks.id, bank.id))
			.get();
		const account = db.select().from(s.memoryAccounts).get();
		if (!terminalBank || !account) throw Error("test_cutover_missing");
		const client = nativeMemoryClient(bank.id, account.tenantId);
		const exact = await client.list();
		const drifted = exact.map((r) =>
			r.fact_type === "observation" && r.id === prior.nativeId
				? { ...r, source_memory_ids: [support, independent] }
				: r,
		);
		expect(() =>
			db.transaction((tx) =>
				publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: bank.id,
					epoch: bank.epoch,
					expectedRevision: terminalBank.revision,
					memories: drifted,
				}),
			),
		).toThrow("memory_migration_authored_observation_changed");
		expect(readPublishedMemory(h.userId, bank.id)).toEqual(visible);
		const renamed = exact.map((r) =>
			r.fact_type === "observation" && r.id === prior.nativeId
				? { ...r, id: "rekeyed-authored", text: "Rephrased native evidence." }
				: r,
		);
		db.transaction((tx) =>
			publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: bank.id,
				epoch: bank.epoch,
				expectedRevision: terminalBank.revision,
				memories: renamed,
			}),
		);
		expect(
			readPublishedMemory(h.userId, bank.id).find(
				(row) => row.nativeId === "rekeyed-authored",
			)?.text,
		).toBe(authored);
		if (companionCount) {
			const existingTarget = f.extraObservations.find(
				(row) => row.id === prior.nativeId,
			);
			if (existingTarget)
				f.extraObservations.splice(
					f.extraObservations.indexOf(existingTarget),
					1,
				);
			f.hideObservation.add(support);
			f.extraObservations.push({
				id: "rekeyed-authored",
				text: "Rephrased native evidence.",
				fact_type: "observation",
				source_memory_ids: [support],
			});
			const { recallMemory } = await import("../memory-context/native");
			const chat = db.select().from(s.conversations).get();
			if (!chat) throw Error("test_chat_missing");
			const recall = () =>
				recallMemory(h.userId, {
					conversationId: chat.id,
					query: "current radio and trail",
					tokenBudget: 500,
				});
			expect((await recall()).map(({ text }) => text).sort()).toEqual(
				[
					authored,
					"My independent trail is Cedar.",
					...companions.map(({ text }) => text),
				].sort(),
			);
			const liveOwner = f.extraObservations.find(
				(row) => row.id === "rekeyed-authored",
			);
			if (!liveOwner) throw Error("test_owner_missing");
			liveOwner.id = "fresh-owner-id";
			liveOwner.text = "Second native rephrase";
			companions[0].id = "fresh-exact-companion-id";
			expect((await recall()).map(({ text }) => text).sort()).toEqual(
				[
					authored,
					"My independent trail is Cedar.",
					...companions.map(({ text }) => text),
				].sort(),
			);
			f.extraObservations.push({
				id: "unranked-new-family-overlap",
				text: "Competing first-party evidence.",
				fact_type: "observation",
				source_memory_ids: [support],
			});
			expect((await recall()).map(({ text }) => text)).toEqual([
				"My independent trail is Cedar.",
			]);
		}
		expect(db.select().from(s.memoryRevocations).get()).toMatchObject({
			nativeFactId: conflict,
		});
		await expect(apply()).rejects.toThrow(
			"memory_migration_recovery_unverified",
		);
	},
);

it.each([false, true])(
	"resumes a marked correction hold with one verified rekeyed authored presentation (legacy=%s)",
	async (legacyMarker) => {
		const { db, s } = await seed();
		db.insert(s.messages)
			.values({
				id: "untouched-history-message",
				conversationId: "chat",
				role: "user",
				content: "I prefer quiet meeting rooms.",
				createdAt: new Date("2020-02-01"),
			})
			.run();
		db.update(s.messages).set({ content: "My radio code is OLD." }).run();
		db.insert(s.memoryProjectionState)
			.values({ id: "projection", userId: h.userId, resetGeneration: 0 })
			.run();
		const authored = "The current radio code is NEW.";
		db.insert(s.memoryProfileItems)
			.values({
				id: "approved",
				userId: h.userId,
				projectionStateId: "projection",
				itemKey: "correction",
				category: "about_you",
				scopeType: "global",
				scopeId: "global",
				status: "active",
				statement: authored,
				metadataJson: JSON.stringify({
					origin: "user_authored",
					reviewResolution: "edited",
				}),
				updatedAt: new Date("2021-01-01"),
			})
			.run();
		const f = await nativeFixture();
		const migration = await import("./migration");
		const jobs = await import("./delivery-job");
		const manifest = await migration.prepareMemoryMigration(h.userId);
		const { eq } = await import("drizzle-orm");
		const { claimNext } = await import("../jobs/ledger");
		const { runAttempt } = await import("../jobs/runner");
		const workerId = "correction-rewind-test";
		const claim = async (id: string) => {
			const job = claimNext(jobs.memoryDeliveryJob, { workerId, jobId: id });
			if (!job) throw Error("test_claim_missing");
			await runAttempt(jobs.memoryDeliveryJob, job, { workerId });
		};
		const sources = db.select().from(s.memorySourceRevisions).all();
		const [authority] = sources.filter((row) => row.messageId === null);
		const [old] = sources.filter((row) => row.messageId === "m");
		const jobFor = (id: string) =>
			db
				.select()
				.from(s.memoryDeliveryJobs)
				.where(eq(s.memoryDeliveryJobs.sourceId, id))
				.get();
		const authoredJob = jobFor(authority.id);
		const oldJob = jobFor(old.id);
		if (!authoredJob || !oldJob) throw Error("test_job_missing");
		const support = `${authority.id}:fact`;
		const companions = Array.from({ length: 2 }, (_, i) => ({
			id: `published-companion-${i}`,
			text: `Exact existing radio observation ${i}.`,
			fact_type: "observation" as const,
			source_memory_ids: [support],
		}));
		f.extraObservations.push(...companions);
		const provision = db
			.select()
			.from(s.memoryDeliveryJobs)
			.where(eq(s.memoryDeliveryJobs.kind, "provision"))
			.get();
		if (provision) await claim(provision.id);
		await claim(authoredJob.id);
		const bank = db.select().from(s.memoryBanks).get();
		const prior = db
			.select()
			.from(s.memoryPublishedRows)
			.where(eq(s.memoryPublishedRows.nativeId, `${support}:observation`))
			.get();
		if (!bank || !prior) throw Error("test_publication_missing");
		expect(prior.text).toBe(authored);
		const independentBefore = db
			.select()
			.from(s.memoryPublishedRows)
			.all()
			.filter((row) => row.id !== prior.id);
		const conflict = `${old.id}:fact`;
		const secondConflict = `${old.id}:second-fact`;
		f.hideObservation.add(conflict);
		f.hideObservation.add(secondConflict);
		f.facts.set(secondConflict, {
			id: secondConflict,
			text: "Use the OLD code to reach the radio.",
			bank: bank.id,
			fact_type: "world",
			document_id: old.id,
			consolidated_at: "2026-11-18T00:00:00Z",
		});
		const changed = {
			id: prior.nativeId,
			text: "The radio code might still be OLD.",
			fact_type: "observation" as const,
			source_memory_ids: [support, conflict, secondConflict],
		};
		f.extraObservations.push(changed);
		await claim(oldJob.id);
		expect(jobFor(old.id)?.errorCode).toBe("memory_preparation_failed");
		expect(f.facts.has(conflict)).toBe(true);
		const config = await import("$lib/server/config-store");
		vi.mocked(config.getConfig).mockReturnValue({
			...config.getConfig(),
			hindsightWorkerEnabled: false,
			hindsightNewAccountsEnabled: false,
		});
		const { createHash } = await import("node:crypto");
		const saved = db.select().from(s.memoryMigrationManifests).get();
		if (!saved) throw Error("test_manifest_missing");
		const { rewindUnpublishedMigrationSources } = await import(
			"./migration-pending-rewind"
		);
		const rewind = (verifiedPreRewindAuthoredObservationId?: string) =>
			rewindUnpublishedMigrationSources({
				userId: h.userId,
				manifestId: manifest.id,
				bankId: bank.id,
				manifestHash: createHash("sha256")
					.update(saved.manifestJson)
					.digest("hex"),
				sourceIds: [old.id],
				holdCorrectionConflict: true,
				verifiedPreRewindAuthoredObservationId,
			});
		const fetch = f.fetcher.getMockImplementation();
		if (!fetch) throw Error("test_fetch_missing");
		let interrupt = true;
		f.fetcher.mockImplementation(async (url, options) => {
			const result = await fetch(url, options);
			if (
				interrupt &&
				options?.method === "DELETE" &&
				String(url).includes("/documents/")
			) {
				interrupt = false;
				f.extraObservations.splice(f.extraObservations.indexOf(changed), 1);
				f.hideObservation.add(support);
				f.extraObservations.push({
					id: "regenerated-authored-row",
					text: "A regenerated phrase about the new radio code.",
					fact_type: "observation",
					source_memory_ids: [support],
				});
				throw Error("interrupted after deleting the old document");
			}
			return result;
		});
		await expect(rewind()).rejects.toThrow();
		expect(f.facts.has(conflict)).toBe(false);
		expect(f.facts.has(secondConflict)).toBe(false);
		const interrupted = db.select().from(s.memoryMigrationManifests).get();
		if (!interrupted) throw Error("test_manifest_missing");
		const checkpoint = JSON.parse(interrupted.checkpointJson ?? "{}");
		expect(checkpoint.migrationRewind.correctionAuthoredObservationId).toBe(
			prior.nativeId,
		);
		if (legacyMarker) {
			delete checkpoint.migrationRewind.correctionAuthoredObservationId;
			db.update(s.memoryMigrationManifests)
				.set({ checkpointJson: JSON.stringify(checkpoint) })
				.run();
			await expect(rewind()).rejects.toThrow(
				"memory_migration_rewind_unverified",
			);
		}
		const resume = () => rewind(legacyMarker ? prior.nativeId : undefined);
		const { readPublishedMemory } = await import("./publication");
		expect(readPublishedMemory(h.userId, bank.id)).toHaveLength(3);
		f.extraObservations.push({
			...changed,
			id: "ambiguous-successor",
			source_memory_ids: [support],
		});
		await expect(resume()).rejects.toThrow(
			"memory_migration_rewind_unverified",
		);
		f.extraObservations.pop();
		await expect(resume()).resolves.toMatchObject({
			heldConflicts: 1,
			replacedSources: 0,
		});
		const published = readPublishedMemory(h.userId, bank.id);
		expect(
			published.find((row) => row.nativeId === "regenerated-authored-row")
				?.text,
		).toBe(authored);
		for (const row of independentBefore) {
			expect(published).toContainEqual(
				expect.objectContaining({
					nativeId: row.nativeId,
					text: row.text,
					sourceFingerprintsJson: row.sourceFingerprintsJson,
				}),
			);
		}
		expect(
			migration
				.inspectMemoryMigration(h.userId)
				.sources.find(({ id }) => id === "m"),
		).toMatchObject({
			eligibility: "held",
			reason: "held_conflict_with_later_correction",
		});
		expect(db.select().from(s.messages).all()).toHaveLength(2);
	},
);

it.each([
	"accepted",
	"presented only by the statement",
	"merged note",
	"note from the statement itself",
	"prior note kept",
	"prior note dropped",
	"statement link dropped",
	"pinned",
	"companion",
	"reworded",
	"newer",
] as const)(
	"older history that corroborates a generated authored observation: %s",
	async (variant) => {
		// The owner extended the rule on 21 November 2026: the chat's fact may
		// be presented only inside the statement's row, and Hindsight may append
		// a dated note made from it, as long as the shown wording stays.
		const accepted =
			variant === "accepted" ||
			variant === "presented only by the statement" ||
			variant === "merged note" ||
			variant === "prior note kept";
		// The statement's own row already carried a dated note of its own fact.
		const priorNote =
			variant === "prior note kept" || variant === "prior note dropped";
		const inside =
			variant === "presented only by the statement" ||
			variant === "merged note" ||
			priorNote;
		const mentioned = "2020-01-01T09:30:00.000Z";
		const noteFor = (id: string) => {
			const fact = f.facts.get(id);
			return fact?.mentioned_at
				? ` (${fact.mentioned_at.slice(0, 16).replace("T", " ")}: ${fact.text.split(" | ")[0].trim()})`
				: "";
		};
		const { db, s } = await seed();
		const history = "Mila, my sister in Porto, works as a ferry pilot.";
		const authored = "My sister Mila lives in Porto.";
		db.update(s.messages)
			.set({
				content: history,
				createdAt: new Date(variant === "newer" ? "2022-01-01" : "2020-01-01"),
			})
			.run();
		db.insert(s.memoryProjectionState)
			.values({ id: "projection", userId: h.userId, resetGeneration: 0 })
			.run();
		db.insert(s.memoryProfileItems)
			.values({
				id: "authored",
				userId: h.userId,
				projectionStateId: "projection",
				itemKey: "sister",
				category: "about_you",
				scopeType: "global",
				scopeId: "global",
				status: "active",
				statement: authored,
				metadataJson: JSON.stringify({
					origin: "user_authored",
					...(variant === "pinned" ? { reviewResolution: "edited" } : {}),
				}),
				updatedAt: new Date("2021-01-01"),
			})
			.run();
		const f = await nativeFixture();
		const migration = await import("./migration");
		const jobs = await import("./delivery-job");
		const manifest = await migration.prepareMemoryMigration(h.userId);
		const { eq } = await import("drizzle-orm");
		const { claimNext } = await import("../jobs/ledger");
		const { runAttempt } = await import("../jobs/runner");
		const claim = async (id: string) => {
			const job = claimNext(jobs.memoryDeliveryJob, {
				workerId: "corroboration-test",
				jobId: id,
			});
			if (!job) throw Error("test_claim_missing");
			await runAttempt(jobs.memoryDeliveryJob, job, {
				workerId: "corroboration-test",
			});
		};
		const sources = db.select().from(s.memorySourceRevisions).all();
		const [authority] = sources.filter((row) => row.messageId === null);
		const [older] = sources.filter((row) => row.messageId === "m");
		const jobFor = (id: string) =>
			db
				.select()
				.from(s.memoryDeliveryJobs)
				.where(eq(s.memoryDeliveryJobs.sourceId, id))
				.get();
		const support = `${authority.id}:fact`;
		const generated = `${support}:observation`;
		const companion = {
			id: "exact-companion",
			text: "Mila is a sister of the user.",
			fact_type: "observation" as const,
			source_memory_ids: [support],
		};
		if (variant === "companion") f.extraObservations.push(companion);
		if (variant === "note from the statement itself")
			f.mentions.set(authority.id, mentioned);
		let olderRan = false;
		const priorRow = {
			id: generated,
			fact_type: "observation" as const,
			source_memory_ids: [support],
			get text() {
				if (!olderRan) return `${authored}${noteFor(support)}`;
				return variant === "prior note kept"
					? `${authored}${noteFor(support)}${noteFor(`${older.id}:fact`)}`
					: `${authored}${noteFor(`${older.id}:fact`)}`;
			},
		};
		if (priorNote) {
			f.mentions.set(authority.id, "2021-01-01T08:00:00.000Z");
			f.extraObservations.push(priorRow);
		}
		await claim(jobFor(authority.id)?.id ?? "");
		expect(jobFor(authority.id)?.status).toBe("succeeded");
		if (variant === "companion")
			db.update(s.memorySourceRevisions)
				.set({
					context: JSON.stringify({
						...JSON.parse(authority.context),
						migrationExactWording: true,
						migrationExactWordingFamily: true,
					}),
				})
				.where(eq(s.memorySourceRevisions.id, authority.id))
				.run();
		const { readPublishedMemory } = await import("./publication");
		const bank = db.select().from(s.memoryBanks).get();
		if (!bank) throw Error("test_bank_missing");
		const before = readPublishedMemory(h.userId, bank.id);
		const incoming = `${older.id}:fact`;
		const target = variant === "companion" ? companion.id : generated;
		const targetBefore = before.find((row) => row.nativeId === target);
		if (!targetBefore) throw Error("test_target_missing");
		if (variant === "companion")
			companion.source_memory_ids = [support, incoming];
		else if (priorNote) {
			olderRan = true;
			priorRow.source_memory_ids = [support, incoming];
			f.mentions.set(older.id, mentioned);
		} else {
			const noteOf =
				variant === "merged note"
					? incoming
					: variant === "note from the statement itself"
						? support
						: undefined;
			const base =
				variant === "reworded" ? "Mila lives in Porto, Portugal." : authored;
			f.extraObservations.push({
				id: generated,
				// Hindsight's dated note, built when the bank is read from the fact
				// as it was retained.
				get text() {
					const fact = noteOf ? f.facts.get(noteOf) : undefined;
					return fact?.mentioned_at
						? `${base} (${fact.mentioned_at.slice(0, 16).replace("T", " ")}: ${fact.text.split(" | ")[0].trim()})`
						: base;
				},
				fact_type: "observation",
				// The row kept the statement's wording but lost the statement.
				source_memory_ids:
					variant === "statement link dropped"
						? [incoming]
						: [support, incoming],
			});
		}
		if (variant === "merged note") f.mentions.set(older.id, mentioned);
		if (inside) f.hideObservation.add(incoming);
		await claim(jobFor(older.id)?.id ?? "");
		if (!accepted) {
			expect(jobFor(older.id)).toMatchObject({
				status: "failed",
				errorCode: "memory_preparation_failed",
			});
			expect(readPublishedMemory(h.userId, bank.id)).toEqual(before);
			return;
		}
		expect(jobFor(older.id)?.status).toBe("succeeded");
		const after = readPublishedMemory(h.userId, bank.id);
		const kept = after.find((row) => row.nativeId === generated);
		expect(kept?.text).toBe(targetBefore.text);
		if (variant === "merged note" || variant === "prior note kept")
			expect(kept?.nativeText).toBe(
				`${targetBefore.nativeText} (2020-01-01 09:30: ${f.facts.get(incoming)?.text.split(" | ")[0].trim()})`,
			);
		else
			expect(kept).toMatchObject({
				nativeText: targetBefore.nativeText,
				updatedAt: targetBefore.updatedAt,
			});
		expect(JSON.parse(kept?.sourceIdsJson ?? "[]")).toEqual([
			support,
			incoming,
		]);
		const independent = after.find(
			(row) => row.nativeId === `${incoming}:observation`,
		);
		if (inside) expect(independent).toBeUndefined();
		else
			expect(JSON.parse(independent?.sourceIdsJson ?? "[]")).toEqual([
				incoming,
			]);
		expect(after).toHaveLength(inside ? 1 : 2);
		expect(migration.verifyMemoryMigration(h.userId, manifest.id).ready).toBe(
			true,
		);
		migration.cutoverMemoryMigration(h.userId, manifest.id);
		const { recallMemory } = await import("../memory-context/native");
		const recalled = await recallMemory(h.userId, {
			conversationId: "chat",
			query: "Mila",
			tokenBudget: 4000,
		});
		expect(recalled.map((row) => row.ref.rowId).sort()).toEqual(
			(inside ? [generated] : [generated, `${incoming}:observation`]).sort(),
		);
		// The owner accepted that the authored row now lists the older chat.
		const read = await import("./native-read");
		const shown = read
			.listMemory(h.userId, { scope: { kind: "personal" } })
			.rows.find((row) => row.ref.rowId === generated);
		expect(shown?.updatedAt).toBeNull();
		const detail = shown && read.getMemoryDetail(h.userId, shown.ref);
		expect(detail?.sources).toHaveLength(2);
		expect(detail?.origin).toBe("conversation");
	},
);

it.each([
	"later history",
	"second corroboration",
	"dropped corroboration",
	"withdrawn unchanged",
	"withdrawn and reworded",
	"authored presented again",
	"mixed row drops its chat",
	"mixed row gains a chat",
] as const)(
	"a corroborated authored observation stays protected: %s",
	async (variant) => {
		// Mixed rows: history ran first and the authored fact joined the chat's
		// observation, so the row's wording came from the chat.
		const mixed = variant.startsWith("mixed");
		const { db, s } = await seed();
		const authored = "My sister Mila lives in Porto.";
		const chat = "Mila, my sister in Porto, works as a ferry pilot.";
		db.update(s.messages)
			.set({ content: chat, createdAt: new Date("2020-01-01") })
			.run();
		db.insert(s.conversations)
			.values({ id: "chat2", userId: h.userId, title: "Second synthetic" })
			.run();
		db.insert(s.messages)
			.values({
				id: "m2",
				conversationId: "chat2",
				role: "user",
				content: "My sister Mila in Porto just got a new boat.",
				createdAt: new Date("2019-06-01"),
			})
			.run();
		db.insert(s.memoryProjectionState)
			.values({ id: "projection", userId: h.userId, resetGeneration: 0 })
			.run();
		db.insert(s.memoryProfileItems)
			.values({
				id: "authored",
				userId: h.userId,
				projectionStateId: "projection",
				itemKey: "sister",
				category: "about_you",
				scopeType: "global",
				scopeId: "global",
				status: "active",
				statement: authored,
				metadataJson: JSON.stringify({ origin: "user_authored" }),
				updatedAt: new Date("2021-01-01"),
			})
			.run();
		let reword = false;
		const reworded = "Mila, my sister, lives in Porto.";
		const f = await nativeFixture({
			followDeletes: true,
			onSupportLost: (observation) => {
				if (reword) observation.text = reworded;
			},
		});
		const migration = await import("./migration");
		const jobs = await import("./delivery-job");
		await migration.prepareMemoryMigration(h.userId);
		const { eq } = await import("drizzle-orm");
		const { claimNext } = await import("../jobs/ledger");
		const { runAttempt } = await import("../jobs/runner");
		const claim = async (id: string) => {
			const job = claimNext(jobs.memoryDeliveryJob, {
				workerId: "corroboration-lifecycle",
				jobId: id,
			});
			if (!job) throw Error("test_claim_missing");
			await runAttempt(jobs.memoryDeliveryJob, job, {
				workerId: "corroboration-lifecycle",
			});
		};
		const jobFor = (id: string) =>
			db
				.select()
				.from(s.memoryDeliveryJobs)
				.where(eq(s.memoryDeliveryJobs.sourceId, id))
				.get();
		const sources = db.select().from(s.memorySourceRevisions).all();
		const [authority] = sources.filter((row) => row.messageId === null);
		const [older] = sources.filter((row) => row.messageId === "m");
		const [second] = sources.filter((row) => row.messageId === "m2");
		const support = `${authority.id}:fact`;
		const first = `${older.id}:fact`;
		const next = `${second.id}:fact`;
		const { readPublishedMemory } = await import("./publication");
		const visible = () => {
			const bank = db.select().from(s.memoryBanks).get();
			return bank ? readPublishedMemory(h.userId, bank.id) : [];
		};
		const supportOf = (nativeId: string) =>
			JSON.parse(
				visible().find((row) => row.nativeId === nativeId)?.sourceIdsJson ??
					"null",
			);
		// Like the live account, a sibling observation also presents the statement.
		const sibling = () =>
			f.extraObservations.push({
				id: "authored-sibling",
				text: "Mila is the user's sister.",
				fact_type: "observation",
				source_memory_ids: [support],
			});
		const observation = {
			id: mixed ? `${first}:observation` : `${support}:observation`,
			text: mixed ? chat : authored,
			fact_type: "observation" as const,
			source_memory_ids: mixed ? [first] : [support],
		};
		if (mixed) {
			await claim(jobFor(older.id)?.id ?? "");
			sibling();
			f.extraObservations.push(observation);
			observation.source_memory_ids = [first, support];
			f.hideObservation.add(support);
			await claim(jobFor(authority.id)?.id ?? "");
			expect(supportOf(observation.id)).toEqual([first, support]);
		} else {
			sibling();
			await claim(jobFor(authority.id)?.id ?? "");
			f.extraObservations.push(observation);
			observation.source_memory_ids = [support, first];
			await claim(jobFor(older.id)?.id ?? "");
			expect(jobFor(older.id)?.status).toBe("succeeded");
			expect(supportOf(observation.id)).toEqual([support, first]);
		}
		const bank = db.select().from(s.memoryBanks).get();
		if (!bank) throw Error("test_bank_missing");
		if (
			variant === "second corroboration" ||
			variant === "mixed row gains a chat"
		)
			observation.source_memory_ids = [...observation.source_memory_ids, next];
		if (variant === "dropped corroboration")
			observation.source_memory_ids = [support];
		if (variant === "mixed row drops its chat") {
			// The chat's wording stays, but the row now cites only the statement.
			observation.source_memory_ids = [support];
			f.extraObservations.push({
				id: "chat-own",
				text: chat,
				fact_type: "observation",
				source_memory_ids: [first],
			});
		}
		if (variant === "authored presented again")
			f.extraObservations.push({
				id: "authored-again",
				text: "Mila is in Porto.",
				fact_type: "observation",
				source_memory_ids: [support, next],
			});
		if (variant.startsWith("withdrawn")) {
			reword = variant === "withdrawn and reworded";
			const { revokeMemorySources } = await import("./revisions");
			revokeMemorySources(h.userId, [older.id]);
			await jobs.enqueueMemoryDelivery({
				userId: h.userId,
				bankId: bank.id,
				epoch: older.epoch,
				kind: "source_cleanup",
				sourceId: older.id,
				requestId: `source-cleanup:${older.id}`,
			});
			const cleanup = db
				.select()
				.from(s.memoryDeliveryJobs)
				.all()
				.find((job) => job.kind === "source_cleanup");
			await claim(cleanup?.id ?? "");
		}
		const before = visible();
		await claim(jobFor(second.id)?.id ?? "");
		if (variant === "later history") {
			expect(jobFor(second.id)?.status).toBe("succeeded");
			expect(
				visible().find((row) => row.nativeId === observation.id)?.text,
			).toBe(authored);
			expect(supportOf(observation.id)).toEqual([support, first]);
			expect(supportOf(`${next}:observation`)).toEqual([next]);
			expect(supportOf(`${first}:observation`)).toEqual([first]);
			return;
		}
		// A withdrawn corroborating chat cannot be restored exactly while a
		// sibling shares the authored fact, so later history fails closed.
		if (variant.startsWith("withdrawn"))
			expect(
				db
					.select()
					.from(s.memoryDeliveryJobs)
					.all()
					.find((job) => job.kind === "source_cleanup"),
			).toMatchObject({
				status: "queued",
				errorCode: "memory_cleanup_publication_unverified",
			});
		expect(jobFor(second.id)).toMatchObject({
			status: "failed",
			errorCode: "memory_preparation_failed",
		});
		expect(visible()).toEqual(before);
		expect(visible().some((row) => row.text === reworded)).toBe(false);
	},
);

/** Zsombor's shape: a statement published first, then an older chat refused. */
async function twoStagePreparation() {
	const { db, s } = await seed();
	const history = "Mila, my sister in Porto, works as a ferry pilot.";
	const authored = "My sister Mila lives in Porto.";
	db.update(s.messages)
		.set({ content: history, createdAt: new Date("2020-01-01") })
		.run();
	// An older chat a later correction holds back.
	db.insert(s.messages)
		.values({
			id: "m3",
			conversationId: "chat",
			role: "user",
			content: "I swim in the lake every Sunday.",
			createdAt: new Date("2019-06-01"),
		})
		.run();
	db.insert(s.memoryProjectionState)
		.values({ id: "projection", userId: h.userId, resetGeneration: 0 })
		.run();
	db.insert(s.memoryProfileItems)
		.values({
			id: "authored",
			userId: h.userId,
			projectionStateId: "projection",
			itemKey: "sister",
			category: "about_you",
			scopeType: "global",
			scopeId: "global",
			status: "active",
			statement: authored,
			metadataJson: JSON.stringify({ origin: "user_authored" }),
			updatedAt: new Date("2021-01-01"),
		})
		.run();
	const f = await nativeFixture();
	const migration = await import("./migration");
	const jobs = await import("./delivery-job");
	const { eq } = await import("drizzle-orm");
	const { claimNext } = await import("../jobs/ledger");
	const { runAttempt } = await import("../jobs/runner");
	const { createHash } = await import("node:crypto");
	const { memoryTextHash } = await import("./revisions");
	const claim = async (id: string) => {
		const job = claimNext(jobs.memoryDeliveryJob, {
			workerId: "restart-test",
			jobId: id,
		});
		if (!job) throw Error("test_claim_missing");
		await runAttempt(jobs.memoryDeliveryJob, job, { workerId: "restart-test" });
	};
	const jobFor = (id: string) =>
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.where(eq(s.memoryDeliveryJobs.sourceId, id))
			.get();
	const first = await migration.prepareMemoryMigration(h.userId);
	const epoch0 = db.select().from(s.memorySourceRevisions).all();
	const [statement0] = epoch0.filter((row) => row.messageId === null);
	const [chat0] = epoch0.filter((row) => row.messageId === "m");
	const [held0] = epoch0.filter((row) => row.messageId === "m3");
	await claim(jobFor(statement0.id)?.id ?? "");
	expect(jobFor(statement0.id)?.status).toBe("succeeded");
	f.extraObservations.push({
		id: `${statement0.id}:fact:observation`,
		text: "Mila lives in Porto, Portugal.",
		fact_type: "observation",
		source_memory_ids: [`${statement0.id}:fact`, `${chat0.id}:fact`],
	});
	await claim(jobFor(chat0.id)?.id ?? "");
	expect(jobFor(chat0.id)).toMatchObject({
		status: "failed",
		errorCode: "memory_preparation_failed",
	});
	// That native state belonged to the old bank only.
	f.extraObservations.length = 0;
	// A rewind recorded a correction hold for the still-queued older chat.
	const swim = migration
		.inspectMemoryMigration(h.userId)
		.sources.find(({ id }) => id === "m3");
	if (!swim) throw Error("test_source_missing");
	const hold = {
		messageId: "m3",
		textHash: memoryTextHash(swim.text),
		assertedAt: swim.assertedAt,
		scopeKey: "personal",
		protectedSourceIds: [],
	};
	const manifest0 = db.select().from(s.memoryMigrationManifests).get();
	if (!manifest0) throw Error("test_manifest_missing");
	db.update(s.memoryMigrationManifests)
		.set({
			checkpointJson: JSON.stringify({
				...JSON.parse(manifest0.checkpointJson ?? "{}"),
				migrationCorrectionHolds: [hold],
			}),
		})
		.where(eq(s.memoryMigrationManifests.id, first.id))
		.run();
	const manifestHash = createHash("sha256")
		.update(manifest0.manifestJson)
		.digest("hex");
	return {
		db,
		s,
		f,
		migration,
		eq,
		claim,
		jobFor,
		createHash,
		first,
		history,
		statement0,
		chat0,
		held0,
		hold,
		manifestHash,
	};
}

it("restarts a two-stage preparation in a fresh epoch, history first", async () => {
	const t = await twoStagePreparation();
	const { db, s, f, migration, eq, claim, jobFor, createHash } = t;
	const oldBank = db.select().from(s.memoryBanks).get();
	const account0 = db.select().from(s.memoryAccounts).get();
	if (!oldBank || !account0) throw Error("test_state_missing");
	const legacyBefore = db.select().from(s.memoryProfileItems).all();
	const resetBefore = db.select().from(s.memoryResetGenerations).all();
	const restart = (manifestId: string, manifestHash: string) =>
		migration.restartMemoryPreparation(h.userId, { manifestId, manifestHash });
	const refused = async (setup: () => void, undo: () => void) => {
		setup();
		await expect(restart(t.first.id, t.manifestHash)).rejects.toThrow(
			"memory_migration_restart_refused",
		);
		undo();
		expect(db.select().from(s.memoryAccounts).get()?.epoch).toBe(0);
	};
	await expect(restart(t.first.id, "0".repeat(64))).rejects.toThrow(
		"memory_migration_restart_refused",
	);
	await expect(restart("another-manifest", t.manifestHash)).rejects.toThrow(
		"memory_migration_restart_refused",
	);
	// Nothing may be running.
	const waiting = jobFor(t.held0.id);
	const setJob = (status: "running" | "queued") =>
		db
			.update(s.memoryDeliveryJobs)
			.set({ status })
			.where(eq(s.memoryDeliveryJobs.id, waiting?.id ?? ""))
			.run();
	await refused(
		() => setJob("running"),
		() => setJob("queued"),
	);
	// Not while a rewind is recorded.
	const checkpoint = () =>
		db
			.select()
			.from(s.memoryMigrationManifests)
			.where(eq(s.memoryMigrationManifests.id, t.first.id))
			.get()?.checkpointJson ?? "{}";
	const saved = checkpoint();
	const setCheckpoint = (json: string) =>
		db
			.update(s.memoryMigrationManifests)
			.set({ checkpointJson: json })
			.where(eq(s.memoryMigrationManifests.id, t.first.id))
			.run();
	await refused(
		() =>
			setCheckpoint(
				JSON.stringify({ ...JSON.parse(saved), migrationRewind: {} }),
			),
		() => setCheckpoint(saved),
	);
	// Not for an account that is being erased.
	const setLifecycle = (lifecycleState: string) =>
		db
			.update(s.memoryAccounts)
			.set({ lifecycleState })
			.where(eq(s.memoryAccounts.userId, h.userId))
			.run();
	await refused(
		() => setLifecycle("erasing"),
		() => setLifecycle("active"),
	);
	// Not while the epoch holds an action that is not the migration's own,
	// such as a quarantine review's Keep.
	await refused(
		() =>
			db
				.insert(s.memoryActions)
				.values({
					id: "kept",
					userId: h.userId,
					bankId: oldBank.id,
					epoch: 0,
					requestId: "synthetic-keep",
					kind: "add",
				})
				.run(),
		() =>
			db.delete(s.memoryActions).where(eq(s.memoryActions.id, "kept")).run(),
	);
	// Not while a quarantine review keeps decisions in the old bank.
	await refused(
		() =>
			db
				.insert(s.memoryQuarantineSessions)
				.values({
					userId: h.userId,
					manifestId: t.first.id,
					epoch: 0,
					controlRevision: 0,
					cutoff: new Date("2026-01-01"),
					policyVersion: "synthetic",
					cohortHash: "0".repeat(64),
					manifestHash: t.manifestHash,
					allowedCohortHash: "0".repeat(64),
					deniedSourceIdsJson: "[]",
					cohortCount: 0,
					reviewPolicyVersion: "synthetic",
				})
				.run(),
		() =>
			db
				.delete(s.memoryQuarantineSessions)
				.where(eq(s.memoryQuarantineSessions.userId, h.userId))
				.run(),
	);

	const restarted = await restart(t.first.id, t.manifestHash);
	expect(restarted).toMatchObject({
		retiredEpoch: 0,
		resumed: false,
		cleanupJobs: 1,
		scopeMovesCarried: 0,
	});
	expect(db.select().from(s.memoryAccounts).get()).toMatchObject({
		epoch: 1,
		authority: "preparing",
		lifecycleState: "active",
		tenantId: account0.tenantId,
	});
	// Legacy Memory and the reset generation are untouched.
	expect(db.select().from(s.memoryProfileItems).all()).toEqual(legacyBefore);
	expect(db.select().from(s.memoryResetGenerations).all()).toEqual(resetBefore);
	expect(
		db
			.select()
			.from(s.memoryMigrationManifests)
			.where(eq(s.memoryMigrationManifests.id, t.first.id))
			.get()?.status,
	).toBe("restarted");
	// The old queue is cancelled, not run.
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.all()
			.filter((j) => j.epoch === 0 && j.kind !== "cleanup")
			.map((j) => j.status)
			.sort(),
	).toEqual(["cancelled", "failed", "succeeded"]);
	// The hold still holds: the older chat gets no source in the new epoch.
	const epoch1 = db
		.select()
		.from(s.memorySourceRevisions)
		.where(eq(s.memorySourceRevisions.epoch, 1))
		.all();
	expect(epoch1.some((row) => row.messageId === "m3")).toBe(false);
	expect(
		migration
			.inspectMemoryMigration(h.userId)
			.sources.find(({ id }) => id === "m3"),
	).toMatchObject({
		eligibility: "held",
		reason: "held_conflict_with_later_correction",
	});
	expect(
		JSON.parse(
			db
				.select()
				.from(s.memoryMigrationManifests)
				.where(eq(s.memoryMigrationManifests.id, restarted.manifestId))
				.get()?.checkpointJson ?? "{}",
		).migrationCorrectionHolds,
	).toEqual([t.hold]);
	// One fresh prepare: the chat is queued before the statement.
	const [statement1] = epoch1.filter((row) => row.messageId === null);
	const [chat1] = epoch1.filter((row) => row.messageId === "m");
	expect(statement1.eventId).not.toBe(t.statement0.eventId);
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.all()
			.filter((j) => j.epoch === 1 && j.kind === "source")
			.map((j) => j.sourceId),
	).toEqual([chat1.id, statement1.id]);
	expect(restarted.changed).toBe(false);
	// The person's cleanup status leaves the restart's cleanup out.
	const controls = await import("../memory-controls");
	expect(
		(await controls.getNativeMemoryCleanupStatus(h.userId))
			.nativeCleanupPending,
	).toBe(false);

	// History first: the statement then joins the chat's row.
	await claim(jobFor(chat1.id)?.id ?? "");
	expect(jobFor(chat1.id)?.status).toBe("succeeded");
	const chatFact = `${chat1.id}:fact`;
	const statementFact = `${statement1.id}:fact`;
	f.extraObservations.push({
		id: `${chatFact}:observation`,
		text: t.history,
		fact_type: "observation",
		source_memory_ids: [chatFact, statementFact],
	});
	f.hideObservation.add(statementFact);
	await claim(jobFor(statement1.id)?.id ?? "");
	expect(jobFor(statement1.id)?.status).toBe("succeeded");
	// Verify waits until the old bank is gone from Hindsight.
	expect(
		migration.verifyMemoryMigration(h.userId, restarted.manifestId),
	).toMatchObject({ ready: false, retiredCleanupPending: 1 });
	const cleanup = db
		.select()
		.from(s.memoryDeliveryJobs)
		.all()
		.find((j) => j.kind === "cleanup");
	expect(cleanup).toMatchObject({
		userId: account0.tenantId,
		bankId: oldBank.id,
		requestId: `restart-erase:${oldBank.id}`,
		status: "queued",
	});
	await claim(cleanup?.id ?? "");
	expect(f.deletedBanks.has(oldBank.id)).toBe(true);
	expect(
		migration.verifyMemoryMigration(h.userId, restarted.manifestId),
	).toMatchObject({ ready: true, retiredCleanupPending: 0 });
	migration.cutoverMemoryMigration(h.userId, restarted.manifestId);
	const { recallMemory } = await import("../memory-context/native");
	const recalled = await recallMemory(h.userId, {
		conversationId: "chat",
		query: "Mila",
		tokenBudget: 4000,
	});
	expect(recalled.map((row) => row.ref.rowId)).toContain(
		`${chatFact}:observation`,
	);
	// Once cut over, the account cannot be restarted.
	const manifest1 = db
		.select()
		.from(s.memoryMigrationManifests)
		.where(eq(s.memoryMigrationManifests.id, restarted.manifestId))
		.get();
	await expect(
		restart(
			restarted.manifestId,
			createHash("sha256")
				.update(manifest1?.manifestJson ?? "")
				.digest("hex"),
		),
	).rejects.toThrow("memory_migration_restart_refused");
	// A later Clear Memory queues its own cleanup for the retired bank. Even
	// holding an operation it can no longer ask about, it succeeds: the
	// restart's cleanup already deleted that bank.
	const { prepareNativeMemoryErasure } = await import("./delivery-job");
	await prepareNativeMemoryErasure(h.userId);
	const again = db
		.select()
		.from(s.memoryDeliveryJobs)
		.where(eq(s.memoryDeliveryJobs.requestId, `erase:${oldBank.id}`))
		.get();
	db.update(s.memoryDeliveryJobs)
		.set({ nativeOperationIdsJson: '["synthetic-pending-operation"]' })
		.where(eq(s.memoryDeliveryJobs.id, again?.id ?? ""))
		.run();
	await claim(again?.id ?? "");
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.where(eq(s.memoryDeliveryJobs.id, again?.id ?? ""))
			.get()?.status,
	).toBe("succeeded");
});

it("resumes a restart that stopped after its atomic step", async () => {
	const t = await twoStagePreparation();
	const { db, s, migration } = t;
	const delivery = await import("./delivery-job");
	const spy = vi
		.spyOn(delivery, "enqueueMemoryMutation")
		.mockRejectedValueOnce(Error("synthetic_prepare_interrupted"));
	await expect(
		migration.restartMemoryPreparation(h.userId, {
			manifestId: t.first.id,
			manifestHash: t.manifestHash,
		}),
	).rejects.toThrow("synthetic_prepare_interrupted");
	spy.mockRestore();
	// Half done: a new epoch with no manifest yet.
	expect(db.select().from(s.memoryAccounts).get()?.epoch).toBe(1);
	expect(
		db
			.select()
			.from(s.memoryMigrationManifests)
			.all()
			.map(({ epoch, status }) => ({ epoch, status })),
	).toEqual([{ epoch: 0, status: "restarted" }]);
	const resumed = await migration.restartMemoryPreparation(h.userId, {
		manifestId: t.first.id,
		manifestHash: t.manifestHash,
	});
	expect(resumed).toMatchObject({
		retiredEpoch: 0,
		resumed: true,
		cleanupJobs: 0,
	});
	expect(db.select().from(s.memoryAccounts).get()?.epoch).toBe(1);
	expect(
		db
			.select()
			.from(s.memoryDeliveryJobs)
			.all()
			.filter((j) => j.kind === "cleanup"),
	).toHaveLength(1);
	expect(
		db
			.select()
			.from(s.memorySourceRevisions)
			.all()
			.filter((row) => row.epoch === 1 && row.messageId === "m"),
	).toHaveLength(1);
	// Once the new epoch has its manifest, the old receipt is spent.
	await expect(
		migration.restartMemoryPreparation(h.userId, {
			manifestId: t.first.id,
			manifestHash: t.manifestHash,
		}),
	).rejects.toThrow("memory_migration_restart_refused");
});

it("keeps the retired epoch's chat scope history after a restart", async () => {
	const { db, s } = await seed();
	db.insert(s.projects)
		.values({ id: "project", userId: h.userId, name: "Project" })
		.run();
	const { moveConversationToProject } = await import("../conversations");
	await moveConversationToProject(h.userId, "chat", "project");
	await nativeFixture();
	const migration = await import("./migration");
	const { createHash } = await import("node:crypto");
	const first = await migration.prepareMemoryMigration(h.userId);
	const held = () =>
		migration
			.inspectMemoryMigration(h.userId)
			.sources.find(({ id }) => id === "m");
	expect(held()).toMatchObject({
		eligibility: "held",
		reason: "historical_scope_changed",
	});
	const manifest = db.select().from(s.memoryMigrationManifests).get();
	const restarted = await migration.restartMemoryPreparation(h.userId, {
		manifestId: first.id,
		manifestHash: createHash("sha256")
			.update(manifest?.manifestJson ?? "")
			.digest("hex"),
	});
	expect(restarted).toMatchObject({ retiredEpoch: 0, scopeMovesCarried: 1 });
	// The chat's earlier scope still keeps its message out of the project.
	expect(held()).toMatchObject({
		eligibility: "held",
		reason: "historical_scope_changed",
	});
	expect(
		db
			.select()
			.from(s.memorySourceRevisions)
			.all()
			.some((row) => row.messageId === "m"),
	).toBe(false);
});

it("keeps the held-history boundary across a restart", async () => {
	const { db, s } = await seed();
	// A review-only removal with unknown provenance holds older history.
	db.insert(s.memoryReviewItems)
		.values({
			id: "review",
			userId: h.userId,
			subjectKey: "k",
			subjectLabel: "s",
			question: "q",
			reason: "r",
			affectedItemIdsJson: '["missing"]',
		})
		.run();
	db.insert(s.memoryReviewResolutions)
		.values({
			id: "resolution",
			userId: h.userId,
			reviewItemId: "review",
			resolutionType: "do_not_remember",
		})
		.run();
	await allowMigrationHistory();
	await nativeFixture();
	const migration = await import("./migration");
	const { eq } = await import("drizzle-orm");
	const { createHash } = await import("node:crypto");
	expect(migration.inspectMemoryMigration(h.userId).holdHistory).toBe(true);
	const first = await migration.prepareMemoryMigration(h.userId);
	// The first preparation began two hours ago; a chat came an hour later.
	db.update(s.memoryMigrationManifests)
		.set({ createdAt: new Date(Date.now() - 2 * 3_600_000) })
		.where(eq(s.memoryMigrationManifests.id, first.id))
		.run();
	db.insert(s.messages)
		.values({
			id: "later",
			conversationId: "chat",
			role: "user",
			content: "I started learning the cello.",
			createdAt: new Date(Date.now() - 3_600_000),
		})
		.run();
	expect(
		migration
			.inspectMemoryMigration(h.userId)
			.sources.find(({ id }) => id === "later")?.eligibility,
	).toBe("eligible");
	const manifest = db.select().from(s.memoryMigrationManifests).get();
	const restarted = await migration.restartMemoryPreparation(h.userId, {
		manifestId: first.id,
		manifestHash: createHash("sha256")
			.update(manifest?.manifestJson ?? "")
			.digest("hex"),
	});
	// The boundary stays where the first preparation put it.
	expect(
		migration
			.inspectMemoryMigration(h.userId)
			.sources.find(({ id }) => id === "later")?.eligibility,
	).toBe("eligible");
	expect(
		migration.verifyMemoryMigration(h.userId, restarted.manifestId).changed,
	).toBe(false);
});
