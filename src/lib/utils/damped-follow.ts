/**
 * One retargetable damped scroll (spec §4.3: "one continuous damped scroll, never a
 * stack of smooth scrolls"). Each frame moves a share of the way that depends on the
 * frame's length, `1 - e^(-dt/τ)`, so it is the same at any frame rate; aiming again
 * in flight only moves the target of the same loop. It lands, and stops, within half
 * a pixel. Under reduced motion it writes the target at once.
 */

export const DAMPED_FOLLOW_TAU_MS = 90;

/** A frame longer than this (a hidden tab, a stall) counts as this long. */
const MAX_FRAME_MS = 64;
const LANDING_PX = 0.5;

export type DampedFollow = {
	aim(top: number): void;
	stop(): void;
	isActive(): boolean;
};

export function createDampedFollow(io: {
	read(): number;
	write(top: number): void;
	reducedMotion(): boolean;
	frame?: (callback: (now: number) => void) => number;
	cancelFrame?: (id: number) => void;
}): DampedFollow {
	const frame =
		io.frame ??
		((callback: (now: number) => void) => requestAnimationFrame(callback));
	const cancelFrame =
		io.cancelFrame ?? ((id: number) => cancelAnimationFrame(id));
	let target = 0;
	let position = 0;
	let last: number | null = null;
	let pending: number | null = null;

	const step = (now: number) => {
		pending = null;
		const dt =
			last === null ? 16 : Math.min(MAX_FRAME_MS, Math.max(0, now - last));
		last = now;
		position +=
			(target - position) * (1 - Math.exp(-dt / DAMPED_FOLLOW_TAU_MS));
		if (Math.abs(target - position) <= LANDING_PX) {
			position = target;
			last = null;
			io.write(position);
			return;
		}
		io.write(position);
		pending = frame(step);
	};

	const stop = () => {
		if (pending !== null) cancelFrame(pending);
		pending = null;
		last = null;
	};

	return {
		aim(top) {
			target = top;
			if (io.reducedMotion()) {
				stop();
				io.write(top);
				return;
			}
			if (pending === null) {
				position = io.read();
				last = null;
				pending = frame(step);
			}
		},
		stop,
		isActive: () => pending !== null,
	};
}
