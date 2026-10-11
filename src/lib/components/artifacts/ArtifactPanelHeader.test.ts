import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArtifactPanelHeader from "./ArtifactPanelHeader.svelte";

afterEach(() => {
	cleanup();
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

	it("the breadcrumb calls onBack and its accessible name carries the item count", async () => {
		const onBack = vi.fn();
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			itemCount: 3,
			onBack,
		});

		const crumb = screen.getByRole("button", {
			name: "Back to This chat (3 items)",
		});
		await fireEvent.click(crumb);
		expect(onBack).toHaveBeenCalledOnce();
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

	it("falls back to the plain eyebrow label when no item count is given", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			onBack: vi.fn(),
		});
		expect(
			screen.getByRole("button", { name: "This chat" }),
		).toBeInTheDocument();
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
