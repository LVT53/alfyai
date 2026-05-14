import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import type { SkillDraftProposal } from "$lib/types";
import SkillDraftCard from "./SkillDraftCard.svelte";

function makeDraft(overrides: Partial<SkillDraftProposal> = {}): SkillDraftProposal {
	return {
		id: "draft-1",
		status: "proposed",
		displayName: "Meeting critic",
		description: "Review meeting notes for weak follow-ups.",
		instructions: "Find missing owners, vague deadlines, and risky assumptions.",
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

	it("renders review details, broader-capability warnings, and action callbacks", async () => {
		const onSave = vi.fn();
		const onDismiss = vi.fn();
		const onPublish = vi.fn();

		render(SkillDraftCard, {
			draft: makeDraft(),
			canPublishSystem: true,
			onSave,
			onDismiss,
			onPublish,
		});

		expect(screen.getByRole("article", { name: "Skill draft: Meeting critic" })).toBeInTheDocument();
		expect(screen.getByText("Review meeting notes for weak follow-ups.")).toBeInTheDocument();
		expect(screen.getByText("Session")).toBeInTheDocument();
		expect(screen.getByText("Ask when needed")).toBeInTheDocument();
		expect(screen.getByText("Private notes")).toBeInTheDocument();
		expect(screen.getByText("Current conversation")).toBeInTheDocument();
		expect(screen.getByText("Can write private Skill Notes.")).toBeInTheDocument();
		expect(screen.getByText("Can use broad current-conversation context.")).toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Save private skill" }));
		await fireEvent.click(screen.getByRole("button", { name: "Dismiss draft" }));
		await fireEvent.click(screen.getByRole("button", { name: "Publish system skill" }));

		expect(onSave).toHaveBeenCalledWith("draft-1");
		expect(onDismiss).toHaveBeenCalledWith("draft-1");
		expect(onPublish).toHaveBeenCalledWith("draft-1");
	});

	it("uses Hungarian labels for card actions", () => {
		uiLanguage.set("hu");

		render(SkillDraftCard, {
			draft: makeDraft({ notesPolicy: "none", sourceScope: "selected_sources_only" }),
			canPublishSystem: true,
			onSave: vi.fn(),
			onDismiss: vi.fn(),
			onPublish: vi.fn(),
		});

		expect(screen.getByRole("button", { name: "Privát skill mentése" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Vázlat elvetése" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Rendszerskill publikálása" })).toBeInTheDocument();
	});
});
