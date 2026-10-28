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
import type { ImageMark } from "$lib/shared/artifacts/image-body";

/** A card, strip or History picture waiting in the composer. */
export type ComposerPictureRef = {
	imageFileId: string;
	name: string;
	/** When the picture was made (ms): tells two pictures of one item apart in their chips. */
	at?: number;
};

/**
 * The name each picture chip shows. Two pictures under one name (two versions
 * or takes of one item) are told apart by the older ones carrying when they
 * were made ("Sunset gradient · today 10:31"); the newest keeps the bare name.
 * Words, never a version number (ruling 76). A name shared with a picture
 * whose time is unknown is left as it is. Keyed by `imageFileId`.
 */
export function pictureChipNames(
	refs: readonly ComposerPictureRef[],
	when: (at: number) => string,
): Map<string, string> {
	const byName = new Map<string, ComposerPictureRef[]>();
	for (const ref of refs) {
		byName.set(ref.name, [...(byName.get(ref.name) ?? []), ref]);
	}
	const names = new Map<string, string>();
	for (const [name, group] of byName) {
		const times = group.map((ref) => ref.at);
		const newest =
			group.length > 1 && times.every((at) => at !== undefined)
				? Math.max(...(times as number[]))
				: null;
		for (const ref of group) {
			names.set(
				ref.imageFileId,
				newest !== null && ref.at !== undefined && ref.at < newest
					? `${name} · ${when(ref.at)}`
					: name,
			);
		}
	}
	return names;
}

/**
 * The marks the person drew on one picture (plan 2b T6), held by the chat page
 * and shown as one `image` chip: the request the send carries, and the item the
 * picture belongs to (its title names the picture when the send adds it).
 */
export type ComposerMarks = {
	imageFileId: string;
	marks: ImageMark[];
	artifactId: string;
	name: string;
	/** The item's version the marks were drawn on: a newer one lets them go (Review Focus 4). */
	version: number | null;
};

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

/**
 * The number the marked picture goes by in this message. Attached already: its
 * chip's number. Otherwise the next one: the send adds it as a ref under that
 * number (F14), the number the server would give it as the open picture, after
 * every attached and uploaded picture (`images/turn-pictures.ts`).
 */
export function markedPictureNumber(
	numbers: ReadonlyMap<string, number>,
	imageFileId: string,
): number {
	return (
		numbers.get(pictureKey({ kind: "ref", imageFileId })) ?? numbers.size + 1
	);
}
