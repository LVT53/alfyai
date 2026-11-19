import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	bootEngine,
	type EngineHarness,
} from "$lib/server/services/jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-api");
});
afterEach(() => h.cleanup());
function event(path: string, body?: unknown) {
	return {
		locals: { user: { id: h.userId, displayName: "Test" } },
		url: new URL(`http://localhost${path}`),
		params: {},
		request: new Request(
			`http://localhost${path}`,
			body === undefined
				? undefined
				: {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					},
		),
	};
}
async function enroll() {
	const { db } = await import("$lib/server/db");
	const s = await import("$lib/server/db/schema");
	const r = await import("$lib/server/services/memory-profile/revisions");
	r.ensureMemoryBank(h.userId, { kind: "personal" });
	db.update(s.memoryAccounts).set({ authority: "hindsight" }).run();
	return { db, s };
}
it("new page contract does not automatically enroll legacy account", async () => {
	const { GET } = await import("./+server");
	const res = await GET(
		event("/api/knowledge/memory") as Parameters<typeof GET>[0],
	);
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({
		authority: "legacy",
		rows: [],
		status: "ready",
	});
	expect(res.headers.get("Cache-Control")).toBe("no-store");
});
it("validates project scope and action bodies without a legacy mutation fallback", async () => {
	await enroll();
	const { GET } = await import("./+server");
	expect(
		(
			await GET(
				event(
					"/api/knowledge/memory?scope=project&projectId=foreign",
				) as Parameters<typeof GET>[0],
			)
		).status,
	).toBe(404);
	const { POST } = await import("./actions/+server");
	expect(
		(
			await POST(
				event("/api/knowledge/memory/actions", {
					target: "profile_item",
					action: "delete",
					itemId: "old",
					expectedProjectionRevision: 1,
				}) as Parameters<typeof POST>[0],
			)
		).status,
	).toBe(400);
});
it("returns durable owner-only action operation and allows lost-response reconciliation", async () => {
	await enroll();
	const { POST } = await import("./actions/+server");
	const requestId = randomUUID();
	const body = {
		kind: "add",
		scope: { kind: "personal" },
		text: "I paddle",
		requestId,
	};
	const response = await POST(
		event("/api/knowledge/memory/actions", body) as Parameters<typeof POST>[0],
	);
	expect(response.status).toBe(200);
	const op = await response.json();
	expect(op.status).toBe("queued");
	const { GET } = await import("./operations/+server");
	const looked = await GET(
		event(
			`/api/knowledge/memory/operations?requestId=${requestId}`,
		) as Parameters<typeof GET>[0],
	);
	expect(await looked.json()).toMatchObject({ id: op.id });
	const other = event(
		`/api/knowledge/memory/operations?requestId=${requestId}`,
	);
	other.locals.user.id = "foreign";
	expect((await GET(other as Parameters<typeof GET>[0])).status).toBe(404);
});
it("retired portrait endpoint is unavailable after cutover", async () => {
	await enroll();
	const { GET } = await import("./overview/+server");
	expect(
		(
			await GET(
				event("/api/knowledge/memory/overview") as Parameters<typeof GET>[0],
			)
		).status,
	).toBe(410);
});
it("requires authenticated user before any new Memory endpoint", async () => {
	const { GET } = await import("./+server");
	const input = { ...event("/api/knowledge/memory"), locals: { user: null } };
	await expect(GET(input as Parameters<typeof GET>[0])).rejects.toMatchObject({
		status: 302,
	});
});
