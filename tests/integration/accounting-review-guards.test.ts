// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountingReadFixture } from "./accounting-read-fixture";

let f: Awaited<ReturnType<typeof accountingReadFixture>>;
beforeEach(async () => {
	f = await accountingReadFixture();
	await f.seed();
});
afterEach(() => {
	vi.restoreAllMocks();
	f?.close();
});
it.each([
	"usage",
	"ledger",
] as const)("retains persisted model identity when %s accounting fails", async (kind) => {
	f.message("identity", "assistant", {
		modelDisplayName: "Persisted display",
		depthMetadata: {
			requested: "thorough",
			appliedProfile: "standard",
			fallback: false,
			modelId: "provider:p:m",
			modelDisplayName: "Persisted display",
		},
	});
	f.legacy("identity");
	f.fault(kind);
	const row = (await f.readers.listMessages("c")).find(
		(m) => m.id === "identity",
	);
	expect(row?.modelId).toBe("provider:p:m");
	expect(row?.costUsd).toBeUndefined();
});
it("logs unavailable optional accounting without exposing error contents or message IDs", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	f.fault("ledger");
	expect(await f.analytics.getMessageReadUsageProjections("c", ["a1"])).toEqual(
		{ availability: "unavailable" },
	);
	expect(warn).toHaveBeenCalledExactlyOnceWith(
		"[ANALYTICS] Optional message accounting unavailable",
		{ messageCount: 1 },
	);
});

it.each([
	"ledger",
	"optional",
] as const)("bounds %s reads to exactly 500 distinct IDs per batch", async (reader) => {
	const batches: { kind: string; ids: string[] }[] = [];
	const prepare = vi.mocked(f.sqlite.prepare).getMockImplementation();
	if (!prepare) throw new Error("fixture must instrument SQLite prepare");
	vi.mocked(f.sqlite.prepare).mockImplementation((query) => {
		const statement = prepare.call(f.sqlite, query);
		const kind = query.includes('from "normal_chat_turns"')
			? "ledger"
			: query.includes('"usage_events"')
				? "legacy"
				: null;
		if (!kind) return statement;
		const wrapped = new Proxy(statement, {
			get(target, key) {
				const value = Reflect.get(target, key);
				if (key === "all")
					return (...params: unknown[]) => {
						const ids = params
							.flat()
							.filter(
								(id): id is string =>
									typeof id === "string" && id.startsWith("batch-"),
							);
						batches.push({ kind, ids });
						return Reflect.apply(target.all, target, params);
					};
				return typeof value === "function"
					? (...args: unknown[]) => {
							const result = Reflect.apply(value, target, args);
							return result === target ? wrapped : result;
						}
					: value;
			},
		});
		return wrapped;
	});
	const ids = Array.from({ length: 1001 }, (_, n) => `batch-${n}`);
	const repeated = [...ids.slice(0, 501), ...ids];
	if (reader === "ledger")
		await f.analytics.getNormalChatMessageUsageProjections("c", repeated);
	else await f.analytics.getMessageReadUsageProjections("c", repeated);
	for (const kind of reader === "ledger" ? ["ledger"] : ["ledger", "legacy"]) {
		const selected = batches
			.filter((batch) => batch.kind === kind)
			.map((batch) => batch.ids);
		expect(selected.map((batch) => batch.length)).toEqual([500, 500, 1]);
		expect(selected.flat()).toEqual(ids);
	}
});
