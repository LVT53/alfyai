import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import SchedulerRelinkHarness from "./SchedulerRelinkHarness.test.svelte";

// Svelte 5.55.8 re-linked a batch that had to run again (an effect created
// while it was flushed wrote state) without marking it linked, so it was never
// unlinked. Every later update that touched the same state merged into that
// dead batch, and soon nothing in the app re-rendered, with no error: the
// picture card stayed on "Making the picture…" until a reload (Task 11, seen
// on ai.dev from the landing page). Fixed in Svelte 5.55.10; this holds it.
describe("the Svelte scheduler", () => {
	it("keeps rendering after a component mounted by an update writes state in $effect.pre", async () => {
		const { rerender } = render(SchedulerRelinkHarness, {
			show: false,
			value: 0,
		});
		await rerender({ show: true, value: 5 });
		for (let value = 6; value <= 10; value += 1) {
			await rerender({ show: true, value });
			expect(screen.getByTestId("value")).toHaveTextContent(String(value));
			expect(screen.getByTestId("seen")).toHaveTextContent(String(value));
		}
	});
});
