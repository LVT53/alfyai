// What an App's script says once the cheap ways of not saying a word are undone.
//
// The audit looks for names (`RTCPeerConnection`, `createElement("iframe")`) and
// a model that has been told not to write one has a handful of obvious ways to
// write it anyway: split it into pieces, spell a letter as an escape, build it
// from character codes, decode it. This folds those back into plain text so the
// audit's pattern sees them. It is the audit's SECOND layer, for the generator
// to read and fix; it is not what holds the line, because no static reading of
// code can (a name can be built from anything the code computes). The bootstrap
// is what holds it, in the browser, and `app-webrtc-guard.spec.ts` measures that.
//
// Every pattern is bounded, so a document made to cost time costs a few
// milliseconds: the audit runs on every App a model writes.

const QUOTE = "[\"'`]";
const GAP = "\\s{0,64}";

function fromCodePoint(code: number, original: string): string {
	return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
		? String.fromCodePoint(code)
		: original;
}

/** A base64 literal's text, or the original when it does not decode to something readable. */
function decodeBase64(encoded: string, original: string): string {
	const decoded = Buffer.from(encoded, "base64").toString("latin1");
	return /^[\x20-\x7e]{1,300}$/.test(decoded) ? `"${decoded}"` : original;
}

export function foldScriptText(text: string): string {
	return (
		text
			// "RTC", "\u{52}TC", "\x52TC"
			.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (match, hex: string) =>
				fromCodePoint(Number.parseInt(hex, 16), match),
			)
			.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex: string) =>
				fromCodePoint(Number.parseInt(hex, 16), match),
			)
			.replace(/\\x([0-9a-fA-F]{2})/g, (match, hex: string) =>
				fromCodePoint(Number.parseInt(hex, 16), match),
			)
			// String.fromCharCode(82, 84, 67)
			.replace(
				/String\s*\.\s*fromCharCode\s*\(([\d\s,]{1,600})\)/g,
				(match, list: string) => {
					const codes = list.split(",").map((part) => Number(part.trim()));
					return codes.every((code) => Number.isInteger(code))
						? `"${codes.map((code) => fromCodePoint(code, "?")).join("")}"`
						: match;
				},
			)
			// atob("UlRDUGVlckNvbm5lY3Rpb24=")
			.replace(
				new RegExp(
					`atob${GAP}\\(${GAP}${QUOTE}([A-Za-z0-9+/]{4,400}={0,2})${QUOTE}${GAP}\\)`,
					"g",
				),
				(match, encoded: string) => decodeBase64(encoded, match),
			)
			// ["RTC", "PeerConnection"].join("")
			.replace(
				new RegExp(
					`\\[${GAP}((?:${QUOTE}[^"'\`]{0,40}${QUOTE}${GAP},${GAP}){0,12}${QUOTE}[^"'\`]{0,40}${QUOTE})${GAP}\\]${GAP}\\.${GAP}join${GAP}\\(${GAP}(?:""|''|\`\`)${GAP}\\)`,
					"g",
				),
				(_match, items: string) =>
					`"${[...items.matchAll(/["'`]([^"'`]{0,40})["'`]/g)]
						.map((item) => item[1])
						.join("")}"`,
			)
			// "RTC" + "PeerConnection"
			.replace(new RegExp(`${QUOTE}${GAP}\\+${GAP}${QUOTE}`, "g"), "")
	);
}
