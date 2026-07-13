// Build the grounding context block fed to DeepSeek V4 Flash, from either our
// pipeline's ResearchResult or Parallel's results. Both go into an IDENTICAL
// system prompt (see runner) so only the retrieved content differs.

import type { ResearchResult } from "../../../src/lib/server/services/web-research";
import type { ParallelCall } from "./parallel-client";

const MAX_CONTEXT_CHARS = 24_000;

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n).trimEnd()}...`;
}

// --- Our pipeline ---

export function oursCandidateUrls(result: ResearchResult): string[] {
	return result.sources.map((s) => s.url);
}

export function buildOursContext(result: ResearchResult): string {
	const brief = result.answerBrief?.markdown?.trim() ?? "";
	if (brief) return truncate(brief, MAX_CONTEXT_CHARS);
	// Fallback (e.g. quick mode with no fetched evidence): list sources + snippets.
	const lines = result.sources.slice(0, 8).map((s, i) => {
		const body =
			s.snippet?.trim() ||
			s.highlights?.[0]?.trim() ||
			s.text?.slice(0, 400)?.trim() ||
			"(no snippet)";
		return `[${i + 1}] ${s.title}\n${s.url}\n${body}`;
	});
	return truncate(
		lines.length ? lines.join("\n\n") : "(no web results returned)",
		MAX_CONTEXT_CHARS,
	);
}

// --- Parallel ---

export function parallelCandidateUrls(call: ParallelCall): string[] {
	return call.results.map((r) => r.url);
}

export function buildParallelContext(call: ParallelCall): string {
	if (!call.results.length) return "(no web results returned)";
	const lines = call.results.slice(0, 10).map((r, i) => {
		const excerpt = (r.excerpts || []).join("\n").trim() || "(no excerpt)";
		const date = r.publish_date ? ` (published ${r.publish_date})` : "";
		return `[${i + 1}] ${r.title}${date}\n${r.url}\n${excerpt}`;
	});
	return truncate(lines.join("\n\n"), MAX_CONTEXT_CHARS);
}
