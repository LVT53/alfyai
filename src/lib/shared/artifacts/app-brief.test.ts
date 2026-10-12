import { describe, expect, it } from "vitest";
import { looksLikeHtml } from "./app-brief";

// LV's note (ruling 77): an App's create call carries a BRIEF, never its HTML. The
// tool text said "Apps: the HTML document", the real model sent its whole markup,
// and the generator received that markup as its prompt. What counts as markup is
// said once, here, for the tool's refusal and for the History reader of old rows.
describe("looksLikeHtml", () => {
	it.each([
		'<!DOCTYPE html>\n<html lang="en"><head><title>Tip</title></head><body></body></html>',
		"<!doctype html><html><body><h1>Tip calculator</h1></body></html>",
		'  <html lang="hu">\n<body>Borravaló</body></html>',
		"```html\n<!doctype html>\n<html><body>x</body></html>\n```",
		'<div class="a"><h1>T</h1><p>one</p><p>two</p><button>go</button><span>x</span></div>',
	])("is true for a document or a run of markup: %s", (text) => {
		expect(looksLikeHtml(text)).toBe(true);
	});

	it.each([
		"A tip calculator: enter the bill and the percentage, see the tip and the total.",
		"Borravaló-kalkulátor: add meg a számlát és a százalékot, és mutasd a borravalót.",
		"A page with a <button> that resets the form and a <table> of results.",
		"",
		"   ",
	])("is false for a brief in words, even one that names a tag: %s", (text) => {
		expect(looksLikeHtml(text)).toBe(false);
	});
});
