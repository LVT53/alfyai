import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactDetail } from "$lib/server/services/artifacts";
import { MAX_INLINE_TEXT_CHARS } from "../files";
import { createKnownBoards } from "./canvas-model";

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

	it("reads an App through the same generic fallback — no dedicated reader is registered for it (Task A7)", async () => {
		// An App has no addressable "blocks" (it is not edited in place — see
		// edit.ts's App refusal), so there is nothing a per-kind reader would
		// add over the generic record: the whole point of a dedicated reader is
		// the blocks shape edit_artifact needs, and App never needs one.
		expect(READ_ARTIFACT_HANDLERS.app).toBeUndefined();
		const html = "<!doctype html><html><body>an app</body></html>";
		getArtifactMock.mockResolvedValue(
			detail({ kind: "app", title: "Trip cost splitter", body: html }),
		);

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload).toMatchObject({
			success: true,
			artifactType: "app",
			title: "Trip cost splitter",
			body: html,
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

// Ruling 67 × ruling 47: what a handler says it showed the model (`readBody`) is
// kept for the turn's later edit, and only there.
describe("runReadArtifactTool — what the turn keeps of a read", () => {
	const read = (
		turnContext: Parameters<typeof runReadArtifactTool>[0]["turnContext"],
		signal: AbortSignal = new AbortController().signal,
	) =>
		runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			detail: "blocks",
			turnContext,
			abortSignal: signal,
		});

	it("keeps the words a handler showed, and puts them on neither the model's answer nor the record", async () => {
		const knownBoards = createKnownBoards();
		READ_ARTIFACT_HANDLERS.document = async () => ({
			blocks: [{ blockId: "b1", kind: "text", hash: "h1", text: "Hello" }],
			versionId: "version-1",
			readBody: "the stored words, exactly",
		});
		getArtifactMock.mockResolvedValue(detail());

		const result = await read({ knownBoards });

		expect(knownBoards.get("artifact-1")).toBe("the stored words, exactly");
		expect(JSON.stringify(result.modelPayload)).not.toContain(
			"the stored words",
		);
		expect(JSON.stringify(result.metadata)).not.toContain("the stored words");
		expect(result.metadata).toMatchObject({ versionId: "version-1" });
	});

	it("replaces what it kept with what the next read showed", async () => {
		const knownBoards = createKnownBoards();
		knownBoards.remember("artifact-1", "older words");
		READ_ARTIFACT_HANDLERS.document = async () => ({ readBody: "newer words" });
		getArtifactMock.mockResolvedValue(detail());

		await read({ knownBoards });

		expect(knownBoards.get("artifact-1")).toBe("newer words");
	});

	it("keeps nothing from a read the turn's signal had already cut off: the model was told it failed", async () => {
		const knownBoards = createKnownBoards();
		const controller = new AbortController();
		READ_ARTIFACT_HANDLERS.document = async () => {
			controller.abort();
			return { readBody: "words nobody was shown" };
		};
		getArtifactMock.mockResolvedValue(detail());

		await read({ knownBoards }, controller.signal);

		expect(knownBoards.get("artifact-1")).toBeUndefined();
	});

	it("leaves what it knew alone when the handler showed no words", async () => {
		const knownBoards = createKnownBoards();
		knownBoards.remember("artifact-1", "what it knew");
		READ_ARTIFACT_HANDLERS.document = async () => ({ blocks: [] });
		getArtifactMock.mockResolvedValue(detail());

		await read({ knownBoards });

		expect(knownBoards.get("artifact-1")).toBe("what it knew");
	});

	it("keeps nothing for an id this conversation does not have", async () => {
		const knownBoards = createKnownBoards();
		getArtifactMock.mockResolvedValue(null);
		listArtifactCatalogueEntriesMock.mockResolvedValue([]);

		await read({ knownBoards });

		expect(knownBoards.get("artifact-1")).toBeUndefined();
	});

	it("reads fine when the turn keeps nothing", async () => {
		READ_ARTIFACT_HANDLERS.document = async () => ({ readBody: "words" });
		getArtifactMock.mockResolvedValue(detail());

		const result = await read(undefined);

		expect(result.modelPayload).toMatchObject({ success: true });
	});
});

// A real gap found after the shell shipped: a "full" read had no size bound
// at all — compactModelPayload only strips EMPTY keys, it never truncates —
// so a large stored body or a long block list would be handed to the model
// whole. Bounded here at the same MAX_INLINE_TEXT_CHARS the file tools
// already use for the identical concern (files.ts), rather than a second
// invented number.
describe("runReadArtifactTool — bounding what reaches the model", () => {
	it("clips a large body to the inline cap, reporting truncated:true and the omitted character count", async () => {
		const hugeBody = "x".repeat(MAX_INLINE_TEXT_CHARS + 50_000);
		getArtifactMock.mockResolvedValue(
			detail({ kind: "document", body: hugeBody }),
		);

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(true);
		if (result.modelPayload.success) {
			expect(result.modelPayload.body?.length).toBeLessThanOrEqual(
				MAX_INLINE_TEXT_CHARS + 10, // small allowance for a "..." marker
			);
			expect(result.modelPayload.truncated).toBe(true);
			expect(result.modelPayload.omittedChars).toBe(50_000);
		}
	});

	it("does not report truncation for a body under the cap", async () => {
		getArtifactMock.mockResolvedValue(
			detail({ kind: "document", body: "well under the cap" }),
		);

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(true);
		if (result.modelPayload.success) {
			expect(result.modelPayload.truncated).toBeUndefined();
			expect(result.modelPayload.omittedChars).toBeUndefined();
		}
	});

	it("keeps blocks in order up to the inline cap, then reports truncated:true and the omitted block count", async () => {
		// Each block serializes to ~1,010 chars; comfortably more than
		// MAX_INLINE_TEXT_CHARS / 1000 of them overflows the cap.
		const blockCount = 200;
		const blocks = Array.from({ length: blockCount }, (_, i) => ({
			blockId: `b${i}`,
			kind: "text",
			hash: `h${i}`,
			text: "y".repeat(1000),
		}));
		READ_ARTIFACT_HANDLERS.document = async () => ({ blocks });
		getArtifactMock.mockResolvedValue(detail({ kind: "document" }));

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			detail: "blocks",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(true);
		if (result.modelPayload.success) {
			const kept = result.modelPayload.blocks ?? [];
			expect(kept.length).toBeGreaterThan(0);
			expect(kept.length).toBeLessThan(blockCount);
			// Every kept block is a real, unmodified block, in original order.
			expect(kept).toEqual(blocks.slice(0, kept.length));
			expect(result.modelPayload.truncated).toBe(true);
			expect(result.modelPayload.omittedBlocks).toBe(blockCount - kept.length);
		}
	});

	it("does not report truncation for a short block list", async () => {
		const blocks = [{ blockId: "b1", kind: "text", hash: "h1", text: "Hello" }];
		READ_ARTIFACT_HANDLERS.document = async () => ({ blocks });
		getArtifactMock.mockResolvedValue(detail({ kind: "document" }));

		const result = await runReadArtifactTool({
			userId: "user-1",
			conversationId: "conv-1",
			artifactId: "artifact-1",
			detail: "blocks",
			abortSignal: new AbortController().signal,
		});

		expect(result.modelPayload.success).toBe(true);
		if (result.modelPayload.success) {
			expect(result.modelPayload.blocks).toEqual(blocks);
			expect(result.modelPayload.truncated).toBeUndefined();
			expect(result.modelPayload.omittedBlocks).toBeUndefined();
		}
	});
});
