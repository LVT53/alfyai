/**
 * A CSS identifier read the way a browser reads it: an escape is the character it
 * names, so `\75rl(` is `url(` and `\u\r\l(` is too. A scan for a word in CSS text
 * that does not undo them is a scan a source can step around, which is why the
 * diagram gates (`html-sanitizer.ts`, `shared/artifacts/mermaid-source.ts`) read
 * through this one. A leaf, with no imports, so the page that has the sanitizer
 * does not also load what only a diagram needs.
 *
 * `css` with every escape in it undone: a hex escape takes the one space that may
 * end it, `\0` and a code point past the last one are the replacement character.
 */
export function decodeCssEscapes(css: string): string {
	return css.replace(
		/\\(?:([0-9A-Fa-f]{1,6})[ \t\n\r\f]?|([^\n\r\f0-9A-Fa-f]))/g,
		(_escape, hex?: string, char?: string) =>
			hex
				? String.fromCodePoint(
						Math.min(Number.parseInt(hex, 16) || 0xfffd, 0x10ffff),
					)
				: (char ?? ""),
	);
}
