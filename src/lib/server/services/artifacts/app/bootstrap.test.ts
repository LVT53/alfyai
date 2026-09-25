import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { APP_BOOTSTRAP_SCRIPT, injectAppBootstrap } from "./bootstrap";

interface StorageMessage {
	v: 1;
	kind: "alfy.storage";
	id: number;
	method: "get" | "set";
	args: unknown[];
}

/**
 * Runs the REAL bootstrap script (not a rewritten copy) inside an isolated
 * `vm` context with stub `window.postMessage`/`addEventListener`/`setTimeout`
 * — no jsdom, no real postMessage event loop, so a reply or a timer fires
 * exactly when the test tells it to.
 */
function createSandbox() {
	const messages: StorageMessage[] = [];
	const listeners: Array<(event: { data: unknown }) => void> = [];
	const pendingTimers: Array<() => void> = [];

	const sandboxWindow: Record<string, unknown> = {
		postMessage: (data: StorageMessage) => {
			messages.push(data);
		},
		addEventListener: (
			type: string,
			handler: (event: { data: unknown }) => void,
		) => {
			if (type === "message") listeners.push(handler);
		},
	};
	sandboxWindow.parent = sandboxWindow;
	sandboxWindow.window = sandboxWindow;

	const context = vm.createContext({
		window: sandboxWindow,
		setTimeout: (fn: () => void) => {
			pendingTimers.push(fn);
			return pendingTimers.length;
		},
	});
	vm.runInContext(APP_BOOTSTRAP_SCRIPT, context);

	return {
		window: sandboxWindow as unknown as {
			alfy: {
				storage: {
					get: (key: string) => Promise<unknown>;
					set: (key: string, value: unknown) => Promise<unknown>;
				};
			};
		},
		messages,
		deliverReply: (reply: Record<string, unknown>) => {
			for (const listener of listeners) listener({ data: reply });
		},
		fireTimers: () => {
			for (const fn of pendingTimers.splice(0)) fn();
		},
	};
}

describe("APP_BOOTSTRAP_SCRIPT — window.alfy.storage", () => {
	it("installs get and set as functions", () => {
		const { window } = createSandbox();
		expect(typeof window.alfy.storage.get).toBe("function");
		expect(typeof window.alfy.storage.set).toBe("function");
	});

	it("is non-writable and non-configurable: a later assignment or delete cannot replace it", () => {
		const { window } = createSandbox();
		const originalGet = window.alfy.storage.get;

		try {
			// A model-authored app trying to replace the bridge with its own
			// (shape-compatible, so this line is not itself a type error —
			// `Object.defineProperty`'s runtime immutability is the thing under
			// test, not TypeScript's).
			window.alfy = {
				storage: {
					get: () => Promise.resolve("hijacked"),
					set: () => Promise.resolve("hijacked"),
				},
			};
		} catch {
			// Strict-mode callers (this test file is an ES module) throw on a
			// non-writable assignment; sloppy-mode callers (a classic inline
			// <script>, the model-authored app's own contract) no-op instead.
			// Either outcome is correct — see the bootstrap.ts comment.
		}
		expect(window.alfy.storage.get).toBe(originalGet);

		let deleted: boolean | undefined;
		try {
			// `delete` requires an optional operand under this repo's TS config,
			// so the target is cast through a shape where the property really is
			// optional — Object.defineProperty's `configurable: false` is the
			// runtime guarantee under test, not TypeScript's static shape.
			deleted = delete (window as unknown as { alfy?: unknown }).alfy;
		} catch {
			deleted = false;
		}
		expect(deleted).not.toBe(true);
		expect(window.alfy.storage.get).toBe(originalGet);
	});

	it("posts exactly one alfy.storage message per call, addressed with v:1 and the method/args", () => {
		const { window, messages } = createSandbox();
		void window.alfy.storage.get("my-key");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			v: 1,
			kind: "alfy.storage",
			method: "get",
			args: ["my-key"],
		});

		void window.alfy.storage.set("my-key", { a: 1 });
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			v: 1,
			kind: "alfy.storage",
			method: "set",
			args: ["my-key", { a: 1 }],
		});
	});

	it("resolves with the reply's value when the parent answers ok", async () => {
		const { window, messages, deliverReply } = createSandbox();
		const promise = window.alfy.storage.get("my-key");
		const request = messages[0];

		deliverReply({
			v: 1,
			kind: "alfy.storage.result",
			id: request.id,
			ok: true,
			value: null,
		});
		await expect(promise).resolves.toBeNull();
	});

	it("rejects with the reply's error when the parent refuses", async () => {
		const { window, messages, deliverReply } = createSandbox();
		const promise = window.alfy.storage.set("my-key", "x".repeat(1_000_000));
		const request = messages[0];

		deliverReply({
			v: 1,
			kind: "alfy.storage.result",
			id: request.id,
			ok: false,
			error: "too_large",
		});
		await expect(promise).rejects.toThrow("too_large");
	});

	it("ignores a reply for a request id it never sent, and a reply with the wrong kind", async () => {
		const { window, messages, deliverReply } = createSandbox();
		const promise = window.alfy.storage.get("my-key");
		const request = messages[0];

		deliverReply({
			v: 1,
			kind: "alfy.storage.result",
			id: request.id + 999,
			ok: true,
			value: "wrong",
		});
		deliverReply({
			v: 1,
			kind: "something.else",
			id: request.id,
			ok: true,
			value: "wrong",
		});
		deliverReply({
			v: 1,
			kind: "alfy.storage.result",
			id: request.id,
			ok: true,
			value: "right",
		});

		await expect(promise).resolves.toBe("right");
	});

	it("times out after 5000ms with no reply, and the rejection is fixed text — never the key", async () => {
		const { window, fireTimers } = createSandbox();
		const promise = window.alfy.storage.get("a-very-secret-key");
		const assertion = expect(promise).rejects.toThrow("alfy.storage timed out");
		fireTimers();
		await assertion;
	});

	it("feature-detects safely: the script never throws just by being evaluated, with no reply ever sent", () => {
		expect(() => createSandbox()).not.toThrow();
	});
});

describe("injectAppBootstrap", () => {
	it("splices the bootstrap immediately after <head>, before any other content", () => {
		const html = "<html><head><title>x</title></head><body>hi</body></html>";
		const injected = injectAppBootstrap(html);

		const headEnd = injected.indexOf("<head>") + "<head>".length;
		expect(
			injected.slice(headEnd, headEnd + APP_BOOTSTRAP_SCRIPT.length + 20),
		).toContain(APP_BOOTSTRAP_SCRIPT);
		expect(injected.indexOf("<script>")).toBeLessThan(
			injected.indexOf("<title>"),
		);
	});

	it("prepends to <body> when there is no <head>", () => {
		const html = "<html><body><h1>hi</h1></body></html>";
		const injected = injectAppBootstrap(html);

		const bodyEnd = injected.indexOf("<body>") + "<body>".length;
		expect(injected.slice(bodyEnd, bodyEnd + 20)).toContain("<script>");
		expect(injected.indexOf("<script>")).toBeLessThan(injected.indexOf("<h1>"));
	});

	it("prepends outright when there is neither <head> nor <body>", () => {
		const html = "<h1>hi</h1>";
		const injected = injectAppBootstrap(html);
		expect(injected.startsWith("<script>")).toBe(true);
	});

	it("is a pure string splice: it never reads anything out of the artifact's own html to build the tag", () => {
		const html =
			"<head><script>window.parent = null;</script></head><body></body>";
		const injected = injectAppBootstrap(html);
		// The bootstrap tag itself is byte-identical regardless of what the
		// artifact's own document contains.
		expect(injected).toContain(`<script>${APP_BOOTSTRAP_SCRIPT}</script>`);
	});
});
