/**
 * A name on one line: control characters and runs of white space become one
 * space, and a name longer than `maxChars` characters is cut with "...". The one
 * cleaning rule for a name that goes into a label or a chip, shared so the
 * browser draws the same words the server records (cleaning twice changes
 * nothing).
 */
export function oneLineName(name: string, maxChars = 80): string {
	const oneLine = name.replace(/[\p{Cc}\s]+/gu, " ").trim();
	const points = Array.from(oneLine);
	return points.length > maxChars
		? `${points.slice(0, maxChars - 3).join("")}...`
		: oneLine;
}
