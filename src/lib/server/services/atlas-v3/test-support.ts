// Fakes shared by the Atlas v3 unit tests (ADR 0063).
//
// Not a test file: it exports no `describe`, so vitest's `src/**/*.test.ts`
// include pattern never picks it up as a suite.

import type {
	AtlasV3LocalDocument,
	AtlasV3LocalSources,
	AtlasV3LocalUnavailable,
} from "./local-sources";
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
	/** Every URL read, fresh or not, in order. */
	readCalls: string[];
	/** The URLs read with `{ fresh: true }` (a seed recheck), in order. */
	freshReadCalls: string[];
}

/**
 * A search index and a page store, addressed by URL. `freshPages` answers a
 * `{ fresh: true }` read — the page as it is NOW — and falls back to `pages`;
 * a `null` there is a page the live fetch cannot reach.
 */
export function fakeResearchWeb(input: {
	hits: AtlasV3SearchHit[] | ((question: string) => AtlasV3SearchHit[]);
	pages?: Record<string, string>;
	freshPages?: Record<string, string | null>;
	failSearch?: boolean;
}): FakeResearchWeb {
	const searchCalls: FakeResearchWeb["searchCalls"] = [];
	const readCalls: string[] = [];
	const freshReadCalls: string[] = [];
	return {
		searchCalls,
		readCalls,
		freshReadCalls,
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
		read: async (url, options): Promise<AtlasV3ReadResult> => {
			readCalls.push(url);
			if (options?.fresh) {
				freshReadCalls.push(url);
				if (input.freshPages && url in input.freshPages) {
					return { url, text: input.freshPages[url] ?? null, cached: false };
				}
			}
			return { url, text: input.pages?.[url] ?? null, cached: false };
		},
	};
}

export interface FakeLocalSources extends AtlasV3LocalSources {
	resolveCalls: Array<Parameters<AtlasV3LocalSources["resolve"]>[0]>;
	passageCalls: Array<Parameters<AtlasV3LocalSources["passages"]>[0]>;
}

/**
 * The user's documents, without a database: `resolve` answers with the
 * documents and unavailable entries given, and `passages` with the passages
 * given per display artifact id (none when a document has no entry).
 */
export function fakeLocalSources(input: {
	documents?: Array<
		Partial<AtlasV3LocalDocument> & {
			displayArtifactId: string;
			title: string;
		}
	>;
	unavailable?: AtlasV3LocalUnavailable[];
	passages?: Record<string, string[]>;
}): FakeLocalSources {
	const resolveCalls: FakeLocalSources["resolveCalls"] = [];
	const passageCalls: FakeLocalSources["passageCalls"] = [];
	const documents: AtlasV3LocalDocument[] = (input.documents ?? []).map(
		(document) => ({
			promptArtifactId: `${document.displayArtifactId}-normalized`,
			origin: "attachment",
			summary: null,
			...document,
		}),
	);
	return {
		resolveCalls,
		passageCalls,
		resolve: async (request) => {
			resolveCalls.push(request);
			return { documents, unavailable: input.unavailable ?? [] };
		},
		passages: async (request) => {
			passageCalls.push(request);
			return (input.passages?.[request.document.displayArtifactId] ?? []).map(
				(text, index) => ({
					text,
					chunkIndex: index,
					pageStart: null,
					pageEnd: null,
				}),
			);
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
