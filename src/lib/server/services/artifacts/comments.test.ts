import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	ALFY_EMPTY_REPLY_MARKER,
	ALFY_REFUSED_MARKER,
} from "$lib/shared/artifact-document/alfy-reply";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import { seedConversation, seedUser } from "./artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

// The @Alfy hook's own model call (T10.5) — every comments.ts suite mocks it
// the same way memory-control-model.test.ts does, since it is the SAME
// `sendJsonControlMessage` seam, never a second one.
const sendJsonControlMessageMock = vi.fn();
vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

function mockAlfyResponse(payload: { note: string; ops?: unknown[] }): void {
	sendJsonControlMessageMock.mockResolvedValueOnce({
		text: JSON.stringify({ note: payload.note, ops: payload.ops ?? [] }),
		rawResponse: {},
		modelId: "model1",
		modelDisplayName: "Test Model",
	});
}

const {
	createArtifact,
	createComment,
	createDocumentArtifact,
	deleteComment,
	getComment,
	listComments,
	parseArtifactAnchor,
	resolveComment,
	runAlfyCommentReply,
} = await import("./index");
const { ARTIFACT_COMMENT_BODY_MAX_CHARS } = await import("./limits");
const { parseDocument } = await import("$lib/shared/artifact-document/blocks");

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

async function createDocument(
	conversationId = CONVERSATION,
	body = "Naschmarkt, then the Secession",
) {
	const result = await createArtifact({
		userId: OWNER,
		conversationId,
		kind: "document",
		title: "Saturday plan",
		body,
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
	sendJsonControlMessageMock.mockReset();
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

describe("getComment", () => {
	it("reads back a single comment scoped to the artifact and its owner", async () => {
		const artifact = await createDocument();
		const created = await comment(artifact.id, "Too early?");
		const found = await getComment({
			userId: OWNER,
			artifactId: artifact.id,
			commentId: created.id,
		});
		expect(found?.id).toBe(created.id);
	});

	it("is null for a stranger, a foreign id, or a wrong artifact id", async () => {
		const artifact = await createDocument();
		const created = await comment(artifact.id, "Too early?");
		expect(
			await getComment({
				userId: STRANGER,
				artifactId: artifact.id,
				commentId: created.id,
			}),
		).toBeNull();
		expect(
			await getComment({
				userId: OWNER,
				artifactId: artifact.id,
				commentId: "nope",
			}),
		).toBeNull();
	});
});

// The @Alfy hook (T10.5): a comment addressed to Alfy runs ONE patch attempt
// through the SAME engine `edit_artifact` uses (`applyDocumentPatch`), never a
// second one, and always leaves a reply in the thread.
describe("runAlfyCommentReply", () => {
	/** A one-block document, plus the real (minted) id and text of that block. */
	async function createDocumentWithBlock(markdown: string) {
		// Ids are minted at creation (T1's rule), which is why this uses
		// createDocumentArtifact — the Document's own creation path — rather
		// than the generic createArtifact() the OTHER describe blocks above use
		// for a plain text body: only the former mints the `<!--b:id-->`
		// markers a real anchor needs to point at.
		const artifact = await createDocumentArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			title: "Trip notes",
			markdown,
			author: "user",
			summary: "Created",
		});
		const parsed = parseDocument(artifact.body ?? "", { mint: false });
		const block = parsed.blocks[0];
		if (!block) throw new Error("fixture must parse to at least one block");
		return { artifact, block };
	}

	/**
	 * `createComment` requires a non-empty prefix AND suffix (Slice 0's
	 * `toAnchor`), so the quote must be a proper substring with real context on
	 * both sides — never the block's whole text.
	 */
	function textAnchorFor(
		block: { id: string; markdown: string },
		quote: string,
	): Anchor {
		const idx = block.markdown.indexOf(quote);
		if (idx === -1) {
			throw new Error(`fixture quote "${quote}" must appear in the block`);
		}
		return {
			kind: "text",
			blockId: block.id,
			quote,
			prefix: block.markdown.slice(0, idx),
			suffix: block.markdown.slice(idx + quote.length),
		};
	}

	it("applies cleanly: the document changes and Alfy's own note appears as the reply", async () => {
		const { artifact, block } = await createDocumentWithBlock(
			"Book the flight to Vienna.",
		);
		const root = await comment(
			artifact.id,
			"@Alfy change Vienna to Budapest.",
			{
				anchor: textAnchorFor(block, "Vienna"),
			},
		);
		mockAlfyResponse({
			note: "Changed the destination to Budapest.",
			ops: [{ op: "replaceRange", find: "Vienna", text: "Budapest" }],
		});

		const result = await runAlfyCommentReply({
			userId: OWNER,
			artifactId: artifact.id,
			commentId: root.id,
			abortSignal: new AbortController().signal,
		});

		if (!result.ok) throw new Error(result.reason);
		expect(result.value.outcome).toBe("applied");
		expect(result.value.applied).toBe(1);
		expect(result.value.reply.body).toBe(
			"Changed the destination to Budapest.",
		);
		expect(result.value.reply.author).toBe("alfy");
		expect(result.value.reply.parentId).toBe(root.id);

		// getComment reads one row and never nests replies (that is
		// listComments' job) — check the thread itself for the reply.
		const threads = await listComments({
			userId: OWNER,
			artifactId: artifact.id,
		});
		const updatedRoot = threads.find((t) => t.id === root.id);
		expect(updatedRoot?.replies.map((r) => r.body)).toContain(
			"Changed the destination to Budapest.",
		);
	});

	it("falls back to a fixed note when Alfy applies a change but writes nothing", async () => {
		const { artifact, block } = await createDocumentWithBlock(
			"Book the flight to Vienna.",
		);
		const root = await comment(artifact.id, "@Alfy fix the city.", {
			anchor: textAnchorFor(block, "Vienna"),
		});
		mockAlfyResponse({
			note: "",
			ops: [{ op: "replaceRange", find: "Vienna", text: "Budapest" }],
		});

		const result = await runAlfyCommentReply({
			userId: OWNER,
			artifactId: artifact.id,
			commentId: root.id,
			abortSignal: new AbortController().signal,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.value.outcome).toBe("applied");
		expect(result.value.reply.body).toBe(ALFY_EMPTY_REPLY_MARKER);
	});

	it("refuses when the engine cannot apply the op, leaving the document untouched", async () => {
		// "Vienna" occurs twice — replaceRange must refuse an ambiguous find
		// rather than guess, exactly like edit_artifact (T2.5's own rule).
		const { artifact, block } = await createDocumentWithBlock(
			"Vienna is lovely. We booked Vienna for June.",
		);
		const root = await comment(artifact.id, "@Alfy change Vienna to Prague.", {
			anchor: textAnchorFor(block, "lovely"),
		});
		mockAlfyResponse({
			note: "Updated the city.",
			ops: [{ op: "replaceRange", find: "Vienna", text: "Prague" }],
		});

		const result = await runAlfyCommentReply({
			userId: OWNER,
			artifactId: artifact.id,
			commentId: root.id,
			abortSignal: new AbortController().signal,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.value.outcome).toBe("refused");
		expect(result.value.applied).toBe(0);
		expect(result.value.reply.body).toBe(ALFY_REFUSED_MARKER);
	});

	it("answers a question with no ops and changes nothing", async () => {
		const { artifact, block } = await createDocumentWithBlock(
			"Westbahnhof is our base.",
		);
		const root = await comment(
			artifact.id,
			"@Alfy is Westbahnhof a good base?",
			{ anchor: textAnchorFor(block, "our base") },
		);
		mockAlfyResponse({
			note: "Yes — it has direct trains to the airport.",
			ops: [],
		});

		const result = await runAlfyCommentReply({
			userId: OWNER,
			artifactId: artifact.id,
			commentId: root.id,
			abortSignal: new AbortController().signal,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.value.outcome).toBe("answered");
		expect(result.value.applied).toBe(0);
		expect(result.value.reply.body).toBe(
			"Yes — it has direct trains to the airport.",
		);
	});

	it("refuses without calling the model at all when the anchor is orphaned", async () => {
		const { artifact, block } = await createDocumentWithBlock(
			"Book the flight to Vienna.",
		);
		const baseAnchor = textAnchorFor(block, "Vienna");
		if (baseAnchor.kind !== "text") throw new Error("unreachable");
		const root = await comment(artifact.id, "@Alfy make this a question.", {
			anchor: { ...baseAnchor, quote: "a phrase that is not here" },
		});

		const result = await runAlfyCommentReply({
			userId: OWNER,
			artifactId: artifact.id,
			commentId: root.id,
			abortSignal: new AbortController().signal,
		});
		if (!result.ok) throw new Error(result.reason);
		expect(result.value.outcome).toBe("refused");
		expect(result.value.reply.body).toBe(ALFY_REFUSED_MARKER);
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
	});

	it("writes nothing once the request is already aborted", async () => {
		const { artifact, block } = await createDocumentWithBlock(
			"Book the flight to Vienna.",
		);
		const root = await comment(artifact.id, "@Alfy change it.", {
			anchor: textAnchorFor(block, "Vienna"),
		});
		const controller = new AbortController();
		controller.abort();

		const result = await runAlfyCommentReply({
			userId: OWNER,
			artifactId: artifact.id,
			commentId: root.id,
			abortSignal: controller.signal,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.reason).toBe("aborted");
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();

		const threads = await listComments({
			userId: OWNER,
			artifactId: artifact.id,
		});
		expect(threads.find((t) => t.id === root.id)?.replies).toHaveLength(0);
	});

	it("is not_found for another user's artifact", async () => {
		const artifact = await createDocument();
		const root = await comment(artifact.id, "@Alfy change it.");
		const result = await runAlfyCommentReply({
			userId: STRANGER,
			artifactId: artifact.id,
			commentId: root.id,
			abortSignal: new AbortController().signal,
		});
		expect(result).toEqual({ ok: false, reason: "not_found" });
	});
});
