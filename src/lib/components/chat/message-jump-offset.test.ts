import { describe, expect, it } from "vitest";
import {
	jumpOffset,
	MESSAGE_JUMP_GAP_PX,
	MESSAGE_JUMP_TOLERANCE_PX,
	remainingJumpOffset,
} from "./message-jump-offset";

// A phone-width reading area: 760 x 600, its top edge 100 px down the window.
const CONTAINER_TOP = 100;
const CONTAINER_HEIGHT = 600;

function offsetFor(
	target: { top: number; height: number },
	gap = MESSAGE_JUMP_GAP_PX,
): number {
	return jumpOffset({
		targetTop: target.top,
		targetHeight: target.height,
		containerTop: CONTAINER_TOP,
		containerHeight: CONTAINER_HEIGHT,
		gap,
	});
}

function remainingFor(
	target: { top: number; height: number },
	options: { gap?: number; tolerance?: number } = {},
): number | null {
	return remainingJumpOffset({
		targetTop: target.top,
		targetHeight: target.height,
		containerTop: CONTAINER_TOP,
		containerHeight: CONTAINER_HEIGHT,
		...options,
	});
}

describe("jumpOffset", () => {
	it("puts a tall reply's first line at the reading area's top, not its middle", () => {
		// The old centring formula: 800 - 100 - (600 - 1400) / 2 = 1100. The
		// reader landed 400 px into the answer instead of on its first line.
		const offset = offsetFor({ top: 800, height: 1400 });
		expect(offset).toBe(800 - CONTAINER_TOP - MESSAGE_JUMP_GAP_PX);
		expect(offset).not.toBe(1100);
	});

	it("treats a one-line reply and a tall reply the same: the first line leads", () => {
		expect(offsetFor({ top: 800, height: 22 })).toBe(
			offsetFor({ top: 800, height: 1400 }),
		);
	});

	it("aims above the view at the first message, which the browser clamps to the top", () => {
		expect(offsetFor({ top: 60, height: 200 })).toBe(
			60 - CONTAINER_TOP - MESSAGE_JUMP_GAP_PX,
		);
		expect(offsetFor({ top: 60, height: 200 })).toBeLessThan(0);
	});

	it("aims past the view at the last message, which the browser clamps to the end", () => {
		expect(offsetFor({ top: 700, height: 900 })).toBe(
			700 - CONTAINER_TOP - MESSAGE_JUMP_GAP_PX,
		);
		expect(offsetFor({ top: 700, height: 900 })).toBeGreaterThan(0);
	});

	it("keeps the gap it is given, so a tighter reading area is a smaller gap", () => {
		const roomy = offsetFor({ top: 500, height: 100 }, 20);
		const tight = offsetFor({ top: 500, height: 100 }, 4);
		expect(tight - roomy).toBe(16);
	});
});

describe("remainingJumpOffset", () => {
	it("asks for nothing when the first line already sits on the gap", () => {
		expect(
			remainingFor({
				top: CONTAINER_TOP + MESSAGE_JUMP_GAP_PX,
				height: 800,
			}),
		).toBeNull();
	});

	it("asks for nothing while the miss is within the tolerance", () => {
		const tolerance = MESSAGE_JUMP_TOLERANCE_PX;
		expect(
			remainingFor({
				top: CONTAINER_TOP + MESSAGE_JUMP_GAP_PX + tolerance,
				height: 200,
			}),
		).toBeNull();
		expect(
			remainingFor({
				top: CONTAINER_TOP + MESSAGE_JUMP_GAP_PX - tolerance,
				height: 200,
			}),
		).toBeNull();
	});

	it("asks for the rest of the distance when the thread grew under the jump", () => {
		// The gate's loaded run: the message came to rest 142 px lower than the
		// first smooth scroll aimed.
		expect(
			remainingFor({
				top: CONTAINER_TOP + MESSAGE_JUMP_GAP_PX + 142,
				height: 400,
			}),
		).toBe(142);
	});

	it("asks for a negative correction when the target sits above the gap", () => {
		expect(
			remainingFor({
				top: CONTAINER_TOP + MESSAGE_JUMP_GAP_PX - 37,
				height: 400,
			}),
		).toBe(-37);
	});

	it("accepts a tighter tolerance for a caller that needs one", () => {
		expect(
			remainingFor(
				{ top: CONTAINER_TOP + MESSAGE_JUMP_GAP_PX + 1.5, height: 100 },
				{ tolerance: 1 },
			),
		).toBe(1.5);
	});

	it("is idempotent: a landing already corrected asks for nothing", () => {
		const target = {
			top: CONTAINER_TOP + MESSAGE_JUMP_GAP_PX + 142,
			height: 400,
		};
		const correction = remainingFor(target);
		expect(correction).toBe(142);
		expect(
			remainingFor({ top: target.top - (correction ?? 0), height: 400 }),
		).toBeNull();
	});
});
