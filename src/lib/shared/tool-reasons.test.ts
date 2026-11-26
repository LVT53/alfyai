import { describe, expect, it } from "vitest";
import {
	ATLAS_ERROR_CODES,
	CONNECTOR_PLACEHOLDER_TITLES,
	CONNECTOR_REASON_CODES,
	CONNECTOR_TOOL_NAMES,
	DISPLAY_OUTPUT_KEY,
	DISPLAY_OUTPUT_MAX_CHARS,
	DISPLAY_OUTPUT_MAX_LINES,
	IMAGE_DERIVED_CODES,
	IMAGE_ERROR_CODES,
	IMAGE_REFUSAL_CODES,
	LOCATION_AT_PREFIX,
	REASON_CODE_KEY,
	REASON_PLACE_KEY,
	SHARED_REASON_CODES,
	TOOL_REASON_CODES,
	VIDEO_ERROR_CODES,
} from "./tool-reasons";

// The closed lists every tool names its outcomes from. The browser's words are
// checked against these lists (`tool-reason-words.test.ts`), so a malformed or
// repeated entry here would put a hole in that check.

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

const LISTS: Record<string, readonly string[]> = {
	shared: SHARED_REASON_CODES,
	connector: CONNECTOR_REASON_CODES,
	image_refusal: IMAGE_REFUSAL_CODES,
	image_error: IMAGE_ERROR_CODES,
	image_derived: IMAGE_DERIVED_CODES,
	video_error: VIDEO_ERROR_CODES,
	atlas_error: ATLAS_ERROR_CODES,
	...TOOL_REASON_CODES,
};

describe("tool reason codes", () => {
	it("writes every code in snake_case", () => {
		for (const [name, list] of Object.entries(LISTS)) {
			for (const code of list) {
				expect(code, `${name}: ${code}`).toMatch(SNAKE_CASE);
			}
		}
	});

	it("lists no code twice in one tool's list", () => {
		for (const [name, list] of Object.entries(LISTS)) {
			expect(new Set(list).size, `${name} repeats a code`).toBe(list.length);
		}
	});

	it("leaves the shared codes out of every tool's own list", () => {
		for (const [name, list] of Object.entries(TOOL_REASON_CODES)) {
			for (const shared of SHARED_REASON_CODES) {
				expect(
					list as readonly string[],
					`${name} lists ${shared}`,
				).not.toContain(shared);
			}
		}
	});

	it("keeps the shared account reasons and the Calendar-specific reasons", () => {
		expect(CONNECTOR_TOOL_NAMES).toEqual([
			"calendar",
			"contacts",
			"email",
			"files",
			"location",
			"media",
			"photos",
			"repos",
			"tasks",
		]);
		expect(TOOL_REASON_CODES.calendar).toEqual([
			...CONNECTOR_REASON_CODES,
			"availability_incomplete",
			"calendar_edit_consent",
		]);
		for (const name of CONNECTOR_TOOL_NAMES) {
			if (name !== "calendar")
				expect(TOOL_REASON_CODES[name]).toBe(CONNECTOR_REASON_CODES);
		}
	});

	it("keeps a Stop out of the picture and clip lists: it is the shared stopped", () => {
		for (const list of [IMAGE_ERROR_CODES, VIDEO_ERROR_CODES] as const) {
			for (const code of list as readonly string[]) {
				expect(code).not.toMatch(/stopped$/);
			}
		}
	});

	it("names the metadata fields the browser reads", () => {
		expect(REASON_CODE_KEY).toBe("reasonCode");
		expect(DISPLAY_OUTPUT_KEY).toBe("displayOutput");
		expect(REASON_PLACE_KEY).toBe("reasonPlace");
	});

	it("keeps the server's placeholder titles the browser recognises", () => {
		expect(CONNECTOR_PLACEHOLDER_TITLES).toEqual({
			untitledEvent: "(untitled event)",
			noSubject: "(no subject)",
			photo: "(photo)",
		});
		expect(LOCATION_AT_PREFIX).toBe("Location at ");
	});

	it("bounds Python's display copy", () => {
		expect(DISPLAY_OUTPUT_MAX_LINES).toBe(12);
		expect(DISPLAY_OUTPUT_MAX_CHARS).toBe(600);
	});
});
