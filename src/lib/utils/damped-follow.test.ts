import { describe, expect, it } from "vitest";
import { createDampedFollow, DAMPED_FOLLOW_TAU_MS } from "./damped-follow";

function harness(start = 0, reducedMotion = false) {
	let position = start;
	const writes: number[] = [];
	const queue: Array<(now: number) => void> = [];
	let now = 0;
	const follow = createDampedFollow({
		read: () => position,
		write: (top) => {
			position = top;
			writes.push(top);
		},
		reducedMotion: () => reducedMotion,
		frame: (callback) => queue.push(callback),
		cancelFrame: () => {
			queue.length = 0;
		},
	});
	const step = (ms = 16) => {
		now += ms;
		const callbacks = queue.splice(0);
		for (const callback of callbacks) callback(now);
		return callbacks.length;
	};
	return { follow, writes, step, queue, position: () => position };
}

describe("createDampedFollow", () => {
	it("follows a moving target in one loop", () => {
		const t = harness();
		expect(DAMPED_FOLLOW_TAU_MS).toBe(90);
		t.follow.aim(100);
		expect(t.queue).toHaveLength(1);
		t.step();
		const first = t.position();
		// One frame of 16 ms covers 1 - e^(-16/90) of the way.
		expect(first).toBeCloseTo(100 * (1 - Math.exp(-16 / 90)));
		t.follow.aim(200);
		// Retargeting keeps the one loop: still a single frame waiting.
		expect(t.queue).toHaveLength(1);
		t.step();
		expect(t.position()).toBeCloseTo(
			first + (200 - first) * (1 - Math.exp(-16 / 90)),
		);
		// A long frame counts as 64 ms at most.
		const before = t.position();
		t.step(500);
		expect(t.position()).toBeCloseTo(
			before + (200 - before) * (1 - Math.exp(-64 / 90)),
		);
	});

	it("lands within half a pixel", () => {
		const t = harness(10);
		t.follow.aim(400);
		let frames = 0;
		while (t.follow.isActive() && frames < 500) {
			t.step();
			frames += 1;
		}
		expect(t.follow.isActive()).toBe(false);
		expect(t.writes.at(-1)).toBe(400);
		expect(frames).toBeLessThan(120);
		t.follow.aim(400);
		t.step();
		expect(t.writes.at(-1)).toBe(400);
	});

	it("writes at once under reduced motion", () => {
		const t = harness(0, true);
		t.follow.aim(300);
		expect(t.writes).toEqual([300]);
		expect(t.queue).toHaveLength(0);
		expect(t.follow.isActive()).toBe(false);
	});

	it("stops where it is", () => {
		const t = harness();
		t.follow.aim(100);
		t.step();
		t.follow.stop();
		expect(t.follow.isActive()).toBe(false);
		expect(t.step()).toBe(0);
	});
});
