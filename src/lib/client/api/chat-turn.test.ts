import { describe, expect, it, vi } from "vitest";
import { checkChatTurn } from "./chat-turn";
import { ApiError } from "./http";

const request = {
	conversationId: "conv-1",
	message: "Edited words",
	model: "model1",
	attachmentIds: ["attachment-1"],
	pictureRefs: [{ imageFileId: "file-1", number: 1 }],
	imageMarks: null,
	activeDocumentArtifactId: "item-1",
	isEditResend: true,
};

function jsonResponse(body: unknown, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("checkChatTurn", () => {
	it("posts the resend's body to the turn check and says ok when the gate takes it", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ ok: true }, 200));

		await expect(checkChatTurn(request, fetchMock)).resolves.toEqual({
			ok: true,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("/api/chat/turn-check");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual(request);
	});

	it("hands back the gate's refusal with the fields a refused send carries, so the page can say the same sentence", async () => {
		const refusal = {
			status: 422,
			error: "Photo.png does not contain enough readable text.",
			code: "attachment_not_ready",
			attachmentIds: ["attachment-1"],
			attachmentReadiness: [
				{
					artifactId: "attachment-1",
					name: "Photo.png",
					reason: "not_text_readable",
				},
			],
		};
		const fetchMock = vi.fn(async () => jsonResponse(refusal, 422));

		const result = await checkChatTurn(request, fetchMock);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(ApiError);
		expect(result.error.message).toBe(refusal.error);
		expect(result.error.status).toBe(422);
		// What `toFriendlySendError` reads off any send error.
		expect(result.error.code).toBe("attachment_not_ready");
		expect(result.error.attachmentReadiness).toEqual(
			refusal.attachmentReadiness,
		);
	});

	it("carries an extraction refusal's per-file rows too", async () => {
		const rows = [
			{
				artifactId: "attachment-1",
				name: "Budget.pdf",
				status: "queued",
				errorCode: null,
				retryable: false,
			},
		];
		const fetchMock = vi.fn(async () =>
			jsonResponse(
				{
					status: 422,
					error: "Budget.pdf is still being prepared for chat.",
					code: "attachment_extraction_pending",
					attachmentExtraction: rows,
				},
				422,
			),
		);

		const result = await checkChatTurn(request, fetchMock);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("attachment_extraction_pending");
		expect(result.error.attachmentExtraction).toEqual(rows);
	});

	it.each([
		400, 403, 404, 409, 422,
	])("takes a %i for the gate's refusal, which the turn would have answered the same", async (status) => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ status, error: "Refused" }, status),
		);

		const result = await checkChatTurn(request, fetchMock);

		expect(result.ok).toBe(false);
	});

	it.each([
		401, 408, 429, 500, 502, 503,
	])("does not take a %i for a refusal: the check could not be made", async (status) => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "Not now" }, status),
		);

		await expect(checkChatTurn(request, fetchMock)).rejects.toBeInstanceOf(
			ApiError,
		);
	});

	// The stream route turns a turn away with this before it admits it (a reply
	// running in another chat, one at a time by default; a server that is draining),
	// and the turn check answers the same: the edit then waits, it does not fail.
	it("says the server is busy when it cannot take a turn now, and not when the gate refuses one", async () => {
		const busy = vi.fn(async () =>
			jsonResponse(
				{
					error: "Server at capacity. Please try again later.",
					code: "CAPACITY_EXCEEDED",
					reason: "user_limit",
					retryAfter: 5,
				},
				503,
			),
		);
		const result = await checkChatTurn(request, busy);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.busy).toBe(true);
		expect(result.error.code).toBe("CAPACITY_EXCEEDED");

		const refused = vi.fn(async () =>
			jsonResponse(
				{ status: 422, error: "Refused", code: "attachment_not_ready" },
				422,
			),
		);
		const gate = await checkChatTurn(request, refused);
		expect(gate.ok).toBe(false);
		if (gate.ok) return;
		expect(gate.busy).toBeFalsy();
	});

	it("fails when the request never reaches the server", async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});

		await expect(checkChatTurn(request, fetchMock)).rejects.toBeInstanceOf(
			TypeError,
		);
	});

	it("fails on an answer that is not the gate's", async () => {
		const fetchMock = vi.fn(
			async () => new Response("<html>", { status: 200 }),
		);

		await expect(checkChatTurn(request, fetchMock)).rejects.toThrow();
	});
});
