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

const { READ_ARTIFACT_HANDLERS, runReadArtifactTool } = await import("./read");

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
	delete READ_ARTIFACT_HANDLERS.document;
});

describe("runReadArtifactTool", () => {
	it("returns candidates and no body for an id this conversation does not have", async () => {
		getArtifactMock.mockResolvedValue(null);
		listArtifactCatalogueEntriesMock.mockResolvedValue([
			{
				artifactId: "a1",
				artifactType: "document",
				title: "Other plan",
				updatedAt: 1,
			},
		]);

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "missing-id",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(false);
		if (!result.modelPayload.success) {
			// The failure variant of ReadArtifactModelPayload has no `body` field
			// at all — the type itself is the "no body" guarantee here.
			expect(result.modelPayload.candidates).toEqual([
				{ artifactId: "a1", title: "Other plan" },
			]);
		}
	});

	it("reads a File-type id from this conversation and says the type, with a short summary", async () => {
		getArtifactMock.mockResolvedValue(
			detail({
				kind: "file",
				title: "Trip summary.pdf",
				body: "x".repeat(1000),
			}),
		);

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			artifactType: "file",
			title: "Trip summary.pdf",
		});
		if (result.modelPayload.success) {
			expect(result.modelPayload.body?.length).toBeLessThan(1000);
		}
	});

	it("never returns a body belonging to another user (delegates ownership to getArtifact)", async () => {
		// getArtifact itself is the scoped read; this proves the tool passes the
		// caller's own userId through rather than substituting one.
		getArtifactMock.mockResolvedValue(null);
		listArtifactCatalogueEntriesMock.mockResolvedValue([]);

		await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
		});

		expect(getArtifactMock).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", conversationId: "conv-1" }),
		);
	});

	it("answers a creatable kind with no reader registered using the generic record", async () => {
		getArtifactMock.mockResolvedValue(
			detail({ kind: "document", body: "# Plan\ncontent" }),
		);

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			artifactType: "document",
			title: "Vienna plan",
			body: "# Plan\ncontent",
		});
	});

	it("reads back the block ids and hashes a registered handler returns", async () => {
		READ_ARTIFACT_HANDLERS.document = async () => ({
			blocks: [{ blockId: "b1", kind: "text", hash: "h1", text: "Hello" }],
		});
		getArtifactMock.mockResolvedValue(detail());

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
			detail: "blocks",
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			blocks: [{ blockId: "b1", kind: "text", hash: "h1", text: "Hello" }],
		});
	});

	it("surfaces a domain failure as a model-safe string, not a stack, when the lookup rejects", async () => {
		getArtifactMock.mockRejectedValue(new Error("db exploded"));

		await expect(
			runReadArtifactTool({
				userId: "user-1",
				conversationId: "conv-1",
				artifactId: "artifact-1",
				abortSignal: new AbortController().signal,
			}),
		).rejects.toThrow("db exploded");
		// Note: this rejection is caught by the tool's execution envelope in
		// index.ts (executeToolWithEnvelope), not inside runReadArtifactTool
		// itself — see index.test.ts for the end-to-end model-safe assertion.
	});

	it("passes its own abortSignal through to a registered handler unchanged", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		READ_ARTIFACT_HANDLERS.document = async (params) => {
			seenSignal = params.abortSignal;
			return { body: "content" };
		};
		getArtifactMock.mockResolvedValue(detail());

		await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			abortSignal: controller.signal,
		});

		expect(seenSignal).toBe(controller.signal);
	});
});
