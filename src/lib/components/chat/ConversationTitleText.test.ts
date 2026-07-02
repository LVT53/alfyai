import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConversationTitleText from "./ConversationTitleText.svelte";

vi.mock("svelte/transition", () => ({
	fade: () => ({}),
}));

describe("ConversationTitleText", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renders the current title without animating on first paint", () => {
		render(ConversationTitleText, { title: "Existing title" });

		expect(screen.getByText("Existing title")).toBeInTheDocument();
	});

	it("animates when a default title becomes a generated title", async () => {
		vi.useFakeTimers();
		const onAnimationComplete = vi.fn();
		const rendered = render(ConversationTitleText, {
			title: "New Conversation",
			onAnimationComplete,
		});

		await rendered.rerender({
			title: "Generated",
			onAnimationComplete,
		});

		expect(screen.queryByText("Generated")).not.toBeInTheDocument();

		await vi.runAllTimersAsync();
		await tick();

		expect(screen.getByText("Generated")).toBeInTheDocument();
		expect(onAnimationComplete).toHaveBeenCalledOnce();
	});
});
