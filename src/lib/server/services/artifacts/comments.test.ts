import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import { seedConversation, seedUser } from "./artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const {
	createArtifact,
	createComment,
	deleteComment,
	listComments,
	parseArtifactAnchor,
	resolveComment,
} = await import("./index");
const { ARTIFACT_COMMENT_BODY_MAX_CHARS } = await import("./limits");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const INCOGNITO = "conv-incognito";

const TEXT_ANCHOR: Anchor = {
	kind: "text",
	blockId: "b1",
	quote: "Naschmarkt",
	prefix: "then the ",
	suffix: ", and",
};
const NODE_ANCHOR: Anchor = { kind: "node", nodeId: "node-7" };

async function createDocument(conversationId = CONVERSATION) {
	const result = await createArtifact({
		userId: OWNER,
		conversationId,
		kind: "document",
		title: "Saturday plan",
		body: "Naschmarkt, then the Secession",
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact;
}

async function comment(
	artifactId: string,
	body: string,
	options: {
		parentId?: string | null;
		anchor?: Anchor | null;
		author?: "user" | "alfy";
		conversationId?: string;
	} = {},
) {
	const created = await createComment({
		userId: OWNER,
		artifactId,
		anchor: options.anchor === undefined ? TEXT_ANCHOR : options.anchor,
		author: options.author ?? "user",
		body,
		parentId: options.parentId ?? null,
		conversationId: options.conversationId,
	});
	if (!created) throw new Error("comment refused");
	return created;
}

function commentRows(artifactId: string) {
	return memory.db
		.select()
		.from(schema.artifactComments)
		.where(eq(schema.artifactComments.artifactId, artifactId))
		.all();
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
});

afterEach(() => {
	memory.close();
});

describe("createComment and listComments", () => {
	it("round-trips a root comment and a reply; the reply is anchored to its parent, not to the document", async () => {
		const artifact = await createDocument();
		const root = await comment(artifact.id, "Too early?");
		const reply = await comment(artifact.id, "Moved it to ten.", {
			parentId: root.id,
			anchor: NODE_ANCHOR,
			author: "alfy",
		});

		expect(root).toMatchObject({
			artifactId: artifact.id,
			parentId: null,
			anchor: TEXT_ANCHOR,
			author: "user",
			body: "Too early?",
			status: "open",
			replies: [],
		});
		expect(reply).toMatchObject({ parentId: root.id, anchor: null });

		const rows = commentRows(artifact.id);
		expect(rows.find((row) => row.id === reply.id)?.anchorJson).toBeNull();

		const threads = await listComments({
			userId: OWNER,
			artifactId: artifact.id,
		});
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({
			id: root.id,
			anchor: TEXT_ANCHOR,
			replies: [
				{
					id: reply.id,
					parentId: root.id,
					anchor: null,
					author: "alfy",
					body: "Moved it to ten.",
					replies: [],
				},
			],
		});
	});

	it("nests replies under their parents and orders both oldest first", async () => {
		const artifact = await createDocument();
		const first = await comment(artifact.id, "first thread");
		const second = await comment(artifact.id, "second thread", {
			anchor: NODE_ANCHOR,
		});
		await comment(artifact.id, "reply A", { parentId: first.id });
		await comment(artifact.id, "reply to second", { parentId: second.id });
		await comment(artifact.id, "reply B", { parentId: first.id });

		const threads = await listComments({
			userId: OWNER,
			artifactId: artifact.id,
		});

		expect(
			threads.map((thread) => [
				thread.body,
				thread.replies.map((reply) => reply.body),
			]),
		).toEqual([
			["first thread", ["reply A", "reply B"]],
			["second thread", ["reply to second"]],
		]);
	});

	it("renders an unparseable stored anchor as an orphan instead of dropping the comment", async () => {
		const artifact = await createDocument();
		const root = await comment(artifact.id, "Where did this go?");
		memory.db
			.update(schema.artifactComments)
			.set({ anchorJson: '{"kind":"text","blockId":"gone"' })
			.where(eq(schema.artifactComments.id, root.id))
			.run();

		const [thread] = await listComments({
			userId: OWNER,
			artifactId: artifact.id,
		});
		expect(thread).toMatchObject({ id: root.id, anchor: null });
	});

	it("refuses — returning null, not throwing — an over-long body, a root with no anchor, and a reply to a reply", async () => {
		const artifact = await createDocument();
		const root = await comment(artifact.id, "thread");
		const reply = await comment(artifact.id, "reply", { parentId: root.id });

		await expect(
			createComment({
				userId: OWNER,
				artifactId: artifact.id,
				anchor: TEXT_ANCHOR,
				author: "user",
				body: "x".repeat(ARTIFACT_COMMENT_BODY_MAX_CHARS + 1),
			}),
		).resolves.toBeNull();
		await expect(
			createComment({
				userId: OWNER,
				artifactId: artifact.id,
				anchor: null,
				author: "user",
				body: "anchored to nothing",
			}),
		).resolves.toBeNull();
		await expect(
			createComment({
				userId: OWNER,
				artifactId: artifact.id,
				anchor: null,
				author: "user",
				body: "reply to a reply",
				parentId: reply.id,
			}),
		).resolves.toBeNull();
		await expect(
			createComment({
				userId: OWNER,
				artifactId: artifact.id,
				anchor: { kind: "point", x: Number.NaN, y: 1 },
				author: "user",
				body: "at a point that is not one",
			}),
		).resolves.toBeNull();
		expect(commentRows(artifact.id)).toHaveLength(2);
	});

	it("treats an empty-string parentId as root — never a thrown FOREIGN KEY error", async () => {
		const artifact = await createDocument();

		// "" is falsy, so this chooses the root path (needs a real anchor) same
		// as omitting parentId — and must not reach the database as the literal
		// string "", which no comment id ever equals.
		const root = await comment(artifact.id, "root via empty parentId", {
			parentId: "",
		});
		expect(root).toMatchObject({ parentId: null, anchor: TEXT_ANCHOR });
		expect(
			commentRows(artifact.id).find((row) => row.id === root.id)?.parentId,
		).toBeNull();

		await expect(
			createComment({
				userId: OWNER,
				artifactId: artifact.id,
				anchor: null,
				author: "user",
				body: "root via empty parentId, but no anchor",
				parentId: "",
			}),
		).resolves.toBeNull();
	});
});

describe("resolveComment", () => {
	it("flips the status and flips it back", async () => {
		const artifact = await createDocument();
		const root = await comment(artifact.id, "Too early?");

		await expect(
			resolveComment({
				userId: OWNER,
				artifactId: artifact.id,
				commentId: root.id,
				resolved: true,
			}),
		).resolves.toBe(true);
		expect(commentRows(artifact.id)[0].status).toBe("resolved");

		await expect(
			resolveComment({
				userId: OWNER,
				artifactId: artifact.id,
				commentId: root.id,
				resolved: false,
			}),
		).resolves.toBe(true);
		expect(commentRows(artifact.id)[0].status).toBe("open");
	});
});

describe("deleteComment", () => {
	it("removes a parent's replies with it — the rows, not just the thread view", async () => {
		const artifact = await createDocument();
		const root = await comment(artifact.id, "thread");
		await comment(artifact.id, "reply A", { parentId: root.id });
		await comment(artifact.id, "reply B", { parentId: root.id });
		const kept = await comment(artifact.id, "another thread");

		await expect(
			deleteComment({
				userId: OWNER,
				artifactId: artifact.id,
				commentId: root.id,
			}),
		).resolves.toBe(true);

		expect(commentRows(artifact.id).map((row) => row.id)).toEqual([kept.id]);
		await expect(
			deleteComment({
				userId: OWNER,
				artifactId: artifact.id,
				commentId: root.id,
			}),
		).resolves.toBe(false);
	});
});

describe("another user, and an incognito artifact from outside", () => {
	it("gets null, false or an empty list everywhere, and writes nothing", async () => {
		const artifact = await createDocument();
		const root = await comment(artifact.id, "mine");
		const hidden = await createDocument(INCOGNITO);
		await comment(hidden.id, "secret", { conversationId: INCOGNITO });

		for (const [userId, artifactId, commentId] of [
			[STRANGER, artifact.id, root.id],
			[OWNER, hidden.id, commentRows(hidden.id)[0].id],
		] as const) {
			await expect(
				createComment({
					userId,
					artifactId,
					anchor: NODE_ANCHOR,
					author: "user",
					body: "probe",
				}),
			).resolves.toBeNull();
			await expect(listComments({ userId, artifactId })).resolves.toEqual([]);
			await expect(
				resolveComment({ userId, artifactId, commentId, resolved: true }),
			).resolves.toBe(false);
			await expect(
				deleteComment({ userId, artifactId, commentId }),
			).resolves.toBe(false);
		}

		expect(commentRows(artifact.id)).toHaveLength(1);
		expect(commentRows(hidden.id)).toHaveLength(1);
		expect(commentRows(artifact.id)[0].status).toBe("open");
	});
});

describe("parseArtifactAnchor", () => {
	it("returns each valid shape", () => {
		for (const anchor of [
			TEXT_ANCHOR,
			NODE_ANCHOR,
			{ kind: "point", x: -12.5, y: 40 },
		] satisfies Anchor[]) {
			expect(parseArtifactAnchor(JSON.stringify(anchor))).toEqual(anchor);
		}
	});

	it("drops unknown extra fields rather than carrying them", () => {
		expect(
			parseArtifactAnchor(
				JSON.stringify({ kind: "node", nodeId: "n", html: "<b>" }),
			),
		).toEqual({ kind: "node", nodeId: "n" });
	});

	it("returns null — never throws — for anything else", () => {
		for (const json of [
			null,
			"",
			"{nope",
			"[]",
			"42",
			JSON.stringify({ kind: "ellipse", x: 1, y: 2 }),
			JSON.stringify({ ...TEXT_ANCHOR, blockId: "" }),
			JSON.stringify({ ...TEXT_ANCHOR, quote: 7 }),
			JSON.stringify({ kind: "text", blockId: "b1", quote: "q", prefix: "p" }),
			JSON.stringify({ kind: "node" }),
			JSON.stringify({ kind: "node", nodeId: "" }),
			JSON.stringify({ kind: "point", x: 1 }),
			JSON.stringify({ kind: "point", x: "1", y: 2 }),
		]) {
			expect(parseArtifactAnchor(json)).toBeNull();
		}
	});
});
