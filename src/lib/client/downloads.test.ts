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
