import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstructionSuggestion } from "$lib/shared/instructions";
import { uiLanguage } from "$lib/stores/settings";
import InstructionSuggestionRow from "./InstructionSuggestionRow.svelte";

function makeSuggestion(
	overrides: Partial<InstructionSuggestion> = {},
): InstructionSuggestion {
	return {
		id: "suggestion-1",
		status: "pending",
		text: "Only suggest trains, no flights.",
		scope: { kind: "project", projectId: "p1", name: "Vienna trip" },
		createdAt: 1_770_000_000_000,
		...overrides,
	};
}

describe("InstructionSuggestionRow", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("renders the scope token and the quoted text", () => {
		render(InstructionSuggestionRow, {
			suggestion: makeSuggestion(),
			onReview: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(screen.getByText("Add to instructions for")).toBeInTheDocument();
		expect(screen.getByTestId("scope-token")).toHaveTextContent("Vienna trip");
		// The offered text is quoted, so the row reads as the model's words
		// rather than as something the app has already decided.
		expect(screen.getByText(/“Only suggest trains, no flights\.”/)).toBeInTheDocument();
		// The row names the scope and the offer for a screen reader: the
		// visible line is three separate spans and a token.
		expect(
			screen.getByRole("group", {
				name: "Add to instructions for Vienna trip: Only suggest trains, no flights.",
			}),
		).toBeInTheDocument();
	});

	it("names the personal scope from the scope, not from the token's pronoun", () => {
		render(InstructionSuggestionRow, {
			suggestion: makeSuggestion({ scope: { kind: "personal" } }),
			onReview: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(screen.getByTestId("scope-token")).toHaveTextContent("You");
		expect(
			screen.getByRole("group", {
				name: "Add to instructions for Personal: Only suggest trains, no flights.",
			}),
		).toBeInTheDocument();
	});

	it("calls onReview when Review is pressed", async () => {
		const onReview = vi.fn();
		const suggestion = makeSuggestion();

		render(InstructionSuggestionRow, {
			suggestion,
			onReview,
			onDismiss: vi.fn(),
		});

		await fireEvent.click(screen.getByRole("button", { name: "Review" }));

		expect(onReview).toHaveBeenCalledWith(suggestion);
	});

	it("calls onDismiss when Dismiss is pressed", async () => {
		const onDismiss = vi.fn();
		const suggestion = makeSuggestion();

		render(InstructionSuggestionRow, {
			suggestion,
			onReview: vi.fn(),
			onDismiss,
		});

		await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		expect(onDismiss).toHaveBeenCalledWith(suggestion);
	});

	it("disables Dismiss while the request is in flight", () => {
		render(InstructionSuggestionRow, {
			suggestion: makeSuggestion(),
			dismissing: true,
			onReview: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
		// The row is being answered: a second answer while the first is in
		// flight would race it.
		expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
	});

	it("shows a failed request in the row without taking the offer away", () => {
		render(InstructionSuggestionRow, {
			suggestion: makeSuggestion(),
			error: "Could not dismiss the suggestion.",
			onReview: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Could not dismiss the suggestion.",
		);
		expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
	});

	it("uses Hungarian labels for the row actions", () => {
		uiLanguage.set("hu");

		render(InstructionSuggestionRow, {
			suggestion: makeSuggestion({ scope: { kind: "personal" } }),
			onReview: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(
			screen.getByRole("button", { name: "Áttekintés" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Elvetés" })).toBeInTheDocument();
	});
});
