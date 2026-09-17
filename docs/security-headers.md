# Security Headers And Content Security Policy

Every response the app serves gets a baseline set of security headers, and every rendered page
additionally carries a Content Security Policy. The CSP ships **report-only by default** — it is
observed, not enforced, until an operator flips it.

- Header logic: [`src/lib/server/security-headers.ts`](../src/lib/server/security-headers.ts) (pure,
  table-driven) applied from [`src/hooks.server.ts`](../src/hooks.server.ts).
- CSP directives: the `csp` block in [`svelte.config.js`](../svelte.config.js).
- Env switch: `CSP_MODE` (see [configuration.md](./configuration.md)).

## What is sent

| Header | Scope | Value |
|---|---|---|
| `X-Content-Type-Options` | every response | `nosniff` |
| `Referrer-Policy` | every response | `strict-origin-when-cross-origin` |
| `Strict-Transport-Security` | production **and** HTTPS only | `max-age=63072000; includeSubDomains` |
| `X-Frame-Options` | HTML documents outside `/api/` | `SAMEORIGIN` |
| `Permissions-Policy` | HTML documents outside `/api/` | camera, microphone, geolocation, payment, USB, sensors and friends all denied |
| `Cross-Origin-Opener-Policy` | HTML documents outside `/api/` | `same-origin` |
| `Content-Security-Policy[-Report-Only]` | rendered pages | see below |

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
img-src 'self' data: blob: https:;
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
- **`img-src https:`** because chat markdown embeds arbitrary remote images from model and search
  output. `data:` is for inline SVG/preview URIs and `blob:` for the image preview and the settings
  image pickers.
- **`worker-src blob:`** for Sentry's replay compression worker. pdf.js and MapLibre workers are
  same-origin.
- **`connect-src`** is same-origin only: the browser never talks to a model provider, a tile server
  or a favicon host directly — those are all proxied through `/api/`. The Sentry DSN origin is
  appended at runtime in `hooks.server.ts`, so the DSN never has to be known at build time and
  rotating it is not a rebuild.

Map tiles (`/api/map-tiles`) and favicons (`/api/favicon`) need no entry of their own: the client
requests both from this origin.

## Rolling out: report-only → enforce

`CSP_MODE` defaults to `report-only`, and anything it does not recognise also means `report-only`,
so a typo cannot put production onto an enforcing policy nobody has watched.

1. **Deploy to staging with the default.** Nothing is blocked; violations are reported.
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

`CSP_MODE=off` removes the header entirely; it exists so a CSP problem can never be the reason a
deploy has to be rolled back.

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
| `/login` (page) | `content-security-policy-report-only` with the full policy incl. `'nonce-…'`; no enforcing CSP | `content-security-policy` with the same policy | neither CSP header |
| `/api/health` (JSON) | `nosniff`, `referrer-policy`, HSTS only — no CSP, no XFO, no COOP, no Permissions-Policy | same | same |
| `/api/**/preview` (endpoint) | its own `default-src 'none'` CSP, enforcing, untouched | untouched | untouched |
| `/_app/immutable/**` | no security headers (served before `handle`) | same | same |
| `/login` over `x-forwarded-proto: http` | as above **minus** `Strict-Transport-Security` | same | same |

Every page response also carries `x-frame-options: SAMEORIGIN`, `cross-origin-opener-policy:
same-origin`, the `Permissions-Policy` list, `referrer-policy: strict-origin-when-cross-origin` and
`x-content-type-options: nosniff`. No `<meta http-equiv="content-security-policy">` is emitted
anywhere, because no route in this app is prerendered — SvelteKit only falls back to a meta tag when
prerendering, and a meta CSP could not be switched by `CSP_MODE` at runtime. If a route ever gains
`export const prerender = true`, this section stops being true for it.
