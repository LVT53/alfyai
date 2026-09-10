import { describe, expect, it } from "vitest";
import { atlasV3NativeSourcesForRequest } from "./language-standard";
import {
	atlasV3SourceTier,
	selectAtlasV3PagesToRead,
	tierCanCorroborate,
} from "./source-tier";

describe("atlasV3SourceTier", () => {
	it("puts regulators, statistics offices and standards bodies first", () => {
		expect(
			atlasV3SourceTier({
				host: "iea.org",
				canonicalUrl: "https://iea.org/reports/x",
			}),
		).toBe("primary");
		expect(
			atlasV3SourceTier({
				host: "cso.ie",
				canonicalUrl: "https://cso.ie/en/x",
			}),
		).toBe("primary");
		expect(
			atlasV3SourceTier({
				host: "iso.org",
				canonicalUrl: "https://iso.org/standard/1",
			}),
		).toBe("primary");
		expect(
			atlasV3SourceTier({ host: "epa.gov", canonicalUrl: "https://epa.gov/a" }),
		).toBe("primary");
		expect(
			atlasV3SourceTier({
				host: "ox.ac.uk",
				canonicalUrl: "https://ox.ac.uk/a",
			}),
		).toBe("primary");
	});

	it("promotes native primary sources for the request's jurisdiction", () => {
		const nativeSources = atlasV3NativeSourcesForRequest({
			query: "Mennyi lesz a minimálbér Magyarországon?",
			language: "hu",
		});
		expect(
			atlasV3SourceTier({
				host: "www.ksh.hu",
				canonicalUrl: "https://ksh.hu/stadat/x",
				nativeSources,
			}),
		).toBe("primary");
		expect(
			atlasV3SourceTier({
				host: "hrportal.hu",
				canonicalUrl: "https://hrportal.hu/hr/minimalber",
				nativeSources,
			}),
		).toBe("press");
	});

	it("calls a marketplace, a menu and a search page weak whatever the host", () => {
		expect(
			atlasV3SourceTier({
				host: "frame.work",
				canonicalUrl: "https://frame.work/marketplace/mainboards",
			}),
		).toBe("weak");
		expect(
			atlasV3SourceTier({
				host: "reddit.com",
				canonicalUrl: "https://reddit.com/r/x/y",
			}),
		).toBe("weak");
		expect(
			atlasV3SourceTier({
				host: "example.gov",
				canonicalUrl: "https://example.gov/search?q=solar",
			}),
		).toBe("weak");
	});

	it("collapses syndicators onto the aggregator tier", () => {
		expect(
			atlasV3SourceTier({
				host: "msn.com",
				canonicalUrl: "https://msn.com/en/a",
			}),
		).toBe("aggregator");
		expect(
			atlasV3SourceTier({
				host: "prnewswire.com",
				canonicalUrl: "https://prnewswire.com/news/a",
			}),
		).toBe("aggregator");
	});

	it("treats a manufacturer's own documentation as primary", () => {
		expect(
			atlasV3SourceTier({
				host: "support.frame.work",
				canonicalUrl: "https://support.frame.work/guides/battery",
				manufacturerHosts: ["frame.work"],
			}),
		).toBe("primary");
	});

	it("treats an unknown host as press rather than as evidence-grade", () => {
		expect(
			atlasV3SourceTier({
				host: "solarnewsdaily.example",
				canonicalUrl: "https://solarnewsdaily.example/a",
			}),
		).toBe("press");
	});
});

describe("tierCanCorroborate", () => {
	it("only lets primary and press count as a publisher", () => {
		expect(tierCanCorroborate("primary")).toBe(true);
		expect(tierCanCorroborate("press")).toBe(true);
		expect(tierCanCorroborate("aggregator")).toBe(false);
		expect(tierCanCorroborate("weak")).toBe(false);
	});
});

describe("selectAtlasV3PagesToRead", () => {
	const candidates = [
		{ host: "reddit.com", canonicalUrl: "https://reddit.com/r/solar/a" },
		{ host: "bbc.com", canonicalUrl: "https://bbc.com/news/a" },
		{ host: "iea.org", canonicalUrl: "https://iea.org/reports/a" },
		{ host: "bbc.co.uk", canonicalUrl: "https://bbc.co.uk/news/b" },
		{ host: "cso.ie", canonicalUrl: "https://cso.ie/a" },
	];

	it("reads the best tier first and never reads a weak page", () => {
		const chosen = selectAtlasV3PagesToRead(candidates, 3);
		expect(chosen.map((entry) => entry.host)).toEqual([
			"iea.org",
			"cso.ie",
			"bbc.com",
		]);
	});

	it("spends the first pass on distinct publishers", () => {
		// bbc.com and bbc.co.uk are one newsroom; the second must not take a slot
		// from a second publisher.
		const chosen = selectAtlasV3PagesToRead(candidates, 2);
		expect(chosen.map((entry) => entry.host)).toEqual(["iea.org", "cso.ie"]);
		expect(chosen.map((entry) => entry.host)).not.toContain("bbc.co.uk");
	});

	it("falls back to a second page from a seen publisher when nothing else is left", () => {
		const chosen = selectAtlasV3PagesToRead(
			[
				{ host: "bbc.com", canonicalUrl: "https://bbc.com/news/a" },
				{ host: "bbc.co.uk", canonicalUrl: "https://bbc.co.uk/news/b" },
			],
			2,
		);
		expect(chosen).toHaveLength(2);
	});

	it("returns nothing when every candidate is weak", () => {
		expect(
			selectAtlasV3PagesToRead(
				[{ host: "reddit.com", canonicalUrl: "https://reddit.com/r/a/b" }],
				3,
			),
		).toEqual([]);
	});
});
