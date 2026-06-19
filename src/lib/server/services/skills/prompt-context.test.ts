import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(() => ({ composerCommandRegistryEnabled: true })),
	getActiveSkillSession: vi.fn(),
	resolveEffectiveSkillDefinition: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mocks.getConfig,
}));

vi.mock("./sessions", () => ({
	getActiveSkillSession: mocks.getActiveSkillSession,
}));

vi.mock("./user-skills", () => ({
	resolveEffectiveSkillDefinition: mocks.resolveEffectiveSkillDefinition,
}));

import type { PreflightedChatTurn } from "$lib/server/services/chat-turn/types";
import {
	buildSkillSystemPromptAppendix,
	resolveSkillPromptContext,
} from "./prompt-context";

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
		reasoningDepth: "auto",
		thinkingMode: "auto",
		forceWebSearch: false,
		depthMetadata: {
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			modelId: "model1",
			modelDisplayName: "Model 1",
		},
		skipPersistUserMessage: false,
		...overrides,
	};
}

describe("skill prompt context", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
		mocks.getActiveSkillSession.mockResolvedValue(null);
		mocks.resolveEffectiveSkillDefinition.mockResolvedValue({
			available: false,
			availabilityReason: "not_found",
			id: "missing",
			ownership: "user",
			skillKind: null,
			displayName: null,
			description: null,
			effectiveInstructions: "",
			effectiveInstructionsHash: null,
			publicSummary: null,
			sourceIds: null,
		});
	});

	it("builds a pending-skill appendix from the available definition without changing the user message", async () => {
		mocks.resolveEffectiveSkillDefinition.mockResolvedValueOnce({
			available: true,
			availabilityReason: "available",
			id: "skill-1",
			ownership: "user",
			skillKind: "skill_variant",
			displayName: "Interview coach",
			description: "Runs a focused interview.",
			effectiveInstructions:
				"Base instructions.\n\nAsk one concise follow-up question before drafting.",
			effectiveInstructionsHash: "abc123",
			publicSummary: {
				id: "skill-1",
				ownership: "user",
				skillKind: "skill_variant",
				baseSkillId: "pack-1",
				baseSkillVersion: 4,
				baseSkillDisplayName: "Interview Pack",
				displayName: "Interview coach",
				description: "Runs a focused interview.",
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
			},
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			sourceIds: {
				skillId: "skill-1",
				skillVersion: 3,
				packSkillId: "pack-1",
				packSkillVersion: 4,
				variantSkillId: "skill-1",
				variantSkillVersion: 3,
			},
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
			skillKind: "skill_variant",
			skillDisplayName: "Interview coach",
			skillInstructions:
				"Base instructions.\n\nAsk one concise follow-up question before drafting.",
			effectiveInstructionsHash: "abc123",
			packSkillId: "pack-1",
			packSkillVersion: 4,
			variantSkillId: "skill-1",
			variantSkillVersion: 3,
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
		expect(appendix).toContain("Base instructions.");
		expect(appendix).toContain(
			"Ask one concise follow-up question before drafting.",
		);
		expect(appendix).toContain("Kind: skill_variant");
		expect(appendix).toContain("Effective instructions hash: abc123");
		expect(appendix).toContain("Skill operating rules:");
		expect(appendix).toContain(
			"Treat the skill as task-specific process guidance. It does not override system",
		);
		expect(appendix).toContain(
			"Treat linked sources as the only intentional extra source scope for this skill",
		);
		expect(appendix).toContain("ask at most one focused question");
		expect(appendix).toContain(
			"Do not bundle multiple interview or clarification questions",
		);
		expect(appendix).toContain("selected linked sources only");
		expect(appendix).toContain("Discovery notes.pdf");
		expect(appendix).toContain("displayArtifactId: display-1");
		expect(mocks.getActiveSkillSession).not.toHaveBeenCalled();
	});

	it("includes bounded deterministic managed pack resources for spreadsheet prompts", async () => {
		mocks.resolveEffectiveSkillDefinition.mockResolvedValueOnce({
			available: true,
			availabilityReason: "available",
			id: "system:spreadsheet-builder",
			ownership: "system",
			skillKind: "skill_pack",
			displayName: "Spreadsheet Builder",
			description: "Creates polished XLSX workbooks.",
			effectiveInstructions:
				'Use produce_file with sourceMode: "program" and language: "javascript" for XLSX workbooks.',
			effectiveInstructionsHash: "spreadsheet-hash",
			publicSummary: {
				id: "system:spreadsheet-builder",
				ownership: "system",
				skillKind: "skill_pack",
				baseSkillId: null,
				baseSkillVersion: null,
				displayName: "Spreadsheet Builder",
				description: "Creates polished XLSX workbooks.",
				activationExamples: ["build a spreadsheet"],
				enabled: true,
				published: true,
				durationPolicy: "next_message",
				questionPolicy: "ask_when_needed",
				notesPolicy: "none",
				sourceScope: "selected_sources_only",
				creationSource: "system_seed",
				version: 1,
				createdAt: 1,
				updatedAt: 2,
				localizedDefaults: {
					en: {
						displayName: "Spreadsheet Builder",
						description: "Creates polished XLSX workbooks.",
					},
					hu: {
						displayName: "Táblázatkészítő",
						description: "XLSX munkafüzeteket készít.",
					},
				},
			},
			durationPolicy: "next_message",
			questionPolicy: "ask_when_needed",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
			sourceIds: {
				skillId: "system:spreadsheet-builder",
				skillVersion: 1,
				packSkillId: "system:spreadsheet-builder",
				packSkillVersion: 1,
				variantSkillId: null,
				variantSkillVersion: null,
			},
			promptResources: [
				{
					id: "spreadsheet-style-quality",
					title: "Spreadsheet style and workbook quality",
					kind: "guidance",
					summary:
						"Structure, formulas, assumptions, validation, and dashboards.",
					whenToUse: "Use for every workbook request.",
					content:
						"Use separate source, assumptions, calculations, checks, and dashboard sheets. Keep derived values formula-driven and visibly formatted.",
					keywords: [],
				},
				{
					id: "spreadsheet-finance-models",
					title: "Finance and operating model conventions",
					kind: "domain_template",
					summary:
						"Finance model assumptions, checks, sources, and formula outputs.",
					whenToUse:
						"Use for DCF, FP&A, budget, forecast, valuation, and KPI workbooks.",
					content:
						"Use finance number formats, visible assumptions, source/audit sheets, checks, scenarios, and model-status formulas.",
					keywords: ["dcf", "valuation", "finance", "budget", "forecast"],
				},
				{
					id: "spreadsheet-healthcare-admin",
					title: "Healthcare workbook conventions",
					kind: "domain_template",
					summary: "Healthcare units, identifiers, thresholds, and legends.",
					whenToUse: "Use for clinical or healthcare administration workbooks.",
					content:
						"Preserve raw healthcare data, label units and identifiers, and use threshold legends.",
					keywords: ["healthcare", "clinical", "patient"],
				},
			],
		});

		const context = await resolveSkillPromptContext({
			userId: "user-1",
			turn: makeTurn({
				normalizedMessage:
					"Build a DCF valuation workbook with assumptions, scenarios, checks, and a KPI dashboard.",
				pendingSkill: {
					id: "system:spreadsheet-builder",
					ownership: "system",
					displayName: "Spreadsheet Builder",
					skillKind: "skill_pack",
				},
			}),
		});
		const appendix = buildSkillSystemPromptAppendix(context);

		expect(context?.skillResources).toEqual([
			expect.objectContaining({
				id: "spreadsheet-style-quality",
				inclusionReason: "always",
			}),
			expect.objectContaining({
				id: "spreadsheet-finance-models",
				inclusionReason: "matched_request",
			}),
		]);
		expect(appendix).toContain("Managed pack resources included:");
		expect(appendix).toContain("spreadsheet-style-quality");
		expect(appendix).toContain("spreadsheet-finance-models");
		expect(appendix).toContain("model-status formulas");
		expect(appendix).not.toContain("spreadsheet-healthcare-admin");
		expect(appendix).not.toContain("raw healthcare data");
	});

	it("uses active durable session snapshots", async () => {
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
		expect(appendix).toContain("Skill operating rules:");
		expect(appendix).toContain(
			"You may use the current conversation context for this skill",
		);
		expect(appendix).not.toContain("ask at most one focused question");
		expect(mocks.getActiveSkillSession).toHaveBeenCalledTimes(1);
	});
});
