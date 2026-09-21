/**
 * Downloading a file the server will only hand to an authenticated request.
 *
 * The problem this exists for: `<a href="/api/chat/files/x/download" download>`
 * is a NAVIGATION as far as the browser is concerned, so it carries
 * `Sec-Fetch-Mode: navigate`, so `hooks.server.ts` answers it with the 303 to
 * `/login` rather than the 401 — and the browser dutifully follows the
 * redirect and saves the login PAGE to disk under the file's own name. The
 * user ends up with a `report.pdf` containing `<!DOCTYPE html>`. The
 * `target="_blank"` variants are the same bug with a blank tab instead.
 *
 * The fix cannot be "make the route answer 401": `Sec-Fetch-Dest: document`
 * plus a `download` attribute is indistinguishable on the wire from a real tab
 * navigation, and a user who pastes a download URL into the address bar SHOULD
 * get the login screen. So the check moves to the client: confirm the session
 * with one cheap `fetch` — which does carry `Sec-Fetch-Mode: cors` and does
 * get the 401 — and only then let the browser download.
 *
 * The download itself stays native. No blob buffering: a synthetic `<a
 * download>` click streams straight to disk, so a 400 MB export costs no
 * memory, and unlike `window.open` a download anchor is not subject to the
 * popup blocker, which is what makes it safe to click one AFTER an await.
 */

import { readErrorPayload } from "$lib/client/api/http";

/**
 * The session probe.
 *
 * `/api/chat/stream/status` with no `conversationId` is the cheapest
 * authenticated endpoint in the app: the hook's own session lookup runs (as it
 * does for every request), and then the handler returns 400 before touching
 * the database, the filesystem or any backend. `/api/health` cannot be used —
 * it is in `PUBLIC_PATHS` and never 401s.
 *
 * The contract is deliberately one-sided: ONLY a 401 stops the download.
 * A 400 is the healthy answer here, and anything else — a 500, a network
 * blip — means we do not know, in which case letting the download proceed and
 * fail visibly beats blocking a file the user asked for.
 */
const SESSION_PROBE_URL = "/api/chat/stream/status";

export type FetchLike = typeof fetch;

/**
 * True when the session is still good enough to download with.
 *
 * On a 401 this routes through `readErrorPayload`, which is the same helper
 * every centrally-routed call uses and which runs the app's one
 * session-expiry reaction — so the user lands on the login screen instead of
 * silently saving an HTML page called `report.pdf`.
 */
export async function confirmSessionForDownload(
	fetchImpl: FetchLike = fetch,
): Promise<boolean> {
	try {
		const response = await fetchImpl(SESSION_PROBE_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		if (response.status !== 401) return true;
		await readErrorPayload(response, "Unauthorized").catch(() => undefined);
		return false;
	} catch {
		// The probe could not be made at all. Not evidence of an expired
		// session, so do not act like it is.
		return true;
	}
}

/**
 * A click the browser should handle itself.
 *
 * Ctrl/Cmd-click, Shift-click and middle-click are explicit "open this
 * somewhere else" gestures, and the anchor is left alone so they keep working.
 * Those land on a navigation, which the 303 answers with a visible login
 * screen — the honest outcome for a gesture whose whole point is to show the
 * user a page. The silent failure this module exists to stop is the plain
 * left-click that writes a file.
 */
export function isBrowserHandledClick(event: MouseEvent): boolean {
	return (
		event.button !== 0 ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		event.altKey
	);
}

/**
 * Starts the browser's own download of `url`.
 *
 * Synthetic anchor rather than `location.assign` so the `download` attribute
 * applies and the current page is not navigated away from; and rather than
 * `window.open` so the popup blocker does not eat it after an await.
 */
export function triggerBrowserDownload(url: string, filename?: string): void {
	if (typeof document === "undefined") return;
	const anchor = document.createElement("a");
	anchor.href = url;
	if (filename) anchor.download = filename;
	anchor.rel = "noopener";
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
}

/**
 * Confirm, then download. The one entry point every affordance uses.
 *
 * Returns whether the download was started, which is what a component needs to
 * decide whether to close its menu.
 */
export async function startAuthenticatedDownload(
	url: string,
	filename?: string,
	fetchImpl: FetchLike = fetch,
): Promise<boolean> {
	if (!url) return false;
	if (!(await confirmSessionForDownload(fetchImpl))) return false;
	triggerBrowserDownload(url, filename);
	return true;
}

/**
 * The `onclick` for an `<a href=… download>` affordance.
 *
 * The anchor keeps its `href`, so the status bar shows the destination and
 * every modified-click gesture keeps its native meaning; this only intercepts
 * the plain left-click, which is the one that would otherwise save a login
 * page under the file's name.
 */
export function handleDownloadAnchorClick(
	event: MouseEvent,
	url: string,
	filename?: string,
	fetchImpl: FetchLike = fetch,
): void {
	if (isBrowserHandledClick(event)) return;
	event.preventDefault();
	void startAuthenticatedDownload(url, filename, fetchImpl);
}
