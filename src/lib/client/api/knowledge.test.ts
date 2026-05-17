import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "./http";
import { uploadKnowledgeAttachment } from "./knowledge";

describe("knowledge client API", () => {
	it("uploads attachments through multipart form data", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
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

		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/knowledge/upload",
			expect.objectContaining({
				method: "POST",
				body: expect.any(FormData),
			}),
		);
		const [, init] = fetchImpl.mock.calls[0];
		const body = init.body as FormData;
		expect(body.get("file")).toBe(file);
		expect(body.get("conversationId")).toBe("conv-1");
		expect(init.headers).toMatchObject({
			"X-AlfyAI-Upload-Name": "note.txt",
			"X-AlfyAI-Upload-Size": String(file.size),
		});
	});

	it("sends encoded upload metadata headers before multipart parsing", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ artifact: { id: "artifact-1" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const file = new File(["hello"], "árvíz tűrő.pdf", {
			type: "application/pdf",
		});

		await uploadKnowledgeAttachment(file, null, fetchImpl);

		const [, init] = fetchImpl.mock.calls[0];
		expect(init.headers).toMatchObject({
			"X-AlfyAI-Upload-Name": encodeURIComponent(file.name),
			"X-AlfyAI-Upload-Size": String(file.size),
		});
	});

	it("preserves server-side upload aborted errors", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
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
			.mockRejectedValue(
				new DOMException("The operation was aborted.", "AbortError"),
			);

		await expect(
			uploadKnowledgeAttachment(new File(["x"], "doc.pdf"), null, fetchImpl),
		).rejects.toThrow(/server or reverse proxy may be closing large uploads/i);
	});

	it("normalizes upload gateway failures into deployment guidance", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response("Bad Gateway", {
				status: 502,
				headers: { "Content-Type": "text/plain" },
			}),
		);
		const file = new File(["x"], "large.pdf", { type: "application/pdf" });

		await expect(uploadKnowledgeAttachment(file, null, fetchImpl)).rejects.toThrow(
			/reverse proxy body limits\/timeouts/i,
		);
	});
});
