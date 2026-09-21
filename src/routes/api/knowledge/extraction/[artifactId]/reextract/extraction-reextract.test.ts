// POST (and GET) /api/knowledge/extraction/[artifactId]/reextract.
//
// Real database, like the Retry route's test: the interesting cases are "not
// yours", "already running" and "that tier does not exist here", and the first
// two are decided by rows rather than by the route's branching. The capability
// probe is the one mock — it is the only thing here that would otherwise open
// a socket.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";

const { probe } = vi.hoisted(() => ({
	probe: {
		tiers: ["flash", "basic"] as string[],
		error: null as { code: string; message: string } | null,
	},
}));

vi.mock("$lib/server/services/mineru/capabilities", () => ({
	getMineruCapabilities: async () => {
		if (probe.error) {
			const error = new Error(probe.error.message) as Error & { code: string };
			error.code = probe.error.code;
			throw error;
		}
		return { version: "4.0.4", outputFormats: ["zip"], tiers: probe.tiers };
	},
}));

const { wake } = vi.hoisted(() => ({ wake: vi.fn() }));

// The façade reaches the worker through a lazy `import("./worker-runner")`, so
// stubbing that module is enough to observe the wake without letting a timer
// loose in a test process. Deliberately NOT an `importOriginal` mock of the
// façade: that keeps one resolved copy of the ledger alive across
// `vi.resetModules()`, and every case after the first would then read the
// previous case's database.
vi.mock("$lib/server/services/extraction/worker-runner", () => ({
	wakeExtractionWorker: wake,
}));

type Route = typeof import("./+server");
type Ledger = typeof import("$lib/server/services/extraction/job-ledger");

let fixture: LedgerFixture;
let route: Route;
let ledger: Ledger;

const OWNER = "user-owner";
const STRANGER = "user-stranger";
/**
 * Mirrors `MAX_ACTIVE_REEXTRACTIONS_PER_USER`. Restated rather than imported:
 * `reextract.ts` pulls in `$lib/server/db`, which opens a database at import
 * time, and this file has to seed one and point `DATABASE_PATH` at it first.
 * The `limit` assertion below fails loudly if the two ever drift.
 */
const REEXTRACT_LIMIT = 5;
const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

function makeEvent(
	artifactId: string,
	userId: string | null,
	body?: unknown,
): Parameters<Route["POST"]>[0] {
	return {
		locals: userId
			? { user: { id: userId, email: `${userId}@example.com` } }
			: {},
		params: { artifactId },
		request: {
			json: async () => {
				if (body === undefined) throw new Error("no body");
				return body;
			},
		},
		url: new URL(
			`http://localhost/api/knowledge/extraction/${artifactId}/reextract`,
		),
		route: { id: "/api/knowledge/extraction/[artifactId]/reextract" },
	} as unknown as Parameters<Route["POST"]>[0];
}

beforeEach(async () => {
	probe.tiers = ["flash", "basic"];
	probe.error = null;
	wake.mockClear();

	fixture = createLedgerFixture("extraction-reextract-route");
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

async function enqueueSucceeded(
	userId: string,
	artifactId: string,
	intakeRoute: "mineru" | "direct-text" = "mineru",
) {
	const normalizedArtifactId = fixture.seedArtifact({
		userId,
		type: "normalized_document",
		name: "sample.md",
	});
	fixture.seedNormalizedLink({
		userId,
		normalizedArtifactId,
		sourceArtifactId: artifactId,
	});
	return ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute,
		fileName: "sample.pdf",
		mimeType: "application/pdf",
		sizeBytes: 2048,
		sourceArtifactId: artifactId,
		normalizedArtifactId,
	});
}

function jobRow(jobId: string) {
	return fixture.sqlite
		.prepare("SELECT * FROM document_extraction_jobs WHERE id = ?")
		.get(jobId) as {
		status: string;
		hints_json: string | null;
		remote_handle_json: string | null;
		attempt_count: number;
	};
}

describe("POST /api/knowledge/extraction/[artifactId]/reextract", () => {
	it("requeues a SUCCEEDED job with the tier as a validated ledger hint", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		const { job } = await enqueueSucceeded(OWNER, artifactId);
		// A handle from the parse that just finished — it must not survive into
		// an attempt that is supposed to submit fresh at a new tier.
		fixture.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET remote_handle_json = ? WHERE id = ?",
			)
			.run(
				'{"extractor":"mineru4","version":1,"remoteJobId":"job_old"}',
				job.id,
			);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { job: { status: string } };
		expect(body.job.status).toBe("queued");

		const row = jobRow(job.id);
		expect(row.status).toBe("queued");
		// `reextract: true` is what the per-user cap counts; the ledger itself
		// never reads either key.
		expect(JSON.parse(row.hints_json ?? "null")).toEqual({
			tier: "basic",
			reextract: true,
		});
		expect(row.remote_handle_json).toBeNull();
		// The façade wakes the worker through a lazy import, so the call lands a
		// microtask after the response.
		await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
	});

	it("refuses a tier that is not higher than the recorded one, before any job write", async () => {
		// The component disabled these menu items; nothing stopped a direct
		// POST. Accepting it would overwrite a `standard` parse — text, chunks
		// and bundle — with a `flash` one, and the job would report success.
		probe.tiers = ["flash", "basic", "standard"];
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			metadata: { extractionTier: "standard" },
		});
		const { job } = await enqueueSucceeded(OWNER, artifactId);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "flash" }),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			code: string;
			currentTier: string;
		};
		expect(body.code).toBe("tier_not_higher");
		expect(body.currentTier).toBe("standard");

		expect(jobRow(job.id).status).toBe("succeeded");
		expect(jobRow(job.id).hints_json).toBeNull();
		expect(wake).not.toHaveBeenCalled();
	});

	it("refuses the tier the document is already at", async () => {
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			metadata: { extractionTier: "basic" },
		});
		const { job } = await enqueueSucceeded(OWNER, artifactId);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(400);
		expect((await response.json()).code).toBe("tier_not_higher");
		expect(jobRow(job.id).status).toBe("succeeded");
	});

	it("accepts a lower tier when an operator forces it", async () => {
		// Not a UI affordance: `force` exists for an operator re-reading a
		// document after an OCR-mode change or a MinerU upgrade.
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			metadata: { extractionTier: "basic" },
		});
		const { job } = await enqueueSucceeded(OWNER, artifactId);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "flash", force: true }),
		);
		expect(response.status).toBe(200);
		expect(jobRow(job.id).status).toBe("queued");
		expect(JSON.parse(jobRow(job.id).hints_json ?? "null")).toMatchObject({
			tier: "flash",
		});
	});

	it("treats a document with no recorded tier as below every tier", async () => {
		// D12: a pre-Phase-4 document is exactly what this action exists for,
		// and it must not be locked out by a tier it never recorded.
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		const { job } = await enqueueSucceeded(OWNER, artifactId);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "flash" }),
		);
		expect(response.status).toBe(200);
		expect(jobRow(job.id).status).toBe("queued");
	});

	it("refuses a tier the server does not offer, before any job write", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		const { job } = await enqueueSucceeded(OWNER, artifactId);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "standard" }),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { code: string; tiers: string[] };
		expect(body.code).toBe("tier_unavailable");
		expect(body.tiers).toEqual(["flash", "basic"]);

		expect(jobRow(job.id).status).toBe("succeeded");
		expect(jobRow(job.id).hints_json).toBeNull();
		expect(wake).not.toHaveBeenCalled();
	});

	it("refuses a tier that is not a tier at all", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		const { job } = await enqueueSucceeded(OWNER, artifactId);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "; DROP TABLE artifacts" }),
		);
		expect(response.status).toBe(400);
		expect((await response.json()).code).toBe("tier_unavailable");
		expect(jobRow(job.id).status).toBe("succeeded");
	});

	it("answers 503 when the backend cannot be asked what it serves", async () => {
		probe.error = { code: "unavailable", message: "connection refused" };
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		const { job } = await enqueueSucceeded(OWNER, artifactId);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(503);
		expect((await response.json()).code).toBe("unavailable");
		expect(jobRow(job.id).status).toBe("succeeded");
	});

	it("refuses another user's document with the same 404 as an unknown id", async () => {
		const theirs = fixture.seedArtifact({ userId: STRANGER });
		await enqueueSucceeded(STRANGER, theirs);

		const owned = await route.POST(makeEvent(theirs, OWNER, { tier: "basic" }));
		const unknown = await route.POST(
			makeEvent("no-such-artifact", OWNER, { tier: "basic" }),
		);

		expect(owned.status).toBe(404);
		expect(unknown.status).toBe(404);
		expect(await owned.json()).toEqual(await unknown.json());
	});

	it("refuses a stranger's document before it looks at the body", async () => {
		const theirs = fixture.seedArtifact({ userId: STRANGER });
		await enqueueSucceeded(STRANGER, theirs);

		// A malformed body from someone who does not own the artifact must still
		// read as "no such artifact", not as "bad tier".
		const response = await route.POST(makeEvent(theirs, OWNER, { tier: 7 }));
		expect(response.status).toBe(404);
	});

	it("refuses a direct-text document: it has no tiers to choose between", async () => {
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			name: "notes.txt",
		});
		await enqueueSucceeded(OWNER, artifactId, "direct-text");

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(404);
	});

	it("refuses while a job for the artifact is still running", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		await ledger.enqueueExtractionJob({
			userId: OWNER,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "sample.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2048,
			sourceArtifactId: artifactId,
		});

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("extraction_job_active");
	});

	it("caps how many re-extractions one user may have in flight", async () => {
		// The per-document guards bound one file. Nothing bounded a library:
		// fifty rows and fifty clicks is fifty parses queued on a backend that
		// serves one job at a time.
		const queued: string[] = [];
		for (let index = 0; index < REEXTRACT_LIMIT; index++) {
			const artifactId = fixture.seedArtifact({ userId: OWNER });
			const { job } = await enqueueSucceeded(OWNER, artifactId);
			const response = await route.POST(
				makeEvent(artifactId, OWNER, { tier: "basic" }),
			);
			expect(response.status).toBe(200);
			queued.push(job.id);
		}
		for (const jobId of queued) {
			expect(jobRow(jobId).status).toBe("queued");
			expect(JSON.parse(jobRow(jobId).hints_json ?? "null")).toEqual({
				tier: "basic",
				reextract: true,
			});
		}

		const oneMore = fixture.seedArtifact({ userId: OWNER });
		const { job: refused } = await enqueueSucceeded(OWNER, oneMore);
		const response = await route.POST(
			makeEvent(oneMore, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBeTruthy();
		const body = (await response.json()) as { code: string; limit: number };
		expect(body.code).toBe("reextract_limit");
		expect(body.limit).toBe(REEXTRACT_LIMIT);
		expect(jobRow(refused.id).status).toBe("succeeded");

		// Another user is unaffected: the cap is per account, not global.
		const theirs = fixture.seedArtifact({ userId: STRANGER });
		await enqueueSucceeded(STRANGER, theirs);
		const stranger = await route.POST(
			makeEvent(theirs, STRANGER, { tier: "basic" }),
		);
		expect(stranger.status).toBe(200);
	});

	it("does not count an upload's queued job against the re-extract cap", async () => {
		// Only jobs that CAME FROM Re-extract hold a seat. A library that is
		// still uploading must not lock the action out.
		for (let index = 0; index < REEXTRACT_LIMIT + 2; index++) {
			await ledger.enqueueExtractionJob({
				userId: OWNER,
				conversationId: null,
				origin: "upload",
				intakeRoute: "mineru",
				fileName: `upload-${index}.pdf`,
				mimeType: "application/pdf",
				sizeBytes: 2048,
				sourceArtifactId: fixture.seedArtifact({ userId: OWNER }),
			});
		}

		const artifactId = fixture.seedArtifact({ userId: OWNER });
		await enqueueSucceeded(OWNER, artifactId);
		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(200);
	});

	it("frees a seat when a re-extraction finishes", async () => {
		const jobIds: string[] = [];
		for (let index = 0; index < REEXTRACT_LIMIT; index++) {
			const artifactId = fixture.seedArtifact({ userId: OWNER });
			const { job } = await enqueueSucceeded(OWNER, artifactId);
			await route.POST(makeEvent(artifactId, OWNER, { tier: "basic" }));
			jobIds.push(job.id);
		}
		fixture.sqlite
			.prepare("UPDATE document_extraction_jobs SET status = ? WHERE id = ?")
			.run("succeeded", jobIds[0]);

		const artifactId = fixture.seedArtifact({ userId: OWNER });
		await enqueueSucceeded(OWNER, artifactId);
		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(200);
	});

	it("refuses past the total-attempt ceiling, exactly as Retry does", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		const { job } = await enqueueSucceeded(OWNER, artifactId);
		fixture.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET attempt_count = ? WHERE id = ?",
			)
			.run(99, job.id);

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("max_attempts");
	});

	it("materialises a row for a pre-ledger document before requeuing it", async () => {
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			name: "ancient.pdf",
			createdAt: LONG_AGO,
		});
		const normalizedArtifactId = fixture.seedArtifact({
			userId: OWNER,
			type: "normalized_document",
			name: "ancient.md",
			createdAt: LONG_AGO,
		});
		fixture.seedNormalizedLink({
			userId: OWNER,
			normalizedArtifactId,
			sourceArtifactId: artifactId,
		});

		const response = await route.POST(
			makeEvent(artifactId, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(200);

		const row = fixture.sqlite
			.prepare(
				"SELECT * FROM document_extraction_jobs WHERE source_artifact_id = ?",
			)
			.get(artifactId) as { status: string; hints_json: string };
		expect(row.status).toBe("queued");
		expect(JSON.parse(row.hints_json)).toEqual({
			tier: "basic",
			reextract: true,
		});
	});

	it("does not materialise a row for a stranger's pre-ledger document", async () => {
		const theirs = fixture.seedArtifact({
			userId: STRANGER,
			name: "ancient.pdf",
			createdAt: LONG_AGO,
		});

		const response = await route.POST(
			makeEvent(theirs, OWNER, { tier: "basic" }),
		);
		expect(response.status).toBe(404);

		const count = fixture.sqlite
			.prepare("SELECT COUNT(*) as count FROM document_extraction_jobs")
			.get() as { count: number };
		expect(count.count).toBe(0);
	});

	it("requires a session", async () => {
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		await enqueueSucceeded(OWNER, artifactId);
		const response = await route.POST(
			makeEvent(artifactId, null, { tier: "basic" }),
		);
		expect(response.status).toBe(401);
	});
});

describe("GET /api/knowledge/extraction/[artifactId]/reextract", () => {
	it("lists the tiers the server serves for an owned document", async () => {
		probe.tiers = ["flash", "basic", "standard"];
		const artifactId = fixture.seedArtifact({ userId: OWNER });
		await enqueueSucceeded(OWNER, artifactId);

		const response = await route.GET(makeEvent(artifactId, OWNER));
		expect(response.status).toBe(200);
		expect((await response.json()).tiers).toEqual([
			"flash",
			"basic",
			"standard",
		]);
	});

	it("offers only tiers strictly above the one the document already has", async () => {
		probe.tiers = ["flash", "basic", "standard", "advanced"];
		const artifactId = fixture.seedArtifact({
			userId: OWNER,
			metadata: { extractionTier: "basic" },
		});
		await enqueueSucceeded(OWNER, artifactId);

		const response = await route.GET(makeEvent(artifactId, OWNER));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			tiers: string[];
			currentTier: string | null;
		};
		// A menu that listed `flash` or `basic` would be offering a 400.
		expect(body.tiers).toEqual(["standard", "advanced"]);
		expect(body.currentTier).toBe("basic");
	});

	it("gives another user's document the ownership 404", async () => {
		const theirs = fixture.seedArtifact({ userId: STRANGER });
		await enqueueSucceeded(STRANGER, theirs);

		const response = await route.GET(makeEvent(theirs, OWNER));
		expect(response.status).toBe(404);
	});
});
