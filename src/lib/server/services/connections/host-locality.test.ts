import { describe, expect, it } from "vitest";
import { assertPublicHttpsUrl, isPrivateHostname } from "./host-locality";

describe("isPrivateHostname", () => {
	it.each([
		["localhost"],
		["localhost.localdomain"],
		["ip6-localhost"],
		["ip6-loopback"],
		["127.0.0.1"],
		["192.168.1.96"],
		["10.1.2.3"],
		["172.16.5.5"],
		["169.254.1.1"],
		["0.0.0.0"],
		["::1"],
		["0:0:0:0:0:0:0:1"],
		["fe80::1"],
		["my-box.local"],
	])("returns true for %s", (host) => {
		expect(isPrivateHostname(host)).toBe(true);
	});

	it.each([
		["api.deepseek.com"],
		["1.2.3.4"],
		["example.com"],
	])("returns false for %s", (host) => {
		expect(isPrivateHostname(host)).toBe(false);
	});

	it("returns false for an empty string", () => {
		expect(isPrivateHostname("")).toBe(false);
	});
});

describe("assertPublicHttpsUrl", () => {
	it("accepts a public https URL", () => {
		expect(assertPublicHttpsUrl("https://alfycloud.hu")).toBe(
			"https://alfycloud.hu",
		);
	});

	it("rejects a non-https URL", () => {
		expect(() => assertPublicHttpsUrl("http://alfycloud.hu")).toThrow();
	});

	it("rejects localhost", () => {
		expect(() => assertPublicHttpsUrl("https://localhost")).toThrow();
	});

	it("rejects loopback IPv4", () => {
		expect(() => assertPublicHttpsUrl("https://127.0.0.1")).toThrow();
	});

	it("rejects 10.0.0.0/8 private range", () => {
		expect(() => assertPublicHttpsUrl("https://10.1.2.3")).toThrow();
	});

	it("rejects 192.168.0.0/16 private range", () => {
		expect(() => assertPublicHttpsUrl("https://192.168.1.5")).toThrow();
	});

	it("rejects a 169.254.0.0/16 link-local host", () => {
		expect(() => assertPublicHttpsUrl("https://169.254.1.1")).toThrow();
	});

	it("rejects a .local mDNS host", () => {
		expect(() => assertPublicHttpsUrl("https://my-box.local")).toThrow();
	});

	it("rejects a non-URL string", () => {
		// https:// is prepended (embedded whitespace).
		expect(() => assertPublicHttpsUrl("not a url")).toThrow();
	});

	it("rejects an empty string", () => {
		expect(() => assertPublicHttpsUrl("")).toThrow();
	});

	it("rejects a whitespace-only string", () => {
		expect(() => assertPublicHttpsUrl("   ")).toThrow();
	});

	it("prepends https:// to a bare host with no scheme", () => {
		expect(assertPublicHttpsUrl("cloud.example.com")).toBe(
			"https://cloud.example.com",
		);
	});

	it("prepends https:// to a bare host and preserves port/path", () => {
		expect(assertPublicHttpsUrl("cloud.example.com:8443/dav")).toBe(
			"https://cloud.example.com:8443/dav",
		);
	});

	it("trims surrounding whitespace before checking for a scheme", () => {
		expect(assertPublicHttpsUrl("  cloud.example.com  ")).toBe(
			"https://cloud.example.com",
		);
	});

	it("leaves an explicit https:// URL byte-for-byte unchanged", () => {
		expect(assertPublicHttpsUrl("https://cloud.example.com:8443/dav")).toBe(
			"https://cloud.example.com:8443/dav",
		);
	});

	it("still rejects an explicit http:// URL rather than upgrading it", () => {
		expect(() => assertPublicHttpsUrl("http://cloud.example.com")).toThrow();
	});

	it("rejects a bare localhost host", () => {
		expect(() => assertPublicHttpsUrl("localhost")).toThrow();
	});

	it("rejects a bare loopback IPv4 host", () => {
		expect(() => assertPublicHttpsUrl("127.0.0.1")).toThrow();
	});

	it("rejects a bare 10.0.0.0/8 host", () => {
		expect(() => assertPublicHttpsUrl("10.0.0.1")).toThrow();
	});

	it("rejects a bare 192.168.0.0/16 host", () => {
		expect(() => assertPublicHttpsUrl("192.168.1.5")).toThrow();
	});

	it("rejects a bracketed bare IPv6 loopback host", () => {
		expect(() => assertPublicHttpsUrl("[::1]")).toThrow();
	});

	it("rejects an https IPv6 loopback host (scheme present, unchanged behavior)", () => {
		expect(() => assertPublicHttpsUrl("https://[::1]")).toThrow();
	});
});
