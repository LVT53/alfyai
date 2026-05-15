import { getConfig } from "$lib/server/config-store";
import type {
	PreflightedChatTurn,
	SkillPromptContext,
	SkillPromptLinkedSource,
} from "$lib/server/services/chat-turn/types";
import type { LinkedContextSource } from "$lib/types";
import { getActiveSkillSession } from "./sessions";
import { getAvailableSkillDefinition } from "./user-skills";

function linkedSourceForPrompt(source: LinkedContextSource): SkillPromptLinkedSource {
	return {
		displayArtifactId: source.displayArtifactId,
		promptArtifactId: source.promptArtifactId,
		familyArtifactIds: source.familyArtifactIds,
		name: source.name,
		type: "document",
		mimeType: source.mimeType,
		documentOrigin: source.documentOrigin,
	};
}

export async function resolveSkillPromptContext(params: {
	userId: string;
	turn: PreflightedChatTurn;
}): Promise<SkillPromptContext | null> {
	const { userId, turn } = params;
	if (turn.deepResearchDepth) return null;
	if (!getConfig().composerCommandRegistryEnabled) return null;

	const linkedSources = turn.linkedSources.map(linkedSourceForPrompt);

	if (turn.pendingSkill) {
		const skill = await getAvailableSkillDefinition(userId, {
			id: turn.pendingSkill.id,
			ownership: turn.pendingSkill.ownership,
		});
		if (skill) {
			return {
				source: "pending_skill",
				skillId: skill.id,
				skillOwnership: skill.ownership,
				skillDisplayName: skill.displayName,
				skillDescription: skill.description,
				skillInstructions: skill.instructions,
				durationPolicy: skill.durationPolicy,
				questionPolicy: skill.questionPolicy,
				notesPolicy: skill.notesPolicy,
				sourceScope: skill.sourceScope,
				skillVersion: skill.version,
				linkedSources,
			};
		}
	}

	const session = await getActiveSkillSession(userId, turn.conversationId);
	if (!session || session.status !== "active") return null;

	return {
		source: "active_session",
		sessionId: session.id,
		sessionStatus: session.status,
		skillId: session.skillId,
		skillOwnership: session.skillOwnership,
		skillDisplayName: session.skillDisplayName,
		skillDescription: session.skillDescription,
		skillInstructions: session.skillInstructions,
		durationPolicy: session.durationPolicy,
		questionPolicy: session.questionPolicy,
		notesPolicy: session.notesPolicy,
		sourceScope: session.sourceScope,
		skillVersion: session.skillVersion,
		linkedSources,
	};
}

function sourceLabel(source: SkillPromptContext["source"]): string {
	return source === "pending_skill" ? "pending skill" : "active skill session";
}

function sourceScopeLabel(sourceScope: SkillPromptContext["sourceScope"]): string {
	return sourceScope === "selected_sources_only"
		? "selected linked sources only"
		: "current conversation context";
}

function buildLinkedSourceLines(sources: SkillPromptLinkedSource[]): string[] {
	if (sources.length === 0) {
		return ["- No linked sources were selected for this turn."];
	}
	return sources.map((source) => {
		const ids = [
			`displayArtifactId: ${source.displayArtifactId}`,
			source.promptArtifactId ? `promptArtifactId: ${source.promptArtifactId}` : null,
		].filter(Boolean);
		return `- ${source.name} (${ids.join("; ")})`;
	});
}

function buildQuestionPolicyLines(context: SkillPromptContext): string[] {
	if (context.questionPolicy !== "ask_when_needed") return [];
	return [
		"- If more information is needed from the user, ask at most one focused question in this assistant turn.",
		"- Do not bundle multiple interview or clarification questions into one response.",
	];
}

export function buildSkillSystemPromptAppendix(
	context: SkillPromptContext | null | undefined,
): string | undefined {
	if (!context) return undefined;
	const questionPolicyLines = buildQuestionPolicyLines(context);

	const metadata = [
		`Source: ${sourceLabel(context.source)}`,
		context.sessionId ? `Session: ${context.sessionId} (${context.sessionStatus})` : null,
		`Skill: ${context.skillDisplayName} (${context.skillOwnership}:${context.skillId}, version ${context.skillVersion})`,
		context.skillDescription ? `Description: ${context.skillDescription}` : null,
		`Duration policy: ${context.durationPolicy}`,
		`Question policy: ${context.questionPolicy}`,
		`Notes policy: ${context.notesPolicy}`,
		`Source scope: ${sourceScopeLabel(context.sourceScope)}`,
	].filter((line): line is string => Boolean(line));

	return [
		"## Active Skill Context",
		...metadata.map((line) => `- ${line}`),
		"",
		"Linked sources available to this skill turn:",
		...buildLinkedSourceLines(context.linkedSources),
		"",
		"Skill instructions:",
		context.skillInstructions.trim(),
		...(questionPolicyLines.length > 0
			? ["", "Skill operating rules:", ...questionPolicyLines]
			: []),
	].join("\n");
}
