/**
 * An edit the turn's stop cut off after its write had begun (ruling 67). The
 * envelope has already told the model the call failed, so the model does not know
 * the board changed: what it knows of the board stays what it read, and its next
 * edit of the block its cut-off edit changed is refused until it reads again.
 *
 * Real tools, real database. Only the moment the stop arrives is arranged: the
 * edit tool's own look at the newest version aborts the turn's signal, after the
 * tool's last check of it and before its write.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import { conversations, users } from "$lib/server/db/schema";

const hooks = vi.hoisted(() => ({
	stopDuringNextEdit: null as AbortController | null,
}));

vi.mock("$lib/server/services/artifacts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("$lib/server/services/artifacts")>();
	return {
		...original,
		listVersions: async (
			params: Parameters<typeof original.listVersions>[0],
		) => {
			const stop = hooks.stopDuringNextEdit;
			if (stop) {
				hooks.stopDuringNextEdit = null;
				stop.abort();
			}
			return original.listVersions(params);
		},
	};
});

const { createArtifact, getArtifact, listVersions } = await import(
	"$lib/server/services/artifacts"
);
const { boardJson } = await import("$lib/shared/artifacts/canvas-body");
const { sampleBoard } = await import(
	"$lib/shared/artifacts/canvas-fixtures.test-helpers"
);
const { VERSION_SUMMARY } = await import(
	"$lib/shared/artifacts/version-summaries"
);
const { createNormalChatTools } = await import("../index");

const NOW = new Date("2026-10-07T09:00:00.000Z");
let userId: string;
let conversationId: string;

beforeEach(() => {
	hooks.stopDuringNextEdit = null;
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

describe("edit_artifact on a board, cut off by the turn's stop (ruling 67)", () => {
	it("does not count a cut-off edit as something the model knows the result of", async () => {
		const made = await createArtifact({
			userId,
			conversationId,
			kind: "canvas",
			title: "Weekend board",
			body: boardJson(sampleBoard()),
			author: "user",
			versionSummary: VERSION_SUMMARY.edited,
		});
		if (!made.ok) throw new Error(`setup: ${made.reason}`);
		const id = made.artifact.id;
		const { tools } = createNormalChatTools({
			userId,
			conversationId,
			turnId: `turn-${randomUUID()}`,
		});
		const call = (ops: unknown[], abortSignal?: AbortSignal) =>
			tools.edit_artifact.execute?.(
				{ artifactId: id, ops },
				{ toolCallId: `call-${randomUUID()}`, messages: [], abortSignal },
			) as Promise<{ success: boolean }>;
		const museum = async () => {
			const record = await getArtifact({
				userId,
				artifactId: id,
				conversationId,
			});
			const node = JSON.parse(record?.body ?? "{}").nodes.find(
				(n: { id: string }) => n.id === "note-museum",
			);
			return node?.data?.text as string;
		};
		await tools.read_artifact.execute?.(
			{ artifactId: id, detail: "blocks" },
			{ toolCallId: "call-read", messages: [] },
		);

		// The stop arrives while the edit is being written: the write lands, and the
		// model is told the call failed.
		const stop = new AbortController();
		hooks.stopDuringNextEdit = stop;
		const cutOff = await call(
			[{ op: "update_node", id: "note-museum", data: { text: "First try" } }],
			stop.signal,
		);
		expect(cutOff.success).toBe(false);
		await vi.waitFor(async () => {
			expect(
				(await listVersions({ userId, artifactId: id, conversationId })).length,
			).toBe(2);
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(await museum()).toBe("First try");

		// It never saw that change, so the block it changed reads as changed since.
		const retry = await call([
			{ op: "update_node", id: "note-museum", data: { text: "Second try" } },
		]);

		expect(retry.success).toBe(false);
		expect(await museum()).toBe("First try");
	});
});
