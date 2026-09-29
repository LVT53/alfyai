import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
	"$lib/server/services/normal-chat-tools/artifact-tools/recreate",
	() => ({ recreateArtifactFromStoredCall: vi.fn() }),
);

import { recreateArtifactFromStoredCall } from "$lib/server/services/normal-chat-tools/artifact-tools/recreate";
import { POST } from "./+server";

const mockRecreate = recreateArtifactFromStoredCall as ReturnType<typeof vi.fn>;

function makeEvent(params: {
	userId?: string | null;
	body?: unknown;
	rawBody?: string;
	signal?: AbortSignal;
}) {
	const userId = params.userId === undefined ? "owner" : params.userId;
	const init: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body:
			params.rawBody ??
			(params.body === undefined ? undefined : JSON.stringify(params.body)),
		signal: params.signal,
	};
	return {
		params: { id: "conv-1", artifactId: "doc-1" },
		request: new Request(
			"http://localhost/api/conversations/conv-1/artifacts/doc-1/regenerate",
			init,
		),
		locals: { user: userId ? { id: userId, role: "user" } : undefined },
	} as never;
}

describe("POST /api/conversations/[id]/artifacts/[artifactId]/regenerate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("throws 401 with no signed-in user, and makes nothing", async () => {
		await expect(POST(makeEvent({ userId: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mockRecreate).not.toHaveBeenCalled();
	});

	it("makes the item again for the caller in this conversation, in the language it was asked in", async () => {
		mockRecreate.mockResolvedValue({
			ok: true,
			created: true,
			artifactId: "doc-1",
			kind: "document",
			title: "Weekend",
		});

		const response = await POST(makeEvent({ body: { language: "hu" } }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			created: true,
			artifactId: "doc-1",
			kind: "document",
			title: "Weekend",
		});
		expect(mockRecreate).toHaveBeenCalledWith({
			userId: "owner",
			conversationId: "conv-1",
			artifactId: "doc-1",
			language: "hu",
			abortSignal: expect.any(AbortSignal),
		});
	});

	it("falls back to English for a missing, unknown or unreadable language", async () => {
		mockRecreate.mockResolvedValue({
			ok: true,
			created: true,
			artifactId: "doc-1",
			kind: "document",
			title: "Weekend",
		});

		for (const event of [
			makeEvent({}),
			makeEvent({ body: { language: "de" } }),
			makeEvent({ body: { language: 3 } }),
			makeEvent({ rawBody: "{not json" }),
		]) {
			await POST(event);
		}

		expect(mockRecreate.mock.calls.map((call) => call[0].language)).toEqual([
			"en",
			"en",
			"en",
			"en",
		]);
	});

	it("hands the service a signal that fires when the request is abandoned", async () => {
		mockRecreate.mockResolvedValue({
			ok: true,
			created: false,
			artifactId: "doc-1",
			kind: "document",
			title: "Weekend",
		});
		const controller = new AbortController();

		await POST(makeEvent({ signal: controller.signal }));
		const handed = mockRecreate.mock.calls[0][0].abortSignal as AbortSignal;
		expect(handed.aborted).toBe(false);
		controller.abort();
		expect(handed.aborted).toBe(true);
	});

	it.each([
		[
			{ ok: false, reason: "not_found" },
			404,
			{ ok: false, reason: "not_found" },
		],
		[
			{ ok: false, reason: "no_stored_input" },
			409,
			{ ok: false, reason: "no_stored_input" },
		],
		[
			{ ok: false, reason: "in_progress" },
			409,
			{ ok: false, reason: "in_progress" },
		],
		[
			{ ok: false, reason: "failed", detail: "The request was cancelled." },
			422,
			{ ok: false, reason: "failed", detail: "The request was cancelled." },
		],
	])("answers %j with %i", async (outcome, status, body) => {
		mockRecreate.mockResolvedValue(outcome);

		const response = await POST(makeEvent({}));

		expect(response.status).toBe(status);
		expect(await response.json()).toEqual(body);
	});
});
