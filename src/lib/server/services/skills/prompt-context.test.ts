import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(() => ({ composerCommandRegistryEnabled: true })),
	getActiveSkillSession: vi.fn(),
	getAvailableSkillDefinition: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mocks.getConfig,
}));

vi.mock("./sessions", () => ({
	getActiveSkillSession: mocks.getActiveSkillSession,
}));

vi.mock("./user-skills", () => ({
	getAvailableSkillDefinition: mocks.getAvailableSkillDefinition,
}));

import {
	buildSkillSystemPromptAppendix,
	resolveSkillPromptContext,
} from "./prompt-context";
import type { PreflightedChatTurn } from "$lib/server/services/chat-turn/types";

function makeTurn(
	overrides: Partial<PreflightedChatTurn> = {},
): PreflightedChatTurn {
	return {
		conversationId: "conv-1",
		normalizedMessage: "Help me prepare",
		modelId: "model1",
		modelDisplayName: "Model 1",
		attachmentIds: [],
		linkedSources: [],
		pendingSkill: null,
		thinkingMode: "auto",
		skipPersistUserMessage: false,
		...overrides,
	};
}

describe("skill prompt context", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
		mocks.getActiveSkillSession.mockResolvedValue(null);
		mocks.getAvailableSkillDefinition.mockResolvedValue(null);
	});

	it("builds a pending-skill appendix from the available definition without changing the user message", async () => {
		mocks.getAvailableSkillDefinition.mockResolvedValueOnce({
			id: "skill-1",
			ownership: "user",
			displayName: "Interview coach",
			description: "Runs a focused interview.",
			instructions: "Ask one concise follow-up question before drafting.",
			activationExamples: ["interview me first"],
			enabled: true,
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			creationSource: "user_created",
			version: 3,
			createdAt: 1,
			updatedAt: 2,
		});
		const turn = makeTurn({
			normalizedMessage: "  already normalized by parser  ".trim(),
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				displayName: "Interview coach",
			},
			linkedSources: [
				{
					displayArtifactId: "display-1",
					promptArtifactId: "prompt-1",
					familyArtifactIds: ["display-1", "prompt-1"],
					name: "Discovery notes.pdf",
					type: "document",
				},
			],
		});

		const context = await resolveSkillPromptContext({
			userId: "user-1",
			turn,
		});
		const appendix = buildSkillSystemPromptAppendix(context);

		expect(turn.normalizedMessage).toBe("already normalized by parser");
		expect(context).toMatchObject({
			source: "pending_skill",
			skillId: "skill-1",
			skillDisplayName: "Interview coach",
			skillInstructions: "Ask one concise follow-up question before drafting.",
			sourceScope: "selected_sources_only",
			linkedSources: [
				expect.objectContaining({
					displayArtifactId: "display-1",
					promptArtifactId: "prompt-1",
					name: "Discovery notes.pdf",
				}),
			],
		});
		expect(appendix).toContain("## Active Skill Context");
		expect(appendix).toContain("Source: pending skill");
		expect(appendix).toContain("Interview coach");
		expect(appendix).toContain("Ask one concise follow-up question before drafting.");
		expect(appendix).toContain("selected linked sources only");
		expect(appendix).toContain("Discovery notes.pdf");
		expect(appendix).toContain("displayArtifactId: display-1");
		expect(mocks.getActiveSkillSession).not.toHaveBeenCalled();
	});

	it("uses active durable session snapshots and omits skill context for Deep Research", async () => {
		mocks.getActiveSkillSession.mockResolvedValueOnce({
			id: "session-1",
			userId: "user-1",
			conversationId: "conv-1",
			skillId: "skill-1",
			skillOwnership: "system",
			status: "active",
			pauseReason: null,
			endReason: null,
			skillDisplayName: "Code Review",
			skillDescription: "Reviews changes.",
			skillInstructions: "Lead with bugs and missing tests.",
			activationExamples: ["review this diff"],
			durationPolicy: "session",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "current_conversation",
			skillVersion: 5,
			startedFrom: "pending_skill",
			startedAt: 1,
			updatedAt: 2,
			pausedAt: null,
			endedAt: null,
			milestones: [],
		});

		const context = await resolveSkillPromptContext({
			userId: "user-1",
			turn: makeTurn(),
		});
		const appendix = buildSkillSystemPromptAppendix(context);

		expect(context).toMatchObject({
			source: "active_session",
			sessionId: "session-1",
			sessionStatus: "active",
			skillDisplayName: "Code Review",
			skillInstructions: "Lead with bugs and missing tests.",
			sourceScope: "current_conversation",
		});
		expect(appendix).toContain("Source: active skill session");
		expect(appendix).toContain("Session: session-1 (active)");
		expect(appendix).toContain("current conversation context");
		expect(appendix).toContain("Lead with bugs and missing tests.");

		await expect(
			resolveSkillPromptContext({
				userId: "user-1",
				turn: makeTurn({ deepResearchDepth: "standard" }),
			}),
		).resolves.toBeNull();
		expect(mocks.getActiveSkillSession).toHaveBeenCalledTimes(1);
	});
});
