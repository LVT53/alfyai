import { render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import HomeRecent from "./HomeRecent.svelte";

const NOW = 1_789_000_000;

function conversation(overrides: Record<string, unknown> = {}) {
	return {
		id: "c1",
		title: "Nextcloud folder clean-up plan",
		updatedAt: NOW - 2 * 3600,
		messageCount: 12,
		atlasFinished: false,
		...overrides,
	};
}

afterEach(() => {
	uiLanguage.set("en");
});

describe("HomeRecent", () => {
	it("says when a conversation was last touched, in English", () => {
		uiLanguage.set("en");
		render(HomeRecent, { recent: [conversation()], nowSeconds: NOW });
		expect(screen.getByTestId("home-recent-line").textContent).toContain(
			"2 hours ago",
		);
	});

	it("says it in Hungarian when that is the UI language", () => {
		// The regression this pins: the line used to go through
		// $lib/utils/time's formatRelativeTime, which is hard-coded to en-US
		// and printed "2 hour ago" into a Hungarian page.
		uiLanguage.set("hu");
		render(HomeRecent, { recent: [conversation()], nowSeconds: NOW });
		const line = screen.getByTestId("home-recent-line").textContent ?? "";
		expect(line).toContain("2 órával ezelőtt");
		expect(line).not.toContain("ago");
	});

	it("marks a line with the Atlas badge instead of a count, never both", () => {
		render(HomeRecent, {
			recent: [conversation({ atlasFinished: true })],
			nowSeconds: NOW,
		});
		expect(screen.getByTestId("home-atlas-badge")).toBeTruthy();
		expect(screen.getByTestId("home-recent-line").textContent).not.toContain(
			"12",
		);
	});

	it("draws nothing at all for a user with no history", () => {
		render(HomeRecent, { recent: [], running: null, nowSeconds: NOW });
		expect(screen.queryByTestId("home-recent")).toBeNull();
	});

	it("counts the running job's elapsed time in the UI language", () => {
		uiLanguage.set("hu");
		render(HomeRecent, {
			recent: [],
			nowSeconds: NOW,
			running: {
				id: "j1",
				kind: "atlas" as const,
				conversationId: "c9",
				title: "Hungarian EV charging subsidies",
				phase: "Kutatás",
				progressPercent: 58,
				startedAt: NOW - 360,
			},
		});
		const line = screen.getByTestId("home-running-line").textContent ?? "";
		expect(line).toContain("6 perc");
		expect(line).toContain("Kutatás");
	});
});
