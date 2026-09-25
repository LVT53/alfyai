import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactDetail } from "$lib/server/services/artifacts";

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

const { EDIT_ARTIFACT_HANDLERS, editArtifactInputSchema, runEditArtifactTool } =
	await import("./edit");

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

describe("runEditArtifactTool — structural validation", () => {
	it("refuses when neither patches nor ops is present", async () => {
		const result = await runEditArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			turnId: "turn-1",
			artifactId: "artifact-1",
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
		});
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
		});

		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ summary: "Moved the errand block" }),
		);
	});
});
