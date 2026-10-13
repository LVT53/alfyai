import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	getLastConversationLanguageMock,
	getPreviousUserMessageTextMock,
	readConversationLanguageMock,
} = vi.hoisted(() => ({
	getLastConversationLanguageMock: vi.fn(),
	getPreviousUserMessageTextMock: vi.fn(),
	readConversationLanguageMock: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	getLastConversationLanguage: getLastConversationLanguageMock,
	getPreviousUserMessageText: getPreviousUserMessageTextMock,
}));

vi.mock("./conversation-language", () => ({
	readConversationLanguage: readConversationLanguageMock,
}));

import { readReplyLanguage } from "../language";
import { LANGUAGE_PROBES } from "./language-probes.test-helpers";
import {
	getReplyLanguageStats,
	resetReplyLanguageStatsForTests,
	resolveTurnReplyLanguage,
} from "./reply-language";

const ENGLISH_REPLY =
	"Heat pumps move heat instead of making it, so they usually need about a third of the energy a gas boiler needs for the same warmth. The catch is the upfront cost and the need for decent insulation.";
const HUNGARIAN_REPLY =
	"Természetesen segítek. Először gyűjtsd össze, hogy mi az, ami nem fér bele a határidőbe, aztán döntsd el, hogy melyiket lehet kihagyni, mert nem minden egyformán fontos.";

function turn(
	overrides: Partial<Parameters<typeof resolveTurnReplyLanguage>[0]>,
) {
	return resolveTurnReplyLanguage({
		userId: "user-1",
		conversationId: "conv-1",
		reply: ENGLISH_REPLY,
		latestUserMessage: "Which is better, a heat pump or a gas boiler?",
		uiLanguage: "en",
		...overrides,
	});
}

describe("resolveTurnReplyLanguage", () => {
	let info: ReturnType<typeof vi.spyOn>;
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		getLastConversationLanguageMock.mockReset();
		getLastConversationLanguageMock.mockResolvedValue(null);
		getPreviousUserMessageTextMock.mockReset();
		getPreviousUserMessageTextMock.mockResolvedValue(null);
		readConversationLanguageMock.mockReset();
		readConversationLanguageMock.mockResolvedValue(null);
		resetReplyLanguageStatsForTests();
		info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		info.mockRestore();
		warn.mockRestore();
	});

	describe("the model names the language (the call faked)", () => {
		it("takes the language the model names for the person, whatever the reply reads as and whatever the account is shown in", async () => {
			for (const probe of LANGUAGE_PROBES) {
				getLastConversationLanguageMock.mockResolvedValue(probe.previous);
				getPreviousUserMessageTextMock.mockResolvedValue(
					probe.previousMessage ?? null,
				);
				readConversationLanguageMock.mockReset();
				readConversationLanguageMock.mockResolvedValue(probe.person);

				const result = await turn({
					reply: probe.reply,
					latestUserMessage: probe.message,
					uiLanguage: probe.uiLanguage,
				});

				expect(result.language, probe.id).toBe(probe.person);
				expect(result.via, probe.id).toBe("model");
				// The reader on the reply text is kept for the record, not for the choice.
				expect(result.reply, probe.id).toBe(readReplyLanguage(probe.reply));
				// The call is given what the person wrote, what they wrote before it
				// and the start of the reply: nothing else, and not the account.
				expect(readConversationLanguageMock, probe.id).toHaveBeenCalledTimes(1);
				expect(readConversationLanguageMock, probe.id).toHaveBeenCalledWith({
					userId: "user-1",
					conversationId: "conv-1",
					latestUserMessage: probe.message,
					previousUserMessage: probe.previousMessage ?? null,
					reply: probe.reply,
				});
			}
		});

		it("is a table with teeth: in many rows the reply reads as the other language than the person's", () => {
			const reversed = LANGUAGE_PROBES.filter((probe) => {
				const read = readReplyLanguage(probe.reply);
				return read !== "unknown" && read !== probe.person;
			});
			// Both directions: an English writer given a Hungarian piece, a Hungarian
			// writer given an English one.
			expect(reversed.length).toBeGreaterThanOrEqual(10);
			expect(reversed.some((p) => p.person === "en")).toBe(true);
			expect(reversed.some((p) => p.person === "hu")).toBe(true);
		});

		it("takes the model's answer when the history cannot be read", async () => {
			getLastConversationLanguageMock.mockRejectedValue(new Error("db down"));
			getPreviousUserMessageTextMock.mockRejectedValue(new Error("db down"));
			readConversationLanguageMock.mockResolvedValue("hu");
			const result = await turn({ reply: "Done.", latestUserMessage: "ok" });
			expect(result).toMatchObject({ language: "hu", via: "model" });
			expect(readConversationLanguageMock).toHaveBeenCalledWith(
				expect.objectContaining({ previousUserMessage: null }),
			);
		});
	});

	describe("the model does not name it: the deterministic chain decides", () => {
		it("a reply the reader names is its own language, for an account shown in either", async () => {
			expect(await turn({ uiLanguage: "hu" })).toEqual({
				language: "en",
				reply: "en",
				via: "fallback",
			});
			expect(await turn({ reply: HUNGARIAN_REPLY, uiLanguage: "en" })).toEqual({
				language: "hu",
				reply: "hu",
				via: "fallback",
			});
		});

		it("a reply that says nothing falls to the conversation's stored language, then the account's", async () => {
			getLastConversationLanguageMock.mockResolvedValue("hu");
			expect(
				await turn({
					reply: "Done.",
					latestUserMessage: "ok",
					uiLanguage: "en",
				}),
			).toEqual({ language: "hu", reply: "unknown", via: "fallback" });
			expect(getLastConversationLanguageMock).toHaveBeenCalledWith(
				"conv-1",
				"user-1",
			);

			getLastConversationLanguageMock.mockResolvedValue(null);
			expect(
				await turn({
					reply: "Done.",
					latestUserMessage: "ok",
					uiLanguage: "hu",
				}),
			).toEqual({ language: "hu", reply: "unknown", via: "fallback" });
		});

		it("goes on when the call throws, and when the history cannot be read", async () => {
			readConversationLanguageMock.mockRejectedValue(new Error("model down"));
			getLastConversationLanguageMock.mockRejectedValue(new Error("db down"));
			getPreviousUserMessageTextMock.mockRejectedValue(new Error("db down"));
			expect(
				await turn({
					reply: "Done.",
					latestUserMessage: "ok",
					uiLanguage: "hu",
				}),
			).toEqual({ language: "hu", reply: "unknown", via: "fallback" });
		});
	});

	describe("observability: one content-free line, one warning, a few counters", () => {
		it("logs the account's UI language, the conversation's language and what the reply reads as", async () => {
			await turn({ uiLanguage: "en" });
			readConversationLanguageMock.mockResolvedValue("hu");
			await turn({
				reply: "Done.",
				latestUserMessage: "ok",
				uiLanguage: "en",
			});

			expect(info.mock.calls.map((call: unknown[]) => call[0])).toEqual([
				"[LANGUAGE] ui=en conversation=en reply=en",
				"[LANGUAGE] ui=en conversation=hu reply=unknown",
			]);
			for (const [line] of [...info.mock.calls, ...warn.mock.calls]) {
				expect(String(line)).not.toContain("heat pump");
				expect(String(line)).not.toContain("user-1");
				expect(String(line)).not.toContain("conv-1");
			}
			expect(warn).not.toHaveBeenCalled();
		});

		it("warns, and counts, when the model answered an English writer in Hungarian, whatever the account is shown in", async () => {
			// The model says the person writes English; the reply reads as Hungarian:
			// the failure the owner asked never to see. The owner's own case is an
			// account shown in Hungarian, writing English.
			readConversationLanguageMock.mockResolvedValue("en");
			await turn({
				reply: HUNGARIAN_REPLY,
				latestUserMessage: "What should I cut from this week?",
				uiLanguage: "en",
			});
			await turn({
				reply: HUNGARIAN_REPLY,
				latestUserMessage: "What should I cut from this week?",
				uiLanguage: "hu",
			});

			expect(info).toHaveBeenCalledWith(
				"[LANGUAGE] ui=en conversation=en reply=hu",
			);
			expect(info).toHaveBeenCalledWith(
				"[LANGUAGE] ui=hu conversation=en reply=hu",
			);
			expect(warn).toHaveBeenCalledTimes(2);
			expect(String(warn.mock.calls[0][0])).toContain(
				"ui=en conversation=en reply=hu",
			);
			expect(String(warn.mock.calls[1][0])).toContain(
				"ui=hu conversation=en reply=hu",
			);
			const stats = getReplyLanguageStats();
			expect(stats.englishWriterHungarianReplyCount).toBe(2);
			expect(stats.lastEnglishWriterHungarianReplyAt).toBeGreaterThan(0);
		});

		it("does not warn for a Hungarian writer, on either account, nor for an English reply to an English writer", async () => {
			// conversation=hu, reply=hu: a Hungarian speaker, on the default UI
			// language and on an account shown in Hungarian.
			readConversationLanguageMock.mockResolvedValue("hu");
			await turn({ reply: HUNGARIAN_REPLY, uiLanguage: "en" });
			await turn({ reply: HUNGARIAN_REPLY, uiLanguage: "hu" });
			// conversation=en, reply=en.
			readConversationLanguageMock.mockResolvedValue("en");
			await turn({ uiLanguage: "en" });
			await turn({ uiLanguage: "hu" });

			expect(warn).not.toHaveBeenCalled();
			expect(getReplyLanguageStats()).toMatchObject({
				turnsRead: 4,
				englishWriterHungarianReplyCount: 0,
				lastEnglishWriterHungarianReplyAt: null,
			});
		});

		it("counts the turns whose reply it could not read, and the turns the model did not name the language", async () => {
			await turn({ reply: "Done.", latestUserMessage: "ok" });
			readConversationLanguageMock.mockResolvedValue("en");
			await turn({ reply: "Done.", latestUserMessage: "ok" });

			expect(getReplyLanguageStats()).toMatchObject({
				turnsRead: 2,
				unreadCount: 2,
				conversationLanguageFallbackCount: 1,
			});
		});
	});
});
