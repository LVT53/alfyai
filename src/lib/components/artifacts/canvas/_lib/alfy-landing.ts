/**
 * How a change of Alfy's reaches the reader's eyes (Feature 2 · Artifacts, Slice
 * 3 T6, the diff path). The server has already decided and saved; this only
 * draws what came back, in the order the spec fixes:
 *
 *   1. the structure first: what was added or taken away, in the board's own
 *      order (a frame before what is inside it), with everything that is going
 *      to move still where it was;
 *   2. a `tick()`, so the flow has drawn it;
 *   3. then what moves glides to its new place over 620 ms (`easeInOut`, one
 *      `requestAnimationFrame` loop), so the board is seen to rearrange, not to
 *      teleport;
 *   4. then what was touched is ringed for 3.2 s (the caller's, not this one's).
 *
 * The plan is a pure function of the two boards (`diffBoards`), so a change from
 * the chat, from an `@Alfy` comment and one restored after a reload are the same
 * thing to draw. Running it is told the clock, the frame loop and the board it
 * draws on (`LandingPort`), so it is tested without a browser. Loaded on demand
 * with the rest of the review parts: a board nobody changes never pays for it.
 */
import { tick } from "svelte";
import { type BoardDelta, diffBoards } from "$lib/shared/artifacts/board-diff";
import type { CanvasBody, Pt } from "$lib/shared/artifacts/canvas";

/** The glide of a block to its new place. */
export const MOVE_MS = 620;
/** How long the strong ring on a touched block stays before it settles to a resting one. */
export const HIGHLIGHT_MS = 3200;
/** "Alfy is arranging…" is seen for at least this long, even when the call is faster (redesign §4.2 item 4). */
export const ARRANGING_MIN_MS = 600;

/** Ease in, ease out: slow at both ends, quickest in the middle. */
export function easeInOut(t: number): number {
	if (t <= 0) return 0;
	if (t >= 1) return 1;
	return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

export interface LandingMove {
	id: string;
	from: Pt;
	to: Pt;
}

export interface LandingPlan {
	/** The new board with each block that will glide still where it was. */
	structural: CanvasBody;
	/** The board as it is once it has landed: exactly what the server holds. */
	final: CanvasBody;
	moves: LandingMove[];
	delta: BoardDelta;
	/** What to ring: every block the change touched, and every one a `highlight` op pointed at, that is on the new board. */
	touched: string[];
}

export function planLanding(
	before: CanvasBody,
	after: CanvasBody,
	highlightIds: readonly string[] = [],
): LandingPlan {
	const delta = diffBoards(before, after);
	const from = new Map(delta.movedNodes.map((move) => [move.id, move.from]));
	const structural: CanvasBody =
		from.size === 0
			? after
			: {
					...after,
					nodes: after.nodes.map((node) => {
						const start = from.get(node.id);
						return start ? { ...node, position: { ...start } } : node;
					}),
				};
	const present = new Set(after.nodes.map((node) => node.id));
	const touched = [
		...delta.touched,
		...highlightIds.filter(
			(id) => present.has(id) && !delta.touched.includes(id),
		),
	];
	// The order the board draws its blocks in, whichever way they were named.
	const order = new Map(after.nodes.map((node, index) => [node.id, index]));
	touched.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
	return {
		structural,
		final: after,
		moves: delta.movedNodes.map((move) => ({ ...move })),
		delta,
		touched,
	};
}

/** What a landing draws on: the board component's own surface, nothing else. */
export interface LandingPort {
	/** Replaces the blocks, the arrows and the marks at once. It is not a step of the reader's. */
	land(body: CanvasBody): void;
	/** Puts blocks at these positions (each in its own space); nothing else changes. */
	place(positions: ReadonlyMap<string, Pt>): void;
	/** A landing is drawing: the reader's gestures and steps wait until it lets go. */
	hold(on: boolean): void;
}

export interface LandingOptions {
	/** No glide: the board lands at once. */
	reducedMotion: boolean;
	/** True when this landing has been overtaken (the board was replaced): it stops drawing. */
	aborted?: () => boolean;
	now?: () => number;
	frame?: (callback: (time: number) => void) => unknown;
}

function glide(
	port: LandingPort,
	moves: readonly LandingMove[],
	options: Required<Pick<LandingOptions, "now" | "frame">> &
		Pick<LandingOptions, "aborted">,
): Promise<void> {
	return new Promise((resolve) => {
		const start = options.now();
		const step = (): void => {
			if (options.aborted?.()) {
				resolve();
				return;
			}
			const t = Math.min(1, (options.now() - start) / MOVE_MS);
			const eased = easeInOut(t);
			port.place(
				new Map(
					moves.map((move) => [
						move.id,
						{
							x: move.from.x + (move.to.x - move.from.x) * eased,
							y: move.from.y + (move.to.y - move.from.y) * eased,
						},
					]),
				),
			);
			if (t < 1) options.frame(step);
			else resolve();
		};
		options.frame(step);
	});
}

/**
 * Draws a plan. Always lets go of the board, whatever happens; a landing that
 * was overtaken (`aborted`) leaves the board to whoever replaced it and does
 * not draw the final board over it.
 */
export async function runLanding(
	port: LandingPort,
	plan: LandingPlan,
	options: LandingOptions,
): Promise<void> {
	const now = options.now ?? (() => performance.now());
	const frame =
		options.frame ?? ((callback) => requestAnimationFrame(callback));
	port.hold(true);
	try {
		if (options.reducedMotion || plan.moves.length === 0) {
			// Nothing to glide (or told not to): the board lands as it is.
			port.land(plan.final);
			return;
		}
		port.land(plan.structural);
		await tick();
		if (options.aborted?.()) return;
		await glide(port, plan.moves, {
			now,
			frame,
			aborted: options.aborted,
		});
		if (options.aborted?.()) return;
		port.land(plan.final);
	} finally {
		port.hold(false);
	}
}
