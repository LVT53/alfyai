import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureNote } from "$lib/client/api/campaigns";
import { uiLanguage } from "$lib/stores/settings";
import FeatureNoteStrip from "./FeatureNoteStrip.svelte";

function makeNote(overrides: Partial<FeatureNote> = {}): FeatureNote {
	return {
		id: "note-1",
		name: "Two-factor authentication",
		snapshotId: "snapshot-1",
		title: {
			en: "Two-factor authentication",
			hu: "Kétlépcsős azonosítás",
		},
		body: {
			en: "Keep your account safer.",
			hu: "Tartsd biztonságban a fiókodat.",
		},
		actionLabel: { en: "Set up 2FA", hu: "2FA beállítása" },
		actionDestination: "/settings",
		publishedAt: "2026-10-17T10:00:00.000Z",
		...overrides,
	};
}

function renderNote(
	overrides: Partial<{
		note: FeatureNote;
		locale: "en" | "hu";
		preview: boolean;
		onDismiss: () => void;
		onAction: (destination: string) => void;
	}> = {},
) {
	return render(FeatureNoteStrip, {
		props: { note: makeNote(), ...overrides },
	});
}

describe("FeatureNoteStrip", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	afterEach(() => {
		cleanup();
		uiLanguage.set("en");
	});

	it("renders the note as a region named by its title, with the sparkle tile", () => {
		const { container } = renderNote();

		const region = screen.getByRole("region", {
			name: "Two-factor authentication",
		});
		expect(region).toHaveAttribute("data-testid", "feature-note");
		expect(
			screen.getByRole("heading", {
				level: 2,
				name: "Two-factor authentication",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("Keep your account safer.")).toBeInTheDocument();

		const tile = container.querySelector(".feature-note-tile");
		expect(tile).not.toBeNull();
		expect(tile).toHaveAttribute("aria-hidden", "true");
		expect(tile?.querySelectorAll("svg.lucide-sparkles")).toHaveLength(1);
	});

	it("names the feature once in a polite, atomic live line", () => {
		renderNote();

		const live = screen.getByRole("status");
		expect(live).toHaveAttribute("aria-live", "polite");
		expect(live).toHaveAttribute("aria-atomic", "true");
		expect(live).toHaveTextContent("New feature: Two-factor authentication");
	});

	it("uses the Hungarian words and chrome under locale hu", () => {
		uiLanguage.set("hu");
		renderNote({ locale: "hu" });

		expect(
			screen.getByRole("region", { name: "Kétlépcsős azonosítás" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Kétlépcsős azonosítás" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Tartsd biztonságban a fiókodat."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "2FA beállítása" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Bezárás" })).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Új funkció: Kétlépcsős azonosítás",
		);
	});

	it("falls back to the other language when the reader's copy is missing", () => {
		renderNote({
			locale: "hu",
			note: makeNote({
				title: { en: "Two-factor authentication", hu: "" },
				body: { en: "Keep your account safer.", hu: "" },
				actionLabel: { en: "Set up 2FA", hu: "" },
			}),
		});

		expect(
			screen.getByRole("heading", { name: "Two-factor authentication" }),
		).toBeInTheDocument();
		expect(screen.getByText("Keep your account safer.")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Set up 2FA" }),
		).toBeInTheDocument();
	});

	it("falls back to the feature-note chrome when a note has no title yet", () => {
		const english = renderNote({
			note: makeNote({ title: { en: "", hu: "" } }),
		});
		// A draft preview can be empty; the region still needs a name.
		expect(
			screen.getByRole("region", { name: "New feature" }),
		).toBeInTheDocument();
		english.unmount();

		uiLanguage.set("hu");
		renderNote({
			locale: "hu",
			note: makeNote({ title: { en: "", hu: "" } }),
		});
		expect(
			screen.getByRole("region", { name: "Új funkció" }),
		).toBeInTheDocument();
	});

	it("draws the dismiss control as a Lucide X, not a text glyph", () => {
		renderNote();

		const dismiss = screen.getByRole("button", { name: "Dismiss" });
		expect(dismiss.querySelector("svg.lucide-x")).not.toBeNull();
		expect(dismiss.textContent?.trim()).toBe("");
	});

	it("does not steal focus from the page it lands on", () => {
		const opener = document.createElement("button");
		opener.textContent = "Focused before the note";
		document.body.append(opener);
		opener.focus();

		try {
			renderNote();
			expect(opener).toHaveFocus();
		} finally {
			opener.remove();
		}
	});

	it("dismisses through onDismiss", async () => {
		const onDismiss = vi.fn();
		renderNote({ onDismiss });

		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("renders the action at the end of the body row and hands its destination up", async () => {
		const onAction = vi.fn();
		renderNote({ onAction });

		const link = screen.getByRole("link", { name: "Set up 2FA" });
		expect(link).toHaveAttribute("href", "/settings");
		expect(link.querySelector("svg.lucide-arrow-right")).not.toBeNull();

		const row = link.parentElement;
		expect(row).toHaveClass("feature-note-line");
		expect(row?.querySelector(".feature-note-body")).toHaveTextContent(
			"Keep your account safer.",
		);

		// The strip leaves the navigation to the anchor (no preventDefault);
		// jsdom cannot navigate, so the test cancels it after the handler ran.
		link.addEventListener("click", (event) => event.preventDefault(), {
			once: true,
		});
		await fireEvent.click(link);
		expect(onAction).toHaveBeenCalledWith("/settings");
	});

	it("keeps the body and the action on one row, with no third line", () => {
		const withAction = renderNote();
		const copy = withAction.container.querySelector(".feature-note-copy");
		expect(copy?.children).toHaveLength(2);
		expect(copy?.children[1]).toHaveClass("feature-note-line");

		withAction.unmount();

		const withoutAction = renderNote({
			note: makeNote({ actionDestination: null }),
		});
		const plainCopy =
			withoutAction.container.querySelector(".feature-note-copy");
		// One title line and one body line; the action never gets a line of its own.
		expect(plainCopy?.children).toHaveLength(2);
		expect(plainCopy?.querySelector(".feature-note-body")).toHaveTextContent(
			"Keep your account safer.",
		);
	});

	it("renders no action for a note without a usable destination or label", () => {
		const cases: Array<[string, Partial<FeatureNote>]> = [
			["an empty destination", { actionDestination: "" }],
			["a missing destination", { actionDestination: null }],
			[
				"a destination off the allow-list",
				{ actionDestination: "javascript:alert(1)" },
			],
			[
				"an external destination",
				{ actionDestination: "https://evil.example.com" },
			],
			[
				"a protocol-relative destination",
				{ actionDestination: "//evil.example.com" },
			],
			["a path off the allow-list", { actionDestination: "/not-a-real-route" }],
			["an internal action", { actionDestination: "internal:chatgpt-import" }],
			["an empty label", { actionLabel: { en: "", hu: "" } }],
			["a whitespace-only label", { actionLabel: { en: "   ", hu: "\t" } }],
		];

		for (const [name, overrides] of cases) {
			const { unmount } = renderNote({ note: makeNote(overrides) });
			expect(screen.queryByRole("link"), name).not.toBeInTheDocument();
			expect(
				screen.getByText("Keep your account safer."),
				name,
			).toBeInTheDocument();
			unmount();
		}
	});

	it("renders the same card in preview without calling any callback", async () => {
		const onDismiss = vi.fn();
		const onAction = vi.fn();
		renderNote({ preview: true, onDismiss, onAction });

		expect(screen.getByTestId("feature-note")).toBeInTheDocument();
		const dismiss = screen.getByRole("button", { name: "Dismiss" });
		const link = screen.getByRole("link", { name: "Set up 2FA" });
		expect(link).toHaveAttribute("href", "/settings");

		await fireEvent.click(dismiss);
		// Keep the preview's own href from navigating jsdom; the point is that
		// the strip does not call its callback in preview.
		link.addEventListener("click", (event) => event.preventDefault(), {
			once: true,
		});
		await fireEvent.click(link);

		expect(onDismiss).not.toHaveBeenCalled();
		expect(onAction).not.toHaveBeenCalled();
	});
});
