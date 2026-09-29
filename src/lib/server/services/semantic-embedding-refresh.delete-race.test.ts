// The security review's L4: an embedding refresh that races a delete must not
// write a vector for a subject that is gone. A refresh awaits a TEI call — real
// I/O — between reading its subject and writing the vector; a delete that lands
// in that gap removes the row and its vector, and the refresh then wrote one
// back for a deleted id. Regenerate makes an item again under the SAME id, so
// the stale vector would have attached to the new item. Real migrated SQLite;
// the TEI call is the one deferred thing, so the race is deterministic.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("$lib/server/config-store", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/config-store")>();
	return {
		...actual,
		getConfig: () => ({ ...actual.getConfig(), teiEmbedderModel: "bge-m3" }),
	};
});

// The TEI call, held open until the test lets it answer.
let answerEmbedding: (vectors: number[][] | null) => void = () => {};
const embedTexts = vi.fn(
	() =>
		new Promise<number[][] | null>((resolve) => {
			answerEmbedding = resolve;
		}),
);
vi.mock("./tei-embedder", () => ({
	canUseTeiEmbedder: () => true,
	embedTexts: (...args: unknown[]) =>
		(embedTexts as (...a: unknown[]) => unknown)(...args),
	getTeiEmbedderBatchSize: () => 8,
}));

const { createArtifact, deleteArtifact } = await import(
	"$lib/server/services/artifacts"
);
const {
	backfillSemanticEmbeddingsForUser,
	queueArtifactSemanticEmbeddingRefresh,
	queueTaskStateSemanticEmbeddingRefresh,
} = await import("./semantic-embedding-refresh");

const OWNER = "user-owner";
const CONVERSATION = "conv-1";

function vectorsFor(subjectType: string, subjectId: string) {
	return memory.db
		.select()
		.from(schema.semanticEmbeddings)
		.where(
			and(
				eq(schema.semanticEmbeddings.subjectType, subjectType),
				eq(schema.semanticEmbeddings.subjectId, subjectId),
			),
		)
		.all();
}

async function makeDocument() {
	const made = await createArtifact({
		userId: OWNER,
		conversationId: CONVERSATION,
		kind: "document",
		title: "Weekend in Vienna",
		body: "Museum in the morning, the Naschmarkt after.",
	});
	if (!made.ok) throw new Error(made.reason);
	return made.artifact;
}

/** Lets everything already settled run: the store is a synchronous driver, so a macrotask is a full drain. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
	memory = createInMemoryDatabase();
	embedTexts.mockClear();
	seedUser(memory, OWNER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
});

afterEach(() => {
	memory.close();
});

describe("an embedding refresh that races a delete", () => {
	it("writes no vector for an artifact deleted while its embedding was being fetched", async () => {
		const artifact = await makeDocument();

		const refresh = backfillSemanticEmbeddingsForUser(OWNER);
		await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledTimes(1));
		// The delete lands in the gap: the row goes, and so does any vector.
		await deleteArtifact({ userId: OWNER, artifactId: artifact.id });
		answerEmbedding([[0.1, 0.2, 0.3]]);
		const counts = await refresh;

		expect(vectorsFor("artifact", artifact.id)).toEqual([]);
		// Nothing was written, so nothing is counted as refreshed.
		expect(counts.artifactCount).toBe(0);
	});

	it("writes no vector when the queued refresh a save started loses the same race", async () => {
		const artifact = await makeDocument();
		const [row] = memory.db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifact.id))
			.all();

		queueArtifactSemanticEmbeddingRefresh(row as never);
		await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledTimes(1));
		await deleteArtifact({ userId: OWNER, artifactId: artifact.id });
		answerEmbedding([[0.1, 0.2, 0.3]]);
		await flush();

		expect(vectorsFor("artifact", artifact.id)).toEqual([]);
	});

	it("still writes the vector when nothing was deleted (the check does not get in the way)", async () => {
		const artifact = await makeDocument();

		const refresh = backfillSemanticEmbeddingsForUser(OWNER);
		await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledTimes(1));
		answerEmbedding([[0.1, 0.2, 0.3]]);
		const counts = await refresh;

		expect(vectorsFor("artifact", artifact.id)).toHaveLength(1);
		expect(counts.artifactCount).toBe(1);
	});

	it("keeps only the survivors of a batch: the deleted artifact gets none, the other still does", async () => {
		const doomed = await makeDocument();
		const kept = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "document",
			title: "Packing list",
			body: "Socks, a charger, the good umbrella.",
		});
		if (!kept.ok) throw new Error(kept.reason);

		const refresh = backfillSemanticEmbeddingsForUser(OWNER);
		await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledTimes(1));
		await deleteArtifact({ userId: OWNER, artifactId: doomed.id });
		answerEmbedding([
			[0.1, 0.2],
			[0.3, 0.4],
		]);
		await refresh;

		expect(vectorsFor("artifact", doomed.id)).toEqual([]);
		expect(vectorsFor("artifact", kept.artifact.id)).toHaveLength(1);
	});

	it("holds for a task state too: a conversation deleted mid-refresh takes its task state, and no vector is left", async () => {
		memory.db
			.insert(schema.conversationTaskStates)
			.values({
				taskId: "task-1",
				userId: OWNER,
				conversationId: CONVERSATION,
				objective: "Plan the weekend",
			})
			.run();

		queueTaskStateSemanticEmbeddingRefresh({
			taskId: "task-1",
			userId: OWNER,
			objective: "Plan the weekend",
			constraints: [],
			factsToPreserve: [],
			decisions: [],
			openQuestions: [],
			nextSteps: [],
		} as never);
		await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledTimes(1));
		memory.db
			.delete(schema.conversations)
			.where(eq(schema.conversations.id, CONVERSATION))
			.run();
		answerEmbedding([[0.1, 0.2, 0.3]]);
		await flush();

		expect(vectorsFor("task_state", "task-1")).toEqual([]);
	});
});
