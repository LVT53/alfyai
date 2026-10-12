# Model Output Never Picks an Address That Is Fetched Without a Click

Status: Accepted (2026-10-12).

Alfy reads pages, emails and files a stranger may have written, and the local model is uncensored, so a prompt injection in them can make it write an address with private data hidden in the path, the query or a subdomain. As a link that address is harmless: following it is the reader's choice. As a request nobody clicked (an `<img>`, a favicon, a page the server reads for the model, a picture a report embeds) it hands the data to whoever owns the address. So **an address the browser or the server requests on its own must come from the user's own messages or from a tool's result, never from the model's words.** Model-written markup also stays inert: no forms, no overlays.

The owner approved this on 2026-10-12 as the prerequisite for [ADR-0067](0067-alfy-works-on-your-computers-through-an-outbound-agent.md), which puts file contents and command output in the model's context. The brief is [`docs/plans/exfil-channels/design.md`](../plans/exfil-channels/design.md).

## Decisions

**1. One shared vocabulary.** `src/lib/shared/url-provenance.ts` is where both sides compare addresses: the comparison key (host without `www.`, path and query exact, scheme and fragment ignored), the addresses in a text or a tool payload, and what a message's own tool calls returned (`toolImages`, `toolSourceHosts`, read from the calls' candidates, which the server writes from the tool's results; a call's input never counts).

**2. One gate for HTML.** `sanitizeHtml` removes every attribute that makes the browser fetch unless its caller allows that exact address. So file previews, the Document history preview and Mermaid get nothing remote by default. Model markdown also loses forms, popovers, positioning CSS and class names the renderer did not write itself (the app's global utility classes could otherwise draw a fake login screen over the chat).

**3. A chat reply shows only pictures its own tools returned.** An image_search result is shown as Brave's 500 px thumbnail through the same-origin `/api/image-search/thumbnail` route, and the Immich photo proxy stays as it is. Any other image becomes a visibly external link chip and is never fetched. The CSP's `img-src` drops `https:`.
Rejected:
- **Originals straight from their hosts:** the renderer would be the only defence, and every host sees the reader.
- **A full proxy of originals:** a DNS-pinning SSRF guard, a cache and, in a sample of Wikipedia lead images, a 2.3 MB median per picture through the home server. A 500 px copy averaged 68 KB.

**4. The server keeps, per user and in memory only, the hosts and thumbnails tools returned.** The favicon proxy, the thumbnail route and report favicons fetch nothing else. It is filled when a tool returns and when stored messages are read, so old chats keep their icons. It never touches the database, because an incognito chat promises no writes.
Rejected:
- **A table:** a migration, a backfill, and incognito tool results written to disk.
- **Signed URLs:** a signature at every place a source reaches the browser.
- **A message id on every favicon request:** five components to thread it through, and no answer while a reply streams.

**5. fetch_url and produce_file check provenance in code, per turn.** An address must appear in this conversation's user messages, or in a tool result: this turn's full payloads, including links on pages already read, plus earlier turns' stored sources. A tool whose output is the model's own words (`run_python`, `produce_file`, the artifact tools) is not a source, or `print("https://…")` would launder an address. Nor is the text of a connector result that a local model summarised for a cloud chat model: that model read the user's mail, events or files, a stranger's email among them, so an address in its summary may carry what it read. Such a call counts only through its candidates, which the server writes from the provider's own answer (an event's or a file's link). Every summary is asked for in one place, `decideLocalDistill`, which marks the tool call it runs in; the tool envelope stores the mark on the call (`localDistilled`), so later turns read it too. A refused address never reaches Parallel, and the model is told why. A produce_file picture that fails the check is left out of the document with a warning.

**6. The server's own fetchers resolve before they connect.** They refuse if any resolved address is not public, and they connect to the address they checked. Before, they checked IP literals only.

**7. SvelteKit's CSRF origin check is back.** `trustedOrigins: ['*']` was a patch for an internal OCR route that has since been deleted. Nothing posts forms across origins.

**8. `frame-src` is enforced on every page even when `CSP_MODE` is report-only.** This is a deliberate exception to the CSP rollout in [`docs/security-headers.md`](../security-headers.md), because model-written App code can otherwise navigate its own frame to any address. Measured in Chromium: eight ways of navigating the frame (`location`, `window["loc"+"ation"]`, `assign`, `replace`, a meta refresh, an anchor click and two more) reached an outside host without it, and none did with it. `off` still removes all CSP, as the escape hatch.
Rejected, measured to do nothing:
- **A Navigation API guard in the App's bootstrap:** the `navigate` event never fires in a sandboxed, opaque-origin frame.
- **`X-DNS-Prefetch-Control: off`:** it changed nothing in any probe.

## Consequences

- Pictures in chats from before this change have no stored thumbnail, so they show as links.
- The ledger assumes one server process. After a restart it refills when a chat is read, but a stored Canvas live-web block shows globes until it is refreshed.
- An address the user wrote only in their instructions, an attached document or a skill's text is refused by fetch_url until they type it or a tool reads it.
- With local summarising on and a cloud chat model, a link inside a summarised email or event (a newsletter's article, say) is refused by fetch_url; the event's or file's own link is not.
- With `CSP_MODE=enforce`, an HTML report previewed in the app inherits `img-src` and shows no remote picture.
- Some leaks remain, and this ADR names them so nobody mistakes them for closed:
  - **Which address:** a model can still leak a little through *which* tool-returned address it embeds or fetches, for example an attacker page with one link per letter. That is low bandwidth and comes with any provenance rule.
  - **DNS inside an App:** Chromium opens a connection to a blocked navigation's target before CSP refuses the request, so a hostname that carries data can still reach its owner's DNS.
  - **Memory excerpts:** `memory_context` results count as tool results, and they can quote the model's earlier prose.
  - **Connector summaries stored before the mark:** a summary stored on a call before calls were marked carries no mark, so in its own conversation the addresses in it still count as a tool's.
  - **WebRTC inside an App:** Chromium's CSP does not govern WebRTC, and the App audit catches only the literal word `RTCPeerConnection`, so App code can still reach a STUN or TURN server of its choosing when it runs. This predates this ADR; blocking it at run time is a design question of its own.
  - **Files opened outside the app:** a file the model produced can reference remote content when the user opens it elsewhere.
