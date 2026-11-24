import { eq as eqId } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-publication");
});
afterEach(() => h.cleanup());
async function fixture() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const rev = await import("./revisions");
	const pub = await import("./publication");
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
	db.update(schema.memorySourceRevisions)
		.set({
			state: "accepted",
			acknowledgedFactsJson: JSON.stringify([
				{ id: "fact", text: "Green kayak" },
			]),
		})
		.run();
	const memories = [
		{
			id: "fact",
			text: "Green kayak",
			fact_type: "world",
			consolidated_at: "2026-11-18T00:00:00Z",
			document_id: source.id,
		},
		{
			id: "observation",
			text: "Green kayak",
			fact_type: "observation",
			source_memory_ids: ["fact"],
		},
	];
	const publish = () =>
		db.transaction((tx) =>
			pub.publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: bank.id,
				epoch: 0,
				expectedRevision: 0,
				memories,
			}),
		);
	return { db, schema, rev, pub, bank, source, memories, publish };
}
describe("accepted native publication", () => {
	it("rejects contaminated complete candidate without replacing accepted view", async () => {
		const f = await fixture();
		const generation = f.publish();
		f.memories[0].text = "Purple kayak";
		expect(() =>
			f.db.transaction((tx) =>
				f.pub.publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: f.bank.id,
					epoch: 0,
					expectedRevision: 1,
					memories: f.memories,
				}),
			),
		).toThrow("memory_candidate_unaccepted");
		expect(f.pub.readPublishedMemory(h.userId, f.bank.id)[0].generation).toBe(
			generation,
		);
	});
	it("revokes old generation pages immediately", async () => {
		const f = await fixture();
		const generation = f.publish();
		f.rev.revokeMemorySources(h.userId, [f.source.id]);
		expect(f.pub.readPublishedMemory(h.userId, f.bank.id, generation)).toEqual(
			[],
		);
	});
	it("fences a late publication after reset", async () => {
		const f = await fixture();
		f.db.update(f.schema.memoryAccounts).set({ epoch: 1 }).run();
		expect(f.publish).toThrow("memory_fence_stale");
	});
	it("fences another process stale writer and preserves source dates on duplicate", async () => {
		const f = await fixture();
		await h.bootSecondProcess();
		const { db } = await import("$lib/server/db");
		const pub = await import("./publication");
		f.publish();
		expect(() =>
			db.transaction((tx) =>
				pub.publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: f.bank.id,
					epoch: 0,
					expectedRevision: 0,
					memories: f.memories,
				}),
			),
		).toThrow("memory_publication_stale");
	});
	it("rejects cross-user access and defaults new accounts to legacy", async () => {
		const f = await fixture();
		expect(f.pub.readPublishedMemory("other", f.bank.id)).toEqual([]);
		const other = h.fixture.seedUser("other");
		const bank = f.rev.ensureMemoryBank(other, { kind: "personal" });
		expect(() =>
			f.rev.recordMemorySource({
				userId: other,
				bankId: bank.id,
				epoch: 0,
				eventId: "x",
				lineageId: "x",
				text: "x",
				context: "",
				assertedAt: new Date(),
			}),
		).toThrow("memory_fence_stale");
	});
	it("promotes only the staged source covered by this intent", async () => {
		const f = await fixture();
		const other = f.rev.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "other",
			lineageId: "other",
			text: "Other",
			context: "",
			assertedAt: new Date("2026-11-18"),
		});
		const { eq } = await import("drizzle-orm");
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({ state: "staged" })
			.where(eq(f.schema.memorySourceRevisions.id, other.id))
			.run();
		f.publish();
		expect(
			f.db
				.select()
				.from(f.schema.memorySourceRevisions)
				.where(eq(f.schema.memorySourceRevisions.id, other.id))
				.get()?.state,
		).toBe("staged");
	});
	it("bounds retained generations and explicitly rejects pruned cursors", async () => {
		const f = await fixture();
		const old = f.publish();
		for (let revision = 1; revision < 8; revision++)
			f.db.transaction((tx) =>
				f.pub.publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: f.bank.id,
					epoch: 0,
					expectedRevision: revision,
					memories: f.memories,
				}),
			);
		expect(f.db.select().from(f.schema.memoryPublishedRows).all()).toHaveLength(
			2,
		);
		expect(() => f.pub.readPublishedMemory(h.userId, f.bank.id, old)).toThrow(
			"memory_generation_stale",
		);
	});
	/**
	 * A second, independent fact beside the fixture's kayak, published once,
	 * so a later publication has something unrelated to keep.
	 */
	async function withUnrelatedFact(f: Awaited<ReturnType<typeof fixture>>) {
		const { eq } = await import("drizzle-orm");
		const other = f.rev.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "other-event",
			lineageId: "other-message",
			text: "I collect maps",
			context: "User statement",
			assertedAt: new Date("2026-11-19"),
		});
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({
				state: "accepted",
				acknowledgedFactsJson: JSON.stringify([
					{ id: "maps", text: "Collects maps" },
				]),
			})
			.where(eq(f.schema.memorySourceRevisions.id, other.id))
			.run();
		f.memories.push(
			{
				id: "maps",
				text: "Collects maps",
				fact_type: "world",
				consolidated_at: "2026-11-19T00:00:00Z",
				document_id: other.id,
			},
			{
				id: "observation-maps",
				text: "Collects maps",
				fact_type: "observation",
				source_memory_ids: ["maps"],
			},
		);
		f.publish();
		return other;
	}
	/** Hindsight holds `memories`; publication is asked again at the bank's revision. */
	const republish = (f: Awaited<ReturnType<typeof fixture>>) =>
		f.db.transaction((tx) => {
			const bank = tx
				.select()
				.from(f.schema.memoryBanks)
				.where(eqId(f.schema.memoryBanks.id, f.bank.id))
				.get();
			return f.pub.publishNativeSnapshot(tx, {
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				expectedRevision: bank?.revision ?? -1,
				memories: f.memories,
			});
		});
	const visibleTexts = (f: Awaited<ReturnType<typeof fixture>>) =>
		f.pub
			.readPublishedMemory(h.userId, f.bank.id)
			.map((row) => row.text)
			.sort();
	it("holds publication while a Remove runs and leaves out exactly its facts once its job ended", async () => {
		const f = await fixture();
		await withUnrelatedFact(f);
		expect(visibleTexts(f)).toEqual(["Collects maps", "Green kayak"]);
		// The person removes the kayak: its fact is revoked at once, its job queued.
		f.db
			.insert(f.schema.memoryActions)
			.values({
				id: "remove-kayak",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				requestId: "6b1f0a52-6f61-4c4e-9a3e-1f6f6f0a5c01",
				kind: "remove",
				exclusionAcknowledged: true,
				cleanupPending: true,
				intentJson: JSON.stringify({
					request: {
						kind: "remove",
						ref: {
							scope: { kind: "personal" },
							generation: "g",
							rowId: "observation",
						},
						requestId: "6b1f0a52-6f61-4c4e-9a3e-1f6f6f0a5c01",
					},
					before: "Green kayak",
					sourceIds: [f.source.id],
					facts: [{ id: "fact", text: "Green kayak", sourceId: f.source.id }],
				}),
			})
			.run();
		f.db
			.insert(f.schema.memoryRevocations)
			.values({
				id: "revocation-kayak",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				nativeFactId: "fact",
				nativeTextHash: f.rev.memoryTextHash("Green kayak"),
				actionId: "remove-kayak",
			})
			.run();
		f.db
			.insert(f.schema.memoryDeliveryJobs)
			.values({
				id: "remove-kayak-job",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "action",
				actionId: "remove-kayak",
				requestId: "action:remove-kayak",
				status: "queued",
			})
			.run();
		expect(visibleTexts(f)).toEqual(["Collects maps"]);
		// Hindsight still holds the kayak and its observation.
		expect(() => republish(f)).toThrow("memory_curation_publication_held");
		// The checker refused the Remove: its job ended, its exclusion did not.
		f.db
			.update(f.schema.memoryDeliveryJobs)
			.set({ status: "failed", errorCode: "memory_preparation_failed" })
			.where(eqId(f.schema.memoryDeliveryJobs.id, "remove-kayak-job"))
			.run();
		const generation = republish(f);
		const rows = f.db
			.select()
			.from(f.schema.memoryPublishedRows)
			.where(eqId(f.schema.memoryPublishedRows.generation, generation))
			.all();
		expect(rows.map((row) => row.nativeId)).toEqual(["observation-maps"]);
		expect(visibleTexts(f)).toEqual(["Collects maps"]);
		// A retried Remove runs again, and holds the bank again while it does.
		f.db
			.update(f.schema.memoryDeliveryJobs)
			.set({ status: "queued", errorCode: null })
			.where(eqId(f.schema.memoryDeliveryJobs.id, "remove-kayak-job"))
			.run();
		expect(() => republish(f)).toThrow("memory_curation_publication_held");
		expect(visibleTexts(f)).toEqual(["Collects maps"]);
	});
	/** A Remove of the kayak, its fact revoked at once, with the given job state and intent. */
	function kayakRemoval(
		f: Awaited<ReturnType<typeof fixture>>,
		status: "queued" | "failed",
		extra: Record<string, unknown> = {},
	) {
		f.db
			.insert(f.schema.memoryActions)
			.values({
				id: "remove-kayak",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				requestId: "6b1f0a52-6f61-4c4e-9a3e-1f6f6f0a5c02",
				kind: "remove",
				exclusionAcknowledged: true,
				cleanupPending: true,
				intentJson: JSON.stringify({
					request: {
						kind: "remove",
						ref: {
							scope: { kind: "personal" },
							generation: "g",
							rowId: "observation",
						},
						requestId: "6b1f0a52-6f61-4c4e-9a3e-1f6f6f0a5c02",
					},
					before: "Green kayak",
					sourceIds: [f.source.id],
					facts: [{ id: "fact", text: "Green kayak", sourceId: f.source.id }],
					...extra,
				}),
			})
			.run();
		f.db
			.insert(f.schema.memoryRevocations)
			.values({
				id: "revocation-kayak",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				nativeFactId: "fact",
				nativeTextHash: f.rev.memoryTextHash("Green kayak"),
				actionId: "remove-kayak",
			})
			.run();
		f.db
			.insert(f.schema.memoryDeliveryJobs)
			.values({
				id: "remove-kayak-job",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "action",
				actionId: "remove-kayak",
				requestId: "action:remove-kayak",
				status,
			})
			.run();
	}
	it("keeps a refused Remove's exclusion while its retry runs, outside its own publication", async () => {
		const f = await fixture();
		await withUnrelatedFact(f);
		// The Remove was refused after its native write, and Hindsight rebuilt
		// the canoe around the removed kayak; the person retries the Remove.
		kayakRemoval(f, "queued", {
			proposal: [{ id: "fact", text: "" }],
			familyFactIds: ["canoe", "fact"],
		});
		const { eq } = await import("drizzle-orm");
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({
				acknowledgedFactsJson: JSON.stringify([
					{ id: "fact", text: "Green kayak" },
					{ id: "canoe", text: "Red canoe" },
				]),
			})
			.where(eq(f.schema.memorySourceRevisions.id, f.source.id))
			.run();
		f.memories.splice(
			0,
			2,
			{
				id: "canoe",
				text: "Red canoe",
				fact_type: "world",
				consolidated_at: "2026-11-18T00:00:00Z",
				document_id: f.source.id,
			},
			{
				id: "observation-canoe",
				text: "Red canoe, earlier beside a green kayak",
				fact_type: "observation",
				source_memory_ids: ["canoe"],
			},
		);
		const publish = (options: {
			checkedActionIds?: string[];
			ownActionId?: string;
		}) =>
			f.db.transaction((tx) => {
				const bank = tx
					.select()
					.from(f.schema.memoryBanks)
					.where(eqId(f.schema.memoryBanks.id, f.bank.id))
					.get();
				return f.pub.publishNativeSnapshot(tx, {
					userId: h.userId,
					bankId: f.bank.id,
					epoch: 0,
					expectedRevision: bank?.revision ?? -1,
					memories: f.memories,
					...options,
				});
			});
		// A replay the hold lets through still leaves the rebuilt canoe out.
		const replayed = publish({ checkedActionIds: ["remove-kayak"] });
		expect(publishedIds(f, replayed)).toEqual(["observation-maps"]);
		expect(visibleTexts(f)).toEqual(["Collects maps"]);
		// The Remove's own publication, after its own final check, may show it.
		const own = publish({
			checkedActionIds: ["remove-kayak"],
			ownActionId: "remove-kayak",
		});
		expect(publishedIds(f, own)).toEqual([
			"observation-canoe",
			"observation-maps",
		]);
	});
	it("leaves out the dependents a refused Remove held for repair", async () => {
		const f = await fixture();
		await withUnrelatedFact(f);
		// A later message of the same chat, whose context named the removed one.
		const dependent = f.rev.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "dependent-event",
			lineageId: "dependent-message",
			text: "I also sort stamps",
			context: "User statement",
			assertedAt: new Date("2026-11-21"),
		});
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({
				state: "repair_held",
				nativeSubmitted: true,
				nativeAcknowledged: true,
			})
			.where(eqId(f.schema.memorySourceRevisions.id, dependent.id))
			.run();
		kayakRemoval(f, "failed", {
			dependencyRepair: {
				version: 1,
				bankId: f.bank.id,
				epoch: 0,
				revision: 0,
				roots: [f.source.id],
				steps: [
					{
						originalId: dependent.id,
						replacementId: "replacement-of-dependent",
						operationId: "operation-of-replacement",
						deleted: false,
					},
				],
				originalFacts: [],
			},
		});
		f.memories.push(
			{
				id: "stamps",
				text: "Sorts stamps",
				fact_type: "world",
				consolidated_at: "2026-11-21T00:00:00Z",
				document_id: dependent.id,
			},
			{
				id: "observation-stamps",
				text: "Sorts stamps",
				fact_type: "observation",
				source_memory_ids: ["stamps"],
			},
			{
				id: "stamps-again",
				text: "Sorts stamps",
				fact_type: "world",
				consolidated_at: "2026-11-21T00:00:00Z",
				document_id: "replacement-of-dependent",
			},
			{
				id: "observation-stamps-again",
				text: "Sorts stamps again",
				fact_type: "observation",
				source_memory_ids: ["stamps-again"],
			},
		);
		const generation = republish(f);
		expect(publishedIds(f, generation)).toEqual(["observation-maps"]);
	});
	it("leaves out the later messages a refused resend's repair held", async () => {
		const f = await fixture();
		await withUnrelatedFact(f);
		const held = f.rev.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "held-resend",
			lineageId: "held-resend",
			text: "I drink coffee on the terrace",
			context: "User statement",
			assertedAt: new Date("2026-11-20"),
		});
		const dependent = f.rev.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "later-message",
			lineageId: "later-message",
			text: "I also sort stamps",
			context: "User statement",
			assertedAt: new Date("2026-11-21"),
		});
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({ nativeSubmitted: true, nativeAcknowledged: true })
			.where(eqId(f.schema.memorySourceRevisions.id, held.id))
			.run();
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({ state: "repair_held", nativeSubmitted: true })
			.where(eqId(f.schema.memorySourceRevisions.id, dependent.id))
			.run();
		// The resend's own repair held the later message and retained its
		// replacement before its final check refused the resend for good.
		f.db
			.insert(f.schema.memoryDeliveryJobs)
			.values({
				id: "held-job",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source",
				sourceId: held.id,
				requestId: `source:${held.id}`,
				status: "failed",
				errorCode: "memory_dependency_check_rejected",
				checkpoint: JSON.stringify({
					dependencyRepair: {
						version: 1,
						bankId: f.bank.id,
						epoch: 0,
						revision: 0,
						roots: [held.id],
						steps: [
							{
								originalId: dependent.id,
								replacementId: "replacement-of-later",
								operationId: "operation-of-later",
								deleted: false,
							},
						],
						originalFacts: [],
					},
				}),
			})
			.run();
		f.memories.push(
			{
				id: "stamps-again",
				text: "Sorts stamps",
				fact_type: "world",
				consolidated_at: "2026-11-21T00:00:00Z",
				document_id: "replacement-of-later",
			},
			{
				id: "observation-stamps-again",
				text: "Sorts stamps",
				fact_type: "observation",
				source_memory_ids: ["stamps-again"],
			},
		);
		const generation = republish(f);
		expect(publishedIds(f, generation)).toEqual([
			"observation",
			"observation-maps",
		]);
	});
	it("leaves out a source whose delivery ended unaccepted and waits for one still queued", async () => {
		const f = await fixture();
		await withUnrelatedFact(f);
		const held = f.rev.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "held-event",
			lineageId: "held-message",
			text: "I drink coffee on the terrace",
			context: "User statement",
			assertedAt: new Date("2026-11-20"),
		});
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({ nativeSubmitted: true, nativeAcknowledged: true })
			.where(eqId(f.schema.memorySourceRevisions.id, held.id))
			.run();
		f.db
			.insert(f.schema.memoryDeliveryJobs)
			.values({
				id: "held-job",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source",
				sourceId: held.id,
				requestId: `source:${held.id}`,
				status: "queued",
			})
			.run();
		f.memories.push(
			{
				id: "terrace",
				text: "Coffee on the terrace",
				fact_type: "world",
				consolidated_at: "2026-11-20T00:00:00Z",
				document_id: held.id,
			},
			{
				id: "observation-terrace",
				text: "Coffee on the terrace",
				fact_type: "observation",
				source_memory_ids: ["terrace"],
			},
		);
		// Still on its way: another publication waits for it, as before.
		expect(() => republish(f)).toThrow("memory_candidate_unaccepted");
		// Its own check refused it: it never publishes, and nothing waits on it.
		f.db
			.update(f.schema.memoryDeliveryJobs)
			.set({ status: "failed", errorCode: "memory_dependency_check_rejected" })
			.where(eqId(f.schema.memoryDeliveryJobs.id, "held-job"))
			.run();
		republish(f);
		expect(visibleTexts(f)).toEqual(["Collects maps", "Green kayak"]);
	});
	it("leaves out exactly what a refused changed resend's edit took away, whatever its job is doing", async () => {
		const f = await fixture();
		await withUnrelatedFact(f);
		// The chat the resend carried: the kayak, which the person's edit
		// rewrote, and the Sunday paddling, which it left as it was.
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({
				acknowledgedFactsJson: JSON.stringify([
					{ id: "fact", text: "Green kayak" },
					{ id: "paddle", text: "Paddles on Sundays" },
				]),
			})
			.where(eqId(f.schema.memorySourceRevisions.id, f.source.id))
			.run();
		const edited = f.rev.recordMemorySource({
			userId: h.userId,
			bankId: f.bank.id,
			epoch: 0,
			eventId: "edited-event",
			lineageId: "message",
			text: "My kayak is blue",
			context: "User statement",
			assertedAt: new Date("2026-11-21"),
		});
		const intent = (
			outcome: "rejected" | "accepted",
			text = "My kayak is blue",
			excludedFactIds?: string[],
		) =>
			JSON.stringify({
				request: {
					kind: "edit",
					requestId: edited.id,
					text,
					ref: {
						scope: { kind: "personal" },
						generation: "source-edit",
						rowId: edited.id,
					},
				},
				before: "My kayak is green",
				sourceIds: [f.source.id],
				facts: [
					{ id: "fact", text: "Green kayak", sourceId: f.source.id },
					{ id: "paddle", text: "Paddles on Sundays", sourceId: f.source.id },
				],
				proposal: [
					{ id: "fact", text: "Blue kayak" },
					{ id: "paddle", text: "Paddles on Sundays" },
				],
				outcome,
				...(excludedFactIds ? { excludedFactIds } : {}),
			});
		f.db
			.insert(f.schema.memoryActions)
			.values({
				id: "source-edit",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				requestId: edited.id,
				kind: "source_edit",
				text: "My kayak is blue",
				previousText: "My kayak is green",
				// As the refusal records it: the fact the edit took away.
				intentJson: intent("rejected", "My kayak is blue", ["fact"]),
			})
			.run();
		const excluded = () =>
			f.db.transaction((tx) => [
				...f.pub.excludedNativeEvidence(tx, f.bank).factIds,
			]);
		// Only the fact the edit changed, with no job, while one is queued, runs
		// again or has ended.
		expect(excluded()).toEqual(["fact"]);
		f.db
			.insert(f.schema.memoryDeliveryJobs)
			.values({
				id: "edited-job",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				kind: "source",
				sourceId: edited.id,
				requestId: `source:${edited.id}`,
				status: "queued",
			})
			.run();
		for (const status of ["queued", "running", "failed"] as const) {
			f.db
				.update(f.schema.memoryDeliveryJobs)
				.set({ status })
				.where(eqId(f.schema.memoryDeliveryJobs.id, "edited-job"))
				.run();
			expect(excluded()).toEqual(["fact"]);
		}
		// Its wording is revoked whatever it is (as the refusal writes it), and
		// Hindsight still holds it merged with the paddling into one card: the
		// card is left out whole, and the rest of the bank publishes.
		f.db
			.insert(f.schema.memoryRevocations)
			.values({
				id: "refused-edit-fact",
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				nativeFactId: "fact",
				actionId: "source-edit",
			})
			.run();
		const maps = f.memories.filter(
			({ id }) => id === "maps" || id === "observation-maps",
		);
		const raw = (id: string, text: string) => ({
			id,
			text,
			fact_type: "world",
			consolidated_at: "2026-11-18T00:00:00Z",
			document_id: f.source.id,
		});
		f.memories.splice(
			0,
			f.memories.length,
			raw("fact", "Blue kayak"),
			raw("paddle", "Paddles on Sundays"),
			{
				id: "merged",
				text: "Blue kayak, paddled on Sundays",
				fact_type: "observation",
				source_memory_ids: ["fact", "paddle"],
			},
			...maps,
		);
		republish(f);
		expect(visibleTexts(f)).toEqual(["Collects maps"]);
		// Hindsight rebuilt the paddling alone once the kayak was invalidated:
		// what the edit left publishes again.
		f.memories.splice(
			0,
			f.memories.length,
			raw("paddle", "Paddles on Sundays"),
			{
				id: "observation-paddle",
				text: "Paddles on Sundays",
				fact_type: "observation",
				source_memory_ids: ["paddle"],
			},
			...maps,
		);
		republish(f);
		expect(visibleTexts(f)).toEqual(["Collects maps", "Paddles on Sundays"]);
		// An edit accepted on a later try excludes nothing.
		f.db
			.update(f.schema.memoryActions)
			.set({ intentJson: intent("accepted") })
			.where(eqId(f.schema.memoryActions.id, "source-edit"))
			.run();
		expect(excluded()).toEqual([]);
		// Nor does a refused edit that only added to the message: it took
		// nothing away, and what its proposal wrote is put back instead.
		f.db
			.update(f.schema.memoryActions)
			.set({
				intentJson: intent(
					"rejected",
					"My kayak is green. I paddle on Sundays too.",
					[],
				),
			})
			.where(eqId(f.schema.memoryActions.id, "source-edit"))
			.run();
		expect(excluded()).toEqual([]);
		// Nor does an edit refused and put back before this rule: it recorded
		// no exclusion, and nothing it put back is taken away later.
		f.db
			.update(f.schema.memoryActions)
			.set({ intentJson: intent("rejected") })
			.where(eqId(f.schema.memoryActions.id, "source-edit"))
			.run();
		expect(excluded()).toEqual([]);
	});
	/**
	 * The fixture's chat as Hindsight held it after a deleted document's
	 * re-consolidation: an old fact and its correction behind the bicycle,
	 * the old fact alone behind the kayak.
	 */
	async function bicycleAndKayak(
		f: Awaited<ReturnType<typeof fixture>>,
		observations: Array<{
			id: string;
			text: string;
			source_memory_ids: string[];
		}>,
	) {
		f.db
			.update(f.schema.memorySourceRevisions)
			.set({
				acknowledgedFactsJson: JSON.stringify([
					{ id: "old", text: "Red bicycle and white kayak" },
					{ id: "correction", text: "The bicycle is green" },
				]),
			})
			.run();
		f.memories.splice(
			0,
			f.memories.length,
			...[
				["old", "Red bicycle and white kayak"],
				["correction", "The bicycle is green"],
			].map(([id, text]) => ({
				id,
				text,
				fact_type: "world",
				consolidated_at: "2026-11-18T00:00:00Z",
				document_id: f.source.id,
			})),
			...observations.map((row) => ({ ...row, fact_type: "observation" })),
		);
	}
	const publishedIds = (
		f: Awaited<ReturnType<typeof fixture>>,
		generation: string,
	) =>
		f.db
			.select()
			.from(f.schema.memoryPublishedRows)
			.where(eqId(f.schema.memoryPublishedRows.generation, generation))
			.all()
			.map(({ nativeId }) => nativeId)
			.sort();
	it("publishes one row for an observation Hindsight wrote twice", async () => {
		const f = await fixture();
		await bicycleAndKayak(f, [
			{
				id: "bike-b",
				text: "Green bicycle",
				source_memory_ids: ["correction", "old"],
			},
			{
				id: "bike-a",
				text: "Green bicycle",
				source_memory_ids: ["old", "correction"],
			},
			{ id: "kayak", text: "White kayak", source_memory_ids: ["old"] },
		]);
		const generation = republish(f);
		expect(visibleTexts(f)).toEqual(["Green bicycle", "White kayak"]);
		expect(publishedIds(f, generation)).toEqual(["bike-a", "kayak"]);
	});
	it("keeps the published id when Hindsight adds a twin beside it", async () => {
		const f = await fixture();
		await bicycleAndKayak(f, [
			{
				id: "bike-b",
				text: "Green bicycle",
				source_memory_ids: ["correction", "old"],
			},
			{ id: "kayak", text: "White kayak", source_memory_ids: ["old"] },
		]);
		republish(f);
		f.memories.push({
			id: "bike-a",
			text: "Green bicycle",
			fact_type: "observation",
			source_memory_ids: ["old", "correction"],
		});
		const generation = republish(f);
		expect(visibleTexts(f)).toEqual(["Green bicycle", "White kayak"]);
		expect(publishedIds(f, generation)).toEqual(["bike-b", "kayak"]);
	});
	it.each([
		[
			"other wording",
			{
				id: "bike-a",
				text: "Green bicycle and white kayak",
				source_memory_ids: ["old", "correction"],
			},
			["Green bicycle", "Green bicycle and white kayak", "White kayak"],
		],
		[
			"other support",
			{
				id: "bike-a",
				text: "Green bicycle",
				source_memory_ids: ["correction"],
			},
			["Green bicycle", "Green bicycle", "White kayak"],
		],
	])(
		"keeps two observations that differ in %s",
		async (_case, other, texts) => {
			const f = await fixture();
			await bicycleAndKayak(f, [
				{
					id: "bike-b",
					text: "Green bicycle",
					source_memory_ids: ["correction", "old"],
				},
				other,
				{ id: "kayak", text: "White kayak", source_memory_ids: ["old"] },
			]);
			republish(f);
			expect(visibleTexts(f)).toEqual(texts);
		},
	);
	it("refuses a twin that rests on an unaccepted fact", async () => {
		const f = await fixture();
		await bicycleAndKayak(f, [
			{
				id: "bike-b",
				text: "Green bicycle",
				source_memory_ids: ["correction", "old"],
			},
			{
				id: "bike-a",
				text: "Green bicycle",
				source_memory_ids: ["old", "correction", "unaccepted"],
			},
		]);
		f.memories.push({
			id: "unaccepted",
			text: "The bicycle is green",
			fact_type: "world",
			consolidated_at: "2026-11-18T00:00:00Z",
			document_id: "another-document",
		});
		expect(() => republish(f)).toThrow("memory_candidate_unaccepted");
	});
	it("rejects replay with changed source identity even when text matches", async () => {
		const f = await fixture();
		expect(() =>
			f.rev.recordMemorySource({
				userId: h.userId,
				bankId: f.bank.id,
				epoch: 0,
				eventId: "event",
				lineageId: "different",
				text: "My kayak is green",
				context: "User statement",
				assertedAt: new Date("2026-11-18"),
			}),
		).toThrow("memory_event_conflict");
	});
});
