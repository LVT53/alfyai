/**
 * The composer's pictures, numbered (plan 2b T5). A message carries uploaded
 * photos and card pictures (Attach) side by side; the person sees one sequence
 * "Picture 1, Picture 2 ...", in the order the pictures were added. The server
 * numbers the same way (`images/turn-pictures.ts`: the refs keep the numbers
 * sent, the uploads fill the free ones), so what the chips say is what Alfy is
 * told.
 *
 * Pure data and functions, nothing Svelte-reactive: MessageInput keeps the
 * order list and asks these for the numbers. There is no cap here: the cap
 * limits one picture request on the server, and Alfy says so in its reply.
 */

/** A card, strip or History picture waiting in the composer. */
export type ComposerPictureRef = { imageFileId: string; name: string };

export type PictureSource =
	| { kind: "upload"; artifactId: string }
	| { kind: "ref"; imageFileId: string };

/** "upload:<id>" or "ref:<id>": one key per picture, whatever it came from. */
export function pictureKey(source: PictureSource): string {
	return source.kind === "upload"
		? `upload:${source.artifactId}`
		: `ref:${source.imageFileId}`;
}

/**
 * Numbers from 1 in the order given, for the keys that are pictures. A
 * non-picture key (a PDF) and a repeated key take no number.
 */
export function numberPictures(
	order: readonly string[],
	isPicture: (key: string) => boolean,
): Map<string, number> {
	const numbers = new Map<string, number>();
	for (const key of order) {
		if (numbers.has(key) || !isPicture(key)) continue;
		numbers.set(key, numbers.size + 1);
	}
	return numbers;
}

/**
 * The order list after the composer's pictures changed: keys that are gone
 * drop out (everyone after them moves up), keys not seen before join the end
 * in the order given. Returns the same array when nothing changed.
 */
export function reconcilePictureOrder(
	previous: readonly string[],
	present: readonly string[],
): readonly string[] {
	const presentSet = new Set(present);
	const kept = previous.filter((key) => presentSet.has(key));
	const known = new Set(kept);
	for (const key of present) {
		if (known.has(key)) continue;
		known.add(key);
		kept.push(key);
	}
	const unchanged =
		kept.length === previous.length &&
		kept.every((key, index) => key === previous[index]);
	return unchanged ? previous : kept;
}

export type ChipSlot =
	| { type: "attachment"; index: number }
	| { type: "ref"; index: number };

/**
 * The order the chips are drawn in. Attachments keep their own order; a card
 * picture sits where its number says: before the first uploaded picture that
 * was added after it, so "Picture 1" is never drawn after "Picture 2".
 * `attachmentKeys[i]` is the picture key of attachment i, or `null` for a file
 * that is not a picture (it stays where it is).
 */
export function arrangePictureChips(
	order: readonly string[],
	attachmentKeys: ReadonlyArray<string | null>,
	refKeys: readonly string[],
): ChipSlot[] {
	const position = new Map(order.map((key, index) => [key, index]));
	const pending = refKeys
		.map((key, index) => ({ index, at: position.get(key) ?? Number.MAX_VALUE }))
		.sort((a, b) => a.at - b.at || a.index - b.index);
	const slots: ChipSlot[] = [];
	let next = 0;
	attachmentKeys.forEach((key, index) => {
		if (key !== null) {
			const at = position.get(key) ?? Number.MAX_VALUE;
			while (next < pending.length && pending[next].at < at) {
				slots.push({ type: "ref", index: pending[next].index });
				next += 1;
			}
		}
		slots.push({ type: "attachment", index });
	});
	for (; next < pending.length; next += 1) {
		slots.push({ type: "ref", index: pending[next].index });
	}
	return slots;
}
