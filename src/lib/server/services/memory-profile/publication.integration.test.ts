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
