import { describe, expect, it } from "vitest";
import {
	articleIdentityKey,
	buildAtlasV2EvidenceIndex,
	formatSourceLine,
	isBoilerplateOnly,
	isRedirectStubText,
	isSocialProfileHost,
	isStatusStubText,
	mergeAtlasV2EvidenceIndexes,
	sourceEvidenceText,
} from "./evidence-index";
import type { AtlasV2RawSource } from "./types";

function raw(overrides: Partial<AtlasV2RawSource> = {}): AtlasV2RawSource {
	return {
		questionId: "q1",
		round: 1,
		url: "https://example.com/news/eu-solar-record",
		title: "EU solar hits a record",
		snippets: [
			"The European Union added 8,000 MW of new solar capacity during the first quarter, according to the association's tracker.",
		],
		publishedAt: "2026-02-11",
		pageExcerpt: null,
		...overrides,
	};
}

describe("junk detectors", () => {
	it("recognises the redirect stub the staging report shipped", () => {
		expect(isRedirectStubText("301 Moved Permanently")).toBe(true);
		expect(isRedirectStubText("302 Found")).toBe(true);
		expect(isRedirectStubText("Redirecting…")).toBe(true);
		expect(isRedirectStubText("Moved permanently to the new site")).toBe(true);
		expect(isRedirectStubText("EU solar hits a record")).toBe(false);
	});

	it("recognises HTTP error and bot-wall stubs", () => {
		expect(isStatusStubText("403 Forbidden")).toBe(true);
		expect(isStatusStubText("404 Not Found")).toBe(true);
		expect(isStatusStubText("Just a moment...")).toBe(true);
		expect(isStatusStubText("Enable JavaScript and cookies to continue")).toBe(
			true,
		);
		expect(isStatusStubText("Solar capacity grew 12% in 2026")).toBe(false);
	});

	it("recognises social profile hosts, including subdomains", () => {
		expect(isSocialProfileHost("linkedin.com")).toBe(true);
		expect(isSocialProfileHost("www.linkedin.com")).toBe(true);
		expect(isSocialProfileHost("de.linkedin.com")).toBe(true);
		expect(isSocialProfileHost("x.com")).toBe(true);
		expect(isSocialProfileHost("iea.org")).toBe(false);
	});

	it("treats a nav-only snippet as carrying no evidence", () => {
		expect(
			isBoilerplateOnly("Home | About | Contact | Sign in | Subscribe"),
		).toBe(true);
		expect(isBoilerplateOnly("Skip to main content Cookie policy")).toBe(true);
		expect(
			isBoilerplateOnly(
				"The European Union added 8,000 MW of new solar capacity.",
			),
		).toBe(false);
	});

	it("keeps a short snippet that carries a figure", () => {
		expect(isBoilerplateOnly("Capacity: 8 GW")).toBe(false);
	});
});

describe("articleIdentityKey", () => {
	it("collapses CDN and staging hosts of the same article", () => {
		const canonical = articleIdentityKey({
			canonicalUrl: "https://example.com/news/eu-solar-record",
			host: "example.com",
			title: "EU solar hits a record",
		});
		const cdn = articleIdentityKey({
			canonicalUrl: "https://cdn.example.com/news/eu-solar-record",
			host: "cdn.example.com",
			title: "EU solar hits a record",
		});
		const staging = articleIdentityKey({
			canonicalUrl: "https://staging.example.com/news/eu-solar-record.amp.html",
			host: "staging.example.com",
			title: "EU solar hits a record",
		});
		expect(canonical).not.toBeNull();
		expect(cdn).toBe(canonical);
		expect(staging).toBe(canonical);
	});

	it("does not collapse two different articles on one host", () => {
		expect(
			articleIdentityKey({
				canonicalUrl: "https://example.com/news/eu-solar-record",
				host: "example.com",
				title: "EU solar hits a record",
			}),
		).not.toBe(
			articleIdentityKey({
				canonicalUrl: "https://example.com/news/eu-wind-record",
				host: "example.com",
				title: "EU wind hits a record",
			}),
		);
	});

	it("returns null when there is too little signal to claim identity", () => {
		expect(
			articleIdentityKey({
				canonicalUrl: "https://example.com/",
				host: "example.com",
				title: "News",
			}),
		).toBeNull();
	});
});

describe("buildAtlasV2EvidenceIndex", () => {
	it("numbers the surviving sources from one and records what it dropped", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw(),
			raw({
				url: "https://iea.org/reports/solar-2026",
				title: "Solar market update 2026",
				snippets: ["Global additions reached 8 GW in the first quarter."],
			}),
		]);
		expect(index.sources.map((source) => source.n)).toEqual([1, 2]);
		expect(index.filteredCount).toBe(0);
		expect(index.byQuestion.q1).toEqual([1, 2]);
	});

	it("drops the 301 stub instead of listing it as a source", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw(),
			raw({
				url: "https://old.example.org/report",
				title: "301 Moved Permanently",
				snippets: ["The document has moved here."],
			}),
		]);
		expect(index.sources).toHaveLength(1);
		expect(index.dropped).toEqual([
			expect.objectContaining({ reason: "redirect_stub" }),
		]);
		expect(index.filteredCount).toBe(1);
	});

	it("drops the LinkedIn company page", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw(),
			raw({
				url: "https://www.linkedin.com/company/solar-europe",
				title: "Solar Europe | LinkedIn",
				snippets: [
					"Solar Europe is an industry association with 4,000 members.",
				],
			}),
		]);
		expect(index.sources).toHaveLength(1);
		expect(index.dropped[0]).toMatchObject({ reason: "social_profile" });
	});

	it("keeps one entry for the same article served three ways", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw({ url: "https://cdn.example.com/news/eu-solar-record" }),
			raw({ url: "https://example.com/news/eu-solar-record" }),
			raw({ url: "https://staging.example.com/news/eu-solar-record" }),
		]);
		expect(index.sources).toHaveLength(1);
		// The non-mirror host wins.
		expect(index.sources[0].host).toBe("example.com");
		expect(index.filteredCount).toBe(2);
		expect(index.dropped.map((entry) => entry.reason)).toEqual([
			"duplicate_article",
			"duplicate_article",
		]);
	});

	it("merges a repeat of the same canonical URL rather than numbering it twice", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw({ questionId: "q1" }),
			raw({
				questionId: "q2",
				url: "https://example.com/news/eu-solar-record?utm_source=news",
				snippets: ["A second excerpt from the same article about 8,000 MW."],
			}),
		]);
		expect(index.sources).toHaveLength(1);
		expect(index.sources[0].questionIds).toEqual(["q1", "q2"]);
		expect(index.sources[0].snippets).toHaveLength(2);
		expect(index.byQuestion).toEqual({ q1: [1], q2: [1] });
	});

	it("drops a source whose every snippet is navigation chrome", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw({
				url: "https://vendor.example/blog",
				title: "Vendor blog",
				snippets: ["Home | About | Contact | Subscribe"],
			}),
		]);
		expect(index.sources).toHaveLength(0);
		expect(index.dropped[0]).toMatchObject({ reason: "boilerplate_only" });
	});

	it("drops an unparsable URL", () => {
		const index = buildAtlasV2EvidenceIndex([raw({ url: "not a url" })]);
		expect(index.sources).toHaveLength(0);
		expect(index.dropped[0]).toMatchObject({ reason: "unparsable_url" });
	});

	it("assigns a publisher organisation so corroboration can be independent", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw({ url: "https://www.bbc.co.uk/news/solar" }),
			raw({
				url: "https://www.bbc.com/news/solar-follow-up",
				title: "Solar follow up story",
			}),
			raw({
				url: "https://iea.org/reports/solar",
				title: "Solar market report",
			}),
		]);
		const organisations = index.sources.map((source) => source.organisation);
		expect(organisations[0]).toBe("bbc");
		expect(organisations[1]).toBe("bbc");
		expect(organisations[2]).toBe("iea");
	});

	it("normalises the publication date", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw({ publishedAt: "2026-02-11T09:30:00Z" }),
		]);
		expect(index.sources[0].date).toBe("2026-02-11");
	});
});

describe("source projections", () => {
	it("joins snippets and the page excerpt into one checkable text", () => {
		const index = buildAtlasV2EvidenceIndex([
			raw({ pageExcerpt: "Full page text mentioning 8,000 MW again." }),
		]);
		const text = sourceEvidenceText(index.sources[0]);
		expect(text).toContain("8,000 MW of new solar capacity");
		expect(text).toContain("Full page text");
	});

	it("formats a source line as title — host, date", () => {
		const index = buildAtlasV2EvidenceIndex([raw()]);
		expect(formatSourceLine(index.sources[0])).toBe(
			"EU solar hits a record — example.com, 2026-02-11",
		);
	});
});

describe("mergeAtlasV2EvidenceIndexes", () => {
	it("returns the fresh index when there is no seed", () => {
		const fresh = buildAtlasV2EvidenceIndex([raw()]);
		expect(mergeAtlasV2EvidenceIndexes(null, fresh)).toBe(fresh);
	});

	it("renumbers a seeded index together with fresh sources", () => {
		const seed = buildAtlasV2EvidenceIndex([raw()]);
		const fresh = buildAtlasV2EvidenceIndex([
			raw({
				url: "https://iea.org/reports/solar-2026",
				title: "Solar market update 2026",
				snippets: ["Global additions reached 8 GW in the first quarter."],
			}),
		]);
		const merged = mergeAtlasV2EvidenceIndexes(seed, fresh);
		expect(merged.sources.map((source) => source.n)).toEqual([1, 2]);
		expect(merged.sources.map((source) => source.host)).toEqual([
			"example.com",
			"iea.org",
		]);
	});
});
