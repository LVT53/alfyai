import { describe, expect, it } from "vitest";
import {
	buildAtlasV3AskPrompt,
	deterministicAtlasV3Title,
	fallbackAtlasV3Ask,
	inferAtlasV3Shape,
	parseAtlasV3Ask,
} from "./ask";

const fallback = {
	query: "How much solar did the EU add in 2025?",
	language: "en" as const,
};

describe("parseAtlasV3Ask", () => {
	it("reads a well-formed answer", () => {
		const ask = parseAtlasV3Ask(
			JSON.stringify({
				decision: "Whether to treat 2025 as the year EU solar growth stalled",
				coreQuestion: "How much solar did the EU add in 2025 versus 2024?",
				title: "EU solar additions, 2025 versus 2024",
				shape: "comparison",
				implicitRequirements: ["EU-27, not Europe", "grid-connected capacity"],
				perspectives: ["installers", "grid operators"],
				subQuestions: ["EU solar additions 2025", "EU solar additions 2024"],
			}),
			fallback,
		);
		expect(ask?.shape).toBe("comparison");
		expect(ask?.title).toBe("EU solar additions, 2025 versus 2024");
		expect(ask?.implicitRequirements).toHaveLength(2);
		expect(ask?.subQuestions).toHaveLength(2);
	});

	it("returns null when there is no question to answer", () => {
		expect(parseAtlasV3Ask("not json at all", fallback)).toBeNull();
		expect(
			parseAtlasV3Ask(JSON.stringify({ shape: "comparison" }), fallback),
		).toBeNull();
	});

	it("falls back to the decision when the core question is missing", () => {
		const ask = parseAtlasV3Ask(
			JSON.stringify({ decision: "Pick a laptop", shape: "nonsense" }),
			fallback,
		);
		expect(ask?.coreQuestion).toBe("Pick a laptop");
		// An unrecognised shape falls back to the request's own wording.
		expect(ask?.shape).toBe("explanation");
	});

	it("drops duplicate list items and caps them", () => {
		const ask = parseAtlasV3Ask(
			JSON.stringify({
				coreQuestion: "q",
				implicitRequirements: [
					"EUR",
					"eur",
					"EUR",
					"a",
					"b",
					"c",
					"d",
					"e",
					"f",
				],
			}),
			fallback,
		);
		expect(ask?.implicitRequirements.slice(0, 2)).toEqual(["EUR", "a"]);
		expect(ask?.implicitRequirements.length).toBeLessThanOrEqual(6);
	});

	it("supplies sub-questions when the model gave none", () => {
		const ask = parseAtlasV3Ask(
			JSON.stringify({ coreQuestion: "q" }),
			fallback,
		);
		expect(ask?.subQuestions.length).toBeGreaterThan(0);
	});
});

describe("inferAtlasV3Shape", () => {
	it("recognises a comparison", () => {
		expect(
			inferAtlasV3Shape({
				query: "Framework 13 vs MacBook Air",
				language: "en",
			}),
		).toBe("comparison");
	});

	it("recognises a timeline", () => {
		expect(
			inferAtlasV3Shape({ query: "Timeline of the EU AI Act", language: "en" }),
		).toBe("timeline");
	});

	it("recognises a forecast in Hungarian", () => {
		expect(
			inferAtlasV3Shape({
				query: "Mennyi lesz a minimálbér 2026-ban?",
				language: "hu",
			}),
		).toBe("forecast");
	});

	it("calls two cues at once mixed", () => {
		expect(
			inferAtlasV3Shape({
				query: "Compare the forecast for solar and wind in 2030",
				language: "en",
			}),
		).toBe("mixed");
	});

	it("defaults to explanation", () => {
		expect(
			inferAtlasV3Shape({ query: "Why do slugs matter", language: "en" }),
		).toBe("explanation");
	});
});

describe("deterministicAtlasV3Title", () => {
	it("passes a short request through", () => {
		expect(deterministicAtlasV3Title("EU solar 2025")).toBe("EU solar 2025");
	});

	it("cuts at a clause boundary rather than mid-word", () => {
		const title = deterministicAtlasV3Title(
			"How much solar capacity did the European Union add in 2025, and how does that compare with 2024?",
		);
		expect(title.length).toBeLessThanOrEqual(70);
		expect(title.endsWith(" ")).toBe(false);
		expect(title).not.toMatch(/[,;:—-]$/);
	});
});

describe("fallbackAtlasV3Ask", () => {
	it("never returns an empty core question", () => {
		const ask = fallbackAtlasV3Ask({
			query: "  Solar in the EU  ",
			language: "en",
		});
		expect(ask.coreQuestion).toBe("Solar in the EU");
		expect(ask.subQuestions.length).toBeGreaterThan(0);
		expect(ask.title).toBe("Solar in the EU");
	});
});

describe("buildAtlasV3AskPrompt", () => {
	it("carries the request, the date and the preferred sources", () => {
		const prompt = buildAtlasV3AskPrompt({
			query: "minimálbér 2026",
			profile: "overview",
			language: "hu",
			currentDate: "2026-09-10",
			preferredSources: ["KSH", "Magyar Közlöny"],
		});
		const parsed = JSON.parse(prompt);
		expect(parsed.request).toBe("minimálbér 2026");
		expect(parsed.currentDate).toBe("2026-09-10");
		expect(parsed.preferredPrimarySources).toContain("KSH");
	});

	it("omits the revise instruction when there is none", () => {
		const parsed = JSON.parse(
			buildAtlasV3AskPrompt({
				query: "q",
				profile: "overview",
				language: "en",
				currentDate: "2026-09-10",
			}),
		);
		expect(parsed.reviseInstruction).toBeUndefined();
		expect(parsed.preferredPrimarySources).toBeUndefined();
	});
});
