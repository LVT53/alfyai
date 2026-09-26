import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { parseDocument } from "$lib/shared/artifact-document/blocks";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedConversationAndMessage(params: {
	content: string;
	role?: "user" | "assistant";
	metadata?: Record<string, unknown>;
}) {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-09-25T09:00:00.000Z");

	db.insert(schema.users)
		.values({
			id: "route-owner",
			email: "route-owner@example.com",
			passwordHash: "h",
		})
		.run();
	db.insert(schema.users)
		.values({
			id: "route-stranger",
			email: "route-stranger@example.com",
			passwordHash: "h",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "route-conversation",
			userId: "route-owner",
			title: "Vienna trip",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "route-assistant",
			conversationId: "route-conversation",
			messageSequence: 2,
			role: params.role ?? "assistant",
			content: params.content,
			metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
			createdAt: now,
		})
		.run();

	sqlite.close();
}

async function postDocument(): Promise<{
	status: number;
	body: Record<string, unknown>;
}> {
	const { POST } = await import("./+server");
	const response = await POST({
		params: { id: "route-conversation", messageId: "route-assistant" },
		locals: { user: { id: "route-owner" } },
	} as unknown as Parameters<typeof POST>[0]);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function rawContentText(artifactId: string): string {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const row = db
		.select({ contentText: schema.artifacts.contentText })
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, artifactId))
		.get();
	sqlite.close();
	return row?.contentText ?? "";
}

describe("POST /api/conversations/[id]/messages/[messageId]/document", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-keep-as-document-route-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort temp DB cleanup.
		}
	});

	it("creates a Document from the message's visible text", async () => {
		seedConversationAndMessage({
			content: "# Vienna\n\nMuseum in the morning.\n\n- [ ] Book tickets",
		});

		const response = await postDocument();

		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({
			ok: true,
			created: true,
			title: "Vienna",
		});
		const artifactId = response.body.artifactId as string;
		const stored = rawContentText(artifactId);
		expect(stored).not.toContain("<thinking>");
		const parsed = parseDocument(stored, { mint: false });
		expect(parsed.blocks.length).toBeGreaterThan(0);
		expect(parsed.blocks.every((b) => b.id.length > 0)).toBe(true);
	});

	it("is idempotent: asking twice opens the same artifact, not a second one", async () => {
		seedConversationAndMessage({ content: "A plan for Saturday." });

		const first = await postDocument();
		const second = await postDocument();

		expect(first.body.artifactId).toBe(second.body.artifactId);
		expect(first.body.created).toBe(true);
		expect(second.body.created).toBe(false);
	});

	it("answers not_found for an empty message", async () => {
		seedConversationAndMessage({ content: "" });

		const response = await postDocument();

		expect(response).toMatchObject({
			status: 404,
			body: { ok: false, reason: "not_found" },
		});
	});

	it("answers not_found for a message that is only a tool call (empty visible content)", async () => {
		seedConversationAndMessage({ content: "   " });

		const response = await postDocument();

		expect(response.status).toBe(404);
	});

	it("answers not_found for a user message", async () => {
		seedConversationAndMessage({
			content: "Write it up for me.",
			role: "user",
		});

		const response = await postDocument();

		expect(response.status).toBe(404);
	});

	it("answers not_found for another user's conversation", async () => {
		seedConversationAndMessage({ content: "Some text." });
		const { POST } = await import("./+server");

		const response = await POST({
			params: { id: "route-conversation", messageId: "route-assistant" },
			locals: { user: { id: "route-stranger" } },
		} as unknown as Parameters<typeof POST>[0]);

		expect(response.status).toBe(404);
	});

	// RV-1A: red before its fix (docs/plans/claude-at-home-2/review-1a.md).
	it("titles the Document with its first line's text, not its Markdown", async () => {
		seedConversationAndMessage({
			content: "**Weekend plan** for *Vienna*\n\n- [ ] Book tickets",
		});

		const response = await postDocument();

		expect(response.body).toMatchObject({
			ok: true,
			title: "Weekend plan for Vienna",
		});
	});
});
