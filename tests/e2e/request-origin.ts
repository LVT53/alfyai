import { e2eBaseUrl, e2eSlot } from "./e2e-env";

/**
 * The `Origin` header a browser sends on every POST, and Playwright's request
 * context (`page.request`, `request.newContext`) does not.
 *
 * SvelteKit's CSRF check refuses a POST, PUT, PATCH or DELETE whose body is a
 * form type (urlencoded, multipart, `text/plain`) when `Origin` is missing or is
 * not the server's own, and a production build runs it (`vite dev` does not).
 * A spec that uploads through `/api/knowledge/upload/raw` with a `text/plain`
 * body, the way the browser's small-file path does, spreads this into its
 * headers; JSON bodies are not form types and need nothing.
 *
 * The value is what the slot's server was started with as its `ORIGIN`
 * (`e2e-servers.ts`), so the two cannot drift.
 */
export function sameOriginHeader(): { origin: string } {
	return { origin: e2eBaseUrl(e2eSlot()) };
}
