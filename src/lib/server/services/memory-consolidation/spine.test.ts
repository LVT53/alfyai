import { describe, expect, it } from "vitest";
import { NIGHT_SHIFT_SPINE } from "./spine";

describe("night-shift consolidation spine", () => {
	it("enumerates its ordered steps in one place", () => {
		expect(NIGHT_SHIFT_SPINE.map((step) => step.name)).toEqual([
			"sweep_dirty_conversations",
			"expire_and_renew",
			"reconcile_and_merge",
			"persona_summary",
		]);
	});

	it("exposes each step as a runnable unit", () => {
		for (const step of NIGHT_SHIFT_SPINE) {
			expect(typeof step.name).toBe("string");
			expect(typeof step.run).toBe("function");
		}
	});
});
