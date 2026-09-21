import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXTRACTION_STATUS_BATCH_LIMIT } from "$lib/shared/extraction-status";
import {
	disabledFileTypeIds,
	resetDisabledFileTypeIds,
} from "$lib/stores/upload-format-gate";
import {
	maxFileUploadSizeBytes,
	resetMaxFileUploadSize,
} from "$lib/stores/upload-limits";
import type { ApiError } from "./http";
import {
	cancelExtraction,
	fetchExtractionJobs,
	fetchMemoryProfileItemDetail,
	retryExtraction,
	submitKnowledgeMemoryAction,
	uploadKnowledgeAttachment,
	uploadRefusalFromError,
} from "./knowledge";

describe("knowledge client API", () => {
	beforeEach(() => {
		resetMaxFileUploadSize();
		resetDisabledFileTypeIds();
	});

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

	it("loads a memory profile item detail", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: "item-about",
					itemKey: "about",
					category: "about_you",
					statement: "Lives in Amsterdam.",
					scope: { type: "global" },
					status: "active",
					revision: 1,
					updatedAt: "2026-06-17T09:00:00.000Z",
					canEdit: true,
					canDelete: true,
					canSuppress: true,
					sourceChips: [
						{
							id: "source-1",
							sourceType: "user_statement",
							label: "Chat",
							summary: "User said this directly.",
						},
					],
					whyRemembered: "User said this directly.",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			fetchMemoryProfileItemDetail("item/about", fetchImpl),
		).resolves.toMatchObject({
			id: "item-about",
			sourceChips: [
				expect.objectContaining({
					label: "Chat",
					summary: "User said this directly.",
				}),
			],
		});

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/knowledge/memory/item%2Fabout",
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

	// The intent response is not the only authoritative reading of the limit:
	// a 413 says the admin lowered it, and by how much.
	it("adopts the limit a 413 reports before rethrowing", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: "File too large. Maximum size is 25MB.",
					code: "upload_file_too_large",
					errorKey: "knowledge.uploadFileTooLarge",
					details: { maxFileUploadSize: 25 * 1024 * 1024 },
				}),
				{ status: 413, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(
			uploadKnowledgeAttachment(new File(["x"], "huge.pdf"), null, fetchImpl),
		).rejects.toMatchObject({ code: "upload_file_too_large" });
		expect(get(maxFileUploadSizeBytes)).toBe(25 * 1024 * 1024);
	});

	it("leaves the limit alone when a 413 carries no usable details", async () => {
		const before = get(maxFileUploadSizeBytes);
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: "Too large",
					code: "upload_file_too_large",
					details: { maxFileUploadSize: 0 },
				}),
				{ status: 413, headers: { "Content-Type": "application/json" } },
			),
		);

		await expect(
			uploadKnowledgeAttachment(new File(["x"], "huge.pdf"), null, fetchImpl),
		).rejects.toMatchObject({ code: "upload_file_too_large" });
		expect(get(maxFileUploadSizeBytes)).toBe(before);
	});

	it("publishes the limit the intent response reports", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						traceId: "trace-upload",
						maxFileUploadSize: 12 * 1024 * 1024,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ artifact: { id: "a" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await uploadKnowledgeAttachment(
			new File(["x"], "doc.pdf"),
			null,
			fetchImpl,
		);
		expect(get(maxFileUploadSizeBytes)).toBe(12 * 1024 * 1024);
	});

	it("publishes the MinerU-4 gate the intent response reports", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						traceId: "trace-upload",
						maxFileUploadSize: 12 * 1024 * 1024,
						disabledFileTypeIds: ["epub", "odp", "ods", "odt", "rtf"],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ artifact: { id: "a" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await uploadKnowledgeAttachment(
			new File(["x"], "doc.pdf"),
			null,
			fetchImpl,
		);

		expect([...get(disabledFileTypeIds)].sort()).toEqual([
			"epub",
			"odp",
			"ods",
			"odt",
			"rtf",
		]);
	});

	it("leaves the gate open when the intent response omits it", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						traceId: "trace-upload",
						maxFileUploadSize: 12 * 1024 * 1024,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ artifact: { id: "a" } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		await uploadKnowledgeAttachment(
			new File(["x"], "doc.pdf"),
			null,
			fetchImpl,
		);

		expect(get(disabledFileTypeIds).size).toBe(0);
	});
});

describe("uploadRefusalFromError", () => {
	async function refusalFrom(body: unknown, status = 415) {
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
		const error = await uploadKnowledgeAttachment(file, null, fetchImpl).catch(
			(caught: unknown) => caught,
		);
		return uploadRefusalFromError(error, file);
	}

	it("turns a type refusal into an i18n key and its parameters", async () => {
		expect(
			await refusalFrom({
				error: "Audio and video files can't be read yet.",
				code: "upload_unsupported_type",
				errorKey: "knowledge.uploadRejectedMedia",
				details: { fileName: "clip.mp4", extension: "mp4", reason: "media" },
			}),
		).toEqual({
			key: "knowledge.uploadRejectedMedia",
			params: { name: "clip.mp4", ext: "MP4", limit: "" },
		});
	});

	// phase5-6 follow-up: AVIF's own reject reason, distinct from
	// `formatNotEnabled` because "Save it as PDF or DOCX" is wrong advice for
	// an image.
	it("turns the convertImage refusal into its own i18n key", async () => {
		expect(
			await refusalFrom({
				error: "AVIF images can't be read yet.",
				code: "upload_unsupported_type",
				errorKey: "knowledge.uploadRejectedConvertImage",
				details: {
					fileName: "photo.avif",
					extension: "avif",
					reason: "convertImage",
				},
			}),
		).toEqual({
			key: "knowledge.uploadRejectedConvertImage",
			params: { name: "photo.avif", ext: "AVIF", limit: "" },
		});
	});

	it("falls back to the file's own name and extension", async () => {
		expect(
			await refusalFrom({
				error: "We can't read that file.",
				code: "upload_unsupported_type",
				errorKey: "knowledge.uploadUnsupportedType",
			}),
		).toEqual({
			key: "knowledge.uploadUnsupportedType",
			params: { name: "clip.mp4", ext: "MP4", limit: "" },
		});
	});

	it("translates the 413 direct-text cap and interpolates the limit", async () => {
		// The cap answers 413, not 415. Keying only on 415 left both upload
		// surfaces showing the server's English sentence.
		expect(
			await refusalFrom(
				{
					error: "Text files are limited to 8 MB.",
					code: "upload_direct_text_too_large",
					errorKey: "knowledge.uploadDirectTextTooLarge",
					details: {
						fileName: "huge.log",
						fileSize: 20_000_000,
						maxBytes: 8_388_608,
					},
				},
				413,
			),
		).toEqual({
			key: "knowledge.uploadDirectTextTooLarge",
			params: { name: "huge.log", ext: "LOG", limit: "8 MB" },
		});
	});

	it("ignores a key it does not own, a non-415, and a plain Error", async () => {
		expect(
			await refusalFrom({
				error: "nope",
				code: "upload_unsupported_type",
				errorKey: "knowledge.somethingElse",
			}),
		).toBeNull();
		expect(
			await refusalFrom(
				{ error: "nope", errorKey: "knowledge.uploadRejectedMedia" },
				400,
			),
		).toBeNull();
		expect(
			uploadRefusalFromError(new Error("boom"), { name: "a.txt" }),
		).toBeNull();
		expect(uploadRefusalFromError(null, { name: "a.txt" })).toBeNull();
	});
});

describe("extraction status client API", () => {
	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	const dto = {
		id: "job-1",
		sourceArtifactId: "artifact-1",
		normalizedArtifactId: null,
		status: "parsing",
		intakeRoute: "mineru",
		fileName: "report.pdf",
		attemptCount: 1,
		maxAttempts: 3,
		retryable: false,
		cancelable: true,
		error: null,
		createdAt: 1,
		updatedAt: 2,
		startedAt: 1,
		legacy: false,
	};

	it("asks for de-duplicated, encoded ids and unwraps the list", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ jobs: [dto] }));

		await expect(
			fetchExtractionJobs(["artifact-1", " artifact-1 ", "a/b", ""], fetchImpl),
		).resolves.toEqual([dto]);

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/knowledge/extraction?artifactIds=artifact-1,a%2Fb",
		);
	});

	// F22. The fifty-id cap is the endpoint's, so the shared client has to
	// respect it: a caller other than the poller handing it a longer list used
	// to get a 400 that looked like the endpoint being broken.
	it("splits a list longer than the endpoint's cap into several requests", async () => {
		const ids = Array.from(
			{ length: EXTRACTION_STATUS_BATCH_LIMIT + 2 },
			(_, index) => `artifact-${index}`,
		);
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ jobs: [dto] }))
			.mockResolvedValueOnce(jsonResponse({ jobs: [{ ...dto, id: "job-2" }] }));

		await expect(fetchExtractionJobs(ids, fetchImpl)).resolves.toHaveLength(2);

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const asked = (fetchImpl.mock.calls as Array<[string]>).map(
			(call) =>
				new URL(call[0], "http://localhost").searchParams
					.get("artifactIds")
					?.split(",").length,
		);
		expect(asked).toEqual([EXTRACTION_STATUS_BATCH_LIMIT, 2]);
	});

	it("never calls the endpoint with an empty id list", async () => {
		const fetchImpl = vi.fn();
		await expect(fetchExtractionJobs(["", "  "], fetchImpl)).resolves.toEqual(
			[],
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("answers an empty list when the payload has no jobs field", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}));
		await expect(
			fetchExtractionJobs(["artifact-1"], fetchImpl),
		).resolves.toEqual([]);
	});

	it("posts a retry and returns the refreshed job", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ job: { ...dto, status: "queued" } }),
			);

		await expect(
			retryExtraction("artifact-1", fetchImpl),
		).resolves.toMatchObject({ status: "queued" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/knowledge/extraction/artifact-1/retry",
			{ method: "POST" },
		);
	});

	it("posts a cancel and returns the refreshed job", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ job: { ...dto, status: "canceled" } }),
			);

		await expect(
			cancelExtraction("artifact-1", fetchImpl),
		).resolves.toMatchObject({ status: "canceled" });
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/knowledge/extraction/artifact-1/cancel",
			{ method: "POST" },
		);
	});

	it("throws an ApiError carrying the endpoint's code", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ error: "nope", code: "extraction_job_not_found" }, 404),
			);

		await expect(
			retryExtraction("artifact-1", fetchImpl),
		).rejects.toMatchObject({
			status: 404,
			code: "extraction_job_not_found",
		});
	});
});
