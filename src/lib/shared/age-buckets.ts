const DAY_MS = 86_400_000;

export type AgeBucket =
	| { unit: "today" }
	| { unit: "yesterday" }
	| { unit: "days" | "weeks" | "months" | "years"; count: number };

/**
 * How long ago something was, in the units a person says it in. Whole days
 * elapsed pick the unit: under a day is today, one day yesterday, 2 to 13 days,
 * 14 to 59 days in weeks (days / 7), 60 to 729 in months (days / 30), 730 and
 * more in years (days / 365). A time after `nowMs` counts as today.
 *
 * Recall tells the model when an entry was last said and Workspace Search
 * tells the person; both read their words off this one rule.
 */
export function ageBucket(atMs: number, nowMs: number): AgeBucket {
	const days = Math.max(0, Math.floor((nowMs - atMs) / DAY_MS));
	if (days === 0) return { unit: "today" };
	if (days === 1) return { unit: "yesterday" };
	if (days < 14) return { unit: "days", count: days };
	if (days < 60) return { unit: "weeks", count: Math.floor(days / 7) };
	if (days < 730) return { unit: "months", count: Math.floor(days / 30) };
	return { unit: "years", count: Math.floor(days / 365) };
}
