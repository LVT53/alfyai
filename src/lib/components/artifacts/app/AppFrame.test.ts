import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_IFRAME_SANDBOX } from "$lib/server/services/artifacts/app/sandbox-response";
import { uiLanguage } from "$lib/stores/settings";
import AppFrame from "./AppFrame.svelte";

const readAppValue = vi.fn();
const writeAppValue = vi.fn();
vi.mock("$lib/client/api/artifacts", () => ({
	readAppValue: (...args: unknown[]) => readAppValue(...args),
	writeAppValue: (...args: unknown[]) => writeAppValue(...args),
}));

function getIframe(container: HTMLElement): HTMLIFrameElement {
	const iframe = container.querySelector("iframe");
	if (!iframe) throw new Error("no iframe rendered");
	return iframe;
}

/** A window-shaped object that is NOT the rendered iframe's contentWindow. */
function foreignWindow(): Window {
	const foreign = document.createElement("iframe");
	document.body.appendChild(foreign);
	const win = foreign.contentWindow as Window;
	return win;
}

function post(data: unknown, source: Window, origin = "null") {
	window.dispatchEvent(
		new MessageEvent("message", { data, source: source as never, origin }),
	);
}

/**
 * A browser keeps one WindowProxy per iframe ELEMENT for its whole life:
 * navigating the element (a new `src`) swaps the document behind the proxy,
 * never the proxy itself. jsdom instead hands out a new window object on every
 * `src` change. This pins the browser's behaviour for the tests that depend on
 * it: the first window an element reports is the one it keeps reporting.
 * Returns the restore function.
 */
function pinWindowProxyPerElement(): () => void {
	const original = Object.getOwnPropertyDescriptor(
		HTMLIFrameElement.prototype,
		"contentWindow",
	);
	if (!original?.get) throw new Error("jsdom changed its iframe shape");
	const readReal = original.get;
	const pinned = new WeakMap<HTMLIFrameElement, Window>();
	Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
		configurable: true,
		get(this: HTMLIFrameElement) {
			const existing = pinned.get(this);
			if (existing) return existing;
			const real = readReal.call(this) as Window | null;
			if (real) pinned.set(this, real);
			return real;
		},
	});
	return () =>
		Object.defineProperty(
			HTMLIFrameElement.prototype,
			"contentWindow",
			original,
		);
}

let restoreContentWindow: (() => void) | null = null;

beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
});

afterEach(() => {
	restoreContentWindow?.();
	restoreContentWindow = null;
	document.body.innerHTML = "";
});

describe("AppFrame — the sandbox and the served route", () => {
	// Ruling 58: the sandbox widens by exactly one token, `allow-forms`, so a
	// generated app's <form> submit EVENT fires (open question 1) while
	// `form-action 'none'` in the CSP still refuses the submission itself.
	it("renders the iframe with the sandbox attribute EXACTLY allow-scripts allow-forms", () => {
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);
		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
		// Pinned against the one shared constant sandbox-response.ts exports, so
		// the frame's literal and the served route's CSP directive cannot drift
		// apart from each other.
		expect(iframe.getAttribute("sandbox")).toBe(APP_IFRAME_SANDBOX);
	});

	it("never carries allow-same-origin or any other sandbox token beyond scripts and forms", () => {
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);
		expect(iframe.getAttribute("sandbox")).not.toMatch(/allow-same-origin/);
		expect(iframe.getAttribute("sandbox")?.split(/\s+/)).toEqual([
			"allow-scripts",
			"allow-forms",
		]);
	});

	it("is reachable by keyboard: tabindex=0", () => {
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		expect(getIframe(container).getAttribute("tabindex")).toBe("0");
	});

	it("points src at the served route with the artifact id and version as a cache-buster", () => {
		const { container } = render(AppFrame, {
			artifactId: "app-42",
			version: 3,
		});
		const src = getIframe(container).getAttribute("src") ?? "";
		expect(src).toBe("/api/artifacts/app-42/app?v=3");
	});

	it("reloads (changes src) when the version prop changes", async () => {
		const { container, rerender } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
		});
		const firstSrc = getIframe(container).getAttribute("src");

		await rerender({ artifactId: "app-1", version: 2 });

		const secondSrc = getIframe(container).getAttribute("src");
		expect(secondSrc).not.toBe(firstSrc);
		expect(secondSrc).toContain("v=2");
	});

	it("widens the served route's scope with conversationId when given one", () => {
		const { container } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
			conversationId: "conv-incognito",
		});
		expect(getIframe(container).getAttribute("src")).toContain(
			"conversationId=conv-incognito",
		);
	});
});

describe("AppFrame — the trust boundary", () => {
	it("ignores a message from a window that is not this iframe's contentWindow", async () => {
		readAppValue.mockResolvedValue({
			ok: true,
			value: "should not be reached",
		});
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);
		const other = foreignWindow();

		post(
			{ v: 1, kind: "alfy.storage", id: 1, method: "get", args: ["k"] },
			other,
		);
		await Promise.resolve();

		expect(readAppValue).not.toHaveBeenCalled();
		void iframe;
	});

	it("ignores a message from the right frame with the wrong kind", async () => {
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);

		post(
			{ v: 1, kind: "alfy.file.read", id: 1, method: "get", args: ["k"] },
			iframe.contentWindow as Window,
		);
		await Promise.resolve();

		expect(readAppValue).not.toHaveBeenCalled();
	});

	it("ignores a message whose origin is not the opaque 'null' (allow-same-origin having crept in)", async () => {
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);

		post(
			{ v: 1, kind: "alfy.storage", id: 1, method: "get", args: ["k"] },
			iframe.contentWindow as Window,
			"https://example.com",
		);
		await Promise.resolve();

		expect(readAppValue).not.toHaveBeenCalled();
	});

	it.each([
		[
			{ v: 2, kind: "alfy.storage", id: 1, method: "get", args: ["k"] },
			"wrong v",
		],
		[
			{ v: 1, kind: "alfy.storage", id: "one", method: "get", args: ["k"] },
			"non-numeric id",
		],
		[
			{ v: 1, kind: "alfy.storage", id: 1, method: "delete", args: ["k"] },
			"unknown method",
		],
		[
			{ v: 1, kind: "alfy.storage", id: 1, method: "get", args: [] },
			"empty args",
		],
		[
			{
				v: 1,
				kind: "alfy.storage",
				id: 1,
				method: "get",
				args: ["a", "b", "c"],
			},
			"too many args",
		],
		[null, "null payload"],
		["a string", "non-object payload"],
	] as const)("drops a malformed message: %s", async (payload, _description) => {
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);

		post(payload, iframe.contentWindow as Window);
		await Promise.resolve();

		expect(readAppValue).not.toHaveBeenCalled();
		expect(writeAppValue).not.toHaveBeenCalled();
	});

	it("uses the PROP's artifactId for the storage call even when the message payload names a different one", async () => {
		readAppValue.mockResolvedValue({ ok: true, value: 42 });
		const { container } = render(AppFrame, {
			artifactId: "the-real-id",
			version: 1,
		});
		const iframe = getIframe(container);

		post(
			{
				v: 1,
				kind: "alfy.storage",
				id: 7,
				method: "get",
				args: ["k"],
				// A forged field: there is no code path that reads this.
				artifactId: "someone-elses-id",
			},
			iframe.contentWindow as Window,
		);
		await vi.waitFor(() => expect(readAppValue).toHaveBeenCalled());

		expect(readAppValue).toHaveBeenCalledWith("the-real-id", "k", null);
	});

	it("forwards the frame's conversationId prop to readAppValue, so an incognito conversation's own App resolves its storage", async () => {
		readAppValue.mockResolvedValue({ ok: true, value: 1 });
		const { container } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
			conversationId: "conv-incognito",
		});
		const iframe = getIframe(container);

		post(
			{ v: 1, kind: "alfy.storage", id: 1, method: "get", args: ["k"] },
			iframe.contentWindow as Window,
		);
		await vi.waitFor(() => expect(readAppValue).toHaveBeenCalled());

		expect(readAppValue).toHaveBeenCalledWith("app-1", "k", "conv-incognito");
	});

	it("forwards the frame's conversationId prop to writeAppValue", async () => {
		writeAppValue.mockResolvedValue({ ok: true });
		const { container } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
			conversationId: "conv-incognito",
		});
		const iframe = getIframe(container);

		post(
			{
				v: 1,
				kind: "alfy.storage",
				id: 2,
				method: "set",
				args: ["k", { a: 1 }],
			},
			iframe.contentWindow as Window,
		);
		await vi.waitFor(() => expect(writeAppValue).toHaveBeenCalled());

		expect(writeAppValue).toHaveBeenCalledWith(
			"app-1",
			"k",
			{ a: 1 },
			"conv-incognito",
		);
	});

	it("replies only to event.source, with the same request id, never broadcasting", async () => {
		readAppValue.mockResolvedValue({ ok: true, value: "hello" });
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);
		const source = iframe.contentWindow as Window;
		const postSpy = vi.spyOn(source, "postMessage");

		post(
			{ v: 1, kind: "alfy.storage", id: 9, method: "get", args: ["k"] },
			source,
		);
		await vi.waitFor(() => expect(postSpy).toHaveBeenCalled());

		expect(postSpy).toHaveBeenCalledWith(
			{ v: 1, kind: "alfy.storage.result", id: 9, ok: true, value: "hello" },
			"*",
		);
	});

	it("a missing key resolves as { ok: true, value: null }, forwarded verbatim to the frame", async () => {
		readAppValue.mockResolvedValue({ ok: true, value: null });
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);
		const source = iframe.contentWindow as Window;
		const postSpy = vi.spyOn(source, "postMessage");

		post(
			{ v: 1, kind: "alfy.storage", id: 1, method: "get", args: ["missing"] },
			source,
		);
		await vi.waitFor(() => expect(postSpy).toHaveBeenCalled());

		expect(postSpy).toHaveBeenCalledWith(
			expect.objectContaining({ ok: true, value: null }),
			"*",
		);
	});

	it("calls writeAppValue with both args for a set", async () => {
		writeAppValue.mockResolvedValue({ ok: true });
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);

		post(
			{
				v: 1,
				kind: "alfy.storage",
				id: 2,
				method: "set",
				args: ["k", { a: 1 }],
			},
			iframe.contentWindow as Window,
		);
		await vi.waitFor(() => expect(writeAppValue).toHaveBeenCalled());

		expect(writeAppValue).toHaveBeenCalledWith("app-1", "k", { a: 1 }, null);
	});

	it("localises a storage refusal into the reply's error text, and calls onStorageError with the same text", async () => {
		writeAppValue.mockResolvedValue({ ok: false, reason: "too_large" });
		const onStorageError = vi.fn();
		const { container } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
			onStorageError,
		});
		const iframe = getIframe(container);
		const source = iframe.contentWindow as Window;
		const postSpy = vi.spyOn(source, "postMessage");

		post(
			{ v: 1, kind: "alfy.storage", id: 3, method: "set", args: ["k", "x"] },
			source,
		);
		await vi.waitFor(() => expect(postSpy).toHaveBeenCalled());

		const [reply] = postSpy.mock.calls[0];
		expect((reply as { error: string }).error).toBe(
			"This app tried to save more than it can.",
		);
		expect(onStorageError).toHaveBeenCalledWith(
			"This app tried to save more than it can.",
		);
	});

	it("a frame that never replies (the bridge's own fetch fails) does not leak: no reply is sent, and onStorageError still fires", async () => {
		readAppValue.mockRejectedValue(new Error("network down"));
		const onStorageError = vi.fn();
		const { container } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
			onStorageError,
		});
		const iframe = getIframe(container);
		const source = iframe.contentWindow as Window;
		const postSpy = vi.spyOn(source, "postMessage");

		post(
			{ v: 1, kind: "alfy.storage", id: 4, method: "get", args: ["k"] },
			source,
		);
		await vi.waitFor(() => expect(onStorageError).toHaveBeenCalled());

		expect(postSpy).not.toHaveBeenCalled();
	});

	// RV-2A: an iframe keeps ONE WindowProxy across navigations, so while the
	// frame's `src` moves to another app (the panel's open-documents rail
	// reuses this component for the next App) the outgoing document is still
	// alive and its messages still pass `event.source === frame.contentWindow`
	// — measured in Chromium: 39 of 40 messages the old document posted during
	// a 150 ms navigation passed the check and were attributed to the new app.
	// jsdom hands out a NEW window object on every `src` change, which hides
	// the bug, so these two tests pin the browser's behaviour explicitly
	// (`pinWindowProxyPerElement`). tests/e2e/artifact-app.spec.ts proves the
	// same thing in a real browser.
	it("a message from the previous app's document, arriving after the panel switched apps, is not served against the new app", async () => {
		restoreContentWindow = pinWindowProxyPerElement();
		writeAppValue.mockResolvedValue({ ok: true });
		readAppValue.mockResolvedValue({
			ok: true,
			value: "the other app's value",
		});
		const { container, rerender } = render(AppFrame, {
			artifactId: "app-a",
			version: 1,
		});
		const previousDocumentWindow = getIframe(container).contentWindow as Window;

		await rerender({ artifactId: "app-b", version: 1 });
		post(
			{
				v: 1,
				kind: "alfy.storage",
				id: 1,
				method: "set",
				args: ["notes", "written by app A"],
			},
			previousDocumentWindow,
		);
		post(
			{ v: 1, kind: "alfy.storage", id: 2, method: "get", args: ["notes"] },
			previousDocumentWindow,
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(writeAppValue).not.toHaveBeenCalled();
		expect(readAppValue).not.toHaveBeenCalled();
	});

	it("a reply to a request the previous version's document made is never delivered to the reloaded document", async () => {
		restoreContentWindow = pinWindowProxyPerElement();
		let resolveRead: (value: unknown) => void = () => {};
		readAppValue.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRead = resolve;
				}),
		);
		const { container, rerender } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
		});
		post(
			{ v: 1, kind: "alfy.storage", id: 1, method: "get", args: ["k"] },
			getIframe(container).contentWindow as Window,
		);
		await vi.waitFor(() => expect(readAppValue).toHaveBeenCalled());

		await rerender({ artifactId: "app-1", version: 2 });
		const reloadedWindow = getIframe(container).contentWindow as Window;
		const reloadedPost = vi.spyOn(reloadedWindow, "postMessage");
		resolveRead({ ok: true, value: "the previous version's answer" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The reloaded document numbers its own requests from 1 again, so a
		// stale reply carrying id 1 would resolve ITS first read.
		expect(reloadedPost).not.toHaveBeenCalled();
	});

	it("after a new version replaces the frame, the new document's calls are served and answered", async () => {
		restoreContentWindow = pinWindowProxyPerElement();
		readAppValue.mockResolvedValue({ ok: true, value: "from version 2" });
		const { container, rerender } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
		});

		await rerender({ artifactId: "app-1", version: 2 });
		expect(container.querySelectorAll("iframe")).toHaveLength(1);
		const reloadedWindow = getIframe(container).contentWindow as Window;
		const reloadedPost = vi.spyOn(reloadedWindow, "postMessage");
		post(
			{ v: 1, kind: "alfy.storage", id: 1, method: "get", args: ["k"] },
			reloadedWindow,
		);

		await vi.waitFor(() =>
			expect(reloadedPost).toHaveBeenCalledWith(
				expect.objectContaining({ id: 1, ok: true, value: "from version 2" }),
				"*",
			),
		);
		expect(readAppValue).toHaveBeenCalledWith("app-1", "k", null);
	});

	it("removes its message listener on unmount, so a closed card cannot keep a channel open", async () => {
		readAppValue.mockResolvedValue({ ok: true, value: 1 });
		const { container, unmount } = render(AppFrame, {
			artifactId: "app-1",
			version: 1,
		});
		const iframe = getIframe(container);
		const source = iframe.contentWindow as Window;

		unmount();
		post(
			{ v: 1, kind: "alfy.storage", id: 5, method: "get", args: ["k"] },
			source,
		);
		await Promise.resolve();

		expect(readAppValue).not.toHaveBeenCalled();
	});
});

// RV-2A. Every accepted message is an authenticated request to the kv route
// (three scoped reads and, for a set, a transaction). Without a bound, one
// app — a buggy save loop or a hostile one — turns a burst of postMessage
// calls into as many concurrent requests, taking the browser's per-host
// connections from the chat itself and the server's time from everyone.
describe("AppFrame — a flood from the frame is bounded", () => {
	function flush(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	/** A controllable server: every call waits until the test releases it. */
	function holdEveryRead() {
		const waiting: Array<() => void> = [];
		let live = 0;
		let peak = 0;
		readAppValue.mockImplementation(() => {
			live += 1;
			peak = Math.max(peak, live);
			return new Promise((resolve) => {
				waiting.push(() => {
					live -= 1;
					resolve({ ok: true, value: null });
				});
			});
		});
		return {
			peak: () => peak,
			async releaseAll(): Promise<void> {
				while (waiting.length > 0) {
					for (const release of waiting.splice(0)) release();
					await flush();
				}
			},
		};
	}

	function burst(source: Window, count: number): void {
		for (let id = 1; id <= count; id += 1) {
			post(
				{ v: 1, kind: "alfy.storage", id, method: "get", args: [`key-${id}`] },
				source,
			);
		}
	}

	it("keeps only a few calls in flight at once, and still answers every call of a startup burst", async () => {
		const server = holdEveryRead();
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const source = getIframe(container).contentWindow as Window;
		const postSpy = vi.spyOn(source, "postMessage");

		// An app loading 200 per-item keys at start (the store's own key cap).
		burst(source, 200);
		await flush();
		expect(server.peak()).toBeLessThanOrEqual(8);

		await server.releaseAll();
		expect(readAppValue).toHaveBeenCalledTimes(200);
		expect(postSpy).toHaveBeenCalledTimes(200);
	});

	it("drops what a frame posts past a bounded backlog, with no server call and no reply for it", async () => {
		const server = holdEveryRead();
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const source = getIframe(container).contentWindow as Window;
		const postSpy = vi.spyOn(source, "postMessage");

		burst(source, 5_000);
		await flush();
		await server.releaseAll();

		const served = readAppValue.mock.calls.length;
		expect(served).toBeGreaterThanOrEqual(200);
		expect(served).toBeLessThanOrEqual(300);
		expect(postSpy).toHaveBeenCalledTimes(served);
	});
});
