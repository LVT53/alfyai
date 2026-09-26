// Integration coverage for the App kind (Feature 2 · Artifacts, Slice 2, Task
// A10): the user-data guarantees that do not have a more specific home
// already. Incognito containment for the App's three readers (the served
// route, the kv route, the export path) lives in
// tests/cross-cutting/incognito-artifact-containment.test.ts, reusing the
// established seedIncognitoArtifactFamily() pattern rather than a second,
// parallel one here; the App-specific archive assertions (its own html
// escaped inert, its verification note as a comment) live in
// account-data-archive/index.test.ts, next to the generic version Slice 0
// already wrote. This file owns the two guarantees that are genuinely new:
// full erasure leaves zero rows, and Clear Memory deletes the App artifact
// while an exported `.html` chat file (a separate generated_output row)
// survives it.
import { eq } from "drizzle-orm";
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

const { createArtifact, deleteArtifact, setKv, createComment } = await import(
	"$lib/server/services/artifacts"
);

const OWNER = "user-owner";
const CONVERSATION = "conv-1";

async function createApp() {
	const result = await createArtifact({
		userId: OWNER,
		conversationId: CONVERSATION,
		kind: "app",
		title: "Trip cost splitter",
		body: "<!doctype html><title>Split</title>",
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact;
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
});

afterEach(() => {
	memory.close();
});

describe("full erasure of an App", () => {
	it("removes the artifact, its versions, comments and key-value rows — zero survivors", async () => {
		const app = await createApp();
		await setKv({
			userId: OWNER,
			artifactId: app.id,
			key: "expenses",
			valueJson: "[42]",
		});
		await createComment({
			userId: OWNER,
			artifactId: app.id,
			anchor: { kind: "node", nodeId: "app" },
			author: "user",
			body: "Nice app!",
		});

		const deleted = await deleteArtifact({ userId: OWNER, artifactId: app.id });

		expect(deleted).toBe(true);
		expect(
			memory.db
				.select()
				.from(schema.artifacts)
				.where(eq(schema.artifacts.id, app.id))
				.all(),
		).toEqual([]);
		expect(
			memory.db
				.select()
				.from(schema.artifactVersions)
				.where(eq(schema.artifactVersions.artifactId, app.id))
				.all(),
		).toEqual([]);
		expect(
			memory.db
				.select()
				.from(schema.artifactComments)
				.where(eq(schema.artifactComments.artifactId, app.id))
				.all(),
		).toEqual([]);
		expect(
			memory.db
				.select()
				.from(schema.artifactKv)
				.where(eq(schema.artifactKv.artifactId, app.id))
				.all(),
		).toEqual([]);
	});
});

describe("Clear Memory and an App", () => {
	it("deletes the App artifact and its stored data, but keeps an exported .html file (a generated_output row)", async () => {
		const app = await createApp();
		await setKv({
			userId: OWNER,
			artifactId: app.id,
			key: "expenses",
			valueJson: "[42]",
		});

		// The exported .html file this App's download route would have produced
		// through produce_file: a SEPARATE row, type generated_output (ruling
		// 18) — never re-typed to "artifact" even though it came from an App.
		const exportedFileId = "exported-app-html";
		memory.db
			.insert(schema.artifacts)
			.values({
				id: exportedFileId,
				userId: OWNER,
				conversationId: CONVERSATION,
				type: "generated_output",
				retrievalClass: "durable",
				name: "Trip cost splitter — app source.html",
				contentText: "<!doctype html><title>Split</title>",
				metadataJson: JSON.stringify({ generatedFile: true }),
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		const { clearMemoryAndKnowledgeForUser } = await import(
			"$lib/server/services/account-lifecycle"
		);
		const deletedIds = await clearMemoryAndKnowledgeForUser(OWNER);

		// The App artifact (type "artifact") is gone …
		expect(deletedIds).toContain(app.id);
		expect(
			memory.db
				.select()
				.from(schema.artifacts)
				.where(eq(schema.artifacts.id, app.id))
				.all(),
		).toEqual([]);
		expect(
			memory.db
				.select()
				.from(schema.artifactKv)
				.where(eq(schema.artifactKv.artifactId, app.id))
				.all(),
		).toEqual([]);

		// … but the exported file (generated_output) survives, exactly like any
		// other download (decisions.md ruling 42).
		expect(deletedIds).not.toContain(exportedFileId);
		const survivor = memory.db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, exportedFileId))
			.all();
		expect(survivor).toHaveLength(1);
		expect(survivor[0]?.type).toBe("generated_output");
	});
});
