import { afterEach, beforeEach, expect, it } from "vitest";
import {
	bootEngine,
	type EngineHarness,
} from "$lib/server/services/jobs/testing/harness";
import { seedSubjectEntries } from "$lib/server/services/memory-profile/subject-read.test-helpers";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-overview-api");
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

async function seed() {
	await seedSubjectEntries(h.userId, { kind: "personal" }, [
		{
			id: "a",
			text: "Speaks three languages.",
			said: new Date().toISOString(),
			kind: "lasting",
			subject: "about_you",
		},
	]);
}

it("says no Overview is written yet, with the count it would be written from", async () => {
	await seed();
	const { GET } = await import("./+server");
	const res = await GET(
		event("/api/knowledge/memory/scope-overview?scope=personal") as never,
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("cache-control")).toBe("no-store");
	expect(await res.json()).toEqual({
		state: "none",
		currentCount: 1,
		text: null,
		writtenFrom: null,
		writtenAt: null,
	});
});

it("refuses to write an Overview of an empty scope", async () => {
	const { POST } = await import("./+server");
	const res = await POST(
		event("/api/knowledge/memory/scope-overview?scope=personal", {
			rewrite: false,
		}) as never,
	);
	expect(res.status).toBe(409);
	expect(await res.json()).toEqual({ error: "overview_empty" });
});

it("answers 503 without a word of why when the model cannot write it", async () => {
	await seed();
	const { POST } = await import("./+server");
	// No memory model is configured in the test environment.
	const res = await POST(
		event("/api/knowledge/memory/scope-overview?scope=personal", {
			rewrite: true,
		}) as never,
	);
	expect(res.status).toBe(503);
	expect(await res.json()).toEqual({ error: "overview_unavailable" });
});
