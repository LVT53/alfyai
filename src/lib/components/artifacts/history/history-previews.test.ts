import { describe, expect, it } from "vitest";
import { HISTORY_PREVIEWS, kindHasHistory } from "./history-previews";

describe("the History preview registry", () => {
	it("gives the Image its History (plan 2b T4), lazily", async () => {
		expect(kindHasHistory("image")).toBe(true);
		const module = await HISTORY_PREVIEWS.image?.();
		expect(module?.default).toBeTypeOf("function");
	});

	it("keeps the kinds that have none without one", () => {
		expect(kindHasHistory("file")).toBe(false);
		expect(kindHasHistory(null)).toBe(false);
	});
});
