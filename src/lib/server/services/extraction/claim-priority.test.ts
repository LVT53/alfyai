import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

type Ledger = typeof import("./job-ledger");

let fixture: LedgerFixture;
let ledger: Ledger;

beforeEach(async () => {
	fixture = createLedgerFixture("claim");
	fixture.seedUser("user-1");
	fixture.seedUser("user-2");
	fixture.seedConversation("conv-1", "user-1");

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	ledger = await import("./job-ledger");
});

afterEach(() => {
	fixture.cleanup();
});

interface EnqueueOptions {
	userId?: string;
	name?: string;
	route?: "direct-text" | "mineru";
	priority?: number;
	createdAt?: Date;
	nextAttemptAt?: Date;
}

async function enqueue(options: EnqueueOptions = {}) {
	const userId = options.userId ?? "user-1";
	const name = options.name ?? `${Math.random()}.pdf`;
	const artifactId = fixture.seedArtifact({ userId, name });
	const { job } = await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: options.priority === 10 ? "generated_file_readback" : "upload",
		intakeRoute: options.route ?? "mineru",
		fileName: name,
		mimeType: null,
		sizeBytes: 16,
		sourceArtifactId: artifactId,
		priority: options.priority,
		now: options.createdAt,
	});

	if (options.nextAttemptAt) {
		fixture.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET next_attempt_at = ? WHERE id = ?",
			)
			.run(Math.floor(options.nextAttemptAt.getTime() / 1000), job.id);
	}

	return job;
}

function claim(
	input: Partial<Parameters<Ledger["claimNextExtractionJob"]>[0]> = {},
) {
	return ledger.claimNextExtractionJob({
		workerId: "worker-a",
		globalLimit: 10,
		perUserLimit: 10,
		...input,
	});
}

describe("claim ordering", () => {
	it("takes an upload before an older readback", async () => {
		const readback = await enqueue({
			name: "generated.pdf",
			priority: 10,
			createdAt: new Date("2026-09-20T08:00:00.000Z"),
		});
		const upload = await enqueue({
			name: "fresh.pdf",
			createdAt: new Date("2026-09-20T09:00:00.000Z"),
		});

		const first = await claim();
		expect(first?.job.id).toBe(upload.id);

		const second = await claim({ workerId: "worker-b" });
		expect(second?.job.id).toBe(readback.id);
	});

	it("breaks a priority tie by age", async () => {
		const older = await enqueue({
			name: "older.pdf",
			createdAt: new Date("2026-09-20T08:00:00.000Z"),
		});
		await enqueue({
			name: "newer.pdf",
			createdAt: new Date("2026-09-20T09:00:00.000Z"),
		});

		expect((await claim())?.job.id).toBe(older.id);
	});
});

describe("claim gates", () => {
	it("skips a job whose backoff has not elapsed, and takes it afterwards", async () => {
		const job = await enqueue({
			name: "backed-off.pdf",
			nextAttemptAt: new Date(Date.now() + 60_000),
		});

		expect(await claim()).toBeNull();
		expect((await claim({ now: new Date(Date.now() + 120_000) }))?.job.id).toBe(
			job.id,
		);
	});

	it("enforces the global cap", async () => {
		await enqueue({ name: "a.pdf" });
		await enqueue({ name: "b.pdf" });
		await enqueue({ name: "c.pdf" });

		expect(await claim({ globalLimit: 2 })).not.toBeNull();
		expect(
			await claim({ globalLimit: 2, workerId: "worker-b" }),
		).not.toBeNull();
		expect(await claim({ globalLimit: 2, workerId: "worker-c" })).toBeNull();
	});

	it("enforces the per-user cap while letting another user through", async () => {
		await enqueue({ userId: "user-1", name: "a.pdf" });
		await enqueue({ userId: "user-1", name: "b.pdf" });
		const other = await enqueue({ userId: "user-2", name: "c.pdf" });

		expect(await claim({ perUserLimit: 1 })).not.toBeNull();
		const second = await claim({ perUserLimit: 1, workerId: "worker-b" });
		expect(second?.job.id).toBe(other.id);
		expect(await claim({ perUserLimit: 1, workerId: "worker-c" })).toBeNull();
	});

	it("restricts to one job id when asked", async () => {
		await enqueue({
			name: "a.pdf",
			createdAt: new Date("2026-09-20T08:00:00Z"),
		});
		const wanted = await enqueue({ name: "b.pdf" });

		const claimed = await claim({ jobId: wanted.id });
		expect(claimed?.job.id).toBe(wanted.id);
	});
});

describe("directTextOnly", () => {
	it("only sees direct-text rows", async () => {
		await enqueue({ name: "scan.pdf", route: "mineru" });
		const text = await enqueue({ name: "notes.txt", route: "direct-text" });

		const claimed = await claim({ directTextOnly: true });
		expect(claimed?.job.id).toBe(text.id);
	});

	it("ignores both caps, because direct text is local CPU not a backend seat", async () => {
		// Capping it would serialise a .txt upload behind somebody's scanned PDF,
		// which is the one thing the inline path exists to avoid.
		await enqueue({ name: "a.pdf", route: "mineru" });
		await claim();

		await enqueue({ name: "a.txt", route: "direct-text" });
		await enqueue({ name: "b.txt", route: "direct-text" });

		expect(
			await claim({
				directTextOnly: true,
				globalLimit: 1,
				perUserLimit: 1,
				workerId: "worker-b",
			}),
		).not.toBeNull();
		expect(
			await claim({
				directTextOnly: true,
				globalLimit: 1,
				perUserLimit: 1,
				workerId: "worker-c",
			}),
		).not.toBeNull();
	});
});
