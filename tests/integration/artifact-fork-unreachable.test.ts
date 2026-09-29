// The security review's M1, end to end on real migrated SQLite: the fork of an
// incognito chat. A fork copies the parent's tool calls and never its items,
// and it inherits incognito — so the parent's Document and App EXIST while
// sitting outside the fork's reach. Before the fix the fork's cards called
// them "deleted" and Regenerate ran a full App generation only to fail at the
// write (probes P1, P2, P4). Now the detail says "unreachable" (not deleted),
// and Regenerate refuses before any model call. Containment itself — the fork
// still cannot read, list or open the parent's items — is untouched and is
// what tests/cross-cutting/incognito-artifact-containment.test.ts pins.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// A real migrated database file, opened by the app's own `db` singleton (some
// services bind it at import time, so an in-memory swap per test would not
// reach them): each test gets a fresh file and freshly imported modules.
let dbPath: string;
const NOW = new Date("2026-09-25T10:00:00.000Z");

const createAppFromBrief = vi.fn();
vi.mock("$lib/server/services/artifacts/app/create", () => ({
	createAppFromBrief: (params: unknown) => createAppFromBrief(params),
}));
vi.mock("$lib/server/services/semantic-embedding-refresh", () => ({
	queueArtifactSemanticEmbeddingRefresh: vi.fn(),
}));

async function loadServices() {
	const [artifacts, forks, detail, recreate] = await Promise.all([
		import("$lib/server/services/artifacts"),
		import("$lib/server/services/conversation-forks"),
		import("$lib/server/services/conversation-detail/read-model"),
		import("$lib/server/services/normal-chat-tools/artifact-tools/recreate"),
	]);
	return {
		createArtifact: artifacts.createArtifact,
		deleteArtifact: artifacts.deleteArtifact,
		getArtifact: artifacts.getArtifact,
		createConversationFork: forks.createConversationFork,
		getConversationDetail: detail.getConversationDetail,
		recreateArtifactFromStoredCall: recreate.recreateArtifactFromStoredCall,
	};
}
let services: Awaited<ReturnType<typeof loadServices>>;

const OWNER = "user-owner";
const PARENT = "conv-incognito-parent";
const DOC = "doc-i";
const APP = "app-x";

function createCall(
	artifactId: string,
	kind: "document" | "app",
	title: string,
	body: string,
) {
	return {
		type: "tool_call",
		callId: `call-${artifactId}`,
		name: "create_artifact",
		input: { artifactType: kind, title, body },
		status: "done",
		metadata: {
			ok: true,
			artifactId,
			artifactKind: kind,
			artifactTitle: title,
		},
	};
}

function seedUsersAndIncognitoParent(): string {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	db.insert(schema.users)
		.values({
			id: OWNER,
			email: "owner@example.com",
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: PARENT,
			userId: OWNER,
			title: "Incognito parent",
			memoryIncognito: true,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(schema.messages)
		.values([
			{
				id: "parent-user",
				conversationId: PARENT,
				messageSequence: 1,
				role: "user",
				content: "Make me a plan and a budget app.",
				createdAt: NOW,
			},
			{
				id: "parent-assistant",
				conversationId: PARENT,
				messageSequence: 2,
				role: "assistant",
				content: "Made both.",
				toolCalls: JSON.stringify([
					createCall(
						DOC,
						"document",
						"Weekend in Vienna",
						"# Weekend\n\nRest.",
					),
					createCall(APP, "app", "Trip budget", "Split the trip costs."),
				]),
				createdAt: NOW,
			},
		])
		.run();
	sqlite.close();
	return "parent-assistant";
}

async function forkTheParent(): Promise<string> {
	const sourceMessageId = seedUsersAndIncognitoParent();
	services = await loadServices();
	for (const [id, kind, title] of [
		[DOC, "document", "Weekend in Vienna"],
		[APP, "app", "Trip budget"],
	] as const) {
		const made = await services.createArtifact({
			userId: OWNER,
			conversationId: PARENT,
			kind,
			title,
			body: `${title} body`,
			id,
		});
		if (!made.ok) throw new Error(made.reason);
	}
	const fork = await services.createConversationFork({
		userId: OWNER,
		sourceConversationId: PARENT,
		sourceMessageId,
	});
	// The fork inherits incognito, so the parent is outside its reach.
	expect(fork.conversation.memoryIncognito).toBe(true);
	return fork.conversation.id;
}

function regenerateIn(conversationId: string, artifactId: string) {
	return services.recreateArtifactFromStoredCall({
		userId: OWNER,
		conversationId,
		artifactId,
		language: "en",
		abortSignal: new AbortController().signal,
	});
}

beforeEach(() => {
	dbPath = join(tmpdir(), `alfyai-fork-unreachable-${randomUUID()}.db`);
	process.env.DATABASE_PATH = dbPath;
	vi.resetModules();
	createAppFromBrief.mockReset();
});

afterEach(() => {
	try {
		unlinkSync(dbPath);
	} catch {
		// Best-effort temp DB cleanup.
	}
});

describe("the fork of an incognito chat, and the parent's items it copied the calls of", () => {
	it("says the parent's items are unreachable, not deleted, and lists none of them as its own (P4)", async () => {
		const fork = await forkTheParent();

		const detail = await services.getConversationDetail({
			userId: OWNER,
			conversationId: fork,
		});

		expect(detail?.unreachableArtifactIds?.sort()).toEqual([APP, DOC].sort());
		expect(detail?.deletedArtifactIds).toEqual([]);
		expect(detail?.artifacts).toEqual([]);
		// Containment is what it was: the fork still cannot read either.
		for (const artifactId of [DOC, APP]) {
			expect(
				await services.getArtifact({
					userId: OWNER,
					artifactId,
					conversationId: fork,
				}),
			).toBeNull();
		}
	});

	it("refuses to regenerate the parent's App before any model call, with its own reason (P1)", async () => {
		const fork = await forkTheParent();

		await expect(regenerateIn(fork, APP)).resolves.toEqual({
			ok: false,
			reason: "unreachable",
		});

		expect(createAppFromBrief).not.toHaveBeenCalled();
	});

	it("refuses to regenerate the parent's Document too, and the parent's item is untouched (P2)", async () => {
		const fork = await forkTheParent();

		await expect(regenerateIn(fork, DOC)).resolves.toEqual({
			ok: false,
			reason: "unreachable",
		});

		const parents = await services.getArtifact({
			userId: OWNER,
			artifactId: DOC,
			conversationId: PARENT,
		});
		expect(parents).toMatchObject({
			conversationId: PARENT,
			title: "Weekend in Vienna",
			versionNumber: 1,
		});
	});

	it("calls an item deleted only once it really is gone: then it reads as deleted and Regenerate works", async () => {
		const fork = await forkTheParent();
		await services.deleteArtifact({
			userId: OWNER,
			artifactId: DOC,
			conversationId: PARENT,
		});

		const detail = await services.getConversationDetail({
			userId: OWNER,
			conversationId: fork,
		});
		expect(detail?.deletedArtifactIds).toEqual([DOC]);
		expect(detail?.unreachableArtifactIds).toEqual([APP]);

		await expect(regenerateIn(fork, DOC)).resolves.toMatchObject({
			ok: true,
			created: true,
			artifactId: DOC,
		});
	});
});
