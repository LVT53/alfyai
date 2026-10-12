import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ArtifactPanelHeader from "./ArtifactPanelHeader.svelte";

afterEach(() => {
	cleanup();
	uiLanguage.set("en");
});

function actionsWith(html: string) {
	return createRawSnippet(() => ({ render: () => html }));
}

describe("ArtifactPanelHeader", () => {
	const phrase = {
		headline: "Changed by Alfy",
		when: "12 min ago",
		text: "Changed by Alfy · 12 min ago",
		a11y: "History. Last change: changed by Alfy 12 min ago",
	};

	it("renders the kind label and title", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			onBack: vi.fn(),
		});

		expect(
			screen.getByRole("heading", { name: "Vienna trip plan" }),
		).toBeInTheDocument();
		expect(screen.getByText("Document")).toBeInTheDocument();
	});

	it("renders no moment segment when nothing is known about the latest moment", () => {
		render(ArtifactPanelHeader, {
			kind: "app",
			title: "Trip budget app",
			onBack: vi.fn(),
		});
		expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
		expect(screen.queryByTestId("artifact-history-button")).toBeNull();
	});

	it("says the latest moment in a history button, never a version number, and opens History when pressed", async () => {
		const onHistory = vi.fn();
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			phrase,
			onHistory,
			onBack: vi.fn(),
		});

		const button = screen.getByRole("button", {
			name: "History. Last change: changed by Alfy 12 min ago",
		});
		expect(button).toHaveTextContent("Changed by Alfy · 12 min ago");
		expect(button).toHaveAttribute("data-testid", "artifact-history-button");
		expect(button).toHaveAttribute("aria-haspopup", "true");
		expect(button).toHaveAttribute("aria-pressed", "false");
		// The old test id stays on the button's own wrapper for one release.
		expect(screen.getByTestId("artifact-version-pill")).toContainElement(
			button,
		);
		expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
		await fireEvent.click(button);
		expect(onHistory).toHaveBeenCalledOnce();
	});

	it("shows the button pressed while History is open", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			phrase,
			onHistory: vi.fn(),
			historyOpen: true,
			onBack: vi.fn(),
		});
		expect(
			screen.getByRole("button", { name: /^History\. Last change/ }),
		).toHaveAttribute("aria-pressed", "true");
	});

	it("reads the moment as plain text, not a button, where the kind has no History yet", () => {
		render(ArtifactPanelHeader, {
			kind: "app",
			title: "Trip budget app",
			phrase,
			onBack: vi.fn(),
		});
		expect(
			screen.getByText("Changed by Alfy · 12 min ago"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /History/ }),
		).not.toBeInTheDocument();
	});

	it("keeps the time when the headline is too long: the headline is the part that truncates", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			phrase,
			onHistory: vi.fn(),
			onBack: vi.fn(),
		});
		const button = screen.getByTestId("artifact-history-button");
		expect(
			button.querySelector(".artifact-panel-header-history-headline"),
		).toHaveTextContent("Changed by Alfy");
		expect(
			button.querySelector(".artifact-panel-header-history-when"),
		).toHaveTextContent("12 min ago");
	});

	it("the breadcrumb calls onBack, and its accessible name says where it goes", async () => {
		const onBack = vi.fn();
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			onBack,
		});

		const crumb = screen.getByRole("button", {
			name: "Back to this chat's items",
		});
		await fireEvent.click(crumb);
		expect(onBack).toHaveBeenCalledOnce();
		// The list says how many; the crumb is only the way back (F28).
		expect(
			crumb.querySelector(".artifact-panel-header-crumb-count"),
		).toBeNull();
	});

	it("draws no breadcrumb where there is nowhere to go back to", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			actions: actionsWith("<button>Close</button>"),
		});

		expect(
			screen.queryByRole("button", { name: /this chat/i }),
		).not.toBeInTheDocument();
		// The rest of the header stands, actions still on the right.
		expect(
			screen.getByRole("heading", { name: "Vienna trip plan" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});

	it("says 'This chat' in English and 'Vissza' in Hungarian, one short word the header never wraps (F28)", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			onBack: vi.fn(),
		});
		expect(screen.getByRole("button")).toHaveTextContent("This chat");
		cleanup();
		uiLanguage.set("hu");
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Bécsi utazás",
			onBack: vi.fn(),
		});
		const crumb = screen.getByRole("button", {
			name: "Vissza a beszélgetés elemeihez",
		});
		expect(crumb).toHaveTextContent("Vissza");
	});

	it("renders the caller's actions snippet", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			onBack: vi.fn(),
			actions: actionsWith(
				'<button type="button" data-testid="close-action">Close</button>',
			),
		});
		expect(screen.getByTestId("close-action")).toBeInTheDocument();
	});

	it('shows every kind\'s own label (never the word "artifact")', () => {
		render(ArtifactPanelHeader, {
			kind: "app",
			title: "Trip budget app",
			onBack: vi.fn(),
		});
		expect(screen.getByText("App")).toBeInTheDocument();
	});
});
