import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html-sanitizer";

describe("html utilities", () => {
	it("escapes HTML-sensitive characters with the default apostrophe entity", () => {
		expect(escapeHtml(`Tom & "Jerry" <'tag'>`)).toBe(
			"Tom &amp; &quot;Jerry&quot; &lt;&#39;tag&#39;&gt;",
		);
	});

	it("preserves legacy apostrophe entity spelling when requested", () => {
		expect(escapeHtml(`it's`, { apostropheEntity: "&#039;" })).toBe(
			"it&#039;s",
		);
	});
});
