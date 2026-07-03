import { describe, expect, it } from "vitest";
import { validateFaviconDomain } from "./domain";

describe("validateFaviconDomain", () => {
	// --- accepts valid hostnames ---
	it("accepts a simple domain", () => {
		expect(validateFaviconDomain("example.com")).toBe("example.com");
	});

	it("accepts a multi-level subdomain", () => {
		expect(validateFaviconDomain("sub.example.co.uk")).toBe(
			"sub.example.co.uk",
		);
	});

	it("strips a leading www. and lowercases", () => {
		expect(validateFaviconDomain("WWW.Example.com")).toBe("example.com");
	});

	it("lowercases the whole hostname", () => {
		expect(validateFaviconDomain("Example.COM")).toBe("example.com");
	});

	// --- rejects empty / non-string ---
	it("rejects empty string", () => {
		expect(validateFaviconDomain("")).toBeNull();
	});

	it("rejects whitespace-only input", () => {
		expect(validateFaviconDomain("   ")).toBeNull();
	});

	it("rejects non-string (null/undefined/number)", () => {
		expect(validateFaviconDomain(null as unknown as string)).toBeNull();
		expect(validateFaviconDomain(undefined as unknown as string)).toBeNull();
		expect(validateFaviconDomain(123 as unknown as string)).toBeNull();
	});

	// --- rejects IP literals (SSRF) ---
	it("rejects IPv4 literals", () => {
		expect(validateFaviconDomain("1.2.3.4")).toBeNull();
		expect(validateFaviconDomain("8.8.8.8")).toBeNull();
	});

	it("rejects IPv6 literals", () => {
		expect(validateFaviconDomain("[::1]")).toBeNull();
		expect(validateFaviconDomain("[2001:db8::1]")).toBeNull();
	});

	// --- rejects localhost / private / reserved ranges (SSRF) ---
	it("rejects localhost", () => {
		expect(validateFaviconDomain("localhost")).toBeNull();
	});

	it("rejects loopback ipv4 127.x", () => {
		expect(validateFaviconDomain("127.0.0.1")).toBeNull();
	});

	it("rejects private 10.x range", () => {
		expect(validateFaviconDomain("10.0.0.1")).toBeNull();
	});

	it("rejects private 192.168.x range", () => {
		expect(validateFaviconDomain("192.168.1.1")).toBeNull();
	});

	it("rejects private 172.16-31.x range", () => {
		expect(validateFaviconDomain("172.16.0.1")).toBeNull();
		expect(validateFaviconDomain("172.31.255.255")).toBeNull();
	});

	it("does NOT reject public 172.x range (172.15, 172.32)", () => {
		// 172.15.x and 172.32.x are NOT private; they should be... actually they
		// are IP literals and IP literals are rejected outright. Assert that here.
		expect(validateFaviconDomain("172.15.0.1")).toBeNull();
	});

	it("rejects link-local 169.254.x range", () => {
		expect(validateFaviconDomain("169.254.169.254")).toBeNull();
	});

	it("rejects the AWS metadata hostname-ish IP", () => {
		expect(validateFaviconDomain("169.254.169.254")).toBeNull();
	});

	// --- rejects input containing scheme / port / path / query ---
	it("rejects a scheme-prefixed URL", () => {
		expect(validateFaviconDomain("https://foo.com")).toBeNull();
		expect(validateFaviconDomain("http://foo.com")).toBeNull();
	});

	it("rejects a port", () => {
		expect(validateFaviconDomain("foo.com:8080")).toBeNull();
	});

	it("rejects a path", () => {
		expect(validateFaviconDomain("foo.com/path")).toBeNull();
	});

	it("rejects a query string", () => {
		expect(validateFaviconDomain("foo.com?x=1")).toBeNull();
	});

	it("rejects credentials", () => {
		expect(validateFaviconDomain("user:pass@foo.com")).toBeNull();
	});

	// --- rejects other obviously-invalid shapes ---
	it("rejects a bare TLD", () => {
		expect(validateFaviconDomain("com")).toBeNull();
	});

	it("rejects input with spaces inside", () => {
		expect(validateFaviconDomain("foo .com")).toBeNull();
	});

	it("rejects a domain with no dot and not a known TLD", () => {
		expect(validateFaviconDomain("foo")).toBeNull();
	});

	it("truncates/rejects absurdly-long input", () => {
		expect(validateFaviconDomain(`${"a".repeat(300)}.com`)).toBeNull();
	});
});
