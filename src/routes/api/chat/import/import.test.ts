import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/chatgpt-import", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("$lib/server/services/chatgpt-import")
	>()),
	importConversations: vi.fn(),
}));

import {
	ChatGptImportAlreadyRunningError,
	ChatGptImportNoSelectionError,
	importConversations,
} from "$lib/server/services/chatgpt-import";
import { POST } from "./+server";

function makeEvent(fields: Record<string, string> = {}) {
	const form = new FormData();
	form.append(
		"file",
		new File(["zip"], "export.zip", { type: "application/zip" }),
	);
	for (const [name, value] of Object.entries(fields)) {
		form.append(name, value);
	}
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

const ticked = { conversationIds: JSON.stringify(["c-1"]) };

describe("POST /api/chat/import", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("answers 409, naming the words to show, while the person's import is running", async () => {
		vi.mocked(importConversations).mockRejectedValue(
			new ChatGptImportAlreadyRunningError(),
		);

		const response = await POST(makeEvent(ticked));

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: expect.stringContaining("already running"),
			errorKey: "chatgptImport.alreadyRunning",
		});
	});

	it("answers a finished import's result as before", async () => {
		const result = { jobId: "job-1", conversationIds: ["c-1"], errors: [] };
		vi.mocked(importConversations).mockResolvedValue(result);

		const response = await POST(makeEvent(ticked));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(result);
		expect(importConversations).toHaveBeenCalledWith(
			"test-user",
			expect.any(Buffer),
			{ projectId: null, conversationIds: ["c-1"] },
		);
	});

	it("hands the import the conversations the form names, and the project", async () => {
		vi.mocked(importConversations).mockResolvedValue({
			jobId: "job-1",
			conversationIds: [],
			errors: [],
		});

		await POST(
			makeEvent({
				conversationIds: JSON.stringify(["c-2", "c-1", "c-2"]),
				projectId: " project-1 ",
			}),
		);

		// Each conversation once, in the order the form named them.
		expect(importConversations).toHaveBeenCalledWith(
			"test-user",
			expect.any(Buffer),
			{ projectId: "project-1", conversationIds: ["c-2", "c-1"] },
		);
	});

	it.each([
		["no conversations at all", {}],
		["an empty list", { conversationIds: "[]" }],
		["text that is not JSON", { conversationIds: "c-1,c-2" }],
		["JSON that is not a list", { conversationIds: '{"id":"c-1"}' }],
		["a list of something other than ids", { conversationIds: "[1, 2]" }],
		["a blank id", { conversationIds: '["c-1", "  "]' }],
	])("answers 400 and imports nothing when the form names %s", async (_label, fields) => {
		const response = await POST(makeEvent(fields));

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: expect.stringContaining("conversation"),
		});
		expect(importConversations).not.toHaveBeenCalled();
	});

	it("answers 400 when the import itself turns an empty selection away", async () => {
		vi.mocked(importConversations).mockRejectedValue(
			new ChatGptImportNoSelectionError(),
		);

		const response = await POST(makeEvent(ticked));

		expect(response.status).toBe(400);
	});
});
