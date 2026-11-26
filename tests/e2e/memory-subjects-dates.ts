/**
 * The dates the Memory page's end-to-end spec shows (memory-subjects.spec.ts).
 * The page writes an entry's last mention as a date from a week back, and adds
 * the year when that is not the current one (`mentionedWhen`,
 * src/routes/(app)/knowledge/_components/memory-when.ts), so a date written
 * into the spec goes stale on 1 January. The spec dates the entry relative to
 * now instead and takes its expected words from here, written with the page's
 * own `Intl` options in both languages
 * (tests/integration/memory-subjects-dates.test.ts holds them to the page).
 */

const DAY_MS = 86_400_000;
/** Far enough back for the page to write a date, never "3 days ago". */
const MENTIONED_DAYS_AGO = 40;

/** When the entry was last mentioned: noon UTC, so no time zone moves its day. */
export function mentionedAt(now = new Date()): string {
	const at = new Date(now.getTime() - MENTIONED_DAYS_AGO * DAY_MS);
	at.setUTCHours(12, 0, 0, 0);
	return at.toISOString();
}

/** The words under that entry's text: "Last mentioned 15 October" or "Utoljára említve: október 15.". */
export function lastMentionedWords(
	language: "en" | "hu",
	now = new Date(),
): string {
	const at = new Date(mentionedAt(now));
	const date = new Intl.DateTimeFormat(language === "hu" ? "hu-HU" : "en-GB", {
		day: "numeric",
		month: "long",
		...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
	}).format(at);
	return language === "hu"
		? `Utoljára említve: ${date}`
		: `Last mentioned ${date}`;
}
