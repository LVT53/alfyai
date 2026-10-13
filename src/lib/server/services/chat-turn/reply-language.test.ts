import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getLastReplyLanguageMock } = vi.hoisted(() => ({
	getLastReplyLanguageMock: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	getLastReplyLanguage: getLastReplyLanguageMock,
}));

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
		getLastReplyLanguageMock.mockReset();
		getLastReplyLanguageMock.mockResolvedValue(null);
		resetReplyLanguageStatsForTests();
		info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		info.mockRestore();
		warn.mockRestore();
	});

	it("reads the reply, not the account: an English reply is English for an account shown in Hungarian", async () => {
		expect(await turn({ uiLanguage: "hu" })).toEqual({
			language: "en",
			read: "en",
		});
		expect(await turn({ reply: HUNGARIAN_REPLY, uiLanguage: "en" })).toEqual({
			language: "hu",
			read: "hu",
		});
	});

	it("falls back to the conversation's last known reply language, then to the account's", async () => {
		getLastReplyLanguageMock.mockResolvedValue("hu");
		expect(
			await turn({ reply: "Done.", latestUserMessage: "ok", uiLanguage: "en" }),
		).toEqual({ language: "hu", read: "unknown" });
		expect(getLastReplyLanguageMock).toHaveBeenCalledWith("conv-1", "user-1");

		getLastReplyLanguageMock.mockResolvedValue(null);
		expect(
			await turn({ reply: "Done.", latestUserMessage: "ok", uiLanguage: "hu" }),
		).toEqual({ language: "hu", read: "unknown" });
	});

	it("goes on without the conversation's history when it cannot be read", async () => {
		getLastReplyLanguageMock.mockRejectedValue(new Error("db down"));
		expect(
			await turn({ reply: "Done.", latestUserMessage: "ok", uiLanguage: "hu" }),
		).toEqual({ language: "hu", read: "unknown" });
	});

	it("logs one content-free line per turn", async () => {
		await turn({ uiLanguage: "en" });
		await turn({ reply: "Done.", latestUserMessage: "ok", uiLanguage: "hu" });

		expect(info.mock.calls.map((call: unknown[]) => call[0])).toEqual([
			"[LANGUAGE] ui=en reply=en",
			"[LANGUAGE] ui=hu reply=unknown",
		]);
		for (const [line] of [...info.mock.calls, ...warn.mock.calls]) {
			expect(String(line)).not.toContain("heat pump");
			expect(String(line)).not.toContain("user-1");
			expect(String(line)).not.toContain("conv-1");
		}
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns, and counts, when an account shown in English got a reply read as Hungarian", async () => {
		await turn({ reply: HUNGARIAN_REPLY, uiLanguage: "en" });

		expect(info).toHaveBeenCalledWith("[LANGUAGE] ui=en reply=hu");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain("ui=en reply=hu");
		const stats = getReplyLanguageStats();
		expect(stats.englishAccountHungarianReplyCount).toBe(1);
		expect(stats.lastEnglishAccountHungarianReplyAt).toBeGreaterThan(0);
	});

	it("does not warn for a Hungarian reply to an account shown in Hungarian, or an English one to an account shown in English", async () => {
		await turn({ reply: HUNGARIAN_REPLY, uiLanguage: "hu" });
		await turn({ uiLanguage: "en" });

		expect(warn).not.toHaveBeenCalled();
		expect(getReplyLanguageStats()).toMatchObject({
			turnsRead: 2,
			unreadCount: 0,
			englishAccountHungarianReplyCount: 0,
			lastEnglishAccountHungarianReplyAt: null,
		});
	});

	it("counts the turns it could not read", async () => {
		await turn({ reply: "Done.", latestUserMessage: "ok" });

		expect(getReplyLanguageStats()).toMatchObject({
			turnsRead: 1,
			unreadCount: 1,
		});
	});
});
