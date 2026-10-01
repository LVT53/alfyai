/**
 * Which blocks of the board are selected, as a pure function of the blocks and
 * of what is to be selected. The one place that turns "select these" into the
 * `selected` flags Svelte Flow reads: a click on a frame's ground picks the frame
 * through it today, and whatever picks several blocks at once (a marquee, a
 * Shift-click) goes through the same function with `additive`, so a selection is
 * never built two ways.
 */
export function withSelection<N extends { id: string; selected?: boolean }>(
	nodes: readonly N[],
	ids: readonly string[],
	options: { additive?: boolean } = {},
): N[] {
	const wanted = new Set(ids);
	let changed = false;
	const next = nodes.map((node) => {
		const selected =
			wanted.has(node.id) || (options.additive === true && !!node.selected);
		if (!!node.selected === selected) return node;
		changed = true;
		return { ...node, selected };
	});
	return changed ? next : (nodes as N[]);
}
