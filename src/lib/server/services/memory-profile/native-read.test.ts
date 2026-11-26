import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

// ── Search over the entries the Memory page shows ────────────────────────

import type { MemoryScope } from "$lib/memory-types";
import { searchTerms } from "$lib/shared/workspace-search-text";

const WINDOW = { offset: 0, limit: 20, countCap: 100 };

/** Memory with a personal bank and a project, each entry from a source of its own. */
async function searchFixture() {
	const { db } = await import("$lib/server/db");
	const s = await import("$lib/server/db/schema");
	const r = await import("./revisions");
	const { eq } = await import("drizzle-orm");
	r.ensureMemoryBank(h.userId, { kind: "personal" });
	db.update(s.memoryAccounts).set({ authority: "hindsight" }).run();
	for (const [id, name] of [
		["p1", "Thesis project"],
		["p2", "Garden"],
	] as const)
		db.insert(s.projects).values({ id, userId: h.userId, name }).run();
	const sourceOf = new Map<string, string>();
	function addEntry(
		scope: MemoryScope,
		nativeId: string,
		text: string,
		saidAt: string,
		editedAt: string | null = null,
	) {
		const bank = r.ensureMemoryBank(h.userId, scope);
		const source = r.recordMemorySource({
			userId: h.userId,
			bankId: bank.id,
			epoch: 0,
			eventId: `e-${nativeId}`,
			lineageId: `l-${nativeId}`,
			text: `said: ${text}`,
			context: "",
			assertedAt: new Date(saidAt),
			...(editedAt ? { explicitEditAt: new Date(editedAt) } : {}),
		});
		const fact = { id: `fact-${nativeId}`, text };
		db.update(s.memorySourceRevisions)
			.set({ state: "accepted", acknowledgedFactsJson: JSON.stringify([fact]) })
			.where(eq(s.memorySourceRevisions.id, source.id))
			.run();
		db.update(s.memoryBanks)
			.set({ generation: "g" })
			.where(eq(s.memoryBanks.id, bank.id))
			.run();
		db.insert(s.memoryPublishedRows)
			.values({
				id: `row-${nativeId}`,
				nativeId,
				bankId: bank.id,
				generation: "g",
				epoch: 0,
				text,
				nativeText: text,
				sourceIdsJson: JSON.stringify([fact.id]),
				sourceFingerprintsJson: JSON.stringify([fact]),
				updatedAt: new Date(saidAt),
			})
			.run();
		sourceOf.set(nativeId, source.id);
		return bank;
	}
	return { db, s, r, eq, addEntry, sourceOf };
}

const PERSONAL: MemoryScope = { kind: "personal" };
const THESIS: MemoryScope = { kind: "project", projectId: "p1" };
const GARDEN: MemoryScope = { kind: "project", projectId: "p2" };

it("searches every bank the person can see", async () => {
	const f = await searchFixture();
	f.addEntry(
		PERSONAL,
		"n1",
		"Writing a thesis on timber housing",
		"2026-11-01",
	);
	f.addEntry(PERSONAL, "n2", "Plan for the kitchen", "2026-11-02");
	f.addEntry(
		THESIS,
		"n3",
		"The thesis model is built at 1:50 scale",
		"2026-11-03",
	);
	const read = await import("./native-read");
	const found = read.searchMemoryEntries(
		h.userId,
		searchTerms("thesis"),
		WINDOW,
	);
	expect(found.searchable).toBe(true);
	expect(found.total).toBe(2);
	expect(found.entries.map((entry) => entry.ref.rowId).sort()).toEqual([
		"n1",
		"n3",
	]);
	expect(found.entries.find((entry) => entry.ref.rowId === "n3")).toMatchObject(
		{
			projectName: "Thesis project",
			ref: { scope: THESIS, generation: "g", rowId: "n3" },
			text: "The thesis model is built at 1:50 scale",
		},
	);
	expect(found.entries.find((entry) => entry.ref.rowId === "n1")).toMatchObject(
		{
			projectName: null,
			ref: { scope: PERSONAL },
		},
	);
});

it("takes words in any order, with accents and capitals folded", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "n1", "Plan for the kitchen", "2026-11-01");
	f.addEntry(PERSONAL, "n2", "Árvíztűrő tükörfúrógép", "2026-11-02");
	const read = await import("./native-read");
	const ids = (query: string) =>
		read
			.searchMemoryEntries(h.userId, searchTerms(query), WINDOW)
			.entries.map((entry) => entry.ref.rowId);
	expect(ids("kitchen plan")).toEqual(["n1"]);
	expect(ids("ARVIZ")).toEqual(["n2"]);
	expect(ids("kitchen budget")).toEqual([]);
});

it("says when each entry was last said, newest first, an edit counting as saying it again", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "old", "Thesis note A", "2026-01-10");
	f.addEntry(PERSONAL, "mid", "Thesis note B", "2026-03-10");
	// Said in January, edited in June: June is when it was last said.
	f.addEntry(THESIS, "edited", "Thesis note C", "2026-01-20", "2026-06-20");
	const read = await import("./native-read");
	const found = read.searchMemoryEntries(
		h.userId,
		searchTerms("thesis"),
		WINDOW,
	);
	expect(found.entries.map((entry) => entry.ref.rowId)).toEqual([
		"edited",
		"mid",
		"old",
	]);
	expect(found.entries.map((entry) => entry.lastSaidAt)).toEqual([
		"2026-06-20T00:00:00.000Z",
		"2026-03-10T00:00:00.000Z",
		"2026-01-10T00:00:00.000Z",
	]);
});

it("pages the entries and counts them up to the cap", async () => {
	const f = await searchFixture();
	for (let index = 0; index < 7; index++)
		f.addEntry(
			PERSONAL,
			`n${index}`,
			`Thesis note ${index}`,
			`2026-02-0${index + 1}`,
		);
	const read = await import("./native-read");
	const terms = searchTerms("thesis");
	const first = read.searchMemoryEntries(h.userId, terms, {
		offset: 0,
		limit: 3,
		countCap: 100,
	});
	expect(first.entries.map((entry) => entry.ref.rowId)).toEqual([
		"n6",
		"n5",
		"n4",
	]);
	expect(first).toMatchObject({ total: 7, hasMore: true });
	const last = read.searchMemoryEntries(h.userId, terms, {
		offset: 6,
		limit: 3,
		countCap: 100,
	});
	expect(last.entries.map((entry) => entry.ref.rowId)).toEqual(["n0"]);
	expect(last.hasMore).toBe(false);
	const capped = read.searchMemoryEntries(h.userId, terms, {
		offset: 0,
		limit: 3,
		countCap: 5,
	});
	expect(capped.total).toBe(5);
});

it("skips a project the person no longer owns", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "n1", "Thesis note", "2026-11-01");
	f.addEntry(GARDEN, "n2", "Thesis shed", "2026-11-02");
	f.db.delete(f.s.projects).where(f.eq(f.s.projects.id, "p2")).run();
	// The bank is still there; only the person's claim on its project is gone.
	expect(
		f.db
			.select()
			.from(f.s.memoryBanks)
			.where(f.eq(f.s.memoryBanks.scopeKey, "project:p2"))
			.all(),
	).toHaveLength(1);
	const read = await import("./native-read");
	const found = read.searchMemoryEntries(
		h.userId,
		searchTerms("thesis"),
		WINDOW,
	);
	expect(found.entries.map((entry) => entry.ref.rowId)).toEqual(["n1"]);
});

it("skips a bank it cannot read, so the others still answer", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "n1", "Thesis note", "2026-11-01");
	f.addEntry(THESIS, "n2", "Thesis model", "2026-11-02");
	f.db
		.update(f.s.memoryBanks)
		.set({ status: "retired" })
		.where(f.eq(f.s.memoryBanks.scopeKey, "project:p1"))
		.run();
	const read = await import("./native-read");
	const found = read.searchMemoryEntries(
		h.userId,
		searchTerms("thesis"),
		WINDOW,
	);
	expect(found.searchable).toBe(true);
	expect(found.entries.map((entry) => entry.ref.rowId)).toEqual(["n1"]);
	f.db
		.update(f.s.memoryBanks)
		.set({ status: "repair_blocked" })
		.where(f.eq(f.s.memoryBanks.scopeKey, "project:p1"))
		.run();
	expect(
		read
			.searchMemoryEntries(h.userId, searchTerms("thesis"), WINDOW)
			.entries.map((entry) => entry.ref.rowId),
	).toEqual(["n1"]);
});

it("says by code alone when it skips a bank", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "n1", "Thesis note", "2026-11-01");
	f.addEntry(THESIS, "n2", "Thesis model", "2026-11-02");
	f.db
		.update(f.s.memoryBanks)
		.set({ status: "retired" })
		.where(f.eq(f.s.memoryBanks.scopeKey, "project:p1"))
		.run();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const read = await import("./native-read");
		read.searchMemoryEntries(h.userId, searchTerms("thesis"), WINDOW);
		const lines = warn.mock.calls.map((call) => String(call[0]));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^\[WORKSPACE_SEARCH\] memory_bank_skipped code=[a-z_]+$/i,
		);
		expect(lines[0]).not.toContain("Thesis");
	} finally {
		warn.mockRestore();
	}
});

it("returns nothing when Memory is off or the account is not on native Memory", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "n1", "Thesis note", "2026-11-01");
	const read = await import("./native-read");
	const none = { entries: [], total: 0, hasMore: false, searchable: false };
	f.db.update(f.s.users).set({ memoryEnabled: false }).run();
	expect(
		read.searchMemoryEntries(h.userId, searchTerms("thesis"), WINDOW),
	).toEqual(none);
	f.db.update(f.s.users).set({ memoryEnabled: true }).run();
	f.db.update(f.s.memoryAccounts).set({ authority: "legacy" }).run();
	expect(
		read.searchMemoryEntries(h.userId, searchTerms("thesis"), WINDOW),
	).toEqual(none);
	f.db.update(f.s.memoryAccounts).set({ authority: "preparing" }).run();
	expect(
		read.searchMemoryEntries(h.userId, searchTerms("thesis"), WINDOW),
	).toEqual(none);
	// A person with no Memory at all.
	expect(
		read.searchMemoryEntries("not-user", searchTerms("thesis"), WINDOW),
	).toEqual(none);
});

it("says it is searchable, with no words searched, for a native account with Memory on", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "n1", "Thesis note", "2026-11-01");
	const read = await import("./native-read");
	expect(read.searchMemoryEntries(h.userId, [], WINDOW)).toEqual({
		entries: [],
		total: 0,
		hasMore: false,
		searchable: true,
	});
});

it("hides an entry the page hides", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "shown", "Thesis note that stays", "2026-11-01");
	f.addEntry(
		PERSONAL,
		"hidden",
		"Thesis note that was taken back",
		"2026-11-02",
	);
	f.r.revokeMemorySources(h.userId, [f.sourceOf.get("hidden") ?? ""]);
	const read = await import("./native-read");
	// The page and the search agree on what is there.
	expect(
		read
			.listMemory(h.userId, { scope: PERSONAL })
			.rows.map((row) => row.ref.rowId),
	).toEqual(["shown"]);
	expect(
		read
			.searchMemoryEntries(h.userId, searchTerms("thesis"), WINDOW)
			.entries.map((entry) => entry.ref.rowId),
	).toEqual(["shown"]);
});

it("the Memory page finds words in any order, and with or without accents", async () => {
	const f = await searchFixture();
	f.addEntry(PERSONAL, "n1", "Plan for the kitchen", "2026-11-01");
	f.addEntry(PERSONAL, "n2", "Árvíztűrő tükörfúrógép", "2026-11-02");
	f.addEntry(PERSONAL, "n3", "Garden shed", "2026-11-03");
	const read = await import("./native-read");
	const rows = (query: string) =>
		read
			.listMemory(h.userId, { scope: PERSONAL, query })
			.rows.map((row) => row.ref.rowId);
	expect(rows("kitchen plan")).toEqual(["n1"]);
	expect(rows("  KITCHEN  plan ")).toEqual(["n1"]);
	expect(rows("arviz")).toEqual(["n2"]);
	expect(rows("kitchen budget")).toEqual([]);
	// A query with no words once cleaned is no query.
	expect(rows("!!").sort()).toEqual(["n1", "n2", "n3"]);
	expect(rows("").sort()).toEqual(["n1", "n2", "n3"]);
});

it("entryLastSaidAt takes the newest source date of an entry's facts", async () => {
	await searchFixture();
	const { entryLastSaidAt, factSaidTimes } = await import("./publication");
	const times = factSaidTimes([
		{
			id: "a",
			source: { assertedAt: new Date("2026-01-01"), explicitEditAt: null },
		},
		{
			// The same fact, acknowledged again by a later source.
			id: "a",
			source: { assertedAt: new Date("2026-02-01"), explicitEditAt: null },
		},
		{
			id: "b",
			source: {
				assertedAt: new Date("2026-01-05"),
				explicitEditAt: new Date("2026-03-05"),
			},
		},
		{
			id: "c",
			source: { assertedAt: new Date("2025-12-01"), explicitEditAt: null },
		},
	]);
	expect(entryLastSaidAt(["a"], times)).toBe("2026-02-01T00:00:00.000Z");
	expect(entryLastSaidAt(["a", "b"], times)).toBe("2026-03-05T00:00:00.000Z");
	expect(entryLastSaidAt(["c", "a"], times)).toBe("2026-02-01T00:00:00.000Z");
	expect(entryLastSaidAt(["unknown"], times)).toBeNull();
	expect(entryLastSaidAt([], times)).toBeNull();
});
