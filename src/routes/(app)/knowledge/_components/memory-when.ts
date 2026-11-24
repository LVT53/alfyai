/**
 * The dates the subject index's page writes (Memory part 3): when an entry was
 * last mentioned ("Last mentioned 3 days ago", "Last mentioned 14 November")
 * and when an earlier state was said ("said March 2025"). The words around
 * them are the dictionary's; the dates are written in the reader's language.
 */
export type MentionedWhen =
	| { kind: "today" }
	| { kind: "yesterday" }
	| { kind: "daysAgo"; count: number }
	| { kind: "date"; text: string };

/** British day-month order for English, as the approved mockups write it. */
function locale(language: string): string {
	return language === "hu" ? "hu-HU" : "en-GB";
}

function instant(iso: string | null): Date | null {
	if (iso === null) return null;
	const at = new Date(iso);
	return Number.isNaN(at.getTime()) ? null : at;
}

const DAY_MS = 86_400_000;

function dayNumber(at: Date): number {
	return Math.floor(
		Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / DAY_MS,
	);
}

/** Today, yesterday or a few days ago within six days; after that the date, with its year when it is not this one. */
export function mentionedWhen(
	iso: string | null,
	now: Date,
	language: string,
): MentionedWhen | null {
	const at = instant(iso);
	if (!at) return null;
	const days = dayNumber(now) - dayNumber(at);
	if (days <= 0) return { kind: "today" };
	if (days === 1) return { kind: "yesterday" };
	if (days <= 6) return { kind: "daysAgo", count: days };
	return {
		kind: "date",
		text: new Intl.DateTimeFormat(locale(language), {
			day: "numeric",
			month: "long",
			...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
		}).format(at),
	};
}

/** The month and year an earlier state was said: "March 2025", "2025. március". */
export function monthAndYear(
	iso: string | null,
	language: string,
): string | null {
	const at = instant(iso);
	if (!at) return null;
	return new Intl.DateTimeFormat(locale(language), {
		month: "long",
		year: "numeric",
	}).format(at);
}
