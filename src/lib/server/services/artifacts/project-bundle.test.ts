import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	NOW,
	seedConversation,
	seedProducedFile,
	seedUser,
} from "./artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact, deleteArtifact, listProjectBundle } = await import(
	"./index"
);
const { linkProjectKnowledge, listProjectKnowledge, unlinkProjectKnowledge } =
	await import("$lib/server/services/knowledge");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const TRIP = "project-trip";
const OTHER_TRIP = "project-other";

/** A chat of the owner's, in a project or out of every one, with a title a row can quote. */
function seedChat(
	id: string,
	options: {
		projectId?: string | null;
		title: string;
		userId?: string;
		memoryIncognito?: boolean;
	},
): void {
	seedConversation(memory, {
		id,
		userId: options.userId ?? OWNER,
		memoryIncognito: options.memoryIncognito,
	});
	memory.sqlite
		.prepare("UPDATE conversations SET title = ?, project_id = ? WHERE id = ?")
		.run(options.title, options.projectId ?? null, id);
}

async function make(
	conversationId: string,
	kind: "document" | "app" | "canvas" | "slides",
	title: string,
	userId = OWNER,
): Promise<string> {
	const result = await createArtifact({
		userId,
		conversationId,
		kind,
		title,
		body:
			kind === "canvas"
				? JSON.stringify({ nodes: [], edges: [] })
				: `${title} body`,
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact.id;
}

/** An uploaded library document, the ordinary thing a project knows about. */
function seedUploadedFile(id: string, name: string, userId = OWNER): void {
	memory.db
		.insert(schema.artifacts)
		.values({
			id,
			userId,
			type: "source_document",
			retrievalClass: "durable",
			name,
			mimeType: "application/pdf",
			sizeBytes: 1024,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	memory.db
		.insert(schema.projects)
		.values([
			{
				id: TRIP,
				userId: OWNER,
				name: "Vienna trip",
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: OTHER_TRIP,
				userId: STRANGER,
				name: "Someone else's trip",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
});

afterEach(() => {
	memory.close();
});

describe("a project's bundle lists what its chats made", () => {
	it("lists the Documents, Apps and Canvases its chats made, ordered by name with its files", async () => {
		seedChat("chat-plan", { projectId: TRIP, title: "Saturday plan" });
		seedChat("chat-money", { projectId: TRIP, title: "Budget" });
		await make("chat-plan", "document", "Saturday plan");
		await make("chat-money", "app", "Trip cost splitter");
		await make("chat-plan", "canvas", "Vienna trip board");
		seedUploadedFile("file-hotel", "Hotel Motto booking.pdf");
		await linkProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
			artifactIds: ["file-hotel"],
		});

		const bundle = await listProjectBundle({ userId: OWNER, projectId: TRIP });

		expect(bundle.map((item) => item.name)).toEqual([
			"Hotel Motto booking.pdf",
			"Saturday plan",
			"Trip cost splitter",
			"Vienna trip board",
		]);
	});

	it("carries the kind from the row's metadata and names the chat it came from", async () => {
		seedChat("chat-plan", { projectId: TRIP, title: "Saturday plan" });
		const documentId = await make("chat-plan", "document", "Saturday plan");
		const appId = await make("chat-plan", "app", "Trip cost splitter");
		const canvasId = await make("chat-plan", "canvas", "Vienna trip board");

		const bundle = await listProjectBundle({ userId: OWNER, projectId: TRIP });
		const byId = new Map(bundle.map((item) => [item.artifactId, item]));

		expect(byId.get(documentId)).toMatchObject({
			artifactKind: "document",
			type: "artifact",
			sourceConversationId: "chat-plan",
			sourceConversationTitle: "Saturday plan",
		});
		expect(byId.get(appId)?.artifactKind).toBe("app");
		expect(byId.get(canvasId)?.artifactKind).toBe("canvas");
		// The kind is read off `metadata_json`: the row's own column only ever
		// says it is a family row.
		const stored = memory.sqlite
			.prepare("SELECT type, metadata_json FROM artifacts WHERE id = ?")
			.get(canvasId) as { type: string; metadata_json: string };
		expect(stored.type).toBe("artifact");
		expect(JSON.parse(stored.metadata_json).artifactType).toBe("canvas");
	});

	it("gives a file row none of the family's fields", async () => {
		seedUploadedFile("file-hotel", "Hotel Motto booking.pdf");
		await linkProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
			artifactIds: ["file-hotel"],
		});

		const [file] = await listProjectBundle({ userId: OWNER, projectId: TRIP });

		expect(file.name).toBe("Hotel Motto booking.pdf");
		expect(file.artifactKind).toBeUndefined();
		expect(file.sourceConversationTitle).toBeUndefined();
		expect(file.linked).toBeUndefined();
	});

	it("never lists Slides, a produced file or something a chat outside the project made", async () => {
		seedChat("chat-plan", { projectId: TRIP, title: "Saturday plan" });
		seedChat("chat-elsewhere", { title: "Something else" });
		await make("chat-plan", "document", "Saturday plan");
		await make("chat-plan", "slides", "Pitch deck");
		seedProducedFile(memory, {
			userId: OWNER,
			conversationId: "chat-plan",
			artifactId: "produced-pdf",
			filename: "Itinerary.pdf",
		});
		await make("chat-elsewhere", "document", "Not in this project");

		const bundle = await listProjectBundle({ userId: OWNER, projectId: TRIP });

		expect(bundle.map((item) => item.name)).toEqual(["Saturday plan"]);
	});

	it("never lists what a chat made while it is incognito, and lists it again when it is not", async () => {
		seedChat("chat-private", {
			projectId: TRIP,
			title: "Private chat",
			memoryIncognito: true,
		});
		await make("chat-private", "document", "Private notes");

		expect(await listProjectBundle({ userId: OWNER, projectId: TRIP })).toEqual(
			[],
		);

		// The flag lives on the chat, not on the item, and the user can move it.
		memory.sqlite
			.prepare("UPDATE conversations SET memory_incognito = 0 WHERE id = ?")
			.run("chat-private");
		expect(
			(await listProjectBundle({ userId: OWNER, projectId: TRIP })).map(
				(item) => item.name,
			),
		).toEqual(["Private notes"]);
	});

	it("does not list another user's item, nor an item of the owner's through another user's project", async () => {
		seedChat("chat-stranger", {
			projectId: OTHER_TRIP,
			title: "Their plan",
			userId: STRANGER,
		});
		const theirs = await make(
			"chat-stranger",
			"document",
			"Their plan",
			STRANGER,
		);

		expect(
			await listProjectBundle({ userId: OWNER, projectId: OTHER_TRIP }),
		).toEqual([]);
		expect(await listProjectBundle({ userId: OWNER, projectId: TRIP })).toEqual(
			[],
		);
		// Not even a link row can bring it in: the owner cannot link it...
		await expect(
			linkProjectKnowledge({
				userId: OWNER,
				projectId: TRIP,
				artifactIds: [theirs],
			}),
		).rejects.toMatchObject({ code: "artifact_not_owned" });
		// ...and a link row somebody planted anyway resolves to nothing.
		memory.db
			.insert(schema.projectKnowledgeLinks)
			.values({
				id: "planted-link",
				userId: OWNER,
				projectId: TRIP,
				artifactId: theirs,
				createdAt: NOW,
			})
			.run();
		expect(await listProjectBundle({ userId: OWNER, projectId: TRIP })).toEqual(
			[],
		);
	});

	it("lists an item the reader linked from the library, whichever chat made it", async () => {
		seedChat("chat-elsewhere", { title: "Something else" });
		const id = await make("chat-elsewhere", "document", "Packing list");
		const before = Math.floor(Date.now() / 1000);

		await linkProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
			artifactIds: [id],
		});

		const [item] = await listProjectBundle({ userId: OWNER, projectId: TRIP });
		expect(item).toMatchObject({
			artifactId: id,
			artifactKind: "document",
			sourceConversationTitle: "Something else",
			linked: true,
		});
		// The link's own time, as the Added column is about the link.
		expect(item.linkedAt).toBeGreaterThanOrEqual(before);
	});

	it("lists an item once when its chat is in the project and it is linked as well", async () => {
		seedChat("chat-plan", { projectId: TRIP, title: "Saturday plan" });
		const id = await make("chat-plan", "document", "Saturday plan");
		await linkProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
			artifactIds: [id],
		});

		const bundle = await listProjectBundle({ userId: OWNER, projectId: TRIP });

		expect(bundle).toHaveLength(1);
		expect(bundle[0].linked).toBe(true);
	});

	it("marks an item that is in the bundle only through its chat as having no link to remove", async () => {
		seedChat("chat-plan", { projectId: TRIP, title: "Saturday plan" });
		await make("chat-plan", "document", "Saturday plan");

		const [item] = await listProjectBundle({ userId: OWNER, projectId: TRIP });

		expect(item.linked).toBe(false);
		// With no link to date it, its time is when the chat made it.
		expect(
			Math.abs(item.linkedAt - Math.floor(Date.now() / 1000)),
		).toBeLessThan(10);
	});

	it("keeps linking a link: unlinking removes the row and deletes nothing", async () => {
		seedChat("chat-elsewhere", { title: "Something else" });
		const id = await make("chat-elsewhere", "document", "Packing list");
		await linkProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
			artifactIds: [id],
		});

		await unlinkProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
			artifactId: id,
		});

		expect(await listProjectBundle({ userId: OWNER, projectId: TRIP })).toEqual(
			[],
		);
		const row = memory.sqlite
			.prepare("SELECT id, content_text FROM artifacts WHERE id = ?")
			.get(id) as { id: string; content_text: string } | undefined;
		expect(row?.content_text).toBe("Packing list body");
		const versions = memory.sqlite
			.prepare(
				"SELECT count(*) AS n FROM artifact_versions WHERE artifact_id = ?",
			)
			.get(id) as { n: number };
		expect(versions.n).toBe(1);
	});

	it("leaves the bundle with the chat that made the item when the chat leaves the project", async () => {
		seedChat("chat-plan", { projectId: TRIP, title: "Saturday plan" });
		await make("chat-plan", "document", "Saturday plan");

		memory.sqlite
			.prepare("UPDATE conversations SET project_id = NULL WHERE id = ?")
			.run("chat-plan");

		expect(await listProjectBundle({ userId: OWNER, projectId: TRIP })).toEqual(
			[],
		);
	});

	it("drops an item the reader deleted, with its link", async () => {
		seedChat("chat-plan", { projectId: TRIP, title: "Saturday plan" });
		const id = await make("chat-plan", "document", "Saturday plan");
		await linkProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
			artifactIds: [id],
		});

		await deleteArtifact({ userId: OWNER, artifactId: id });

		expect(await listProjectBundle({ userId: OWNER, projectId: TRIP })).toEqual(
			[],
		);
	});

	it("keeps the model's own list of project files to files", async () => {
		seedChat("chat-plan", { projectId: TRIP, title: "Saturday plan" });
		seedChat("chat-elsewhere", { title: "Something else" });
		await make("chat-plan", "document", "Saturday plan");
		const linked = await make("chat-elsewhere", "app", "Trip cost splitter");
		seedUploadedFile("file-hotel", "Hotel Motto booking.pdf");
		await linkProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
			artifactIds: ["file-hotel", linked],
		});

		const files = await listProjectKnowledge({
			userId: OWNER,
			projectId: TRIP,
		});

		// The prompt section and the name mentions read this list; a Document
		// is not prompt-ready as a linked source, so a mention of its name
		// would fail the turn.
		expect(files.map((file) => file.name)).toEqual(["Hotel Motto booking.pdf"]);
		expect(
			(await listProjectBundle({ userId: OWNER, projectId: TRIP })).map(
				(item) => item.name,
			),
		).toEqual([
			"Hotel Motto booking.pdf",
			"Saturday plan",
			"Trip cost splitter",
		]);
	});
});
