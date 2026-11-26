/** One remembered entry a search ranked, with what its line costs. */
export interface RecallCandidate {
	key: string;
	tokens: number;
}

/**
 * A share of the recall budget: the ranked lists it takes from, in turn, and
 * the most it may take before the spill pass.
 */
export interface RecallLane {
	lists: readonly (readonly RecallCandidate[])[];
	capTokens: number;
}

/**
 * Shares one recall budget between lanes. The first pass walks the lanes in
 * order, each up to its cap; the spill pass walks them again with the caps
 * lifted, so a share one lane leaves unused goes to the next. Within a lane
 * the lists take turns, one entry each, and an entry two lists ranked is
 * taken once. Returns the taken keys in the order taken; their tokens never
 * add up to more than `budgetTokens`.
 *
 * Callers put the lanes in spill order: project, then core, then message.
 */
export function allocateRecall(
	lanes: readonly RecallLane[],
	budgetTokens: number,
): string[] {
	const taken: string[] = [];
	const takenKeys = new Set<string>();
	let total = 0;

	const walk = (lane: RecallLane, capTokens: number) => {
		let laneTokens = 0;
		// Totals only grow during a walk, so an entry that does not fit now
		// never fits later in it: each list keeps a cursor past what it passed.
		const cursors = lane.lists.map(() => 0);
		const open = new Set(lane.lists.keys());
		while (open.size > 0) {
			for (const index of [...open]) {
				const list = lane.lists[index];
				let cursor = cursors[index];
				while (cursor < list.length) {
					const candidate = list[cursor];
					if (
						!takenKeys.has(candidate.key) &&
						laneTokens + candidate.tokens <= capTokens &&
						total + candidate.tokens <= budgetTokens
					)
						break;
					cursor += 1;
				}
				if (cursor >= list.length) {
					open.delete(index);
					continue;
				}
				const candidate = list[cursor];
				cursors[index] = cursor + 1;
				takenKeys.add(candidate.key);
				taken.push(candidate.key);
				laneTokens += candidate.tokens;
				total += candidate.tokens;
			}
		}
	};

	for (const lane of lanes) walk(lane, lane.capTokens);
	for (const lane of lanes) walk(lane, Number.POSITIVE_INFINITY);
	return taken;
}
