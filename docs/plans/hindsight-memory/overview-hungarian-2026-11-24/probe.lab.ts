// The Overview probe: the app's own `composeMemoryOverview` over the two synthetic scopes beside this file
// (`personal.json`, `project.json`), in both UI languages, several runs each, one call in flight at a time.
//
// The model is a `CurationModel` that sends what `createCurationModel` sends for a call a person reads
// (memory-profile/curation.ts): `sendJsonControlMessageViaProvider`, thinking off, no temperature of its own
// (so the qwen family's profile applies: temperature 0.6, top_p 0.95, top_k 20), the strict `memory_edit`
// JSON schema, 8,192 output tokens. The only differences are the endpoint, which is the shared model bridge
// that holds the key (`OVERVIEW_PROBE_BRIDGE`, default http://127.0.0.1:18891/v1), and that no admission
// headers are sent. No key is read, printed or stored. Synthetic data only.
//
//   OVERVIEW_PROBE_LABEL=<name> [OVERVIEW_PROBE_RUNS=5] [OVERVIEW_PROBE_OUT=<dir>] [OVERVIEW_PROBE_BRIDGE=<url>] \
//     [OVERVIEW_PROBE_ENTRIES=en|large] \
//     npx vitest run -c docs/plans/hindsight-memory/overview-hungarian-2026-11-24/vitest.config.ts
//
// `OVERVIEW_PROBE_ENTRIES=en` reads `personal.en.json` and `project.en.json` (the same facts worded as an
// English account's entries) and writes only the `en` paragraphs: an English account over English entries.
// `OVERVIEW_PROBE_ENTRIES=large` reads `personal.large.json` (about a hundred entries, English) and writes
// only its personal `en` paragraphs: how long the paragraph gets when there are many entries.
//
// It writes `<out>/<label>.json` (default out: `outputs/` beside this file), after every call: the prompts the
// model received, one sample request body (so the sampling and the schema can be read off it), and a result
// per call: scope, language, run, milliseconds, the paragraph (or the error) and whatever else the model
// answered besides the paragraph (`extras`: the borrowed-words list, from Config 3 round 2 on).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { CurationModel } from "$lib/server/services/memory-profile/curation";
import {
	composeMemoryOverview,
	type OverviewEntry,
} from "$lib/server/services/memory-profile/overview";
import {
	type JsonControlMessageOptions,
	sendJsonControlMessageViaProvider,
} from "$lib/server/services/normal-chat-control-model";

// Vitest runs from the repository root (the config's `root`), and a module's `import.meta.url` there is
// root-relative, so the folder is named from the working directory.
const HERE = join(
	process.cwd(),
	"docs/plans/hindsight-memory/overview-hungarian-2026-11-24",
);
const LABEL = process.env.OVERVIEW_PROBE_LABEL ?? "";
const RUNS = Number(process.env.OVERVIEW_PROBE_RUNS ?? "5");
const OUT = process.env.OVERVIEW_PROBE_OUT ?? join(HERE, "outputs");
const BRIDGE = process.env.OVERVIEW_PROBE_BRIDGE ?? "http://127.0.0.1:18891/v1";
const MODEL_NAME = "qwen3-6-27b";
const ENTRIES = process.env.OVERVIEW_PROBE_ENTRIES ?? "";
const LANGUAGES = ENTRIES ? (["en"] as const) : (["hu", "en"] as const);
const SCOPES =
	ENTRIES === "large"
		? (["personal"] as const)
		: (["personal", "project"] as const);
const CALL_TIMEOUT_MS = 600_000;

interface Scope {
	scopeKind: "personal" | "project";
	name: string | null;
	entries: OverviewEntry[];
}

function loadScope(file: string): Scope {
	return JSON.parse(readFileSync(join(HERE, file), "utf8")) as Scope;
}

describe("the Overview probe (calls a model; not part of npm test)", () => {
	it(
		"writes the scopes' paragraphs with the app's own prompt",
		async () => {
			if (!LABEL) throw new Error("set OVERVIEW_PROBE_LABEL");
			const suffix = ENTRIES ? `.${ENTRIES}` : "";
			const scopes = Object.fromEntries(
				SCOPES.map((name) => [name, loadScope(`${name}${suffix}.json`)]),
			) as Record<(typeof SCOPES)[number], Scope>;
			const prompts = new Set<string>();
			let sampleRequest: unknown = null;
			let lastExtras: unknown = null;
			const model: CurationModel = async (
				prompt,
				input,
				schema,
				thinkingMode = "off",
				_assertCurrent,
				call = {},
			) => {
				prompts.add(prompt);
				const options: JsonControlMessageOptions = {
					systemPrompt: prompt,
					fetch: async (url, init) => {
						if (!sampleRequest && typeof init?.body === "string")
							sampleRequest = JSON.parse(init.body);
						return fetch(url, init);
					},
					thinkingMode,
					maxTokens: 8192,
					...(call.readBy === "person" ? {} : { temperature: 0 }),
					jsonSchema: { name: "memory_edit", schema, strict: true },
					signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
					allowReasoningFallback: false,
					allowStructuredOutputFallback: thinkingMode !== "on",
					requestTimeoutMs: CALL_TIMEOUT_MS,
				};
				const result = await sendJsonControlMessageViaProvider(
					JSON.stringify(input),
					{
						id: "memory-curation",
						name: "memory-curation",
						displayName: "Memory curation",
						baseUrl: BRIDGE,
						modelName: MODEL_NAME,
						apiKey: "held-by-the-bridge",
					},
					options,
					CALL_TIMEOUT_MS,
				);
				const answer = JSON.parse(result.text) as Record<string, unknown>;
				const { overview: _paragraph, ...extras } = answer;
				lastExtras = extras;
				return answer;
			};

			const results: Array<Record<string, unknown>> = [];
			mkdirSync(OUT, { recursive: true });
			const save = () =>
				writeFileSync(
					join(OUT, `${LABEL}.json`),
					`${JSON.stringify({ label: LABEL, bridgeModel: MODEL_NAME, prompts: [...prompts], sampleRequest, results }, null, "\t")}\n`,
				);
			// One call at a time, interleaved by run, so a slow stretch of the shared model touches
			// every cell alike.
			for (let run = 1; run <= RUNS; run++)
				for (const scopeName of SCOPES)
					for (const language of LANGUAGES) {
						const scope = scopes[scopeName];
						const started = Date.now();
						try {
							const text = await composeMemoryOverview(
								{
									scopeKind: scope.scopeKind,
									name: scope.name,
									language,
									entries: scope.entries,
								},
								model,
							);
							results.push({
								scope: scopeName,
								language,
								run,
								ms: Date.now() - started,
								text,
								extras: lastExtras,
							});
						} catch (error) {
							results.push({
								scope: scopeName,
								language,
								run,
								ms: Date.now() - started,
								error: String(error),
							});
						}
						save();
					}
		},
		RUNS * SCOPES.length * LANGUAGES.length * CALL_TIMEOUT_MS,
	);
});
