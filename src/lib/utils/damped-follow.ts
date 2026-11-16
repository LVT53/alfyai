// One retargetable damped scroll (read aloud, spec §4.3 "Following" and the
// scrubber's off-screen sentence, Plan 2 Task 14).
//
// The thread follows a target with a single loop, never a stack of smooth
// scrolls: each frame it moves a share of the way, `1 - e^(-dt/90)`, which is
// what an exponential approach with a 90 ms time constant does whatever the
// frame rate, and a target that moves while it flies (the scrubber's pointer
// crossing sentences) only changes where the same loop is going. It lands
// within half a pixel, writes the target itself and stops. Under reduced motion
// there is no flight: the target is written at once.
//
// The scroll box is not touched here: `read`, `write` and the frame clock come
// from the caller, so the owner of the scroll (MessageArea) decides what scrolls
// and the tests drive a clock by hand.

/** The time constant of the approach, in milliseconds. */
export const DAMPED_FOLLOW_TAU_MS = 90;
/** A frame is never counted as longer: a tab that slept moves one step, not the whole way. */
const MAX_FRAME_MS = 64;
/** Within this the target is as good as reached. */
const LAND_WITHIN_PX = 0.5;
/** The first frame of a flight has no frame before it to measure. */
const FIRST_FRAME_MS = 16;

export type DampedFollowIo = {
	/** Where the scroll box is now: asked once, when a flight starts. */
	read(): number;
	write(top: number): void;
	reducedMotion(): boolean;
	frame?: (callback: (now: number) => void) => number;
	cancelFrame?: (id: number) => void;
};

export type DampedFollow = {
	/** Flies to `top`, or retargets the flight already in the air. */
	aim(top: number): void;
	/** Leaves the box where it is. */
	stop(): void;
	isActive(): boolean;
};

export function createDampedFollow(io: DampedFollowIo): DampedFollow {
	const requestFrame =
		io.frame ?? ((callback) => requestAnimationFrame(callback));
	const cancelFrame = io.cancelFrame ?? ((id) => cancelAnimationFrame(id));
	let target = 0;
	let position = 0;
	let last: number | null = null;
	let handle: number | null = null;

	function step(now: number): void {
		handle = null;
		const elapsed = last === null ? FIRST_FRAME_MS : now - last;
		const dt = Math.min(MAX_FRAME_MS, Math.max(0, elapsed));
		last = now;
		position +=
			(target - position) * (1 - Math.exp(-dt / DAMPED_FOLLOW_TAU_MS));
		if (Math.abs(target - position) <= LAND_WITHIN_PX) {
			position = target;
			io.write(target);
			last = null;
			return;
		}
		io.write(position);
		handle = requestFrame(step);
	}

	function stop(): void {
		if (handle !== null) cancelFrame(handle);
		handle = null;
		last = null;
	}

	return {
		aim(top) {
			target = top;
			if (io.reducedMotion()) {
				stop();
				io.write(top);
				return;
			}
			// A flight in the air keeps its place and its loop: only the target moved.
			if (handle !== null) return;
			position = io.read();
			last = null;
			handle = requestFrame(step);
		},
		stop,
		isActive: () => handle !== null,
	};
}
