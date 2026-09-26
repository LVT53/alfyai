// research_web's own module (Feature 2 · Artifacts, decisions.md ruling 57).
// A pure move out of `normal-chat-tools/index.ts`: the App verifier
// (`artifacts/app/verify.ts`) needed this ONE tool without pulling in the
// whole `createNormalChatTools` factory, which — through
// `artifact-tools/create.ts`'s per-kind dispatch — closed a cycle back to
// the App's own generation path (`artifacts/app/create.ts` -> ... ->
// `generate-and-verify.ts` -> `verify.ts` -> `normal-chat-tools/index.ts` ->
// `artifact-tools/create.ts` -> ...; Fallow 4 -> 5). Used by BOTH `index.ts`
// (the chat turn's own tool set) and `verify.ts` (the fact-verification
// pass) — the exact same tool, unchanged: the frozen catalogue snapshot
// tests (`index.test.ts`) prove it.
import { type ToolExecutionOptions, tool } from "ai";
import type { z } from "zod";
import { getConfig } from "$lib/server/config-store";
import { recordParallelUsage } from "$lib/server/services/analytics";
import type { ToolEvidenceCandidate } from "$lib/server/services/message-evidence";
import { fetchUrlViaParallel } from "$lib/server/services/parallel-search/fetch-url";
import { researchWebViaParallel } from "$lib/server/services/parallel-search/research";
import type { GroundedWebResult } from "$lib/server/services/parallel-search/types";
import {
	buildGroundedWebModelPayload,
	buildGroundedWebPageFromFetch,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
	type GroundedWebPage,
	selectTopDistinctSourceUrls,
	summarizeGroundedWebResult,
} from "$lib/server/services/web-grounding";
import { resolveFetchContentCharCap } from "./fetch-url";
import { resolveModelContextTokens } from "./model-context-tokens";
import {
	researchWebInputSchema,
	sanitizeResearchWebInput,
} from "./research-web";
// asExecutableTool lives in ./shared (moved there alongside this module,
// also ruling 57): a pure type-narrowing cast with no runtime behavior,
// needed by every tool in index.ts AND by this module, so it could not
// stay a private helper of index.ts once this module had to stop
// importing index.ts.
import {
	asExecutableTool,
	executeToolWithEnvelope,
	modelSafeToolError,
	TOOL_TIMEOUTS_MS,
	type ToolCallRecorder,
} from "./shared";
import {
	buildToolResultCacheKey,
	getCachedToolResult,
	setCachedToolResult,
} from "./tool-result-cache";

// Per-result excerpt budget (chars) requested from Parallel for
// research_web. Moved verbatim from index.ts alongside the tool that is
// its only reader.
const RESEARCH_WEB_EXCERPT_MAX_CHARS = 2000;

/**
 * research_web's own EN/HU description + errorPrefix — moved verbatim out
 * of index.ts's family-wide `TOOL_I18N` (ruling 43/5a) so this module
 * needs no import from index.ts at all. index.ts imports these BACK in to
 * populate `TOOL_I18N.en.research_web` / `.hu.research_web`, so the
 * assembled catalogue text is byte-identical to before (the frozen
 * snapshot tests assert this).
 */
export const RESEARCH_WEB_I18N: Record<
	"en" | "hu",
	{ description: string; errorPrefix: string }
> = {
	en: {
		description:
			'Search the web for current or verifiable facts: prices, specs, news, policies, comparisons. Call with {"query": "the exact research question"}; optionally `objective` and 2-3 short keyword `searchQueries` (no site: operators, no years unless historical). Set `readPages` to 1-2 when the answer needs page-level detail (an exact price, a spec, official documentation, one named article), so it finishes here rather than in a separate fetch_url step; else 0. Do not use it for a URL the user already gave (fetch_url), for distance, route or travel time (map_route), for pictures to show (image_search), or when this turn already has web research results. Returns `evidence` snippets and an `answerBriefMarkdown`, plus `pages` (url, title, contentMarkdown) when `readPages` was set; prefer primary sources when they conflict.',
		errorPrefix: "Web research failed",
	},
	hu: {
		description:
			'Keresés az interneten aktuális vagy ellenőrizhető tényekért: árak, specifikációk, hírek, szabályzatok, összehasonlítások. Hívd így: {"query": "a pontos kutatási kérdés"}; opcionálisan `objective` és 2-3 rövid kulcsszavas `searchQueries` (site: operátor nélkül, évszám nélkül, hacsak nem történeti a kérdés). A `readPages`-t állítsd 1-2-re, ha a válaszhoz oldal-szintű részlet kell (pontos ár, specifikáció, hivatalos dokumentáció, egy megnevezett cikk), így a kutatás itt fejeződik be egy külön fetch_url lépés helyett; egyébként 0. Ne használd olyan URL-hez, amelyet a felhasználó már megadott (fetch_url), távolsághoz, útvonalhoz vagy menetidőhöz (map_route), megmutatandó képekhez (image_search), és akkor sem, ha ebben a körben már vannak webes kutatási eredmények. `evidence` részleteket és `answerBriefMarkdown` összefoglalót ad vissza, valamint `pages` tömböt (url, title, contentMarkdown), ha a `readPages` be volt állítva; ellentmondás esetén az elsődleges forrást részesítsd előnyben.',
		errorPrefix: "A webes kutatás sikertelen",
	},
};

export interface CreateResearchWebToolParams {
	userId: string;
	conversationId: string;
	turnId: string;
	modelId?: string;
	language: "en" | "hu";
	recorder: ToolCallRecorder;
}

/**
 * The research_web tool, unchanged from what index.ts built inline before
 * ruling 57 — only its home moved. Called by index.ts's
 * `createNormalChatTools` (the chat turn's own web-research tool) and by
 * `artifacts/app/verify.ts` (the App's fact-verification pass, its ONE
 * place a tool is allowed — spec §2.11 forbids the generator itself from
 * reaching for anything).
 */
export function createResearchWebTool(params: CreateResearchWebToolParams) {
	// `ctx` is just `params` under its old name: the extracted tool body
	// below reads ctx.userId/ctx.conversationId/ctx.turnId/ctx.modelId
	// exactly as it did inside createNormalChatTools's own closure, so the
	// move needed no substitution inside the body itself.
	const ctx = params;
	const { recorder } = params;
	const i18n = { research_web: RESEARCH_WEB_I18N[params.language] };

	return asExecutableTool(
		tool({
			description: i18n.research_web.description,
			inputSchema: researchWebInputSchema,
			execute: async (
				input: z.infer<typeof researchWebInputSchema>,
				options: ToolExecutionOptions,
			) => {
				const safeInput = sanitizeResearchWebInput(input);
				// readPages is consumed here, not forwarded to Parallel search —
				// strip it before building the search request.
				const { readPages, ...researchRequest } = safeInput;
				return executeToolWithEnvelope({
					toolName: "research_web",
					timeoutMs: TOOL_TIMEOUTS_MS.research_web,
					options,
					recorder,
					run: async (abortSignal) => {
						const { parallelApiKey, parallelBaseUrl } = getConfig();
						const parallelDeps = {
							fetch,
							config: { parallelApiKey, parallelBaseUrl },
							signal: abortSignal,
						};
						// Per-conversation cache: an identical query/objective/searchQueries
						// (and readPages) this conversation already paid Parallel for is
						// served from memory, pages included, instead of paying and waiting
						// twice (see tool-result-cache.ts).
						type ResearchCacheEntry = {
							result: GroundedWebResult;
							pages: GroundedWebPage[];
							pageCandidates: ToolEvidenceCandidate[];
						};
						const cacheKey = buildToolResultCacheKey({
							conversationId: ctx.conversationId,
							toolName: "research_web",
							input: safeInput,
						});
						const cachedEntry =
							getCachedToolResult<ResearchCacheEntry>(cacheKey);
						const cached = Boolean(cachedEntry);
						let result: GroundedWebResult;
						let pages: GroundedWebPage[] = [];
						let pageCandidates: ToolEvidenceCandidate[] = [];
						if (cachedEntry) {
							({ result, pages, pageCandidates } = cachedEntry);
						} else {
							result = await researchWebViaParallel(
								researchRequest,
								parallelDeps,
								{
									sessionId: ctx.turnId,
									excerptMaxChars: RESEARCH_WEB_EXCERPT_MAX_CHARS,
								},
							);
							// Fire-and-forget Parallel Turbo usage tracking; never block or
							// alter the tool result on analytics failure. Skipped entirely on
							// a cache hit — a repeated identical call must not bill twice.
							void recordParallelUsage({
								userId: ctx.userId,
								conversationId: ctx.conversationId,
								tool: "research_web",
							}).catch(() => {});
							// readPages: fetch the top N distinct result URLs in the
							// SAME call, so a question needing page-level detail (an
							// exact price, a spec, official documentation) doesn't need
							// a separate fetch_url step. Best-effort: any failure here
							// (a single page, or the whole batch) is swallowed — the
							// search result already succeeded and stands on its own.
							if (readPages && readPages > 0) {
								const topUrls = selectTopDistinctSourceUrls(
									result.sources,
									readPages,
								);
								if (topUrls.length > 0) {
									const contextTokens = await resolveModelContextTokens(
										ctx.modelId,
									).catch(() => null);
									// Divide the shared char-cap ceiling across the pages
									// being read, so N pages together never exceed the
									// same total budget a single fetch_url call would get.
									const perPageCap = Math.max(
										1,
										Math.floor(
											resolveFetchContentCharCap(contextTokens) /
												topUrls.length,
										),
									);
									const settled = await Promise.allSettled(
										topUrls.map((url) =>
											fetchUrlViaParallel({ urls: [url] }, parallelDeps, {
												sessionId: ctx.turnId,
												maxCharsTotal: perPageCap,
											}),
										),
									);
									for (const outcome of settled) {
										if (outcome.status !== "fulfilled") continue;
										const pageResult = outcome.value;
										const page = buildGroundedWebPageFromFetch(pageResult);
										if (!page) continue;
										pages.push(page);
										pageCandidates.push(
											...createGroundedWebCandidates(pageResult),
										);
										// Same usage-tracking shape as fetch_url's own
										// call: fire-and-forget, never blocks the result.
										void recordParallelUsage({
											userId: ctx.userId,
											conversationId: ctx.conversationId,
											tool: "fetch_url",
										}).catch(() => {});
									}
								}
							}

							// Same discipline as fetch_url below: a search that came
							// back with no sources found nothing and is worth
							// re-running, so it is never pinned for the TTL.
							if (result.sources.length > 0) {
								setCachedToolResult(cacheKey, {
									result,
									pages,
									pageCandidates,
								});
							}
						}

						const modelPayload = {
							...buildGroundedWebModelPayload(result),
							...(pages.length > 0 ? { pages } : {}),
							...(cached ? { cached: true as const } : {}),
						};
						const candidates = [
							...createGroundedWebCandidates(result),
							...pageCandidates,
						];
						return {
							modelPayload,
							entry: {
								callId: options.toolCallId,
								name: "research_web",
								input: safeInput,
								status: "done",
								outputSummary: summarizeGroundedWebResult(result),
								sourceType: "web",
								candidates,
								metadata: {
									...createGroundedWebMetadata(result),
									...(cached ? { cached: true as const } : {}),
								},
							},
						};
					},
					onError: (error) => {
						const message = modelSafeToolError(
							error,
							i18n.research_web.errorPrefix,
						);
						const modelPayload = {
							success: false as const,
							error: message,
						};
						return {
							modelPayload,
							entry: {
								callId: options.toolCallId,
								name: "research_web",
								input: safeInput,
								status: "done",
								outputSummary: modelPayload.error,
								sourceType: "web",
								candidates: [],
								metadata: {
									ok: false,
									evidenceReady: false,
									error: modelPayload.error,
								},
							},
						};
					},
				});
			},
		}),
	);
}
