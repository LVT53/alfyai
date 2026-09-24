import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createKnowledgeUploadRouteHarness,
	makeKnowledgeUploadEvent,
	makeKnowledgeUploadHeaders,
	mockCompleteKnowledgeUploadFromStoredFile,
	mockIsKnowledgeUploadConversationError,
	mockIsKnowledgeUploadProjectError,
	mockValidateKnowledgeUploadConversation,
	mockValidateKnowledgeUploadProject,
} from "../test-helpers";
import { POST } from "./+server";

const harness = createKnowledgeUploadRouteHarness({ userId: "raw-user" });

describe("POST /api/knowledge/upload/raw", () => {
	it("streams the raw file body to temporary storage and persists a source artifact", async () => {
		const bytes = Buffer.from("hello");
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: bytes,
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-rawtest",
					"x-alfyai-upload-name": encodeURIComponent("scan.pdf"),
					"x-alfyai-upload-size": String(bytes.length),
					"x-alfyai-conversation-id": "conv-1",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/raw",
				routeId: "/api/knowledge/upload/raw",
				userId: harness.userId,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.artifact.id).toBe("artifact-1");
		expect(mockCompleteKnowledgeUploadFromStoredFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: harness.userId,
				conversationId: "conv-1",
				fileName: "scan.pdf",
				mimeType: "application/pdf",
				sizeBytes: bytes.length,
				binaryHash: createHash("sha256").update(bytes).digest("hex"),
				tempPathAbsolute: expect.stringContaining(".incoming"),
				traceId: "upload-rawtest",
				logPrefix: "Raw",
			}),
		);
		expect(harness.consoleInfoSpy).toHaveBeenCalledWith(
			"[KNOWLEDGE] Raw upload receive completed",
			expect.objectContaining({
				traceId: "upload-rawtest",
				receivedBytes: bytes.length,
			}),
		);
	});

	// The type allowlist runs here too. /intent is a handshake, not a gate: a
	// client can skip it and post the bytes straight at this route.
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
			"photo.avif",
			"image/avif",
			"convertImage",
			"knowledge.uploadRejectedConvertImage",
		],
		[
			"mystery.qqq",
			"application/octet-stream",
			"unknownType",
			"knowledge.uploadUnsupportedType",
		],
	])("refuses %s with 415 before any byte is written", async (fileName, mimeType, reason, errorKey) => {
		const bytes = Buffer.from("hello");
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: bytes,
				headers: makeKnowledgeUploadHeaders({
					"content-type": mimeType,
					"x-alfyai-upload-trace-id": "upload-rawtype",
					"x-alfyai-upload-name": encodeURIComponent(fileName),
					"x-alfyai-upload-size": String(bytes.length),
				}),
				requestUrl: "http://localhost/api/knowledge/upload/raw",
				routeId: "/api/knowledge/upload/raw",
				userId: harness.userId,
			}),
		);
		const data = await response.json();
		const incoming = await stat(
			join(process.cwd(), "data", "knowledge", harness.userId, ".incoming"),
		).catch(() => null);

		expect(response.status).toBe(415);
		expect(data.code).toBe("upload_unsupported_type");
		expect(data.errorKey).toBe(errorKey);
		expect(data.details).toMatchObject({ fileName, reason });
		// The refusal happens before the temp directory is even created.
		expect(incoming).toBeNull();
		expect(mockValidateKnowledgeUploadConversation).not.toHaveBeenCalled();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("still admits an unknown extension whose declared MIME is text", async () => {
		const bytes = Buffer.from("--- a\n+++ b\n");
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: bytes,
				headers: makeKnowledgeUploadHeaders({
					"content-type": "text/x-diff",
					"x-alfyai-upload-trace-id": "upload-rawtext",
					"x-alfyai-upload-name": encodeURIComponent("fix.patch"),
					"x-alfyai-upload-size": String(bytes.length),
				}),
				requestUrl: "http://localhost/api/knowledge/upload/raw",
				routeId: "/api/knowledge/upload/raw",
				userId: harness.userId,
			}),
		);

		expect(response.status).toBe(200);
		expect(mockCompleteKnowledgeUploadFromStoredFile).toHaveBeenCalled();
	});

	it("rejects raw uploads when the declared browser size does not match received bytes", async () => {
		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-mismatch",
					"x-alfyai-upload-name": "scan.pdf",
					"x-alfyai-upload-size": "6",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/raw",
				routeId: "/api/knowledge/upload/raw",
				userId: harness.userId,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe("upload_size_mismatch");
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("rejects an invalid conversation before writing a raw temporary file", async () => {
		const error = new Error("Conversation not found or access denied");
		mockValidateKnowledgeUploadConversation.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-missing-conv-early",
					"x-alfyai-conversation-id": "missing-conv",
					"x-alfyai-upload-name": "scan.pdf",
					"x-alfyai-upload-size": "5",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/raw",
				routeId: "/api/knowledge/upload/raw",
				userId: harness.userId,
			}),
		);
		const data = await response.json();
		const incomingDir = await stat(
			join(process.cwd(), "data", "knowledge", harness.userId, ".incoming"),
		).catch(() => null);

		expect(response.status).toBe(400);
		expect(data).toMatchObject({
			error: "Conversation not found or access denied",
			code: "conversation_not_found",
			traceId: "upload-missing-conv-early",
		});
		expect(incomingDir).toBeNull();
		expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
	});

	it("translates intake conversation validation failures without changing the public raw-upload response", async () => {
		const error = new Error("Conversation not found or access denied");
		mockCompleteKnowledgeUploadFromStoredFile.mockRejectedValueOnce(error);
		mockIsKnowledgeUploadConversationError.mockReturnValueOnce(true);

		const response = await POST(
			makeKnowledgeUploadEvent({
				body: Buffer.from("hello"),
				headers: makeKnowledgeUploadHeaders({
					"x-alfyai-upload-trace-id": "upload-missing-conv",
					"x-alfyai-conversation-id": "missing-conv",
					"x-alfyai-upload-name": "scan.pdf",
					"x-alfyai-upload-size": "5",
				}),
				requestUrl: "http://localhost/api/knowledge/upload/raw",
				routeId: "/api/knowledge/upload/raw",
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
	// Uploading from inside a project is the same request with one extra header:
	// the file is a library document that happens to be linked to that project.
	describe("uploading into a project", () => {
		it("resolves the project header and hands it to intake", async () => {
			const bytes = Buffer.from("hello");
			const response = await POST(
				makeKnowledgeUploadEvent({
					body: bytes,
					headers: makeKnowledgeUploadHeaders({
						"x-alfyai-upload-trace-id": "upload-rawproject",
						"x-alfyai-upload-name": encodeURIComponent("scan.pdf"),
						"x-alfyai-upload-size": String(bytes.length),
						"x-alfyai-project-id": "trip-project",
					}),
					requestUrl: "http://localhost/api/knowledge/upload/raw",
					routeId: "/api/knowledge/upload/raw",
					userId: harness.userId,
				}),
			);

			expect(response.status).toBe(200);
			expect(mockValidateKnowledgeUploadProject).toHaveBeenCalledWith({
				userId: harness.userId,
				projectId: "trip-project",
			});
			expect(mockCompleteKnowledgeUploadFromStoredFile).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: "trip-project" }),
			);
		});

		it("passes a null project id for an ordinary library upload", async () => {
			const bytes = Buffer.from("hello");
			const response = await POST(
				makeKnowledgeUploadEvent({
					body: bytes,
					headers: makeKnowledgeUploadHeaders({
						"x-alfyai-upload-trace-id": "upload-rawplain",
						"x-alfyai-upload-name": encodeURIComponent("scan.pdf"),
						"x-alfyai-upload-size": String(bytes.length),
					}),
					requestUrl: "http://localhost/api/knowledge/upload/raw",
					routeId: "/api/knowledge/upload/raw",
					userId: harness.userId,
				}),
			);

			expect(response.status).toBe(200);
			expect(mockCompleteKnowledgeUploadFromStoredFile).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: null }),
			);
		});

		it("rejects a project that is not the caller's before writing a raw temporary file", async () => {
			mockValidateKnowledgeUploadProject.mockRejectedValueOnce(
				Object.assign(new Error("Project not found or access denied"), {
					name: "KnowledgeUploadProjectError",
				}),
			);
			mockIsKnowledgeUploadProjectError.mockReturnValueOnce(true);

			const response = await POST(
				makeKnowledgeUploadEvent({
					body: Buffer.from("hello"),
					headers: makeKnowledgeUploadHeaders({
						"x-alfyai-upload-trace-id": "upload-foreign-project",
						"x-alfyai-project-id": "other-project",
						"x-alfyai-upload-name": "scan.pdf",
						"x-alfyai-upload-size": "5",
					}),
					requestUrl: "http://localhost/api/knowledge/upload/raw",
					routeId: "/api/knowledge/upload/raw",
					userId: harness.userId,
				}),
			);
			const data = await response.json();
			const incomingDir = await stat(
				join(process.cwd(), "data", "knowledge", harness.userId, ".incoming"),
			).catch(() => null);

			expect(response.status).toBe(400);
			expect(data).toMatchObject({
				error: "Project not found or access denied",
				code: "invalid_project",
				traceId: "upload-foreign-project",
			});
			expect(incomingDir).toBeNull();
			expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
		});
	});

	// Bug B2: a failed receive must not leave its partial bytes behind. Nothing
	// ever swept `.incoming/`, so every abandoned attempt was permanent.
	describe("temporary file hygiene (B2)", () => {
		async function incomingEntries(): Promise<string[]> {
			return await readdir(
				join(process.cwd(), "data", "knowledge", harness.userId, ".incoming"),
			).catch(() => []);
		}

		it("leaves nothing behind when the declared size does not match", async () => {
			const response = await POST(
				makeKnowledgeUploadEvent({
					body: Buffer.from("hello"),
					headers: makeKnowledgeUploadHeaders({
						"x-alfyai-upload-trace-id": "upload-leak-mismatch",
						"x-alfyai-upload-name": "scan.pdf",
						"x-alfyai-upload-size": "6",
					}),
					requestUrl: "http://localhost/api/knowledge/upload/raw",
					routeId: "/api/knowledge/upload/raw",
					userId: harness.userId,
				}),
			);

			expect(response.status).toBe(400);
			expect(await incomingEntries()).toEqual([]);
		});

		it("leaves nothing behind when the body stream fails mid-transfer", async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.error(new Error("connection reset"));
				},
			});

			const response = await POST(
				makeKnowledgeUploadEvent({
					body,
					headers: makeKnowledgeUploadHeaders({
						"x-alfyai-upload-trace-id": "upload-leak-stream",
						"x-alfyai-upload-name": "scan.pdf",
						"x-alfyai-upload-size": "9",
					}),
					requestUrl: "http://localhost/api/knowledge/upload/raw",
					routeId: "/api/knowledge/upload/raw",
					userId: harness.userId,
				}),
			);

			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(await incomingEntries()).toEqual([]);
			expect(mockCompleteKnowledgeUploadFromStoredFile).not.toHaveBeenCalled();
		});
	});
});
