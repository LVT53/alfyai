// An App's create call carries a BRIEF (what the app is for and does), never its
// HTML (LV's note, ruling 77). The tool text used to call the body "the HTML
// document", the real model sent its whole markup, the generator received that
// markup as its PROMPT, and version 1's summary was 500 characters of it. The App
// contract has always said the chat model does not write the markup
// (`artifacts/app/create.ts`: the generator is the only thing that does), so a body
// that is markup is refused, with the fix named. What counts as markup is decided
// once, here: for that refusal, and for a reader of the rows the old text left
// behind (History never prints a brief that is a document).
//
// Browser-safe, no imports.

const DOCUMENT_START =
	/^(?:```[a-z]*\s*)?(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i;
const TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi;
/** A brief names a tag or two in words ("a <button> that resets it"); a run of this many is markup. */
const RUN_OF_MARKUP = 5;

export function looksLikeHtml(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === "") return false;
	if (DOCUMENT_START.test(trimmed)) return true;
	return (trimmed.match(TAG)?.length ?? 0) >= RUN_OF_MARKUP;
}
