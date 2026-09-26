import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/artifacts/app/storage", () => ({
	readAppValue: vi.fn(),
	writeAppValue: vi.fn(),
}));

import {
	readAppValue,
	writeAppValue,
} from "$lib/server/services/artifacts/app/storage";
import { GET, POST } from "./+server";

const mockReadAppValue = readAppValue as ReturnType<typeof vi.fn>;
const mockWriteAppValue = writeAppValue as ReturnType<typeof vi.fn>;

function makeGetEvent(
	id = "app-1",
	userId: string | null = "owner-user",
	key: string | null = "expenses",
	conversationId: string | null = null,
) {
	const params = new URLSearchParams();
	if (key !== null) params.set("key", key);
	if (conversationId) params.set("conversationId", conversationId);
	return {
		params: { id },
		url: new URL(
			`http://localhost/api/artifacts/${id}/app/kv?${params.toString()}`,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

function makePostEvent(
	id = "app-1",
	userId: string | null = "owner-user",
	body: unknown = { key: "expenses", value: [1, 2] },
	options?: { unparseable?: boolean },
) {
	return {
		params: { id },
		url: new URL(`http://localhost/api/artifacts/${id}/app/kv`),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
		request: {
			json: async () => {
				if (options?.unparseable) throw new SyntaxError("bad json");
				return body;
			},
		},
	} as never;
}

describe("GET /api/artifacts/[id]/app/kv", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 when there is no authenticated user", async () => {
		await expect(GET(makeGetEvent("app-1", null))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockReadAppValue).not.toHaveBeenCalled();
	});

	it("400s invalid_key when the query has no ?key=", async () => {
		const response = await GET(makeGetEvent("app-1", "owner-user", null));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, reason: "invalid_key" });
		expect(mockReadAppValue).not.toHaveBeenCalled();
	});

	it("200s { ok: true, value } for a hit", async () => {
		mockReadAppValue.mockResolvedValue({ ok: true, value: [42] });
		const response = await GET(makeGetEvent());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, value: [42] });
	});

	it("200s { ok: true, value: null } for a miss — never a 404 for a missing KEY", async () => {
		mockReadAppValue.mockResolvedValue({ ok: true, value: null });
		const response = await GET(makeGetEvent());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, value: null });
	});

	it.each([
		["invalid_key", 400],
		["not_found", 404],
	] as const)("maps reason %s to status %i", async (reason, status) => {
		mockReadAppValue.mockResolvedValue({ ok: false, reason });
		const response = await GET(makeGetEvent());
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ ok: false, reason });
	});

	it("passes the artifact id from the ROUTE, and the key/conversationId from the query, to the service", async () => {
		mockReadAppValue.mockResolvedValue({ ok: true, value: 1 });
		await GET(makeGetEvent("app-42", "owner-user", "k", "conv-1"));
		expect(mockReadAppValue).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "app-42",
			key: "k",
			conversationId: "conv-1",
		});
	});

	// Ruling 58: the served App document is already no-store; the kv READ's
	// body is the user's own stored data and deserves the same treatment,
	// even though nothing here is heuristically cacheable today (no
	// validator) — this makes it explicit rather than relying on that.
	it.each([
		["a hit", () => mockReadAppValue.mockResolvedValue({ ok: true, value: 1 })],
		[
			"a miss",
			() => mockReadAppValue.mockResolvedValue({ ok: true, value: null }),
		],
		[
			"a refusal",
			() =>
				mockReadAppValue.mockResolvedValue({ ok: false, reason: "not_found" }),
		],
	] as const)("sends Cache-Control: no-store for %s", async (_label, setup) => {
		setup();
		const response = await GET(makeGetEvent());
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("sends Cache-Control: no-store even for the missing-?key= 400", async () => {
		const response = await GET(makeGetEvent("app-1", "owner-user", null));
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});
});

describe("POST /api/artifacts/[id]/app/kv", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 when there is no authenticated user", async () => {
		await expect(POST(makePostEvent("app-1", null))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockWriteAppValue).not.toHaveBeenCalled();
	});

	it("400s invalid_key for a body with no string key", async () => {
		const response = await POST(
			makePostEvent("app-1", "owner-user", { value: 1 }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ ok: false, reason: "invalid_key" });
		expect(mockWriteAppValue).not.toHaveBeenCalled();
	});

	it("400s invalid_key for an unparseable body", async () => {
		const response = await POST(
			makePostEvent("app-1", "owner-user", undefined, { unparseable: true }),
		);
		expect(response.status).toBe(400);
		expect(mockWriteAppValue).not.toHaveBeenCalled();
	});

	it("200s { ok: true } on success", async () => {
		mockWriteAppValue.mockResolvedValue({ ok: true });
		const response = await POST(makePostEvent());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it.each([
		["invalid_key", 400],
		["not_serialisable", 400],
		["too_large", 413],
		["too_many_keys", 409],
		["not_found", 404],
	] as const)("maps reason %s to status %i", async (reason, status) => {
		mockWriteAppValue.mockResolvedValue({ ok: false, reason });
		const response = await POST(makePostEvent());
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ ok: false, reason });
	});

	it("never echoes the key or the value back in a refusal body", async () => {
		mockWriteAppValue.mockResolvedValue({ ok: false, reason: "too_large" });
		const response = await POST(
			makePostEvent("app-1", "owner-user", {
				key: "secret-key",
				value: "secret-value",
			}),
		);
		const bodyText = await response.text();
		expect(bodyText).not.toContain("secret-key");
		expect(bodyText).not.toContain("secret-value");
	});

	it("passes the artifact id from the ROUTE and the key/value from the body to the service", async () => {
		mockWriteAppValue.mockResolvedValue({ ok: true });
		await POST(
			makePostEvent("app-42", "owner-user", { key: "k", value: { a: 1 } }),
		);
		expect(mockWriteAppValue).toHaveBeenCalledWith({
			userId: "owner-user",
			artifactId: "app-42",
			key: "k",
			value: { a: 1 },
			conversationId: null,
		});
	});
});
