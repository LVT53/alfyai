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
	"summary",
] as const)("retains actual full detail and paging after %s failure", async (kind) => {
	const { getConversationDetail, getOlderConversationMessages } = await import(
		"$lib/server/services/conversation-detail/read-model"
	);
	const input = { userId: "u", conversationId: "c", messageWindowLimit: 3 };
	const baseline = await getConversationDetail(input);
	expect(baseline?.messages.map((row) => row.id)).toEqual(["a1", "u2", "a2"]);
	f.fault(kind);
	const detail = await getConversationDetail(input);
	expect(f.counts[kind]).toBe(1);
	expect(durable(detail?.messages ?? [])).toEqual(
		durable(baseline?.messages ?? []),
	);
	expect(detail?.hasMoreMessages).toBe(true);
	if (kind === "summary") {
		expect(detail).not.toHaveProperty("totalCostUsdMicros");
		expect(detail).not.toHaveProperty("totalTokens");
		expect(detail?.messages[2].costUsd).toBe(0.00014);
	} else {
		expectUnknown(detail?.messages ?? []);
		expect(detail?.totalCostUsdMicros).toBe(baseline?.totalCostUsdMicros);
	}
	f.fault(kind);
	const page = await getOlderConversationMessages({
		userId: "u",
		conversationId: "c",
		limit: 2,
		offset: 2,
	});
	expect(page?.messages.map((row) => row.id)).toEqual(["u1", "a1"]);
	expect(page?.hasMoreBefore).toBe(false);
	if (kind !== "summary") expectUnknown(page?.messages ?? []);
});
it("omits incognito totals without optional accounting and preserves missing authorization", async () => {
	const { getConversationDetail, getOlderConversationMessages } = await import(
		"$lib/server/services/conversation-detail/read-model"
	);
	f.db
		.update(schema.conversations)
		.set({ memoryIncognito: true })
		.where(eq(schema.conversations.id, "c"))
		.run();
	f.fault("summary");
	const detail = await getConversationDetail({
		userId: "u",
		conversationId: "c",
	});
	expect(detail?.messages).toHaveLength(4);
	expectUnknown(detail?.messages ?? []);
	expect(detail).not.toHaveProperty("totalCostUsdMicros");
	expect(detail).not.toHaveProperty("totalTokens");
	for (const kind of ["ledger", "usage", "legacy", "summary"])
		expect(f.counts[kind] ?? 0).toBe(0);
	expect(
		await getConversationDetail({ userId: "intruder", conversationId: "c" }),
	).toBeNull();
	expect(
		await getOlderConversationMessages({
			userId: "u",
			conversationId: "absent",
			offset: 0,
		}),
	).toBeNull();
});
