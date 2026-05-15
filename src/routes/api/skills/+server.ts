import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	createUserSkillDefinition,
	listEnabledSystemSkillSummaries,
	listUserSkillDefinitions,
	localizeSystemSkillSummary,
	seedBuiltInSystemSkillDefinitions,
	UserSkillValidationError,
	type CreateUserSkillDefinitionInput,
	type SystemSkillSummary,
} from "$lib/server/services/skills/user-skills";

function disabledResponse() {
	return json(
		{
			error: "Composer Command Registry is disabled.",
			errorKey: "composerCommandRegistry.disabled",
		},
		{ status: 404 },
	);
}

function ensureEnabled() {
	return getConfig().composerCommandRegistryEnabled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readCreateInput(body: unknown): CreateUserSkillDefinitionInput {
	const record = isRecord(body) ? body : {};
	return {
		displayName: typeof record.displayName === "string" ? record.displayName : "",
		description: typeof record.description === "string" ? record.description : undefined,
		instructions: typeof record.instructions === "string" ? record.instructions : "",
		activationExamples: Array.isArray(record.activationExamples)
			? record.activationExamples.filter((item): item is string => typeof item === "string")
			: undefined,
		enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
		durationPolicy: typeof record.durationPolicy === "string" ? record.durationPolicy : undefined,
		questionPolicy: typeof record.questionPolicy === "string" ? record.questionPolicy : undefined,
		notesPolicy: typeof record.notesPolicy === "string" ? record.notesPolicy : undefined,
		sourceScope: typeof record.sourceScope === "string" ? record.sourceScope : undefined,
		creationSource: typeof record.creationSource === "string" ? record.creationSource : undefined,
	} as CreateUserSkillDefinitionInput;
}

function validationResponse(error: UserSkillValidationError) {
	return json({ error: error.message, errorKey: error.code }, { status: error.status });
}

function instructionFreeLocalizedDefaults(value: unknown): SystemSkillSummary["localizedDefaults"] {
	const defaults = isRecord(value) ? value : {};
	const en = isRecord(defaults.en) ? defaults.en : {};
	const hu = isRecord(defaults.hu) ? defaults.hu : {};
	return {
		en: {
			displayName: typeof en.displayName === "string" ? en.displayName : "",
			description: typeof en.description === "string" ? en.description : "",
		},
		hu: {
			displayName: typeof hu.displayName === "string" ? hu.displayName : "",
			description: typeof hu.description === "string" ? hu.description : "",
		},
	};
}

function publicSystemSkillSummary(skill: SystemSkillSummary): SystemSkillSummary {
	const { instructions: _instructions, localizedDefaults, ...summary } = skill as SystemSkillSummary & {
		instructions?: unknown;
	};
	return {
		...summary,
		localizedDefaults: instructionFreeLocalizedDefaults(localizedDefaults),
	};
}

export const GET: RequestHandler = async (event) => {
	requireAuth(event);

	if (!ensureEnabled()) {
		return disabledResponse();
	}

	const user = event.locals.user!;
	await seedBuiltInSystemSkillDefinitions(user.id);
	const [skills, systemSkills] = await Promise.all([
		listUserSkillDefinitions(user.id),
		listEnabledSystemSkillSummaries(),
	]);
	return json({
		skills,
		systemSkills: systemSkills
			.map((skill) => localizeSystemSkillSummary(skill, user.uiLanguage))
			.map(publicSystemSkillSummary),
	});
};

export const POST: RequestHandler = async (event) => {
	requireAuth(event);

	if (!ensureEnabled()) {
		return disabledResponse();
	}

	const user = event.locals.user!;
	const body = await event.request.json().catch(() => ({}));
	try {
		const skill = await createUserSkillDefinition(user.id, readCreateInput(body));
		return json({ skill }, { status: 201 });
	} catch (error) {
		if (error instanceof UserSkillValidationError) {
			return validationResponse(error);
		}
		throw error;
	}
};
