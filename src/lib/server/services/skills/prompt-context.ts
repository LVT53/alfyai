// On-demand skill loading (replaces the former session-based Skill Control
// Envelope prompt injection — see drizzle/1777140000088_drop_skill_sessions_and_notes.sql):
//
// 1. `buildSkillCatalogueBlock` renders the compact "## Skills available"
//    block the per-turn packet carries for every enabled skill (system packs
//    + the user's own), so the model can decide whether a skill matches the
//    request.
// 2. `resolveSkillInstructionsForUse` looks a skill up by the `name` the
//    model passed to the `use_skill` tool and returns its full effective
//    instructions plus up to 3 selected pack resources.
// 3. `resolvePendingSkillApplication` does the same for an explicit `$`
//    composer selection, forcing that skill's instructions into the packet
//    for the turn without a durable session row.
//
// Both (2) and (3) share `buildSkillInstructionsEnvelope` so the model sees
// byte-identical instruction framing regardless of how the skill was loaded.

import {
	discoverSkillSummaries,
	localizeSkillDiscoverySummary,
	type ManagedSkillPromptResource,
	resolveEffectiveSkillDefinition,
	type SkillDiscoverySummary,
} from "$lib/server/services/skills/user-skills";
import type { PendingSkillSelection } from "./types";

const MAX_CATALOGUE_LINES = 15;
const MAX_CATALOGUE_CHARS = 1400;
const MAX_PROMPT_RESOURCES = 3;
const MAX_RESOURCE_CONTENT_LENGTH = 700;

export const SKILLS_AVAILABLE_HEADING = "## Skills available";

export interface SelectedSkillResource {
	id: string;
	title: string;
	content: string;
}

function includesKeyword(text: string, keyword: string): boolean {
	const normalizedKeyword = keyword.trim().toLowerCase();
	return Boolean(normalizedKeyword && text.includes(normalizedKeyword));
}

function truncateResourceContent(value: string): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length <= MAX_RESOURCE_CONTENT_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_RESOURCE_CONTENT_LENGTH - 1).trimEnd()}...`;
}

// Selects up to MAX_PROMPT_RESOURCES pack resources for a skill activation:
// "guidance" resources always apply first, then "domain_template" resources
// whose keywords match the current request — the same rule the former
// session-based prompt injection used.
export function selectSkillResources(
	resources: ManagedSkillPromptResource[] | undefined,
	requestText: string,
): SelectedSkillResource[] {
	if (!resources?.length) return [];
	const normalizedRequest = requestText.toLowerCase();
	const selected: SelectedSkillResource[] = [];

	for (const resource of resources) {
		if (resource.kind !== "guidance") continue;
		selected.push({
			id: resource.id,
			title: resource.title,
			content: truncateResourceContent(resource.content),
		});
		if (selected.length >= MAX_PROMPT_RESOURCES) return selected;
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
			content: truncateResourceContent(resource.content),
		});
		if (selected.length >= MAX_PROMPT_RESOURCES) return selected;
	}

	return selected;
}

// Shared instruction framing for both the `use_skill` tool result and a
// forced `$` selection — the model sees the same envelope either way.
export function buildSkillInstructionsEnvelope(params: {
	displayName: string;
	instructions: string;
	resources: SelectedSkillResource[];
}): string {
	const { displayName, instructions, resources } = params;
	const lines = [
		`Skill "${displayName}" instructions — apply these for the rest of this turn:`,
		"",
		instructions.trim(),
	];
	if (resources.length > 0) {
		lines.push("", "Additional skill resources:");
		for (const resource of resources) {
			lines.push(`- ${resource.title}: ${resource.content}`);
		}
	}
	return lines.join("\n");
}

function truncateDescription(description: string, maxLength: number): string {
	const normalized = description.trim();
	if (maxLength <= 0) return "";
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

// Builds the compact per-turn "## Skills available" catalogue block: one
// `name — description` line per enabled skill, capped at MAX_CATALOGUE_LINES
// lines and MAX_CATALOGUE_CHARS characters total (descriptions are
// truncated, never names). Returns null when the user has no enabled skills.
export function buildSkillCatalogueBlock(
	entries: SkillDiscoverySummary[],
): string | null {
	if (entries.length === 0) return null;
	const capped = entries.slice(0, MAX_CATALOGUE_LINES);
	let remaining = MAX_CATALOGUE_CHARS - SKILLS_AVAILABLE_HEADING.length - 1;
	const lines: string[] = [];

	for (let index = 0; index < capped.length; index += 1) {
		const entry = capped[index];
		const prefix = `- ${entry.displayName} — `;
		const linesLeft = capped.length - index;
		const budgetForThisLine = Math.max(
			0,
			Math.floor(remaining / linesLeft) - 1,
		);
		const descriptionBudget = Math.max(0, budgetForThisLine - prefix.length);
		const description = truncateDescription(
			entry.description,
			descriptionBudget,
		);
		const line = `${prefix}${description}`;
		lines.push(line);
		remaining -= line.length + 1;
	}

	return [SKILLS_AVAILABLE_HEADING, ...lines].join("\n");
}

// Fetches the user's enabled skills (system packs + their own), localized
// for display, ready to pass to buildSkillCatalogueBlock.
export async function listSkillCatalogueEntries(
	userId: string,
	language?: "en" | "hu",
): Promise<SkillDiscoverySummary[]> {
	const summaries = await discoverSkillSummaries(userId);
	return summaries.map((summary) =>
		localizeSkillDiscoverySummary(summary, language),
	);
}

export type SkillLookupFailureReason = "not_found" | "disabled";

export type SkillLookupResult =
	| {
			ok: true;
			skillId: string;
			skillOwnership: "user" | "system";
			skillKind: "user_skill" | "skill_pack" | "skill_variant";
			displayName: string;
			envelope: string;
	  }
	| { ok: false; reason: SkillLookupFailureReason };

async function resolveSkillByName(
	userId: string,
	name: string,
): Promise<SkillDiscoverySummary | null> {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return null;
	// Models write the name in several shapes — "Plan Critic", "plan-critic",
	// "plan_critic", the id "system:grill-with-docs" or its tail
	// "grill-with-docs" — so compare on a letters-and-digits key as well.
	const key = (value: string) =>
		value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
	const wanted = key(normalized);
	const summaries = await discoverSkillSummaries(userId);
	return (
		summaries.find((summary) =>
			skillNamesFor(summary).some(
				(candidate) => candidate.trim().toLowerCase() === normalized,
			),
		) ??
		summaries.find((summary) => {
			const id = summary.id.trim().toLowerCase();
			const idTail = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
			return (
				skillNamesFor(summary).some((candidate) => key(candidate) === wanted) ||
				key(id) === wanted ||
				key(idTail) === wanted
			);
		}) ??
		null
	);
}

// Every name a model could plausibly have been shown for one skill: its
// stored name, its id, and — for a system pack — the localized display names
// `listSkillCatalogueEntries` renders into the catalogue (the model can only
// echo the name it saw, so a Hungarian catalogue line must resolve too).
function skillNamesFor(summary: SkillDiscoverySummary): string[] {
	const names = [summary.displayName, summary.id];
	if (summary.ownership === "system" && "localizedDefaults" in summary) {
		names.push(
			summary.localizedDefaults.en.displayName,
			summary.localizedDefaults.hu.displayName,
		);
	}
	return names.filter((name) => Boolean(name?.trim()));
}

async function resolveSkillEnvelopeById(params: {
	userId: string;
	id: string;
	ownership: "user" | "system";
	requestText: string;
}): Promise<SkillLookupResult> {
	const { userId, id, ownership, requestText } = params;
	const effective = await resolveEffectiveSkillDefinition(userId, {
		id,
		ownership,
	});
	if (!effective.available) return { ok: false, reason: "disabled" };

	const resources = selectSkillResources(
		effective.promptResources,
		requestText,
	);
	const envelope = buildSkillInstructionsEnvelope({
		displayName: effective.displayName,
		instructions: effective.effectiveInstructions,
		resources,
	});
	return {
		ok: true,
		skillId: effective.id,
		skillOwnership: effective.ownership,
		skillKind: effective.skillKind,
		displayName: effective.displayName,
		envelope,
	};
}

// Backing implementation for the `use_skill` tool: resolves the model's
// `name` argument (matched against displayName or id, case-insensitively)
// against the user's enabled skills, and returns its full instructions.
export async function resolveSkillInstructionsForUse(params: {
	userId: string;
	name: string;
	requestText: string;
}): Promise<SkillLookupResult> {
	const match = await resolveSkillByName(params.userId, params.name);
	if (!match) return { ok: false, reason: "not_found" };
	return resolveSkillEnvelopeById({
		userId: params.userId,
		id: match.id,
		ownership: match.ownership,
		requestText: params.requestText,
	});
}

// Backing implementation for an explicit `$` composer selection: resolves
// the pending skill and returns the same envelope shape `use_skill` would,
// so the server can inject it into the packet for this turn only — no
// durable session row.
export async function resolvePendingSkillApplication(params: {
	userId: string;
	pendingSkill: PendingSkillSelection;
	requestText: string;
}): Promise<SkillLookupResult> {
	return resolveSkillEnvelopeById({
		userId: params.userId,
		id: params.pendingSkill.id,
		ownership: params.pendingSkill.ownership,
		requestText: params.requestText,
	});
}
