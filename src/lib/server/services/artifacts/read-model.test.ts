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

const { createArtifact, listArtifactsForConversation, updateArtifactBody } =
	await import("./index");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-a";
const OTHER_CONVERSATION = "conv-b";
const INCOGNITO = "conv-incognito";
const STRANGER_CONVERSATION = "conv-stranger";

async function create(
	conversationId: string,
	title: string,
	kind: "document" | "app" = "document",
	userId = OWNER,
) {
	const result = await createArtifact({
		userId,
		conversationId,
		kind,
		title,
		body: `${title} body`,
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact;
}

function setUpdatedAt(id: string, at: Date) {
	memory.sqlite
		.prepare("UPDATE artifacts SET updated_at = ? WHERE id = ?")
		.run(Math.floor(at.getTime() / 1000), id);
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, { id: OTHER_CONVERSATION, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
	seedConversation(memory, { id: STRANGER_CONVERSATION, userId: STRANGER });
});

afterEach(() => {
	memory.close();
});

describe("listArtifactsForConversation", () => {
	it("lists the conversation's artifacts and its produced files, newest first", async () => {
		const plan = await create(CONVERSATION, "Saturday plan");
		const splitter = await create(CONVERSATION, "Trip cost splitter", "app");
		seedProducedFile(memory, {
			userId: OWNER,
			conversationId: CONVERSATION,
			artifactId: "produced-summary",
			filename: "Vienna trip summary.pdf",
		});
		setUpdatedAt("produced-summary", new Date(NOW.getTime() + 1_000));
		setUpdatedAt(plan.id, new Date(NOW.getTime() + 3_000));
		setUpdatedAt(splitter.id, new Date(NOW.getTime() + 2_000));

		const listed = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});

		expect(listed.map((row) => [row.title, row.kind])).toEqual([
			["Saturday plan", "document"],
			["Trip cost splitter", "app"],
			["Vienna trip summary.pdf", "file"],
		]);
		expect(listed[0]).toMatchObject({
			id: plan.id,
			conversationId: CONVERSATION,
			versionNumber: 1,
			commentCount: 0,
			updatedAt: NOW.getTime() + 3_000,
		});
		expect(listed[2]).toMatchObject({ versionNumber: 0, commentCount: 0 });
	});

	it("carries the newest version number and the comment count", async () => {
		const plan = await create(CONVERSATION, "Saturday plan");
		await updateArtifactBody({
			userId: OWNER,
			artifactId: plan.id,
			body: "v2",
			author: "user",
			summary: "Edited",
		});
		memory.db
			.insert(schema.artifactComments)
			.values([
				{
					id: "root",
					artifactId: plan.id,
					userId: OWNER,
					anchorJson: JSON.stringify({ kind: "node", nodeId: "n" }),
					author: "user",
					body: "Too early?",
					createdAt: NOW,
				},
				{
					id: "reply",
					artifactId: plan.id,
					userId: OWNER,
					parentId: "root",
					author: "alfy",
					body: "Moved it to ten.",
					createdAt: NOW,
				},
			])
			.run();

		const [row] = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});

		expect(row).toMatchObject({ versionNumber: 2, commentCount: 2 });
	});

	it("lists nothing from another conversation or another user", async () => {
		await create(OTHER_CONVERSATION, "Elsewhere");
		await create(STRANGER_CONVERSATION, "Not yours", "document", STRANGER);
		seedProducedFile(memory, {
			userId: OWNER,
			conversationId: OTHER_CONVERSATION,
			artifactId: "produced-elsewhere",
			filename: "elsewhere.pdf",
		});

		await expect(
			listArtifactsForConversation({
				userId: OWNER,
				conversationId: CONVERSATION,
			}),
		).resolves.toEqual([]);
		// A conversation that is not the caller's lists nothing, even though it
		// holds an artifact.
		await expect(
			listArtifactsForConversation({
				userId: OWNER,
				conversationId: STRANGER_CONVERSATION,
			}),
		).resolves.toEqual([]);
	});

	it("does not list a produced-file artifact that has no produced file to open", async () => {
		seedProducedFile(memory, {
			userId: OWNER,
			conversationId: CONVERSATION,
			artifactId: "no-file",
			filename: "ghost.pdf",
			withChatFile: false,
		});

		await expect(
			listArtifactsForConversation({
				userId: OWNER,
				conversationId: CONVERSATION,
			}),
		).resolves.toEqual([]);
	});

	it("lists an incognito conversation's artifacts to that conversation only", async () => {
		await create(INCOGNITO, "Secret plan");

		const inside = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: INCOGNITO,
		});
		expect(inside.map((row) => row.title)).toEqual(["Secret plan"]);

		await expect(
			listArtifactsForConversation({
				userId: OWNER,
				conversationId: CONVERSATION,
			}),
		).resolves.toEqual([]);
	});
});
