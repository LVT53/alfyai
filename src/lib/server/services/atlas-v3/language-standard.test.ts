import { describe, expect, it } from "vitest";
import {
	atlasV3LanguageStandard,
	atlasV3NativeSourcesForRequest,
	isAtlasV3NativePrimaryHost,
	isLabelShapedTitle,
	isTautologicalSentence,
	probeAtlasV3Register,
} from "./language-standard";

describe("atlasV3LanguageStandard", () => {
	it("carries register rules and native sources for Hungarian", () => {
		const standard = atlasV3LanguageStandard({ language: "hu" });
		expect(standard?.writerAddendum).toContain("KSH");
		expect(standard?.writerAddendum).toContain("tautológia");
		expect(standard?.criticAddendum).toContain("Magyar Közlöny");
	});

	it("can be turned off for Hungarian without turning off Hungarian", () => {
		expect(
			atlasV3LanguageStandard({ language: "hu", hungarianEnabled: false }),
		).toBeNull();
		expect(
			atlasV3LanguageStandard({ language: "en", hungarianEnabled: false }),
		).not.toBeNull();
	});
});

describe("atlasV3NativeSourcesForRequest", () => {
	it("assumes a Hungarian-language request is about Hungary", () => {
		const sets = atlasV3NativeSourcesForRequest({
			query: "Mennyi lesz a minimálbér?",
			language: "hu",
		});
		expect(sets.map((set) => set.region)).toContain("hu");
	});

	it("picks the jurisdiction the request names, in English", () => {
		const sets = atlasV3NativeSourcesForRequest({
			query: "How many Kerry slugs are left in Ireland?",
			language: "en",
		});
		expect(sets.map((set) => set.region)).toEqual(["ie"]);
	});

	it("returns nothing for a request with no jurisdiction", () => {
		expect(
			atlasV3NativeSourcesForRequest({
				query: "How do lithium-ion cells age?",
				language: "en",
			}),
		).toEqual([]);
	});
});

describe("isAtlasV3NativePrimaryHost", () => {
	it("matches a subdomain of a native source", () => {
		const sets = atlasV3NativeSourcesForRequest({
			query: "magyar",
			language: "hu",
		});
		expect(isAtlasV3NativePrimaryHost("statinfo.ksh.hu", sets)).toBe(true);
		expect(isAtlasV3NativePrimaryHost("ksh.hu.example.com", sets)).toBe(false);
	});
});

describe("isTautologicalSentence", () => {
	it("catches the v2 Hungarian opener", () => {
		expect(
			isTautologicalSentence(
				"A 2026-os minimálbér változása a 2025-ös alapösszegekhez képest határozza meg az éves változás mértékét.",
			),
		).toBe(true);
	});

	it("leaves a normal sentence alone", () => {
		expect(
			isTautologicalSentence(
				"The EU added 65.1 GW of solar in 2025, below the 65.6 GW installed a year earlier.",
			),
		).toBe(false);
	});
});

describe("isLabelShapedTitle", () => {
	it("rejects a database-label title", () => {
		expect(isLabelShapedTitle("2025-ös referenciaadat")).toBe(true);
		expect(isLabelShapedTitle("Reference data")).toBe(true);
		expect(isLabelShapedTitle("")).toBe(true);
	});

	it("rejects the `entity — metric` heading v3 shipped eight times", () => {
		expect(
			isLabelShapedTitle("Commission — obligations entry into application"),
		).toBe(true);
		expect(
			isLabelShapedTitle("providers — compliance deadline for pre-2025 models"),
		).toBe(true);
	});

	/**
	 * The dash rule reads the LEFT of the dash, not the dash itself: a title
	 * that says something before it is a finding, and rewriting it from the
	 * claim made the heading worse.
	 */
	it("accepts a finding that merely contains a dash", () => {
		expect(
			isLabelShapedTitle("Framework 13 vs Dell XPS 13 — repairability"),
		).toBe(false);
		expect(
			isLabelShapedTitle(
				"Solar additions fell in 2025 — the first drop since 2016",
			),
		).toBe(false);
	});

	it("accepts a hyphenated word", () => {
		expect(
			isLabelShapedTitle("Grid-connected additions fell 17% in 2025"),
		).toBe(false);
	});

	it("accepts the sentence-shaped replacement", () => {
		expect(
			isLabelShapedTitle(
				"Commission: enforcement powers entry into application 2 August 2026",
			),
		).toBe(false);
	});

	it("accepts a title that states a finding", () => {
		expect(isLabelShapedTitle("Rooftop demand fell, utility-scale grew")).toBe(
			false,
		);
	});
});

describe("probeAtlasV3Register", () => {
	it("catches a hollow English lead sentence", () => {
		const probes = probeAtlasV3Register({
			text: "Repairability scores highlight a clear trade-off between modularity and compact design.",
			language: "en",
		});
		expect(probes.map((probe) => probe.code)).toContain("hollow");
	});

	it("catches Hungarian officialese", () => {
		const probes = probeAtlasV3Register({
			text: "A béremelés végrehajtásra kerül a következő évben.",
			language: "hu",
		});
		expect(probes.map((probe) => probe.code)).toContain("officialese");
	});

	it("says nothing about a dense factual sentence", () => {
		expect(
			probeAtlasV3Register({
				text: "SolarPower Europe puts 2025 grid-connected additions at 65.1 GW (as of December 2025).",
				language: "en",
			}),
		).toEqual([]);
	});
});
