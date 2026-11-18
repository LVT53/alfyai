import { describe, expect, it, vi } from "vitest";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { estimateTokenCount } from "$lib/utils/tokens";
import { bindReadResultGrant } from "./normal-chat-tools/model-payload-budget";
import {
	createToolCallRecorder,
	executeToolWithEnvelope,
	type ToolCallRecorder,
} from "./normal-chat-tools/shared";
import { stableStringify } from "./normal-chat-tools/stable-stringify";
import {
	baseGroundedWebDiagnostics,
	type GroundedWebResult,
	MAX_PAYLOAD_SOURCES,
} from "./parallel-search/types";
import {
	boundGroundedWebView,
	buildGroundedWebModelPayload,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
	extractCitedCanonicalWebUrls,
	extractGroundedWebCitationSources,
	groundedWebSourcesFromCandidates,
	summarizeGroundedWebResult,
} from "./web-grounding";

function fixture(
	overrides: Partial<GroundedWebResult> = {},
): GroundedWebResult {
	return {
		query: "what is the capital of france",
		queries: [{ query: "what is the capital of france" }],
		sources: [
			{
				id: "p0",
				title: "Source Zero",
				url: "https://example.com/a",
				provider: "parallel",
				authorityClass: "standard",
				authorityScore: 50,
				snippet: "snippet a",
				highlights: ["highlight a"],
				providerRank: 0,
				publishedAt: null,
				updatedAt: null,
			},
			{
				id: "p1",
				title: "Source One",
				url: "https://example.org/b",
				provider: "parallel",
				authorityClass: "standard",
				authorityScore: 50,
				snippet: "snippet b",
				highlights: ["highlight b"],
				providerRank: 1,
				publishedAt: null,
				updatedAt: null,
			},
		],
		evidence: [
			{
				id: "p0e0",
				sourceId: "p0",
				title: "Source Zero",
				url: "https://example.com/a",
				provider: "parallel",
				quote: "quote a",
				score: 1,
			},
			{
				id: "p1e0",
				sourceId: "p1",
				title: "Source One",
				url: "https://example.org/b",
				provider: "parallel",
				quote: "quote b",
				score: 0.9,
			},
		],
		answerBrief: {
			markdown: "# Web research brief\n[1] Source Zero — https://example.com/a",
			instructions: ["Answer only from these sources."],
		},
		diagnostics: baseGroundedWebDiagnostics({
			mode: "turbo",
			fetchedSourceCount: 2,
			fusedSourceCount: 2,
			selectedSourceCount: 2,
			evidenceCandidateCount: 2,
		}),
		...overrides,
	};
}

// P4 tool-result hygiene: `diagnostics`, `answerBrief.instructions` and the
// trailing `instructions` string are gone from the MODEL payload — diagnostics
// now live only in the recorder `metadata` via createGroundedWebMetadata (see
// the "diagnostics move to recorder metadata" tests below).
const FROZEN_PAYLOAD_KEYS = [
	"success",
	"name",
	"sourceType",
	"query",
	"queries",
	"answerBrief",
	"answerBriefMarkdown",
	"sources",
	"evidence",
];

describe("web-grounding contract guard (GroundedWebResult)", () => {
	it("buildGroundedWebModelPayload emits the frozen top-level field names", () => {
		const payload = buildGroundedWebModelPayload(fixture());
		for (const key of FROZEN_PAYLOAD_KEYS) {
			expect(payload).toHaveProperty(key);
		}
		expect(payload.name).toBe("research_web");
		expect(payload.sourceType).toBe("web");
		expect(payload.success).toBe(true);
		expect(payload.query).toBe("what is the capital of france");
		expect(payload.queries).toEqual(["what is the capital of france"]);
		expect(payload.answerBriefMarkdown).toContain("Web research brief");
		expect(payload).not.toHaveProperty("diagnostics");
		expect(payload).not.toHaveProperty("instructions");
		expect(payload.answerBrief).not.toHaveProperty("instructions");
	});

	it("source and evidence entries carry the frozen field names", () => {
		const payload = buildGroundedWebModelPayload(fixture());
		expect(payload.sources[0]).toMatchObject({
			id: "p0",
			title: "Source Zero",
			url: "https://example.com/a",
			provider: "parallel",
			authorityClass: "standard",
			authorityScore: 50,
		});
		expect(payload.evidence[0]).toMatchObject({
			id: "p0e0",
			sourceId: "p0",
			quote: "quote a",
			url: "https://example.com/a",
			score: 1,
		});
	});

	it("createGroundedWebCandidates yields web candidates", () => {
		const candidates = createGroundedWebCandidates(fixture());
		expect(candidates.length).toBe(2);
		for (const c of candidates) {
			expect(c.sourceType).toBe("web");
			expect(c.material).toBe(true);
			expect(c.id).toBeTruthy();
			expect(c.title).toBeTruthy();
			expect(c.url).toBeTruthy();
		}
	});

	it("createGroundedWebCandidates never exceeds the model's source slice (MAX_PAYLOAD_SOURCES)", () => {
		const manySources = Array.from({ length: 12 }, (_, index) => ({
			id: `p${index}`,
			title: `Source ${index}`,
			url: `https://example${index}.com/a`,
			provider: "parallel",
			authorityClass: "standard",
			authorityScore: 50,
			snippet: `snippet ${index}`,
			highlights: [`highlight ${index}`],
			providerRank: index,
			publishedAt: null,
			updatedAt: null,
		}));
		const candidates = createGroundedWebCandidates(
			fixture({ sources: manySources }),
		);
		// The chip/candidate set must never represent a source the model was not
		// given (the model payload is sliced to MAX_PAYLOAD_SOURCES).
		expect(candidates.length).toBe(MAX_PAYLOAD_SOURCES);
		expect(candidates.map((c) => c.id)).toEqual(
			manySources.slice(0, MAX_PAYLOAD_SOURCES).map((s) => s.id),
		);
	});

	it("createGroundedWebMetadata gates evidence", () => {
		expect(createGroundedWebMetadata(fixture())).toMatchObject({
			ok: true,
			evidenceReady: true,
		});
		const noEvidence = createGroundedWebMetadata(fixture({ evidence: [] }));
		expect(noEvidence.ok).toBe(true);
		expect(noEvidence.evidenceReady).toBe(false);
	});

	it("createGroundedWebMetadata carries the diagnostics dropped from the model payload", () => {
		const metadata = createGroundedWebMetadata(fixture());
		expect(metadata).toMatchObject({
			mode: "turbo",
			fetchedSourceCount: 2,
			fusedSourceCount: 2,
			selectedSourceCount: 2,
			evidenceCandidateCount: 2,
			pageExtractionAttemptedCount: 0,
			pageExtractionSucceededCount: 0,
		});
		// Every metadata value must be a flat scalar (or null) — the recorder
		// entry's `metadata` field rejects nested objects/arrays.
		for (const value of Object.values(metadata)) {
			expect(["string", "number", "boolean"]).toContain(typeof value);
		}
	});

	it("empty evidence makes the payload not evidence-ready", () => {
		const payload = buildGroundedWebModelPayload(fixture({ evidence: [] }));
		expect(payload.success).toBe(false);
	});

	it("maxMarkdownChars opt raises the answer-brief markdown limit", () => {
		const longMarkdown = "x".repeat(45000);
		const briefOverride = {
			answerBrief: { markdown: longMarkdown, instructions: [] },
		};

		// Default (research_web, no opts) caps the brief at the
		// WEB_RESEARCH_BRIEF_MAX_CHARS default of 12000 chars (plus ellipsis).
		const defaultPayload = buildGroundedWebModelPayload(fixture(briefOverride));
		expect(defaultPayload.answerBriefMarkdown.length).toBeLessThanOrEqual(
			12003,
		);
		expect(defaultPayload.answerBriefMarkdown.length).toBeGreaterThan(11000);

		// A larger maxMarkdownChars (e.g. fetch_url's model-aware cap) lets the
		// full brief through untruncated.
		const raisedPayload = buildGroundedWebModelPayload(fixture(briefOverride), {
			maxMarkdownChars: 50000,
		});
		expect(raisedPayload.answerBriefMarkdown.length).toBe(45000);
	});

	it("WEB_RESEARCH_BRIEF_MAX_CHARS env override changes the research_web default", async () => {
		const longMarkdown = "x".repeat(20000);
		const briefOverride = {
			answerBrief: { markdown: longMarkdown, instructions: [] },
		};
		const previous = process.env.WEB_RESEARCH_BRIEF_MAX_CHARS;
		process.env.WEB_RESEARCH_BRIEF_MAX_CHARS = "5000";
		try {
			// The cap now comes from env.ts's config.webResearchBriefMaxChars,
			// read once per process and cached (env.ts's `config` Proxy) — a
			// live process.env mutation only reaches a NEW module graph, so
			// this needs its own fresh import rather than the module-level
			// static one every other test in this file uses.
			vi.resetModules();
			const { buildGroundedWebModelPayload: buildWithOverride } = await import(
				"./web-grounding"
			);
			const payload = buildWithOverride(fixture(briefOverride));
			expect(payload.answerBriefMarkdown.length).toBeLessThanOrEqual(5003);
			expect(payload.answerBriefMarkdown.length).toBeGreaterThan(4000);
		} finally {
			if (previous === undefined) {
				delete process.env.WEB_RESEARCH_BRIEF_MAX_CHARS;
			} else {
				process.env.WEB_RESEARCH_BRIEF_MAX_CHARS = previous;
			}
			vi.resetModules();
		}
	});

	it("fetch_url is unaffected by the research_web default cap when it passes its own", () => {
		const longMarkdown = "x".repeat(20000);
		const briefOverride = {
			answerBrief: { markdown: longMarkdown, instructions: [] },
		};
		const payload = buildGroundedWebModelPayload(fixture(briefOverride), {
			name: "fetch_url",
			maxMarkdownChars: 60000,
		});
		expect(payload.name).toBe("fetch_url");
		expect(payload.answerBriefMarkdown.length).toBe(20000);
	});

	it("summarizeGroundedWebResult reports the counts", () => {
		const summary = summarizeGroundedWebResult(fixture());
		expect(summary).toContain("2");
		expect(summary.length).toBeGreaterThan(0);
	});
});

describe("extractGroundedWebCitationSources", () => {
	const candidate = (url: string): ToolEvidenceCandidate => ({
		id: `c-${url}`,
		title: "T",
		url,
		snippet: null,
		sourceType: "web",
		material: true,
	});
	const entry = (name: string, url: string): ToolCallEntry =>
		({
			callId: `call-${name}`,
			name,
			input: {},
			status: "done",
			sourceType: "web",
			candidates: [candidate(url)],
			metadata: { ok: true, evidenceReady: true },
		}) as unknown as ToolCallEntry;

	it("harvests citation sources from both research_web and fetch_url", () => {
		const sources = extractGroundedWebCitationSources([
			entry("research_web", "https://example.com/a"),
			entry("fetch_url", "https://example.org/b"),
		]);
		const hosts = sources.map((s) => s.host).sort();
		expect(hosts).toEqual(["example.com", "example.org"]);
	});

	it("ignores non-web / non-done tool calls", () => {
		const notDone = {
			...entry("research_web", "https://x.com/1"),
			status: "running",
		} as unknown as ToolCallEntry;
		expect(extractGroundedWebCitationSources([notDone])).toEqual([]);
	});
});

describe("extractCitedCanonicalWebUrls", () => {
	it("canonicalizes cited URLs from markdown links and bare URLs", () => {
		const set = extractCitedCanonicalWebUrls(
			"See [docs](https://www.foo.com/a/?utm_source=x) and https://bar.com/b.",
		);
		expect([...set].sort()).toEqual(["https://bar.com/b", "https://foo.com/a"]);
	});

	it("keeps balanced parentheses inside a cited URL", () => {
		const set = extractCitedCanonicalWebUrls(
			"See [Cork](https://en.wikipedia.org/wiki/Cork_(city)) and https://en.wikipedia.org/wiki/Cork_(city).",
		);
		expect([...set]).toEqual(["https://en.wikipedia.org/wiki/Cork_(city)"]);
	});

	it("returns an empty set when the answer cites no URLs", () => {
		expect(extractCitedCanonicalWebUrls("no links here at all").size).toBe(0);
	});
});

describe("groundedWebSourcesFromCandidates", () => {
	it("is the inverse of createGroundedWebCandidates: the sources the model was given, rebuilt from the candidates the tool call persisted", () => {
		const result = fixture();
		const payload = buildGroundedWebModelPayload(result);

		const rebuilt = groundedWebSourcesFromCandidates(
			createGroundedWebCandidates(result),
		);

		expect(rebuilt).toEqual(payload.sources);
	});

	it("carries the dates a source has, and only those", () => {
		const result = fixture();
		result.sources[0].publishedAt = "2026-09-01";
		result.sources[1].updatedAt = "2026-09-02";
		const rebuilt = groundedWebSourcesFromCandidates(
			createGroundedWebCandidates(result),
		);
		expect(rebuilt[0]).toMatchObject({
			publishedAt: "2026-09-01",
			updatedAt: null,
		});
		expect(rebuilt[1]).toMatchObject({
			publishedAt: null,
			updatedAt: "2026-09-02",
		});
	});

	it("takes the highlight a candidate stands on when its source had no snippet, and no snippet when it had neither", () => {
		const result = fixture();
		result.sources[0].snippet = null;
		result.sources[1].snippet = null;
		result.sources[1].highlights = [];
		const rebuilt = groundedWebSourcesFromCandidates(
			createGroundedWebCandidates(result),
		);
		expect(rebuilt[0].snippet).toBe("highlight a");
		expect(rebuilt[1]).not.toHaveProperty("snippet");
	});

	it("fills what a record from before the tool kept its metadata does not have with neutral values, never with undefined", () => {
		const old: ToolEvidenceCandidate = {
			id: "old-1",
			title: "Older record",
			url: "https://example.org/older",
			snippet: null,
			sourceType: "web",
		};

		expect(groundedWebSourcesFromCandidates([old])).toEqual([
			{
				id: "old-1",
				title: "Older record",
				url: "https://example.org/older",
				provider: "",
				authorityClass: "unknown",
				authorityScore: 0,
				publishedAt: null,
				updatedAt: null,
			},
		]);
	});

	it("leaves out what is not a web source with an address: another tool's candidate, one with no link", () => {
		const web = createGroundedWebCandidates(fixture())[0];
		const rebuilt = groundedWebSourcesFromCandidates([
			{ ...web, id: "photo", sourceType: "tool" },
			{ ...web, id: "no-link", url: "" },
			{ ...web, id: "null-link", url: null as unknown as string },
			web,
		]);
		expect(rebuilt.map((source) => source.id)).toEqual([web.id]);
	});
});

// Task 2 RED: only the NEW selected view may become evidence. Old captures and
// the candidate/cache backing data must remain unchanged.
describe("Task 2 bounded NEW web view", () => {
	function select(
		result: GroundedWebResult,
		maxPayloadTokens: number,
		pages = [] as import("./web-grounding").GroundedWebPage[],
	) {
		expect(boundGroundedWebView).toBeTypeOf("function");
		return boundGroundedWebView({
			result,
			pages,
			name: "research_web",
			cached: true,
			maxPayloadTokens,
		});
	}

	it("preserves the complete fitting candidate view and its brief", () => {
		const result = fixture();
		const before = structuredClone(result);
		const view = select(result, 8_000);
		expect(view.modelPayload).toMatchObject({
			...buildGroundedWebModelPayload(result),
			bounded: true,
			coverage: "full",
			omitted: { sources: 0, evidence: 0, pages: 0 },
			pageRanges: [],
		});
		expect(view.candidates.map((candidate) => candidate.id)).toEqual([
			"p0",
			"p1",
		]);
		expect(result).toEqual(before);
	});

	it("drops the unscoped brief when quotes are omitted even with every source retained", () => {
		const base = fixture();
		const result = fixture({
			sources: [base.sources[0]],
			evidence: [
				base.evidence[0],
				...Array.from({ length: 20 }, (_, index) => ({
					...base.evidence[0],
					id: `tail-${index}`,
					quote: "OMITTED_QUOTE_FACT ".repeat(45),
				})),
			],
			answerBrief: {
				markdown: "OMITTED_QUOTE_FACT is confirmed.",
				instructions: [],
			},
		});
		const view = select(result, 1_200);
		expect(view.modelPayload.sources.map((source) => source.id)).toEqual([
			"p0",
		]);
		expect(view.modelPayload.coverage).toBe("partial");
		expect(view.modelPayload.omitted.evidence).toBeGreaterThan(0);
		expect(view.modelPayload.answerBriefMarkdown ?? "").toBe("");
		expect(JSON.stringify(view.candidates)).not.toContain("OMITTED_QUOTE_FACT");
		expect(view.metadata.evidenceCount).toBe(view.modelPayload.evidence.length);
		expect(
			estimateTokenCount(stableStringify(view.modelPayload)),
		).toBeLessThanOrEqual(1_200);
	});

	it("exposes a versioned exact page prefix without its unseen tail or brief-only fact", () => {
		const base = fixture();
		const result = fixture({
			sources: [base.sources[0]],
			evidence: [base.evidence[0]],
			answerBrief: { markdown: "UNSEEN_PAGE_TAIL_FACT", instructions: [] },
		});
		const page = {
			url: base.sources[0].url,
			title: "Page",
			contentMarkdown: `${"Visible 😀 evidence. ".repeat(2_000)}UNSEEN_PAGE_TAIL_FACT`,
		};
		const view = select(result, 1_200, [page]);
		expect(view.modelPayload.sources.map((source) => source.id)).toEqual([
			"p0",
		]);
		expect(view.modelPayload.coverage).toBe("partial");
		const range = view.modelPayload.pageRanges[0];
		expect(range).toMatchObject({
			sourceId: "p0",
			start: 0,
			totalChars: page.contentMarkdown.length,
		});
		expect(range.contentHash).toBeTruthy();
		expect(range.end).toBeGreaterThan(0);
		expect(range.end).toBeLessThan(page.contentMarkdown.length);
		expect(view.modelPayload.pages?.[0].contentMarkdown).toBe(
			page.contentMarkdown.slice(0, range.end),
		);
		const lastUnit = page.contentMarkdown.charCodeAt(range.end - 1);
		expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
		expect(JSON.stringify(view)).not.toContain("UNSEEN_PAGE_TAIL_FACT");
		expect(view.modelPayload.answerBriefMarkdown ?? "").toBe("");
		expect(
			estimateTokenCount(stableStringify(view.modelPayload)),
		).toBeLessThanOrEqual(1_200);
	});

	it("selects deterministically on a new cache lease and keeps omitted sources out of citation eligibility", () => {
		const base = fixture();
		const sources = Array.from({ length: 8 }, (_, index) => ({
			...base.sources[0],
			id: `s${index}`,
			url: `https://source${index}.example/a`,
			snippet: "source detail ".repeat(35),
		}));
		const result = fixture({
			sources,
			evidence: sources.map((source) => ({
				...base.evidence[0],
				id: `${source.id}e0`,
				sourceId: source.id,
				url: source.url,
				quote: "supported quote ".repeat(40),
			})),
		});
		const before = structuredClone(result);
		const oldView = select(result, 16_000);
		const oldCapture = structuredClone(oldView);
		const view = select(result, 1_200);
		expect(select(result, 1_200)).toEqual(view);
		expect(view.modelPayload.omitted.sources).toBeGreaterThan(0);
		const selected = view.modelPayload.sources.map((source) => source.id);
		expect(selected.length).toBeGreaterThan(0);
		expect(view.candidates.map((candidate) => candidate.id)).toEqual(selected);
		for (const evidence of view.modelPayload.evidence)
			expect(selected).toContain(evidence.sourceId);
		const citations = extractGroundedWebCitationSources([
			{
				name: "research_web",
				input: {},
				status: "done",
				candidates: view.candidates,
				metadata: view.metadata,
			},
		]);
		expect(citations.map((citation) => citation.id)).toEqual(selected);
		expect(view.metadata.sourceCount).toBe(selected.length);
		expect(view.metadata.evidenceCount).toBe(view.modelPayload.evidence.length);
		expect(result).toEqual(before);
		expect(oldView).toEqual(oldCapture);
	});
});

it("Task 2 never restores an omitted raw highlight as factual candidate support", () => {
	const base = fixture();
	const result = fixture({
		sources: [
			{
				...base.sources[0],
				snippet: null,
				highlights: ["HIDDEN_HIGHLIGHT_FACT"],
			},
			base.sources[1],
		],
		evidence: [base.evidence[1]],
		answerBrief: {
			markdown: `HIDDEN_HIGHLIGHT_FACT ${"brief detail ".repeat(3_000)}`,
			instructions: [],
		},
	});
	const view = boundGroundedWebView({
		result,
		pages: [],
		name: "research_web",
		cached: false,
		maxPayloadTokens: 1_200,
	});
	expect(view.modelPayload.coverage).toBe("partial");
	expect(view.modelPayload.sources.map((source) => source.id)).toContain("p0");
	const metadataOnly = view.candidates.find(
		(candidate) => candidate.id === "p0",
	);
	expect(metadataOnly?.snippet).toBeNull();
	expect(metadataOnly?.material).toBe(false);
	expect(
		extractGroundedWebCitationSources([
			{
				name: "research_web",
				input: {},
				status: "done",
				candidates: view.candidates,
				metadata: view.metadata,
			},
		]).map((source) => source.id),
	).toEqual(["p1"]);
	expect(JSON.stringify(view)).not.toContain("HIDDEN_HIGHLIGHT_FACT");
});

it.each([
	"no support",
	"unfittable quote",
	"unfittable page",
] as const)("Task 2 admits useful B before metadata-only A with %s consumes its room", async (kind) => {
	const base = fixture();
	const a = {
		...base.sources[0],
		snippet: null,
		highlights: ["UNEXPOSED_A_FACT"],
	};
	const b = {
		...base.sources[1],
		snippet: "Useful exposed B evidence.",
		highlights: [],
	};
	const evidence =
		kind === "unfittable quote"
			? [{ ...base.evidence[0], quote: "UNEXPOSED_A_FACT ".repeat(2_000) }]
			: [];
	const pages =
		kind === "unfittable page"
			? [
					{
						url: a.url,
						title: "Page header too large to fit ".repeat(1_000),
						contentMarkdown: "UNEXPOSED_A_FACT ".repeat(2_000),
					},
				]
			: [];
	const result = fixture({
		sources: [a, b],
		evidence,
		answerBrief: { markdown: "UNEXPOSED_A_FACT", instructions: [] },
	});
	const before = structuredClone({ result, pages });
	const bOnly = boundGroundedWebView({
		result: {
			...result,
			sources: [b],
			evidence: [],
			answerBrief: { markdown: "", instructions: [] },
		},
		pages: [],
		name: "research_web",
		cached: false,
		maxPayloadTokens: 32_000,
	}).modelPayload;
	const expectedB = {
		...bOnly,
		coverage: "partial",
		omitted: { sources: 1, evidence: evidence.length, pages: pages.length },
	};
	const limit = estimateTokenCount(stableStringify(expectedB));
	const aAndB = {
		...expectedB,
		sources: buildGroundedWebModelPayload(result).sources,
		answerBrief: { sourceCount: 2, evidenceCount: 0 },
		omitted: { ...expectedB.omitted, sources: 0 },
	};
	expect(estimateTokenCount(stableStringify(aAndB))).toBeGreaterThan(limit);
	const selected = boundGroundedWebView({
		result,
		pages,
		name: "research_web",
		cached: false,
		maxPayloadTokens: limit,
	});
	expect.soft(selected.modelPayload.success).toBe(true);
	expect
		.soft(selected.modelPayload.sources.map((source) => source.id))
		.toEqual(["p1"]);
	const baseRecorder = createToolCallRecorder();
	const observed: unknown[] = [];
	const recorder: ToolCallRecorder = {
		...baseRecorder,
		observeResult: ({ payload }) => {
			observed.push(payload);
		},
	};
	const options = bindReadResultGrant(
		{ toolCallId: "material-bundle", messages: [] },
		{
			kind: "admitted",
			turnId: "t",
			segmentId: "s",
			attemptId: "a",
			stepId: "step",
			executionId: "e",
			proposalOrdinal: 0,
			maxPayloadTokens: limit,
			maxFailurePayloadTokens: 256,
		},
	);
	const returned = await executeToolWithEnvelope({
		toolName: "research_web",
		timeoutMs: 5_000,
		readOnly: true,
		options,
		recorder,
		run: async () => ({
			modelPayload: selected.modelPayload,
			entry: {
				name: "research_web",
				callId: "material-bundle",
				input: {},
				status: "done" as const,
				candidates: selected.candidates,
				metadata: selected.metadata,
			},
		}),
		onError: () => {
			throw new Error("A fitting material bundle must not fail");
		},
	});
	expect(returned).toMatchObject({
		success: true,
		coverage: "partial",
		sources: [expectedB.sources[0]],
		evidence: [],
	});
	expect(observed).toEqual([returned]);
	expect(baseRecorder.getEntries()[0].candidates).toEqual(selected.candidates);
	expect(selected.candidates).toMatchObject([
		{ id: "p1", snippet: b.snippet, material: true },
	]);
	expect(
		extractGroundedWebCitationSources(baseRecorder.getEntries()).map(
			(source) => source.id,
		),
	).toEqual(["p1"]);
	expect(estimateTokenCount(stableStringify(returned))).toBeLessThanOrEqual(
		limit,
	);
	expect(JSON.stringify(returned)).not.toContain("UNEXPOSED_A_FACT");
	expect({ result, pages }).toEqual(before);
});
