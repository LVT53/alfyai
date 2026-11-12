// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	accountingReadFixture,
	durable,
	expectUnknown,
} from "./accounting-read-fixture";

let f: Awaited<ReturnType<typeof accountingReadFixture>>;
beforeEach(async () => {
	f = await accountingReadFixture();
	await f.seed();
});
afterEach(() => f?.close());

it.each([
	"ledger",
	"usage",
	"legacy",
] as const)("preserves both real readers when %s accounting fails", async (kind) => {
	const baseline = await f.readers.listMessages("c");
	expect(baseline.map((row) => row.id)).toEqual(["u1", "a1", "u2", "a2"]);
	expect(baseline[3]).toMatchObject({
		costUsd: 0.00014,
		totalTokenCount: 120,
		thinkingTokenCount: 5,
	});
	const before = f.facts();
	for (const read of [
		() => f.readers.listMessages("c"),
		async () => (await f.readers.listMessageWindow("c")).messages,
	]) {
		f.fault(kind);
		const rows = await read();
		expect(f.counts[kind]).toBe(1);
		expect(durable(rows)).toEqual(durable(baseline));
		expectUnknown(rows);
		expect(rows[1]).toMatchObject({
			modelDisplayName: "Saved display",
			providerDisplayName: "Saved provider",
			providerIconUrl: "/saved-icon.png",
		});
		expect(rows[3].modelId).toBeUndefined();
	}
	f.fault();
	expect(f.facts()).toEqual(before);
	expect((await f.readers.listMessages("c"))[3].costUsd).toBe(0.00014);
});

it.each([
	"ledger",
	"usage",
	"legacy",
] as const)("discards earlier batches after later %s failure", async (kind) => {
	for (let n = 0; n < 502; n++) {
		f.message(`bulk-${n}`);
		f.legacy(`bulk-${n}`);
	}
	f.fault(kind, 2);
	const rows = await f.readers.listMessages("c");
	expect(rows).toHaveLength(506);
	expectUnknown(rows);
	expect(f.counts[kind]).toBe(2);
	f.fault();
	const restored = await f.readers.listMessages("c");
	expect(restored[3].costUsd).toBe(0.00014);
	expect(restored.at(-1)?.costUsd).toBe(0.000042);
	expect(f.counts.ledger).toBe(2);
	expect(f.counts.usage).toBeLessThanOrEqual(2);
	expect(f.counts.legacy).toBeLessThanOrEqual(2);
	const pages = await Promise.all(
		[0, 2].map((offset) =>
			f.readers.listMessageWindow("c", { limit: 2, offset }),
		),
	);
	expect(pages.map((page) => page.messages.map((row) => row.id))).toEqual([
		["bulk-500", "bulk-501"],
		["bulk-498", "bulk-499"],
	]);
	expect(pages.map((page) => page.hasMoreBefore)).toEqual([true, true]);
});

it("does no enrichment-only privacy or accounting reads for empty and user-only selections", async () => {
	f.fault("privacy");
	expect(await f.readers.listMessages("empty")).toEqual([]);
	expect(await f.readers.listMessageWindow("empty")).toEqual({
		messages: [],
		hasMoreBefore: false,
	});
	expect(f.counts.privacy ?? 0).toBe(0);
	f.message("only-user", "user", {}, "empty");
	for (const conversationId of ["absent", "empty"]) {
		for (const read of [
			() => f.readers.listMessages(conversationId),
			async () => (await f.readers.listMessageWindow(conversationId)).messages,
		]) {
			f.fault("privacy");
			expect((await read()).map((row) => row.id)).toEqual(
				conversationId === "empty" ? ["only-user"] : [],
			);
			expect(f.counts.privacy ?? 0).toBe(0);
			expect(f.counts.ledger ?? 0).toBe(0);
		}
	}
	f.fault("privacy");
	expect(await f.readers.listMessageWindow("c", { offset: 100 })).toEqual({
		messages: [],
		hasMoreBefore: false,
	});
	expect(f.counts.privacy ?? 0).toBe(0);
});

it.each([
	"core",
	"attachments",
	"privacy",
] as const)("keeps mandatory %s failures rejecting", async (kind) => {
	for (const read of [
		() => f.readers.listMessages("c"),
		() => f.readers.listMessageWindow("c"),
	]) {
		f.fault(kind);
		await expect(read()).rejects.toThrow(`injected-${kind}`);
	}
});

it("preserves selected rows on successful privacy absence without touching accounting", async () => {
	for (const read of [
		() => f.readers.listMessages("c"),
		async () => (await f.readers.listMessageWindow("c")).messages,
	]) {
		f.fault("privacy-absent");
		const rows = await read();
		expect(rows.map((row) => row.id)).toEqual(["u1", "a1", "u2", "a2"]);
		expectUnknown(rows);
		expect(f.counts.ledger ?? 0).toBe(0);
		expect(f.counts.usage ?? 0).toBe(0);
		expect(f.counts.legacy ?? 0).toBe(0);
	}
});

it("resolves incognito before all optional reads despite stale financial rows", async () => {
	f.db
		.update(schema.conversations)
		.set({ memoryIncognito: true })
		.where(eq(schema.conversations.id, "c"))
		.run();
	for (const kind of ["ledger", "usage", "legacy"] as const) {
		f.fault(kind);
		const rows = await f.readers.listMessages("c");
		expect(rows).toHaveLength(4);
		expectUnknown(rows);
		expect(f.counts.ledger ?? 0).toBe(0);
		expect(f.counts.usage ?? 0).toBe(0);
		expect(f.counts.legacy ?? 0).toBe(0);
	}
});

it.each([
	"ledger",
	"summary",
] as const)("keeps strict usage rejection for %s failure", async (kind) => {
	f.fault(kind);
	await expect(
		f.analytics.getMessageUsageState("u", "c", "a2"),
	).rejects.toThrow();
	f.fault();
	expect(
		await f.analytics.getMessageUsageState("intruder", "c", "a2"),
	).toBeNull();
	expect(
		await f.analytics.getMessageUsageState("u", "c", "missing"),
	).toBeNull();
});

it("does not enrich an assistant lookahead row outside a user-only page", async () => {
	f.fault("privacy");
	const page = await f.readers.listMessageWindow("c", { limit: 1, offset: 1 });
	expect(page.messages.map((row) => row.id)).toEqual(["u2"]);
	expect(page.hasMoreBefore).toBe(true);
	for (const kind of ["privacy", "ledger", "usage", "legacy"])
		expect(f.counts[kind] ?? 0).toBe(0);
});

it("preserves observed healthy ledger message identity without stale legacy numbers", async () => {
	// Before the core/optional split, the message's usage_events row supplied
	// this actual recorded identity even though the ledger supplied its totals.
	for (const read of [
		() => f.readers.listMessages("c"),
		async () => (await f.readers.listMessageWindow("c", { limit: 1 })).messages,
	]) {
		const rows = await read();
		expect(rows.find((row) => row.id === "a2")).toMatchObject({
			modelId: "provider:p:m",
			modelDisplayName: "Accounting display",
			costUsd: 0.00014,
			// The time its message recorded (the fixture's analytics row), as live;
			// cost and tokens come from the ledger, not from the legacy rows.
			generationDurationMs: 8888,
			responseTokenCount: 20,
			thinkingTokenCount: 5,
			totalTokenCount: 120,
		});
	}
});

it("scopes optional projections to selected assistants and retains genuine legacy zero", async () => {
	f.message("zero");
	f.legacy("zero", 0);
	const result = await f.analytics.getMessageReadUsageProjections("c", [
		"a1",
		"zero",
		"u1",
		"absent",
	]);
	expect(result.availability).toBe("resolved");
	if (result.availability !== "resolved")
		throw new Error("expected healthy projection");
	expect([...result.projections.keys()].sort()).toEqual(["a1", "zero"]);
	expect(result.projections.get("zero")?.costUsdMicros).toBe(0);
	const other = await f.analytics.getMessageReadUsageProjections("empty", [
		"a1",
	]);
	expect(other.availability).toBe("resolved");
	if (other.availability === "resolved") expect(other.projections.size).toBe(0);
});
