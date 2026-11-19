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

## Normal Chat picture decisions

We ran paired English and Hungarian questions through a signed-in Chromium session using the built-in AlfyAI prompt and the hosted Flash Next model. Each started a new local Normal Chat conversation with normal tool choice. Image search replayed recorded Parallel Fast results for the subject so both languages had the same candidates. The app fetched the real publisher previews. We checked the pixels in the outbound model request, the image selected in the answer, and whether Chromium decoded it. The questions never explicitly requested a picture. [Evaluation prompts](../../tests/fixtures/ai/image-search-intents.ts)

The visual questions asked how to distinguish Mini-B and Micro-B plugs, recognize the Great Market Hall entrance from Fővám tér, and identify male and female common blackbirds. The matching text controls asked what USB stands for, how to translate Nagyvásárcsarnok, and the blackbird's scientific name. In two additional turns, the search supplied a market façade with a misleading connector-comparison title. Flash Next received the façade pixels and withheld the picture in both languages.

In all six recognition and comparison turns, Flash Next searched, inspected the pixels and embedded a matching reference. All ten inline pictures decoded in Chromium, and every embedded URL matched a result ID whose pixels the model received. In the blackbird replies the photos showed the male, while the answers described the female in words. All six text controls answered without an image search. The English bird question took three image searches and the Hungarian one took two, so a visual turn can use more than one Fast request.

A deterministic integration test also checks the JPEG pixel content on both the ordinary send path and the streaming path. It covers a publisher failure, a text-only model, and a seeing model that times out after receiving the picture and hands the answer to a text-only replacement. [Wire-level regression tests](../../tests/integration/image-search-inspection.test.ts)

## Monthly chat picture analytics

Open **Settings → Administration → System analytics → Parallel API**. The chat picture panel opens on the current UTC month. Use the month navigation to inspect an earlier period.

| Measure | What counts |
| --- | --- |
| Search frequency | Saved, non-incognito Normal Chat turns with at least one picture search, divided by eligible turns during the measured period. Resuming the same turn keeps its identity. |
| Additional searches | Each search after the first in a turn, including a second attempt after a failure. The panel counts failed requests, successful empty searches and returned candidates separately. |
| Pictures in replies | Each distinct search-result image included inline in an assistant reply. The same image appearing twice in that reply counts once. Tool-row thumbnails and pictures inspected by the model do not add to this count. |
| Browser outcomes | A successful browser load confirms a picture loaded. A subsequent success can resolve an earlier failure. An image with no browser report remains unknown. Reopening the same reply can update an outcome without adding a picture. Usefulness requires a separate assessment. |
| Cost | The app's billing ledger records one Fast request at $0.001 for a successful search, including an empty result. Preview loads and inspections add no Fast request. The additional-search row is part of the picture-search total. Each row shows list price, credit consumed and the amount booked after credit. The account inclusion settings apply to chat figures. All accounts' Parallel calls share the budget. |

Detailed search and display measurement starts when the database migration runs. The panel identifies its first partial month and shows only recorded billing for earlier months. Historical Brave activity and missing browser reports cannot establish how many pictures loaded.

In a Chromium validation with three synthetic local chats, Flash Next chose its own tools and image search replayed recorded Parallel Fast candidates. The dashboard increased by three turns, two of which searched for pictures. Three searches, including one follow-up, returned 13 candidates. The replies included two distinct pictures, and Chromium confirmed both loaded. The local ledger showed $0.003 in image searches at list price, including $0.001 for the follow-up, with $0 charged after credit. This test generated no production usage.

A read-only production snapshot on **19 November 2026 at 19:24 UTC** found **287 Turbo web searches, 235 Extract calls and 0 Parallel image searches** for November to date. At list price the app had used **$0.522** of its shared **$5** monthly credit, with **$4.478 remaining** and **$0 booked after credit**. That leaves room for 4,478 Fast image searches if other Parallel usage stops at the snapshot total. Each later web search or extraction also consumes credit.
