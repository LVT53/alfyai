# Parallel Image Search for AlfyAI

Provider documentation checked on 19 November 2026.

## How a chat search would work

AlfyAI can send one JSON request to `POST https://api.parallel.ai/v1/images/search` using its Parallel API key in the `x-api-key` header. The required `search_queries` list accepts one to three short keyword queries. An optional `objective` describes what the image should actually show, such as a landmark from a particular angle. An optional country code can localize the search. Results default to ten, and `advanced_settings.max_results` can select one to twenty. [Quickstart](https://docs.parallel.ai/image-search/image-search-quickstart) · [Request fields](https://docs.parallel.ai/image-search/best-practices)

Each result supplies a title, the direct image address, its source page and dimensions. The source page gives chat a citation target. AlfyAI currently requests five Brave results and displays previews through its own route, which accepts only Brave-hosted thumbnails previously returned to that user. Parallel’s documented response supplies a publisher image address without a hosted thumbnail field. A switch needs a way to show previews that preserves this privacy boundary. [Parallel response schema](https://docs.parallel.ai/api-reference/search/image-search) · [AlfyAI image search and thumbnail handling](../../src/lib/server/services/image-search.ts)

## Prices and monthly credit

| Image search | Price per 1,000 requests | Typical provider latency |
| --- | ---: | ---: |
| Parallel Fast | $1 | ~1 second |
| Parallel Advanced (default) | $5 | ~3 seconds |
| Brave Search plan | $5 | — |

Parallel charges once per image search, including up to twenty results. Selecting five results to match AlfyAI costs the same as requesting twenty. Fast must be selected explicitly. Parallel positions Advanced for more exacting image selection. Relative relevance on AlfyAI’s English and Hungarian queries remains unmeasured. [Parallel pricing](https://docs.parallel.ai/getting-started/pricing) · [Parallel modes](https://docs.parallel.ai/image-search/modes) · [Brave Search plan](https://brave.com/search/api/#plans)

Parallel gives each eligible organization with a card on file $5 monthly across its APIs. Unused credit expires at month-end and additional use is billed. Every $1 of credit left after web search, extraction and other usage buys 1,000 Fast or 200 Advanced image searches. Brave advertises its own monthly Search credit, so moving a covered Brave request consumes some of the shared Parallel allowance. [Parallel monthly credit terms](https://parallel.ai/blog/free-tier-parallel) · [Brave Search plan](https://brave.com/search/api/#plans)

## Production budget

Read-only snapshot of AlfyAI production on 19 November 2026 at 18:27 UTC. Web calls are the admin analytics events grouped by billing month. Image counts are completed `image_search` entries in retained assistant messages, counted by call rather than message. October's 19 distinct calls occurred in eight replies. The estimates assume one image API request per recorded image call and use the app's $0.001 list-cost estimate per Turbo or Extract event. [AlfyAI analytics calculation](../../src/lib/server/services/analytics.ts) · [Image tool execution](../../src/lib/server/services/normal-chat-tools/index.ts)

| Month | Turbo | Extract | Image calls | Web list cost | With Fast images | With Advanced images |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| July | 163 | 49 | 0 | $0.212 | $0.212 | $0.212 |
| August | 132 | 17 | 0 | $0.149 | $0.149 | $0.149 |
| September | 271 | 199 | 1 | $0.470 | $0.471 | $0.475 |
| October | 672 | 545 | 19 | $1.217 | $1.236 | $1.312 |
| November through the 19th | 287 | 235 | 0 | $0.522 | $0.522 | $0.522 |

At October's web volume, the remaining $3.783 covers 3,783 Fast or 756 Advanced image requests for the month. Even 100 Fast image searches per day for 31 days would put the combined estimate at $4.317. Production booked $0 for November's Parallel events after allowance. These are AlfyAI's recorded calls and estimated list costs. Deleted chats and provider activity outside production can cause differences from the organization's actual bill.

## Why image search rarely appears in chat

The owner confirmed Parallel as the next image-search provider on 19 November. A read-only follow-up on the same production database counted tool selections and outcomes among retained, non-imported assistant replies. October had eight image-search replies out of 537, alongside 265 replies with web research and 26 with image generation. November through the 19th had zero out of 298, alongside 126 with web research and 18 with generation. These categories can overlap.

October's 19 image calls included ten that returned candidates and nine that recorded errors. All nine errors were on 28 or 31 October, and five explicitly reported HTTP 402. Four of the eight replies contained Markdown image syntax, which does not establish that the browser displayed a picture. No such reply also called `produce_file` or `create_artifact`. The monthly budget table conservatively prices every recorded attempt.

Normal Chat offers image search even when picture generation is switched off. The tool description tells the model how to find and embed pictures but sends anything geographic to maps. The built-in system prompt explicitly prioritizes image search for real pictures in polished reports and PDFs. For ordinary questions it permits an immediate answer when the model has enough evidence. Web research also has a user-initiated forced path. The evidence points to few cues to choose a picture for a normal answer, especially for a landmark or place. The counts alone cannot establish how often an image would have helped. [Tool selection](../../src/lib/server/services/chat-turn/normal-chat-tool-gating.ts) · [Image tool description](../../src/lib/server/services/normal-chat-tools/index.ts) · [Built-in prompt](../../src/lib/server/prompts.ts) · [Forced web search](../../src/lib/server/services/normal-chat-model/index.ts)

Commit `e4459952c` on 23 October removed a real Brave image query from the five-minute health check. Its commit message records quota exhaustion, 429s and a degraded status shown to the model. Production currently has a populated Brave key and the health registry checks its presence. That check cannot validate provider access. The historical probe explains additional non-chat traffic and earlier reliability problems. The October errors in retained replies occurred after the fix was authored, and November's retained replies contain no image call that could report a provider error. [Health registry](../../src/lib/server/services/tool-health/registry.ts)

## Visual verification and query language

On 19 November we repeated the three public queries and inspected decoded thumbnails. The ten Parallel Fast requests included Hungarian-only, English-only and combined queries with the same visual objective, plus a follow-up search for a female blackbird. Three Brave requests repeated the original keywords. Across both providers, 50 of 56 result slots yielded a viewable thumbnail under the bounded public fetch. These counts include images appearing in more than one query. The additional requests cost $0.025 at list price.

| Example | What the pictures showed |
| --- | --- |
| Mini-B and Micro-B plugs | Parallel's second result was a labeled comparison and its first result showed only one connector. Brave also returned a useful labeled side-by-side photo. The first image and the most useful image differed on both providers. |
| Great Market Hall entrance | Hungarian keywords alone returned historical interiors, a metro image and a roof detail. Adding a visual objective returned the recognizable front façade with the same Hungarian keywords. English and combined terms with that objective also returned the façade. The pictures establish the appearance of the building, not the date the photograph was taken. Brave's Hungarian results included useful views even though their titles were empty. |
| Male and female common blackbird | None of the viewable Parallel images established a clear adult male/female pair together. English-only and mixed queries returned single males or a bird attending a nest. The unqualified Hungarian results included an adult-looking black bird beside two brown birds whose age and sex the image did not establish. Brave returned brown and black birds in separate photos. |

Keep local names and accents in the keywords. For objects and identification tasks, add a common international or scientific term when it makes the search more precise. State what must be visible in the objective. Related terms share one Fast request. Treat candidate titles as clues and verify the requested distinction before using an image as evidence. A narrow sample cannot rank languages for other subjects. [Parallel query guidance](https://docs.parallel.ai/image-search/best-practices)
