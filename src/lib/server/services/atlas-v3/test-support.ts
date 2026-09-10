// Fakes shared by the Atlas v3 unit tests (ADR 0063).
//
// Not a test file: it exports no `describe`, so vitest's `src/**/*.test.ts`
// include pattern never picks it up as a suite.

import type { AtlasV3ModelCall } from "./model-call";
import type {
	AtlasV3ReadResult,
	AtlasV3ResearchWeb,
	AtlasV3SearchHit,
	AtlasV3SearchResult,
} from "./research-web-adapter";
import type { AtlasV3Usage } from "./types";

export const ZERO_USAGE: AtlasV3Usage = {
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	costUsdMicros: 0,
};

export interface FakeModelCall {
	call: AtlasV3ModelCall;
	/** Every stage label the pipeline asked for, in order. */
	stages: string[];
	/** Every prompt sent, keyed by the stage label of that call. */
	prompts: Array<{ stage: string; system: string; prompt: string }>;
}

/**
 * A model whose answer is chosen by a prefix match on the stage label. An
 * unmatched stage answers `{}`, which every v3 parser treats as "unusable" and
 * falls back from — so a test only has to script the stages it cares about.
 */
export function fakeModel(
	responses: Record<string, string | string[] | ((prompt: string) => string)>,
	options?: { finishReason?: string },
): FakeModelCall {
	const stages: string[] = [];
	const prompts: FakeModelCall["prompts"] = [];
	const queues = new Map<string, string[]>();
	for (const [key, value] of Object.entries(responses)) {
		if (Array.isArray(value)) queues.set(key, [...value]);
	}
	const call: AtlasV3ModelCall = async ({ stage, system, prompt }) => {
		stages.push(stage);
		prompts.push({ stage, system, prompt });
		const key = Object.keys(responses)
			.filter((candidate) => stage.startsWith(candidate))
			.sort((left, right) => right.length - left.length)[0];
		const configured = key === undefined ? undefined : responses[key];
		let text = "{}";
		if (typeof configured === "function") {
			text = configured(prompt);
		} else if (Array.isArray(configured)) {
			const queue = queues.get(key ?? "") ?? [];
			text = queue.shift() ?? configured.at(-1) ?? "{}";
		} else if (typeof configured === "string") {
			text = configured;
		}
		return {
			text,
			finishReason: options?.finishReason ?? "stop",
			usage: { ...ZERO_USAGE },
		};
	};
	return { call, stages, prompts };
}

export interface FakeResearchWeb extends AtlasV3ResearchWeb {
	searchCalls: Array<{ question: string; queries: string[] }>;
	readCalls: string[];
}

/** A search index and a page store, addressed by URL. */
export function fakeResearchWeb(input: {
	hits: AtlasV3SearchHit[] | ((question: string) => AtlasV3SearchHit[]);
	pages?: Record<string, string>;
	failSearch?: boolean;
}): FakeResearchWeb {
	const searchCalls: FakeResearchWeb["searchCalls"] = [];
	const readCalls: string[] = [];
	return {
		searchCalls,
		readCalls,
		search: async (request): Promise<AtlasV3SearchResult> => {
			searchCalls.push({
				question: request.question,
				queries: request.searchQueries,
			});
			if (input.failSearch) throw new Error("parallel is down");
			return {
				hits:
					typeof input.hits === "function"
						? input.hits(request.question)
						: input.hits,
				cached: false,
			};
		},
		read: async (url): Promise<AtlasV3ReadResult> => {
			readCalls.push(url);
			return { url, text: input.pages?.[url] ?? null, cached: false };
		},
	};
}

/** A well-formed `read_for_goal` answer, as JSON. */
export function readAnswer(input: {
	quotes: string[];
	claims?: Array<{
		entity: string;
		metric: string;
		value: string;
		unit?: string | null;
		period?: string | null;
		asOf?: string | null;
		series?: string | null;
		quoteIndexes: number[];
	}>;
	useless?: boolean;
}): string {
	return JSON.stringify({
		quotes: input.quotes.map((text) => ({ text })),
		claims: input.claims ?? [],
		useless: input.useless ?? false,
	});
}
