/** A block's words in a few of its own, for the name a screen reader announces: newlines collapsed, cut on a word where it can be. */
export function excerpt(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
