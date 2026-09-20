// POST /api/knowledge/extraction/[artifactId]/cancel.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";

type CancelRoute = typeof import("./+server");
type Ledger = typeof import("$lib/server/services/extraction/job-ledger");
type ReadModel = typeof import("$lib/server/services/extraction/read-model");

let fixture: LedgerFixture;
let route: CancelRoute;
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
			`http://localhost/api/knowledge/extraction/${artifactId}/cancel`,
		),
		route: { id: "/api/knowledge/extraction/[artifactId]/cancel" },
	} as unknown as Parameters<CancelRoute["POST"]>[0];
}

beforeEach(async () => {
	fixture = createLedgerFixture("extraction-cancel-route");
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

async function enqueueQueued(userId: string, artifactId: string) {
	await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: "slow.pdf",
		mimeType: "application/pdf",
		sizeBytes: 2048,
		sourceArtifactId: artifactId,
	});
}

describe("POST /api/knowledge/extraction/[artifactId]/cancel", () => {
	it("cancels a queued job", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER, name: "slow.pdf" });
		await enqueueQueued(OWNER, artifactId);

		const response = await route.POST(makeEvent(artifactId, OWNER));
		expect(response.status).toBe(200);

		const body = (await response.json()) as {
			job: { status: string; cancelable: boolean };
		};
		expect(body.job.status).toBe("canceled");
		expect(body.job.cancelable).toBe(false);
	});

	it("refuses another user's job and leaves it running", async () => {
		const theirs = fixture.seedArtifact({ userId: STRANGER });
		await enqueueQueued(STRANGER, theirs);

		const response = await route.POST(makeEvent(theirs, OWNER));
		expect(response.status).toBe(404);
		const body = (await response.json()) as { code: string };
		expect(body.code).toBe("extraction_job_not_cancelable");

		const [dto] = await readModel.getExtractionJobsForArtifacts({
			userId: STRANGER,
			artifactIds: [theirs],
		});
		expect(dto.status).toBe("queued");
	});

	it("refuses a job that already reached a terminal status", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		await enqueueQueued(OWNER, artifactId);
		await route.POST(makeEvent(artifactId, OWNER));

		const second = await route.POST(makeEvent(artifactId, OWNER));
		expect(second.status).toBe(404);
	});

	it("refuses a synthesised legacy row, which has no worker to stop", async () => {
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			createdAt: LONG_AGO,
		});

		const response = await route.POST(makeEvent(artifactId, OWNER));
		expect(response.status).toBe(404);
	});

	it("answers 401 when there is no session", async () => {
		const response = await route.POST(makeEvent("artifact-1", null));
		expect(response.status).toBe(401);
	});
});
