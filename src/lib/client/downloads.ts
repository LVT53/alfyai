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

import {
	cancelFileProductionJob,
	type FileProductionJobWaitOptions,
	type FileProductionJobWaitResult,
	waitForFileProductionJob,
} from "$lib/client/api/file-production";
import { readErrorPayload } from "$lib/client/api/http";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import { clearSessionExpiry } from "$lib/stores/session";

/**
 * The session probe.
 *
 * `/api/chat/stream/status` is the cheapest authenticated endpoint in the app:
 * the hook's own session lookup runs (as it does for every request), and then
 * the handler answers from memory (`{ hasOrphanedStream: false }` for a
 * conversation it has no stream for) without touching the database, the
 * filesystem or any backend. `/api/health` cannot be used — it is in
 * `PUBLIC_PATHS` and never 401s. The probe names a conversation that cannot
 * exist, so it is answered 200: it used to ask with none, which the handler
 * refuses with a 400 on purpose, and DevTools showed a red failed request at the
 * start of every download (friction audit F30).
 *
 * The contract is deliberately one-sided: ONLY a 401 stops the download.
 * Anything else — a 500, a network blip — means we do not know, in which case
 * letting the download proceed and fail visibly beats blocking a file the user
 * asked for.
 */
const SESSION_PROBE_URL =
	"/api/chat/stream/status?conversationId=session-probe";

export type FetchLike = typeof fetch;

/**
 * True when the session is still good enough to download with.
 *
 * On a 401 this routes through `readErrorPayload`, which is the same helper
 * every centrally-routed call uses and which runs the app's one
 * session-expiry reaction — so the shell's "You have been signed out" row goes
 * up, with its way back, instead of the browser silently saving an HTML page
 * called `report.pdf`.
 *
 * The other direction matters just as much. The probe reaching the handler is
 * proof the gate admitted it, so a tab that was showing the row because of an
 * earlier refusal lowers it again here — the same "a request that succeeded
 * heals this tab" rule the HTTP helpers apply, which is how signing in from
 * another tab gets this one working without a reload. A 5xx is not that proof:
 * the request may never have reached the gate at all.
 */
export async function confirmSessionForDownload(
	fetchImpl: FetchLike = fetch,
): Promise<boolean> {
	try {
		const response = await fetchImpl(SESSION_PROBE_URL, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		if (response.status === 401) {
			await readErrorPayload(response, "Unauthorized").catch(() => undefined);
			return false;
		}
		// Anything the gate admitted (below 500) is proof the session is good.
		if (response.status < 500) clearSessionExpiry();
		return true;
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

/**
 * What starting a produced file's job answered: the job, or the server's reason for
 * refusing. `reused` says the job is one an earlier press made (the same item and
 * format is one job, so two tabs, or a press after Escape, share it): the press that
 * was handed it does not own it.
 */
type ProducedFileStart =
	| { ok: true; job: FileProductionJob; reused?: boolean }
	| { ok: false; reason: string };

/**
 * `reason` is the server's own when it refused to start the job (`source_too_large`,
 * `no_conversation`, …), else one of: `job_failed` (the job failed or is gone),
 * `timeout` (still running when the wait ran out), `no_file` (finished with none),
 * `session_ended` (the session ended before the download could start; the shell's
 * signed-out row says so), `failed` (starting the job threw).
 */
type ProducedFileDownloadResult =
	| { ok: true; filename: string }
	| { ok: false; reason: string };

interface ProducedFileDownloadDeps {
	wait?: (
		job: FileProductionJob,
		options?: FileProductionJobWaitOptions,
	) => Promise<FileProductionJobWaitResult>;
	cancel?: (jobId: string) => Promise<unknown>;
	download?: typeof startAuthenticatedDownload;
	fetchImpl?: FetchLike;
	waitOptions?: FileProductionJobWaitOptions;
}

/** How many presses in this tab are waiting on each job: a job is shared by every press of the same item and format. */
const waitingOn = new Map<string, number>();

/**
 * What a Download does for a file the server has to make first (a Document's PDF,
 * Word or Markdown, an App's `.html`): start the job, follow it until it has made
 * the file, then hand the browser the file's own download. The one path for both,
 * so a Download is never "started and forgotten": a file that is ready downloads,
 * and one that is not says why (the caller shows it; friction audit F1).
 *
 * The download is the canonical `/api/chat/files/[id]/download`, built here from
 * the file's id and fetched through `startAuthenticatedDownload` like every other.
 * A job still running when the wait ran out is cancelled, so it does not finish
 * later into a file nobody is waiting for, unless another press shares it.
 */
export async function downloadProducedFile(
	start: () => Promise<ProducedFileStart>,
	deps: ProducedFileDownloadDeps = {},
): Promise<ProducedFileDownloadResult> {
	let started: ProducedFileStart;
	try {
		started = await start();
	} catch {
		return { ok: false, reason: "failed" };
	}
	if (!started.ok) return { ok: false, reason: started.reason };

	const wait = deps.wait ?? waitForFileProductionJob;
	const jobId = started.job.id;
	waitingOn.set(jobId, (waitingOn.get(jobId) ?? 0) + 1);
	let settled: FileProductionJobWaitResult;
	try {
		settled = await wait(started.job, {
			fetchImpl: deps.fetchImpl,
			...deps.waitOptions,
		});
	} finally {
		const left = (waitingOn.get(jobId) ?? 1) - 1;
		if (left > 0) waitingOn.set(jobId, left);
		else waitingOn.delete(jobId);
	}
	if (settled.state === "timeout") {
		// Stopping the job is for the press that made it, and only when no other press
		// here still waits on it (RV-B M2): a job two presses share is not cancelled
		// out from under the one that is still waiting. One that is left running
		// finishes into a file the next press is handed (the key is the item's words).
		if (!started.reused && !waitingOn.has(jobId)) {
			const cancel = deps.cancel ?? ((id) => cancelFileProductionJob(id));
			void Promise.resolve(cancel(jobId)).catch(() => undefined);
		}
		return { ok: false, reason: "timeout" };
	}
	if (settled.state !== "succeeded") return { ok: false, reason: "job_failed" };

	const file = settled.job.files[0];
	if (!file) return { ok: false, reason: "no_file" };

	const download = deps.download ?? startAuthenticatedDownload;
	const began = await download(
		`/api/chat/files/${encodeURIComponent(file.id)}/download`,
		file.filename,
		deps.fetchImpl,
	);
	return began
		? { ok: true, filename: file.filename }
		: { ok: false, reason: "session_ended" };
}
