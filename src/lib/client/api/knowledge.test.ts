import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "./http";
import {
	submitKnowledgeMemoryAction,
	uploadKnowledgeAttachment,
} from "./knowledge";

describe("knowledge client API", () => {
	it("submits projection-backed memory profile actions", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					resetGeneration: 0,
					projectionRevision: 8,
					categories: [
						{ category: "about_you", items: [] },
						{ category: "preferences", items: [] },
						{ category: "goals_ongoing_work", items: [] },
						{ category: "constraints_boundaries", items: [] },
					],
					review: {
						visibleItems: [],
						openCount: 0,
						overflowCount: 0,
					},
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			submitKnowledgeMemoryAction(
				{
					action: "edit",
					itemId: "item-about",
					statement: "Lives in Rotterdam.",
					expectedProjectionRevision: 7,
				},
				fetchImpl,
			),
		).resolves.toMatchObject({
			projectionRevision: 8,
			categories: [
				{ category: "about_you", items: [] },
				{ category: "preferences", items: [] },
				{ category: "goals_ongoing_work", items: [] },
				{ category: "constraints_boundaries", items: [] },
			],
		});

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/knowledge/memory/actions",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "edit",
					itemId: "item-about",
					statement: "Lives in Rotterdam.",
					expectedProjectionRevision: 7,
				}),
			}),
		);
	});

	it("uploads attachments through the raw file-body endpoint", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						traceId: "trace-upload",
						rawUploadLimit: 1024,
						chunkBodyLimit: 1024 * 1024,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ artifact: { id: "artifact-1" }, promptReady: true }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		const file = new File(["hello"], "note.txt", { type: "text/plain" });

		await expect(
			uploadKnowledgeAttachment(file, "conv-1", fetchImpl),
		).resolves.toEqual({
			artifact: { id: "artifact-1" },
			promptReady: true,
		});

		expect(fetchImpl).toHaveBeenNthCalledWith(
			1,
			"/api/knowledge/upload/intent",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					fileName: file.name,
					fileSize: file.size,
					mimeType: file.type,
					conversationId: "conv-1",
				}),
			}),
		);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"/api/knowledge/upload/raw",
			expect.objectContaining({
				method: "POST",
				body: file,
			}),
		);
		const [, init] = fetchImpl.mock.calls[1];
		expect(init.headers).toMatchObject({
			"Content-Type": "text/plain",
			"X-AlfyAI-Conversation-Id": "conv-1",
			"X-AlfyAI-Upload-Name": "note.txt",
			"X-AlfyAI-Upload-Size": String(file.size),
			"X-AlfyAI-Upload-Trace-Id": "trace-upload",
		});
	});

	it("sends encoded upload metadata headers before multipart parsing", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ traceId: "trace-upload" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ artifact: { id: "artifact-1" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		const file = new File(["hello"], "árvíz tűrő.pdf", {
			type: "application/pdf",
		});

		await uploadKnowledgeAttachment(file, null, fetchImpl);

		const [, init] = fetchImpl.mock.calls[1];
		expect(init.headers).toMatchObject({
			"Content-Type": "application/pdf",
			"X-AlfyAI-Upload-Name": encodeURIComponent(file.name),
			"X-AlfyAI-Upload-Size": String(file.size),
		});
	});

	it("uploads large attachments in small chunks to avoid long request timeouts", async () => {
		const fileBytes = new Uint8Array(2 * 1024 * 1024 + 1);
		const file = new File([fileBytes], "large.pdf", {
			type: "application/pdf",
		});
		const totalChunks = 9;
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify({ traceId: "trace-upload" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		for (let index = 0; index < totalChunks - 1; index += 1) {
			fetchImpl.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						complete: false,
						traceId: "trace-upload",
						receivedBytes: (index + 1) * 256 * 1024,
						totalSize: file.size,
						chunkIndex: index,
						totalChunks,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		}
		fetchImpl.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					complete: true,
					traceId: "trace-upload",
					receivedBytes: file.size,
					totalSize: file.size,
					artifact: { id: "artifact-large" },
					promptReady: true,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			uploadKnowledgeAttachment(file, "conv-1", fetchImpl),
		).resolves.toMatchObject({
			artifact: { id: "artifact-large" },
			promptReady: true,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(totalChunks + 1);
		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"/api/knowledge/upload/chunk",
			expect.objectContaining({
				method: "POST",
				body: expect.any(Blob),
			}),
		);
		const [, firstChunkInit] = fetchImpl.mock.calls[1];
		expect(firstChunkInit.headers).toMatchObject({
			"Content-Type": "application/pdf",
			"X-AlfyAI-Chunk-Index": "0",
			"X-AlfyAI-Chunk-Total": String(totalChunks),
			"X-AlfyAI-Chunk-Start": "0",
			"X-AlfyAI-Chunk-Size": String(256 * 1024),
			"X-AlfyAI-Chunk-Final": "false",
			"X-AlfyAI-Conversation-Id": "conv-1",
			"X-AlfyAI-Upload-Trace-Id": "trace-upload",
		});
		const [, finalChunkInit] = fetchImpl.mock.calls[totalChunks];
		expect(finalChunkInit.headers).toMatchObject({
			"X-AlfyAI-Chunk-Index": String(totalChunks - 1),
			"X-AlfyAI-Chunk-Size": "1",
			"X-AlfyAI-Chunk-Final": "true",
		});
	});

	it("uses chunked upload when the server raw upload limit is below the file size", async () => {
		const fileBytes = new Uint8Array(1024 * 1024 + 1);
		const file = new File([fileBytes], "adapter-limited.pdf", {
			type: "application/pdf",
		});
		const totalChunks = 5;
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					traceId: "trace-upload",
					rawUploadLimit: 1024 * 1024,
					chunkBodyLimit: 1024 * 1024,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		for (let index = 0; index < totalChunks - 1; index += 1) {
			fetchImpl.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						complete: false,
						traceId: "trace-upload",
						receivedBytes: (index + 1) * 256 * 1024,
						totalSize: file.size,
						chunkIndex: index,
						totalChunks,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		}
		fetchImpl.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					complete: true,
					traceId: "trace-upload",
					receivedBytes: file.size,
					totalSize: file.size,
					artifact: { id: "artifact-limited" },
					promptReady: true,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			uploadKnowledgeAttachment(file, "conv-1", fetchImpl),
		).resolves.toMatchObject({
			artifact: { id: "artifact-limited" },
			promptReady: true,
		});

		expect(fetchImpl).toHaveBeenNthCalledWith(
			2,
			"/api/knowledge/upload/chunk",
			expect.objectContaining({
				method: "POST",
				body: expect.any(Blob),
			}),
		);
	});

	it("caps chunk size to the server-reported chunk body limit", async () => {
		const chunkBodyLimit = 64 * 1024;
		const fileBytes = new Uint8Array(2 * chunkBodyLimit + 1);
		const file = new File([fileBytes], "small-chunks.pdf", {
			type: "application/pdf",
		});
		const totalChunks = 3;
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					traceId: "trace-upload",
					rawUploadLimit: 1024,
					chunkBodyLimit,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		for (let index = 0; index < totalChunks - 1; index += 1) {
			fetchImpl.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						complete: false,
						traceId: "trace-upload",
						receivedBytes: (index + 1) * chunkBodyLimit,
						totalSize: file.size,
						chunkIndex: index,
						totalChunks,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);
		}
		fetchImpl.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					complete: true,
					traceId: "trace-upload",
					receivedBytes: file.size,
					totalSize: file.size,
					artifact: { id: "artifact-small-chunks" },
					promptReady: true,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			uploadKnowledgeAttachment(file, "conv-1", fetchImpl),
		).resolves.toMatchObject({
			artifact: { id: "artifact-small-chunks" },
			promptReady: true,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(totalChunks + 1);
		const [, firstChunkInit] = fetchImpl.mock.calls[1];
		expect(firstChunkInit.headers).toMatchObject({
			"X-AlfyAI-Chunk-Total": String(totalChunks),
			"X-AlfyAI-Chunk-Size": String(chunkBodyLimit),
		});
		const [, finalChunkInit] = fetchImpl.mock.calls[totalChunks];
		expect(finalChunkInit.headers).toMatchObject({
			"X-AlfyAI-Chunk-Index": String(totalChunks - 1),
			"X-AlfyAI-Chunk-Size": "1",
			"X-AlfyAI-Chunk-Final": "true",
		});
	});

	it("fails before sending file bytes when the server chunk body limit cannot make progress", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					traceId: "trace-upload",
					rawUploadLimit: 1024,
					chunkBodyLimit: 0,
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		const file = new File([new Uint8Array(1025)], "blocked.pdf", {
			type: "application/pdf",
		});

		await expect(
			uploadKnowledgeAttachment(file, "conv-1", fetchImpl),
		).rejects.toThrow(/chunk size limit is too low/i);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("preserves server-side upload aborted errors", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ traceId: "trace-upload" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						error:
							"Upload was interrupted before the server received the complete file.",
						code: "upload_aborted",
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		await expect(
			uploadKnowledgeAttachment(new File(["x"], "doc.pdf"), null, fetchImpl),
		).rejects.toMatchObject({
			message: expect.stringMatching(/interrupted/i),
			code: "upload_aborted",
		} satisfies Partial<ApiError>);
	});

	it("normalizes browser-side upload aborts into a readable error", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ traceId: "trace-upload" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockRejectedValueOnce(
				new DOMException("The operation was aborted.", "AbortError"),
			);

		await expect(
			uploadKnowledgeAttachment(new File(["x"], "doc.pdf"), null, fetchImpl),
		).rejects.toThrow(/server or reverse proxy may be closing large uploads/i);
	});

	it("normalizes upload gateway failures into deployment guidance", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ traceId: "trace-upload" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("Bad Gateway", {
					status: 502,
					headers: { "Content-Type": "text/plain" },
				}),
			);
		const file = new File(["x"], "large.pdf", { type: "application/pdf" });

		await expect(
			uploadKnowledgeAttachment(file, null, fetchImpl),
		).rejects.toThrow(/reverse proxy body limits\/timeouts/i);
	});
});
