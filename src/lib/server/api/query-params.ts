/**
 * A query-string value that must be a whole number of at least one (a page's
 * `before` or `limit`): the number, `undefined` when the parameter is absent,
 * and `null` when it is present but is anything else — so a route can answer a
 * malformed query with a 400 before it looks anything up, and treat an absent
 * one as "not asked". Nine digits at most: no id or count is larger.
 */
export function optionalPositiveIntegerParam(
	value: string | null,
): number | null | undefined {
	if (value === null) return undefined;
	if (!/^\d{1,9}$/.test(value)) return null;
	const parsed = Number(value);
	return parsed >= 1 ? parsed : null;
}
