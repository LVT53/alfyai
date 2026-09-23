// Ported from atlas-v2/evidence-index.test.ts: the identity and stub cases
// for the filters copied into source-filters.ts.
import { describe, expect, it } from "vitest";
import {
	articleIdentityKey,
	isBoilerplateOnly,
	isRedirectStubText,
	isSocialProfileHost,
	isStatusStubText,
} from "./source-filters";

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
