import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
	APP_BOOTSTRAP_SCRIPT,
	APP_READONLY_BOOTSTRAP_SCRIPT,
	injectAppBootstrap,
	injectReadOnlyAppBootstrap,
} from "./bootstrap";

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
function createSandbox(
	script = APP_BOOTSTRAP_SCRIPT,
	browserGlobals: Record<string, unknown> = {},
) {
	const messages: StorageMessage[] = [];
	const listeners: Array<(event: { data: unknown; source?: unknown }) => void> =
		[];
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
	// What the browser has on a window before any script runs: plain, writable,
	// configurable properties, which is what the bootstrap has to take away.
	Object.assign(sandboxWindow, browserGlobals);

	const context = vm.createContext({
		window: sandboxWindow,
		setTimeout: (fn: () => void) => {
			pendingTimers.push(fn);
			return pendingTimers.length;
		},
	});
	vm.runInContext(script, context);

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
		// Real replies arrive FROM the parent: inside the iframe document this
		// script runs in, `event.source` on an incoming message is always the
		// window that sent it — the parent, i.e. `window.parent` as this
		// document sees it. The sandbox aliases `parent` to itself, so that is
		// the default `source` here; a test can pass a different object to
		// simulate a reply arriving from anything else.
		deliverReply: (
			reply: Record<string, unknown>,
			source: unknown = sandboxWindow.parent,
		) => {
			for (const listener of listeners) listener({ data: reply, source });
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

	// Ruling 58, RV-2A open question 4 (hardening): unreachable today (the App
	// can open no popup or nested frame under its own sandbox), but the
	// listener should not rely on that alone — a window holding a reference to
	// the App's frame must not be able to resolve its pending promises with a
	// forged value.
	it("ignores a reply whose source is not window.parent, even with a matching id and kind", async () => {
		const { window, messages, deliverReply } = createSandbox();
		const promise = window.alfy.storage.get("my-key");
		const request = messages[0];
		const impostor = { not: "the parent" };

		deliverReply(
			{
				v: 1,
				kind: "alfy.storage.result",
				id: request.id,
				ok: true,
				value: "forged",
			},
			impostor,
		);
		deliverReply({
			v: 1,
			kind: "alfy.storage.result",
			id: request.id,
			ok: true,
			value: "from the real parent",
		});

		await expect(promise).resolves.toBe("from the real parent");
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
	const TAG = `<script>${APP_BOOTSTRAP_SCRIPT}</script>`;

	it("puts the bootstrap first: nothing of the document comes before it", () => {
		const html = "<html><head><title>x</title></head><body>hi</body></html>";
		expect(injectAppBootstrap(html)).toBe(`${TAG}${html}`);
	});

	it("keeps a leading doctype first by copying it ahead of the bootstrap, and leaves the document's own bytes alone", () => {
		const html =
			'<!DOCTYPE html>\n<html lang="en"><meta charset="utf-8"><title>t</title><script>var hasBridge = !!window.alfy;</script><h1>x</h1>';
		const injected = injectAppBootstrap(html);

		// Anything but whitespace or a comment before the doctype makes the parser
		// ignore it and render in quirks mode (Chromium's compatMode reads
		// "BackCompat"), so the doctype is said first; the document's own copy of it
		// then comes after a script and is ignored, which a parser does without a
		// word. Nothing the document wrote is moved or removed.
		expect(injected).toBe(`<!DOCTYPE html>${TAG}${html}`);
		expect(injected.indexOf(APP_BOOTSTRAP_SCRIPT)).toBeLessThan(
			injected.indexOf("var hasBridge"),
		);
	});

	it("copies a doctype that follows whitespace and comments, as a browser reads it", () => {
		const html =
			'\n <!-- a --> <!doctype html PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<p>x</p>';
		expect(injectAppBootstrap(html)).toBe(
			`<!doctype html PUBLIC "-//W3C//DTD HTML 4.01//EN">${TAG}${html}`,
		);
	});

	it.each([
		["a plain comment", "<!-- <!doctype html> --><p>x</p>"],
		["a script before it", "<script>1</script><!doctype html><p>x</p>"],
		["a text node before it", "x <!doctype html><p>x</p>"],
		["a doctype that never ends", "<!doctype html"],
		["a comment that never ends", "<!-- <!doctype html>"],
		["no doctype at all", "<p>x</p>"],
	])("copies no doctype when %s", (_name, html) => {
		expect(injectAppBootstrap(html)).toBe(`${TAG}${html}`);
	});

	it("copies no doctype that is unreasonably long", () => {
		const html = `<!doctype ${"a".repeat(4_000)}><p>x</p>`;
		expect(injectAppBootstrap(html)).toBe(`${TAG}${html}`);
	});

	// ADR-0068 / the Opus review's I-1: the bootstrap was spliced after the first
	// `<head` anywhere in the text, so a script placed before that point, or a
	// `<head>` mentioned in a comment or a string, ran first. The bootstrap is
	// first whatever comes before the document's real beginning.
	it.each([
		[
			"a script ahead of <head>",
			"<!doctype html><script>1</script><head></head>",
		],
		[
			"the word <head> in a comment",
			"<!-- <head> --><script>1</script><head></head>",
		],
		[
			"the word <head> in a string",
			'<script>var x = "<head>"</script><head></head>',
		],
		["a head-less, body-less document", "<script>1</script>"],
		["an upper-case HEAD", "<!DOCTYPE html><HTML><HEAD></HEAD></HTML>"],
		[
			"an empty comment, then a script",
			"<!--><script>1</script><!-- --><!doctype html>",
		],
		[
			"a three-dash empty comment",
			"<!---><script>1</script><!-- --><!doctype html>",
		],
		[
			"a bang-closed comment",
			"<!-- x --!><script>1</script> --><!doctype html>",
		],
		["an unclosed head tag", "<head <script>1</script>"],
	])("is first for %s", (_name, html) => {
		const injected = injectAppBootstrap(html);
		const doctypeCopy = injected.slice(0, injected.indexOf(TAG));
		// Only a doctype can stand in front of the bootstrap, and only when it was
		// the document's very first thing; it holds no markup that runs.
		expect(doctypeCopy === "" || /^<!doctype[^<>]*>$/i.test(doctypeCopy)).toBe(
			true,
		);
		expect(injected.endsWith(html)).toBe(true);
	});

	it("reads a comment's end the way the tokenizer does, so the doctype it finds is the one the browser sees", () => {
		// `<!-->` and `<!--->` are whole comments; `--!>` closes one; `-->` inside a
		// longer run of dashes does too.
		for (const [html, copies] of [
			["<!--><!doctype html>", true],
			["<!---><!doctype html>", true],
			["<!-- x --!><!doctype html>", true],
			["<!-- x ---><!doctype html>", true],
			["<!----><!doctype html>", true],
			["<!-- x --!--><!doctype html>", true],
			["<!-- x -- ><!doctype html>", false],
			["<!-- x --!<!doctype html>", false],
		] as const) {
			const injected = injectAppBootstrap(html);
			expect(injected.startsWith("<!doctype html><script>"), html).toBe(copies);
		}
	});

	it("is a pure string splice: it never reads anything out of the artifact's own html to build the tag", () => {
		const html =
			"<head><script>window.parent = null;</script></head><body></body>";
		const injected = injectAppBootstrap(html);
		// The bootstrap tag itself is byte-identical regardless of what the
		// artifact's own document contains.
		expect(injected).toContain(TAG);
	});

	// RV-2A. This runs on EVERY request for an App, over model-authored text:
	// a splice point found by backtracking lets one stored body stall the
	// server's event loop each time anyone opens it. Every input below is
	// finished in well under a millisecond by a linear scan; the thresholds
	// are hundreds of times that, so a slow shared machine cannot flip them.
	it("finds its splice point without backtracking over a run of comments", () => {
		const html = `${"<!---->".repeat(36)}x`;
		const started = performance.now();
		injectAppBootstrap(html);
		expect(performance.now() - started).toBeLessThan(250);
	});

	it("reads a long run of dashes, and of short comments, in linear time", () => {
		const started = performance.now();
		injectAppBootstrap(`<!--${"-".repeat(500_000)}x`);
		injectAppBootstrap(`<!--${"--!".repeat(200_000)}`);
		injectAppBootstrap("<!-->".repeat(100_000));
		injectAppBootstrap("<!---".repeat(100_000));
		injectAppBootstrap(`${" ".repeat(500_000)}<p>`);
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("finds its splice point without rescanning the document for every unclosed tag", () => {
		const html = "<head ".repeat(32_000);
		const started = performance.now();
		injectAppBootstrap(html);
		expect(performance.now() - started).toBeLessThan(250);
	});
});

// ADR-0068. Chromium's CSP does not govern WebRTC, so the App's own realm loses
// the constructors before any of its code runs, and a frame the App makes
// itself (a window of its own, a fresh `RTCPeerConnection`) is kept from
// existing: Trusted Types with a default policy that refuses every string that
// would make one. The browser measurement is tests/e2e/app-webrtc-guard.spec.ts.
describe("APP_BOOTSTRAP_SCRIPT: no WebRTC, no frame with content", () => {
	const REMOVED = [
		"RTCPeerConnection",
		"webkitRTCPeerConnection",
		"mozRTCPeerConnection",
		"RTCDataChannel",
		"XSLTProcessor",
		"documentPictureInPicture",
	];
	const present = () =>
		Object.fromEntries(REMOVED.map((name) => [name, function Native() {}]));

	function descriptorOf(window: object, name: string) {
		return Object.getOwnPropertyDescriptor(window, name);
	}

	it.each(
		REMOVED,
	)("%s is undefined, cannot be written, redefined or deleted", (name) => {
		const { window } = createSandbox(APP_BOOTSTRAP_SCRIPT, present());
		expect(descriptorOf(window, name)).toEqual({
			value: undefined,
			writable: false,
			enumerable: false,
			configurable: false,
		});
		expect(() =>
			Object.defineProperty(window, name, { value: function Other() {} }),
		).toThrow(TypeError);
		expect(() => {
			(window as unknown as Record<string, unknown>)[name] =
				function Other() {};
		}).toThrow(TypeError);
		expect(Reflect.deleteProperty(window, name)).toBe(false);
		expect((window as unknown as Record<string, unknown>)[name]).toBe(
			undefined,
		);
	});

	it("names a constructor the browser does not have as undefined too, so nothing is left to be defined later", () => {
		const { window } = createSandbox(APP_BOOTSTRAP_SCRIPT, {});
		expect(descriptorOf(window, "mozRTCPeerConnection")?.configurable).toBe(
			false,
		);
	});

	it("does this before anything else the bootstrap does, in the read-only bridge as well", () => {
		for (const script of [
			APP_BOOTSTRAP_SCRIPT,
			APP_READONLY_BOOTSTRAP_SCRIPT,
		]) {
			expect(script.indexOf("RTCPeerConnection")).toBeGreaterThan(-1);
			expect(script.indexOf("RTCPeerConnection")).toBeLessThan(
				script.indexOf("alfy.storage"),
			);
			const { window } = createSandbox(script, present());
			expect(descriptorOf(window, "RTCPeerConnection")?.configurable).toBe(
				false,
			);
		}
	});

	describe("the default Trusted Types policy", () => {
		type Callbacks = {
			createHTML: (html: string, type: string, sink: string) => string;
			createScript: (script: string, type: string, sink: string) => string;
			createScriptURL: (url: string, type: string, sink: string) => string;
		};

		function withPolicy(script = APP_BOOTSTRAP_SCRIPT) {
			const created: Array<{ name: string; callbacks: Callbacks }> = [];
			createSandbox(script, {
				trustedTypes: {
					createPolicy: (name: string, callbacks: Callbacks) => {
						created.push({ name, callbacks });
						return callbacks;
					},
				},
			});
			expect(created).toHaveLength(1);
			expect(created[0].name).toBe("default");
			return created[0].callbacks;
		}
		const html = (
			policy: Callbacks,
			text: string,
			sink = "Element innerHTML",
		) => policy.createHTML(text, "TrustedHTML", sink);

		it("passes the markup an app is written with, unchanged", () => {
			const policy = withPolicy();
			for (const text of [
				"<li>a</li><li>b</li>",
				"<button onclick='go()'>x</button>",
				"<svg><circle r=1></circle></svg>",
				"<p>an iframe is a frame</p>",
				"&lt;iframe&gt;",
				"<iframes></iframes><framework></framework>",
				"",
			]) {
				expect(html(policy, text)).toBe(text);
			}
		});

		it.each([
			["an iframe", '<iframe srcdoc="x"></iframe>'],
			["an IFRAME", "<IFRAME></IFRAME>"],
			[
				"an iframe inside svg",
				"<svg><foreignObject><iframe></iframe></foreignObject></svg>",
			],
			["a frameset", "<frameset></frameset>"],
			["a frame", "<frame src=x>"],
			["an object", "<object data=x></object>"],
			["an embed", "<embed src=x>"],
			["a slash after the name", "<iframe/srcdoc=x>"],
			["a fencedframe", "<fencedframe>"],
			["a portal", "<portal src=x>"],
		])("refuses %s in any markup sink", (_name, text) => {
			const policy = withPolicy();
			for (const sink of [
				"Element innerHTML",
				"Element outerHTML",
				"Element insertAdjacentHTML",
				"Range createContextualFragment",
				"DOMParser parseFromString",
				"Element setHTMLUnsafe",
				"ShadowRoot setHTMLUnsafe",
				"Document parseHTMLUnsafe",
				"Document execCommand",
				"Document write",
				"Document writeln",
			]) {
				expect(() => html(policy, text, sink), sink).toThrow(/An app cannot/);
			}
		});

		it("refuses a document for a frame, however harmless, because the sink is the frame's own", () => {
			const policy = withPolicy();
			expect(() =>
				html(policy, "<p>hi</p>", "HTMLIFrameElement srcdoc"),
			).toThrow(/An app cannot/);
			expect(() => html(policy, "", "HTMLIFrameElement srcdoc")).toThrow(
				/An app cannot/,
			);
		});

		// What a parser does with `document.write` is to put the text in front of
		// the rest of the document, so a tag can be begun by a write and ended by
		// the next write or by the markup that follows the script. A write that
		// ends where a frame's name could be going is refused, which is every way of
		// splitting one.
		it.each([
			"<",
			"<i",
			"<if",
			"<ifr",
			"<ifra",
			"<ifram",
			"<iframe",
			"<IFRA",
			"<o",
			"<ob",
			"<em",
			"<embe",
			"<f",
			"<fr",
			"<frames",
			"<fe",
			"<fenced",
			"<fencedframe",
			"<p",
			"<port",
			"text <i",
		])("refuses a write that ends in %s, where the rest of a frame tag could come from the next write or from the document", (text) => {
			const policy = withPolicy();
			expect(() => html(policy, text, "Document write")).toThrow(
				/An app cannot/,
			);
			expect(() => html(policy, text, "Document writeln")).toThrow(
				/An app cannot/,
			);
		});

		it("allows that same ending in a sink that has no 'next' to continue it", () => {
			const policy = withPolicy();
			expect(html(policy, "a <i", "Element innerHTML")).toBe("a <i");
		});

		it("lets an ordinary write through", () => {
			const policy = withPolicy();
			expect(html(policy, "<p id=w>written</p>", "Document write")).toBe(
				"<p id=w>written</p>",
			);
			expect(html(policy, "1 < 2 and more", "Document write")).toBe(
				"1 < 2 and more",
			);
		});

		it("passes scripts and script URLs through: the CSP decides those", () => {
			const policy = withPolicy();
			expect(
				policy.createScript("go()", "TrustedScript", "Element onclick"),
			).toBe("go()");
			expect(
				policy.createScriptURL(
					"a.js",
					"TrustedScriptURL",
					"HTMLScriptElement src",
				),
			).toBe("a.js");
		});

		it("is made in the read-only bridge as well", () => {
			withPolicy(APP_READONLY_BOOTSTRAP_SCRIPT);
		});

		it("does nothing, and does not throw, in a browser with no Trusted Types", () => {
			expect(() => createSandbox(APP_BOOTSTRAP_SCRIPT, {})).not.toThrow();
		});

		it("does not throw if the browser refuses the policy; the bridge still comes up", () => {
			const { window } = createSandbox(APP_BOOTSTRAP_SCRIPT, {
				trustedTypes: {
					createPolicy: () => {
						throw new TypeError("Policy with name default already exists.");
					},
				},
			});
			expect(typeof window.alfy.storage.get).toBe("function");
		});
	});
});

// Ruling 76 (Q7): a saved version shown in History runs against today's saved
// data and leaves it alone.
describe("APP_READONLY_BOOTSTRAP_SCRIPT — a saved version's bridge", () => {
	it("is the writing bridge but for `set`, so the two cannot drift", () => {
		const writing = APP_BOOTSTRAP_SCRIPT.split("\n");
		const readOnly = APP_READONLY_BOOTSTRAP_SCRIPT.split("\n");
		expect(readOnly).toHaveLength(writing.length);
		const differing = writing.filter((line, index) => line !== readOnly[index]);
		expect(differing).toHaveLength(1);
		expect(differing[0]).toContain("set:");
	});

	it("still reads today's value from the parent, exactly as the writing bridge does", async () => {
		const { window, messages, deliverReply } = createSandbox(
			APP_READONLY_BOOTSTRAP_SCRIPT,
		);
		const pending = window.alfy.storage.get("tips");
		expect(messages).toEqual([
			{ v: 1, kind: "alfy.storage", id: 1, method: "get", args: ["tips"] },
		]);
		deliverReply({
			v: 1,
			kind: "alfy.storage.result",
			id: 1,
			ok: true,
			value: 12,
		});
		await expect(pending).resolves.toBe(12);
	});

	it("rejects `set` at once and sends nothing to the parent", async () => {
		const { window, messages } = createSandbox(APP_READONLY_BOOTSTRAP_SCRIPT);
		await expect(window.alfy.storage.set("tips", 12)).rejects.toThrow(
			/read.?only/i,
		);
		expect(messages).toEqual([]);
	});

	// RV-V M-6: an App that shows the error it caught shows THIS to a reader, whatever
	// their language, and the served document cannot know it. A code is not an English
	// sentence a Hungarian reader meets.
	it("refuses with a code, not a sentence in English", async () => {
		const { window } = createSandbox(APP_READONLY_BOOTSTRAP_SCRIPT);
		const refusal = await window.alfy.storage
			.set("tips", 12)
			.catch((error: Error) => error);
		// (An Error of the sandbox's own realm: its name and message are what an App reads.)
		expect((refusal as Error).name).toBe("Error");
		expect((refusal as Error).message).toBe("ALFY_STORAGE_READ_ONLY");
		expect(APP_READONLY_BOOTSTRAP_SCRIPT).not.toMatch(/saved version/);
	});

	it("cannot be replaced or removed by the App", () => {
		const { window } = createSandbox(APP_READONLY_BOOTSTRAP_SCRIPT);
		const original = window.alfy.storage.set;
		try {
			window.alfy = {
				storage: { get: () => Promise.resolve(), set: () => Promise.resolve() },
			};
		} catch {
			// strict mode throws; sloppy mode no-ops: either is correct
		}
		expect(window.alfy.storage.set).toBe(original);
		let deleted: boolean | undefined;
		try {
			deleted = delete (window as unknown as { alfy?: unknown }).alfy;
		} catch {
			deleted = false;
		}
		expect(deleted).not.toBe(true);
	});

	it("is spliced in where the writing bridge goes, and never both", () => {
		const html =
			"<!doctype html><html><head><title>t</title></head><body>x</body></html>";
		const readOnly = injectReadOnlyAppBootstrap(html);
		expect(readOnly).toBe(
			`<!doctype html><script>${APP_READONLY_BOOTSTRAP_SCRIPT}</script>${html}`,
		);
		expect(readOnly).not.toContain(APP_BOOTSTRAP_SCRIPT);
		expect(injectAppBootstrap(html)).not.toContain(
			APP_READONLY_BOOTSTRAP_SCRIPT,
		);
		// A document with no head, no body and no doctype gets it first.
		expect(injectReadOnlyAppBootstrap("<p>x</p>").startsWith("<script>")).toBe(
			true,
		);
	});
});
