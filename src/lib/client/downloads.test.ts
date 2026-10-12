// The helper that stands between a download button and the browser.
//
// The bug it exists for is quiet and nasty: a `<a download>` is a NAVIGATION,
// so an expired session gets the 303 to /login, so the browser follows it and
// saves the login PAGE to disk under the file's own name. The user is left
// holding a `report.pdf` full of `<!DOCTYPE html>` with nothing on screen to
// say anything went wrong.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SESSION_EXPIRED_CODE,
	SESSION_EXPIRED_HEADER,
} from "$lib/session-expiry";
import {
	clearSessionExpiry,
	isSessionExpired,
	markSessionExpired,
} from "$lib/stores/session";
import {
	confirmSessionForDownload,
	downloadProducedFile,
	handleDownloadAnchorClick,
	isBrowserHandledClick,
	startAuthenticatedDownload,
	triggerBrowserDownload,
} from "./downloads";

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function clickEvent(init: Partial<MouseEventInit> = {}): MouseEvent {
	return new MouseEvent("click", { button: 0, cancelable: true, ...init });
}

beforeEach(() => {
	clearSessionExpiry();
	document.body.innerHTML = "";
});

describe("confirmSessionForDownload", () => {
	it("probes the cheapest authenticated endpoint, not a public one", async () => {
		// `/api/health` is in PUBLIC_PATHS and can never 401, so a probe of it
		// would always say "fine".
		const fetchImpl = vi.fn(async () =>
			jsonResponse(400, { error: "conversationId is required" }),
		);

		expect(await confirmSessionForDownload(fetchImpl)).toBe(true);
		expect(fetchImpl).toHaveBeenCalledWith(
			"/api/chat/stream/status",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("treats the 400 a valid session gets as a healthy answer", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(400, { error: "conversationId is required" }),
		);
		expect(await confirmSessionForDownload(fetchImpl)).toBe(true);
		expect(isSessionExpired()).toBe(false);
	});

	it("reports an expired session and refuses", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(
				401,
				{ error: "expired", code: SESSION_EXPIRED_CODE },
				{ [SESSION_EXPIRED_HEADER]: "1" },
			),
		);

		expect(await confirmSessionForDownload(fetchImpl)).toBe(false);
		// The download affordances are outside `http.ts`, but the verdict they
		// reach is the same one every other transport reports: the shell's
		// signed-out row, with its way back.
		expect(isSessionExpired()).toBe(true);
	});

	// A route's own gate never reaches the hook, so it has no header to send.
	it("reports a route's own Unauthorized too", async () => {
		expect(
			await confirmSessionForDownload(
				vi.fn(async () => jsonResponse(401, { error: "Unauthorized" })),
			),
		).toBe(false);

		expect(isSessionExpired()).toBe(true);
	});

	// The other direction: signing in on another tab has to heal this one, and
	// the probe reaching the handler at all is the proof that it did.
	it("lowers a stale row when the probe gets through", async () => {
		markSessionExpired();

		expect(
			await confirmSessionForDownload(
				vi.fn(async () =>
					jsonResponse(400, { error: "conversationId is required" }),
				),
			),
		).toBe(true);

		expect(isSessionExpired()).toBe(false);
	});

	it("does not block a download when the probe itself fails", async () => {
		// A 500 or a dropped connection is not evidence of an expired session.
		// Letting the download proceed and fail visibly beats refusing a file
		// the user asked for on a guess.
		expect(
			await confirmSessionForDownload(vi.fn(async () => jsonResponse(500, {}))),
		).toBe(true);
		expect(
			await confirmSessionForDownload(
				vi.fn(async () => {
					throw new TypeError("Failed to fetch");
				}),
			),
		).toBe(true);
		expect(isSessionExpired()).toBe(false);
	});

	// ...and it is equally not evidence the session is GOOD, so a row already
	// on screen stays up.
	it("leaves a raised row alone when the probe cannot answer", async () => {
		markSessionExpired();

		expect(
			await confirmSessionForDownload(vi.fn(async () => jsonResponse(500, {}))),
		).toBe(true);

		expect(isSessionExpired()).toBe(true);
	});
});

describe("triggerBrowserDownload", () => {
	it("clicks a download anchor rather than buffering a blob", async () => {
		// No `createObjectURL`, no `arrayBuffer()`: a 400 MB export has to
		// stream to disk, not through memory.
		const clicked: Array<{ href: string; download: string }> = [];
		const realClick = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function patched(
			this: HTMLAnchorElement,
		) {
			clicked.push({
				href: this.getAttribute("href") ?? "",
				download: this.download,
			});
		};
		try {
			triggerBrowserDownload("/api/chat/files/f1/download", "report.pdf");
		} finally {
			HTMLAnchorElement.prototype.click = realClick;
		}

		expect(clicked).toEqual([
			{ href: "/api/chat/files/f1/download", download: "report.pdf" },
		]);
		// And it cleans up after itself.
		expect(document.body.querySelector("a")).toBeNull();
	});
});

describe("startAuthenticatedDownload", () => {
	it("downloads once the session is confirmed", async () => {
		const clicks: string[] = [];
		const realClick = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function patched(
			this: HTMLAnchorElement,
		) {
			clicks.push(this.getAttribute("href") ?? "");
		};
		try {
			const started = await startAuthenticatedDownload(
				"/api/knowledge/a1/download",
				"notes.md",
				vi.fn(async () => jsonResponse(400, { error: "nope" })),
			);
			expect(started).toBe(true);
		} finally {
			HTMLAnchorElement.prototype.click = realClick;
		}
		expect(clicks).toEqual(["/api/knowledge/a1/download"]);
	});

	it("downloads nothing at all when the session is gone", async () => {
		const clicks: string[] = [];
		const realClick = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function patched(
			this: HTMLAnchorElement,
		) {
			clicks.push(this.getAttribute("href") ?? "");
		};
		try {
			const started = await startAuthenticatedDownload(
				"/api/knowledge/a1/download",
				"notes.md",
				vi.fn(async () => jsonResponse(401, { error: "Unauthorized" })),
			);
			expect(started).toBe(false);
		} finally {
			HTMLAnchorElement.prototype.click = realClick;
		}
		// The whole point: no file is written.
		expect(clicks).toEqual([]);
	});
});

describe("isBrowserHandledClick", () => {
	it("leaves the modified-click gestures to the browser", () => {
		for (const init of [
			{ ctrlKey: true },
			{ metaKey: true },
			{ shiftKey: true },
			{ altKey: true },
			{ button: 1 },
		]) {
			expect(
				isBrowserHandledClick(clickEvent(init)),
				JSON.stringify(init),
			).toBe(true);
		}
	});

	it("takes the plain left click", () => {
		expect(isBrowserHandledClick(clickEvent())).toBe(false);
	});
});

describe("handleDownloadAnchorClick", () => {
	it("does not preventDefault a middle click, so open-in-new-tab still works", () => {
		const event = clickEvent({ button: 1 });
		handleDownloadAnchorClick(event, "/api/chat/files/f1/download", "r.pdf");
		expect(event.defaultPrevented).toBe(false);
	});

	it("intercepts the plain left click", () => {
		const event = clickEvent();
		handleDownloadAnchorClick(
			event,
			"/api/chat/files/f1/download",
			"r.pdf",
			vi.fn(async () => jsonResponse(400, {})),
		);
		expect(event.defaultPrevented).toBe(true);
	});
});

// Friction audit F1: a Download of a file the server has to make first follows
// the job to its end and starts the browser's download of the file it made.
describe("downloadProducedFile", () => {
	const job = (status: string, extra: Record<string, unknown> = {}) =>
		({
			id: "job-1",
			conversationId: "conv-1",
			title: "Trip plan",
			status,
			createdAt: 1,
			updatedAt: 2,
			files: [],
			warnings: [],
			dismissed: false,
			sourceMode: "document_source",
			...extra,
		}) as never;

	const made = job("succeeded", {
		files: [
			{
				id: "file/1",
				filename: "trip-plan.pdf",
				mimeType: "application/pdf",
				sizeBytes: 10,
				downloadUrl: "/somewhere/else",
				previewUrl: null,
			},
		],
	});

	it("starts the download of the file the job made, on the canonical route, under its name", async () => {
		const download = vi.fn(async () => true);
		const wait = vi.fn(async () => ({
			state: "succeeded" as const,
			job: made,
		}));

		const result = await downloadProducedFile(
			async () => ({ ok: true, job: job("queued") }),
			{ wait, download },
		);

		expect(result).toEqual({ ok: true, filename: "trip-plan.pdf" });
		// Built from the file's id, never from a URL the job carried.
		expect(download).toHaveBeenCalledWith(
			"/api/chat/files/file%2F1/download",
			"trip-plan.pdf",
			undefined,
		);
	});

	it("passes the server's own reason when it refused to start the job", async () => {
		const wait = vi.fn();
		const download = vi.fn();
		await expect(
			downloadProducedFile(
				async () => ({ ok: false, reason: "source_too_large" }),
				{ wait, download },
			),
		).resolves.toEqual({ ok: false, reason: "source_too_large" });
		expect(wait).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();
	});

	it("says failed when starting the job threw", async () => {
		await expect(
			downloadProducedFile(async () => {
				throw new TypeError("Failed to fetch");
			}),
		).resolves.toEqual({ ok: false, reason: "failed" });
	});

	it("downloads nothing for a job that failed or is gone", async () => {
		const download = vi.fn();
		for (const settled of [
			{ state: "failed" as const, job: job("failed") },
			{ state: "gone" as const },
		]) {
			await expect(
				downloadProducedFile(async () => ({ ok: true, job: job("queued") }), {
					wait: vi.fn(async () => settled),
					download,
				}),
			).resolves.toEqual({ ok: false, reason: "job_failed" });
		}
		expect(download).not.toHaveBeenCalled();
	});

	it("stops the job when the wait ran out, so it does not finish later into a file nobody is waiting for", async () => {
		const cancel = vi.fn(async () => ({}));
		const download = vi.fn();

		const result = await downloadProducedFile(
			async () => ({ ok: true, job: job("queued") }),
			{
				wait: vi.fn(async () => ({
					state: "timeout" as const,
					job: job("running"),
				})),
				cancel,
				download,
			},
		);

		expect(result).toEqual({ ok: false, reason: "timeout" });
		expect(cancel).toHaveBeenCalledWith("job-1");
		expect(download).not.toHaveBeenCalled();
	});

	it("says so when the job finished with no file", async () => {
		await expect(
			downloadProducedFile(async () => ({ ok: true, job: job("queued") }), {
				wait: vi.fn(async () => ({
					state: "succeeded" as const,
					job: job("succeeded"),
				})),
				download: vi.fn(),
			}),
		).resolves.toEqual({ ok: false, reason: "no_file" });
	});

	it("says so when the session ended before the download could start", async () => {
		await expect(
			downloadProducedFile(async () => ({ ok: true, job: job("queued") }), {
				wait: vi.fn(async () => ({ state: "succeeded" as const, job: made })),
				download: vi.fn(async () => false),
			}),
		).resolves.toEqual({ ok: false, reason: "session_ended" });
	});
});
