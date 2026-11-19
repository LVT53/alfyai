/**
 * The refusals create_artifact.canvas makes after the board's own vocabulary has
 * accepted the body: the store's size limits, a board that would have lost
 * blocks, a title it will not take, and a stop between the checks and the write.
 * The store is stubbed: its limits sit past what the vocabulary lets through
 * (canvas-handlers.test.ts holds the real database's refusals), so none of these
 * can be reached with a real body. Each refusal names itself beside the words
 * the model reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareCanvasBoardMock = vi.fn();
const createArtifactMock = vi.fn();

vi.mock("$lib/server/services/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/services/artifacts")>()),
	prepareCanvasBoard: (...args: unknown[]) => prepareCanvasBoardMock(...args),
	createArtifact: (...args: unknown[]) => createArtifactMock(...args),
}));

import { CREATE_ARTIFACT_HANDLERS } from "./create";

const preparedBoard = (dropped: string[] = []) => ({
	ok: true as const,
	body: { nodes: [], edges: [] },
	json: "{}",
	hash: "hash",
	dropped: { nodes: dropped, edges: [], annotations: [] },
	repaired: [],
});

function make(signal: AbortSignal = new AbortController().signal) {
	const handler = CREATE_ARTIFACT_HANDLERS.canvas;
	if (!handler) throw new Error("no canvas create handler is registered");
	return handler({
		userId: "user-1",
		conversationId: "conv-1",
		turnId: "turn-1",
		title: "Board",
		body: "{}",
		abortSignal: signal,
	});
}

beforeEach(() => {
	prepareCanvasBoardMock.mockReset();
	createArtifactMock.mockReset();
});

describe("create_artifact.canvas — what the store refuses", () => {
	it.each([
		"too_large",
		"too_many_nodes",
	])("names a board past the store's limit (%s) too_large, in the words it always had", async (reason) => {
		prepareCanvasBoardMock.mockReturnValue({ ok: false, reason });

		expect(await make()).toEqual({
			ok: false,
			reason:
				"The board is larger than a board may be. Make it smaller: fewer or shorter blocks.",
			code: "too_large",
		});
		expect(createArtifactMock).not.toHaveBeenCalled();
	});

	it("names a board the store cannot read request_adjusted", async () => {
		prepareCanvasBoardMock.mockReturnValue({
			ok: false,
			reason: "invalid_body",
		});

		expect(await make()).toEqual({
			ok: false,
			reason:
				"The board could not be read. Send it as a JSON object with nodes and edges.",
			code: "request_adjusted",
		});
	});

	it("names a board that would have lost blocks request_adjusted, and makes nothing", async () => {
		prepareCanvasBoardMock.mockReturnValue(preparedBoard(["n1", "n2"]));

		const result = await make();

		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringContaining("the board would have left out n1, n2"),
			code: "request_adjusted",
		});
		expect(createArtifactMock).not.toHaveBeenCalled();
	});

	it("names a stop between the checks and the write stopped, and writes nothing", async () => {
		const controller = new AbortController();
		prepareCanvasBoardMock.mockImplementation(() => {
			controller.abort();
			return preparedBoard();
		});

		expect(await make(controller.signal)).toEqual({
			ok: false,
			reason: "The request was cancelled.",
			code: "stopped",
		});
		expect(createArtifactMock).not.toHaveBeenCalled();
	});

	it("names a title the store would not take request_adjusted, and any other refusal of the write nothing", async () => {
		prepareCanvasBoardMock.mockReturnValue(preparedBoard());

		createArtifactMock.mockResolvedValueOnce({
			ok: false,
			reason: "invalid_title",
		});
		expect(await make()).toEqual({
			ok: false,
			reason: "The board needs a title.",
			code: "request_adjusted",
		});

		createArtifactMock.mockResolvedValueOnce({
			ok: false,
			reason: "not_found",
		});
		expect(await make()).toEqual({
			ok: false,
			reason: "Could not create the board.",
		});
	});
});
