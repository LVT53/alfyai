import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRequestError } from "$lib/server/services/memory-profile/memory-request";
import { GET, POST } from "./+server";

const api = vi.hoisted(() => ({
	getMemoryQuarantine: vi.fn(),
	startMemoryQuarantine: vi.fn(),
	resolveMemoryQuarantineCandidate: vi.fn(),
	retryMemoryQuarantineApproval: vi.fn(),
}));
vi.mock("$lib/server/services/memory-profile/quarantine", () => api);

function event(body?: unknown, authenticated = true) {
	const url = new URL("http://localhost/api/knowledge/memory/quarantine");
	return {
		locals: authenticated ? { user: { id: "authenticated-owner" } } : {},
		request: new Request(
			url,
			body === undefined
				? undefined
				: { method: "POST", body: JSON.stringify(body) },
		),
		url,
	} as Parameters<typeof POST>[0];
}
const result = { status: "pending", candidates: [] };
beforeEach(() => {
	vi.resetAllMocks();
	for (const method of Object.values(api)) method.mockResolvedValue(result);
});

it("serves only the authenticated owner's uncached review and explicitly starts it", async () => {
	const response = await GET(event());
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual(result);
	expect(api.getMemoryQuarantine).toHaveBeenCalledWith("authenticated-owner");
	expect(api.startMemoryQuarantine).not.toHaveBeenCalled();

	const started = await POST(event({ action: "start", requestId: "start-1" }));
	expect(started.status).toBe(200);
	expect(api.startMemoryQuarantine).toHaveBeenCalledWith(
		"authenticated-owner",
		{ requestId: "start-1" },
	);
});

it("uses authenticated scope and rejects edited text when discarding", async () => {
	const valid = {
		action: "resolve",
		requestId: "req-1",
		id: "draft",
		decision: "keep",
		text: "edited",
	};
	const response = await POST(
		event({ ...valid, userId: "other-owner", scope: { kind: "personal" } }),
	);
	expect(response.status).toBe(200);
	expect(api.resolveMemoryQuarantineCandidate).toHaveBeenCalledExactlyOnceWith(
		"authenticated-owner",
		{ requestId: "req-1", id: "draft", decision: "keep", text: "edited" },
	);
	const bad = await POST(event({ ...valid, decision: "discard" }));
	expect(bad.status).toBe(400);
	expect(api.resolveMemoryQuarantineCandidate).toHaveBeenCalledTimes(1);
});

it("reports a stale candidate without returning storage or server details", async () => {
	api.resolveMemoryQuarantineCandidate.mockRejectedValue(
		new MemoryRequestError("stale_memory", 409),
	);
	const response = await POST(
		event({
			action: "resolve",
			requestId: "remove-1",
			id: "draft",
			decision: "discard",
		}),
	);
	expect(response.status).toBe(409);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(await response.json()).toEqual({ error: "stale_memory" });
});

it("requires a signed-in account before reading suggestions or recording consent", async () => {
	const read = event(undefined, false);
	await expect(GET(read)).rejects.toMatchObject({
		status: 302,
		location: "/login",
	});
	const write = event({ action: "start", requestId: "start-1" }, false);
	await expect(POST(write)).rejects.toMatchObject({
		status: 302,
		location: "/login",
	});
	expect(api.getMemoryQuarantine).not.toHaveBeenCalled();
	expect(api.startMemoryQuarantine).not.toHaveBeenCalled();
});

it("retries an existing approval by id within the signed-in account", async () => {
	const response = await POST(
		event({ action: "retry", id: "approval-1", userId: "elsewhere" }),
	);
	expect(response.status).toBe(200);
	expect(api.retryMemoryQuarantineApproval).toHaveBeenCalledExactlyOnceWith(
		"authenticated-owner",
		{ id: "approval-1" },
	);
	expect(api.resolveMemoryQuarantineCandidate).not.toHaveBeenCalled();
});
