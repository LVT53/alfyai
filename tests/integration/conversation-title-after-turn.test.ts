// The first title of a chat, end to end on real migrated SQLite and with no
// browser anywhere: the person may have clicked away before the first reply was
// done, so a turn that finishes on the server has to name its conversation by
// itself. Only the model call and the slow post-turn steps are stood in for; the
// messages, the conversation row and the write are the real ones.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { DEFAULT_CONVERSATION_TITLE } from "$lib/shared/conversation-title";

const generateTitle = vi.fn();
vi.mock("$lib/server/services/title-generator", () => ({
	generateTitle: (...args: unknown[]) => generateTitle(...args),
}));

vi.mock(
	"$lib/server/services/chat-turn/finalize-steps",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("$lib/server/services/chat-turn/finalize-steps")
		>()),
		persistAssistantTurnState: vi.fn(async () => ({
			activeWorkingSet: [],
			taskState: null,
			contextDebug: null,
			workCapsule: undefined,
		})),
		persistAssistantEvidence: vi.fn(async () => undefined),
		persistUserTurnAttachments: vi.fn(async () => undefined),
		recordAssistantTurnAnalytics: vi.fn(async () => undefined),
		runPostTurnTasks: vi.fn(async () => undefined),
	}),
);

// One real migrated file for the whole of this test file, opened by the app's own
// `db` singleton, and a conversation of its own for each test: the steps kept
// real above are imported once, so a fresh file per test would not reach them.
const dbPath = join(tmpdir(), `alfyai-title-after-turn-${randomUUID()}.db`);
process.env.DATABASE_PATH = dbPath;
const NOW = new Date("2026-11-01T10:00:00.000Z");
const OWNER = "user-owner";

function withDb<T>(use: (db: ReturnType<typeof drizzle<typeof schema>>) => T): T {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	try {
		return use(drizzle(sqlite, { schema }));
	} finally {
		sqlite.close();
	}
}

function seedConversation(title: string = DEFAULT_CONVERSATION_TITLE): string {
	const id = randomUUID();
	withDb((db) =>
		db
			.insert(schema.conversations)
			.values({ id, userId: OWNER, title, createdAt: NOW, updatedAt: NOW })
			.run(),
	);
	return id;
}

function storedTitle(id: string): string | undefined {
	return withDb(
		(db) =>
			db
				.select({ title: schema.conversations.title })
				.from(schema.conversations)
				.where(eq(schema.conversations.id, id))
				.get()?.title,
	);
}

async function finishTurn(
	conversationId: string,
	overrides: { persistTurnState?: boolean } = {},
) {
	const { finalizeChatTurn } = await import(
		"$lib/server/services/chat-turn/finalize"
	);
	await finalizeChatTurn({
		turnKind: "stream",
		responseLanguage: "en",
		userId: OWNER,
		conversationId,
		userMessageContent: "How does tidal energy work?",
		persistUserMessage: true,
		normalizedMessage: "How does tidal energy work?",
		upstreamMessage: "How does tidal energy work?",
		assistantResponse: "The tides turn a turbine.",
		assistantMetadata: { evidenceStatus: "pending" },
		attachmentIds: [],
		activeDocumentArtifactId: null,
		contextStatus: null,
		initialTaskState: null,
		initialContextDebug: null,
		analytics: null,
		assistantMirrorContent: "The tides turn a turbine.",
		maintenanceReason: "chat_stream",
		...overrides,
	});
}

beforeAll(() => {
	withDb((db) => {
		migrate(db, { migrationsFolder: "./drizzle" });
		db.insert(schema.users)
			.values({
				id: OWNER,
				email: "owner@example.com",
				passwordHash: "hash",
				uiLanguage: "hu",
				titleLanguage: "en",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	});
});

beforeEach(() => {
	generateTitle.mockReset();
	generateTitle.mockResolvedValue("Tidal Energy Basics");
});

afterAll(() => {
	try {
		unlinkSync(dbPath);
	} catch {
		// Best-effort temp DB cleanup.
	}
});

describe("a turn that ends with nobody watching", () => {
	it("names its conversation from what was stored, in the account's title language", async () => {
		const chat = seedConversation();

		await finishTurn(chat);

		await vi.waitFor(() => {
			expect(storedTitle(chat)).toBe("Tidal Energy Basics");
		});
		expect(generateTitle).toHaveBeenCalledWith(
			"How does tidal energy work?",
			"The tides turn a turbine.",
			"en",
			"hu",
			null,
		);
	});

	it("names a conversation after a stopped turn too", async () => {
		const chat = seedConversation();

		await finishTurn(chat, { persistTurnState: false });

		await vi.waitFor(() => {
			expect(storedTitle(chat)).toBe("Tidal Energy Basics");
		});
	});

	it("leaves a conversation that already has a name alone", async () => {
		const chat = seedConversation("Named by hand");

		await finishTurn(chat);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(generateTitle).not.toHaveBeenCalled();
		expect(storedTitle(chat)).toBe("Named by hand");
	});

	it("shares one model call with a page that asks at the same moment", async () => {
		const chat = seedConversation();
		const { ensureConversationTitle } = await import(
			"$lib/server/services/chat-turn/conversation-title"
		);

		await finishTurn(chat);
		const fromThePage = await ensureConversationTitle({
			userId: OWNER,
			conversationId: chat,
		});

		expect(fromThePage).toBe("Tidal Energy Basics");
		expect(generateTitle).toHaveBeenCalledTimes(1);
	});

	it("keeps a rename made while the model was working", async () => {
		const chat = seedConversation();
		let finishTitle: (title: string) => void = () => {};
		generateTitle.mockReturnValue(
			new Promise<string>((resolve) => {
				finishTitle = resolve;
			}),
		);
		const { updateConversationTitle } = await import(
			"$lib/server/services/conversations"
		);

		await finishTurn(chat);
		await vi.waitFor(() => expect(generateTitle).toHaveBeenCalled());
		await updateConversationTitle(OWNER, chat, "My own name for it");
		finishTitle("Tidal Energy Basics");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(storedTitle(chat)).toBe("My own name for it");
	});

	it("does not fail the turn when the title cannot be made", async () => {
		const chat = seedConversation();
		generateTitle.mockRejectedValue(new Error("title model down"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		await expect(finishTurn(chat)).resolves.toBeUndefined();
		await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());

		expect(storedTitle(chat)).toBe(DEFAULT_CONVERSATION_TITLE);
		consoleError.mockRestore();
	});
});
