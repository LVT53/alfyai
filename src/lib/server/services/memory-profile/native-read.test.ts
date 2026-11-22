import { afterEach, beforeEach, expect, it } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-read");
});
afterEach(() => h.cleanup());
async function fixture() {
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
		text: "Original user quotation",
		context: "",
		assertedAt: new Date("2026-11-01"),
	});
	const facts = Array.from({ length: 55 }, (_, i) => ({
		id: `f${i}`,
		text: `Fact ${i}`,
	}));
	db.update(s.memorySourceRevisions)
		.set({ state: "accepted", acknowledgedFactsJson: JSON.stringify(facts) })
		.run();
	db.update(s.memoryBanks).set({ generation: "g" }).run();
	for (const [i, f] of facts.entries())
		db.insert(s.memoryPublishedRows)
			.values({
				id: `r${i}`,
				nativeId: `n${i}`,
				bankId: bank.id,
				generation: "g",
				epoch: 0,
				text: i === 0 ? "Current green kayak" : `Fact ${i}`,
				nativeText: i === 0 ? "Current green kayak (old amber)" : f.text,
				sourceIdsJson: JSON.stringify([f.id]),
				sourceFingerprintsJson: JSON.stringify([f]),
				updatedAt: new Date("2026-11-01"),
			})
			.run();
	return { db, s, r, bank, source };
}
it("pins pagination and searches only current display text", async () => {
	await fixture();
	const read = await import("./native-read");
	const p = read.listMemory(h.userId, { scope: { kind: "personal" } });
	expect(p.rows).toHaveLength(50);
	expect(p.nextCursor).toBeTruthy();
	const p2 = read.listMemory(h.userId, {
		scope: { kind: "personal" },
		cursor: p.nextCursor ?? undefined,
	});
	expect(p2.rows).toHaveLength(5);
	expect(new Set([...p.rows, ...p2.rows].map((r) => r.ref.rowId)).size).toBe(
		55,
	);
	expect(
		read.listMemory(h.userId, { scope: { kind: "personal" }, query: "amber" })
			.rows,
	).toEqual([]);
});
it("omits uncertain display dates while retaining source dates and internal paging order", async () => {
	const f = await fixture();
	const { eq } = await import("drizzle-orm");
	const recentDate = new Date("2026-11-08");
	const quote = "I edited my assertion to say that the kayak is green.";
	f.db
		.insert(f.s.conversations)
		.values({ id: "edited-chat", userId: h.userId, title: "Edited chat" })
		.run();
	f.db
		.insert(f.s.messages)
		.values({
			id: "newer",
			conversationId: "edited-chat",
			role: "user",
			content: quote,
		})
		.run();
	const recent = f.r.recordMemorySource({
		userId: h.userId,
		bankId: f.bank.id,
		epoch: 0,
		eventId: "message:newer",
		lineageId: "newer",
		conversationId: "edited-chat",
		messageId: "newer",
		text: quote,
		context: "",
		assertedAt: f.source.assertedAt,
		explicitEditAt: recentDate,
	});
	const recentFact = { id: "newer-fact", text: "The kayak is green." };
	f.db
		.update(f.s.memorySourceRevisions)
		.set({
			state: "accepted",
			acknowledgedFactsJson: JSON.stringify([recentFact]),
		})
		.where(eq(f.s.memorySourceRevisions.id, recent.id))
		.run();
	f.db
		.update(f.s.memoryPublishedRows)
		.set({
			sourceFingerprintsJson: JSON.stringify([
				{ id: "f0", text: "Fact 0" },
				recentFact,
			]),
			sourceIdsJson: JSON.stringify(["f0", recentFact.id]),
			updatedAt: recentDate,
		})
		.where(eq(f.s.memoryPublishedRows.nativeId, "n0"))
		.run();
	const read = await import("./native-read");
	const page = read.listMemory(h.userId, { scope: { kind: "personal" } });
	expect(page.rows[0]).toMatchObject({ ref: { rowId: "n0" }, updatedAt: null });
	expect(page.rows[1].updatedAt).toBe(f.source.assertedAt.toISOString());
	const detail = read.getMemoryDetail(h.userId, page.rows[0].ref);
	expect(detail.row.updatedAt).toBeNull();
	expect(
		detail.sources.find((source) => source.id === recent.id),
	).toMatchObject({
		quote,
		available: true,
		assertedAt: recentDate.toISOString(),
	});
	expect(detail.sources.map(({ assertedAt }) => assertedAt).sort()).toEqual([
		f.source.assertedAt.toISOString(),
		recentDate.toISOString(),
	]);
});
it("old cursors and detail cannot resurrect revoked information", async () => {
	const f = await fixture();
	const read = await import("./native-read");
	const p = read.listMemory(h.userId, { scope: { kind: "personal" } });
	f.r.revokeMemorySources(h.userId, [f.source.id]);
	expect(
		read.listMemory(h.userId, {
			scope: { kind: "personal" },
			cursor: p.nextCursor ?? undefined,
		}).rows,
	).toEqual([]);
	expect(() => read.getMemoryDetail(h.userId, p.rows[0].ref)).toThrow();
});
it("does not enroll legacy users, exposes no cross-user or foreign project rows", async () => {
	const f = await fixture();
	const read = await import("./native-read");
	expect(() =>
		read.listMemory("not-user", { scope: { kind: "personal" } }),
	).toThrow();
	expect(() =>
		read.listMemory(h.userId, {
			scope: { kind: "project", projectId: "foreign" },
		}),
	).toThrow();
	f.db.update(f.s.memoryAccounts).set({ authority: "legacy" }).run();
	expect(
		read.listMemory(h.userId, { scope: { kind: "personal" } }),
	).toMatchObject({ authority: "legacy", rows: [] });
});
it("manual source without conversation is explicit and off does not expose rows", async () => {
	const f = await fixture();
	const read = await import("./native-read");
	const p = read.listMemory(h.userId, { scope: { kind: "personal" } });
	const detail = read.getMemoryDetail(h.userId, p.rows[0].ref);
	expect(detail.origin).toBe("unknown");
	expect(detail.sources[0].quote).toBe("");
	f.db.update(f.s.users).set({ memoryEnabled: false }).run();
	expect(
		read.listMemory(h.userId, { scope: { kind: "personal" } }),
	).toMatchObject({ status: "off", rows: [] });
});

it("batches list source counts without loading quotations for a thousand-source bank", async () => {
	const f = await fixture();
	const { vi } = await import("vitest");
	f.db.transaction((tx) => {
		for (let i = 0; i < 1000; i++)
			tx.insert(f.s.memorySourceRevisions)
				.values({
					id: `bulk-${i}`,
					userId: h.userId,
					bankId: f.bank.id,
					epoch: 0,
					eventId: `bulk-${i}`,
					lineageId: `bulk-${i}`,
					text: "Quotation excluded from list",
					context: "",
					textHash: `hash-${i}`,
					assertedAt: new Date(),
					state: "accepted",
					acknowledgedFactsJson: JSON.stringify([{ id: "f0", text: "Fact 0" }]),
				})
				.run();
	});
	const read = await import("./native-read");
	const prepare = vi.spyOn(h.sqlite, "prepare");
	const started = performance.now();
	const page = read.listMemory(h.userId, { scope: { kind: "personal" } });
	const elapsed = performance.now() - started;
	const statements = prepare.mock.calls.map(([sql]) => String(sql));
	expect(page.rows).toHaveLength(50);
	expect(page.rows.find((r) => r.ref.rowId === "n0")?.sourceCount).toBe(1001);
	expect(
		statements.filter((sql) => sql.includes('from "memory_source_revisions"'))
			.length,
	).toBeLessThanOrEqual(3);
	expect(
		statements.filter(
			(sql) =>
				sql.includes('from "messages"') || sql.includes('from "conversations"'),
		),
	).toHaveLength(0);
	console.info(
		`Synthetic 1001-source / 50-row list: ${elapsed.toFixed(1)} ms, ${statements.length} SQL statements`,
	);
	prepare.mockRestore();
});
