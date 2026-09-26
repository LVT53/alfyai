import { describe, expect, it } from "vitest";
import type { DocumentBlock } from "$lib/shared/artifact-document/blocks";
import {
	buildDocumentAlfyActivity,
	reconstructDocumentPatch,
	type RawAlfyToolCallSegment,
} from "./alfy-activity";

function block(id: string, markdown: string, label = markdown): DocumentBlock {
	return { id, kind: "paragraph", markdown, hash: `hash-${id}`, label };
}

describe("buildDocumentAlfyActivity", () => {
	it("returns null for a tool call that is not create_artifact/edit_artifact", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "research_web",
			status: "done",
			input: {},
		};
		expect(buildDocumentAlfyActivity(segment)).toBeNull();
	});

	it("returns null for an edit_artifact call on a non-document kind", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "edit_artifact",
			status: "done",
			input: { artifactId: "art-1", patches: [] },
			metadata: { ok: true, artifactId: "art-1", artifactKind: "canvas" },
		};
		expect(buildDocumentAlfyActivity(segment)).toBeNull();
	});

	it("returns null for a running create_artifact call (no id exists yet)", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "create_artifact",
			status: "running",
			input: { artifactType: "document", title: "Vienna plan" },
		};
		expect(buildDocumentAlfyActivity(segment)).toBeNull();
	});

	it("is 'running' for an in-flight edit_artifact call, carrying its label", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "edit_artifact",
			callId: "call-1",
			status: "running",
			input: {
				artifactId: "art-1",
				summary: "Add packing list",
				patches: [{ op: "insertText", blockId: "b1", baseHash: "h1", text: "x" }],
			},
		};
		const activity = buildDocumentAlfyActivity(segment);
		expect(activity).toEqual({
			key: "call-1",
			artifactId: "art-1",
			toolName: "edit_artifact",
			status: "running",
			label: "Add packing list",
			patches: [],
			refusedBlocks: [],
			appliedCount: 0,
		});
	});

	it("is 'applied' once an edit_artifact call succeeds with nothing refused", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "edit_artifact",
			callId: "call-2",
			status: "done",
			input: {
				artifactId: "art-1",
				summary: "Add packing list",
				patches: [
					{ op: "insertText", blockId: "b1", baseHash: "h1", text: "Charger" },
				],
			},
			metadata: {
				ok: true,
				artifactId: "art-1",
				artifactKind: "document",
				artifactTitle: "Trip",
				appliedCount: 1,
			},
		};
		const activity = buildDocumentAlfyActivity(segment);
		expect(activity?.status).toBe("applied");
		expect(activity?.appliedCount).toBe(1);
		expect(activity?.refusedBlocks).toEqual([]);
		expect(activity?.patches).toHaveLength(1);
	});

	it("is 'refused' when the output names refused blocks, and reads them from metadata JSON", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "edit_artifact",
			callId: "call-3",
			status: "done",
			input: {
				artifactId: "art-1",
				patches: [
					{ op: "insertText", blockId: "b1", baseHash: "h1", text: "A" },
					{ op: "insertText", blockId: "b2", baseHash: "h2", text: "B" },
				],
			},
			metadata: {
				ok: true,
				artifactId: "art-1",
				artifactKind: "document",
				appliedCount: 1,
				refusedBlocksJson: JSON.stringify([
					{ blockId: "b2", reason: "block_changed" },
				]),
			},
		};
		const activity = buildDocumentAlfyActivity(segment);
		expect(activity?.status).toBe("refused");
		expect(activity?.appliedCount).toBe(1);
		expect(activity?.refusedBlocks).toEqual([
			{ blockId: "b2", reason: "block_changed" },
		]);
	});

	it("is 'failed' when the tool call itself failed", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "edit_artifact",
			callId: "call-4",
			status: "failed",
			input: { artifactId: "art-1" },
		};
		expect(buildDocumentAlfyActivity(segment)?.status).toBe("failed");
	});

	it("is 'failed' when the call settled but the domain result was ok: false", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "edit_artifact",
			callId: "call-5",
			status: "done",
			input: { artifactId: "art-1" },
			metadata: { ok: false, artifactId: "art-1", artifactKind: "document" },
		};
		expect(buildDocumentAlfyActivity(segment)?.status).toBe("failed");
	});

	it("resolves create_artifact's target id and label from metadata/input once done", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "create_artifact",
			callId: "call-6",
			status: "done",
			input: { artifactType: "document", title: "Vienna plan" },
			metadata: {
				ok: true,
				artifactId: "art-new",
				artifactKind: "document",
				artifactTitle: "Vienna plan",
			},
		};
		const activity = buildDocumentAlfyActivity(segment);
		expect(activity?.artifactId).toBe("art-new");
		expect(activity?.status).toBe("applied");
		expect(activity?.label).toBe("Vienna plan");
	});

	it("ignores malformed refusedBlocksJson rather than throwing", () => {
		const segment: RawAlfyToolCallSegment = {
			name: "edit_artifact",
			callId: "call-7",
			status: "done",
			input: { artifactId: "art-1", patches: [] },
			metadata: {
				ok: true,
				artifactId: "art-1",
				artifactKind: "document",
				refusedBlocksJson: "not json",
			},
		};
		expect(() => buildDocumentAlfyActivity(segment)).not.toThrow();
		expect(buildDocumentAlfyActivity(segment)?.refusedBlocks).toEqual([]);
	});
});

describe("reconstructDocumentPatch", () => {
	const previousBlocksById = new Map<string, DocumentBlock>([
		["b1", block("b1", "Old text one", "Old text one")],
		["b2", block("b2", "Old text two", "Old text two")],
	]);

	it("returns null when the activity carries no patches (e.g. create_artifact)", () => {
		expect(
			reconstructDocumentPatch(
				{
					key: "k",
					artifactId: "a",
					toolName: "create_artifact",
					status: "applied",
					label: null,
					patches: [],
					refusedBlocks: [],
					appliedCount: 0,
				},
				previousBlocksById,
			),
		).toBeNull();
	});

	it("marks every non-refused op applied, with an inverse from the PRE-EDIT block text", () => {
		const result = reconstructDocumentPatch(
			{
				key: "call-1",
				artifactId: "a",
				toolName: "edit_artifact",
				status: "applied",
				label: "Add packing list",
				patches: [
					{ op: "insertText", blockId: "b1", baseHash: "hash-b1", text: "New" },
				],
				refusedBlocks: [],
				appliedCount: 1,
			},
			previousBlocksById,
		);
		expect(result).not.toBeNull();
		expect(result?.outcomes).toEqual([
			{
				opId: "call-1-0",
				kind: "insertText",
				blockId: "b1",
				blockLabel: "Old text one",
				status: "applied",
			},
		]);
		expect(result?.inverses).toEqual([
			{ opId: "call-1-0", blockId: "b1", previousMarkdown: "Old text one" },
		]);
		expect(result?.patch.ops[0].blockLabel).toBe("Old text one");
	});

	it("marks a refused op refused, with its reason code, and gives it no inverse", () => {
		const result = reconstructDocumentPatch(
			{
				key: "call-2",
				artifactId: "a",
				toolName: "edit_artifact",
				status: "refused",
				label: null,
				patches: [
					{ op: "insertText", blockId: "b1", baseHash: "hash-b1", text: "A" },
					{ op: "insertText", blockId: "b2", baseHash: "hash-b2", text: "B" },
				],
				refusedBlocks: [{ blockId: "b2", reason: "block_changed" }],
				appliedCount: 1,
			},
			previousBlocksById,
		);
		expect(result?.outcomes).toEqual([
			{
				opId: "call-2-0",
				kind: "insertText",
				blockId: "b1",
				blockLabel: "Old text one",
				status: "applied",
			},
			{
				opId: "call-2-1",
				kind: "insertText",
				blockId: "b2",
				blockLabel: "Old text two",
				status: "refused",
				code: "block_changed",
			},
		]);
		// Only the applied op gets an inverse — a refused op never touched the document.
		expect(result?.inverses).toEqual([
			{ opId: "call-2-0", blockId: "b1", previousMarkdown: "Old text one" },
		]);
	});
});
