import { describe, expect, it } from "vitest";
import { APP_CONTRACT_PROMPT } from "$lib/server/services/artifacts/app/contract";
import { APP_EVAL_CASES, scoreAppEval } from "./apps";

describe("APP_EVAL_CASES", () => {
	it("has the prototype's ten prompts plus one known-bad fixture, all with unique ids", () => {
		const ids = APP_EVAL_CASES.map((evalCase) => evalCase.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(APP_EVAL_CASES).toHaveLength(11);
		expect(APP_EVAL_CASES.filter((evalCase) => evalCase.knownBad)).toHaveLength(
			1,
		);
	});

	it("every case belongs to the app suite and carries the real App contract prompt", () => {
		for (const evalCase of APP_EVAL_CASES) {
			expect(evalCase.suite).toBe("app");
			expect(evalCase.prompt).toContain(APP_CONTRACT_PROMPT);
		}
	});

	it("requests thinking off for every case (spec §2.9), regardless of the harness default", () => {
		for (const evalCase of APP_EVAL_CASES) {
			expect(evalCase.thinking).toBe("off");
		}
	});
});

const CLEAN_APP_HTML = `<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --surface-page:#fafaf8; --surface-elevated:#f4f3ee; --text-primary:#1a1a1a; --text-muted:#6b6b6b; --border-default:rgba(0,0,0,.08); --accent:#c15f3c; font-family: Georgia, Helvetica, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --surface-page:#1a1a1a; --surface-elevated:#242424; --text-primary:#ececec; --text-muted:#a0a0a0; --border-default:rgba(255,255,255,.08); --accent:#d4836b; } }
body { background: var(--surface-page); color: var(--text-primary); border: 1px solid var(--border-default); }
button { background: var(--surface-elevated); color: var(--accent); }
</style></head>
<body>
<button id="go">Go</button>
<script>document.getElementById('go').onclick = () => alfy.storage.set('x', 1);</script>
</body>
</html>`;

function fence(html: string): string {
	return `\`\`\`html\n${html}\n\`\`\``;
}

describe("scoreAppEval", () => {
	const baseCase = APP_EVAL_CASES[0];

	it("scores good for a clean app that passes every one of the fifteen contract checks", () => {
		const result = scoreAppEval(baseCase, {
			caseId: baseCase.id,
			suite: "app",
			response: fence(CLEAN_APP_HTML),
		});
		expect(result.verdict).toBe("good");
	});

	it("scores acceptable when a glitch-severity rule fires (a remote script), never bad", () => {
		const withRemoteScript = CLEAN_APP_HTML.replace(
			"<body>",
			`<body><script src="https://cdn.example.com/x.js"></script>`,
		);
		const result = scoreAppEval(baseCase, {
			caseId: baseCase.id,
			suite: "app",
			response: fence(withRemoteScript),
		});
		expect(result.verdict).toBe("acceptable");
		expect(
			result.reasons.some((reason) => reason.includes("no-script-src")),
		).toBe(true);
	});

	it("scores bad when there is no usable html fence at all", () => {
		const result = scoreAppEval(baseCase, {
			caseId: baseCase.id,
			suite: "app",
			response: "OK",
		});
		expect(result.verdict).toBe("bad");
	});

	it("scores bad for an empty response, the one universal failure", () => {
		const result = scoreAppEval(baseCase, {
			caseId: baseCase.id,
			suite: "app",
			response: "",
		});
		expect(result.verdict).toBe("bad");
	});

	it("the suite's own known-bad fixture scores bad no matter what a compliant model answers to it", () => {
		const knownBad = APP_EVAL_CASES.find((evalCase) => evalCase.knownBad);
		if (!knownBad) throw new Error("no known-bad case declared");
		const result = scoreAppEval(knownBad, {
			caseId: knownBad.id,
			suite: "app",
			response: "OK",
		});
		expect(result.verdict).toBe("bad");
	});
});
