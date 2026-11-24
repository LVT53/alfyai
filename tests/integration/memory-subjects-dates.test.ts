import { describe, expect, it } from "vitest";
import { mentionedWhen } from "../../src/routes/(app)/knowledge/_components/memory-when";
import { lastMentionedWords, mentionedAt } from "../e2e/memory-subjects-dates";

// The end-to-end spec of the Memory page (tests/e2e/memory-subjects.spec.ts)
// dates one entry relative to now and expects the words the page writes for
// it. The page writes the year only when the date is not this year, so a
// calendar date fixed in the spec went stale on 1 January. This holds that
// the spec's words are the page's own on any day, either side of a new year.
const DAYS = [
	"2026-11-24T09:00:00Z",
	"2026-12-31T23:30:00Z",
	"2027-01-01T00:30:00Z",
	"2027-01-05T12:00:00Z",
	"2027-02-09T12:00:00Z",
	"2027-02-12T12:00:00Z",
	"2028-02-29T12:00:00Z",
	"2028-12-31T23:59:00Z",
].map((day) => new Date(day));

describe("the Memory page spec's own dates", () => {
	it.each(DAYS)(
		"writes the page's words for a mention dated from %s",
		(now) => {
			for (const language of ["en", "hu"] as const) {
				const when = mentionedWhen(mentionedAt(now), now, language);
				expect(when?.kind).toBe("date");
				const date = when?.kind === "date" ? when.text : "";
				expect(lastMentionedWords(language, now)).toBe(
					language === "hu"
						? `Utoljára említve: ${date}`
						: `Last mentioned ${date}`,
				);
			}
		},
	);

	it("names the year exactly when the mention is in another year", () => {
		const january = new Date("2027-01-05T12:00:00Z");
		const november = new Date("2026-11-24T12:00:00Z");
		expect(lastMentionedWords("en", january)).toBe(
			"Last mentioned 26 November 2026",
		);
		expect(lastMentionedWords("hu", january)).toBe(
			"Utoljára említve: 2026. november 26.",
		);
		expect(lastMentionedWords("en", november)).toBe(
			"Last mentioned 15 October",
		);
		expect(lastMentionedWords("hu", november)).toBe(
			"Utoljára említve: október 15.",
		);
	});
});
