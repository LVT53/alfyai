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
	it("renders the kind label, title and meta line", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			meta: "edited 2 min ago",
			onBack: vi.fn(),
		});

		expect(
			screen.getByRole("heading", { name: "Vienna trip plan" }),
		).toBeInTheDocument();
		expect(screen.getByText("Document")).toBeInTheDocument();
		expect(screen.getByText("edited 2 min ago")).toBeInTheDocument();
	});

	it("renders no version segment when versionNumber is absent", () => {
		render(ArtifactPanelHeader, {
			kind: "app",
			title: "Trip budget app",
			onBack: vi.fn(),
		});
		expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
	});

	it("renders the version as a button and calls onVersions when clicked", async () => {
		const onVersions = vi.fn();
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			versionNumber: 6,
			onVersions,
			onBack: vi.fn(),
		});

		const versionButton = screen.getByRole("button", { name: "Version 6" });
		expect(versionButton).toHaveTextContent("v6");
		await fireEvent.click(versionButton);
		expect(onVersions).toHaveBeenCalledOnce();
	});

	it("renders the version as plain text, not a button, when no onVersions handler is given", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			versionNumber: 6,
			onBack: vi.fn(),
		});
		expect(screen.getByText("v6")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Version/ }),
		).not.toBeInTheDocument();
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

	it("falls back to the plain eyebrow label when no item count is given", () => {
		render(ArtifactPanelHeader, {
			kind: "document",
			title: "Vienna trip plan",
			onBack: vi.fn(),
		});
		expect(screen.getByRole("button", { name: "This chat" })).toBeInTheDocument();
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

	it("shows every kind's own label (never the word \"artifact\")", () => {
		render(ArtifactPanelHeader, {
			kind: "app",
			title: "Trip budget app",
			onBack: vi.fn(),
		});
		expect(screen.getByText("App")).toBeInTheDocument();
	});
});
