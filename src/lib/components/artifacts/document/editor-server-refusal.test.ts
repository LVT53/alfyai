/**
 * T7.4's named proof (`slice-1.md` Task T7, Step 1.4): "the user's edit is
 * what the next `read_artifact` sees" — through the REAL editor, not hand-
 * built Markdown strings. `tests/integration/artifact-document.test.ts`
 * already proves the server-side refusal engine's `block_changed` path with
 * plain strings (T3's own version of this same proof); this file proves the
 * BROWSER half — that `readMarkdown(editor)` → `parseDocument` →
 * `serializeDocument` (exactly `DocumentBody.svelte`'s own save path,
 * `currentCanonicalMarkdown`) produces text the server's hash guard agrees
 * with, end to end: create → Alfy reads (snapshot) → the user types in a
 * REAL Tiptap instance → the user's save lands → Alfy's patch against the
 * PRE-EDIT hash is refused `block_changed`, and the user's edit — the exact
 * bytes the editor produced — is what is actually stored.
 *
 * A real, migrated database (no mocked `$lib/server/db`), like
 * `tests/integration/artifact-document.test.ts` — this is what makes the
 * refusal proof real rather than a mock agreeing with itself.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { artifacts, conversations, users } from "$lib/server/db/schema";
import {
	applyDocumentPatch,
	createDocumentArtifact,
	readDocumentForAlfy,
	saveDocumentBody,
} from "$lib/server/services/artifacts";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import type { PatchOp, PatchSet } from "$lib/shared/artifact-document/patch";
import { createDocumentEditor, readMarkdown } from "./document-editor";

const NOW = new Date("2026-09-26T09:00:00.000Z");

let userId: string;
let conversationId: string;
let element: HTMLElement | null = null;

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

function seedConversation(id: string, ownerId: string) {
	db.insert(conversations)
		.values({
			id,
			userId: ownerId,
			title: "Trip",
			memoryIncognito: false,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function rawContentText(artifactId: string): string {
	return (
		db
			.select({ contentText: artifacts.contentText })
			.from(artifacts)
			.where(eq(artifacts.id, artifactId))
			.get()?.contentText ?? ""
	);
}

beforeEach(() => {
	userId = `user-${randomUUID()}`;
	conversationId = `conv-${randomUUID()}`;
	seedUser(userId);
	seedConversation(conversationId, userId);
});

afterEach(() => {
	element?.remove();
	element = null;
});

/** `DocumentBody.svelte`'s own save path, verbatim (T7.2). */
function canonicalFromEditor(
	editor: ReturnType<typeof createDocumentEditor>,
): string {
	return serializeDocument(parseDocument(readMarkdown(editor)).blocks);
}

describe("the real editor's output through the server's block_changed refusal", () => {
	it("a patch addressed with the pre-edit hash is refused after a real editor save, and the editor's own bytes are what is stored", async () => {
		const created = await createDocumentArtifact({
			userId,
			conversationId,
			title: "Saturday plan",
			markdown: "First paragraph.\n\nSecond paragraph.",
			author: "alfy",
			summary: "Alfy wrote the first draft",
		});

		// Alfy reads first (writes the snapshot) — this is the hash a LATER
		// patch will (wrongly) try to use.
		const read = await readDocumentForAlfy({
			userId,
			artifactId: created.id,
			conversationId,
		});
		const target = read.blocks.find((b) => b.text.includes("First paragraph"));
		expect(target).toBeDefined();
		const preEditHash = target?.hash ?? "";

		// The user opens a REAL editor on the CURRENT stored body and edits the
		// same block Alfy just read.
		element = document.createElement("div");
		document.body.appendChild(element);
		const editor = createDocumentEditor({
			element,
			markdown: created.body ?? "",
			placeholder: "Write anything, or ask Alfy to.",
		});
		const beforeEdit = parseDocument(readMarkdown(editor), { mint: false });
		const firstBlock = beforeEdit.blocks.find((b) =>
			b.markdown.includes("First paragraph"),
		);
		expect(firstBlock).toBeDefined();

		let targetPos: number | null = null;
		editor.state.doc.forEach((node, offset) => {
			if (targetPos !== null) return;
			if (node.attrs?.blockId === firstBlock?.id) {
				targetPos = offset + node.nodeSize - 1;
			}
		});
		expect(targetPos).not.toBeNull();
		editor.commands.insertContentAt(targetPos ?? 0, " — changed by the user");

		// The user's own save: DocumentBody.svelte's exact canonicalisation path.
		const canonical = canonicalFromEditor(editor);
		const saveResult = await saveDocumentBody({
			userId,
			artifactId: created.id,
			conversationId,
			body: { markdown: canonical, tabs: [] },
			author: "user",
			summary: "the user's edit",
		});
		expect(saveResult.ok).toBe(true);
		editor.destroy();

		// Alfy now tries to patch the SAME block using the hash from its EARLIER
		// read — stale the moment the user's save landed.
		const op: PatchOp = {
			opId: `op-${randomUUID()}`,
			kind: "replaceBlock",
			blockId: target?.blockId ?? "",
			baseHash: preEditHash,
			text: "Alfy's own change",
			blockLabel: "block",
		};
		const patch: PatchSet = {
			patchId: "p-1",
			label: "Alfy's patch",
			ops: [op],
		};
		const patchResult = await applyDocumentPatch({
			userId,
			artifactId: created.id,
			conversationId,
			patch,
		});

		expect(patchResult.ok).toBe(true);
		if (patchResult.ok) {
			expect(patchResult.result.applied).toBe(0);
			expect(patchResult.result.outcomes[0].code).toBe("block_changed");
		}

		const stored = rawContentText(created.id);
		expect(stored).toContain("changed by the user");
		expect(stored).not.toContain("Alfy's own change");
		// The stored bytes are EXACTLY the canonical form the browser posted —
		// no server-side re-canonicalisation silently rewrote them differently.
		expect(stored).toBe(canonical);
	});
});
