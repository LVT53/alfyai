// What a reply draws under its text for the items it made or changed.
//
// A turn that makes a Document and works on it calls create_artifact, then
// edit_artifact (and the model the audit walked fails an edit or two on the way),
// and every call used to be a card or a raw row of its own: three identical cards
// for one Document, and a failed attempt printing its parameters (RC-A #2, and the
// owner's call on F16: "one card per item per reply"). Pure: the rows are built by
// `buildToolActivityItem`; this decides which of them the reply shows.
import type { ToolActivityItem } from "./tool-activity";

export type DeliverableEntry<Segment> = {
	/** The tool call the row was built from. */
	segment: Segment;
	item: ToolActivityItem;
};

export type FoldedDeliverables<Segment> = {
	/** What the reply draws under its text, in the order the items first appeared. */
	shown: ToolActivityItem[];
	/**
	 * The failed attempts the reply does not draw: a later call of the same item made
	 * good (or repeated) what they tried. They stay steps of the turn, in its rail.
	 */
	retried: Segment[];
};

/** Whether the row is a card of an item (a call that made or changed one). */
function isCard(item: ToolActivityItem): boolean {
	return (
		item.body?.kind === "artifact" &&
		item.artifact !== undefined &&
		!item.artifact.failed
	);
}

/**
 * One card per item: the card stays where the item first appeared and shows the
 * item as the turn's last call left it. A failed attempt is a row of the reply only
 * when it is what the turn ended on for that item (nothing made good after it) and
 * only the last such attempt: a reader needs "it did not work" once, not once per
 * try. Everything else (a call still running, a create that was refused, a row of
 * another tool) passes through as it is.
 */
export function foldArtifactDeliverables<Segment>(
	entries: ReadonlyArray<DeliverableEntry<Segment>>,
): FoldedDeliverables<Segment> {
	const firstCard = new Map<string, number>();
	const lastCard = new Map<string, number>();
	const lastFailure = new Map<string, number>();
	entries.forEach(({ item }, index) => {
		const id = item.artifact?.id;
		if (!id) return;
		if (isCard(item)) {
			if (!firstCard.has(id)) firstCard.set(id, index);
			lastCard.set(id, index);
		} else if (item.artifact?.failed) {
			lastFailure.set(id, index);
		}
	});

	const shown: ToolActivityItem[] = [];
	const retried: Segment[] = [];
	entries.forEach(({ segment, item }, index) => {
		const id = item.artifact?.id;
		if (id && isCard(item)) {
			// Its slot is the first card's; what it shows is the last one's.
			if (firstCard.get(id) === index) {
				const last = entries[lastCard.get(id) as number].item;
				shown.push(last === item ? item : { ...last, key: item.key });
			}
			return;
		}
		if (id && item.artifact?.failed) {
			const madeGoodAfter = index < (lastCard.get(id) ?? -1);
			if (madeGoodAfter || lastFailure.get(id) !== index) {
				retried.push(segment);
				return;
			}
		}
		shown.push(item);
	});
	return { shown, retried };
}
