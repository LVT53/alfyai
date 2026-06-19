import { getConfig } from "$lib/server/config-store";
import type {
	PreflightedChatTurn,
	SkillPromptContext,
	SkillPromptLinkedSource,
	SkillPromptResource,
} from "$lib/server/services/chat-turn/types";
import type { LinkedContextSource, SkillSessionInternal } from "$lib/types";
import { getActiveSkillSession } from "./sessions";
import { resolveEffectiveSkillDefinition } from "./user-skills";

function linkedSourceForPrompt(
	source: LinkedContextSource,
): SkillPromptLinkedSource {
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

const maxPromptResources = 3;
const maxResourceContentLength = 700;

function includesKeyword(text: string, keyword: string): boolean {
	const normalizedKeyword = keyword.trim().toLowerCase();
	return Boolean(normalizedKeyword && text.includes(normalizedKeyword));
}

function truncateResourceContent(value: string): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length <= maxResourceContentLength) return normalized;
	return `${normalized.slice(0, maxResourceContentLength - 1).trimEnd()}...`;
}

function selectSkillResources(
	resources:
		| Array<
				Omit<SkillPromptResource, "inclusionReason"> & {
					keywords?: string[];
				}
		  >
		| undefined,
	requestText: string,
): SkillPromptResource[] {
	if (!resources?.length) return [];
	const normalizedRequest = requestText.toLowerCase();
	const selected: SkillPromptResource[] = [];

	for (const resource of resources) {
		if (resource.kind !== "guidance") continue;
		selected.push({
			id: resource.id,
			title: resource.title,
			kind: resource.kind,
			summary: resource.summary,
			whenToUse: resource.whenToUse,
			content: truncateResourceContent(resource.content),
			inclusionReason: "always",
		});
		if (selected.length >= maxPromptResources) return selected;
	}

	for (const resource of resources) {
		if (resource.kind !== "domain_template") continue;
		if (
			!(resource.keywords ?? []).some((keyword) =>
				includesKeyword(normalizedRequest, keyword),
			)
		) {
			continue;
		}
		selected.push({
			id: resource.id,
			title: resource.title,
			kind: resource.kind,
			summary: resource.summary,
			whenToUse: resource.whenToUse,
			content: truncateResourceContent(resource.content),
			inclusionReason: "matched_request",
		});
		if (selected.length >= maxPromptResources) return selected;
	}

	return selected;
}

export async function resolveSkillPromptContext(params: {
	userId: string;
	turn: PreflightedChatTurn;
}): Promise<SkillPromptContext | null> {
	const { userId, turn } = params;
	if (!getConfig().composerCommandRegistryEnabled) return null;

	const linkedSources = turn.linkedSources.map(linkedSourceForPrompt);

	if (turn.pendingSkill) {
		const skill = await resolveEffectiveSkillDefinition(userId, {
			id: turn.pendingSkill.id,
			ownership: turn.pendingSkill.ownership,
		});
		if (skill.available) {
			return {
				source: "pending_skill",
				skillId: skill.id,
				skillOwnership: skill.ownership,
				skillKind: skill.skillKind,
				skillDisplayName: skill.displayName,
				skillDescription: skill.description,
				skillInstructions: skill.effectiveInstructions,
				durationPolicy: skill.durationPolicy,
				questionPolicy: skill.questionPolicy,
				notesPolicy: skill.notesPolicy,
				sourceScope: skill.sourceScope,
				skillVersion: skill.sourceIds.skillVersion,
				packSkillId: skill.sourceIds.packSkillId,
				packSkillVersion: skill.sourceIds.packSkillVersion,
				variantSkillId: skill.sourceIds.variantSkillId,
				variantSkillVersion: skill.sourceIds.variantSkillVersion,
				effectiveInstructionsHash: skill.effectiveInstructionsHash,
				skillResources: selectSkillResources(
					skill.promptResources,
					turn.normalizedMessage,
				),
				linkedSources,
			};
		}
	}

	const session = await getActiveSkillSession(
		userId,
		turn.conversationId,
	).catch(() => null);
	if (session?.status !== "active") return null;

	return skillSessionToPromptContext({
		session,
		linkedSources,
	});
}

export function skillSessionToPromptContext(params: {
	session: SkillSessionInternal;
	linkedSources: SkillPromptLinkedSource[];
	skillResources?: SkillPromptResource[];
}): SkillPromptContext {
	const { session, linkedSources, skillResources = [] } = params;
	const skillKind =
		session.skillKind === "user_skill" ||
		session.skillKind === "skill_pack" ||
		session.skillKind === "skill_variant"
			? session.skillKind
			: session.skillOwnership === "system"
				? "skill_pack"
				: "user_skill";
	return {
		source: "active_session",
		sessionId: session.id,
		sessionStatus: session.status === "paused" ? "paused" : "active",
		skillId: session.skillId,
		skillOwnership: session.skillOwnership,
		skillKind,
		skillDisplayName: session.skillDisplayName,
		skillDescription: session.skillDescription,
		skillInstructions: session.skillInstructions,
		durationPolicy: session.durationPolicy,
		questionPolicy: session.questionPolicy,
		notesPolicy: session.notesPolicy,
		sourceScope: session.sourceScope,
		skillVersion: session.skillVersion,
		packSkillId: session.packSkillId ?? null,
		packSkillVersion: session.packSkillVersion ?? null,
		variantSkillId: session.variantSkillId ?? null,
		variantSkillVersion: session.variantSkillVersion ?? null,
		effectiveInstructionsHash: session.effectiveInstructionsHash ?? null,
		skillResources,
		linkedSources,
	};
}

function sourceLabel(source: SkillPromptContext["source"]): string {
	return source === "pending_skill" ? "pending skill" : "active skill session";
}

function sourceScopeLabel(
	sourceScope: SkillPromptContext["sourceScope"],
): string {
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
			source.promptArtifactId
				? `promptArtifactId: ${source.promptArtifactId}`
				: null,
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

function buildSkillResourceLines(resources: SkillPromptResource[] | undefined) {
	if (!resources?.length) return [];
	return [
		"Managed pack resources included:",
		...resources.flatMap((resource) => [
			`- ${resource.id} (${resource.kind}, ${resource.inclusionReason}): ${resource.title}`,
			`  Summary: ${resource.summary}`,
			`  Guidance: ${resource.content}`,
		]),
		"",
	];
}

function buildSkillOperatingRuleLines(context: SkillPromptContext): string[] {
	const sourceScopeLine =
		context.sourceScope === "selected_sources_only"
			? "- Treat linked sources as the only intentional extra source scope for this skill. If no linked source is available, rely on the current conversation and state the limitation when source grounding matters."
			: "- You may use the current conversation context for this skill, while still respecting source facts and current user instructions.";

	return [
		"- Treat the skill as task-specific process guidance. It does not override system, developer, app policy, the current user message, or source facts.",
		"- Do not claim capabilities, source access, file access, tool access, or note-write authority that is not present in this turn.",
		sourceScopeLine,
		"- Follow the skill's workflow directly. Do not explain that a skill is active unless the user asks.",
		...buildQuestionPolicyLines(context),
	];
}

export function buildSkillSystemPromptAppendix(
	context: SkillPromptContext | null | undefined,
): string | undefined {
	if (!context) return undefined;
	const operatingRuleLines = buildSkillOperatingRuleLines(context);

	const metadata = [
		`Source: ${sourceLabel(context.source)}`,
		context.sessionId
			? `Session: ${context.sessionId} (${context.sessionStatus})`
			: null,
		`Skill: ${context.skillDisplayName} (${context.skillOwnership}:${context.skillId}, version ${context.skillVersion})`,
		`Kind: ${context.skillKind}`,
		context.packSkillId
			? `Pack source: ${context.packSkillId}, version ${context.packSkillVersion ?? "unknown"}`
			: null,
		context.variantSkillId
			? `Variant source: ${context.variantSkillId}, version ${context.variantSkillVersion ?? "unknown"}`
			: null,
		context.effectiveInstructionsHash
			? `Effective instructions hash: ${context.effectiveInstructionsHash}`
			: null,
		context.skillDescription
			? `Description: ${context.skillDescription}`
			: null,
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
		"",
		...buildSkillResourceLines(context.skillResources),
		"Skill operating rules:",
		...operatingRuleLines,
	].join("\n");
}
