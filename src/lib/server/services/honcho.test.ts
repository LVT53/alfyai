import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

const mocks = vi.hoisted(() => {
	const config = {
		honchoApiKey: "test-api-key",
		honchoBaseUrl: "http://honcho.test",
		honchoWorkspace: "test-workspace",
		honchoIdentityNamespace: "honcho-prune-test",
		honchoEnabled: true,
		honchoContextWaitMs: 100,
		honchoContextPollIntervalMs: 10,
		honchoPersonaContextWaitMs: 100,
		honchoOverviewWaitMs: 100,
		teiEmbedderUrl: "",
		teiEmbedderApiKey: "",
		teiEmbedderBatchSize: 8,
		teiRerankerUrl: "",
		teiRerankerApiKey: "",
		teiRerankerMaxTexts: 8,
		documentTokenBudget: 6000,
		workingSetPromptTokenBudget: 20000,
		smallFileThreshold: 256000,
		maxModelContext: 262144,
		compactionUiThreshold: 209715,
		targetConstructedContext: 157286,
		model1MaxModelContext: 262144,
		model1CompactionUiThreshold: 209715,
		model1TargetConstructedContext: 157286,
		model2MaxModelContext: 262144,
		model2CompactionUiThreshold: 209715,
		model2TargetConstructedContext: 157286,
		memoryMaintenanceIntervalMinutes: 0,
		contextDiagnosticsDebug: false,
		honchoNativeUploadEnabled: false,
	};

	/** Sessions registered via peer.sessions() — keyed by session id */
	const registeredSessions = new Map<
		string,
		{
			id: string;
			metadata: Record<string, unknown>;
			deleted: boolean;
		}
	>();

	/** Peers keyed by peer id */
	const peers = new Map<
		string,
		{
			id: string;
			sessions: () => Promise<{ toArray: () => Promise<Array<{ id: string }>> }>;
			conclusions: {
				list: () => Promise<{ toArray: () => Promise<Array<{ id: string; content: string; sessionId: string | null; createdAt: string }>> }>;
				delete: (id: string) => Promise<void>;
			};
			conclusionsOf: (target: unknown) => {
				list: () => Promise<{ toArray: () => Promise<Array<{ id: string; content: string; sessionId: string | null; createdAt: string }>> }>;
				delete: (id: string) => Promise<void>;
			};
			setCard: () => Promise<void>;
			message: (content: string, options?: { metadata?: Record<string, unknown> }) => {
				content: string;
				metadata: Record<string, unknown>;
				peerId: string;
				createdAt: string;
			};
		}
	>();

	function makeSessionList(peerId: string) {
		return async () => {
			const sessions = Array.from(registeredSessions.values()).filter(
				(s) => !s.deleted,
			);
			return {
				toArray: async () => sessions.map((s) => ({ id: s.id })),
			};
		};
	}

	function makePeer(id: string) {
		return {
			id,
			sessions: makeSessionList(id),
			conclusions: {
				list: async () => ({
					toArray: async () =>
						[] as Array<{
							id: string;
							content: string;
							sessionId: string | null;
							createdAt: string;
						}>,
				}),
				delete: async () => undefined,
			},
			conclusionsOf: () => ({
				list: async () => ({
					toArray: async () =>
						[] as Array<{
							id: string;
							content: string;
							sessionId: string | null;
							createdAt: string;
						}>,
				}),
				delete: async () => undefined,
			}),
			setCard: async () => undefined,
			message: (
				content: string,
				options?: { metadata?: Record<string, unknown> },
			) => ({
				content,
				metadata: options?.metadata ?? {},
				peerId: id,
				createdAt: new Date("2026-06-01T09:00:00.000Z").toISOString(),
			}),
		};
	}

	function getOrCreatePeer(id: string) {
		if (!peers.has(id)) {
			peers.set(id, makePeer(id));
		}
		return peers.get(id)!;
	}

	function Honcho(_opts?: unknown) {
		return {
			peer: vi.fn(async (id: string) => getOrCreatePeer(id)),
			session: vi.fn(async (id: string) => {
				const s = registeredSessions.get(id);
				return {
					id,
					setMetadata: vi.fn(async (meta: Record<string, unknown>) => {
						if (s) {
							s.metadata = meta;
						} else {
							registeredSessions.set(id, {
								id,
								metadata: meta,
								deleted: false,
							});
						}
					}),
					setPeers: vi.fn(async () => undefined),
					delete: vi.fn(async () => {
						const session = registeredSessions.get(id);
						if (session) {
							session.deleted = true;
						}
					}),
					addMessages: vi.fn(async () => undefined),
					context: vi.fn(async () => ({
						messages: [],
						summary: null,
					})),
				};
			}),
			getMetadata: vi.fn(async () => ({})),
		};
	}

	return { config, registeredSessions, peers, getOrCreatePeer, Honcho };
});

vi.mock("$lib/server/config-store", async (importActual) => {
	const actual =
		await importActual<typeof import("$lib/server/config-store")>();
	return {
		...actual,
		getConfig: () => mocks.config,
		getMaxModelContext: () => mocks.config.maxModelContext,
		getCompactionUiThreshold: () => mocks.config.compactionUiThreshold,
		getTargetConstructedContext: () => mocks.config.targetConstructedContext,
		getDocumentTokenBudget: () => mocks.config.documentTokenBudget,
		getWorkingSetPromptTokenBudget: () =>
			mocks.config.workingSetPromptTokenBudget,
		getSmallFileThreshold: () => mocks.config.smallFileThreshold,
	};
});

vi.mock("@honcho-ai/sdk", () => ({
	Honcho: mocks.Honcho,
}));

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

describe("pruneOrphanHonchoSessions", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-honcho-prune-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		mocks.config.honchoEnabled = true;
		mocks.registeredSessions.clear();
		mocks.peers.clear();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("returns zero when Honcho is disabled", async () => {
		mocks.config.honchoEnabled = false;
		const { pruneOrphanHonchoSessions } = await import("./honcho");

		const result = await pruneOrphanHonchoSessions();

		expect(result).toEqual({ deleted: 0, errors: 0 });
	});

	it("preserves sessions for existing conversations", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T09:00:00.000Z");

		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "user-1@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.insert(schema.conversations)
			.values({
				id: "conv-1",
				userId: "user-1",
				title: "Active conversation",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		// Pre-register a session that matches conv-1
		const { pruneOrphanHonchoSessions } = await import("./honcho");
		const { getHonchoSessionId } = await import("./honcho");

		const expectedSessionId = getHonchoSessionId("user-1", "conv-1", 0);
		mocks.registeredSessions.set(expectedSessionId, {
			id: expectedSessionId,
			metadata: {},
			deleted: false,
		});

		// Also register an unrelated session that does NOT match
		mocks.registeredSessions.set("orphan-session", {
			id: "orphan-session",
			metadata: {},
			deleted: false,
		});

		const result = await pruneOrphanHonchoSessions();

		expect(result.deleted).toBeGreaterThanOrEqual(1);
		expect(result.errors).toBe(0);

		// The matching session should still be present (not deleted)
		expect(mocks.registeredSessions.get(expectedSessionId)?.deleted).toBe(
			false,
		);
		// The orphan should be deleted
		expect(mocks.registeredSessions.get("orphan-session")?.deleted).toBe(true);
	});

	it("prunes legacy raw-conversation-id sessions that no longer exist", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T09:00:00.000Z");

		db.insert(schema.users)
			.values({
				id: "user-2",
				email: "user-2@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		// conv-legacy exists in SQLite
		db.insert(schema.conversations)
			.values({
				id: "conv-legacy",
				userId: "user-2",
				title: "Legacy conversation",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		// Register sessions: one matching legacy raw ID, one orphan
		mocks.registeredSessions.set("conv-legacy", {
			id: "conv-legacy",
			metadata: {},
			deleted: false,
		});
		mocks.registeredSessions.set("conv-deleted", {
			id: "conv-deleted",
			metadata: {},
			deleted: false,
		});

		const { pruneOrphanHonchoSessions } = await import("./honcho");

		const result = await pruneOrphanHonchoSessions();

		expect(result.errors).toBe(0);
		// conv-legacy should be preserved (matches existing conversation)
		expect(mocks.registeredSessions.get("conv-legacy")?.deleted).toBe(false);
		// conv-deleted should be pruned (no matching conversation)
		expect(mocks.registeredSessions.get("conv-deleted")?.deleted).toBe(true);
		expect(result.deleted).toBeGreaterThanOrEqual(1);
	});

	it("handles no users in the database gracefully", async () => {
		openSeedDatabase();

		const { pruneOrphanHonchoSessions } = await import("./honcho");

		const result = await pruneOrphanHonchoSessions();

		expect(result).toEqual({ deleted: 0, errors: 0 });
	});

	it("handles Honcho errors gracefully without crashing", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T09:00:00.000Z");

		db.insert(schema.users)
			.values({
				id: "user-err",
				email: "user-err@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.insert(schema.conversations)
			.values({
				id: "conv-err",
				userId: "user-err",
				title: "Error conversation",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		// Make peer.sessions() throw for this user
		const { getOrCreatePeer } = mocks;
		const { getHonchoUserPeerId, getHonchoAssistantPeerId } =
			await import("./honcho");

		const userPeerId = getHonchoUserPeerId("user-err", 0);
		const assistantPeerId = getHonchoAssistantPeerId("user-err", 0);

		const userPeer = getOrCreatePeer(userPeerId);
		const origUserSessions = userPeer.sessions;
		userPeer.sessions = async () => {
			throw new Error("Honcho is down");
		};

		const { pruneOrphanHonchoSessions } = await import("./honcho");

		const result = await pruneOrphanHonchoSessions();

		// Should not throw, should report errors
		expect(result.errors).toBeGreaterThanOrEqual(1);
		expect(result.deleted).toBe(0);
	});

	it("deletes zero when all sessions match existing conversations", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T09:00:00.000Z");

		db.insert(schema.users)
			.values({
				id: "user-clean",
				email: "user-clean@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		db.insert(schema.conversations)
			.values([
				{
					id: "clean-1",
					userId: "user-clean",
					title: "Clean 1",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "clean-2",
					userId: "user-clean",
					title: "Clean 2",
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();

		const { pruneOrphanHonchoSessions, getHonchoSessionId } =
			await import("./honcho");

		// Register matching sessions only
		for (const convId of ["clean-1", "clean-2"]) {
			const sid = getHonchoSessionId("user-clean", convId, 0);
			mocks.registeredSessions.set(sid, {
				id: sid,
				metadata: {},
				deleted: false,
			});
			// Also register legacy raw ID sessions
			mocks.registeredSessions.set(convId, {
				id: convId,
				metadata: {},
				deleted: false,
			});
		}

		const result = await pruneOrphanHonchoSessions();

		expect(result.deleted).toBe(0);
		expect(result.errors).toBe(0);
	});
});
