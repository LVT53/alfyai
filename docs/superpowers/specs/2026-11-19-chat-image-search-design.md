# Web images in chat

## Work list

- [x] Establish the production baseline and confirm the budget. [Research and counts](../../research/2026-11-19-parallel-image-search.md)
- [x] **Switch chat image search to Parallel Fast.** Implemented locally. The provider client, safe previews, historical Brave rendering and shared billing are wired into Normal Chat.
- [x] Improve when chat chooses a picture. Normal Chat now uses references for recognition, comparison and steps that depend on matching a visible feature. The [bilingual evaluation](../../research/2026-11-19-parallel-image-search.md#normal-chat-picture-decisions) covers equivalent questions where pictures help and where words suffice.
- [ ] Measure the outcome from selection to display. Distinguish attempted searches, provider failures, usable candidates, pictures included in a reply and previews that actually loaded. Assess usefulness separately from successful loading.

## First provider comparison

On 19 November 2026, three public keyword queries were sent once to each provider with five results requested. Parallel explicitly used Fast, with no visual objective. Each of its 12 results had both an image URL and a source-page URL. All six requests succeeded. Total list cost was $0.003 for Parallel and $0.015 for Brave. These were direct provider requests outside chat analytics.

| Query | Parallel results / seconds | Brave results / seconds | What the first three titles told us |
| --- | ---: | ---: | --- |
| USB mini B vs micro B plug side by side | 5 / 1.26 | 5 / 1.04 | Two Parallel titles explicitly described labeled comparisons. Two Brave titles were generic image placeholders. |
| budapesti Nagyvásárcsarnok főbejárat Fővám tér | 3 / 1.28 | 5 / 0.96 | Parallel found the market, including a historical view. None of the three titles established a present-day entrance view. Brave's three titles were empty. |
| feketerigó hím tojó egymás mellett | 4 / 1.30 | 5 / 1.03 | Both found blackbird-related results. No title among the first three for either provider established a male and female together. |

This sample verifies endpoint access, response fields and a plausible latency for chat. The follow-up checked actual pixels for all three subjects and compared English-only, Hungarian-only and combined keywords with matched objectives. [Visual verification](../../research/2026-11-19-parallel-image-search.md#visual-verification-and-query-language)

## Provider switch and acceptance

1. Extend the existing Parallel client with image search. Use its runtime key, base URL, cancellation and error handling. Explicitly select Fast and request five results. Existing chat calls with a single query must continue to work. Trim whitespace and take up to 200 Unicode code points for the keyword query. Preserve the full search intent of a longer input in the optional objective, up to its documented limit. Cover a long Hungarian query in a regression test. Keep the complete publisher image URL and source page as distinct fields. Treat fewer than five results as normal. [Parallel request fields](https://docs.parallel.ai/image-search/best-practices) · [Response example](https://docs.parallel.ai/image-search/image-search-quickstart)
2. Deliver previews through the authenticated same-origin route. Use the exact image URL returned by the tool for that user, preserve signed queries, and keep model text and tool inputs outside that authorization. Reuse the existing guarded outbound fetch, enforce bounded raster decoding and resizing, and retain a source link when a preview fails. Apply the same rules to the expanded tool row, inline Markdown and reopened conversations. Preserve legacy Brave thumbnails. [Source provenance rules](../../../src/lib/server/services/url-provenance/AGENTS.md)
3. Count one successful Fast request, including a valid empty result, against the shared allowance. Include images in the monthly admin totals and English/Hungarian breakdown. Preview loads incur no search charge. Browser load measurement belongs to the later measurement item. Diagnostics should reflect the Parallel configuration without spending an image request on a health check.
4. Verify cancellation, empty/error outcomes, exact-URL authorization and cross-user isolation, legacy history, reload, and the allowance boundary with all three Parallel event types. Verify visible previews in the browser and run the repository gate with the source-provenance and settings coverage. The current provider sample establishes no application test result.


## Local application verification

A signed-in Chromium session opened and reloaded a synthetic conversation containing real publisher images of the connectors, the market and a blackbird, plus a Brave thumbnail saved in the historical tool format. All four decoded at 500 px wide in both passes, entirely through the app's origin.

In a separate new chat turn, a simulated chat model requested the market with Hungarian and English keywords. A local provider fixture replayed a recorded Parallel response. The normal chat path issued one Fast request, displayed the real publisher image through the thumbnail route, and wrote one image usage event fully covered by the shared allowance. Reopening the chat displayed the same image and left the provider and usage counters at one. This exercised the search-to-preview and billing paths independently of a live model's choice of when to search.
