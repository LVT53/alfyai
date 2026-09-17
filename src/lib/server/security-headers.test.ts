import { describe, expect, it } from "vitest";
import {
	appendCspSources,
	buildSecurityHeaders,
	isSecureRequest,
	parseCspModeEnv,
	type SecurityHeaderInput,
	sentryConnectSource,
} from "./security-headers";

const SVELTEKIT_CSP =
	"default-src 'self'; script-src 'self' 'nonce-abc123'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'";

function input(overrides: Partial<SecurityHeaderInput> = {}) {
	return buildSecurityHeaders({
		pathname: "/",
		contentType: "text/html; charset=utf-8",
		isSecureRequest: true,
		isProduction: true,
		cspMode: "report-only",
		csp: SVELTEKIT_CSP,
		...overrides,
	});
}

describe("parseCspModeEnv", () => {
	it.each([
		["off", "off"],
		["OFF", "off"],
		["  enforce  ", "enforce"],
		["report-only", "report-only"],
	])("parses %s", (value, expected) => {
		expect(parseCspModeEnv(value)).toBe(expected);
	});

	it("falls back to report-only for anything it does not recognise", () => {
		// A typo must never be the thing that puts production onto an enforcing
		// policy nobody has watched a console for.
		for (const value of [undefined, "", "enforced", "on", "true", "yes"]) {
			expect(parseCspModeEnv(value)).toBe("report-only");
		}
	});
});

describe("buildSecurityHeaders", () => {
	describe("baseline headers", () => {
		it("sets nosniff and a referrer policy on documents", () => {
			const { set } = input();
			expect(set["x-content-type-options"]).toBe("nosniff");
			expect(set["referrer-policy"]).toBe("strict-origin-when-cross-origin");
		});

		it("sets them on API responses too", () => {
			const { set } = input({
				pathname: "/api/conversations",
				contentType: "application/json",
			});
			expect(set["x-content-type-options"]).toBe("nosniff");
			expect(set["referrer-policy"]).toBe("strict-origin-when-cross-origin");
		});
	});

	describe("document-only headers", () => {
		it("frames, permissions and COOP on an HTML document", () => {
			const { set } = input();
			expect(set["x-frame-options"]).toBe("SAMEORIGIN");
			expect(set["cross-origin-opener-policy"]).toBe("same-origin");
			expect(set["permissions-policy"]).toContain("camera=()");
			expect(set["permissions-policy"]).toContain("microphone=()");
			expect(set["permissions-policy"]).toContain("geolocation=()");
		});

		it("does not claim clipboard, which the app actually uses", () => {
			const { set } = input();
			expect(set["permissions-policy"]).not.toContain("clipboard");
		});

		it.each([
			["a JSON API response", "/api/conversations", "application/json"],
			["a stylesheet", "/_app/immutable/assets/app.css", "text/css"],
			["a response with no content type", "/api/health", null],
		])("leaves %s alone", (_label, pathname, contentType) => {
			const { set } = input({ pathname, contentType });
			expect(set["x-frame-options"]).toBeUndefined();
			expect(set["cross-origin-opener-policy"]).toBeUndefined();
			expect(set["permissions-policy"]).toBeUndefined();
		});

		it("leaves an HTML file preview alone because it lives under /api/", () => {
			// /api/knowledge/[id]/preview and /api/chat/files/[id]/preview return
			// text/html with their own hardened headers. The preview runtime
			// matches their CSP string exactly to decide whether a generated
			// report may run scripts, so anything added here would be noise at
			// best and a silent downgrade at worst.
			const { set } = input({
				pathname: "/api/knowledge/doc-1/preview",
				contentType: "text/html; charset=utf-8",
			});
			expect(set["x-frame-options"]).toBeUndefined();
			expect(set["cross-origin-opener-policy"]).toBeUndefined();
		});
	});

	describe("HSTS", () => {
		it("is sent on production HTTPS", () => {
			expect(input().set["strict-transport-security"]).toContain("max-age=");
		});

		it("is absent on plain HTTP", () => {
			expect(
				input({ isSecureRequest: false }).set["strict-transport-security"],
			).toBeUndefined();
		});

		it("is absent outside production even over HTTPS", () => {
			expect(
				input({ isProduction: false }).set["strict-transport-security"],
			).toBeUndefined();
		});
	});

	describe("CSP modes", () => {
		it("report-only moves the policy to the report-only header", () => {
			const { set, remove } = input({ cspMode: "report-only" });
			expect(set["content-security-policy-report-only"]).toBe(SVELTEKIT_CSP);
			expect(set["content-security-policy"]).toBeUndefined();
			expect(remove).toContain("content-security-policy");
		});

		it("enforce ships the policy as-is", () => {
			const { set, remove } = input({ cspMode: "enforce" });
			expect(set["content-security-policy"]).toBe(SVELTEKIT_CSP);
			expect(set["content-security-policy-report-only"]).toBeUndefined();
			expect(remove).not.toContain("content-security-policy");
		});

		it("off removes the policy entirely", () => {
			const { set, remove } = input({ cspMode: "off" });
			expect(set["content-security-policy"]).toBeUndefined();
			expect(set["content-security-policy-report-only"]).toBeUndefined();
			expect(remove).toContain("content-security-policy");
		});

		it("does nothing about CSP on a response that never had one", () => {
			const { set, remove } = input({
				csp: null,
				pathname: "/api/conversations",
				contentType: "application/json",
			});
			expect(set["content-security-policy-report-only"]).toBeUndefined();
			expect(remove).toEqual([]);
		});

		it("adds the Sentry origin to connect-src", () => {
			const { set } = input({
				extraConnectSources: ["https://o1.ingest.sentry.io"],
			});
			expect(set["content-security-policy-report-only"]).toContain(
				"connect-src 'self' https://o1.ingest.sentry.io",
			);
			// And only to connect-src.
			expect(set["content-security-policy-report-only"]).toContain(
				"default-src 'self';",
			);
		});
	});

	describe("headers a route already set", () => {
		it("never overwrites them", () => {
			// The file-preview responses set a stricter Referrer-Policy and their
			// own CSP; this function must defer to them completely.
			const { set } = input({
				pathname: "/api/knowledge/doc-1/preview",
				contentType: "text/html; charset=utf-8",
				existingHeaders: new Set(["referrer-policy", "x-content-type-options"]),
			});
			expect(set["referrer-policy"]).toBeUndefined();
			expect(set["x-content-type-options"]).toBeUndefined();
		});

		it("still applies the headers the route did not claim", () => {
			const { set } = input({
				existingHeaders: new Set(["referrer-policy"]),
			});
			expect(set["referrer-policy"]).toBeUndefined();
			expect(set["x-content-type-options"]).toBe("nosniff");
			expect(set["x-frame-options"]).toBe("SAMEORIGIN");
		});
	});
});

describe("appendCspSources", () => {
	it("appends to the named directive only", () => {
		const result = appendCspSources(
			"default-src 'self'; connect-src 'self'",
			"connect-src",
			["https://sentry.example"],
		);
		expect(result).toBe(
			"default-src 'self'; connect-src 'self' https://sentry.example",
		);
	});

	it("does not duplicate a source that is already there", () => {
		const policy = "connect-src 'self' https://sentry.example";
		expect(
			appendCspSources(policy, "connect-src", ["https://sentry.example"]),
		).toBe(policy);
	});

	it("leaves the policy alone when the directive is absent", () => {
		// Falling back to default-src would turn "let Sentry connect" into "let
		// Sentry be a script source", because default-src covers every directive
		// that is not otherwise specified.
		const policy = "default-src 'self'; script-src 'self'";
		expect(
			appendCspSources(policy, "connect-src", ["https://sentry.example"]),
		).toBe(policy);
	});

	it("is a no-op with no sources", () => {
		const policy = "connect-src 'self'";
		expect(appendCspSources(policy, "connect-src", [])).toBe(policy);
	});

	it("tolerates a trailing semicolon", () => {
		expect(
			appendCspSources("connect-src 'self';", "connect-src", [
				"https://x.test",
			]),
		).toBe("connect-src 'self' https://x.test");
	});
});

describe("sentryConnectSource", () => {
	it("keeps only the origin, never the DSN's public key", () => {
		expect(
			sentryConnectSource("https://abc123@o987.ingest.de.sentry.io/456"),
		).toBe("https://o987.ingest.de.sentry.io");
	});

	it("returns null for an absent or unparseable DSN", () => {
		expect(sentryConnectSource(undefined)).toBeNull();
		expect(sentryConnectSource("")).toBeNull();
		expect(sentryConnectSource("   ")).toBeNull();
		expect(sentryConnectSource("not a url")).toBeNull();
	});
});

describe("isSecureRequest", () => {
	it("prefers an explicit forwarded protocol", () => {
		expect(
			isSecureRequest(
				new URL("https://app.example/"),
				new Headers({ "x-forwarded-proto": "http" }),
			),
		).toBe(false);
		expect(
			isSecureRequest(
				new URL("http://localhost:3001/"),
				new Headers({ "x-forwarded-proto": "https" }),
			),
		).toBe(true);
	});

	it("reads only the first hop of a forwarded chain", () => {
		expect(
			isSecureRequest(
				new URL("http://localhost/"),
				new Headers({ "x-forwarded-proto": "https, http" }),
			),
		).toBe(true);
	});

	it("falls back to the URL's protocol", () => {
		expect(
			isSecureRequest(new URL("https://app.example/"), new Headers()),
		).toBe(true);
		expect(isSecureRequest(new URL("http://localhost/"), new Headers())).toBe(
			false,
		);
	});
});
