import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveOpenAICompatibleProviderAdapterProfile } from "./provider-compatibility";
import { resolveModelCallSampling } from "./sampling";

const QWEN = {
	name: "model1",
	displayName: "Local",
	baseUrl: "http://192.168.1.96:30000/v1",
	modelName: "qwen3-6-27b",
};
const GPT = {
	name: "cloud",
	displayName: "Cloud",
	baseUrl: "https://openai-compatible.example/v1",
	modelName: "gpt-4.1",
};

describe("resolveModelCallSampling", () => {
	it("is the qwen family's declared profile, read from the adapter and never copied", () => {
		const declared =
			resolveOpenAICompatibleProviderAdapterProfile(QWEN).defaultSampling;
		expect(declared).toEqual({ temperature: 0.6, topP: 0.95, topK: 20 });
		expect(resolveModelCallSampling(QWEN)).toEqual({
			temperature: declared?.temperature,
			topP: declared?.topP,
		});
	});

	it("lets a machine-read answer keep its own temperature while top_p stays the family's", () => {
		expect(
			resolveModelCallSampling(QWEN, { machineReadTemperature: 0 }),
		).toEqual({ temperature: 0, topP: 0.95 });
	});

	it("prefers the family profile over a profileless fallback", () => {
		expect(
			resolveModelCallSampling(QWEN, { profilelessTemperature: 0.4 }),
		).toEqual({ temperature: 0.6, topP: 0.95 });
	});

	it("sends a family with no profile exactly its fallback, and no top_p", () => {
		expect(
			resolveModelCallSampling(GPT, { profilelessTemperature: 0.4 }),
		).toEqual({ temperature: 0.4, topP: undefined });
		expect(
			resolveModelCallSampling(GPT, {
				machineReadTemperature: 0,
				profilelessTemperature: 0.4,
			}),
		).toEqual({ temperature: 0, topP: undefined });
	});

	it("sends nothing at all for a profileless family with no fallback (the chat turn's own case)", () => {
		expect(resolveModelCallSampling(GPT)).toEqual({
			temperature: undefined,
			topP: undefined,
		});
	});
});

// The structural half of the rule: a model call cannot go round the one sampling
// route without this file failing. Everything below reads source text.
const SRC_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);

/** Every non-test source under src/: the services, the routes, the client. */
function serverSources(): Array<{ file: string; code: string }> {
	return readdirSync(SRC_ROOT, { recursive: true })
		.map(String)
		.filter(
			(file) =>
				file.endsWith(".ts") &&
				!/\.test[.-]/.test(file) &&
				!file.endsWith(".d.ts"),
		)
		.map((file) => ({
			file: relative(SRC_ROOT, join(SRC_ROOT, file)),
			code: stripComments(readFileSync(join(SRC_ROOT, file), "utf8")),
		}));
}

function stripComments(code: string): string {
	return code
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ADAPTER =
	"lib/server/services/normal-chat-model/provider-compatibility.ts";

describe("every model call takes its sampling from the one route", () => {
	it("holds no sampling number outside the family adapter", () => {
		const offenders = serverSources()
			.filter(({ file }) => file !== ADAPTER)
			.filter(({ code }) => /\b(?:top_?[kp])\b\s*[:=]\s*[0-9.]/i.test(code))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	it("builds no chat-completions request body by hand", () => {
		const handBuilt = serverSources()
			.filter(({ code }) => /chat\/completions/.test(code))
			.map(({ file }) => file)
			.sort();
		expect(handBuilt).toEqual([
			// The provider key check: a one-token liveness ping nobody reads.
			"lib/server/services/providers.ts",
		]);
	});

	it("gives every AI SDK call site the shared helper", () => {
		const callSites = serverSources().filter(({ code }) =>
			/\b(?:generateText|streamText|generateObject|streamObject)\s*\(/.test(
				code,
			),
		);
		expect(callSites.length).toBeGreaterThan(0);
		const withoutHelper = callSites
			.filter(({ code }) => !/\bresolveModelCallSampling\s*\(/.test(code))
			.map(({ file }) => file);
		expect(withoutHelper).toEqual([]);
	});

	// A temperature written as a number at a call site is how a path escapes the
	// profile. Each one left is an answer only a machine reads, or what a family
	// with no profile has always sent; a new one is a decision to write down here.
	const EXPLICIT_TEMPERATURES: Record<
		string,
		{ count: number; reason: string }
	> = {
		"lib/server/services/artifacts/app/verify.ts": {
			count: 1,
			reason: "the App classifier: a JSON checkable/not verdict, deterministic",
		},
		"lib/server/services/chat-turn/follow-up-suggestions.ts": {
			count: 1,
			reason:
				"profileless fallback only: a family with no profile keeps the 0.4 it always sent",
		},
		"lib/server/services/chat-turn/thought-step-classifier.ts": {
			count: 1,
			reason:
				"profileless fallback only: a family with no profile keeps the 0 it always sent",
		},
		"lib/server/services/chat-turn/turn-acknowledgment.ts": {
			count: 1,
			reason:
				"a JSON intent classification: the person only ever sees a template and a verbatim slice of their own message",
		},
		"lib/server/services/conversation-summaries.ts": {
			count: 1,
			reason:
				"a 50-100 word durable digest the model itself re-reads, never shown; low and stable keeps the injected prompt text steady",
		},
		"lib/server/services/memory-control-model.ts": {
			count: 1,
			reason:
				"the judge, reconcile/merge and re-curation: deterministic JSON decisions (ADR-0045); the persona summary is readBy: person",
		},
		"lib/server/services/task-state.ts": {
			count: 1,
			reason: "strict-JSON task state update, machine-read",
		},
		"lib/server/services/task-state/artifacts.ts": {
			count: 1,
			reason:
				"a working checkpoint of historical context the model re-reads, never shown",
		},
		"lib/server/services/task-state/control-model.ts": {
			count: 1,
			reason: "the persona-fact JSON classifier",
		},
	};

	it("lists every explicit temperature with the reason it may stay", () => {
		const found: Record<string, number> = {};
		for (const { file, code } of serverSources()) {
			if (file === ADAPTER) continue; // where the profile itself is declared
			const matches = code.match(/[Tt]emperature\s*(?::\s*-?\d|\?\?\s*-?\d)/g);
			if (matches) found[file] = matches.length;
		}
		const expected = Object.fromEntries(
			Object.entries(EXPLICIT_TEMPERATURES).map(([file, { count }]) => [
				file,
				count,
			]),
		);
		expect(found).toEqual(expected);
		for (const { reason } of Object.values(EXPLICIT_TEMPERATURES)) {
			expect(reason.length).toBeGreaterThan(20);
		}
	});
});
