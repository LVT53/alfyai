import { render, screen } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, describe, expect, it } from "vitest";
import { makeGrammarFormatters } from "$lib/client/connections/status-grammar";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import HomeProjects from "./HomeProjects.svelte";

/**
 * The home projects row (Workspaces Slice G, §M6): up to three cards for the
 * most recently active projects, under the composer.
 *
 * The two rules worth pinning here are the ones a later reader would be tempted
 * to "fix": the row draws NOTHING when there is nothing to draw (no heading over
 * an empty grid), and it draws exactly the projects it is handed — the
 * "a project with no chats gets no card" rule belongs to
 * `listRecentlyActiveProjects`, and re-applying it here would be a second
 * definition of it.
 */

const NOW = 1_789_000_000;

function project(overrides: Record<string, unknown> = {}) {
	return {
		id: "p1",
		name: "Vienna trip",
		color: null,
		chatCount: 3,
		lastActivityAt: NOW - 3 * 3600,
		hasInstructions: true,
		fileCount: 2,
		...overrides,
	};
}

/** What `HomeSurface` passes down: the shared, language-aware formatter. */
function formatRelative(seconds: number): string {
	return makeGrammarFormatters("en", () => NOW * 1000).relative(seconds);
}

afterEach(() => {
	uiLanguage.set("en");
});

describe("HomeProjects", () => {
	it("draws nothing at all for a user with no projects", () => {
		render(HomeProjects, { projects: [], formatRelative });

		// Not "an empty grid": no rule, no heading, no section.
		expect(screen.queryByTestId("home-projects")).toBeNull();
		expect(screen.queryByText(get(t)("home.projectsHeading"))).toBeNull();
	});

	it("draws one card per project under a heading rule", () => {
		render(HomeProjects, {
			projects: [
				project(),
				project({ id: "p2", name: "Flat renovation", chatCount: 1 }),
			],
			formatRelative,
		});

		expect(screen.getByTestId("home-projects")).toBeTruthy();
		expect(screen.getByText(get(t)("home.projectsHeading"))).toBeTruthy();
		expect(screen.getAllByTestId("home-project-card")).toHaveLength(2);
		expect(screen.getByText("Vienna trip")).toBeTruthy();
		expect(screen.getByText("Flat renovation")).toBeTruthy();
	});

	it("links each card to its project, named for a screen reader", () => {
		render(HomeProjects, {
			projects: [project({ id: "project-7", name: "Vienna trip" })],
			formatRelative,
		});

		const card = screen.getByTestId("home-project-card");
		expect(card.getAttribute("href")).toBe("/projects/project-7");
		expect(card.getAttribute("aria-label")).toBe(
			get(t)("projects.openA11y", { name: "Vienna trip" }),
		);
	});

	it("counts chats and says how long ago, in the caller's language", () => {
		render(HomeProjects, { projects: [project()], formatRelative });

		expect(screen.getByTestId("home-project-stats").textContent).toContain(
			"3 chats · active 3 hours ago",
		);
	});

	it("says it in Hungarian when that is the UI language", () => {
		// The formatter is the caller's, so this pins the wiring rather than the
		// grammar: the surface hands down the same Intl-backed pair the recent
		// list and the project page use, never a second vocabulary.
		uiLanguage.set("hu");
		const hungarian = (seconds: number) =>
			makeGrammarFormatters("hu", () => NOW * 1000).relative(seconds);
		render(HomeProjects, {
			projects: [project()],
			formatRelative: hungarian,
		});

		const stats = screen.getByTestId("home-project-stats").textContent ?? "";
		expect(stats).toContain("3 csevegés");
		expect(stats).toContain("3 órával ezelőtt");
		expect(stats).not.toContain("ago");
	});

	it("uses the singular stat line for a one-chat project", () => {
		render(HomeProjects, {
			projects: [project({ chatCount: 1 })],
			formatRelative,
		});
		expect(screen.getByTestId("home-project-stats").textContent).toContain(
			"1 chat ·",
		);
	});

	it("shows an indicator only when it is true", () => {
		render(HomeProjects, {
			projects: [
				project({ id: "a", hasInstructions: false, fileCount: 0 }),
				project({ id: "b", hasInstructions: true, fileCount: 0 }),
				project({ id: "c", hasInstructions: false, fileCount: 3 }),
			],
			formatRelative,
		});

		const cards = screen.getAllByTestId("home-project-card");
		expect(
			cards[0]?.querySelector('[data-testid="home-project-instructions"]'),
		).toBeNull();
		expect(
			cards[0]?.querySelector('[data-testid="home-project-files"]'),
		).toBeNull();

		expect(
			cards[1]?.querySelector('[data-testid="home-project-instructions"]')
				?.textContent,
		).toContain(get(t)("projects.instructionsLabel"));
		expect(
			cards[1]?.querySelector('[data-testid="home-project-files"]'),
		).toBeNull();

		expect(
			cards[2]?.querySelector('[data-testid="home-project-instructions"]'),
		).toBeNull();
		expect(
			cards[2]?.querySelector('[data-testid="home-project-files"]')
				?.textContent,
		).toContain("3 files");
	});

	it("puts the middot between two indicators and never on its own", () => {
		render(HomeProjects, {
			projects: [
				project({ id: "both", hasInstructions: true, fileCount: 2 }),
				project({ id: "one", hasInstructions: true, fileCount: 0 }),
			],
			formatRelative,
		});

		const cards = screen.getAllByTestId("home-project-card");
		const both = cards[0]?.querySelector(".home-project-meta")?.textContent;
		expect(both).toContain("·");
		expect(
			cards[1]
				?.querySelector(".home-project-meta")
				?.querySelector(".home-project-separator"),
		).toBeNull();
	});

	it("uses the singular file label for exactly one file", () => {
		render(HomeProjects, {
			projects: [project({ fileCount: 1 })],
			formatRelative,
		});
		expect(screen.getByTestId("home-project-files").textContent).toContain(
			"1 file",
		);
	});

	it("draws what it is handed, filtering nothing of its own", () => {
		// Decision 9's rule is the server's: `listRecentlyActiveProjects` never
		// returns a project with no chats. A card that quietly dropped one it did
		// receive would be a second, drifting definition of the same rule.
		render(HomeProjects, {
			projects: [
				project({ id: "empty", name: "Brand new project", chatCount: 0 }),
			],
			formatRelative,
		});
		expect(screen.getAllByTestId("home-project-card")).toHaveLength(1);
	});
});
