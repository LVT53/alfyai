import { describe, expect, it } from "vitest";
import { APP_CONTRACT_PROMPT } from "$lib/server/services/artifacts/app/contract";
import { APP_EVAL_CASES, evaluateAppEval, scoreAppEval } from "./apps";

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

	// Ruling 55: each fixture declares its language, and generation is asked
	// for it exactly the way production asks the turn's own resolved
	// language — the same buildAppRequestMessage sentence, not a re-typed one
	// that could drift from it.
	it("declares each prompt's language and asks for it with production's own instruction sentence", () => {
		const english = APP_EVAL_CASES.find((c) => c.id === "app-01");
		const hungarian = APP_EVAL_CASES.find((c) => c.id === "app-02");
		expect(english?.language).toBe("en");
		expect(hungarian?.language).toBe("hu");
		expect(english?.prompt).toContain(
			"Write the whole app in English: every label, button, empty state and error message.",
		);
		expect(hungarian?.prompt).toContain(
			"Write the whole app in Hungarian: every label, button, empty state and error message.",
		);
	});

	it("the known-bad case still declares a language (English)", () => {
		const knownBad = APP_EVAL_CASES.find((evalCase) => evalCase.knownBad);
		expect(knownBad?.language).toBe("en");
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

	// Ruling 55: a UI in the wrong language is broken — the specific failure
	// mode a live run found (3 of 10 English prompts came back Hungarian).
	describe("language mismatch (ruling 55)", () => {
		const HUNGARIAN_UI_HTML = CLEAN_APP_HTML.replace(
			"<html>",
			'<html lang="hu">',
		).replace(
			'<button id="go">Go</button>',
			'<button id="go">Indítás</button><p>Add meg az adatokat és nyomd meg a gombot a folytatáshoz.</p>',
		);

		it("scores bad for a recorded Hungarian UI answering an English-declared case", () => {
			const englishCase = APP_EVAL_CASES.find((c) => c.id === "app-01");
			if (!englishCase) throw new Error("app-01 not found");
			const result = scoreAppEval(englishCase, {
				caseId: englishCase.id,
				suite: "app",
				response: fence(HUNGARIAN_UI_HTML),
			});
			expect(result.verdict).toBe("bad");
			expect(result.reasons.some((r) => /language/i.test(r))).toBe(true);
		});

		it("does not flag a matching language", () => {
			const hungarianCase = APP_EVAL_CASES.find((c) => c.id === "app-02");
			if (!hungarianCase) throw new Error("app-02 not found");
			const result = scoreAppEval(hungarianCase, {
				caseId: hungarianCase.id,
				suite: "app",
				response: fence(HUNGARIAN_UI_HTML),
			});
			expect(result.verdict).not.toBe("bad");
		});

		it("does not flag a case with no declared language (defensive default)", () => {
			const result = scoreAppEval(
				{ ...baseCase, language: undefined },
				{
					caseId: baseCase.id,
					suite: "app",
					response: fence(HUNGARIAN_UI_HTML),
				},
			);
			expect(result.verdict).not.toBe("bad");
		});
	});

	// Ruling 56: the browser pass's own fatal/glitch signals fold into the
	// same good/acceptable/bad verdict the static audit already produces,
	// ported from the P1 prototype's score.ts rules.
	describe("folding the browser pass's evaluation into the verdict (ruling 56)", () => {
		function evaluation(overrides: Record<string, unknown> = {}) {
			return {
				pages: [
					{
						label: "light-1280",
						textLength: 200,
						controlCount: 2,
						consoleErrors: [],
						pageErrors: [],
						blockedRequests: [],
					},
				],
				interaction: {
					clicked: true,
					domChanged: true,
					clickedButtons: ["Go"],
					domChangedAfter: "Go",
					dialogs: [],
					note: null,
					storageSetsBefore: 0,
					storageSetsAfter: 1,
				},
				consoleErrors: [],
				pageErrors: [],
				blockedRequests: [],
				storageGets: 0,
				storageSets: 1,
				storageKeys: ["x"],
				...overrides,
			};
		}

		it("stays good when the browser pass reports nothing wrong", () => {
			const result = scoreAppEval(
				baseCase,
				{ caseId: baseCase.id, suite: "app", response: fence(CLEAN_APP_HTML) },
				evaluation(),
			);
			expect(result.verdict).toBe("good");
		});

		it("downgrades to acceptable on a console error", () => {
			const result = scoreAppEval(
				baseCase,
				{ caseId: baseCase.id, suite: "app", response: fence(CLEAN_APP_HTML) },
				evaluation({ consoleErrors: ["ReferenceError: x is not defined"] }),
			);
			expect(result.verdict).toBe("acceptable");
			expect(result.reasons.some((r) => r.includes("ReferenceError"))).toBe(
				true,
			);
		});

		it("downgrades to acceptable when a network request was blocked", () => {
			const result = scoreAppEval(
				baseCase,
				{ caseId: baseCase.id, suite: "app", response: fence(CLEAN_APP_HTML) },
				evaluation({ blockedRequests: ["https://cdn.example.com/x.js"] }),
			);
			expect(result.verdict).toBe("acceptable");
		});

		it("fails outright when nothing rendered", () => {
			const result = scoreAppEval(
				baseCase,
				{ caseId: baseCase.id, suite: "app", response: fence(CLEAN_APP_HTML) },
				evaluation({
					pages: [
						{
							label: "light-1280",
							textLength: 0,
							controlCount: 0,
							consoleErrors: [],
							pageErrors: [],
							blockedRequests: [],
						},
					],
				}),
			);
			expect(result.verdict).toBe("bad");
		});

		it("fails outright on an uncaught exception that left the page nearly empty", () => {
			const result = scoreAppEval(
				baseCase,
				{ caseId: baseCase.id, suite: "app", response: fence(CLEAN_APP_HTML) },
				evaluation({
					pageErrors: ["TypeError: cannot read properties of undefined"],
					pages: [
						{
							label: "light-1280",
							textLength: 10,
							controlCount: 1,
							consoleErrors: [],
							pageErrors: ["TypeError: cannot read properties of undefined"],
							blockedRequests: [],
						},
					],
				}),
			);
			expect(result.verdict).toBe("bad");
		});

		it("is not folded in at all when there is no evaluation (e.g. extraction-only)", () => {
			const result = scoreAppEval(baseCase, {
				caseId: baseCase.id,
				suite: "app",
				response: fence(CLEAN_APP_HTML),
			});
			expect(result.verdict).toBe("good");
		});
	});
});

describe("evaluateAppEval (ruling 56)", () => {
	const baseCase = APP_EVAL_CASES[0];

	it("returns null without touching a browser when extraction failed", async () => {
		const result = await evaluateAppEval(baseCase, {
			caseId: baseCase.id,
			suite: "app",
			response: "OK, no fence here",
		});
		expect(result).toBeNull();
	});
});
