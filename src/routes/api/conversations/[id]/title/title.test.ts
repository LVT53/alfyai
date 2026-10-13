import type { RequestEvent } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	generateTitleMock,
	getLastConversationLanguageMock,
	updateConversationTitleMock,
} = vi.hoisted(() => ({
	generateTitleMock: vi.fn(),
	getLastConversationLanguageMock: vi.fn(),
	updateConversationTitleMock: vi.fn(),
}));

vi.mock("$lib/server/services/title-generator", () => ({
	generateTitle: generateTitleMock,
}));

vi.mock("$lib/server/services/messages", () => ({
	getLastConversationLanguage: getLastConversationLanguageMock,
}));

vi.mock("$lib/server/services/conversations", () => ({
	updateConversationTitle: updateConversationTitleMock,
}));

import { POST } from "./+server";

function makeEvent(user: Record<string, unknown> | null) {
	return {
		request: new Request("http://localhost/api/conversations/conv-1/title", {
			method: "POST",
			body: JSON.stringify({
				userMessage: "Write an email to my colleague in Hungarian",
				assistantResponse: "Here is a draft: Kedves Márk!",
			}),
		}),
		params: { id: "conv-1" },
		locals: { user },
	} as unknown as RequestEvent;
}

describe("POST /api/conversations/[id]/title", () => {
	beforeEach(() => {
		generateTitleMock.mockReset();
		generateTitleMock.mockResolvedValue("Email to a colleague");
		getLastConversationLanguageMock.mockReset();
		getLastConversationLanguageMock.mockResolvedValue(null);
		updateConversationTitleMock.mockReset();
	});

	it("writes the title in the language the turn named for the conversation, so it agrees with the chips", async () => {
		getLastConversationLanguageMock.mockResolvedValue("en");

		const response = await POST(
			makeEvent({ id: "user-1", titleLanguage: "auto", uiLanguage: "hu" }),
		);

		expect(await response.json()).toEqual({ title: "Email to a colleague" });
		// The recorded language is looked up under the caller's own id.
		expect(getLastConversationLanguageMock).toHaveBeenCalledWith(
			"conv-1",
			"user-1",
		);
		expect(generateTitleMock).toHaveBeenCalledWith(
			"Write an email to my colleague in Hungarian",
			"Here is a draft: Kedves Márk!",
			"auto",
			"hu",
			"en",
		);
		expect(updateConversationTitleMock).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"Email to a colleague",
		);
	});

	it("goes on with no recorded language when the lookup fails or finds none", async () => {
		getLastConversationLanguageMock.mockRejectedValue(new Error("db down"));
		await POST(makeEvent({ id: "user-1", titleLanguage: "en" }));
		expect(generateTitleMock).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(String),
			"en",
			undefined,
			null,
		);

		getLastConversationLanguageMock.mockResolvedValue(null);
		await POST(makeEvent({ id: "user-1", titleLanguage: "auto" }));
		expect(generateTitleMock).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(String),
			"auto",
			undefined,
			null,
		);
	});

	it("refuses a request with no signed-in user and generates nothing", async () => {
		const response = await POST(makeEvent(null));
		expect(response.status).toBe(401);
		expect(generateTitleMock).not.toHaveBeenCalled();
	});
});
