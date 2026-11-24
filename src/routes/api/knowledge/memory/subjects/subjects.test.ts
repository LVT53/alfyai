import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	bootEngine,
	type EngineHarness,
} from "$lib/server/services/jobs/testing/harness";
import { seedSubjectEntries } from "$lib/server/services/memory-profile/subject-read.test-helpers";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-subjects-api");
});
afterEach(() => {
	vi.doUnmock("$lib/server/services/memory");
	vi.restoreAllMocks();
	h.cleanup();
});

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

// A read that fails for a reason the person is not told answers 503 and leaves
// one content-free line: the error's kind and code, never its message, which
// can quote a row's or a model's text (as the Overview's route does).
it("logs a content-free line, and answers 503, when a subject read fails unexpectedly", async () => {
	const secret = "a remembered sentence the database quoted";
	const fails = () => {
		throw Object.assign(new Error(secret), { code: "SQLITE_BUSY" });
	};
	vi.doMock("$lib/server/services/memory", async (importOriginal) => ({
		...(await importOriginal<typeof import("$lib/server/services/memory")>()),
		readMemorySubjectIndex: fails,
		listMemorySubject: fails,
	}));
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const index = await import("./+server");
	const subject = await import("./[subject]/+server");
	const first = await index.GET(
		event("/api/knowledge/memory/subjects?scope=personal") as never,
	);
	const second = await subject.GET(
		event("/api/knowledge/memory/subjects/about_you?scope=personal", {
			subject: "about_you",
		}) as never,
	);
	for (const res of [first, second]) {
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "memory_unavailable" });
	}
	expect(logged.mock.calls).toEqual([
		[
			"[KNOWLEDGE_MEMORY] Subject index unavailable",
			{ error: "Error", code: "SQLITE_BUSY" },
		],
		[
			"[KNOWLEDGE_MEMORY] Subject entries unavailable",
			{ error: "Error", code: "SQLITE_BUSY" },
		],
	]);
	expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
});

it("logs nothing for a refusal the person is told of", async () => {
	const logged = vi.spyOn(console, "error").mockImplementation(() => {});
	const { GET } = await import("./+server");
	const res = await GET(
		event(
			"/api/knowledge/memory/subjects?scope=project&projectId=not-theirs",
		) as never,
	);
	expect(res.status).toBe(404);
	expect(logged).not.toHaveBeenCalled();
});
