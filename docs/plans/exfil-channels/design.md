# Exfiltration channels: approved design and agents' brief

Status: design APPROVED by the owner on 2026-10-12; the owner skipped a separate spec review, so this file is the
brief the implementing agents work from. Prerequisite for Feature 3 (Computers, ADR-0067). Branch
`fix/exfil-channels`, cut from `dev` at `85e806168`. Line numbers below are from that commit; find code by its
symbol, not by the number.

## The rule

An address the browser or the server requests **without a click** must come from the user's own messages or
from a tool's result, never from the model's words. Links stay links (a click is the reader's choice). The
model is uncensored and may be prompt-injected by a page, an email or a file it reads, so nothing here may rely on
the model behaving. Model-written markup must also stay inert in-flow content: no overlays, no forms.

## Owner decisions

1. This file is the brief; no separate spec or plan review.
2. image_search pictures load as **Brave's 500 px thumbnails through a same-origin route**; CSP `img-src` becomes
   `'self' data: blob:`.
3. **App frame navigation is in this patch**: an always-enforced `frame-src` (even when CSP_MODE is
   `report-only`) and a test that an App navigating out makes no request.
4. **Also in this patch** (owner, after the design): SSRF hardening of the server's own fetchers (they check IP
   literals, never the resolved address) and inert model markup (no `position:fixed` overlays, no forms).

## Channel inventory

Browser fetches from model-written markup:
- Markdown images: `renderer.image` in `src/lib/services/markdown.ts` emits any `src`.
- Raw HTML in a reply: there is no `renderer.html`, so model HTML reaches `sanitizeHtml`
  (`src/lib/utils/html-sanitizer.ts`), whose DOMPurify html profile keeps `img src/srcset`, `picture>source
  srcset`, `video poster/src`, `video>source`, `audio src`, `input type=image src`, `background=` on
  table/td/th. Each fired a request in Chrome 154, mid-stream. `<form action=https://… method=post>` with password
  inputs survives, and so do `position:fixed` overlays (style attributes are allowed on this path, and Tailwind
  utility classes such as `fixed inset-0 z-50` are global in `src/app.css`).
- Every other `renderMarkdown`/`sanitizeHtml` sink: checklist items (`MarkdownRenderer.svelte` → `Checklist`),
  Document History preview (`DocumentVersionPreview.svelte`), `.md` previews (`DocumentPreviewRenderer.svelte`),
  static `.html` previews (`preview-runtime/text/index.ts`, sandboxed iframe without CSP), Mermaid SVG
  (`sanitizeHtml({svg:true})` keeps an HTML-namespace `img src`).
- Source chips: `sourceFaviconUrl` in `markdown.ts` builds `/api/favicon?domain=<any host the model linked>`.
- Tool rows: `getToolWebSources` in `src/lib/utils/tool-activity.ts` falls back to fetch_url's INPUT urls when no
  candidates came back, so `ToolActivityRow.svelte` asks for the favicon of a host the model only asked for, even
  after a refused fetch.
- App artifacts: model JS can navigate its own frame (`location=`, meta refresh, `a.click()`); the App's CSP
  (`sandbox-response.ts`) cannot stop navigation, the page's `frame-src 'self'` is report-only by default, and the
  regex no-navigate audit (`audit.ts`) is evadable (`const w=window; w.location=`, `window["loc"+"ation"]`).
  `<link rel=preconnect>` opened a TCP connection despite the CSP, so a hostname can still leak through DNS.

Server fetches of model-chosen addresses:
- `/api/favicon` (`src/routes/api/favicon/+server.ts`): any host → `https://<host>/favicon.ico`, then
  DuckDuckGo. Behind the session gate already (not in `PUBLIC_PATHS` in `src/hooks.server.ts`).
- Report favicons: `resolveReportFavicons` (`file-production/report-favicons.ts`, called from
  `execution-adapter.ts`) for up to 48 hosts the model wrote into a report's sources.
- fetch_url: any `z.string().url()` (`normal-chat-tools/fetch-url.ts`; handler in `normal-chat-tools/index.ts`)
  goes to Parallel Extract, which fetches it. The rule exists only as prompt prose (`src/lib/server/prompts.ts`).
- produce_file image blocks `{kind:"https"}` (`file-production/source-schema.ts`): the PDF path fetches them
  server-side (`file-production/image-loader.ts`); HTML and Markdown reports embed them as remote `<img>`
  (`renderers/standard-report-html.ts`, `renderers/standard-report-markdown.ts`), also in the downloaded copy.
- SSRF: `validateFaviconDomain` (`src/lib/server/favicon/domain.ts`) and `validateHttpsUrl` in `image-loader.ts`
  check literals only; `https://[::ffff:7f00:1]/`, `[::]`, `100.64.0.0/10`, `*.internal` and any public name that
  resolves to a private address pass.

CSRF: `kit.csrf.trustedOrigins: ['*']` in `svelte.config.js` came from `af1288c73` for an internal OCR multipart
route that `560d0a679` deleted. No legitimate cross-origin form sender exists (OAuth callbacks are GET; connections,
browser push, `/api/chat/files/produce` and the drain read JSON). Callers that post a form type with no `Origin`
(Playwright's request context, scripts) would get a 403 from the restored check: `tests/e2e/home-projects.spec.ts`,
`tests/e2e/project-files.spec.ts`, `tests/e2e/project-file-tool-read-live.spec.ts`,
`tests/e2e/live-evidence-metadata.spec.ts`, `scripts/atlas-eval.ts`, `scripts/verify-live-extraction-types.ts` (all
`text/plain` to `/api/knowledge/upload/raw`). Session cookie: HttpOnly, SameSite=Lax (`services/auth.ts`).

Ruled out (do not change): Tiptap Document (no Image extension), canvas model blocks, canvas-web search (reader's
own query), Atlas page reads (search hits only), map tiles, avatar and campaign assets, connection writes
(confirm-gated), the pasted-URL prefetch (the user's own message), MessageEvidenceDetails and AtlasActivityBody
favicons (result hosts).

Residual, documented and not fixed: the model can still leak a little through WHICH tool-returned address it
embeds or fetches (an attacker page with one link per letter); DNS lookups started by `preconnect` inside an App;
files the model made and the user opens outside the app.

## The shared contract (already on the branch)

`src/lib/shared/url-provenance.ts` (with `url-provenance.test.ts`) is the one vocabulary both sides compare in.
Use it; do not write a second canonicalizer, URL extractor or route-URL builder.

- `provenanceKey(raw)`: comparison form. Host lowercase, punycode, no leading `www.`; port only if not default;
  path and query exactly as `new URL` writes them; scheme and fragment ignored. Null for non-http(s), relative,
  credentials, over 2,000 chars.
- `sourceHostOf(raw)`: the favicon proxy's host (lowercase, no leading `www.`).
- `extractUrls(text, { bareDomains?, limit? })`: absolute addresses in a text (prose punctuation trimmed,
  `&amp;` also read as `&`); bare domains only with `bareDomains` (for the user's own words).
- `extractUrlsFromValue(value, limit?)`: absolute addresses in a JSON-like payload, bounded.
- `toolImages(segments)`: `{ url, thumbnail }` for each image_search result in a message's tool calls (thumbnail
  only when it is a Brave proxy address).
- `toolSourceHosts(segments)`: hosts of every tool result's `candidates[].url`; never a call's input.
- `isBraveThumbnailUrl(raw)`, `BRAVE_THUMBNAIL_HOST`.
- `IMAGE_THUMBNAIL_ROUTE` (`/api/image-search/thumbnail`), `imageThumbnailRouteUrl(thumbnail)`,
  `readImageThumbnailRouteUrl(src)`; `FAVICON_ROUTE`, `faviconRouteUrl(host)`, `readFaviconRouteUrl(src)`.

## Work split: three agents, disjoint files

Each agent works in its own worktree and branch, commits in small focused steps, and touches only the files of
its slice (ask before editing anything else). Run `npm ci` with Node 22 first
(`export PATH=/opt/homebrew/opt/node@22/bin:$PATH`).

### Agent A: client rendering (`fix/exfil-client`, worktree `.claude/worktrees/exfil-a`)

Owns: `src/lib/utils/html-sanitizer.ts`, `src/lib/services/markdown.ts`, `src/lib/utils/markdown-loader.ts`,
`src/lib/components/chat/MarkdownRenderer.svelte`, `src/lib/components/chat/MessageBubble.svelte`,
`src/lib/utils/tool-activity.ts`, `src/lib/components/chat/ToolActivityRow.svelte`, chat i18n strings
(`src/lib/i18n/chat.ts`), their tests, and a new e2e spec `tests/e2e/chat-remote-resources.spec.ts`.

1. **Sanitizer gate.** `sanitizeHtml` removes every attribute that makes the browser fetch (`src` on any element,
   `srcset`, `poster`, `background`, and the `<source>`/`<track>` elements) unless the caller passes a predicate
   that allows that exact address for that tag. Raster `data:image/(png|jpeg|gif|webp|avif)` stays on `<img>`. An
   `<img>` whose `src` is not allowed is removed whole. Keep the Mermaid `svg` path's own rules working (its
   `href` rule) and its tests green; the HTML-namespace `img` escape must be closed too.
2. **Inert markup** for model markdown (a named option `renderMarkdown` always passes): drop `form`, `button`,
   `select`, `option`, `textarea`, `dialog`, and `input` except a disabled checkbox (GFM task list); drop
   `popover`, `popovertarget`, `popovertargetaction`, `autofocus`; keep only the CSS properties Shiki and our own
   markup use in `style` (enumerate them from the code and the tests: colour, background colour, font style and
   weight, text decoration, text align, …), never `position`, `z-index`, `inset`/`top`/`left`/`right`/`bottom`,
   `transform`/`translate`, viewport units; keep only `class` names our renderer emits (find them in
   `markdown.ts`, Shiki's output, marked's task list) so global Tailwind utilities cannot be borrowed. Prove with
   tests that tables, callouts, chips, frontmatter, task lists, details/summary and highlighted code render as
   before.
3. **Chat resource policy.** `RenderMarkdownOptions` gains the message's tool results (`toolImages`,
   `toolSourceHosts` from the shared module). `renderer.image`: a same-origin Immich thumbnail
   (`isPhotoProxyPath`, `src/lib/shared/artifacts/block-urls.ts`) or a raster `data:` URI → `<img>`; an address
   whose `provenanceKey` equals an image_search result's `url` or `thumbnail` → `<img
   src=imageThumbnailRouteUrl(thumbnail)>` (no thumbnail → treated as not allowed); anything else → a visibly
   external link chip (alt text or host, the host shown, `target=_blank rel="noopener noreferrer external"`, a
   localized title saying the image was not loaded), never fetched; a non-http(s) address → its alt text only. The
   sanitizer predicate for chat allows exactly those addresses, so raw HTML gains nothing. Chip favicons only for
   hosts in `toolSourceHosts`; any other chip shows the existing globe fallback immediately, with no `<img>`.
   Default (no tool results passed: previews, history, checklists outside a message) = no remote image at all.
4. **Wiring.** `MessageBubble` derives the policy from `message.thinkingSegments` and passes it to
   `MarkdownRenderer`, which passes it to every `renderMarkdown` call (prose and checklist items) and re-renders
   when it changes. Key the derivation on its content (a stable string), not on array identity, so streaming
   tokens do not rebuild it.
5. **Tool rows.** A source that came from a call's INPUT (the fetch fallback in `getToolWebSources`) is marked
   and shown with the globe fallback, never an `<img>` of `/api/favicon` for that host.
6. **Strings**: every new user-visible string (the blocked-image title and accessible name) in English and
   Hungarian.
7. **Tests**: unit tests for the sanitizer gate, inert markup, the renderer policy, the wiring helper and the
   tool-row change. E2E `tests/e2e/chat-remote-resources.spec.ts` (pattern: `tests/e2e/mermaid-hardening.spec.ts`;
   use `createEmptyConversation`; seed assistant messages with `db.insert(messages)` including `toolCalls` JSON):
   a reply with an injected markdown image, raw `<img>`, `srcset`, `<video poster>`, `background=`, a form, a
   fixed overlay and a chip to an unknown host makes **zero** requests to the stand-in host and no
   `/api/favicon` request for that host, and shows the blocked-image chip; a reply whose image_search tool call
   returned `https://<stand-in>/cat.jpg` with a Brave thumbnail renders exactly one `<img>` whose request goes to
   `/api/image-search/thumbnail?url=…` (fulfil that route with `page.route`, since the server route lives in
   another slice) and nothing to the stand-in host.

### Agent B1: server provenance (`fix/exfil-provenance`, worktree `.claude/worktrees/exfil-b1`)

Owns: a new `src/lib/server/services/url-provenance/` boundary (index facade), `src/routes/api/favicon/+server.ts`,
a new `src/routes/api/image-search/thumbnail/+server.ts`, `src/lib/server/services/image-search.ts`,
`src/lib/server/services/normal-chat-tools/` (`index.ts`, `shared.ts`, `fetch-url.ts`, `image-search.ts`,
`research-web-tool.ts` if needed), `src/lib/server/services/conversation-detail/read-model.ts`,
`src/lib/server/services/messages.ts` (a read helper if needed), `src/lib/server/services/artifacts/canvas-web.ts`,
the Atlas source registration, `src/lib/server/services/file-production/report-favicons.ts` and
`execution-adapter.ts` (only to hand report favicons the user and conversation), and their tests.

1. **Per-user source ledger**, in memory only (never on disk: incognito promises no writes): per user, the hosts
   and the exact Brave thumbnail addresses that tools returned, bounded (LRU per user and overall). Fed by: the
   tool recorder in `createNormalChatTools` (every recorded entry's `candidates[].url` hosts; image_search
   thumbnails), canvas-web search/refresh results, Atlas source registration, and a backfill from stored messages
   when the conversation detail and older pages are read (`toolSourceHosts`/`toolImages` over each message's
   `thinkingSegments`; also any Atlas sources the read model returns). Writes happen synchronously before the
   tool-call event reaches the browser, so a favicon request never races its own entry.
2. **Favicon route**: refuse a host that is not in the user's ledger (globe, `cache-control: no-store`, no
   outbound request, nothing negative-cached); a served icon becomes `private` (the answer now depends on the
   user). Logs carry no host.
3. **Thumbnail route** `GET /api/image-search/thumbnail?url=`: only `isBraveThumbnailUrl` addresses that are in
   the user's ledger; `fetch` with no redirects, a timeout (~8 s), a byte cap (~2 MB), only
   `image/jpeg|png|webp|gif|avif` (never SVG); respond with `x-content-type-options: nosniff`,
   `cache-control: private, max-age=86400`, `content-security-policy: default-src 'none'; sandbox`,
   `cross-origin-resource-policy: same-origin`; anything else is a 404 with no body detail.
4. **image-search.ts**: Brave's thumbnail is `results[].thumbnail.src` (the code reads `thumbnail.url`, so it is
   always missing); `properties.url` is the image file. Keep the payload's field names.
5. **fetch_url provenance** (per turn, built lazily on the first fetch_url call): allowed = `extractUrls` of
   `ctx.requestText` with bare domains (the current user message is NOT persisted until finalize), of this
   conversation's stored user messages (scoped by user), every absolute address in every tool result this turn
   (observe the model payload in `executeToolWithEnvelope`, and the pasted-URL prefetch payload if it reaches the
   model as a tool result), and earlier turns' stored `candidates[].url` and `resultDigest` addresses. Compare by
   `provenanceKey`. Refused addresses never reach Parallel; a call with some allowed fetches those and says how
   many were refused; a call with none returns a model-safe error in the turn's language (English and Hungarian)
   that says the address did not come from the user or a tool result and that research_web finds pages. The
   refused URL stays only in the call's `input`. Logs: counts only.
6. **produce_file images**: the same per-turn provenance before intake; an `https` image block whose address is
   not allowed is left out of the document and the payload carries a warning naming how many were left out.
7. **Report favicons**: `resolveReportFavicons` fetches only hosts in the user's ledger or in the conversation's
   stored tool results (the job can run after a restart, and before finalize persists the current turn).
8. **Tests** for each item, including: the favicon route never calls fetch for an unknown host; the thumbnail
   route refuses a non-Brave or unknown address; fetch_url never calls Parallel for a refused URL; a URL from a
   page fetched earlier in the turn is allowed; a URL from the current message is allowed; a stored earlier
   turn's source is allowed; produce_file strips a refused image; the ledger backfill.

### Agent B2: hardening (`fix/exfil-hardening`, worktree `.claude/worktrees/exfil-b2`)

Owns: a new `src/lib/server/outbound/` (public-address guard and fetch), `src/lib/server/favicon/fetch.ts` and
`domain.ts`, `src/lib/server/services/file-production/image-loader.ts`, `svelte.config.js`,
`src/lib/server/security-headers.ts`, `src/hooks.server.ts` (only if the header logic needs it), the App sandbox
files (`src/lib/server/services/artifacts/app/sandbox-response.ts` and the bootstrap script, if measured to help),
the four CSRF specs and two scripts named above, a new `tests/e2e/app-frame-navigation.spec.ts`,
`docs/security-headers.md`, `docs/configuration.md`, and their tests.

1. **SSRF guard**: one module that decides whether an address is public (IPv4 and IPv6 special ranges, including
   IPv4-mapped and -compatible IPv6, NAT64, 6to4/Teredo embeddings, CGNAT `100.64/10`, `0/8`, multicast, reserved,
   ULA, link-local, unspecified) and a fetch that resolves the name, refuses the request if any resolved address is
   not public, and connects to the address it checked (a `lookup` on `node:https`; no new dependency), with
   redirects off or re-checked per hop, a timeout and a byte cap. Use it in `fetchFavicon` (source site and
   DuckDuckGo) and in `image-loader.ts`; keep their tests green and add the cases the audit found
   (`[::ffff:7f00:1]`, `[::]`, `100.64.x`, a public name resolving to `127.0.0.1`, a redirect into a private
   range).
2. **CSRF**: delete the `csrf` block from `svelte.config.js`; give the four specs and two scripts an `origin`
   header; grep `tests/e2e` and `scripts` for any other form-typed request without one (Playwright's request
   context sends none) and fix it the same way; add a unit test that fails if `trustedOrigins` ever contains
   `'*'` again; document it (`docs/security-headers.md`, and `ORIGIN` as optional in `docs/configuration.md`).
3. **App frames**: in report-only mode the page response carries, beside the report-only policy, an enforced
   `content-security-policy` with the page policy's own `frame-src` (`enforce` already enforces it; `off` still
   sends no CSP at all, the documented escape hatch). Table tests in `security-headers.test.ts`. Measure in
   headless Chrome whether a Navigation API guard in the App bootstrap (cancel cross-document navigations) and
   `X-DNS-Prefetch-Control: off` on the App response stop the TCP/DNS attempt; add them only if they do and break
   no App test. E2E `tests/e2e/app-frame-navigation.spec.ts`: an App body seeded straight into the database
   (bypassing the write audit) that navigates its frame to a stand-in host by `location`, an evasive
   `window["loc"+"ation"]`, a meta refresh and an anchor click makes no request to that host (`page.route`
   counting). Check the document preview iframes (`srcdoc`) and the App frame still load (run their specs).
4. **CSP `img-src`** becomes `'self' data: blob:`. First grep the UI for any other remote image (provider icons,
   connection logos, CSS `url(https…)`) and report what you find; update the `svelte.config.js` comment and
   `docs/security-headers.md` (why each directive is what it is).

### Orchestrator (after the three merge)

ADR (next after 0067) for the rule and its residuals; one Core Rules bullet in `AGENTS.md` naming the modules;
an Opus adversarial review of the merged branch; then
`scripts/gates.sh agent <out-dir> --port <base> tests/e2e/chat-remote-resources.spec.ts
tests/e2e/app-frame-navigation.spec.ts tests/e2e/mermaid-hardening.spec.ts <the CSRF specs> <preview and App
specs>` once.

## Rules for every agent

- Read `AGENTS.md`. Check current docs before framework code (Svelte/SvelteKit official docs on svelte.dev via
  WebFetch when no docs MCP is available; say you used the fallback).
- Economical: targeted reads (`grep -a`; six src files hold NUL bytes and plain grep may skip them), short output
  tails, targeted tests while iterating. Never run `npm run check` or `npm test` while a build runs.
- At the end, once: `scripts/gates.sh agent <out-dir> --port <your port> --workers 2 <your specs>` (A 5300,
  B1 5400, B2 5500); 0 errors and 0 warnings from `npm run check`; no new Fallow findings.
- Commit in small focused steps with messages that say why; end each message with the
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` line. Never push. Report your model ID, what you
  changed, the gate numbers, and anything you could not do.
