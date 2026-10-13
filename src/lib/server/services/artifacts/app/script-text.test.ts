import { describe, expect, it } from "vitest";
import { foldScriptText } from "./script-text";

describe("foldScriptText", () => {
	it.each([
		[
			"joined literals",
			'window["RTC" + "PeerConnection"]',
			"RTCPeerConnection",
		],
		[
			"joined with mixed quotes",
			"window['RTC' + \"Peer\" + `Connection`]",
			"RTCPeerConnection",
		],
		[
			"joined across a gap",
			'x["RTC"   +   "Peer" +"Connection"]',
			"RTCPeerConnection",
		],
		["a unicode escape", "new \\u0052TCPeerConnection()", "RTCPeerConnection"],
		[
			"a braced unicode escape",
			"new \\u{52}TCPeerConnection()",
			"RTCPeerConnection",
		],
		["a hex escape", "new \\x52TCPeerConnection()", "RTCPeerConnection"],
		[
			"character codes",
			"window[String.fromCharCode(82, 84, 67, 80, 101, 101, 114)]",
			"RTCPeer",
		],
		[
			"a base64 literal",
			'window[atob("UlRDUGVlckNvbm5lY3Rpb24=")]',
			"RTCPeerConnection",
		],
		[
			"a joined list",
			'window[["RTC", "Peer", "Connection"].join("")]',
			"RTCPeerConnection",
		],
	])("undoes %s", (_name, source, expected) => {
		expect(foldScriptText(source)).toContain(expected);
	});

	it("leaves text without those tricks as it was", () => {
		const text =
			"<p>Peer connection tips</p><script>var a = 'x'; var b = 1 + 2;</script>";
		expect(foldScriptText(text)).toBe(text);
	});

	it("does not turn an addition of numbers or variables into a join", () => {
		expect(foldScriptText("var s = a + b + 'x'")).toBe("var s = a + b + 'x'");
	});

	it("leaves an out-of-range escape and a binary base64 literal alone", () => {
		expect(foldScriptText("\\u{110000}")).toBe("\\u{110000}");
		expect(foldScriptText('atob("AAECAwQFBgc=")')).toBe('atob("AAECAwQFBgc=")');
	});

	it("is linear on text made to cost time", () => {
		const started = performance.now();
		foldScriptText(`"${" ".repeat(200_000)}x`);
		foldScriptText("[".repeat(100_000));
		foldScriptText("atob(".repeat(50_000));
		foldScriptText(`"+"`.repeat(100_000));
		foldScriptText("\\u00".repeat(100_000));
		foldScriptText(`String.fromCharCode(${"1,".repeat(300)}`.repeat(200));
		expect(performance.now() - started).toBeLessThan(800);
	});
});
