import { beforeEach, describe, expect, it, vi } from "vitest";

const { callShortLocalControlModelMock, selectLimitMock } = vi.hoisted(() => ({
	callShortLocalControlModelMock: vi.fn(),
	selectLimitMock: vi.fn(),
}));

vi.mock("../chat-turn/short-local-text", () => ({
	callShortLocalControlModel: callShortLocalControlModelMock,
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: () => ({
			from: () => ({ where: () => ({ limit: selectLimitMock }) }),
		}),
	},
}));

vi.mock("$lib/server/db/schema", () => ({
	users: { id: "id", uiLanguage: "ui_language" },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

import {
	askAtlasQuestionLanguage,
	resolveAtlasQuestionLanguage,
} from "./question-language";

function answer(text: string) {
	return { text, rawResponse: {}, modelId: "model2" as const };
}

const PARAMS = {
	userId: "user-1",
	conversationId: "conv-1",
	query: "How much solar did the EU add in 2025 versus 2024?",
};

describe("askAtlasQuestionLanguage", () => {
	beforeEach(() => {
		callShortLocalControlModelMock.mockReset();
		selectLimitMock.mockReset();
	});

	it("asks the control model which language the question is written in, once, deterministically", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			answer('{"language": "hu"}'),
		);

		await expect(askAtlasQuestionLanguage(PARAMS)).resolves.toBe("hu");

		expect(callShortLocalControlModelMock).toHaveBeenCalledTimes(1);
		const call = callShortLocalControlModelMock.mock.calls[0][0];
		expect(call).toMatchObject({
			message: PARAMS.query,
			feature: "atlas_question_language",
			userId: "user-1",
			conversationId: "conv-1",
			thinkingMode: "off",
			// A one-word machine-read verdict: sampling.test.ts lists the 0.
			temperature: 0,
		});
		expect(call.systemPrompt).toMatch(
			/In which language is this question written/,
		);
		expect(call.jsonSchema.schema.properties.language.enum).toEqual([
			"en",
			"hu",
		]);
	});

	it("reads English, and tolerates the envelope a model wraps it in", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			answer('Sure:\n```json\n{"language": "en"}\n```'),
		);
		await expect(askAtlasQuestionLanguage(PARAMS)).resolves.toBe("en");
	});

	it("shows the model only the start of a long question", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			answer('{"language": "en"}'),
		);
		await askAtlasQuestionLanguage({ ...PARAMS, query: "a ".repeat(3_000) });
		expect(
			callShortLocalControlModelMock.mock.calls[0][0].message.length,
		).toBeLessThanOrEqual(1_000);
	});

	it("is null when the model cannot answer, answers with something else, or the question is empty", async () => {
		callShortLocalControlModelMock.mockResolvedValue(null);
		await expect(askAtlasQuestionLanguage(PARAMS)).resolves.toBeNull();

		callShortLocalControlModelMock.mockResolvedValue(
			answer('{"language": "de"}'),
		);
		await expect(askAtlasQuestionLanguage(PARAMS)).resolves.toBeNull();

		callShortLocalControlModelMock.mockResolvedValue(answer("hungarian"));
		await expect(askAtlasQuestionLanguage(PARAMS)).resolves.toBeNull();

		callShortLocalControlModelMock.mockClear();
		await expect(
			askAtlasQuestionLanguage({ ...PARAMS, query: "   " }),
		).resolves.toBeNull();
		expect(callShortLocalControlModelMock).not.toHaveBeenCalled();
	});
});

describe("resolveAtlasQuestionLanguage", () => {
	beforeEach(() => {
		callShortLocalControlModelMock.mockReset();
		selectLimitMock.mockReset();
	});

	it("is the model's reading, whatever the account is shown in", async () => {
		callShortLocalControlModelMock.mockResolvedValue(
			answer('{"language": "hu"}'),
		);
		selectLimitMock.mockResolvedValue([{ uiLanguage: "en" }]);

		await expect(resolveAtlasQuestionLanguage(PARAMS)).resolves.toBe("hu");
		expect(selectLimitMock).not.toHaveBeenCalled();
	});

	it("falls to the account's UI language when the model cannot say, then to English", async () => {
		callShortLocalControlModelMock.mockResolvedValue(null);
		selectLimitMock.mockResolvedValue([{ uiLanguage: "hu" }]);
		await expect(resolveAtlasQuestionLanguage(PARAMS)).resolves.toBe("hu");

		selectLimitMock.mockResolvedValue([]);
		await expect(resolveAtlasQuestionLanguage(PARAMS)).resolves.toBe("en");

		selectLimitMock.mockRejectedValue(new Error("db down"));
		await expect(resolveAtlasQuestionLanguage(PARAMS)).resolves.toBe("en");

		callShortLocalControlModelMock.mockRejectedValue(new Error("down"));
		await expect(resolveAtlasQuestionLanguage(PARAMS)).resolves.toBe("en");
	});
});
