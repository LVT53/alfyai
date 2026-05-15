import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import SkillSessionPanel from "./SkillSessionPanel.svelte";
import type { SkillSession } from "$lib/types";

const session: SkillSession = {
	id: "session-1",
	userId: "user-1",
	conversationId: "conv-1",
	skillId: "skill-1",
	skillOwnership: "user",
	status: "active",
	pauseReason: null,
	endReason: null,
	skillDisplayName: "Meeting critic",
	skillDescription: "Reviews notes",
	activationExamples: [],
	durationPolicy: "session",
	questionPolicy: "none",
	notesPolicy: "create_private_notes",
	sourceScope: "selected_sources_only",
	skillVersion: 1,
	startedFrom: "pending_skill",
	startedAt: 1,
	updatedAt: 1,
	pausedAt: null,
	endedAt: null,
	milestones: [],
};

describe("SkillSessionPanel", () => {
	it("shows the durable session summary and exposes finish/dismiss controls", async () => {
		const onFinish = vi.fn();
		const onDismiss = vi.fn();
		const { getByRole, getByText, queryByText } = render(SkillSessionPanel, {
			session,
			onFinish,
			onDismiss,
		});

		const panel = getByRole("region", { name: "Skill session" });
		expect(panel).toBeInTheDocument();
		expect(panel).toHaveClass("skill-session-panel");
		expect(panel.querySelector(".skill-session-panel__status")).toHaveTextContent("Active");
		expect(getByText("Meeting critic")).toBeInTheDocument();
		expect(getByText("Active")).toBeInTheDocument();
		expect(queryByText("Active skill")).not.toBeInTheDocument();
		expect(queryByText("Selected sources only · Private notes")).not.toBeInTheDocument();
		expect(queryByText("Expected next action: continue the chat with this skill active.")).not.toBeInTheDocument();

		await fireEvent.click(getByRole("button", { name: "Finish" }));
		await fireEvent.click(getByRole("button", { name: "Dismiss" }));

		expect(onFinish).toHaveBeenCalledOnce();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	it("surfaces failed note milestones", () => {
		const { getByRole } = render(SkillSessionPanel, {
			session: {
				...session,
				milestones: [
					{
						id: "milestone-1",
						sessionId: "session-1",
						userId: "user-1",
						conversationId: "conv-1",
						kind: "failed_note",
						messageKey: "skillSessions.milestones.failedNote",
						messageParams: {
							errorMessage: "Skill note operations can only mutate Skill Notes.",
						},
						createdAt: 2,
					},
				],
			},
			onFinish: vi.fn(),
			onDismiss: vi.fn(),
		});

		expect(getByRole("status")).toHaveTextContent(
			"Note update failed: Skill note operations can only mutate Skill Notes.",
		);
	});
});
