import type {
	ToolCallEntry,
	WebCitationAudit,
	WebCitationAuditCitation,
	WebCitationAuditStatus,
	WebCitationMatchType,
} from "$lib/types";
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
};

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

function appendNotice(response: string, notice: string): string {
	const trimmedResponse = response.trimEnd();
	return `${trimmedResponse}\n\n${notice}`;
}

export function applyWebCitationQualityGate(params: {
	assistantResponse: string;
	toolCalls?: ToolCallEntry[];
	maxSources?: number;
}): WebCitationQualityGateResult {
	const toolCalls = params.toolCalls ?? [];
	const sources = extractGroundedWebCitationSources(toolCalls);
	const citationUrls = extractAssistantWebCitationUrls(
		params.assistantResponse,
	);
	const audit = buildAuditFromParts({ sources, citationUrls });
	const unchanged = {
		response: params.assistantResponse,
		audit,
		appendedNotice: null,
	};

	if (!audit) return unchanged;

	const appendedNotice = buildQualityNotice({
		audit,
		sources,
	});
	if (!appendedNotice) return unchanged;

	return {
		response: appendNotice(params.assistantResponse, appendedNotice),
		audit: { ...audit, noticeAppended: true },
		appendedNotice,
	};
}
