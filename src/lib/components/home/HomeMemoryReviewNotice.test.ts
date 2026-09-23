import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import HomeMemoryReviewNotice from "./HomeMemoryReviewNotice.svelte";

afterEach(() => {
	uiLanguage.set("en");
});

describe("HomeMemoryReviewNotice", () => {
	it("draws nothing at all when the count is zero", () => {
		render(HomeMemoryReviewNotice, {
			count: 0,
			href: "/knowledge?tab=memory#memory-review",
		});
		expect(screen.queryByTestId("home-memory-review-notice")).toBeNull();
	});

	it("uses the singular sentence and link for exactly one item, in English", () => {
		render(HomeMemoryReviewNotice, {
			count: 1,
			href: "/knowledge?tab=memory#memory-review",
		});
		const text =
			screen.getByTestId("home-memory-review-notice").textContent ?? "";
		expect(text).toContain("1 memory from recent chats needs a quick look.");
		expect(text).toContain("Review it →");
		expect(text).not.toContain("Review them");
	});

	it("uses the plural sentence and link for more than one item, in English", () => {
		render(HomeMemoryReviewNotice, {
			count: 3,
			href: "/knowledge?tab=memory#memory-review",
		});
		const text =
			screen.getByTestId("home-memory-review-notice").textContent ?? "";
		expect(text).toContain("3 memories from recent chats need a quick look.");
		expect(text).toContain("Review them →");
		expect(text).not.toContain("Review it");
	});

	it("renders the same noun form in Hungarian for one or many", () => {
		uiLanguage.set("hu");
		const { unmount } = render(HomeMemoryReviewNotice, {
			count: 1,
			href: "/knowledge?tab=memory#memory-review",
		});
		let text =
			screen.getByTestId("home-memory-review-notice").textContent ?? "";
		expect(text).toContain(
			"1 emlék a legutóbbi beszélgetésekből gyors átnézésre vár.",
		);
		expect(text).toContain("Áttekintés →");
		unmount();

		render(HomeMemoryReviewNotice, {
			count: 4,
			href: "/knowledge?tab=memory#memory-review",
		});
		text = screen.getByTestId("home-memory-review-notice").textContent ?? "";
		expect(text).toContain(
			"4 emlék a legutóbbi beszélgetésekből gyors átnézésre vár.",
		);
	});

	it("points the review link at the Knowledge Memory review section", () => {
		render(HomeMemoryReviewNotice, {
			count: 2,
			href: "/knowledge?tab=memory#memory-review",
		});
		const link = screen.getByTestId(
			"home-memory-review-link",
		) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe(
			"/knowledge?tab=memory#memory-review",
		);
	});

	it("hides on dismiss and calls onDismiss (the caller's own persistence call)", async () => {
		const onDismiss = vi.fn();
		render(HomeMemoryReviewNotice, {
			count: 2,
			href: "/knowledge?tab=memory#memory-review",
			onDismiss,
		});
		const dismissButton = screen.getByTestId("home-memory-review-dismiss");
		expect(dismissButton.getAttribute("aria-label")).toBe("Dismiss");

		await fireEvent.click(dismissButton);

		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId("home-memory-review-notice")).toBeNull();
	});

	it("labels the Hungarian dismiss button in Hungarian", () => {
		uiLanguage.set("hu");
		render(HomeMemoryReviewNotice, {
			count: 1,
			href: "/knowledge?tab=memory#memory-review",
		});
		expect(
			screen
				.getByTestId("home-memory-review-dismiss")
				.getAttribute("aria-label"),
		).toBe("Elrejtés");
	});
});
