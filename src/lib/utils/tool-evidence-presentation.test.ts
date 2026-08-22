import { describe, expect, it } from "vitest";
import type { I18nKey } from "$lib/i18n";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import {
	buildFetchedSourceSummary,
	candidateReason,
	citedCount,
	dedupeSourcesByUrl,
	extractHostname,
	type FetchedSource,
	formatToolCall,
	getAgendaCandidates,
	getFaviconUrl,
	getFetchedSources,
	getFetchUrlSources,
	getFetchUrls,
	getPhotoCandidates,
	getToolTitle,
	immichThumbnailUrl,
	isCalendarToolName,
	isCitedSource,
	isPhotosToolName,
	orderCitedFirst,
	type ToolCallSegment,
	type Translate,
} from "./tool-evidence-presentation";

// A faithful stand-in for the app's real `$t`: reproduces the exact strings
// (incl. the minimal ICU plural) the English dictionary uses for the keys these
// pure builders touch, so the summary/label assertions lock the real output.
const fakeTranslate: Translate = (key: I18nKey, params) => {
	const count = Number(params?.count);
	const dict: Partial<Record<I18nKey, string>> = {
		"toolCalls.searchedWeb": "Searched the web",
		"toolCalls.sourcesCount": `${count} source${count === 1 ? "" : "s"}`,
		"toolCalls.citedCount": `${count} cited`,
		"toolCalls.readPagesCount": `Read ${count} page${count === 1 ? "" : "s"}`,
		"toolCalls.search": "Search",
		"toolCalls.webSearch": "Searched the web",
		"toolCalls.fetchPage": "Fetch page",
		"toolCalls.calendar": "Calendar",
		"toolCalls.createFile": "Create file",
		"toolCalls.generic": "Tool",
	};
	return dict[key] ?? key;
};

function candidate(
	over: Partial<ToolEvidenceCandidate> = {},
): ToolEvidenceCandidate {
	return {
		id: over.id ?? "c1",
		title: over.title ?? "Title",
		sourceType: over.sourceType ?? "web",
		...over,
	};
}

function webSegment(
	candidates: ToolEvidenceCandidate[],
	name = "research_web",
): ThinkingSegment {
	return { type: "tool_call", name, status: "done", input: {}, candidates };
}

describe("extractHostname", () => {
	it("strips a leading www.", () => {
		expect(extractHostname("https://www.example.com/path?q=1")).toBe(
			"example.com",
		);
	});

	it("keeps a non-www host untouched", () => {
		expect(extractHostname("https://docs.example.org/a")).toBe(
			"docs.example.org",
		);
	});

	it("falls back to a 40-char slice on an unparseable value", () => {
		const raw = "not a url ".repeat(10);
		expect(extractHostname(raw)).toBe(raw.slice(0, 40));
	});
});

describe("getFaviconUrl", () => {
	it("builds the same-origin /api/favicon proxy URL from the host, www-stripped", () => {
		expect(getFaviconUrl("https://www.example.com/deep/path")).toBe(
			"/api/favicon?domain=example.com",
		);
	});

	it("routes through the same-origin proxy and never leaks to google", () => {
		const url = getFaviconUrl("https://news.example.co.uk/story");
		expect(url).toBe("/api/favicon?domain=news.example.co.uk");
		expect(url).not.toContain("google");
	});

	it("returns null for an unparseable url", () => {
		expect(getFaviconUrl("::::not a url")).toBeNull();
	});
});

describe("getFetchUrls", () => {
	it("splits a comma-separated url list from a fetch tool, keeping only valid urls", () => {
		expect(
			getFetchUrls("fetch_url", {
				url: "https://a.example, not-a-url, https://b.example",
			}),
		).toEqual(["https://a.example", "https://b.example"]);
	});

	it("returns [] for a non-fetch tool", () => {
		expect(getFetchUrls("calendar", { url: "https://a.example" })).toEqual([]);
	});

	it("returns [] for a file-production tool even if it carries a url", () => {
		expect(
			getFetchUrls("produce_file", { previewUrl: "https://a.example" }),
		).toEqual([]);
	});
});

describe("candidateReason", () => {
	it("prefers the trimmed snippet", () => {
		expect(candidateReason(candidate({ snippet: "  hi there  " }))).toBe(
			"hi there",
		);
	});

	it("falls back through reason/reasoning/description/summary metadata", () => {
		expect(
			candidateReason(candidate({ metadata: { description: "desc" } })),
		).toBe("desc");
		expect(candidateReason(candidate({ metadata: { summary: "sum" } }))).toBe(
			"sum",
		);
	});

	it("returns undefined when nothing usable is present", () => {
		expect(
			candidateReason(candidate({ metadata: { start: "x" } })),
		).toBeUndefined();
	});
});

describe("isCitedSource / orderCitedFirst", () => {
	it("treats only status 'selected' as cited", () => {
		expect(isCitedSource({ title: "a", url: "u", status: "selected" })).toBe(
			true,
		);
		expect(isCitedSource({ title: "a", url: "u", status: "reference" })).toBe(
			false,
		);
		expect(isCitedSource({ title: "a", url: "u" })).toBe(false);
	});

	it("moves cited sources to the front while keeping each group's original order (stable)", () => {
		const sources: FetchedSource[] = [
			{ title: "u1", url: "u1", status: "reference" },
			{ title: "c1", url: "c1", status: "selected" },
			{ title: "u2", url: "u2", status: "reference" },
			{ title: "c2", url: "c2", status: "selected" },
		];
		expect(orderCitedFirst(sources).map((s) => s.url)).toEqual([
			"c1",
			"c2",
			"u1",
			"u2",
		]);
	});
});

describe("dedupeSourcesByUrl", () => {
	it("collapses duplicate urls, keeping first-occurrence position", () => {
		const deduped = dedupeSourcesByUrl([
			{ title: "a", url: "u1" },
			{ title: "b", url: "u2" },
			{ title: "a-again", url: "u1" },
		]);
		expect(deduped.map((s) => s.url)).toEqual(["u1", "u2"]);
		expect(deduped[0].title).toBe("a");
	});

	it("prefers the cited copy on a status collision, keeping first position", () => {
		const deduped = dedupeSourcesByUrl([
			{ title: "ref", url: "u1", status: "reference" },
			{ title: "cited", url: "u1", status: "selected" },
		]);
		expect(deduped).toHaveLength(1);
		expect(deduped[0].url).toBe("u1");
		expect(deduped[0].status).toBe("selected");
		expect(deduped[0].title).toBe("cited");
	});

	it("does not downgrade an already-cited copy when a later reference appears", () => {
		const deduped = dedupeSourcesByUrl([
			{ title: "cited", url: "u1", status: "selected" },
			{ title: "ref", url: "u1", status: "reference" },
		]);
		expect(deduped).toHaveLength(1);
		expect(deduped[0].status).toBe("selected");
	});
});

describe("getFetchedSources", () => {
	it("returns [] for anything but a research_web tool_call", () => {
		expect(
			getFetchedSources({ type: "text", content: "hi" } as ThinkingSegment),
		).toEqual([]);
		expect(getFetchedSources(webSegment([], "calendar"))).toEqual([]);
	});

	it("shapes web candidates into cited-first, deduped sources with hostname fallback titles", () => {
		const sources = getFetchedSources(
			webSegment([
				candidate({
					id: "u",
					title: "",
					url: "https://www.uncited.example/x",
					status: "reference",
				}),
				candidate({
					id: "c",
					title: "Cited One",
					url: "https://cited.example/y",
					status: "selected",
					snippet: "why it matters",
				}),
				// non-web candidate is filtered out
				candidate({ id: "t", sourceType: "tool", url: "https://tool.example" }),
			]),
		);
		expect(sources).toHaveLength(2);
		// cited leads
		expect(sources[0].url).toBe("https://cited.example/y");
		expect(sources[0].reason).toBe("why it matters");
		// empty title falls back to www-stripped hostname
		expect(sources[1].title).toBe("uncited.example");
	});
});

describe("getFetchUrlSources", () => {
	it("maps read-page urls to hostname-titled sources, deduped", () => {
		const sources = getFetchUrlSources("fetch_url", {
			url: "https://www.a.example/p, https://a.example/p",
		});
		// distinct urls (trailing slash normalization makes these two different)
		expect(sources.map((s) => s.title)).toEqual(["a.example", "a.example"]);
		expect(sources.every((s) => s.status === undefined)).toBe(true);
	});
});

describe("citedCount / buildFetchedSourceSummary", () => {
	const cited: FetchedSource = { title: "c", url: "c", status: "selected" };
	const ref: FetchedSource = { title: "r", url: "r", status: "reference" };

	it("counts only cited sources", () => {
		expect(citedCount([cited, ref, cited])).toBe(2);
	});

	it("formats the search summary with the cited clause when something was cited", () => {
		expect(
			buildFetchedSourceSummary([cited, ref], "search", fakeTranslate),
		).toBe("Searched the web · 2 sources · 1 cited");
	});

	it("omits the cited clause when nothing was cited", () => {
		expect(buildFetchedSourceSummary([ref], "search", fakeTranslate)).toBe(
			"Searched the web · 1 source",
		);
	});

	it("formats the read summary by page count", () => {
		expect(buildFetchedSourceSummary([ref, ref], "read", fakeTranslate)).toBe(
			"Read 2 pages",
		);
	});
});

describe("agenda / photo candidate extraction", () => {
	function tool(
		candidates: ToolEvidenceCandidate[],
		name = "calendar",
	): ToolCallSegment {
		return {
			type: "tool_call",
			name,
			status: "done",
			input: {},
			candidates,
		};
	}

	it("keeps only candidates with a string metadata.start, capped at 5", () => {
		const items = getAgendaCandidates([
			tool([
				candidate({ id: "e1", metadata: { start: "2026-07-10T09:00:00Z" } }),
				candidate({ id: "e2", metadata: { location: "no start" } }),
				...Array.from({ length: 8 }, (_, i) =>
					candidate({ id: `x${i}`, metadata: { start: `t${i}` } }),
				),
			]),
		]);
		expect(items.length).toBe(5);
		expect(items.every((c) => typeof c.metadata?.start === "string")).toBe(
			true,
		);
	});

	it("keeps only candidates with a string metadata.thumbnailPath, capped at 8", () => {
		const items = getPhotoCandidates([
			tool(
				Array.from({ length: 12 }, (_, i) =>
					candidate({
						id: `p${i}`,
						metadata: { thumbnailPath: `/api/assets/a${i}/thumbnail` },
					}),
				),
				"photos",
			),
		]);
		expect(items.length).toBe(8);
	});

	it("flattens candidates across multiple grouped tool calls", () => {
		const items = getAgendaCandidates([
			tool([candidate({ id: "a", metadata: { start: "t1" } })]),
			tool([candidate({ id: "b", metadata: { start: "t2" } })]),
		]);
		expect(items.map((c) => c.id)).toEqual(["a", "b"]);
	});
});

describe("immichThumbnailUrl", () => {
	it("rewrites the internal asset thumbnail path to the per-user proxy route", () => {
		expect(immichThumbnailUrl("/api/assets/asset-1/thumbnail")).toBe(
			"/api/connections/immich/thumbnail/asset-1",
		);
	});

	it("returns null for a non-string or non-matching path", () => {
		expect(immichThumbnailUrl(42)).toBeNull();
		expect(immichThumbnailUrl("/api/assets/asset-1/full")).toBeNull();
		expect(immichThumbnailUrl(undefined)).toBeNull();
	});
});

describe("isCalendarToolName / isPhotosToolName", () => {
	it("matches case-insensitively", () => {
		expect(isCalendarToolName("Calendar")).toBe(true);
		expect(isCalendarToolName("photos")).toBe(false);
		expect(isPhotosToolName("PHOTOS")).toBe(true);
	});
});

describe("formatToolCall", () => {
	it("labels a web search with the tool label and quoted query", () => {
		expect(
			formatToolCall("research_web", { query: "best pho" }, fakeTranslate),
		).toBe('Searched the web: "best pho"');
	});

	it("labels a non-web search with the generic Search label", () => {
		expect(formatToolCall("tavily_search", { q: "cats" }, fakeTranslate)).toBe(
			'Search: "cats"',
		);
	});

	it("labels a fetch tool with the tool label and hostname", () => {
		expect(
			formatToolCall(
				"fetch_url",
				{ url: "https://www.a.example/p" },
				fakeTranslate,
			),
		).toBe("Fetch page: a.example");
	});

	it("labels a connection tool by capability + humanized action", () => {
		expect(
			formatToolCall("calendar", { action: "list_events" }, fakeTranslate),
		).toBe("Calendar: list events");
	});

	it("returns just the label for a file-production tool", () => {
		expect(
			formatToolCall("produce_file", { requestTitle: "Report" }, fakeTranslate),
		).toBe("Create file");
	});
});

describe("getToolTitle", () => {
	it("returns the raw query for a search tool", () => {
		expect(getToolTitle("research_web", { query: "q" })).toBe("q");
	});

	it("returns the request title for a file-production tool, defaulting to produce_file", () => {
		expect(getToolTitle("produce_file", { filename: "f.pdf" })).toBe("f.pdf");
		expect(getToolTitle("produce_file", {})).toBe("produce_file");
	});

	it("returns the first input value for a fetch tool", () => {
		expect(getToolTitle("fetch_url", { url: "https://a.example" })).toBe(
			"https://a.example",
		);
	});
});
