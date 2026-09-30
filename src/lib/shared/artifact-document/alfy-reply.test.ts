import { describe, expect, it } from "vitest";
import {
	ALFY_EMPTY_REPLY_MARKER,
	splitSkippedOps,
	withSkippedOps,
} from "./alfy-reply";

// The marker a board's @Alfy reply carries for the ops it skipped: written by the
// server, read back by the card. It must round-trip whatever a block's words are,
// and it must never turn something a person wrote, or a body that merely looks
// like it, into a list of skipped ops.

describe("withSkippedOps / splitSkippedOps", () => {
	it("round-trips a note and what was skipped", () => {
		const skipped = [
			{ target: "Museum, 14:00", reason: "unknown_id" },
			{ target: "", reason: "cycle" },
		];
		expect(splitSkippedOps(withSkippedOps("Moved it.", skipped))).toEqual({
			text: "Moved it.",
			skipped,
		});
	});

	it("leaves a note alone when nothing was skipped", () => {
		expect(withSkippedOps("Moved it.", [])).toBe("Moved it.");
		expect(splitSkippedOps("Moved it.")).toEqual({
			text: "Moved it.",
			skipped: [],
		});
	});

	it("keeps the empty-note marker readable beside a list, for the card to turn into Done", () => {
		const body = withSkippedOps(ALFY_EMPTY_REPLY_MARKER, [
			{ target: "a", reason: "duplicate_id" },
		]);
		expect(splitSkippedOps(body).text).toBe(ALFY_EMPTY_REPLY_MARKER);
	});

	it("survives words that look like the marker's own brackets", () => {
		const skipped = [
			{ target: "]] [[alfy:skipped:[] \n\n", reason: "unknown_id" },
		];
		expect(splitSkippedOps(withSkippedOps("Note ]]", skipped)).skipped).toEqual(
			skipped,
		);
	});

	it("takes a marker it cannot read off the note and names nothing", () => {
		expect(splitSkippedOps("Done.\n\n[[alfy:skipped:{not json]]")).toEqual({
			text: "Done.",
			skipped: [],
		});
		expect(splitSkippedOps('Done.\n\n[[alfy:skipped:"a string"]]')).toEqual({
			text: "Done.",
			skipped: [],
		});
	});

	it("drops entries that are not a target and a reason", () => {
		const body =
			'Done.\n\n[[alfy:skipped:[{"target":"a","reason":"x"},{"target":1},null,"s"]]]';
		expect(splitSkippedOps(body).skipped).toEqual([
			{ target: "a", reason: "x" },
		]);
	});

	it("ignores a marker that is not at the very end of the body", () => {
		const body = "A note [[alfy:skipped:[]]] and more words";
		expect(splitSkippedOps(body)).toEqual({ text: body, skipped: [] });
	});
});
