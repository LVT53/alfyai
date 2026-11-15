// @vitest-environment node
//
// GET /api/images/takes/[takeId]/events: the take's end over SSE. Ownership
// first (another person's take is a 404), the stream's headers, one `settled`
// event when the take settles, and then the stream ends. A take that has
// already settled answers at once. A migrated database file and the job engine.

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	createImageFixture,
	type ImageFixture,
} from "$lib/server/services/images/testing/fixture";
import { insertTake } from "$lib/server/services/images/testing/takes";
import { warmModules } from "$lib/server/testing/warm-modules";

let fixture: ImageFixture;

beforeAll(async () => {
	await warmModules([
		() => import("./+server"),
		() => import("$lib/server/services/images/image-job"),
		() => import("$lib/server/services/jobs"),
	]);
}, 30_000);

beforeEach(() => {
	fixture = createImageFixture("image-take-events");
	fixture.seedUser("u1");
	fixture.seedUser("u2");
	fixture.seedConversation("c1", "u1");
	fixture.seedCard({ id: "card-1", userId: "u1", conversationId: "c1" });
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterEach(async () => {
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
		resetJobsForTests();
	} catch {
		// The engine was never imported.
	}
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The database module was never imported.
	}
	fixture.cleanup();
	vi.restoreAllMocks();
});

const base = { userId: "u1", conversationId: "c1", cardId: "card-1" };

function event(takeId: string, userId: string | null, query = "") {
	const url = new URL(
		`http://localhost/api/images/takes/${takeId}/events${query}`,
	);
	return {
		params: { takeId },
		url,
		locals: {
			user: userId ? { id: userId, role: "user" } : undefined,
		},
		request: new Request(url),
	} as never;
}

/** The route's answer, or the status of the refusal it threw. */
async function call(run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		return new Response(null, { status: (error as { status: number }).status });
	}
}

/** The stream's whole text, read to its end. */
function readToEnd(response: Response): Promise<string> {
	return new Response(response.body).text();
}

describe("GET /api/images/takes/[takeId]/events", () => {
	it("answers 401 without a session and 404 for a take the caller does not own", async () => {
		const { GET } = await import("./+server");
		const takeId = await insertTake({ ...base, status: "queued" });

		expect((await call(() => GET(event(takeId, null)))).status).toBe(401);
		expect((await call(() => GET(event(takeId, "u2")))).status).toBe(404);
		expect((await call(() => GET(event("no-such-take", "u1")))).status).toBe(
			404,
		);
		expect(
			(await call(() => GET(event(takeId, "u1", "?conversationId=c2")))).status,
		).toBe(404);
	});

	it("streams a settle as one settled event and then ends", async () => {
		const { GET } = await import("./+server");
		const takeId = await insertTake({ ...base, status: "queued" });

		const response = await call(() => GET(event(takeId, "u1")));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.headers.get("cache-control")).toContain("no-cache");
		expect(response.headers.get("cache-control")).toContain("no-transform");

		const text = readToEnd(response);
		const { cancel } = await import("$lib/server/services/jobs");
		const { imageJob } = await import("$lib/server/services/images/image-job");
		await cancel(imageJob, takeId, { userId: "u1" });

		const body = await text;
		expect(body).toContain("event: settled");
		expect(body).toContain(`"takeId":"${takeId}"`);
		expect(body).toContain('"status":"cancelled"');
		expect(body).toContain("event: close");
	});

	it("answers at once for a take that has already settled", async () => {
		const { GET } = await import("./+server");
		const takeId = await insertTake({ ...base, status: "failed" });

		const response = await call(() => GET(event(takeId, "u1")));
		expect(response.status).toBe(200);

		const body = await readToEnd(response);
		expect(body).toContain("event: settled");
		expect(body).toContain('"status":"failed"');
		expect(body).toContain("event: close");
	});
});
