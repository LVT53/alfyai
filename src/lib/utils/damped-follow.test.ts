import { describe, expect, it } from "vitest";
import { createDampedFollow, DAMPED_FOLLOW_TAU_MS } from "./damped-follow";

/** A scroll box and a frame clock the test drives by hand. */
function harness(options: { start?: number; reduced?: boolean } = {}) {
	let top = options.start ?? 0;
	let reduced = options.reduced ?? false;
	const writes: number[] = [];
	let reads = 0;
	let next = 1;
	const pending = new Map<number, (now: number) => void>();
	let framesRequested = 0;
	const follow = createDampedFollow({
		read: () => {
			reads += 1;
			return top;
		},
		write: (value) => {
			top = value;
			writes.push(value);
		},
		reducedMotion: () => reduced,
		frame: (callback) => {
			framesRequested += 1;
			const id = next++;
			pending.set(id, callback);
			return id;
		},
		cancelFrame: (id) => {
			pending.delete(id);
		},
	});
	let now = 0;
	/** Runs the pending frame, `ms` after the last one. */
	function tick(ms = 16): boolean {
		const entry = [...pending.entries()][0];
		if (!entry) return false;
		pending.delete(entry[0]);
		now += ms;
		entry[1](now);
		return true;
	}
	return {
		follow,
		writes,
		tick,
		get top() {
			return top;
		},
		get reads() {
			return reads;
		},
		get pending() {
			return pending.size;
		},
		get framesRequested() {
			return framesRequested;
		},
		setReduced(value: boolean) {
			reduced = value;
		},
		setTop(value: number) {
			top = value;
		},
	};
}

describe("createDampedFollow", () => {
	it("moves a fraction of the way each frame, never past the target", () => {
		const box = harness();
		box.follow.aim(1000);
		expect(box.follow.isActive()).toBe(true);
		box.tick(16);
		// One frame of 16 ms at a time constant of 90 ms: 1 - e^(-16/90) of the way.
		const share = 1 - Math.exp(-16 / DAMPED_FOLLOW_TAU_MS);
		expect(box.top).toBeCloseTo(1000 * share, 6);
		let last = box.top;
		while (box.tick(16)) {
			expect(box.top).toBeGreaterThan(last);
			expect(box.top).toBeLessThanOrEqual(1000);
			last = box.top;
		}
	});

	it("lands within half a pixel, writes the target itself and stops", () => {
		const box = harness({ start: 40 });
		box.follow.aim(640);
		let frames = 0;
		while (box.tick(16) && frames < 1000) frames += 1;
		expect(frames).toBeLessThan(200);
		expect(box.top).toBe(640);
		expect(box.writes.at(-1)).toBe(640);
		// Until the very last frame it was not there yet, and the step before was within reach.
		const beforeLast = box.writes.at(-2) as number;
		expect(Math.abs(640 - beforeLast)).toBeLessThan(6);
		expect(box.follow.isActive()).toBe(false);
		expect(box.pending).toBe(0);
	});

	it("follows a moving target in one loop", () => {
		const box = harness();
		box.follow.aim(500);
		box.tick();
		box.tick();
		const before = box.top;
		box.follow.aim(900); // retargets the same flight
		expect(box.pending).toBe(1);
		for (let i = 0; i < 6; i++) box.tick();
		expect(box.top).toBeGreaterThan(before);
		// The scroll box was read once, at the start; the loop never ran twice at once.
		expect(box.reads).toBe(1);
		let guard = 0;
		while (box.tick() && guard++ < 1000)
			expect(box.pending).toBeLessThanOrEqual(1);
		expect(box.top).toBe(900);
	});

	it("caps a long frame at 64 ms", () => {
		const box = harness();
		box.follow.aim(1000);
		box.tick(16);
		const after = box.top;
		box.tick(5000); // the tab was asleep: one frame still moves one 64 ms step
		const step = (1000 - after) * (1 - Math.exp(-64 / DAMPED_FOLLOW_TAU_MS));
		expect(box.top - after).toBeCloseTo(step, 6);
	});

	it("writes at once under reduced motion", () => {
		const box = harness({ reduced: true });
		box.follow.aim(750);
		expect(box.writes).toEqual([750]);
		expect(box.follow.isActive()).toBe(false);
		expect(box.framesRequested).toBe(0);
		// Reduced motion cancels a flight in progress too.
		const flying = harness();
		flying.follow.aim(500);
		flying.tick();
		flying.setReduced(true);
		flying.follow.aim(900);
		expect(flying.top).toBe(900);
		expect(flying.follow.isActive()).toBe(false);
		expect(flying.pending).toBe(0);
	});

	it("stops where it is, and starts again from where the box is", () => {
		const box = harness();
		box.follow.aim(1000);
		box.tick();
		box.follow.stop();
		const stopped = box.top;
		expect(box.follow.isActive()).toBe(false);
		expect(box.pending).toBe(0);
		expect(box.tick()).toBe(false);
		expect(box.top).toBe(stopped);
		// The reader scrolled meanwhile: the next flight starts from the box.
		box.setTop(300);
		box.follow.aim(320);
		box.tick();
		expect(box.top).toBeGreaterThan(300);
		expect(box.top).toBeLessThanOrEqual(320);
		expect(box.reads).toBe(2);
	});

	it("lands at once when it is already within half a pixel", () => {
		const box = harness({ start: 100 });
		box.follow.aim(100.3);
		box.tick();
		expect(box.top).toBe(100.3);
		expect(box.follow.isActive()).toBe(false);
	});
});
