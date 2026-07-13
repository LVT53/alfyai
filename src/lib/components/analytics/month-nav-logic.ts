/**
 * Pure month-navigation logic for `MonthNav.svelte` (Phase B, wave B2).
 *
 * Extracted so the prev/next clamping and label formatting can be unit-tested
 * without mounting the component. `months` are "YYYY-MM" strings; a `null`
 * selection means "all time".
 */

/**
 * Format a "YYYY-MM" month key as a localized "Month YYYY" label
 * (e.g. "July 2026"). Builds a Date from the first of the month.
 *
 * @param month  "YYYY-MM" key.
 * @param locale Optional BCP-47 locale (defaults to the host default).
 */
export function formatMonthLabel(month: string, locale?: string): string {
	if (!/^\d{4}-\d{2}$/.test(month)) return month;
	const date = new Date(`${month}-01T00:00:00`);
	if (Number.isNaN(date.getTime())) return month;
	return date.toLocaleString(locale, { month: "long", year: "numeric" });
}

/**
 * Compute the month key one step from `selected` within `months`.
 *
 * `months` is assumed chronologically ascending. `direction` -1 = previous
 * (older), +1 = next (newer). When `selected` is `null` (all-time), stepping
 * back enters the newest month and stepping forward stays all-time. Stepping
 * off either end returns the current `selected` unchanged (clamped).
 *
 * @returns the resulting month key, or `null` for all-time.
 */
export function stepMonth(
	months: readonly string[],
	selected: string | null,
	direction: -1 | 1,
): string | null {
	if (months.length === 0) return selected;

	if (selected === null) {
		// From all-time: going back selects the newest month; going forward is a no-op.
		return direction === -1 ? months[months.length - 1] : null;
	}

	const index = months.indexOf(selected);
	if (index === -1) return selected;

	const nextIndex = index + direction;
	if (nextIndex < 0 || nextIndex >= months.length) return selected;
	return months[nextIndex];
}

/** True when stepping `previous` from `selected` would go past the oldest month. */
export function isPrevDisabled(
	months: readonly string[],
	selected: string | null,
): boolean {
	if (months.length === 0) return true;
	if (selected === null) return false; // all-time can always step back to newest
	return months.indexOf(selected) === 0;
}

/** True when stepping `next` from `selected` would go past the newest month. */
export function isNextDisabled(
	months: readonly string[],
	selected: string | null,
): boolean {
	if (months.length === 0) return true;
	if (selected === null) return true; // already at the newest edge (all-time)
	return months.indexOf(selected) === months.length - 1;
}
