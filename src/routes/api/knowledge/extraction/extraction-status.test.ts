// GET /api/knowledge/extraction — the batch poll.
//
// Driven against a real migrated database rather than a mocked service,
// because the property under test is ownership: a mocked read model would
// happily return whatever it was told to, and the question here is whether the
// route can ever be made to ask about somebody else's artifact.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";

type StatusRoute = typeof import("./+server");
type Ledger = typeof import("$lib/server/services/extraction/job-ledger");

let fixture: LedgerFixture;
let route: StatusRoute;
let ledger: Ledger;

const OWNER = "user-owner";
const STRANGER = "user-stranger";

function makeEvent(query: string, userId: string | null) {
	return {
		locals: userId
			? { user: { id: userId, email: `${userId}@example.com` } }
			: {},
		params: {},
		url: new URL(`http://localhost/api/knowledge/extraction${query}`),
		route: { id: "/api/knowledge/extraction" },
	} as unknown as Parameters<StatusRoute["GET"]>[0];
}

beforeEach(async () => {
	fixture = createLedgerFixture("extraction-status-route");
	fixture.seedUser(OWNER);
	fixture.seedUser(STRANGER);

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	route = await import("./+server");
	ledger = await import("$lib/server/services/extraction/job-ledger");
});

afterEach(() => {
	fixture.cleanup();
});

async function enqueue(userId: string, artifactId: string, fileName: string) {
	await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName,
		mimeType: "application/pdf",
		sizeBytes: 2048,
		sourceArtifactId: artifactId,
	});
}

describe("GET /api/knowledge/extraction", () => {
	it("returns a DTO per owned artifact id, in the order asked", async () => {
		const first = fixture.seedArtifact({ userId: OWNER, name: "first.pdf" });
		const second = fixture.seedArtifact({ userId: OWNER, name: "second.pdf" });
		await enqueue(OWNER, first, "first.pdf");
		await enqueue(OWNER, second, "second.pdf");

		const response = await route.GET(
			makeEvent(`?artifactIds=${second},${first}`, OWNER),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			jobs: Array<{ sourceArtifactId: string; status: string }>;
		};

		expect(body.jobs.map((job) => job.sourceArtifactId)).toEqual([
			second,
			first,
		]);
		expect(body.jobs.every((job) => job.status === "queued")).toBe(true);
	});

	it("omits another user's artifact instead of answering for it", async () => {
		const mine = fixture.seedArtifact({ userId: OWNER, name: "mine.pdf" });
		const theirs = fixture.seedArtifact({
			userId: STRANGER,
			name: "theirs.pdf",
		});
		await enqueue(OWNER, mine, "mine.pdf");
		await enqueue(STRANGER, theirs, "theirs.pdf");

		const response = await route.GET(
			makeEvent(`?artifactIds=${mine},${theirs}`, OWNER),
		);
		const body = (await response.json()) as {
			jobs: Array<{ sourceArtifactId: string }>;
		};

		expect(body.jobs).toHaveLength(1);
		expect(body.jobs[0]?.sourceArtifactId).toBe(mine);
	});

	it("omits an id that resolves to nothing at all", async () => {
		const response = await route.GET(
			makeEvent("?artifactIds=does-not-exist", OWNER),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ jobs: [] });
	});

	it("refuses more than fifty ids", async () => {
		const ids = Array.from({ length: 51 }, (_, index) => `artifact-${index}`);
		const response = await route.GET(
			makeEvent(`?artifactIds=${ids.join(",")}`, OWNER),
		);

		expect(response.status).toBe(400);
		const body = (await response.json()) as { code: string };
		expect(body.code).toBe("too_many_artifact_ids");
	});

	it("counts ids after deduplication, so fifty distinct ids pass", async () => {
		const ids = Array.from({ length: 50 }, (_, index) => `artifact-${index}`);
		const response = await route.GET(
			makeEvent(`?artifactIds=${[...ids, ids[0]].join(",")}`, OWNER),
		);

		expect(response.status).toBe(200);
	});

	it("answers an empty list without touching the database", async () => {
		const response = await route.GET(makeEvent("", OWNER));
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ jobs: [] });
	});

	it("answers 401 when there is no session", async () => {
		const response = await route.GET(makeEvent("?artifactIds=a", null));
		expect(response.status).toBe(401);
	});
});
