// POST /api/knowledge/extraction/[artifactId]/retry.
//
// Real database, for the same reason the batch poll's test uses one: the
// interesting cases are "not yours" and "not retryable", and both are decided
// by rows rather than by the route's own branching.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";

type RetryRoute = typeof import("./+server");
type Ledger = typeof import("$lib/server/services/extraction/job-ledger");
type ReadModel = typeof import("$lib/server/services/extraction/read-model");

let fixture: LedgerFixture;
let route: RetryRoute;
let ledger: Ledger;
let readModel: ReadModel;

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

function makeEvent(artifactId: string, userId: string | null) {
	return {
		locals: userId
			? { user: { id: userId, email: `${userId}@example.com` } }
			: {},
		params: { artifactId },
		url: new URL(
			`http://localhost/api/knowledge/extraction/${artifactId}/retry`,
		),
		route: { id: "/api/knowledge/extraction/[artifactId]/retry" },
	} as unknown as Parameters<RetryRoute["POST"]>[0];
}

beforeEach(async () => {
	fixture = createLedgerFixture("extraction-retry-route");
	fixture.seedUser(OWNER);
	fixture.seedUser(STRANGER);

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	route = await import("./+server");
	ledger = await import("$lib/server/services/extraction/job-ledger");
	readModel = await import("$lib/server/services/extraction/read-model");
});

afterEach(() => {
	fixture.cleanup();
});

async function enqueueFailed(userId: string, artifactId: string) {
	await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: "broken.pdf",
		mimeType: "application/pdf",
		sizeBytes: 2048,
		sourceArtifactId: artifactId,
		failure: {
			errorCode: "max_attempts",
			errorMessage: "Gave up after three attempts.",
			retryable: true,
		},
	});
}

describe("POST /api/knowledge/extraction/[artifactId]/retry", () => {
	it("requeues a failed, retryable job and clears its error", async () => {
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			name: "broken.pdf",
		});
		await enqueueFailed(OWNER, artifactId);

		const response = await route.POST(makeEvent(artifactId, OWNER));
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			job: { status: string; error: unknown; retryable: boolean };
		};
		expect(body.job.status).toBe("queued");
		expect(body.job.error).toBeNull();
		expect(body.job.retryable).toBe(false);
	});

	it("refuses another user's failed job with the same 404 as an unknown id", async () => {
		const theirs = fixture.seedArtifact({
			userId: STRANGER,
			name: "theirs.pdf",
		});
		await enqueueFailed(STRANGER, theirs);

		const owned = await route.POST(makeEvent(theirs, OWNER));
		const unknown = await route.POST(makeEvent("no-such-artifact", OWNER));

		expect(owned.status).toBe(404);
		expect(unknown.status).toBe(404);
		expect(await owned.json()).toEqual(await unknown.json());

		// And the stranger's row is untouched.
		const [theirDto] = await readModel.getExtractionJobsForArtifacts({
			userId: STRANGER,
			artifactIds: [theirs],
		});
		expect(theirDto.status).toBe("failed");
	});

	it("refuses a job that is not retryable", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		await ledger.enqueueExtractionJob({
			userId: OWNER,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "queued.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1,
			sourceArtifactId: artifactId,
		});

		const response = await route.POST(makeEvent(artifactId, OWNER));
		expect(response.status).toBe(404);
		const body = (await response.json()) as { code: string };
		expect(body.code).toBe("extraction_job_not_found");
	});

	it("materialises a row for a pre-ledger artifact before retrying it", async () => {
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			name: "ancient.pdf",
			createdAt: LONG_AGO,
		});

		// Nothing has ever been written for this artifact: the read model
		// synthesises a `legacy_unknown` failure for it.
		const [before] = await readModel.getExtractionJobsForArtifacts({
			userId: OWNER,
			artifactIds: [artifactId],
		});
		expect(before.legacy).toBe(true);
		expect(before.error?.code).toBe("legacy_unknown");

		const response = await route.POST(makeEvent(artifactId, OWNER));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			job: { id: string; status: string; legacy: boolean };
		};
		expect(body.job.status).toBe("queued");
		expect(body.job.legacy).toBe(false);
		expect(body.job.id).not.toBe(before.id);

		const row = await ledger.getExtractionJobRow(body.job.id);
		expect(row?.userId).toBe(OWNER);
		expect(row?.sourceArtifactId).toBe(artifactId);
	});

	it("does not materialise a row for a stranger's pre-ledger artifact", async () => {
		const theirs = fixture.seedArtifact({
			userId: STRANGER,
			name: "ancient.pdf",
			createdAt: LONG_AGO,
		});

		const response = await route.POST(makeEvent(theirs, OWNER));
		expect(response.status).toBe(404);

		const count = fixture.sqlite
			.prepare("SELECT COUNT(*) as count FROM document_extraction_jobs")
			.get() as { count: number };
		expect(count.count).toBe(0);
	});

	it("answers 401 when there is no session", async () => {
		const response = await route.POST(makeEvent("artifact-1", null));
		expect(response.status).toBe(401);
	});
});
