import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditAppHtml } from "./audit";
import { APP_CONTRACT_RULES, APP_GLITCH_RULE_IDS } from "./contract";

const PASSING_FIXTURE = readFileSync(
	path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../../../../../tests/fixtures/artifacts/app/passing-app.html",
	),
	"utf8",
);

function checkFor(checks: ReturnType<typeof auditAppHtml>, rule: string) {
	const found = checks.find((check) => check.rule === rule);
	if (!found) throw new Error(`no check for rule ${rule}`);
	return found;
}

describe("auditAppHtml", () => {
	it("runs all nineteen rules, always, in APP_CONTRACT_RULES order", () => {
		const checks = auditAppHtml("<html></html>");
		expect(checks).toHaveLength(19);
		expect(checks.map((check) => check.rule)).toEqual(
			APP_CONTRACT_RULES.map((rule) => rule.id),
		);
	});

	it("never throws on malformed or empty input", () => {
		expect(() => auditAppHtml("")).not.toThrow();
		expect(() => auditAppHtml("not html at all")).not.toThrow();
	});

	it("a real generated app (the P1 prototype's) passes every glitch check and at most two notes", () => {
		const checks = auditAppHtml(PASSING_FIXTURE);
		const glitches = checks.filter(
			(check) => check.severity === "glitch" && !check.passed,
		);
		const notes = checks.filter(
			(check) => check.severity === "note" && !check.passed,
		);
		expect(glitches).toEqual([]);
		expect(notes.length).toBeLessThanOrEqual(2);
		// The one expected note failure: this fixture predates the token
		// rename and still uses the prototype's shorthand names.
		expect(notes.map((n) => n.rule)).toEqual(["tokens"]);
	});

	describe("the five glitch rules", () => {
		it("no-script-src flags an external script", () => {
			const check = checkFor(
				auditAppHtml('<script src="https://cdn.example.com/x.js"></script>'),
				"no-script-src",
			);
			expect(check.passed).toBe(false);
			expect(check.severity).toBe("glitch");
			expect(check.detail).toContain("https://cdn.example.com/x.js");
		});

		it("no-link-href flags an external stylesheet or font", () => {
			const check = checkFor(
				auditAppHtml('<link href="https://fonts.example.com/a.css">'),
				"no-link-href",
			);
			expect(check.passed).toBe(false);
			expect(check.severity).toBe("glitch");
		});

		it("no-remote-img flags a remote image", () => {
			const check = checkFor(
				auditAppHtml('<img src="https://example.com/pic.png">'),
				"no-remote-img",
			);
			expect(check.passed).toBe(false);
		});

		it.each([
			"fetch(",
			"XMLHttpRequest",
			"WebSocket",
			"EventSource",
			"sendBeacon",
			"@import",
		])("no-network-api flags %s", (needle) => {
			const check = checkFor(
				auditAppHtml(`<script>${needle}</script>`),
				"no-network-api",
			);
			expect(check.passed).toBe(false);
			expect(check.detail).toContain(needle);
		});

		it.each([
			"localStorage",
			"sessionStorage",
			"indexedDB",
			"document.cookie",
		])("no-web-storage flags %s", (needle) => {
			const check = checkFor(
				auditAppHtml(`<script>${needle}.getItem('x')</script>`),
				"no-web-storage",
			);
			expect(check.passed).toBe(false);
		});
	});

	describe("the note rules", () => {
		it("tokens: reports how many of the six real tokens are missing", () => {
			const check = checkFor(
				auditAppHtml(":root { --surface-page: #fff; --accent: #000; }"),
				"tokens",
			);
			expect(check.passed).toBe(false);
			expect(check.detail).toContain("2/6");
		});

		it("dark: requires a prefers-color-scheme: dark block", () => {
			expect(checkFor(auditAppHtml(""), "dark").passed).toBe(false);
			expect(
				checkFor(auditAppHtml("@media (prefers-color-scheme: dark) {}"), "dark")
					.passed,
			).toBe(true);
		});

		it("uses-vars: requires at least five var(--…) references", () => {
			const four = "a{c:var(--a)}b{c:var(--b)}c{c:var(--c)}d{c:var(--d)}";
			expect(checkFor(auditAppHtml(four), "uses-vars").passed).toBe(false);
			expect(
				checkFor(auditAppHtml(`${four}e{c:var(--e)}`), "uses-vars").passed,
			).toBe(true);
		});

		it("no-hardcoded-extremes: only exact #fff/#000 literals count, not near-misses", () => {
			expect(
				checkFor(auditAppHtml("color:#fff"), "no-hardcoded-extremes").passed,
			).toBe(false);
			expect(
				checkFor(auditAppHtml("color:#ffffff"), "no-hardcoded-extremes").passed,
			).toBe(false);
			expect(
				checkFor(auditAppHtml("color:#fffabc"), "no-hardcoded-extremes").passed,
			).toBe(true);
		});

		it("georgia / helvetica: case-insensitive presence", () => {
			expect(checkFor(auditAppHtml("font: georgia"), "georgia").passed).toBe(
				true,
			);
			expect(
				checkFor(auditAppHtml("font: HELVETICA"), "helvetica").passed,
			).toBe(true);
		});

		it("alfy-storage: detects window.alfy.storage usage with flexible spacing", () => {
			expect(
				checkFor(auditAppHtml("window.alfy.storage.get('k')"), "alfy-storage")
					.passed,
			).toBe(true);
			expect(checkFor(auditAppHtml(""), "alfy-storage").passed).toBe(false);
		});

		it("viewport: requires the viewport meta tag", () => {
			expect(
				checkFor(
					auditAppHtml('<meta name="viewport" content="width=device-width">'),
					"viewport",
				).passed,
			).toBe(true);
			expect(checkFor(auditAppHtml(""), "viewport").passed).toBe(false);
		});

		it("fluid: flags a fixed width above 420px but not max-width or a smaller value", () => {
			expect(checkFor(auditAppHtml("width: 800px"), "fluid").passed).toBe(
				false,
			);
			expect(checkFor(auditAppHtml("max-width: 800px"), "fluid").passed).toBe(
				true,
			);
			expect(checkFor(auditAppHtml("width: 300px"), "fluid").passed).toBe(true);
		});

		it("size: flags a document over ~460 lines", () => {
			const long = Array.from({ length: 461 }, () => "x").join("\n");
			expect(checkFor(auditAppHtml(long), "size").passed).toBe(false);
			const short = Array.from({ length: 10 }, () => "x").join("\n");
			expect(checkFor(auditAppHtml(short), "size").passed).toBe(true);
		});
	});

	// Ruling 58 (RV-2A's sandbox review): dialogs and eval are glitches (the
	// app still works, degraded by the real sandbox); navigation and WebRTC
	// are violations (a sandbox-escape attempt, handled by generate.ts's
	// retry-then-refuse, not just a card line).
	describe("ruling 58's four sandbox rules", () => {
		it.each([
			"alert(",
			"confirm(",
			"prompt(",
		])("no-dialogs flags %s", (call) => {
			const check = checkFor(
				auditAppHtml(`<script>${call}'x');</script>`),
				"no-dialogs",
			);
			expect(check.passed).toBe(false);
			expect(check.severity).toBe("glitch");
		});

		it("no-dialogs does not flag an unrelated identifier containing the word", () => {
			expect(
				checkFor(
					auditAppHtml("<script>promptText('x');</script>"),
					"no-dialogs",
				).passed,
			).toBe(true);
		});

		it.each(["eval(", "eval ("])("no-eval flags %s", (call) => {
			const check = checkFor(
				auditAppHtml(`<script>${call}'1+1');</script>`),
				"no-eval",
			);
			expect(check.passed).toBe(false);
			expect(check.severity).toBe("glitch");
		});

		it("no-eval flags new Function(...) and does not flag a plain function call", () => {
			expect(
				checkFor(
					auditAppHtml("<script>new Function('return 1')();</script>"),
					"no-eval",
				).passed,
			).toBe(false);
			expect(
				checkFor(
					auditAppHtml("<script>evaluate(x); myEval(x);</script>"),
					"no-eval",
				).passed,
			).toBe(true);
		});

		it.each([
			["location = 'https://x.example'", "location assignment"],
			["window.location = 'https://x.example'", "location assignment"],
			["location.href = 'https://x.example'", "location assignment"],
			["location.assign('https://x.example')", "location.assign/replace("],
			["location.replace('https://x.example')", "location.assign/replace("],
			["window.open('https://x.example')", "window.open("],
		])("no-navigate flags %s", (script) => {
			const check = checkFor(
				auditAppHtml(`<script>${script};</script>`),
				"no-navigate",
			);
			expect(check.passed).toBe(false);
			expect(check.severity).toBe("violation");
		});

		it("no-navigate flags an external <a href> but not an in-page anchor", () => {
			expect(
				checkFor(
					auditAppHtml('<a href="https://example.com">go</a>'),
					"no-navigate",
				).passed,
			).toBe(false);
			expect(
				checkFor(auditAppHtml('<a href="//example.com">go</a>'), "no-navigate")
					.passed,
			).toBe(false);
			expect(
				checkFor(auditAppHtml('<a href="#section">go</a>'), "no-navigate")
					.passed,
			).toBe(true);
		});

		it('no-navigate flags <meta http-equiv="refresh">', () => {
			expect(
				checkFor(
					auditAppHtml('<meta http-equiv="refresh" content="0;url=x">'),
					"no-navigate",
				).passed,
			).toBe(false);
		});

		it("no-navigate does not flag a comparison (location === x) or an unrelated variable", () => {
			expect(
				checkFor(
					auditAppHtml("<script>if (location === x) {}</script>"),
					"no-navigate",
				).passed,
			).toBe(true);
		});

		it("no-navigate does not flag an app's OWN 'location' field (an address, a city) on an unrelated object", () => {
			// A trip-cost app, an expense tracker, a contact form: "location" is a
			// completely ordinary field name that has nothing to do with
			// window.location. Flagging it makes generation retry-then-refuse an
			// app that never tried to navigate anywhere.
			expect(
				checkFor(
					auditAppHtml(
						"<script>expense.location = input.value; state.location = 'Budapest';</script>",
					),
					"no-navigate",
				).passed,
			).toBe(true);
		});

		it("no-navigate flags bracket-notation self-navigation, not just dot notation", () => {
			// window['location'] = ... is the same self-navigation attempt as
			// window.location = ..., just spelled with a computed member access.
			// A rule the model (or an obfuscated payload) can bypass by rewriting
			// `.location` as `['location']` is not the rule the spec asks for.
			expect(
				checkFor(
					auditAppHtml(
						"<script>window['location'] = 'https://evil.example/steal';</script>",
					),
					"no-navigate",
				).passed,
			).toBe(false);
			expect(
				checkFor(
					auditAppHtml(
						`<script>self["location"] = 'https://evil.example/steal';</script>`,
					),
					"no-navigate",
				).passed,
			).toBe(false);
		});

		it("no-webrtc flags RTCPeerConnection", () => {
			const check = checkFor(
				auditAppHtml("<script>new RTCPeerConnection();</script>"),
				"no-webrtc",
			);
			expect(check.passed).toBe(false);
			expect(check.severity).toBe("violation");
		});

		it("a clean document passes all four new rules", () => {
			const checks = auditAppHtml(PASSING_FIXTURE);
			for (const rule of [
				"no-dialogs",
				"no-eval",
				"no-navigate",
				"no-webrtc",
			]) {
				expect(checkFor(checks, rule).passed).toBe(true);
			}
		});

		// Ruling 58: the tag regexes are bounded to 4096 chars so a pathological
		// answer with no closing `>` cannot cost catastrophic backtracking time
		// (measured ~0.65s unbounded). A generous 200ms ceiling proves the
		// bound is in effect without making the test flaky on a loaded CI box.
		it("audits a pathological 96 KB tag-like document well under the old unbounded cost", () => {
			const pathological = `<script src="${"a".repeat(96_000)}`; // no closing '>' at all
			const startedAt = performance.now();
			expect(() => auditAppHtml(pathological)).not.toThrow();
			const elapsedMs = performance.now() - startedAt;
			expect(elapsedMs).toBeLessThan(200);
		});
	});

	it("APP_GLITCH_RULE_IDS names exactly the rules whose severity is glitch", () => {
		const glitchRules = APP_CONTRACT_RULES.filter(
			(rule) => rule.severity === "glitch",
		).map((rule) => rule.id);
		expect([...APP_GLITCH_RULE_IDS].sort()).toEqual([...glitchRules].sort());
	});

	it("never returns a rejection: every result is passed true/false, nothing else", () => {
		const checks = auditAppHtml("<script>fetch('x')</script>");
		for (const check of checks) {
			expect(typeof check.passed).toBe("boolean");
		}
	});
});
