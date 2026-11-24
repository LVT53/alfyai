import { afterEach, beforeEach, expect, it } from "vitest";
import {
	bootEngine,
	type EngineHarness,
} from "$lib/server/services/jobs/testing/harness";
import { seedSubjectEntries } from "$lib/server/services/memory-profile/subject-read.test-helpers";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-subjects-api");
});
afterEach(() => h.cleanup());

function event(path: string, params: Record<string, string> = {}) {
	return {
		locals: { user: { id: h.userId, displayName: "Test" } },
		url: new URL(`http://localhost${path}`),
		params,
		request: new Request(`http://localhost${path}`),
	};
}

it("answers the subject index of the person's own scope", async () => {
	await seedSubjectEntries(h.userId, { kind: "personal" }, [
		{
			id: "a",
			text: "Speaks three languages.",
			said: new Date().toISOString(),
			kind: "lasting",
			subject: "about_you",
		},
	]);
	const { GET } = await import("./+server");
	const res = await GET(
		event("/api/knowledge/memory/subjects?scope=personal") as never,
	);
	expect(res.status).toBe(200);
	expect(res.headers.get("cache-control")).toBe("no-store");
	expect(await res.json()).toMatchObject({
		subjects: [{ subject: "about_you", count: 1 }],
	});
});

it("refuses another person's project", async () => {
	const { GET } = await import("./+server");
	const res = await GET(
		event(
			"/api/knowledge/memory/subjects?scope=project&projectId=not-theirs",
		) as never,
	);
	expect(res.status).toBe(404);
});

it("refuses a state it does not know and a subject the bank kind does not have", async () => {
	const { GET } = await import("./[subject]/+server");
	const unknownState = await GET(
		event("/api/knowledge/memory/subjects/about_you?state=stale", {
			subject: "about_you",
		}) as never,
	);
	expect(unknownState.status).toBe(400);
	expect(await unknownState.json()).toEqual({ error: "invalid_state" });
	const unknownSubject = await GET(
		event("/api/knowledge/memory/subjects/plans_status?scope=personal", {
			subject: "plans_status",
		}) as never,
	);
	expect(unknownSubject.status).toBe(400);
	expect(await unknownSubject.json()).toEqual({ error: "invalid_subject" });
});
