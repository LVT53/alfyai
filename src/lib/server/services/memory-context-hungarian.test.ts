import { describe, expect, it } from "vitest";

import {
	resolveProjectMemoryContextMode,
	tokenizeQuery,
} from "./memory-context";

describe("Hungarian memory context query handling", () => {
	it("preserves accented Hungarian query terms", () => {
		expect(
			tokenizeQuery(
				"Keress rá a korábbi beszélgetéseimben a kerékpár biztosításra.",
			),
		).toEqual(expect.arrayContaining(["kerékpár", "biztosításra"]));

		expect(tokenizeQuery("felmondási idő")).toEqual(
			expect.arrayContaining(["felmondási", "idő"]),
		);
		expect(tokenizeQuery("önéletrajz Roche")).toEqual(
			expect.arrayContaining(["önéletrajz", "roche"]),
		);
	});

	it("filters Hungarian stopwords from broad history queries", () => {
		expect(tokenizeQuery("mi és hogyan")).toEqual([]);
	});

	it("routes Hungarian project report requests to report mode", () => {
		expect(
			resolveProjectMemoryContextMode({
				query:
					"Készíts jelentést a projektmappa korábbi beszélgetéseiből.",
			}),
		).toBe("report");
		expect(
			resolveProjectMemoryContextMode({
				query: "Foglalj össze mindent ebből a projektből.",
			}),
		).toBe("report");
	});

	it("keeps plain project mentions in summary mode", () => {
		expect(
			resolveProjectMemoryContextMode({
				query: "Nézd meg a projekt állapotát.",
			}),
		).toBe("summary");
	});

	it("uses detail mode when a sibling conversation is selected", () => {
		expect(
			resolveProjectMemoryContextMode({
				query: "Bármi",
				siblingConversationId: "conversation-2",
			}),
		).toBe("detail");
	});
});
