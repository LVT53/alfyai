/**
 * `createArtifact` commits the artifact row and only then writes its chunks.
 * When the chunk write throws, the row used to stay: an artifact with zero
 * chunks, whose full `contentText` is still what the prompt pipeline reads
 * and whose embedding refresh never runs. Retrieval silently has nothing to
 * retrieve from.
 *
 * The chunk writer is mocked here on purpose — this pins `createArtifact`'s
 * own cleanup, independently of why the write failed. The real failure mode
 * it protects against (a document over ~4.8 MB exceeding SQLite's bound
 * variable limit) is fixed and covered in `task-state/chunk-sync.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const syncArtifactChunksMock = vi.fn();
vi.mock("$lib/server/services/task-state/chunk-sync", () => ({
	syncArtifactChunks: (...args: unknown[]) => syncArtifactChunksMock(...args),
}));

const queueEmbeddingRefreshMock = vi.fn();
vi.mock("$lib/server/services/semantic-embedding-refresh", () => ({
	queueArtifactSemanticEmbeddingRefresh: (...args: unknown[]) =>
		queueEmbeddingRefreshMock(...args),
}));

const { createArtifact } = await import("./core");

const USER = "user-1";
const NOW = new Date("2026-09-20T10:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	syncArtifactChunksMock.mockResolvedValue(undefined);
	memory = createInMemoryDatabase();
	memory.db
		.insert(schema.users)
		.values({
			id: USER,
			email: `${USER}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
});

afterEach(() => {
	memory.close();
});

function storedArtifactIds(): string[] {
	return memory.db
		.select({ id: schema.artifacts.id })
		.from(schema.artifacts)
		.all()
		.map((row) => row.id);
}

describe("createArtifact", () => {
	it("returns the stored artifact when chunk sync succeeds", async () => {
		const artifact = await createArtifact({
			userId: USER,
			type: "source_document",
			name: "notes.txt",
			contentText: "body",
		});

		expect(storedArtifactIds()).toEqual([artifact.id]);
		expect(syncArtifactChunksMock).toHaveBeenCalledWith(
			expect.objectContaining({ artifactId: artifact.id, userId: USER }),
		);
		expect(queueEmbeddingRefreshMock).toHaveBeenCalledTimes(1);
	});

	it("removes the artifact row when chunk sync throws, and rethrows", async () => {
		const failure = new Error("too many SQL variables");
		syncArtifactChunksMock.mockRejectedValueOnce(failure);
		const id = randomUUID();

		await expect(
			createArtifact({
				id,
				userId: USER,
				type: "source_document",
				name: "ledger.log",
				contentText: "body",
			}),
		).rejects.toThrow("too many SQL variables");

		expect(storedArtifactIds()).toEqual([]);
		// No half-made artifact means nothing to embed either.
		expect(queueEmbeddingRefreshMock).not.toHaveBeenCalled();
	});

	it("leaves artifacts it did not create alone when one fails", async () => {
		const first = await createArtifact({
			userId: USER,
			type: "source_document",
			name: "kept.txt",
			contentText: "body",
		});

		syncArtifactChunksMock.mockRejectedValueOnce(new Error("boom"));
		await expect(
			createArtifact({
				userId: USER,
				type: "source_document",
				name: "dropped.txt",
				contentText: "body",
			}),
		).rejects.toThrow("boom");

		expect(storedArtifactIds()).toEqual([first.id]);
	});
});
