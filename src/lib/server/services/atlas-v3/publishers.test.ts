import { describe, expect, it } from "vitest";
import {
	areIndependentHosts,
	isSyndicationHost,
	organisationForHost,
	registrableDomain,
	stripMirrorPrefixes,
} from "./publishers";

describe("stripMirrorPrefixes", () => {
	it("removes edge, mirror and environment labels", () => {
		expect(stripMirrorPrefixes("cdn.example.com")).toBe("example.com");
		expect(stripMirrorPrefixes("staging.example.com")).toBe("example.com");
		expect(stripMirrorPrefixes("amp.cdn.example.com")).toBe("example.com");
		expect(stripMirrorPrefixes("www.example.com")).toBe("example.com");
		expect(stripMirrorPrefixes("m.example.co.uk")).toBe("example.co.uk");
	});

	it("keeps a meaningful subdomain", () => {
		expect(stripMirrorPrefixes("data.worldbank.org")).toBe(
			"data.worldbank.org",
		);
	});
});

describe("registrableDomain", () => {
	it("handles multi-label public suffixes", () => {
		expect(registrableDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
		expect(registrableDomain("stats.gov.uk")).toBe("stats.gov.uk");
		expect(registrableDomain("blog.example.com")).toBe("example.com");
	});
});

describe("organisationForHost", () => {
	it("collapses one newsroom's several hostnames", () => {
		expect(organisationForHost("bbc.com")).toBe("bbc");
		expect(organisationForHost("www.bbc.co.uk")).toBe("bbc");
		expect(organisationForHost("theguardian.com")).toBe("guardian");
		expect(organisationForHost("guardian.co.uk")).toBe("guardian");
	});

	it("collapses every aggregator onto one organisation", () => {
		expect(organisationForHost("msn.com")).toBe("aggregator:syndicated");
		expect(organisationForHost("finance.yahoo.com")).toBe(
			"aggregator:syndicated",
		);
		expect(organisationForHost("biztoc.com")).toBe("aggregator:syndicated");
		expect(areIndependentHosts("msn.com", "biztoc.com")).toBe(false);
	});

	it("treats a mirror host as the same organisation as its origin", () => {
		expect(areIndependentHosts("example.com", "cdn.example.com")).toBe(false);
		expect(areIndependentHosts("example.com", "staging.example.com")).toBe(
			false,
		);
	});

	it("treats two unrelated publishers as independent", () => {
		expect(areIndependentHosts("iea.org", "irena.org")).toBe(true);
		expect(areIndependentHosts("bbc.com", "reuters.com")).toBe(true);
	});

	it("falls back to the registrable domain for unknown hosts", () => {
		expect(organisationForHost("blog.some-vendor.example")).toBe(
			"some-vendor.example",
		);
	});
});

describe("isSyndicationHost", () => {
	it("is true only for aggregators and wire distributors", () => {
		expect(isSyndicationHost("prnewswire.com")).toBe(true);
		expect(isSyndicationHost("news.yahoo.com")).toBe(true);
		expect(isSyndicationHost("reuters.com")).toBe(false);
		expect(isSyndicationHost("iea.org")).toBe(false);
	});
});
