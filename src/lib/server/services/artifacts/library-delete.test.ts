import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { posterFileName } from "$lib/shared/artifacts/poster-file";
import { NOW, seedConversation, seedUser } from "./artifacts.test-helpers";

// Knowledge -> Documents' Delete of a board (FU-1). The library keeps the
// knowledge store's own delete (who may delete, what goes with a row), and a
// board's poster files, which the store cannot reach, go through the very
// function the panel's Delete calls. So the two Deletes take exactly the same
// files, and what the board's Delete leaves alone stays (a stranger's file of the
// same name, a file that hangs from a reply, another board's posters).

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact, deleteArtifact, deleteLibraryArtifact } = await import(
	"./index"
);

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const STRANGER_CONVERSATION = "conv-stranger";

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, {
		id: STRANGER_CONVERSATION,
		userId: STRANGER,
	});
	memory.db
		.insert(schema.messages)
		.values({
			id: "reply-1",
			conversationId: CONVERSATION,
			role: "assistant",
			content: "Here it is.",
			createdAt: NOW,
		})
		.run();
});

afterEach(() => {
	memory.close();
});

async function createBoard(kind: "canvas" | "document" = "canvas") {
	const created = await createArtifact({
		userId: OWNER,
		conversationId: CONVERSATION,
		kind,
		title: kind === "canvas" ? "Weekend board" : "Weekend plan",
		body: kind === "canvas" ? null : "Book the museum.",
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact;
}

const fileRow = (
	id: string,
	filename: string,
	overrides: Partial<typeof schema.chatGeneratedFiles.$inferInsert> = {},
) => ({
	id,
	conversationId: CONVERSATION,
	assistantMessageId: null,
	userId: OWNER,
	filename,
	mimeType: "image/png",
	sizeBytes: 100,
	storagePath: `${CONVERSATION}/${filename}`,
	createdAt: NOW,
	...overrides,
});

/** What a board has in its chat: its own posters, a picture of it on a reply, and the look-alikes that are not its posters. */
function seedFilesOf(boardId: string, tag: string, otherBoardId: string) {
	memory.db
		.insert(schema.chatGeneratedFiles)
		.values([
			fileRow(`${tag}poster-app`, posterFileName(boardId, "app-1")),
			fileRow(`${tag}poster-photos`, posterFileName(boardId, "photos-1")),
			// Another board's poster, in the same chat.
			fileRow(`${tag}poster-other`, posterFileName(otherBoardId, "app-1")),
			// The board's exported picture hangs from a reply: a file of the chat.
			fileRow(`${tag}export-png`, `${tag}Weekend board.png`, {
				assistantMessageId: "reply-1",
			}),
			// Somebody else's file that only looks like a poster of this board: another
			// user's chat, and a file that hangs from a reply.
			fileRow(`${tag}stranger`, posterFileName(boardId, "app-2"), {
				userId: STRANGER,
				conversationId: STRANGER_CONVERSATION,
				storagePath: `${STRANGER_CONVERSATION}/${tag}x.png`,
			}),
			fileRow(`${tag}hung`, posterFileName(boardId, "app-3"), {
				assistantMessageId: "reply-1",
			}),
		])
		.run();
}

const fileIds = () =>
	memory.db
		.select()
		.from(schema.chatGeneratedFiles)
		.all()
		.map((row) => row.id)
		.sort();

const boardRow = (id: string) =>
	memory.db
		.select()
		.from(schema.artifacts)
		.where(eq(schema.artifacts.id, id))
		.get();

describe("deleteLibraryArtifact: a board deleted from Knowledge -> Documents", () => {
	it("takes the posters of the board and leaves everything else in the chat", async () => {
		const board = await createBoard();
		const other = await createBoard();
		seedFilesOf(board.id, "", other.id);

		const result = await deleteLibraryArtifact(OWNER, board.id);

		// The store's own answer, unchanged: what the route puts on the wire.
		expect(result).toEqual({
			deletedArtifactIds: [board.id],
			deletedStoragePaths: [],
			failedStoragePaths: [],
		});
		expect(boardRow(board.id)).toBeUndefined();
		expect(fileIds()).toEqual([
			"export-png",
			"hung",
			"poster-other",
			"stranger",
		]);
		expect(boardRow(other.id)).toBeDefined();
	});

	it("takes exactly what the panel's Delete takes", async () => {
		const first = await createBoard();
		const second = await createBoard();
		const spare = await createBoard();
		seedFilesOf(first.id, "panel-", spare.id);
		seedFilesOf(second.id, "library-", spare.id);

		await expect(
			deleteArtifact({ userId: OWNER, artifactId: first.id }),
		).resolves.toEqual({ ok: true });
		await expect(
			deleteLibraryArtifact(OWNER, second.id),
		).resolves.toMatchObject({ deletedArtifactIds: [second.id] });

		const left = (tag: string) =>
			fileIds()
				.filter((id) => id.startsWith(tag))
				.map((id) => id.slice(tag.length));
		expect(left("library-")).toEqual(left("panel-"));
		// And that is not everything: the look-alikes stayed.
		expect(left("library-")).toEqual([
			"export-png",
			"hung",
			"poster-other",
			"stranger",
		]);
	});

	it("takes nothing when the library does not delete the board: another user's, or an id that is not there", async () => {
		const board = await createBoard();
		memory.db
			.insert(schema.chatGeneratedFiles)
			.values([fileRow("poster-app", posterFileName(board.id, "app-1"))])
			.run();

		await expect(deleteLibraryArtifact(STRANGER, board.id)).resolves.toBeNull();
		await expect(deleteLibraryArtifact(OWNER, "no-such-board")).resolves.toBe(
			null,
		);

		expect(fileIds()).toEqual(["poster-app"]);
		expect(boardRow(board.id)).toBeDefined();
	});

	it("does not fail the delete of the board when a poster cannot be removed", async () => {
		const board = await createBoard();
		memory.db
			.insert(schema.chatGeneratedFiles)
			.values([fileRow("poster-app", posterFileName(board.id, "app-1"))])
			.run();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// The rows go through a transaction, not `db.delete`: the first `db.delete` is the poster's.
		const failing = vi.spyOn(memory.db, "delete").mockImplementationOnce(() => {
			throw new Error("disk full");
		});

		await expect(deleteLibraryArtifact(OWNER, board.id)).resolves.toMatchObject(
			{
				deletedArtifactIds: [board.id],
			},
		);

		expect(boardRow(board.id)).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("poster files"),
			expect.anything(),
		);
		failing.mockRestore();
		warn.mockRestore();
	});

	it("goes looking for posters only for a board: a Document's id has none, whatever a file is called", async () => {
		const document = await createBoard("document");
		memory.db
			.insert(schema.chatGeneratedFiles)
			.values([fileRow("look-alike", posterFileName(document.id, "app-1"))])
			.run();

		await expect(
			deleteLibraryArtifact(OWNER, document.id),
		).resolves.toMatchObject({ deletedArtifactIds: [document.id] });

		expect(boardRow(document.id)).toBeUndefined();
		expect(fileIds()).toEqual(["look-alike"]);
	});

	it("still deletes a board whose chat is gone, as the library always did: its row is the user's, and there is no chat to take files from", async () => {
		memory.db
			.insert(schema.artifacts)
			.values({
				id: "stranded-board",
				userId: OWNER,
				conversationId: null,
				type: "artifact",
				retrievalClass: "durable",
				name: "Old board",
				metadataJson: JSON.stringify({
					artifactType: "canvas",
					title: "Old board",
				}),
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		memory.db
			.insert(schema.chatGeneratedFiles)
			.values([
				fileRow("poster-app", posterFileName("stranded-board", "app-1")),
			])
			.run();

		await expect(
			deleteLibraryArtifact(OWNER, "stranded-board"),
		).resolves.toMatchObject({ deletedArtifactIds: ["stranded-board"] });

		expect(boardRow("stranded-board")).toBeUndefined();
		// Its poster is in a chat the row no longer names, so this delete cannot say
		// whose it is; the chat's own cleanup takes it.
		expect(fileIds()).toEqual(["poster-app"]);
	});
});
