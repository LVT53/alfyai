/**
 * A user's save landing between the model's read of the newest version and its
 * write (Feature 2 · Artifacts, Slice 3): the envelope refuses the stale base
 * (`version_conflict`), and the edit tool tries ONCE more, because every op is
 * judged against the board as it is then. Real database; only the tool's own
 * "which version is newest" read is made stale, for the first try (or both).
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import { conversations, users } from "$lib/server/db/schema";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";

let staleReads = 0;

vi.mock("$lib/server/services/artifacts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("$lib/server/services/artifacts")>();
	return {
		...original,
		// The edit tool's own read of the newest version: while `staleReads` is
		// above zero it answers with the one BEFORE it, as if a save had landed
		// after the read.
		listVersions: async (
			params: Parameters<typeof original.listVersions>[0],
		) => {
			const versions = await original.listVersions({
				...params,
				limit: Math.max(params.limit ?? 50, 2),
			});
			if (staleReads > 0 && versions.length > 1) {
				staleReads -= 1;
				return [versions[1]];
			}
			return versions.slice(0, params.limit ?? versions.length);
		},
	};
});

const { createArtifact, listVersions, saveCanvasBoard } = await import(
	"$lib/server/services/artifacts"
);
const { runEditArtifactTool } = await import("./edit");

const NOW = new Date("2026-09-29T12:00:00.000Z");
let userId: string;
let conversationId: string;

beforeEach(() => {
	staleReads = 0;
	userId = `user-${randomUUID()}`;
	conversationId = `conv-${randomUUID()}`;
	db.insert(users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(conversations)
		.values({
			id: conversationId,
			userId,
			title: "Trip",
			memoryIncognito: false,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
});

/** A board with two versions, so there is an older one for a stale read to answer with. */
async function boardWithTwoVersions() {
	const made = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Weekend",
		body: boardJson(sampleBoard()),
		author: "user",
	});
	if (!made.ok) throw new Error("setup");
	const board = sampleBoard();
	board.nodes[0] = { ...board.nodes[0], position: { x: 44, y: 44 } };
	const saved = await saveCanvasBoard({
		userId,
		artifactId: made.artifact.id,
		conversationId,
		body: boardJson(board),
		author: "user",
		summary: VERSION_SUMMARY.edited,
		expectVersion: 1,
	});
	if (!saved.ok) throw new Error("setup: save");
	return made.artifact.id;
}

function edit(artifactId: string) {
	return runEditArtifactTool({
		userId,
		conversationId,
		turnId: "turn-1",
		artifactId,
		ops: [{ op: "move", id: "note-museum", to: { x: 7, y: 7 } }],
		abortSignal: new AbortController().signal,
	});
}

describe("edit_artifact.canvas — a save landing between the read and the write", () => {
	it("tries once more, judging the ops against the board as it is now, and applies them", async () => {
		const artifactId = await boardWithTwoVersions();
		staleReads = 1;
		const result = await edit(artifactId);
		expect(result.modelPayload).toMatchObject({ success: true, applied: 1 });
		const versions = await listVersions({ userId, artifactId, conversationId });
		expect(versions[0]).toMatchObject({ author: "alfy" });
		expect(versions).toHaveLength(3);
	});

	it("says to read the board again — and writes nothing — when the conflict stands after the second try", async () => {
		const artifactId = await boardWithTwoVersions();
		staleReads = 2;
		const result = await edit(artifactId);
		expect(result.modelPayload.success).toBe(false);
		if (result.modelPayload.success) return;
		expect(result.modelPayload.error).toMatch(/read_artifact/);
		expect(result.modelPayload.error).toMatch(/Nothing was applied/);
		expect(
			await listVersions({ userId, artifactId, conversationId }),
		).toHaveLength(2);
	});
});
