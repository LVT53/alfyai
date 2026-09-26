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

const {
	createArtifact,
	createDocumentArtifact,
	listArtifactsForConversation,
	updateArtifactBody,
} = await import("./index");

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

/** Bypasses `saveDocumentBody`'s own tab-writing format (T9) — this test only needs the STORED metadata shape `documentTabsFromMetadata` reads. */
function setMetadataTabs(
	id: string,
	tabs: { id: string; title: string; startBlockId: string }[],
) {
	const row = memory.sqlite
		.prepare("SELECT metadata_json FROM artifacts WHERE id = ?")
		.get(id) as { metadata_json: string };
	const metadata = JSON.parse(row.metadata_json);
	metadata.tabs = tabs;
	memory.sqlite
		.prepare("UPDATE artifacts SET metadata_json = ? WHERE id = ?")
		.run(JSON.stringify(metadata), id);
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

// T9 steps 4/7: the chat card's Document preview (subtitle facts + the
// tickable checklist). Bounded and never the whole body — every assertion
// here either counts something small or reads through the SAME
// parse/serializer (`parseDocument`) everything else uses.
describe("listArtifactsForConversation — documentPreview (T9 steps 4/7)", () => {
	const TASKS_BODY = [
		"# Packing",
		"",
		"- [x] Passport",
		"",
		"- [x] Tickets",
		"",
		"- [ ] Charger",
		"",
		"- [ ] Sunscreen",
		"",
		"- [ ] Umbrella",
		"",
		"- [ ] Guidebook",
		"",
		"- [ ] Snacks",
	].join("\n");

	/**
	 * The generic `createArtifact` stores whatever body it is given verbatim —
	 * it has no idea a Document's body needs block-id markers minted first.
	 * `createDocumentArtifact` (the real Document creation path, also what
	 * `create_artifact`'s tool handler calls) does that minting, so a
	 * multi-block body here gets the SAME distinct ids the live app would give
	 * it — using the plain `create()` helper above (backed by `createArtifact`
	 * directly) here would silently collapse every block onto one id.
	 */
	async function createDocumentWithBody(title: string, body: string) {
		return createDocumentArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			title,
			markdown: body,
			author: "user",
			summary: "Created",
		});
	}

	it("bounds tasks to the first five, in order, with the real block ids and checked state", async () => {
		const doc = await createDocumentWithBody("Packing list", TASKS_BODY);

		const [row] = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});

		expect(row.id).toBe(doc.id);
		expect(row.documentPreview?.tasks).toHaveLength(5);
		expect(row.documentPreview?.tasks.map((t) => t.text)).toEqual([
			"Passport",
			"Tickets",
			"Charger",
			"Sunscreen",
			"Umbrella",
		]);
		expect(row.documentPreview?.tasks.map((t) => t.checked)).toEqual([
			true,
			true,
			false,
			false,
			false,
		]);
		expect(row.documentPreview?.totalTaskCount).toBe(7);
		// Real, parser-minted block ids — never a synthetic index.
		expect(new Set(row.documentPreview?.tasks.map((t) => t.blockId)).size).toBe(
			5,
		);
	});

	it("counts the document's tabs", async () => {
		const doc = await createDocumentWithBody("Trip plan", "# Plan\nGo.");
		setMetadataTabs(doc.id, [
			{ id: "t1", title: "Plan", startBlockId: "b1" },
			{ id: "t2", title: "Budget", startBlockId: "b2" },
			{ id: "t3", title: "Packing", startBlockId: "b3" },
		]);

		const [row] = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});

		expect(row.documentPreview?.tabCount).toBe(3);
	});

	it("has an empty (not missing) tasks list for a document with no checklist", async () => {
		const doc = await createDocumentWithBody("Notes", "# Notes\nJust text.");

		const [row] = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});

		expect(row.id).toBe(doc.id);
		// `createDocumentArtifact` gives every fresh document its one default
		// tab (T9.3: a document with exactly one tab hides the strip) — the
		// checklist is what is actually empty here.
		expect(row.documentPreview).toMatchObject({
			tabCount: 1,
			tasks: [],
			totalTaskCount: 0,
		});
	});

	it("never leaks the body itself — only the bounded fields", async () => {
		const secret = "Sunscreen brand: only the good stuff, don't tell Alfy";
		await createDocumentWithBody("Packing list", `${TASKS_BODY}\n\n${secret}`);

		const [row] = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});

		expect(row).not.toHaveProperty("body");
		expect(row).not.toHaveProperty("markdown");
		expect(JSON.stringify(row)).not.toContain(secret);
	});

	it("omits documentPreview entirely for a non-document kind", async () => {
		await create(CONVERSATION, "Trip cost splitter", "app");

		const [row] = await listArtifactsForConversation({
			userId: OWNER,
			conversationId: CONVERSATION,
		});

		expect(row.kind).toBe("app");
		expect(row.documentPreview).toBeUndefined();
	});
});
