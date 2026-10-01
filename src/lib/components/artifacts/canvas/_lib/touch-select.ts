/**
 * Picking several blocks with a finger. A finger has no Shift key and no marquee (a
 * drag on the empty board pans, and must), so a selection of several starts with a
 * LONG PRESS on a block: it is added to what was picked, and from then on a plain tap
 * on a block adds it or, when it is picked already, takes it out. A tap on the empty
 * board puts everything down and the taps are plain again (the board clears the
 * selection itself; this only notices that nothing is picked any more). A touch that
 * moves is a drag or a pan, never a pick. Loaded on demand, on a device whose pointer
 * is coarse (`group-parts.ts`): a desktop never pays for it.
 *
 * Why it sets the selection a moment after the finger lifts: the library has already
 * replaced the selection with the block that was touched, on touch start, and runs its
 * own click handler after the lift; setting ours last makes ours the one that stands.
 */

/** A press this long, still, is a long press. */
export const HOLD_MS = 450;
/** How long after the lift the click that follows it is waited for. */
const CLICK_WAIT_MS = 600;
/** A finger that travels further than this is dragging, not pressing. */
const SLOP = 10;
/** Taps on these keep their own meaning (a tick, a field, a link). */
const CONTROLS = "button, input, textarea, select, a, [contenteditable='true']";

export type TouchSelectionApi = {
	/** The ids picked now. */
	selected: () => string[];
	/** Picks exactly these blocks. */
	select: (ids: string[]) => void;
	/** The board is the reader's to change, with the Select tool. */
	enabled: () => boolean;
	/** Says something to a screen reader. */
	announce: (message: string) => void;
	/** What is said when a long press starts a selection. */
	hint: () => string;
};

type Press = {
	id: string;
	/** What was picked before the finger came down. */
	before: string[];
	x: number;
	y: number;
	held: boolean;
	moved: boolean;
	timer: ReturnType<typeof setTimeout>;
};

/** The picked blocks once a press on `id` is done: a long press adds; a tap in the picking mode toggles. */
export function afterPress(
	before: readonly string[],
	id: string,
	held: boolean,
): string[] {
	const picked = new Set(before);
	if (held || !picked.has(id)) picked.add(id);
	else picked.delete(id);
	return [...picked];
}

/** Starts watching `root` for the touches above; returns what stops it. */
export function watchTouchSelection(
	root: HTMLElement,
	api: TouchSelectionApi,
): () => void {
	let adding = false;
	let press: Press | null = null;

	const forget = () => {
		if (press) clearTimeout(press.timer);
		press = null;
	};

	const down = (event: PointerEvent) => {
		forget();
		if (event.pointerType !== "touch" || !event.isPrimary || !api.enabled())
			return;
		adding = adding && api.selected().length > 0;
		const target = event.target instanceof Element ? event.target : null;
		const id = target
			?.closest<HTMLElement>(".svelte-flow__node")
			?.getAttribute("data-id");
		if (!id || target?.closest(CONTROLS)) return;
		const current: Press = {
			id,
			before: api.selected(),
			x: event.clientX,
			y: event.clientY,
			held: false,
			moved: false,
			timer: setTimeout(() => {
				current.held = true;
				adding = true;
				api.announce(api.hint());
			}, HOLD_MS),
		};
		press = current;
	};

	const move = (event: PointerEvent) => {
		if (
			press &&
			!press.moved &&
			Math.hypot(event.clientX - press.x, event.clientY - press.y) > SLOP
		) {
			press.moved = true;
			clearTimeout(press.timer);
		}
	};

	const up = () => {
		const done = press;
		forget();
		if (!done || done.moved || !(done.held || adding)) return;
		const next = afterPress(done.before, done.id, done.held);
		adding = next.length > 0;
		const apply = () => {
			if (api.enabled()) api.select(next);
		};
		// Once the lift is done, and again once the click that follows it (if one does:
		// a long press has none) has run the library's own selection and the board has
		// taken it in: a pick made before that would find the board unchanged and leave
		// the library's to stand.
		const later = () => void setTimeout(apply, 0);
		later();
		root.addEventListener("click", later, { once: true });
		setTimeout(() => root.removeEventListener("click", later), CLICK_WAIT_MS);
	};

	root.addEventListener("pointerdown", down, true);
	root.addEventListener("pointermove", move, true);
	root.addEventListener("pointerup", up, true);
	root.addEventListener("pointercancel", forget, true);
	return () => {
		forget();
		root.removeEventListener("pointerdown", down, true);
		root.removeEventListener("pointermove", move, true);
		root.removeEventListener("pointerup", up, true);
		root.removeEventListener("pointercancel", forget, true);
	};
}
