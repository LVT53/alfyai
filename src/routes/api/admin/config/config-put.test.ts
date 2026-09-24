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
// What the (mocked) admin_config table holds, so a GET after a PUT reports the
// row the PUT wrote — the read half of the save-read-save round trip.
const stored = new Map<string, string>();

vi.mock("$lib/server/db", () => ({
	db: {
		select: () => ({
			from: () =>
				Promise.resolve(
					[...stored].map(([key, value]) => ({
						key,
						value,
						updatedAt: new Date(0),
						updatedBy: "admin-1",
					})),
				),
		}),
		delete: () => ({
			where: (clause: { key?: string }) => {
				const key = clause?.key ?? "?";
				deleted.push(key);
				stored.delete(key);
				return Promise.resolve();
			},
		}),
		insert: () => ({
			values: (row: { key: string; value: string }) => ({
				onConflictDoUpdate: () => {
					upserted.push({ key: row.key, value: row.value });
					stored.set(row.key, row.value);
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
	};
});

import { GET, PUT } from "./+server";

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
		const response = await PUT(
			makeEvent({ DOCUMENT_EXTRACTION_MAX_ATTEMPTS: "5" }),
		);

		expect(response.status).toBe(200);
		expect(upserted).toEqual([
			{ key: "DOCUMENT_EXTRACTION_MAX_ATTEMPTS", value: "5" },
		]);
	});

	it("refuses a value above the key's maximum and names the bound", async () => {
		const response = await PUT(
			makeEvent({ DOCUMENT_EXTRACTION_MAX_ATTEMPTS: "900" }),
		);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.invalid.DOCUMENT_EXTRACTION_MAX_ATTEMPTS).toEqual({
			reason: "above-max",
			limit: 10,
		});
		expect(body.error).toContain("DOCUMENT_EXTRACTION_MAX_ATTEMPTS");
	});

	it("refuses a non-integer for an integer key", async () => {
		const response = await PUT(makeEvent({ CONCURRENT_STREAM_LIMIT: "lots" }));

		expect(response.status).toBe(400);
		expect((await response.json()).invalid.CONCURRENT_STREAM_LIMIT).toEqual({
			reason: "not-a-number",
		});
	});

	it("refuses a select value that is not one of the registry's options", async () => {
		const response = await PUT(makeEvent({ MINERU_OCR_MODE: "v9" }));

		expect(response.status).toBe(400);
		expect((await response.json()).invalid.MINERU_OCR_MODE).toEqual({
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

	// Save → read → save again, the way the admin page does it: the field is
	// seeded from the stored value, so a canonical form this endpoint refuses
	// makes the NEXT save of that key a 400 — and, because a rejection fails the
	// whole patch, every other key in the same body with it. The value below is
	// the reported repro: `String(0.0000001)` is "1e-7", which has no place in
	// this endpoint's own `/^-?\d*\.?\d+$/` pattern for a `number` control.
	describe("a stored number can be saved again", () => {
		beforeEach(() => {
			stored.clear();
		});

		it("stores a tiny value in a form the endpoint accepts back", async () => {
			const first = await PUT(
				makeEvent({ PARALLEL_FREE_MONTHLY_USD: "0.0000001" }),
			);

			expect(first.status).toBe(200);
			expect(upserted).toEqual([
				{ key: "PARALLEL_FREE_MONTHLY_USD", value: "0.0000001" },
			]);
		});

		it("accepts a PATCH echoing the value the GET reports as stored", async () => {
			const first = await PUT(
				makeEvent({ PARALLEL_FREE_MONTHLY_USD: "0.0000001" }),
			);
			expect(first.status).toBe(200);

			const read = (await (await GET(makeEvent({}))).json()) as {
				overrides: Record<string, string>;
			};
			const storedValue = read.overrides.PARALLEL_FREE_MONTHLY_USD;

			// The whole patch fails when this key does, so the stored form
			// being un-saveable took every other key in the body down with it.
			upserted.length = 0;
			const second = await PUT(
				makeEvent({ PARALLEL_FREE_MONTHLY_USD: storedValue }),
			);

			expect(second.status).toBe(200);
			expect(await second.json()).toEqual({ success: true });
			expect(upserted).toEqual([
				{ key: "PARALLEL_FREE_MONTHLY_USD", value: "0.0000001" },
			]);
			expect(storedValue).toBe("0.0000001");
		});

		it("still refuses an exponent spelling typed by hand", async () => {
			// The fix changes the form this endpoint WRITES, not the forms it
			// reads: "1e-7" and "1e3" stay not-a-number, as the registry's own
			// tests and the hostile-input expectations both require.
			for (const raw of ["1e-7", "1e3", "0.0000001e0"]) {
				upserted.length = 0;
				const response = await PUT(
					makeEvent({ PARALLEL_FREE_MONTHLY_USD: raw }),
				);
				expect(response.status, raw).toBe(400);
				expect(
					(await response.json()).invalid.PARALLEL_FREE_MONTHLY_USD,
					raw,
				).toEqual({ reason: "not-a-number" });
				expect(upserted, raw).toEqual([]);
			}
		});
	});
});
