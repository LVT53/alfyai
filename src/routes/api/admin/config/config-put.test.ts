// The admin config write endpoint is reachable with any body an admin can
// send, so type and range are checked here rather than only in the Advanced
// page's controls. These tests pin the three properties that matter: a bad
// value is refused and named, a refusal writes NOTHING (not even the keys in
// the same patch that were fine), and an empty value still deletes the row.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
}));

const deleted: string[] = [];
const upserted: Array<{ key: string; value: string }> = [];

vi.mock("$lib/server/db", () => ({
	db: {
		select: () => ({ from: () => Promise.resolve([]) }),
		delete: () => ({
			where: (clause: { key?: string }) => {
				deleted.push(clause?.key ?? "?");
				return Promise.resolve();
			},
		}),
		insert: () => ({
			values: (row: { key: string; value: string }) => ({
				onConflictDoUpdate: () => {
					upserted.push({ key: row.key, value: row.value });
					return Promise.resolve();
				},
			}),
		}),
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: (_column: unknown, value: string) => ({ key: value }),
}));

vi.mock("$lib/server/db/schema", () => ({
	adminConfig: { key: "key" },
}));

vi.mock("$lib/server/prompts", () => ({
	normalizeSystemPromptReference: (value: string) => value,
}));

vi.mock("$lib/server/config-store", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/config-store")
	>("$lib/server/config-store");
	return {
		...actual,
		refreshConfig: vi.fn(async () => {}),
		getEnvDefaults: () => ({}),
		getResolvedAdminConfigValues: () => ({}),
		getAtlasOverviewMaxOutputTokens: () => 0,
		getAtlasInDepthMaxOutputTokens: () => 0,
		getAtlasExhaustiveMaxOutputTokens: () => 0,
		getAtlasMaxWriterPromptChars: () => 0,
	};
});

import { PUT } from "./+server";

type RouteEvent = Parameters<typeof PUT>[0];

function makeEvent(body: Record<string, unknown>): RouteEvent {
	return {
		request: new Request("http://localhost/api/admin/config", {
			method: "PUT",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
		locals: { user: { id: "admin-1", role: "admin" } },
		params: {},
		url: new URL("http://localhost/api/admin/config"),
		route: { id: "/api/admin/config" },
	} as RouteEvent;
}

describe("PUT /api/admin/config validation", () => {
	beforeEach(() => {
		deleted.length = 0;
		upserted.length = 0;
		vi.clearAllMocks();
	});

	it("writes a value that is inside the registry's range", async () => {
		const response = await PUT(makeEvent({ ATLAS_V2_ENTAILMENT_BATCH: "12" }));

		expect(response.status).toBe(200);
		expect(upserted).toEqual([
			{ key: "ATLAS_V2_ENTAILMENT_BATCH", value: "12" },
		]);
	});

	it("refuses a value above the key's maximum and names the bound", async () => {
		const response = await PUT(makeEvent({ ATLAS_V2_ENTAILMENT_BATCH: "900" }));

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.invalid.ATLAS_V2_ENTAILMENT_BATCH).toEqual({
			reason: "above-max",
			limit: 25,
		});
		expect(body.error).toContain("ATLAS_V2_ENTAILMENT_BATCH");
	});

	it("refuses a non-integer for an integer key", async () => {
		const response = await PUT(makeEvent({ CONCURRENT_STREAM_LIMIT: "lots" }));

		expect(response.status).toBe(400);
		expect((await response.json()).invalid.CONCURRENT_STREAM_LIMIT).toEqual({
			reason: "not-a-number",
		});
	});

	it("refuses a pipeline value that is not one of v1, v2 or v3", async () => {
		const response = await PUT(makeEvent({ ATLAS_PIPELINE: "v9" }));

		expect(response.status).toBe(400);
		expect((await response.json()).invalid.ATLAS_PIPELINE).toEqual({
			reason: "invalid-option",
		});
	});

	it("writes nothing at all when one key in the patch is invalid", async () => {
		const response = await PUT(
			makeEvent({
				TEI_TIMEOUT_MS: "5000",
				PER_USER_STREAM_LIMIT: "0",
			}),
		);

		expect(response.status).toBe(400);
		expect(upserted).toEqual([]);
		expect(deleted).toEqual([]);
	});

	it("still treats an empty value as delete-the-override", async () => {
		const response = await PUT(makeEvent({ TEI_TIMEOUT_MS: "   " }));

		expect(response.status).toBe(200);
		expect(deleted).toEqual(["TEI_TIMEOUT_MS"]);
		expect(upserted).toEqual([]);
	});

	it("stores the canonical form of an accepted value", async () => {
		const response = await PUT(
			makeEvent({ ATTACHMENT_TRACE_DEBUG: "TRUE", TEI_TIMEOUT_MS: "0500" }),
		);

		expect(response.status).toBe(200);
		// Order follows ADMIN_CONFIG_KEYS, not the request body.
		expect(upserted).toEqual([
			{ key: "TEI_TIMEOUT_MS", value: "500" },
			{ key: "ATTACHMENT_TRACE_DEBUG", value: "true" },
		]);
	});

	it("refuses a boolean spelling it cannot read as on or off", async () => {
		const response = await PUT(makeEvent({ ATTACHMENT_TRACE_DEBUG: "maybe" }));

		expect(response.status).toBe(400);
		expect(upserted).toEqual([]);
	});

	// A key marked `effect: "unwired"` is one no code path reads. The Advanced
	// page renders it read-only and leaves it out of the patch, and this
	// endpoint drops it: storing it would answer `{ success: true }` for a
	// change that can have no effect, and leave a row in the override list
	// looking like a live setting. Dropped, NOT refused — a refusal fails the
	// whole patch, so one stale tab or provisioning script carrying an unwired
	// key alongside a dozen good ones could no longer save anything at all.
	describe("keys nothing reads", () => {
		it("drops one and names it, without calling the value invalid", async () => {
			const response = await PUT(makeEvent({ TEI_RERANKER_MODEL: "bge-m3" }));
			const body = (await response.json()) as {
				success: boolean;
				ignored: Record<string, { reason: string }>;
			};

			expect(response.status).toBe(200);
			expect(body.success).toBe(true);
			expect(body.ignored.TEI_RERANKER_MODEL).toEqual({
				reason: "unwired",
			});
			expect(upserted).toEqual([]);
			expect(deleted).toEqual([]);
		});

		// And the other direction: a key that WAS inert and is now wired has to
		// be stored, not silently dropped. Both timeouts were on this list.
		it("stores the sandbox timeout now that the sandbox enforces it", async () => {
			const response = await PUT(
				makeEvent({ FILE_PRODUCTION_SANDBOX_TIMEOUT_MS: "120000" }),
			);
			const body = (await response.json()) as {
				success: boolean;
				ignored?: Record<string, { reason: string }>;
			};

			expect(response.status).toBe(200);
			expect(body.success).toBe(true);
			// Nothing was dropped, so the endpoint does not report an `ignored`
			// map at all.
			expect(body.ignored?.FILE_PRODUCTION_SANDBOX_TIMEOUT_MS).toBeUndefined();
			expect(upserted).toEqual([
				{ key: "FILE_PRODUCTION_SANDBOX_TIMEOUT_MS", value: "120000" },
			]);
		});

		it("drops every one of them, including the text control", async () => {
			for (const key of [
				// FILE_PRODUCTION_RENDERER_TIMEOUT_MS and
				// FILE_PRODUCTION_SANDBOX_TIMEOUT_MS used to be here. Both are
				// wired now — the attempt's RenderBudget deadline and the
				// program-mode container's deadline — so both are writable.
				"TEI_RERANKER_MODEL",
				"WORKING_SET_DOCUMENT_TOKEN_BUDGET",
				"WORKING_SET_PROMPT_TOKEN_BUDGET",
			]) {
				upserted.length = 0;
				deleted.length = 0;
				const response = await PUT(makeEvent({ [key]: "1200" }));
				const body = (await response.json()) as {
					ignored: Record<string, { reason: string }>;
				};
				expect(response.status, key).toBe(200);
				expect(body.ignored[key], key).toEqual({ reason: "unwired" });
				expect(upserted, key).toEqual([]);
			}
		});

		it("drops an empty one too — it must not delete a row either", async () => {
			// "" normally means "drop the override". For a key that cannot be
			// written there is nothing to drop, and an existing row (written by
			// an older build, before these keys were inert) must survive.
			const response = await PUT(makeEvent({ TEI_RERANKER_MODEL: "" }));

			expect(response.status).toBe(200);
			expect(deleted).toEqual([]);
			expect(upserted).toEqual([]);
		});

		it("leaves the rest of the patch alone instead of taking it down", async () => {
			// The whole point of dropping rather than refusing: the good key in
			// the same body still lands. An admin tab loaded before this deploy
			// posts exactly this shape.
			const response = await PUT(
				makeEvent({
					TEI_TIMEOUT_MS: "500",
					TEI_RERANKER_MODEL: "bge-reranker-v2-m3",
				}),
			);
			const body = (await response.json()) as {
				ignored: Record<string, { reason: string }>;
			};

			expect(response.status).toBe(200);
			expect(Object.keys(body.ignored)).toEqual(["TEI_RERANKER_MODEL"]);
			expect(upserted).toEqual([{ key: "TEI_TIMEOUT_MS", value: "500" }]);
		});

		it("reports the drop alongside a genuine validation failure", async () => {
			// A malformed value still fails everything, and the caller hears
			// about both problems from the one response.
			const response = await PUT(
				makeEvent({
					PER_USER_STREAM_LIMIT: "0",
					TEI_RERANKER_MODEL: "anything",
				}),
			);
			const body = (await response.json()) as {
				error: string;
				invalid: Record<string, { reason: string }>;
				ignored: Record<string, { reason: string }>;
			};

			expect(response.status).toBe(400);
			expect(body.error).toContain("Invalid value for PER_USER_STREAM_LIMIT");
			expect(Object.keys(body.invalid)).toEqual(["PER_USER_STREAM_LIMIT"]);
			expect(body.ignored.TEI_RERANKER_MODEL).toEqual({ reason: "unwired" });
			expect(upserted).toEqual([]);
			expect(deleted).toEqual([]);
		});

		it("says nothing about ignored keys when the patch has none", async () => {
			const response = await PUT(makeEvent({ TEI_TIMEOUT_MS: "500" }));
			const body = (await response.json()) as Record<string, unknown>;

			expect(response.status).toBe(200);
			expect(body).toEqual({ success: true });
		});
	});

	it("leaves keys with no registry spec untouched", async () => {
		// `MODEL_TIMEOUT_FAILOVER_TARGET_MODEL` lives on a named page, not the
		// Advanced registry; it must still be writable, not silently rejected.
		const response = await PUT(
			makeEvent({ MODEL_TIMEOUT_FAILOVER_TARGET_MODEL: "provider:p1:m1" }),
		);

		expect(response.status).toBe(200);
		expect(upserted).toEqual([
			{ key: "MODEL_TIMEOUT_FAILOVER_TARGET_MODEL", value: "provider:p1:m1" },
		]);
	});
});
