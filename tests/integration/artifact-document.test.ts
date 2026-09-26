// The Document type against a real, migrated database (Slice 1) — no mocked
// `$lib/server/db`, the same connection bootstrap the server uses. This is
// where the reload trap and the canonical-form-at-rest trap live: both are
// invisible to a pure unit test because they are about what actually got
// written to `content_text`, not about what a function returns in memory.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import {
	artifactKv,
	artifacts,
	artifactVersions,
	conversations,
	users,
} from "$lib/server/db/schema";
import {
	applyDocumentPatch,
	createArtifact,
	createDocumentArtifact,
	getArtifact,
	readDocumentForAlfy,
	restoreVersion,
	saveDocumentBody,
	updateArtifactBody,
} from "$lib/server/services/artifacts";
import {
	buildIndex,
	countMarkers,
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import type { PatchOp, PatchSet } from "$lib/shared/artifact-document/patch";

const NOW = new Date("2026-09-25T10:00:00.000Z");

let userId: string;
let strangerId: string;
let conversationId: string;
let incognitoConversationId: string;

function seedUser(id: string) {
	db.insert(users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedConversation(id: string, ownerId: string, incognito = false) {
	db.insert(conversations)
		.values({
			id,
			userId: ownerId,
			title: "Vienna trip",
			memoryIncognito: incognito,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

beforeEach(() => {
	userId = `user-${randomUUID()}`;
	strangerId = `stranger-${randomUUID()}`;
	conversationId = `conv-${randomUUID()}`;
	incognitoConversationId = `conv-incog-${randomUUID()}`;
	seedUser(userId);
	seedUser(strangerId);
	seedConversation(conversationId, userId);
	seedConversation(incognitoConversationId, userId, true);
});

afterEach(() => {
	db.delete(users).where(eq(users.id, userId)).run();
	db.delete(users).where(eq(users.id, strangerId)).run();
});

function rawContentText(artifactId: string): string {
	return (
		db
			.select({ contentText: artifacts.contentText })
			.from(artifacts)
			.where(eq(artifacts.id, artifactId))
			.get()?.contentText ?? ""
	);
}

function versionCount(artifactId: string): number {
	return db
		.select({ id: artifactVersions.id })
		.from(artifactVersions)
		.where(eq(artifactVersions.artifactId, artifactId))
		.all().length;
}

function op(
	overrides: Partial<PatchOp> & Pick<PatchOp, "blockId" | "baseHash" | "kind">,
): PatchOp {
	return {
		opId: overrides.opId ?? `op-${randomUUID()}`,
		blockLabel: overrides.blockLabel ?? "block",
		...overrides,
	};
}

describe("the Document type on a real database", () => {
	it("createDocumentArtifact writes one marker per block, and the first version is the created body", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Saturday plan",
			markdown: "# Saturday\n\nMuseum in the morning.\n\n- [ ] Book tickets",
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});

		const stored = rawContentText(created.id);
		const parsed = parseDocument(stored, { mint: false });
		expect(countMarkers(stored)).toBe(parsed.blocks.length);
		expect(parsed.blocks.every((b) => b.id.length > 0)).toBe(true);

		const versions = db
			.select()
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, created.id))
			.all();
		expect(versions).toHaveLength(1);
		expect(versions[0].body).toBe(stored);
	});

	it("preserves ids from Markdown that already carries markers, and two creations from the same plain input do not share ids", async () => {
		const withMarkers = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Notes",
			markdown: "<!--b:pfixed1-->\nHello there.",
			author: "user",
			summary: "x",
		});
		const parsed = parseDocument(rawContentText(withMarkers.id), {
			mint: false,
		});
		expect(parsed.blocks[0].id).toBe("pfixed1");

		const first = await createDocumentArtifact({
			userId,
			conversationId,
			title: "A",
			markdown: "Plain paragraph, no markers.",
			author: "user",
			summary: "x",
		});
		const second = await createDocumentArtifact({
			userId,
			conversationId,
			title: "B",
			markdown: "Plain paragraph, no markers.",
			author: "user",
			summary: "x",
		});
		const firstIds = parseDocument(rawContentText(first.id), {
			mint: false,
		}).blocks.map((b) => b.id);
		const secondIds = parseDocument(rawContentText(second.id), {
			mint: false,
		}).blocks.map((b) => b.id);
		expect(firstIds[0]).not.toBe(secondIds[0]);
	});

	it("readDocumentForAlfy returns marker-free text and writes the snapshot with exactly those hashes", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Saturday plan",
			markdown: "# Saturday\n\nMuseum in the morning.",
			author: "alfy",
			summary: "x",
		});

		const read = await readDocumentForAlfy({
			userId,
			artifactId: created.id,
			conversationId,
		});
		expect(read.blocks.length).toBeGreaterThan(0);
		for (const block of read.blocks) {
			expect(block.text).not.toContain("<!--b:");
			expect(block.blockId.length).toBeGreaterThan(0);
			expect(block.hash.length).toBeGreaterThan(0);
		}

		const kv = db
			.select({ valueJson: artifactKv.valueJson })
			.from(artifactKv)
			.where(eq(artifactKv.artifactId, created.id))
			.get();
		expect(kv).toBeDefined();
		const stored = JSON.parse(kv?.valueJson ?? "{}");
		const expectedIndex = Object.fromEntries(
			read.blocks.map((b) => [b.blockId, b.hash]),
		);
		expect(stored.index).toEqual(expectedIndex);
	});

	// [trap] The reload path: create, read the RAW stored string back (as a
	// fresh server process would after a restart), parse it fresh, and patch
	// using hashes taken from that fresh parse. If ids were minted lazily
	// instead of at parse time, this is exactly the read that would come back
	// with no stable identity, and the patch below would refuse everything.
	it("REGRESSION: a patch built from a fresh reload of the stored text applies (the prototype's real bug)", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Saturday plan",
			markdown: "First paragraph.\n\nSecond paragraph.",
			author: "alfy",
			summary: "x",
		});

		// Simulate a fresh process: read only the raw string, parse it as if
		// nothing else was known about the document.
		const reloaded = parseDocument(rawContentText(created.id), { mint: false });
		expect(reloaded.minted).toBe(false);
		const [p1, p2] = reloaded.blocks;

		const patch: PatchSet = {
			patchId: "patch-1",
			label: "Edit both",
			ops: [
				op({
					kind: "replaceBlock",
					blockId: p1.id,
					baseHash: p1.hash,
					text: "Changed first.",
				}),
				op({
					kind: "replaceBlock",
					blockId: p2.id,
					baseHash: p2.hash,
					text: "Changed second.",
				}),
			],
		};

		// Alfy must read first (writes the snapshot), exactly as the tool does.
		await readDocumentForAlfy({
			userId,
			artifactId: created.id,
			conversationId,
		});
		const result = await applyDocumentPatch({
			userId,
			artifactId: created.id,
			conversationId,
			patch,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result.applied).toBe(2);
			expect(result.result.refused).toBe(0);
		}
	});

	it("refuses block_changed after a user edit through saveDocumentBody, and the stored body does not move", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Saturday plan",
			markdown: "First paragraph.",
			author: "alfy",
			summary: "x",
		});
		const read = await readDocumentForAlfy({
			userId,
			artifactId: created.id,
			conversationId,
		});
		const [block] = read.blocks;

		// The user edits the SAME block directly (not through Alfy) after the read.
		const artifact = await getArtifact({
			userId,
			artifactId: created.id,
			conversationId,
		});
		const parsedBeforeUserEdit = parseDocument(artifact?.body ?? "", {
			mint: false,
		});
		const edited = parsedBeforeUserEdit.blocks.map((b) =>
			b.id === block.blockId ? { ...b, markdown: "The user changed this." } : b,
		);
		await saveDocumentBody({
			userId,
			artifactId: created.id,
			conversationId,
			body: { markdown: serializeDocument(edited), tabs: [] },
			author: "user",
			summary: "the user's edit",
		});
		const versionsBeforePatch = versionCount(created.id);

		const patch: PatchSet = {
			patchId: "patch-2",
			label: "Stale edit",
			ops: [
				op({
					kind: "replaceBlock",
					blockId: block.blockId,
					baseHash: block.hash,
					text: "Alfy's change",
				}),
			],
		};
		const result = await applyDocumentPatch({
			userId,
			artifactId: created.id,
			conversationId,
			patch,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result.applied).toBe(0);
			expect(result.result.outcomes[0].code).toBe("block_changed");
		}
		expect(rawContentText(created.id)).toContain("The user changed this.");
		expect(rawContentText(created.id)).not.toContain("Alfy's change");
		// The user's edit is the only version that grew the count; Alfy's
		// all-refused patch writes nothing.
		expect(versionCount(created.id)).toBe(versionsBeforePatch);
	});

	it("saveDocumentBody with a stale expectVersion returns version_conflict and writes nothing", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Plan",
			markdown: "Text.",
			author: "alfy",
			summary: "x",
		});
		const before = rawContentText(created.id);

		const result = await saveDocumentBody({
			userId,
			artifactId: created.id,
			conversationId,
			body: { markdown: "Clobbered.", tabs: [] },
			author: "user",
			summary: "x",
			expectVersion: 99,
		});

		expect(result).toEqual({ ok: false, reason: "version_conflict" });
		expect(rawContentText(created.id)).toBe(before);
	});

	// [trap] Ownership: another user, another kind, and an incognito artifact
	// read from outside its own conversation must all answer alike.
	it("applyDocumentPatch: not_found for another user, not_a_document for a non-document, not_found for incognito from outside", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Plan",
			markdown: "Text.",
			author: "alfy",
			summary: "x",
		});
		const patch: PatchSet = { patchId: "p", label: "l", ops: [] };

		await expect(
			applyDocumentPatch({ userId: strangerId, artifactId: created.id, patch }),
		).resolves.toEqual({ ok: false, reason: "not_found" });

		const canvasResult = await createArtifact({
			userId,
			conversationId,
			kind: "canvas",
			title: "Board",
			body: "{}",
			author: "user",
		});
		if (!canvasResult.ok) throw new Error("canvas creation refused");
		await expect(
			applyDocumentPatch({
				userId,
				artifactId: canvasResult.artifact.id,
				conversationId,
				patch,
			}),
		).resolves.toEqual({ ok: false, reason: "not_a_document" });

		const hidden = await createDocumentArtifact({
			userId,
			conversationId: incognitoConversationId,
			title: "Secret",
			markdown: "Shh.",
			author: "user",
			summary: "x",
		});
		await expect(
			applyDocumentPatch({ userId, artifactId: hidden.id, patch }),
		).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("restoring a version writes a new version and does not re-mint block ids", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Plan",
			markdown: "Original text.",
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});
		const originalIds = parseDocument(rawContentText(created.id), {
			mint: false,
		}).blocks.map((b) => b.id);

		await updateArtifactBody({
			userId,
			artifactId: created.id,
			conversationId,
			body: "Edited text.",
			author: "user",
			summary: "An edit",
		});
		const firstVersion = db
			.select()
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, created.id))
			.all()
			.find((v) => v.versionNumber === 1);
		if (!firstVersion) throw new Error("no first version");

		const restoreResult = await restoreVersion({
			userId,
			artifactId: created.id,
			conversationId,
			versionId: firstVersion.id,
		});
		expect(restoreResult.ok).toBe(true);

		const versions = db
			.select()
			.from(artifactVersions)
			.where(eq(artifactVersions.artifactId, created.id))
			.all();
		expect(versions).toHaveLength(3);
		const restored = versions.find((v) => v.versionNumber === 3);
		expect(restored?.summary).toContain("Alfy wrote the first draft");
		expect(rawContentText(created.id)).toBe(
			"Original text.".length ? firstVersion.body : "",
		);
		const restoredIds = parseDocument(rawContentText(created.id), {
			mint: false,
		}).blocks.map((b) => b.id);
		expect(restoredIds).toEqual(originalIds);
	});

	it("artifact_kv['alfy.snapshot'] is unreadable outside a scoped read", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Plan",
			markdown: "Text.",
			author: "alfy",
			summary: "x",
		});
		await readDocumentForAlfy({
			userId,
			artifactId: created.id,
			conversationId,
		});

		// Another user cannot reach it through the same operation.
		await expect(
			readDocumentForAlfy({ userId: strangerId, artifactId: created.id }),
		).rejects.toThrow();
	});

	// [trap, ruling 12] The stored body must already be canonical: a reload
	// with no user edit must not rewrite a single byte, or the very next patch
	// would refuse on a document nobody touched.
	it("the stored body is already canonical — a reload rewrites nothing", async () => {
		const messyMarkdown = [
			"# Trip",
			"",
			"* one",
			"+ two",
			"",
			"| a  |   b |",
			"| -- | --- |",
			"| 1  | 2   |",
			"",
			"",
			"",
			"Trailing blank runs above.",
		].join("\n");

		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Trip",
			markdown: messyMarkdown,
			author: "user",
			summary: "x",
		});

		const stored = rawContentText(created.id);
		const reparsed = parseDocument(stored, { mint: false });
		expect(serializeDocument(reparsed.blocks)).toBe(stored);
		const rereparsed = parseDocument(stored, { mint: false });
		expect(buildIndex(rereparsed.blocks)).toEqual(buildIndex(reparsed.blocks));
	});

	// [trap] Body, version and snapshot are one transaction: force a failure
	// partway through and prove none of the three moved.
	it("writes nothing when a step partway through saveDocumentBody's transaction throws", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Plan",
			markdown: "Text.",
			author: "alfy",
			summary: "x",
		});
		const before = rawContentText(created.id);
		const versionsBefore = versionCount(created.id);

		await expect(
			updateArtifactBody({
				userId,
				artifactId: created.id,
				conversationId,
				body: "attempted edit",
				author: "alfy",
				summary: "x",
				snapshot: { at: 1, docVersion: 1, index: {} },
				metadataPatch: { poison: 10n as unknown as number },
			}),
		).rejects.toThrow();

		expect(rawContentText(created.id)).toBe(before);
		expect(versionCount(created.id)).toBe(versionsBefore);
		const kv = db
			.select({ id: artifactKv.id })
			.from(artifactKv)
			.where(eq(artifactKv.artifactId, created.id))
			.get();
		expect(kv).toBeUndefined();
	});
});

// RV-1A (independent review of Slice 1's engine and server side): each case
// was red before its fix; docs/plans/claude-at-home-2/review-1a.md quotes it.
describe("RV-1A: the Document's writes on a real database", () => {
	it("two Alfy edits running at once both land: neither writes over a body it did not read", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Trip",
			markdown: "Alpha.\n\nBeta.",
			author: "alfy",
			summary: "x",
		});
		const read = await readDocumentForAlfy({
			userId,
			artifactId: created.id,
			conversationId,
		});
		const [alpha, beta] = read.blocks;
		const patchFor = (
			block: (typeof read.blocks)[number],
			text: string,
		): PatchSet => ({
			patchId: `patch-${block.blockId}`,
			label: "Edit",
			ops: [
				op({
					kind: "replaceBlock",
					blockId: block.blockId,
					baseHash: block.hash,
					text,
				}),
			],
		});

		// The AI SDK runs a step's tool calls concurrently: two edit_artifact
		// calls in one step reach applyDocumentPatch in the same tick.
		const [first, second] = await Promise.all([
			applyDocumentPatch({
				userId,
				artifactId: created.id,
				conversationId,
				patch: patchFor(alpha, "Alpha changed."),
			}),
			applyDocumentPatch({
				userId,
				artifactId: created.id,
				conversationId,
				patch: patchFor(beta, "Beta changed."),
			}),
		]);
		expect(first.ok && first.result.applied).toBe(1);
		expect(second.ok && second.result.applied).toBe(1);

		const stored = parseDocument(rawContentText(created.id), { mint: false });
		expect(stored.blocks.map((block) => block.markdown)).toEqual([
			"Alpha changed.",
			"Beta changed.",
		]);
		expect(versionCount(created.id)).toBe(3);
	});

	it("a user's save landing inside an Alfy edit's read→write window wins: the edit is re-checked, never written over it", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Trip",
			markdown: "Alpha.\n\nBeta.",
			author: "alfy",
			summary: "x",
		});
		const read = await readDocumentForAlfy({
			userId,
			artifactId: created.id,
			conversationId,
		});
		const beta = read.blocks[1];
		const userBody = rawContentText(created.id).replace(
			"Beta.",
			"Beta, as the user wrote it.",
		);

		const [save, edit] = await Promise.all([
			saveDocumentBody({
				userId,
				artifactId: created.id,
				conversationId,
				body: { markdown: userBody, tabs: [] },
				author: "user",
				summary: "Edited",
				coalesceUserEdits: true,
			}),
			applyDocumentPatch({
				userId,
				artifactId: created.id,
				conversationId,
				patch: {
					patchId: "p",
					label: "Alfy",
					ops: [
						op({
							kind: "replaceBlock",
							blockId: beta.blockId,
							baseHash: beta.hash,
							text: "Beta, as Alfy wrote it.",
						}),
					],
				},
			}),
		]);
		expect(save.ok).toBe(true);
		expect(edit.ok && edit.result.outcomes[0].code).toBe("block_changed");
		expect(rawContentText(created.id)).toContain("Beta, as the user wrote it.");
	});
});
