import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createKnowledgeUploadRouteHarness,
	makeKnowledgeUploadEvent,
	makeKnowledgeUploadHeaders,
	makeKnowledgeUploadRequestEvent,
	mockCompleteKnowledgeUploadFromStoredFile,
	mockIsKnowledgeUploadConversationError,
	mockValidateKnowledgeUploadConversation,
} from "../test-helpers";
import { POST } from "./+server";

const harness = createKnowledgeUploadRouteHarness({ userId: "chunk-user" });

describe("POST /api/knowledge/upload/chunk", () => {
	it("accepts non-final chunks without starting extraction", async () => {
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-chunktest",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.complete).toBe(false);
		expect(data.receivedBytes).toBe(5);
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("reports cumulative received bytes across multiple non-final chunks", async () => {
		const firstResponse = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-chunktest",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const firstData = await firstResponse.json();
		const secondResponse = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("world"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-chunktest",
					"x-alfyai-chunk-index": "1",
					"x-alfyai-chunk-start": "5",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const secondData = await secondResponse.json();

		expect(firstResponse.status).toBe(200);
		expect(firstData).toMatchObject({ complete: false, receivedBytes: 5 });
		expect(secondResponse.status).toBe(200);
		expect(secondData).toMatchObject({ complete: false, receivedBytes: 10 });
		expect(harness.consoleInfoSpy).toHaveBeenCalledWith(
			"[KNOWLEDGE] Chunked upload part received",
			expect.objectContaining({
				chunkIndex: 1,
				receivedBytes: 10,
				totalSize: 10,
			}),
		);
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	// The type allowlist runs here too. A client that skips /intent — or one
	// that lies to it and then posts anyway — must not be able to stream bytes
	// of a type the server will never read.
	it.each([
		["clip.mp4", "video/mp4", "media", "knowledge.uploadRejectedMedia"],
		[
			"bundle.zip",
			"application/zip",
			"archive",
			"knowledge.uploadRejectedArchive",
		],
		[
			"scan.ofd",
			"application/ofd",
			"formatNotEnabled",
			"knowledge.uploadRejectedFormatNotEnabled",
		],
		[
			"mystery.qqq",
			"application/octet-stream",
			"unknownType",
			"knowledge.uploadUnsupportedType",
		],
	])("refuses %s with 415 before a single part is written", async (fileName, mimeType, reason, errorKey) => {
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"content-type": mimeType,
					"x-alfyai-upload-trace-id": "upload-chunktype",
					"x-alfyai-upload-name": encodeURIComponent(fileName),
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const data = await response.json();
		const uploadDir = await stat(
			join(
				process.cwd(),
				"data",
				"knowledge",
				harness.userId,
				".incoming",
				"upload-chunktype",
			),
		).catch(() => null);

		expect(response.status).toBe(415);
		expect(data.code).toBe("upload_unsupported_type");
		expect(data.errorKey).toBe(errorKey);
		expect(data.details).toMatchObject({ fileName, reason });
		// Nothing was written, so there is nothing to clean up.
		expect(uploadDir).toBeNull();
		expect(mockValidateKnowledgeUploadConversation).not.toHaveBeenCalled();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("still admits an unknown extension whose declared MIME is text", async () => {
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"content-type": "text/x-diff",
					"x-alfyai-upload-trace-id": "upload-chunktext",
					"x-alfyai-upload-name": encodeURIComponent("fix.patch"),
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);

		expect(response.status).toBe(200);
	});

	it("rejects an invalid conversation before writing a non-final chunk", async () => {
		const error = new Error("Conversation not found or access denied");
		mockValidateKnowledgeUploadConversation.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-chunktest",
					"x-alfyai-conversation-id": "missing-conv",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const data = await response.json();
		const uploadDir = await stat(
			join(
				process.cwd(),
				"data",
				"knowledge",
				harness.userId,
				".incoming",
				"upload-chunktest",
			),
		).catch(() => null);

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			error: "Conversation not found or access denied",
			code: "conversation_not_found",
			traceId: "upload-chunktest",
		});
		expect(uploadDir).toBeNull();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("rejects an invalid conversation before reading the chunk body", async () => {
		const error = new Error("Conversation not found or access denied");
		mockValidateKnowledgeUploadConversation.mockImplementation(
			async (params: { conversationId?: string | null }) => {
				if (params.conversationId === "missing-conv") {
					throw error;
				}
				return params.conversationId?.trim() || null;
			},
		);
		mockIsKnowledgeUploadConversationError.mockImplementation(
			(candidate: unknown) => candidate === error,
		);
		const event = makeKnowledgeUploadEvent({
			body: Buffer.from("hello"),
			headers: makeKnowledgeUploadHeaders({
				"x-alfyai-upload-trace-id": "upload-chunktest",
				"x-alfyai-conversation-id": "missing-conv",
				"x-alfyai-chunk-index": "0",
				"x-alfyai-chunk-start": "0",
				"x-alfyai-chunk-size": "5",
				"x-alfyai-chunk-final": "false",
				"x-alfyai-chunk-total": "2",
			}),
			requestUrl: "http://localhost/api/knowledge/upload/chunk",
			routeId: "/api/knowledge/upload/chunk",
			userId: harness.userId,
		});
		const arrayBufferSpy = vi
			.spyOn(event.request, "arrayBuffer")
			.mockRejectedValue(new Error("chunk body should not be consumed"));

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			error: "Conversation not found or access denied",
			code: "conversation_not_found",
			traceId: "upload-chunktest",
		});
		expect(arrayBufferSpy).not.toHaveBeenCalled();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("rejects declared chunk metadata above the chunk cap before reading the chunk body", async () => {
		const event = makeKnowledgeUploadRequestEvent({
			headers: makeKnowledgeUploadHeaders({
				"x-alfyai-upload-trace-id": "upload-chunktest",
				"x-alfyai-upload-size": String(3 * 1024 * 1024),
				"x-alfyai-chunk-index": "0",
				"x-alfyai-chunk-start": "0",
				"x-alfyai-chunk-size": String(1024 * 1024 + 1),
				"x-alfyai-chunk-final": "false",
				"x-alfyai-chunk-total": "2",
			}),
			requestUrl: "http://localhost/api/knowledge/upload/chunk",
			routeId: "/api/knowledge/upload/chunk",
			userId: harness.userId,
		});
		const arrayBufferSpy = vi
			.spyOn(event.request, "arrayBuffer")
			.mockRejectedValue(new Error("chunk body should not be consumed"));

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(413);
		expect(data).toMatchObject({
			code: "upload_chunk_too_large",
			traceId: "upload-chunktest",
		});
		expect(arrayBufferSpy).not.toHaveBeenCalled();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("rejects a request content length above the chunk cap before reading the chunk body", async () => {
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-chunktest",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
					"content-length": String(1024 * 1024 + 1),
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(413);
		expect(data).toMatchObject({
			code: "upload_chunk_too_large",
			traceId: "upload-chunktest",
		});
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("rejects chunk metadata with a start offset that does not match the chunk index", async () => {
		const event = makeKnowledgeUploadEvent({
			body: Buffer.from("hello"),
			headers: makeKnowledgeUploadHeaders({
				"x-alfyai-upload-trace-id": "upload-chunktest",
				"x-alfyai-chunk-index": "0",
				"x-alfyai-chunk-start": "5",
				"x-alfyai-chunk-size": "5",
				"x-alfyai-chunk-final": "false",
				"x-alfyai-chunk-total": "2",
			}),
			requestUrl: "http://localhost/api/knowledge/upload/chunk",
			routeId: "/api/knowledge/upload/chunk",
			userId: harness.userId,
		});
		const arrayBufferSpy = vi
			.spyOn(event.request, "arrayBuffer")
			.mockRejectedValue(new Error("chunk body should not be consumed"));

		const response = await POST(event);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			code: "chunk_start_invalid",
			traceId: "upload-chunktest",
		});
		expect(arrayBufferSpy).not.toHaveBeenCalled();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("assembles all chunks and completes the knowledge upload on the final chunk", async () => {
		await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-chunktest",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("world"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-chunktest",
					"x-alfyai-chunk-index": "1",
					"x-alfyai-chunk-start": "5",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "true",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.complete).toBe(true);
		expect(mockCompleteKnowledgeUploadFromStoredFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: harness.userId,
				conversationId: "conv-1",
				fileName: "scan.pdf",
				mimeType: "application/pdf",
				sizeBytes: 10,
				binaryHash: createHash("sha256").update("helloworld").digest("hex"),
				tempPathAbsolute: expect.stringContaining("upload-chunktest.assembled"),
				traceId: "upload-chunktest",
				logPrefix: "Chunked",
			}),
		);
	});

	it("rejects chunks whose declared size does not match the received body", async () => {
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("nope"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-chunktest",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe("chunk_size_mismatch");
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("translates intake conversation validation failures on the final chunk", async () => {
		const error = new Error("Conversation not found or access denied");
		mockCompleteKnowledgeUploadFromStoredFile.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-missing-conv",
					"x-alfyai-conversation-id": "missing-conv",
					"x-alfyai-chunk-index": "0",
					"x-alfyai-chunk-start": "0",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "false",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("world"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-missing-conv",
					"x-alfyai-conversation-id": "missing-conv",
					"x-alfyai-chunk-index": "1",
					"x-alfyai-chunk-start": "5",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "true",
					"x-alfyai-chunk-total": "2",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			error: "Conversation not found or access denied",
			code: "conversation_not_found",
			traceId: "upload-missing-conv",
		});
	});
	// Bug B2: assembly is the last moment every part is still on disk. Returning
	// 400 without dropping the part directory left a full copy of the file in
	// `.incoming/<trace>/` that nothing would ever come back for.
	it("drops the part directory when assembly fails", async () => {
		const uploadDir = join(
			process.cwd(),
			"data",
			"knowledge",
			harness.userId,
			".incoming",
			"upload-assembly-fail",
		);

		// Only the LAST part is ever sent, so part-000000 is missing when the
		// route tries to stitch the file back together.
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("world"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-assembly-fail",
					"x-alfyai-chunk-index": "1",
					"x-alfyai-chunk-start": "5",
					"x-alfyai-chunk-size": "5",
					"x-alfyai-chunk-final": "true",
					"x-alfyai-chunk-total": "2",
					"x-alfyai-upload-size": "10",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/chunk",
				routeId: "/api/knowledge/upload/chunk",
				userId: harness.userId,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe("chunk_assembly_failed");
		expect(await stat(uploadDir).catch(() => null)).toBeNull();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});
});
