// GET /api/knowledge/extraction — the batch poll.
//
// Driven against a real migrated database rather than a mocked service,
// because the property under test is ownership: a mocked read model would
// happily return whatever it was told to, and the question here is whether the
// route can ever be made to ask about somebody else's artifact.
//
// The response is a contract for the client poller: `jobs` is the lifecycle
// truth, and `readiness` is the content verdict for terminal success only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";

type StatusRoute = typeof import("./+server");
type Ledger = typeof import("$lib/server/services/extraction/extraction-job");

const readinessCalls = vi.hoisted(() => [] as string[][]);

// Records readiness reads and delegates to the real authority, so a test can
// prove the route does NOT make an extra DB read when nothing succeeded. The
// actual module is loaded at CALL time: each test gets a fresh database through
// `vi.resetModules()`, while this factory's result outlives that reset.
vi.mock("$lib/server/services/knowledge/readiness", async () => {
	const loadActual = () =>
		vi.importActual<typeof import("$lib/server/services/knowledge/readiness")>(
			"$lib/server/services/knowledge/readiness",
		);

	const actual = await loadActual();
	return {
		...actual,
		readAttachmentReadinessSnapshots: async (
			userId: string,
			artifactIds: string[],
		) => {
			readinessCalls.push(artifactIds);
			const current = await loadActual();
			return current.readAttachmentReadinessSnapshots(userId, artifactIds);
		},
	};
});

let fixture: LedgerFixture;
let route: StatusRoute;
let ledger: Ledger;

const OWNER = "user-owner";
const STRANGER = "user-stranger";

/** Passes `hasMeaningfulAttachmentText`; `Tiny.` does not. */
const READY_TEXT =
	"Quarterly revenue grew by twelve percent across every region this year.";
const THIN_TEXT = "Tiny.";

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
	readinessCalls.length = 0;

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	route = await import("./+server");
	ledger = await import("$lib/server/services/extraction/extraction-job");
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

/** Puts the queued job in a settled state the way the engine leaves it. */
function settleJobStatus(
	sourceArtifactId: string,
	status: "succeeded" | "failed",
) {
	fixture.sqlite
		.prepare(
			"UPDATE document_extraction_jobs SET status = ? WHERE source_artifact_id = ?",
		)
		.run(status, sourceArtifactId);
}

function seedNormalized(
	userId: string,
	sourceArtifactId: string,
	contentText: string,
): string {
	const normalizedId = fixture.seedArtifact({
		userId,
		type: "normalized_document",
		name: "document.md",
		contentText,
	});
	fixture.seedNormalizedLink({
		userId,
		normalizedArtifactId: normalizedId,
		sourceArtifactId,
	});
	return normalizedId;
}

async function seedSucceededJob(
	userId: string,
	contentText: string | null,
): Promise<{ sourceId: string; normalizedId: string | null }> {
	const sourceId = fixture.seedArtifact({ userId, name: "document.pdf" });
	await enqueue(userId, sourceId, "document.pdf");
	const normalizedId =
		contentText === null ? null : seedNormalized(userId, sourceId, contentText);
	settleJobStatus(sourceId, "succeeded");
	return { sourceId, normalizedId };
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
			readiness: unknown[];
		};

		expect(body.jobs.map((job) => job.sourceArtifactId)).toEqual([
			second,
			first,
		]);
		expect(body.jobs.every((job) => job.status === "queued")).toBe(true);
		// Queued is not terminal success: no content verdict is owed, so no
		// readiness read is made at all.
		expect(body.readiness).toEqual([]);
		expect(readinessCalls).toEqual([]);
	});

	it("answers readiness for a succeeded job with meaningful normalized text", async () => {
		const { sourceId, normalizedId } = await seedSucceededJob(
			OWNER,
			READY_TEXT,
		);

		const response = await route.GET(
			makeEvent(`?artifactIds=${sourceId}`, OWNER),
		);
		const body = (await response.json()) as {
			jobs: Array<{ status: string }>;
			readiness: Array<{
				artifactId: string;
				promptReady: boolean;
				promptArtifactId: string | null;
				readinessError: string | null;
				readinessErrorCode: string | null;
			}>;
		};

		expect(body.jobs[0]?.status).toBe("succeeded");
		expect(body.readiness).toEqual([
			{
				artifactId: sourceId,
				promptReady: true,
				promptArtifactId: normalizedId,
				readinessError: null,
				readinessErrorCode: null,
			},
		]);
		expect(readinessCalls).toEqual([[sourceId]]);
	});

	it("reports no_usable_text for a succeeded job whose normalized text is thin", async () => {
		const { sourceId } = await seedSucceededJob(OWNER, THIN_TEXT);

		const response = await route.GET(
			makeEvent(`?artifactIds=${sourceId}`, OWNER),
		);
		const body = (await response.json()) as {
			readiness: Array<{
				artifactId: string;
				promptReady: boolean;
				promptArtifactId: string | null;
				readinessError: string | null;
				readinessErrorCode: string | null;
			}>;
		};

		expect(body.readiness).toHaveLength(1);
		expect(body.readiness[0]).toMatchObject({
			artifactId: sourceId,
			promptReady: false,
			promptArtifactId: null,
			readinessErrorCode: "no_usable_text",
		});
		expect(body.readiness[0]?.readinessError).toBeTruthy();
	});

	it("reports not_prepared for a succeeded job with no normalized document", async () => {
		const { sourceId } = await seedSucceededJob(OWNER, null);

		const response = await route.GET(
			makeEvent(`?artifactIds=${sourceId}`, OWNER),
		);
		const body = (await response.json()) as {
			readiness: Array<{
				artifactId: string;
				promptReady: boolean;
				promptArtifactId: string | null;
				readinessErrorCode: string | null;
			}>;
		};

		expect(body.readiness).toEqual([
			{
				artifactId: sourceId,
				promptReady: false,
				promptArtifactId: null,
				readinessError: expect.stringContaining("could not be prepared"),
				readinessErrorCode: "not_prepared",
			},
		]);
	});

	it("keeps failed jobs out of readiness", async () => {
		const sourceId = fixture.seedArtifact({ userId: OWNER, name: "bad.pdf" });
		await enqueue(OWNER, sourceId, "bad.pdf");
		settleJobStatus(sourceId, "failed");

		const response = await route.GET(
			makeEvent(`?artifactIds=${sourceId}`, OWNER),
		);
		const body = (await response.json()) as {
			jobs: Array<{ status: string }>;
			readiness: unknown[];
		};

		expect(body.jobs[0]?.status).toBe("failed");
		expect(body.readiness).toEqual([]);
		expect(readinessCalls).toEqual([]);
	});

	it.each([
		["queued", null],
		[
			"active",
			"UPDATE document_extraction_jobs SET status = 'running', phase = 'parsing' WHERE source_artifact_id = ?",
		],
		[
			"failed",
			"UPDATE document_extraction_jobs SET status = 'failed' WHERE source_artifact_id = ?",
		],
		[
			"canceled",
			"UPDATE document_extraction_jobs SET status = 'cancelled' WHERE source_artifact_id = ?",
		],
	])("reads no readiness for a %s job", async (_label, update) => {
		const sourceId = fixture.seedArtifact({ userId: OWNER, name: "doc.pdf" });
		await enqueue(OWNER, sourceId, "doc.pdf");
		if (update) fixture.sqlite.prepare(update).run(sourceId);

		const response = await route.GET(
			makeEvent(`?artifactIds=${sourceId}`, OWNER),
		);
		const body = (await response.json()) as {
			jobs: Array<{ status: string }>;
			readiness: unknown[];
		};

		expect(body.jobs).toHaveLength(1);
		expect(body.jobs[0]?.status).not.toBe("succeeded");
		expect(body.readiness).toEqual([]);
		expect(readinessCalls).toEqual([]);
	});

	it("asks readiness only about the succeeded jobs in a mixed batch", async () => {
		const { sourceId: succeededId } = await seedSucceededJob(OWNER, READY_TEXT);
		const queuedId = fixture.seedArtifact({
			userId: OWNER,
			name: "queued.pdf",
		});
		await enqueue(OWNER, queuedId, "queued.pdf");

		const response = await route.GET(
			makeEvent(`?artifactIds=${queuedId},${succeededId}`, OWNER),
		);
		const body = (await response.json()) as {
			jobs: Array<{ sourceArtifactId: string }>;
			readiness: Array<{ artifactId: string }>;
		};

		expect(body.jobs.map((job) => job.sourceArtifactId)).toEqual([
			queuedId,
			succeededId,
		]);
		expect(body.readiness.map((snapshot) => snapshot.artifactId)).toEqual([
			succeededId,
		]);
		expect(readinessCalls).toEqual([[succeededId]]);
	});

	it("omits another user's artifact instead of answering for it", async () => {
		const mine = fixture.seedArtifact({ userId: OWNER, name: "mine.pdf" });
		await enqueue(OWNER, mine, "mine.pdf");
		const { sourceId: theirs } = await seedSucceededJob(STRANGER, READY_TEXT);

		const response = await route.GET(
			makeEvent(`?artifactIds=${mine},${theirs}`, OWNER),
		);
		const body = (await response.json()) as {
			jobs: Array<{ sourceArtifactId: string }>;
			readiness: Array<{ artifactId: string }>;
		};

		expect(body.jobs).toHaveLength(1);
		expect(body.jobs[0]?.sourceArtifactId).toBe(mine);
		expect(body.readiness).toEqual([]);
		expect(readinessCalls).toEqual([]);
	});

	it("omits an id that resolves to nothing at all", async () => {
		const response = await route.GET(
			makeEvent("?artifactIds=does-not-exist", OWNER),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			jobs: [],
			readiness: [],
		});
	});

	it("answers a readiness-read failure with the jobs and an empty verdict list", async () => {
		const { sourceId } = await seedSucceededJob(OWNER, READY_TEXT);
		// Make the CONTENT read itself fail. The job lifecycle read does not
		// touch this table, but the readiness batch does, so this is the one
		// failure the route must absorb without losing the jobs.
		fixture.sqlite.exec("DROP TABLE artifact_links");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			const response = await route.GET(
				makeEvent(`?artifactIds=${sourceId}`, OWNER),
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				jobs: Array<{ sourceArtifactId: string; status: string }>;
				readiness: unknown[];
			};
			// Job lifecycle polling must keep working even when the content
			// verdict cannot be read.
			expect(body.jobs).toHaveLength(1);
			expect(body.jobs[0]).toMatchObject({
				sourceArtifactId: sourceId,
				status: "succeeded",
			});
			expect(body.readiness).toEqual([]);
			expect(warn).toHaveBeenCalledWith(
				"[EXTRACTION] Readiness lookup failed",
				expect.anything(),
			);
		} finally {
			warn.mockRestore();
		}
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
		await expect(response.json()).resolves.toEqual({
			jobs: [],
			readiness: [],
		});
	});

	it("answers 401 when there is no session", async () => {
		const response = await route.GET(makeEvent("?artifactIds=a", null));
		expect(response.status).toBe(401);
	});
});
