import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillDraftProposal } from "$lib/server/services/skills/types";
import { uiLanguage } from "$lib/stores/settings";
import SkillDraftCard from "./SkillDraftCard.svelte";

function makeDraft(
	overrides: Partial<SkillDraftProposal> = {},
): SkillDraftProposal {
	return {
		id: "draft-1",
		status: "proposed",
		displayName: "Meeting critic",
		description: "Review meeting notes for weak follow-ups.",
		instructions:
			"Find missing owners, vague deadlines, and risky assumptions.",
		activationExamples: ["review these meeting notes"],
		durationPolicy: "session",
		questionPolicy: "ask_when_needed",
		notesPolicy: "create_private_notes",
		sourceScope: "current_conversation",
		...overrides,
	};
}

describe("SkillDraftCard", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("shows what the skill does and how to ask for it, and calls back on Save and Dismiss", async () => {
		const onSave = vi.fn();
		const onDismiss = vi.fn();

		render(SkillDraftCard, {
			draft: makeDraft(),
			onSave,
			onDismiss,
		});

		expect(
			screen.getByRole("article", { name: "Skill draft: Meeting critic" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Review meeting notes for weak follow-ups."),
		).toBeInTheDocument();
		expect(screen.getByText("What it does")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Find missing owners, vague deadlines, and risky assumptions.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Try asking")).toBeInTheDocument();
		expect(screen.getByText("review these meeting notes")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Save private skill" }),
		).toHaveClass("skill-draft-card__primary");
		expect(screen.getByRole("button", { name: "Dismiss draft" })).toHaveClass(
			"skill-draft-card__secondary",
		);
		expect(
			screen.queryByRole("button", { name: "Publish skill" }),
		).not.toBeInTheDocument();

		await fireEvent.click(
			screen.getByRole("button", { name: "Save private skill" }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: "Dismiss draft" }),
		);

		expect(onSave).toHaveBeenCalledWith("draft-1");
		expect(onDismiss).toHaveBeenCalledWith("draft-1");
	});

	it("shows none of the policy chips or warnings left from skill sessions", () => {
		render(SkillDraftCard, {
			draft: makeDraft({
				durationPolicy: "session",
				questionPolicy: "ask_when_needed",
				notesPolicy: "create_private_notes",
				sourceScope: "current_conversation",
			}),
			onSave: vi.fn(),
			onDismiss: vi.fn(),
		});

		for (const leftover of [
			"Ask when needed",
			"No questions",
			"Current conversation",
			"Selected sources only",
			"Can use broad current-conversation context.",
			"Uses only selected linked sources when sources are needed.",
			"Session",
			"Private notes",
		]) {
			expect(screen.queryByText(leftover)).not.toBeInTheDocument();
		}
	});

	it("folds long instructions behind Show more and opens them in full", async () => {
		const instructions = `Take the notes the person gives. ${"Keep each part short and plain. ".repeat(12)}End with the blockers.`;
		render(SkillDraftCard, {
			draft: makeDraft({ instructions }),
			onSave: vi.fn(),
			onDismiss: vi.fn(),
		});

		const toggle = screen.getByRole("button", { name: "Show more" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText(instructions)).not.toBeInTheDocument();
		expect(
			screen.getByText(/^Take the notes the person gives\..*…$/),
		).toBeInTheDocument();

		await fireEvent.click(toggle);

		expect(screen.getByText(instructions)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});

	it("shows short instructions whole, with nothing to unfold", () => {
		render(SkillDraftCard, {
			draft: makeDraft(),
			onSave: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(
			screen.queryByRole("button", { name: "Show more" }),
		).not.toBeInTheDocument();
	});

	it("links a saved draft to its skill in Settings instead of offering Save again", () => {
		render(SkillDraftCard, {
			draft: makeDraft({ status: "saved", savedSkillId: "skill 7" }),
			onSave: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(screen.getByText("Saved")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Open in Skills" }),
		).toHaveAttribute("href", "/settings?section=skills&skill=skill%207");
		expect(
			screen.queryByRole("button", { name: "Save private skill" }),
		).not.toBeInTheDocument();
	});

	it("offers nothing to do on a dismissed draft", () => {
		render(SkillDraftCard, {
			draft: makeDraft({ status: "dismissed" }),
			onSave: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(screen.getByText("Dismissed")).toBeInTheDocument();
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("uses Hungarian labels for card actions", () => {
		uiLanguage.set("hu");

		render(SkillDraftCard, {
			draft: makeDraft({
				notesPolicy: "none",
				sourceScope: "selected_sources_only",
			}),
			onSave: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(
			screen.getByRole("button", { name: "Privát skill mentése" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Vázlat elvetése" }),
		).toBeInTheDocument();
		expect(screen.getByText("Mit csinál")).toBeInTheDocument();
		expect(screen.getByText("Így kérheted")).toBeInTheDocument();
	});

	it("uses Hungarian labels for the saved draft link and the fold", () => {
		uiLanguage.set("hu");

		render(SkillDraftCard, {
			draft: makeDraft({
				status: "saved",
				savedSkillId: "skill-7",
				instructions: "Rövid, tömör jegyzetek. ".repeat(20),
			}),
			onSave: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(
			screen.getByRole("link", { name: "Ugrás a skillhez" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Bővebben" }),
		).toBeInTheDocument();
	});

	it("renders a localized draft action error and disables actions while busy", () => {
		uiLanguage.set("hu");

		render(SkillDraftCard, {
			draft: makeDraft(),
			busy: true,
			actionError: "Nem sikerült menteni a skill vázlatot.",
			onSave: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Nem sikerült menteni a skill vázlatot.",
		);
		expect(
			screen.getByRole("button", { name: "Privát skill mentése" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Vázlat elvetése" }),
		).toBeDisabled();
	});
});
