import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/chatgpt-import", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/server/services/chatgpt-import")
	>()),
	importConversations: vi.fn(),
}));

import {
	ChatGptImportAlreadyRunningError,
	importConversations,
} from "$lib/server/services/chatgpt-import";
import { POST } from "./+server";

function makeEvent() {
	const form = new FormData();
	form.append(
		"file",
		new File(["zip"], "export.zip", { type: "application/zip" }),
	);
	return {
		// The test's own form, as the other upload routes' tests hand theirs over:
		// a body parsed by undici would carry undici's File, not this environment's.
		request: { formData: vi.fn().mockResolvedValue(form) },
		locals: { user: { id: "test-user", role: "user" } },
		params: {},
		url: new URL("http://localhost/api/chat/import"),
		route: { id: "/api/chat/import" },
	} as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/chat/import", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("answers 409, naming the words to show, while the person's import is running", async () => {
		vi.mocked(importConversations).mockRejectedValue(
			new ChatGptImportAlreadyRunningError(),
		);

		const response = await POST(makeEvent());

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: expect.stringContaining("already running"),
			errorKey: "chatgptImport.alreadyRunning",
		});
	});

	it("answers a finished import's result as before", async () => {
		const result = { jobId: "job-1", conversationIds: ["c-1"], errors: [] };
		vi.mocked(importConversations).mockResolvedValue(result);

		const response = await POST(makeEvent());

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(result);
		expect(importConversations).toHaveBeenCalledWith(
			"test-user",
			expect.any(Buffer),
			{ projectId: null },
		);
	});
});
