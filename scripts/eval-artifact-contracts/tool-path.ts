// The live path THROUGH THE REAL TOOL (decisions.md ruling 62): "every eval
// suite's live run goes through the real tool description and schema, never a
// hand-written prompt". `client.ts` sends one bare user message and reads the
// reply's text, which cannot carry a tool, and ruling 44 keeps `run.ts`,
// `config.ts` and `client.ts` closed to type slices — so a suite whose contract
// IS a tool call ships this module beside them and a runner that hands the
// harness's own `runSuite` a client built on it (`run-tool-suite.ts`).
//
// What a case sends is what a chat turn sends: the tool catalogue, read from
// the frozen snapshot the app's own tests keep byte-identical to the request's
// `tools` array (`normal-chat-tools/tool-catalogue.<lang>.snapshot.txt`, written
// by `index.test.ts`, which fails when a description or schema changes without
// the snapshot moving). Nothing here re-types a tool description, so this run
// cannot drift from the app's, and a change to the catalogue reaches the eval
// the moment its snapshot is regenerated.
//
// The recorded response is an envelope — `{ toolCalls, content, finishReason }`
// — because the answer to score is the tool call, not the text around it.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EVAL_ARTIFACTS_SAMPLING,
	type EvalArtifactsThinkingMode,
} from "./config";
import type { EvalCase, EvalUsage } from "./types";

export type ToolPathLanguage = "en" | "hu";

/** What one case sends. */
export interface ToolPathRequestSpec {
	system: string;
	user: string;
	/** Picks the catalogue's locale, exactly as the turn's language does in the app. */
	language: ToolPathLanguage;
	/** `auto` is production's; naming a tool isolates writing from routing. */
	toolChoice: "auto" | { name: string };
	/**
	 * Tools this conversation would not have. A real turn sends fewer tools than
	 * the snapshot's fully connected catalogue (the snapshot's own header says
	 * which are withheld per conversation), and a case that names them is
	 * measuring a turn that never happens.
	 */
	withoutTools?: readonly string[];
	/**
	 * A real turn is a conversation: a lookup (a search, an image search) is
	 * answered and the model goes on to make the thing. A single request cannot
	 * follow that, so a suite may give a bounded follow-up: `answer` returns the
	 * neutral result for a tool it answers, or `null` for one it does not (the
	 * call that makes the deck, or one that has no business in the case), which
	 * ends the conversation and is the step that is scored.
	 */
	followUp?: ToolPathFollowUp;
	thinking: EvalArtifactsThinkingMode;
}

export interface ToolPathFollowUp {
	maxSteps: number;
	answer(name: string, args: unknown): string | null;
}

/**
 * A suite whose live run goes through the tools (`run-tool-suite.ts`): how it
 * asks the model for one of its cases. Known-bad cases are never asked.
 */
export interface ToolSuite {
	requestFor(evalCase: EvalCase): ToolPathRequestSpec;
}

export interface ToolPathToolCall {
	/** The provider's id for the call, kept so an answered lookup can be sent back against it. */
	id?: string;
	name: string;
	/** The parsed arguments; the raw text when they were not JSON. */
	arguments: unknown;
}

/** A step the model took before the one that is scored: lookups the suite answered. */
export interface ToolPathStep {
	toolCalls: ToolPathToolCall[];
	content: string;
	/** What each call was answered with, in order. */
	results: string[];
}

export interface ToolPathEnvelope {
	/** The final step's calls: the ones that are scored. */
	toolCalls: ToolPathToolCall[];
	/** The assistant's text beside (or instead of) a tool call; empty when there is none. */
	content: string;
	finishReason: string | null;
	/** The lookups the model made first and the suite answered; absent when the first step was the last. */
	priorSteps?: ToolPathStep[];
}

// dirname(fileURLToPath(import.meta.url)), NOT new URL(".", import.meta.url):
// see run.ts's own note on why Vite-loaded (vitest) code needs the former.
const CATALOGUE_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../src/lib/server/services/normal-chat-tools",
);

const catalogueCache = new Map<ToolPathLanguage, unknown[]>();

/**
 * The tools array of a chat request, as the app's frozen snapshot holds it:
 * the file's prose header, a `----` line, then the pretty-printed JSON.
 */
export function loadToolCatalogue(language: ToolPathLanguage): unknown[] {
	const cached = catalogueCache.get(language);
	if (cached) return cached;
	const text = readFileSync(
		join(CATALOGUE_DIR, `tool-catalogue.${language}.snapshot.txt`),
		"utf8",
	);
	const marker = "\n----\n";
	const at = text.indexOf(marker);
	if (at < 0) {
		throw new Error(
			`tool-catalogue.${language}.snapshot.txt has no "----" line; its format changed`,
		);
	}
	const tools: unknown = JSON.parse(text.slice(at + marker.length));
	if (!Array.isArray(tools)) {
		throw new Error(
			`tool-catalogue.${language}.snapshot.txt is not a tools array`,
		);
	}
	catalogueCache.set(language, tools);
	return tools;
}

export function buildToolPathRequestBody(
	model: string,
	spec: ToolPathRequestSpec,
	history: readonly unknown[] = [],
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model,
		messages: [
			{ role: "system", content: spec.system },
			{ role: "user", content: spec.user },
			...history,
		],
		tools: loadToolCatalogue(spec.language).filter(
			(tool) =>
				!spec.withoutTools?.includes(
					(tool as { function: { name: string } }).function.name,
				),
		),
		tool_choice:
			spec.toolChoice === "auto"
				? "auto"
				: { type: "function", function: { name: spec.toolChoice.name } },
		temperature: EVAL_ARTIFACTS_SAMPLING.temperature,
		top_p: EVAL_ARTIFACTS_SAMPLING.topP,
		top_k: EVAL_ARTIFACTS_SAMPLING.topK,
		max_tokens: EVAL_ARTIFACTS_SAMPLING.maxTokens,
	};
	// Qwen defaults to thinking ON; "off" is sent the way the app sends it
	// (normal-chat-model/provider-compatibility.ts, the "qwen" case).
	if (spec.thinking === "off") {
		body.chat_template_kwargs = { enable_thinking: false };
	}
	return body;
}

export function encodeToolPathResponse(envelope: ToolPathEnvelope): string {
	return JSON.stringify(envelope, null, 2);
}

function decodeToolCalls(value: unknown): ToolPathToolCall[] | null {
	if (!Array.isArray(value)) return null;
	const calls: ToolPathToolCall[] = [];
	for (const call of value) {
		if (typeof call !== "object" || call === null) return null;
		const record = call as {
			id?: unknown;
			name?: unknown;
			arguments?: unknown;
		};
		if (typeof record.name !== "string") return null;
		calls.push({
			...(typeof record.id === "string" ? { id: record.id } : {}),
			name: record.name,
			arguments: record.arguments,
		});
	}
	return calls;
}

/** The envelope a recorded response holds, or `null` for anything else. Never throws. */
export function decodeToolPathResponse(text: string): ToolPathEnvelope | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const toolCalls = decodeToolCalls(record.toolCalls);
	if (!toolCalls) return null;
	const envelope: ToolPathEnvelope = {
		toolCalls,
		content: typeof record.content === "string" ? record.content : "",
		finishReason:
			typeof record.finishReason === "string" ? record.finishReason : null,
	};
	if (Array.isArray(record.priorSteps)) {
		const steps: ToolPathStep[] = [];
		for (const step of record.priorSteps) {
			const item = step as Record<string, unknown> | null;
			const calls = item ? decodeToolCalls(item.toolCalls) : null;
			if (!item || !calls) return null;
			steps.push({
				toolCalls: calls,
				content: typeof item.content === "string" ? item.content : "",
				results: Array.isArray(item.results) ? item.results.map(String) : [],
			});
		}
		if (steps.length > 0) envelope.priorSteps = steps;
	}
	return envelope;
}

export interface ToolPathEndpoint {
	baseUrl: string;
	model: string;
	/** Optional: the local server needs none. Captured, never returned or logged. */
	apiKey?: string | null;
}

interface CompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | null;
			tool_calls?: Array<{
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

function parseArguments(raw: string | undefined): unknown {
	if (raw === undefined) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function addUsage(
	total: EvalUsage | undefined,
	step: EvalUsage | undefined,
): EvalUsage | undefined {
	if (!step) return total;
	if (!total) return step;
	const sum = (a?: number, b?: number) =>
		a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
	return {
		promptTokens: sum(total.promptTokens, step.promptTokens),
		completionTokens: sum(total.completionTokens, step.completionTokens),
		totalTokens: sum(total.totalTokens, step.totalTokens),
	};
}

/** One request, read back as an envelope. A non-ok status throws an error carrying `.status`. */
async function requestOnce(
	endpoint: ToolPathEndpoint,
	spec: ToolPathRequestSpec,
	history: readonly unknown[],
	deps: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ envelope: ToolPathEnvelope; usage?: EvalUsage }> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
	const response = await fetchImpl(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(endpoint.apiKey
				? { Authorization: `Bearer ${endpoint.apiKey}` }
				: {}),
		},
		body: JSON.stringify(
			buildToolPathRequestBody(endpoint.model, spec, history),
		),
		signal: deps.signal,
	});
	if (!response.ok) {
		const error = new Error(
			`Model endpoint returned ${response.status}`,
		) as Error & {
			status?: number;
		};
		error.status = response.status;
		throw error;
	}
	const json = (await response.json()) as CompletionResponse;
	const choice = json.choices?.[0];
	const toolCalls: ToolPathToolCall[] = (choice?.message?.tool_calls ?? []).map(
		(call) => ({
			...(call.id ? { id: call.id } : {}),
			name: call.function?.name ?? "",
			arguments: parseArguments(call.function?.arguments),
		}),
	);
	return {
		envelope: {
			toolCalls,
			content: choice?.message?.content ?? "",
			finishReason: choice?.finish_reason ?? null,
		},
		usage: json.usage
			? {
					promptTokens: json.usage.prompt_tokens,
					completionTokens: json.usage.completion_tokens,
					totalTokens: json.usage.total_tokens,
				}
			: undefined,
	};
}

function assistantMessage(envelope: ToolPathEnvelope): unknown {
	return {
		role: "assistant",
		content: envelope.content,
		tool_calls: envelope.toolCalls.map((call, index) => ({
			id: call.id ?? `call_${index}`,
			type: "function",
			function: {
				name: call.name,
				arguments:
					typeof call.arguments === "string"
						? call.arguments
						: JSON.stringify(call.arguments),
			},
		})),
	};
}

/**
 * The model's answer to a case, through the tools, as an envelope. With a
 * follow-up it is a short bounded conversation: a step whose every call the
 * suite can answer is answered and the model asked again; the first step that
 * calls anything else (the call that makes the deck), calls nothing, or is the
 * last one allowed, is the one returned — with the lookups before it in
 * `priorSteps`. A non-ok status throws an error with `.status`, which is what
 * `run.ts`'s one-retry and two-consecutive-429/5xx policy reads.
 */
export async function sendThroughTools(
	endpoint: ToolPathEndpoint,
	spec: ToolPathRequestSpec,
	deps: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ text: string; usage?: EvalUsage }> {
	const history: unknown[] = [];
	const prior: ToolPathStep[] = [];
	let usage: EvalUsage | undefined;
	const maxSteps = spec.followUp?.maxSteps ?? 1;

	for (let step = 1; ; step += 1) {
		const result = await requestOnce(endpoint, spec, history, deps);
		usage = addUsage(usage, result.usage);
		const { envelope } = result;
		const answers =
			spec.followUp && step < maxSteps && envelope.toolCalls.length > 0
				? envelope.toolCalls.map((call) =>
						spec.followUp?.answer(call.name, call.arguments),
					)
				: null;
		const answerable = answers?.every(
			(answer): answer is string => typeof answer === "string",
		);
		if (!answers || !answerable) {
			return {
				text: encodeToolPathResponse({
					...envelope,
					...(prior.length > 0 ? { priorSteps: prior } : {}),
				}),
				usage,
			};
		}
		prior.push({
			toolCalls: envelope.toolCalls,
			content: envelope.content,
			results: answers as string[],
		});
		history.push(assistantMessage(envelope));
		envelope.toolCalls.forEach((call, index) => {
			history.push({
				role: "tool",
				tool_call_id: call.id ?? `call_${index}`,
				content: answers[index],
			});
		});
	}
}
