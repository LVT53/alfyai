import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
	vi.clearAllMocks();
	uiLanguage.set("en");
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("AppFrame — the sandbox and the served route", () => {
	it("renders the iframe with the sandbox attribute EXACTLY allow-scripts", () => {
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);
		expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
	});

	it("never carries allow-same-origin or any other sandbox token", () => {
		const { container } = render(AppFrame, { artifactId: "app-1", version: 1 });
		const iframe = getIframe(container);
		expect(iframe.getAttribute("sandbox")).not.toMatch(/allow-same-origin/);
		expect(iframe.getAttribute("sandbox")?.split(/\s+/)).toEqual([
			"allow-scripts",
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

		expect(readAppValue).toHaveBeenCalledWith("the-real-id", "k");
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

		expect(writeAppValue).toHaveBeenCalledWith("app-1", "k", { a: 1 });
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
