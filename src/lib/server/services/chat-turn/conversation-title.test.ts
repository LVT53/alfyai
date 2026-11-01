import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	generateTitleMock,
	getConversationMock,
	getLastConversationLanguageMock,
	invalidateHomeSummaryMock,
	listMessageWindowMock,
	nameUntitledConversationMock,
	userLanguages,
} = vi.hoisted(() => ({
	generateTitleMock: vi.fn(),
	getConversationMock: vi.fn(),
	getLastConversationLanguageMock: vi.fn(),
	invalidateHomeSummaryMock: vi.fn(),
	listMessageWindowMock: vi.fn(),
	nameUntitledConversationMock: vi.fn(),
	userLanguages: {
		row: { titleLanguage: "auto", uiLanguage: "hu" } as Record<
			string,
			string
		> | null,
	},
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (userLanguages.row ? [userLanguages.row] : []),
				}),
			}),
		}),
	},
}));

vi.mock("$lib/server/services/title-generator", () => ({
	generateTitle: generateTitleMock,
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: getConversationMock,
	nameUntitledConversation: nameUntitledConversationMock,
}));

vi.mock("$lib/server/services/messages", () => ({
	getLastConversationLanguage: getLastConversationLanguageMock,
	listMessageWindow: listMessageWindowMock,
}));

vi.mock("$lib/server/services/home-summary", () => ({
	invalidateHomeSummary: invalidateHomeSummaryMock,
}));

import { DEFAULT_CONVERSATION_TITLE } from "$lib/shared/conversation-title";
import { ensureConversationTitle } from "./conversation-title";

const TURN = { userId: "user-1", conversationId: "conv-1" };

function untitled() {
	return { id: "conv-1", title: DEFAULT_CONVERSATION_TITLE };
}

describe("ensureConversationTitle", () => {
	beforeEach(() => {
		vi.unstubAllEnvs();
		userLanguages.row = { titleLanguage: "auto", uiLanguage: "hu" };
		generateTitleMock.mockReset();
		generateTitleMock.mockResolvedValue("Email to a colleague");
		getConversationMock.mockReset();
		getConversationMock.mockResolvedValue(untitled());
		getLastConversationLanguageMock.mockReset();
		getLastConversationLanguageMock.mockResolvedValue("en");
		invalidateHomeSummaryMock.mockReset();
		listMessageWindowMock.mockReset();
		listMessageWindowMock.mockResolvedValue({
			messages: [
				{ role: "user", content: "An old question" },
				{ role: "assistant", content: "An old answer" },
				{ role: "user", content: "Write an email to my colleague" },
				{ role: "assistant", content: "Here is a draft" },
			],
		});
		nameUntitledConversationMock.mockReset();
		nameUntitledConversationMock.mockImplementation(
			async (_userId: string, _id: string, title: string) => ({
				id: "conv-1",
				title,
			}),
		);
	});

	it("names an untitled conversation from its latest exchange, with no page involved", async () => {
		await expect(ensureConversationTitle(TURN)).resolves.toBe(
			"Email to a colleague",
		);

		expect(generateTitleMock).toHaveBeenCalledWith(
			"Write an email to my colleague",
			"Here is a draft",
			"auto",
			"hu",
			"en",
		);
		expect(nameUntitledConversationMock).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
			"Email to a colleague",
		);
	});

	it("lets go of the cached home summary after the write, so the new-chat page's Recent shows the title", async () => {
		await ensureConversationTitle(TURN);

		expect(invalidateHomeSummaryMock).toHaveBeenCalledWith("user-1");
		expect(
			invalidateHomeSummaryMock.mock.invocationCallOrder[0],
		).toBeGreaterThan(nameUntitledConversationMock.mock.invocationCallOrder[0]);
	});

	it("spends no model call on a conversation that already has a title", async () => {
		getConversationMock.mockResolvedValue({
			id: "conv-1",
			title: "My own name for it",
		});

		await expect(ensureConversationTitle(TURN)).resolves.toBe(
			"My own name for it",
		);

		expect(generateTitleMock).not.toHaveBeenCalled();
		expect(nameUntitledConversationMock).not.toHaveBeenCalled();
	});

	it("shares one model call between the page's request and the end of the turn", async () => {
		let finishTitle!: (title: string) => void;
		generateTitleMock.mockReturnValue(
			new Promise<string>((resolve) => {
				finishTitle = resolve;
			}),
		);

		const fromThePage = ensureConversationTitle(TURN);
		const fromTheTurn = ensureConversationTitle(TURN);
		await vi.waitFor(() => expect(generateTitleMock).toHaveBeenCalled());
		finishTitle("Email to a colleague");

		await expect(fromThePage).resolves.toBe("Email to a colleague");
		await expect(fromTheTurn).resolves.toBe("Email to a colleague");
		expect(generateTitleMock).toHaveBeenCalledTimes(1);
		expect(nameUntitledConversationMock).toHaveBeenCalledTimes(1);
	});

	it("asks again after a finished attempt rather than holding on to it", async () => {
		await ensureConversationTitle(TURN);
		await ensureConversationTitle(TURN);

		expect(generateTitleMock).toHaveBeenCalledTimes(2);
	});

	it("keeps a rename made while the model was working, and reports the name that stayed", async () => {
		nameUntitledConversationMock.mockResolvedValue(null);
		getConversationMock
			.mockResolvedValueOnce(untitled())
			.mockResolvedValueOnce({ id: "conv-1", title: "Renamed meanwhile" });

		await expect(ensureConversationTitle(TURN)).resolves.toBe(
			"Renamed meanwhile",
		);
		expect(invalidateHomeSummaryMock).not.toHaveBeenCalled();
	});

	it("does nothing for a conversation that is not this person's, or is gone", async () => {
		getConversationMock.mockResolvedValue(null);

		await expect(ensureConversationTitle(TURN)).resolves.toBeNull();

		expect(generateTitleMock).not.toHaveBeenCalled();
	});

	it("has nothing to name a conversation from until its reply is stored", async () => {
		listMessageWindowMock.mockResolvedValue({
			messages: [{ role: "user", content: "Write an email" }],
		});

		await expect(ensureConversationTitle(TURN)).resolves.toBeNull();

		expect(generateTitleMock).not.toHaveBeenCalled();
	});

	it("leaves the conversation untitled when the generator could only give back the default", async () => {
		generateTitleMock.mockResolvedValue(DEFAULT_CONVERSATION_TITLE);

		await expect(ensureConversationTitle(TURN)).resolves.toBeNull();

		expect(nameUntitledConversationMock).not.toHaveBeenCalled();
	});

	it("goes on with no recorded language when the lookup fails", async () => {
		getLastConversationLanguageMock.mockRejectedValue(new Error("db down"));

		await ensureConversationTitle(TURN);

		expect(generateTitleMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			"auto",
			"hu",
			null,
		);
	});

	it("takes the person's own title language from their account", async () => {
		userLanguages.row = { titleLanguage: "en", uiLanguage: "hu" };

		await ensureConversationTitle(TURN);

		expect(generateTitleMock).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			"en",
			"hu",
			"en",
		);
	});

	it("stays out of the way of browser tests, which have no title model", async () => {
		vi.stubEnv("PLAYWRIGHT_TEST", "1");

		await expect(ensureConversationTitle(TURN)).resolves.toBeNull();

		expect(getConversationMock).not.toHaveBeenCalled();
		expect(generateTitleMock).not.toHaveBeenCalled();
	});
});
