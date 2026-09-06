import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	canonicalizeGroundedWebUrl,
	extractAssistantWebCitationUrls,
	extractGroundedWebCitationSources,
	type GroundedWebCitationSource,
} from "./web-grounding";

export type WebCitationQualityGateResult = {
	response: string;
	audit: WebCitationAudit | null;
	appendedNotice: string | null;
	// Summary of the auto-repair pass below (null when no web tool ran this
	// turn, so there was nothing to check). Rides the assistant message
	// metadata as `citationAudit` (see chat-turn/stream-completion.ts and
	// routes/api/chat/send).
	repair: WebCitationRepairSummary | null;
};

export interface WebCitationRepairSummary {
	// Markdown links found in the response, excluding any URL the user pasted
	// in their own message this turn.
	cited: number;
	// Of `cited`, how many exactly matched a retrieved source (left as-is).
	verified: number;
	// Of `cited`, how many were rewritten to a same-registrable-domain
	// retrieved source's URL.
	repaired: number;
	// Of `cited`, how many matched no retrieved source and had their link
	// markup removed (the link TEXT is always kept).
	stripped: number;
}

// Captures both the link text and URL (unlike web-grounding.ts's
// MARKDOWN_LINK_RE, which only needs the URL) so a stripped link can fall
// back to its text instead of disappearing.
const MARKDOWN_LINK_WITH_TEXT_RE =
	/\[([^\]]+)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;

function collectCanonicalUrls(text: string): Set<string> {
	const canonical = new Set<string>();
	for (const url of extractAssistantWebCitationUrls(text)) {
		const result = canonicalizeGroundedWebUrl(url);
		if (result) canonical.add(result.canonicalUrl);
	}
	return canonical;
}

/**
 * Rewrites or strips every markdown link in `assistantResponse` whose URL
 * isn't backed by `sources` (this turn's retrieved research_web/fetch_url
 * candidates, prefetch included) — UNLESS the user pasted that URL
 * themselves, in which case it's left untouched. A link whose canonical URL
 * exactly matches a source is left as-is ("verified"); one that shares a
 * source's registrable domain (host) is rewritten to that source's URL
 * ("repaired"); anything else has its `[text](url)` markup stripped down to
 * just `text` ("stripped") — the link text itself is never removed. Bare
 * URLs (no markdown link syntax) are left untouched: only markdown links
 * carry a claim ("here's the source") that can be repaired without deleting
 * content.
 */
function repairAssistantWebCitations(params: {
	assistantResponse: string;
	sources: GroundedWebCitationSource[];
	userPastedCanonicalUrls: Set<string>;
}): { response: string } & WebCitationRepairSummary {
	const { sources, userPastedCanonicalUrls } = params;
	let cited = 0;
	let verified = 0;
	let repaired = 0;
	let stripped = 0;

	const response = params.assistantResponse.replace(
		MARKDOWN_LINK_WITH_TEXT_RE,
		(full, text: string, url: string) => {
			const canonical = canonicalizeGroundedWebUrl(url);
			// Malformed/non-http(s) link URLs are left exactly as written —
			// there's nothing safe to compare them against.
			if (!canonical) return full;
			if (userPastedCanonicalUrls.has(canonical.canonicalUrl)) return full;

			cited += 1;
			const exact = sources.find(
				(source) => source.canonicalUrl === canonical.canonicalUrl,
			);
			if (exact) {
				verified += 1;
				return full;
			}
			const hostMatch = sources.find(
				(source) => source.host === canonical.host,
			);
			if (hostMatch) {
				repaired += 1;
				return `[${text}](${hostMatch.url})`;
			}
			stripped += 1;
			return text;
		},
	);

	return { response, cited, verified, repaired, stripped };
}

function matchCitation(
	url: string,
	sources: GroundedWebCitationSource[],
): WebCitationAuditCitation | null {
	const canonical = canonicalizeGroundedWebUrl(url);
	if (!canonical) return null;

	const exact = sources.find(
		(source) => source.canonicalUrl === canonical.canonicalUrl,
	);
	if (exact) {
		return {
			url,
			canonicalUrl: canonical.canonicalUrl,
			supported: true,
			matchType: "exact",
			matchedSourceId: exact.id,
			matchedSourceTitle: exact.title,
			matchedSourceUrl: exact.url,
		};
	}

	const hostMatch = sources.find((source) => source.host === canonical.host);
	const matchType: WebCitationMatchType = hostMatch ? "host" : "none";
	return {
		url,
		canonicalUrl: canonical.canonicalUrl,
		supported: false,
		matchType,
		matchedSourceId: hostMatch?.id ?? null,
		matchedSourceTitle: hostMatch?.title ?? null,
		matchedSourceUrl: hostMatch?.url ?? null,
	};
}

function auditStatus(params: {
	retrievedSourceCount: number;
	citedUrlCount: number;
	unsupportedCitationCount: number;
}): WebCitationAuditStatus {
	if (params.retrievedSourceCount === 0 && params.citedUrlCount === 0)
		return "none";
	if (params.retrievedSourceCount > 0 && params.citedUrlCount === 0)
		return "missing_citations";
	if (params.unsupportedCitationCount > 0) return "unsupported_citations";
	return "passed";
}

function buildAuditFromParts(params: {
	sources: GroundedWebCitationSource[];
	citationUrls: string[];
	noticeAppended?: boolean;
}): WebCitationAudit | null {
	const { sources, citationUrls } = params;
	if (sources.length === 0 && citationUrls.length === 0) {
		return null;
	}

	const citations = citationUrls
		.map((url) => matchCitation(url, sources))
		.filter((citation): citation is WebCitationAuditCitation =>
			Boolean(citation),
		);
	const supportedCitationCount = citations.filter(
		(citation) => citation.supported,
	).length;
	const unsupportedCitationCount = citations.length - supportedCitationCount;

	return {
		status: auditStatus({
			retrievedSourceCount: sources.length,
			citedUrlCount: citations.length,
			unsupportedCitationCount,
		}),
		retrievedSourceCount: sources.length,
		citedUrlCount: citations.length,
		supportedCitationCount,
		unsupportedCitationCount,
		noticeAppended: params.noticeAppended || undefined,
		citations,
	};
}

export function buildWebCitationAudit(params: {
	assistantResponse: string;
	toolCalls?: ToolCallEntry[];
}): WebCitationAudit | null {
	const toolCalls = params.toolCalls ?? [];
	return buildAuditFromParts({
		sources: extractGroundedWebCitationSources(toolCalls),
		citationUrls: extractAssistantWebCitationUrls(params.assistantResponse),
	});
}

function buildQualityNotice(params: {
	audit: WebCitationAudit;
	sources: GroundedWebCitationSource[];
}): string | null {
	if (
		params.audit.status !== "missing_citations" &&
		params.audit.status !== "unsupported_citations"
	) {
		return null;
	}

	if (params.sources.length === 0) {
		return "Source check: I attempted web research, but the tool returned no retrievable sources. Any links in the generated answer were not verified by the web research tool, so I cannot treat them as source-backed citations.";
	}

	if (params.audit.status === "missing_citations") {
		return "Source check: I used web research for this answer, but the generated text did not include source links.";
	}

	return "Source check: One or more links in the generated answer were not returned by the web research tool. Treat unsupported links cautiously.";
}

function hasDoneWebGroundingToolCall(toolCalls: ToolCallEntry[]): boolean {
	return toolCalls.some(
		(tool) =>
			tool.status === "done" &&
			(tool.name === "research_web" || tool.name === "fetch_url"),
	);
}

export function applyWebCitationQualityGate(params: {
	assistantResponse: string;
	toolCalls?: ToolCallEntry[];
	// The user's own message this turn (upstream/normalized text, not the
	// assistant's). Any URL pasted here is exempt from auto-repair below —
	// the assistant is allowed to keep echoing/linking back to a URL the
	// user themselves supplied, even though it isn't a retrieved source.
	userMessage?: string;
	maxSources?: number;
}): WebCitationQualityGateResult {
	const toolCalls = params.toolCalls ?? [];
	const sources = extractGroundedWebCitationSources(toolCalls);

	// Only auto-repair when a web-grounding tool actually ran this turn —
	// otherwise `sources` is trivially empty and every ordinary markdown
	// link in the response (which has nothing to do with web citations)
	// would look "unsupported" and get stripped.
	const repairResult = hasDoneWebGroundingToolCall(toolCalls)
		? repairAssistantWebCitations({
				assistantResponse: params.assistantResponse,
				sources,
				userPastedCanonicalUrls: collectCanonicalUrls(params.userMessage ?? ""),
			})
		: null;
	const repairedResponse = repairResult?.response ?? params.assistantResponse;
	const repair: WebCitationRepairSummary | null = repairResult
		? {
				cited: repairResult.cited,
				verified: repairResult.verified,
				repaired: repairResult.repaired,
				stripped: repairResult.stripped,
			}
		: null;
	if (repair && (repair.repaired > 0 || repair.stripped > 0)) {
		console.info("[WEB_CITATION_AUDIT] Auto-repaired unsupported citations", {
			cited: repair.cited,
			verified: repair.verified,
			repaired: repair.repaired,
			stripped: repair.stripped,
		});
	}

	const citationUrls = extractAssistantWebCitationUrls(repairedResponse);
	const audit = buildAuditFromParts({ sources, citationUrls });
	const unchanged = {
		response: repairedResponse,
		audit,
		appendedNotice: null,
		repair,
	};

	if (!audit) return unchanged;

	const appendedNotice = buildQualityNotice({
		audit,
		sources,
	});
	if (!appendedNotice) return unchanged;

	// The repaired response IS the user-visible text going forward — only the
	// (structured, never baked into prose) quality notice is withheld from
	// user-visible text. The audit data is stored separately via
	// persistAssistantEvidence in finalize.ts.
	return {
		response: repairedResponse,
		audit: { ...audit, noticeAppended: false },
		appendedNotice,
		repair,
	};
}

// Relocated out of the former src/lib/types.ts god-module
// (architecture-deepening T1); these types carry no behavior change, only
// a new home next to the web-citation-audit service that owns them.

export type WebCitationAuditStatus =
	| "none"
	| "passed"
	| "missing_citations"
	| "unsupported_citations";

export type WebCitationMatchType = "exact" | "host" | "none";

export interface WebCitationAuditCitation {
	url: string;
	canonicalUrl: string;
	supported: boolean;
	matchType: WebCitationMatchType;
	matchedSourceId?: string | null;
	matchedSourceTitle?: string | null;
	matchedSourceUrl?: string | null;
}

export interface WebCitationAudit {
	status: WebCitationAuditStatus;
	retrievedSourceCount: number;
	citedUrlCount: number;
	supportedCitationCount: number;
	unsupportedCitationCount: number;
	noticeAppended?: boolean;
	citations: WebCitationAuditCitation[];
}
