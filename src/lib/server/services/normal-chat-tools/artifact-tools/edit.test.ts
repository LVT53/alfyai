import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactDetail } from "$lib/server/services/artifacts";
import {
	PATCH_OP_KINDS,
	patchOpInputSchema,
} from "$lib/shared/artifact-document/patch";
import { EDIT_ARTIFACT_DOCUMENT_EXAMPLE } from "./kind-prose";

const getArtifactMock =
	vi.fn<
		(params: {
			userId: string;
			artifactId: string;
			conversationId?: string | null;
		}) => Promise<ArtifactDetail | null>
	>();
const listArtifactCatalogueEntriesMock =
	vi.fn<
		(params: { userId: string; conversationId: string }) => Promise<
			Array<{
				artifactId: string;
				artifactType: string;
				title: string;
				updatedAt: number;
			}>
		>
	>();

vi.mock("$lib/server/services/artifacts", () => ({
	getArtifact: (...args: unknown[]) => getArtifactMock(...(args as [never])),
	listArtifactCatalogueEntries: (...args: unknown[]) =>
		listArtifactCatalogueEntriesMock(...(args as [never])),
}));

const {
	documentPatchesArraySchema,
	EDIT_ARTIFACT_HANDLERS,
	editArtifactInputSchema,
	runEditArtifactTool,
} = await import("./edit");

function detail(overrides: Partial<ArtifactDetail> = {}): ArtifactDetail {
	return {
		id: "artifact-1",
		kind: "document",
		title: "Vienna plan",
		conversationId: "conv-1",
		versionNumber: 1,
		commentCount: 0,
		updatedAt: Date.now(),
		body: "# Plan\ncontent",
		bodyHash: "hash-1",
		metadata: { artifactType: "document", title: "Vienna plan" },
		...overrides,
	};
}

afterEach(() => {
	getArtifactMock.mockReset();
	listArtifactCatalogueEntriesMock.mockReset();
	delete EDIT_ARTIFACT_HANDLERS.document;
	delete EDIT_ARTIFACT_HANDLERS.app;
});

describe("editArtifactInputSchema", () => {
	it("caps patches and ops at 40", () => {
		const tooMany = {
			artifactId: "a",
			ops: Array.from({ length: 41 }, () => ({})),
		};
		expect(editArtifactInputSchema.safeParse(tooMany).success).toBe(false);
	});
});

// A dev live check (2026-09-26) found edit_artifact's Document op contract
// undiscoverable: the advertised schema never showed the real `op` values, so
// the model guessed seven wrong synonyms in a row (insert_after, replace,
// update, edit, update_block — never one of the five real ops) and gave up.
// The fix makes `patchOpInputSchema` (patch.ts) the ONE schema both the
// advertised description/schema and this handler's own validator read; these
// pin that the two really are the same schema, not two that happen to agree
// today.
describe("edit_artifact's Document op contract (dev incident, 2026-09-26)", () => {
	it("the description's own worked example parses through the real validator", () => {
		const result = documentPatchesArraySchema.safeParse(
			EDIT_ARTIFACT_DOCUMENT_EXAMPLE.patches,
		);
		expect(result.success).toBe(true);
	});

	it.each([
		{
			op: "replaceBlock",
			blockId: "b1",
			baseHash: "h1",
			text: "New text.",
		},
		{
			op: "insertText",
			blockId: "b1",
			baseHash: "h1",
			text: "More text.",
			at: "end",
		},
		{
			op: "replaceRange",
			blockId: "b1",
			baseHash: "h1",
			find: "old",
			text: "new",
		},
		{ op: "toggleTask", blockId: "b1", baseHash: "h1", checked: true },
		{
			op: "addTableRow",
			blockId: "b1",
			baseHash: "h1",
			cells: ["a", "b"],
		},
	])("the advertised union accepts a real $op example with exactly its fields", (example) => {
		expect(patchOpInputSchema.safeParse(example).success).toBe(true);
	});

	it("PATCH_OP_KINDS lists exactly the five ops the schema's own discriminant accepts", () => {
		expect(PATCH_OP_KINDS).toEqual([
			"replaceBlock",
			"insertText",
			"replaceRange",
			"toggleTask",
			"addTableRow",
		]);
	});

	it("refuses an op name outside the union — the exact guess the real model made on dev", () => {
		const result = patchOpInputSchema.safeParse({
			op: "insert_after",
			blockId: "b1",
			baseHash: "h1",
			text: "x",
		});
		expect(result.success).toBe(false);
	});
});

describe("runEditArtifactTool — structural validation", () => {
	it("refuses when neither patches nor ops is present", async () => {
		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		expect(getArtifactMock).not.toHaveBeenCalled();
	});

	it("refuses when both patches and ops are present", async () => {
		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{}],
			ops: [{}],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		expect(getArtifactMock).not.toHaveBeenCalled();
	});
});

describe("runEditArtifactTool — id resolution", () => {
	it("returns candidates and refuses when the id is not in this conversation", async () => {
		getArtifactMock.mockResolvedValue(null);
		listArtifactCatalogueEntriesMock.mockResolvedValue([
			{
				artifactId: "a1",
				artifactType: "document",
				title: "Other plan",
				updatedAt: 1,
			},
		]);

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "missing-id",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.candidates).toEqual([
				{ artifactId: "a1", title: "Other plan" },
			]);
		}
	});

	it("never edits another user's artifact (delegates ownership to getArtifact)", async () => {
		getArtifactMock.mockResolvedValue(null);
		listArtifactCatalogueEntriesMock.mockResolvedValue([]);

		await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(getArtifactMock).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", conversationId: "conv-1" }),
		);
	});
});

describe("runEditArtifactTool — no kind registered yet (Slice 5a)", () => {
	it("refuses a Document edit with an unsupported_kind reason the model can act on", async () => {
		getArtifactMock.mockResolvedValue(detail({ kind: "document" }));

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.refused).toEqual([
				{ target: "artifact-1", reason: "unsupported_kind" },
			]);
			expect(result.modelPayload.error.length).toBeGreaterThan(0);
		}
	});

	it("refuses an App edit with the regeneration explanation", async () => {
		getArtifactMock.mockResolvedValue(
			detail({ kind: "app", title: "Cost splitter" }),
		);

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			ops: [{ op: "update_node" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			expect(result.modelPayload.error.toLowerCase()).toContain("new app");
		}
	});

	it("refuses a File edit — files are produced, not edited", async () => {
		getArtifactMock.mockResolvedValue(
			detail({ kind: "file", title: "Trip.pdf" }),
		);

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "replace" }],
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
	});
});

describe("runEditArtifactTool — a registered handler", () => {
	it("applies a patch batch and returns the version id, with one refusal per refused op", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: true,
			value: {
				versionId: "version-2",
				applied: 2,
				refused: [{ target: "block-3", reason: "unsupported_kind" as const }],
			},
		});

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }, { op: "b" }, { op: "c" }],
			summary: "Moved the errand block",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload).toEqual({
			success: true,
			artifactId: "artifact-1",
			versionId: "version-2",
			applied: 2,
			refused: [{ target: "block-3", reason: "unsupported_kind" }],
		});
		expect(result.metadata).toEqual({
			ok: true,
			artifactId: "artifact-1",
			artifactKind: "document",
			artifactTitle: "Vienna plan",
			appliedCount: 2,
			refusedBlocksJson: JSON.stringify([
				{ blockId: "block-3", reason: "unsupported_kind" },
			]),
		});
	});

	// T8 live: the browser never sees the full server PatchResult (no
	// inverses, no per-op outcomes) for a live edit_artifact call — only this
	// metadata bag. `refusedBlocksJson` is what an open Document panel
	// reconstructs its refusal notice from (see `document/alfy-activity.ts`),
	// so its shape (an array of plain `{blockId, reason}`, JSON-encoded
	// because `metadata` values must stay flat scalars) is load-bearing.
	it("omits refusedBlocksJson when nothing was refused", async () => {
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async () => ({
			ok: true,
			value: { versionId: "version-2", applied: 3, refused: [] },
		});

		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }, { op: "b" }, { op: "c" }],
			summary: "Moved the errand block",
			abortSignal: new AbortController().signal,
		});

		expect(result.metadata.appliedCount).toBe(3);
		expect(result.metadata).not.toHaveProperty("refusedBlocksJson");
	});

	it("records the summary is passed through to the handler as the version's description", async () => {
		getArtifactMock.mockResolvedValue(detail());
		const handler = vi.fn(async () => ({
			ok: true as const,
			value: { versionId: "version-2", applied: 1, refused: [] },
		}));
		EDIT_ARTIFACT_HANDLERS.document = handler;

		await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }],
			summary: "Moved the errand block",
			abortSignal: new AbortController().signal,
		});

		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ summary: "Moved the errand block" }),
		);
	});

	it("passes its own abortSignal through to a registered handler unchanged", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		getArtifactMock.mockResolvedValue(detail());
		EDIT_ARTIFACT_HANDLERS.document = async (params) => {
			seenSignal = params.abortSignal;
			return {
				ok: true,
				value: { versionId: "version-2", applied: 1, refused: [] },
			};
		};

		await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
			patches: [{ op: "a" }],
			abortSignal: controller.signal,
		});

		expect(seenSignal).toBe(controller.signal);
	});
});
