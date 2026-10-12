import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ConversationTitleText from "./ConversationTitleText.svelte";

vi.mock("svelte/transition", () => ({
	fade: () => ({}),
}));

describe("ConversationTitleText", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		uiLanguage.set("en");
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
	// F5: the stored default is one English sentence, and a Hungarian reader
	// never sees it.
	it("shows the stored default title in the reader's language", () => {
		uiLanguage.set("hu");
		render(ConversationTitleText, { title: "New Conversation" });

		expect(screen.getByText("Új beszélgetés")).toBeInTheDocument();
		expect(screen.queryByText("New Conversation")).not.toBeInTheDocument();
	});

	it("shows a blank title as the untitled label too", () => {
		uiLanguage.set("hu");
		render(ConversationTitleText, { title: "  " });

		expect(screen.getByText("Új beszélgetés")).toBeInTheDocument();
	});

	it("types a generated title in over the localized untitled label", async () => {
		uiLanguage.set("hu");
		vi.useFakeTimers();
		const onAnimationComplete = vi.fn();
		const rendered = render(ConversationTitleText, {
			title: "New Conversation",
			onAnimationComplete,
		});
		expect(screen.getByText("Új beszélgetés")).toBeInTheDocument();

		await rendered.rerender({ title: "Kávéházak", onAnimationComplete });
		expect(screen.queryByText("Kávéházak")).not.toBeInTheDocument();

		await vi.runAllTimersAsync();
		await tick();

		expect(screen.getByText("Kávéházak")).toBeInTheDocument();
		expect(onAnimationComplete).toHaveBeenCalledOnce();
	});

	it("does not type anything in when only the interface language changes", async () => {
		vi.useFakeTimers();
		const onAnimationComplete = vi.fn();
		render(ConversationTitleText, {
			title: "New Conversation",
			onAnimationComplete,
		});

		uiLanguage.set("hu");
		await tick();
		await vi.runAllTimersAsync();

		expect(screen.getByText("Új beszélgetés")).toBeInTheDocument();
		expect(onAnimationComplete).not.toHaveBeenCalled();
	});
});
