import { eq } from "drizzle-orm";
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

// The review's computation is spied on (and still runs): RV-V M-10 asks how often
// a page of History parses the versions since the marker.
vi.mock("./document-ops", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./document-ops")>();
	return {
		...actual,
		computePendingReviewBlocks: vi.fn(actual.computePendingReviewBlocks),
	};
});

const { createArtifact, updateArtifactBody } = await import("./index");
const { computePendingReviewBlocks } = await import("./document-ops");
const { listHistory } = await import("./history");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CONVERSATION = "conv-owner";
const INCOGNITO = "conv-incognito";

const doc = (...blocks: Array<[string, string]>) =>
	blocks.map(([id, text]) => `<!--b:${id}-->\n${text}`).join("\n\n");

async function makeDocument(
	body = doc(["p1", "Saturday"]),
	conversationId = CONVERSATION,
) {
	const result = await createArtifact({
		userId: OWNER,
		conversationId,
		kind: "document",
		title: "Saturday plan",
		body,
		author: "alfy",
		versionSummary: "Alfy wrote the first draft",
	});
	if (!result.ok) throw new Error(result.reason);
	return result.artifact;
}

async function write(
	artifactId: string,
	body: string,
	author: "user" | "alfy",
	summary: string,
	extra: { metadataPatch?: Record<string, unknown> } = {},
) {
	const result = await updateArtifactBody({
		userId: OWNER,
		artifactId,
		body,
		author,
		summary,
		...extra,
	});
	if (!result.ok) throw new Error(result.reason);
	return result;
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

describe("listHistory", () => {
	it("tells a Document's story newest first, with the Undo folded onto the change it undid", async () => {
		const artifact = await makeDocument();
		await write(artifact.id, doc(["p1", "Saturday!"]), "user", "Edited");
		await write(
			artifact.id,
			doc(["p1", "Saturday!"], ["p2", "Rainy-day plan"]),
			"alfy",
			"Added a rainy-day plan",
		);
		await write(
			artifact.id,
			doc(["p1", "Saturday!"]),
			"user",
			"Undid Alfy's change: v3",
		);

		const result = await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
		});

		expect(result).toMatchObject({
			ok: true,
			artifactKind: "document",
			older: false,
			nextBefore: null,
			newestVersion: 4,
		});
		if (!result.ok) return;
		expect(
			result.moments.map((m) => [m.versionNumber, m.kind, m.fold, m.status]),
		).toEqual([
			[3, "alfy_edit", "undone", "undone"],
			[2, "user_edit", null, null],
			[1, "first_draft", null, null],
		]);
		expect(result.moments[0].detail).toMatchObject({
			type: "document",
			added: { count: 1, first: "Rainy-day plan" },
		});
		expect(result.moments[0].steps.map((s) => s.versionNumber)).toEqual([4]);
	});

	it("records a burst's first save beside its last, and the reader's name", async () => {
		const artifact = await makeDocument();
		const first = await updateArtifactBody({
			userId: OWNER,
			artifactId: artifact.id,
			body: doc(["p1", "Saturday!"]),
			author: "user",
			summary: "Edited",
			coalesceUserEdits: true,
		});
		if (!first.ok) throw new Error(first.reason);
		memory.db
			.update(schema.artifactVersions)
			.set({ label: "Before the client call" })
			.where(eq(schema.artifactVersions.id, first.versionId))
			.run();

		const result = await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
		});
		if (!result.ok) throw new Error("not ok");
		expect(result.moments[0]).toMatchObject({
			label: "Before the client call",
			startedAt: expect.any(Number),
			at: expect.any(Number),
		});
	});

	it("answers the same not_found for a missing id, another user's, a produced file and an incognito item read from outside", async () => {
		const mine = await makeDocument();
		const incognito = await makeDocument(doc(["p1", "Secret"]), INCOGNITO);
		seedProducedFile(memory, {
			userId: OWNER,
			conversationId: CONVERSATION,
			artifactId: "file-1",
			filename: "plan.pdf",
		});

		const notFound = { ok: false, reason: "not_found" };
		expect(await listHistory({ userId: OWNER, artifactId: "nope" })).toEqual(
			notFound,
		);
		expect(
			await listHistory({ userId: STRANGER, artifactId: mine.id }),
		).toEqual(notFound);
		expect(await listHistory({ userId: OWNER, artifactId: "file-1" })).toEqual(
			notFound,
		);
		expect(
			await listHistory({ userId: OWNER, artifactId: incognito.id }),
		).toEqual(notFound);
		expect(
			await listHistory({
				userId: OWNER,
				artifactId: incognito.id,
				conversationId: CONVERSATION,
			}),
		).toEqual(notFound);
		// Read from its own conversation it is the owner's.
		expect(
			await listHistory({
				userId: OWNER,
				artifactId: incognito.id,
				conversationId: INCOGNITO,
			}),
		).toMatchObject({ ok: true, newestVersion: 1 });
	});

	describe("paging", () => {
		async function seedMany(count: number) {
			const artifact = await makeDocument();
			for (let i = 2; i <= count; i += 1) {
				await write(
					artifact.id,
					doc(["p1", `Text ${i}`]),
					i % 2 === 0 ? "user" : "alfy",
					i % 2 === 0 ? "Edited" : `Alfy ${i}`,
				);
			}
			return artifact;
		}

		it("reads a long history fifty moments at a time, newest first, without a gap or a repeat", async () => {
			const artifact = await seedMany(120);
			const seen: number[] = [];
			let before: number | undefined;
			let pages = 0;
			for (;;) {
				const page = await listHistory({
					userId: OWNER,
					artifactId: artifact.id,
					before,
					limit: 50,
				});
				if (!page.ok) throw new Error("not ok");
				pages += 1;
				expect(page.newestVersion).toBe(120);
				expect(page.moments.length).toBeLessThanOrEqual(50);
				seen.push(...page.moments.map((m) => m.versionNumber));
				if (!page.older) {
					expect(page.nextBefore).toBeNull();
					break;
				}
				expect(page.nextBefore).toBe(seen[seen.length - 1]);
				before = page.nextBefore ?? undefined;
			}
			expect(pages).toBe(3);
			expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => 120 - i));
		});

		it("keeps a folded moment whole across a page boundary, and finds a restore's source on an older page", async () => {
			const artifact = await makeDocument();
			// v2..v48: ordinary alternating rows, then an Alfy change at v49 undone at v50.
			for (let i = 2; i <= 48; i += 1) {
				await write(
					artifact.id,
					doc(["p1", `Text ${i}`]),
					"user",
					i % 2 ? "Edited" : "Edited (x)",
				);
			}
			await write(
				artifact.id,
				doc(["p1", "Text 48"], ["p2", "Alfy"]),
				"alfy",
				"Added a note",
			);
			await write(
				artifact.id,
				doc(["p1", "Text 48"]),
				"user",
				"Undid Alfy's change: v49",
			);
			await write(artifact.id, doc(["p1", "Text 2"]), "user", "Restored v2");

			// A page of two moments: the restore, and the folded Alfy change with its Undo.
			const first = await listHistory({
				userId: OWNER,
				artifactId: artifact.id,
				limit: 2,
			});
			if (!first.ok) throw new Error("not ok");
			expect(
				first.moments.map((m) => [m.versionNumber, m.kind, m.fold]),
			).toEqual([
				[51, "restore", null],
				[49, "alfy_edit", "undone"],
			]);
			expect(first.nextBefore).toBe(49);
			// The next page starts below the whole moment.
			const second = await listHistory({
				userId: OWNER,
				artifactId: artifact.id,
				before: first.nextBefore ?? undefined,
				limit: 2,
			});
			if (!second.ok) throw new Error("not ok");
			expect(second.moments.map((m) => m.versionNumber)).toEqual([48, 47]);

			// The source of the restore, far below, knows it was restored from.
			const oldest = await listHistory({
				userId: OWNER,
				artifactId: artifact.id,
				before: 4,
				limit: 5,
			});
			if (!oldest.ok) throw new Error("not ok");
			const source = oldest.moments.find((m) => m.versionNumber === 2);
			expect(source?.restoredHere).toEqual([
				expect.objectContaining({ versionNumber: 51 }),
			]);
			expect(source?.sameAsNow).toBe(true);
		});
	});

	it("does not compare a body over the cap: the moment says so, and the history still loads", async () => {
		const artifact = await makeDocument();
		const big = doc(["p1", "x".repeat(300 * 1024)]);
		await write(artifact.id, big, "user", "Edited");
		await write(artifact.id, doc(["p1", "short"]), "user", "Restored v1");

		const result = await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
		});
		if (!result.ok) throw new Error("not ok");
		expect(result.moments.map((m) => [m.versionNumber, m.detail.type])).toEqual(
			[
				[3, "large"], // measured against the large version before it
				[2, "large"],
				[1, "none"],
			],
		);
	});

	it("says Waiting for what the review still holds, from the same marker", async () => {
		const artifact = await makeDocument(doc(["p1", "Saturday"]));
		await write(
			artifact.id,
			doc(["p1", "Saturday"], ["p2", "Rainy-day plan"]),
			"alfy",
			"Added a rainy-day plan",
			{ metadataPatch: { review: { throughVersion: 1, keptBlockIds: [] } } },
		);

		const result = await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
		});
		if (!result.ok) throw new Error("not ok");
		expect(result.moments[0]).toMatchObject({
			kind: "alfy_edit",
			status: "waiting",
		});

		// Kept: the marker moves past it.
		memory.db
			.update(schema.artifacts)
			.set({
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: "Saturday plan",
					review: { throughVersion: 2, keptBlockIds: [] },
				}),
			})
			.where(eq(schema.artifacts.id, artifact.id))
			.run();
		const kept = await listHistory({ userId: OWNER, artifactId: artifact.id });
		if (!kept.ok) throw new Error("not ok");
		expect(kept.moments[0].status).toBe("kept");
	});

	// RV-V M-10: what still waits is read from every version since the review's marker,
	// bodies included. A page of History asked for it every time: each "Show older",
	// each reopen. It is the same answer until the artifact changes.
	it("parses the versions since the marker once for an artifact that has not changed, and again when it has", async () => {
		const artifact = await makeDocument(doc(["p1", "Saturday"]));
		await write(
			artifact.id,
			doc(["p1", "Saturday"], ["p2", "Rainy-day plan"]),
			"alfy",
			"Added a rainy-day plan",
			{ metadataPatch: { review: { throughVersion: 1, keptBlockIds: [] } } },
		);
		for (let n = 3; n <= 6; n += 1) {
			await write(
				artifact.id,
				doc(["p1", "Saturday"], ["p2", `Rainy-day plan, take ${n}`]),
				"alfy",
				`Reworded ${n}`,
			);
		}
		const spy = vi.mocked(computePendingReviewBlocks);
		spy.mockClear();

		// The first page, the next page, a reopen: one parse.
		const first = await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
			limit: 2,
		});
		if (!first.ok) throw new Error("not ok");
		expect(first.nextBefore).not.toBeNull();
		await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
			limit: 2,
			before: first.nextBefore ?? undefined,
		});
		const again = await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
			limit: 2,
		});
		expect(spy).toHaveBeenCalledTimes(1);
		// And the answer is the same one each time.
		if (!again.ok) throw new Error("not ok");
		expect(again.moments.map((m) => m.status)).toEqual(
			first.moments.map((m) => m.status),
		);

		// A new version is new facts: parsed again, and the status follows.
		await write(
			artifact.id,
			doc(["p1", "Saturday"], ["p2", "Rainy-day plan, again"]),
			"alfy",
			"Reworded again",
		);
		const changed = await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
			limit: 2,
		});
		expect(spy).toHaveBeenCalledTimes(2);
		if (!changed.ok) throw new Error("not ok");
		expect(changed.moments[0].status).toBe("waiting");

		// The marker moving (Keep) is new facts too: nothing waits now.
		memory.db
			.update(schema.artifacts)
			.set({
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: "Saturday plan",
					review: { throughVersion: 7, keptBlockIds: [] },
				}),
			})
			.where(eq(schema.artifacts.id, artifact.id))
			.run();
		const kept = await listHistory({
			userId: OWNER,
			artifactId: artifact.id,
			limit: 2,
		});
		if (!kept.ok) throw new Error("not ok");
		expect(kept.moments[0].status).toBe("kept");
	});

	it("links an edit that answered a comment to Alfy's one reply, and to none when it is ambiguous", async () => {
		const artifact = await makeDocument();
		await write(
			artifact.id,
			doc(["p1", "Saturday"], ["p2", "Answer"]),
			"alfy",
			"Alfy's comment reply",
		);
		const row = memory.db
			.select()
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.artifactId, artifact.id))
			.all()
			.find((r) => r.versionNumber === 2);
		const at = row?.createdAt ?? NOW;
		const comment = (id: string) => ({
			id,
			artifactId: artifact.id,
			userId: OWNER,
			anchorJson: JSON.stringify({ kind: "node", nodeId: "p1" }),
			author: "alfy" as const,
			body: "Done.",
			createdAt: at,
		});
		memory.db.insert(schema.artifactComments).values(comment("reply-1")).run();

		const one = await listHistory({ userId: OWNER, artifactId: artifact.id });
		if (!one.ok) throw new Error("not ok");
		expect(one.moments[0]).toMatchObject({
			kind: "alfy_reply_edit",
			commentId: "reply-1",
		});

		memory.db.insert(schema.artifactComments).values(comment("reply-2")).run();
		const two = await listHistory({ userId: OWNER, artifactId: artifact.id });
		if (!two.ok) throw new Error("not ok");
		expect(two.moments[0].commentId).toBeNull();
	});

	it("derives a board's story the same way, with the change it waits on", async () => {
		const board = (text: string) =>
			JSON.stringify({
				version: 1,
				nodes: [
					{
						id: "a",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "sticky", text, tone: "yellow" },
					},
				],
				edges: [],
				viewport: { x: 0, y: 0, zoom: 1 },
				annotations: [],
			});
		const created = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "canvas",
			title: "Board",
			body: board("one"),
			author: "alfy",
			versionSummary: "Alfy wrote the first draft",
		});
		if (!created.ok) throw new Error(created.reason);
		await write(created.artifact.id, board("two"), "alfy", "Reworded", {
			metadataPatch: { review: { throughVersion: 1, keptBlockIds: [] } },
		});

		const result = await listHistory({
			userId: OWNER,
			artifactId: created.artifact.id,
		});
		if (!result.ok) throw new Error("not ok");
		expect(result.artifactKind).toBe("canvas");
		expect(result.moments[0]).toMatchObject({
			kind: "alfy_edit",
			status: "waiting",
			detail: { type: "canvas", blocksChanged: { count: 1, first: "two" } },
		});
	});

	it("answers an artifact with no versions with an empty history", async () => {
		const created = await createArtifact({
			userId: OWNER,
			conversationId: CONVERSATION,
			kind: "document",
			title: "Empty",
			body: null,
		});
		if (!created.ok) throw new Error(created.reason);
		expect(
			await listHistory({ userId: OWNER, artifactId: created.artifact.id }),
		).toEqual({
			ok: true,
			artifactKind: "document",
			moments: [],
			older: false,
			nextBefore: null,
			newestVersion: 0,
		});
	});
});
