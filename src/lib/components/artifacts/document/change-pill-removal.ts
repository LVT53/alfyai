/**
 * The pill that goes when Keep has run its window, without the text below it
 * jumping (F18, ruling 77). Pure DOM, no `@tiptap/*`: `DocumentBody.svelte` is
 * the one caller and may not import the editor's modules statically
 * (`lazy-boundary.test.ts`).
 *
 * A pill that did not fit after the text sits on a line of its own, and that line
 * is part of its paragraph: when the widget leaves, everything below comes up by a
 * whole line (28 px and more) in one frame. ProseMirror owns those nodes, so they
 * are neither restyled nor wrapped; they are moved the way a list reorders itself
 * (FLIP): measure where each block below stood, let the pill go, measure again, and
 * play the difference as a `translateY` that eases to nothing. A Web Animation
 * touches no attribute, so the editor's own DOM observer never sees it. Under
 * reduced motion the pill just goes.
 */
import { tick } from "svelte";
import {
	MOTION_DURATION,
	MOTION_EASING,
	prefersReducedMotion,
} from "$lib/utils/motion";

/** The blocks below this far under the viewport are not seen to move. */
const BELOW_THE_FOLD_PX = 600;
/** Marks the animation this module plays, so a second pill leaving while the first one's is still easing takes it over (below). */
const FLIP_ANIMATION_ID = "change-pill-flip";

/** The pill widget's own mount (`change-pill-decoration.ts`) for this change, in `root`. */
function findPillMount(root: ParentNode, changeId: string): HTMLElement | null {
	for (const mount of root.querySelectorAll<HTMLElement>(
		".change-pill-mount",
	)) {
		if (mount.dataset.changeId === changeId) return mount;
	}
	return null;
}

/** Everything that comes after `mount` in the text and so moves when its line goes: the later siblings of every ancestor up to the editor, the ones in view or near it. */
function blocksBelow(mount: HTMLElement): HTMLElement[] {
	const editor = mount.closest(".ProseMirror");
	if (!editor) return [];
	const reach = window.innerHeight + BELOW_THE_FOLD_PX;
	const below: HTMLElement[] = [];
	for (
		let node: HTMLElement | null = mount.parentElement;
		node && node !== editor;
		node = node.parentElement
	) {
		for (
			let next = node.nextElementSibling;
			next instanceof HTMLElement;
			next = next.nextElementSibling
		) {
			if (next.getBoundingClientRect().top > reach) break;
			below.push(next);
		}
	}
	return below;
}

/**
 * Runs `remove` (which takes the pill out of the document) and eases what is
 * below it up by the room it leaves, instead of in one frame. `remove` may be
 * asynchronous in effect (it sets state the editor then follows): the layout is
 * read again after Svelte has flushed it, before anything is painted.
 */
export async function removeChangePillSmoothly(
	root: ParentNode,
	changeId: string,
	remove: () => void,
): Promise<void> {
	const mount = findPillMount(root, changeId);
	if (!mount || prefersReducedMotion()) {
		remove();
		return;
	}
	const below = blocksBelow(mount);
	// Where each block is SEEN now, an earlier pill's easing (still running when
	// "Keep all" sends several one after another) included.
	const before = below.map((block) => block.getBoundingClientRect().top);
	remove();
	await tick();
	below.forEach((block, index) => {
		// The earlier easing is taken over: it ends here, and the new one carries what
		// was left of it together with this pill's room, from where the block was seen.
		for (const running of block.getAnimations()) {
			if (running.id === FLIP_ANIMATION_ID) running.cancel();
		}
		const moved = before[index] - block.getBoundingClientRect().top;
		if (Math.abs(moved) < 1) return;
		block.animate(
			[{ transform: `translateY(${moved}px)` }, { transform: "none" }],
			{
				id: FLIP_ANIMATION_ID,
				duration: MOTION_DURATION.emphasis,
				easing: MOTION_EASING.out,
			},
		);
	});
}
