import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAdmin } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	createSystemSkillDefinition,
	listAdminSystemSkillDefinitions,
	seedBuiltInSystemSkillDefinitions,
	UserSkillValidationError,
	type CreateSystemSkillDefinitionInput,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readCreateInput(body: unknown): CreateSystemSkillDefinitionInput {
	const record = isRecord(body) ? body : {};
	return {
		displayName: typeof record.displayName === "string" ? record.displayName : "",
		description: typeof record.description === "string" ? record.description : undefined,
		instructions: typeof record.instructions === "string" ? record.instructions : "",
		activationExamples: Array.isArray(record.activationExamples)
			? record.activationExamples.filter((item): item is string => typeof item === "string")
			: undefined,
		enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
		published: typeof record.published === "boolean" ? record.published : undefined,
		durationPolicy: typeof record.durationPolicy === "string" ? record.durationPolicy : undefined,
		questionPolicy: typeof record.questionPolicy === "string" ? record.questionPolicy : undefined,
		notesPolicy: typeof record.notesPolicy === "string" ? record.notesPolicy : undefined,
		sourceScope: typeof record.sourceScope === "string" ? record.sourceScope : undefined,
		creationSource: typeof record.creationSource === "string" ? record.creationSource : undefined,
	} as CreateSystemSkillDefinitionInput;
}

function validationResponse(error: UserSkillValidationError) {
	return json({ error: error.message, errorKey: error.code }, { status: error.status });
}

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return disabledResponse();
	}

	await seedBuiltInSystemSkillDefinitions(event.locals.user!.id);
	return json({ skills: await listAdminSystemSkillDefinitions() });
};

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);

	if (!getConfig().composerCommandRegistryEnabled) {
		return disabledResponse();
	}

	const body = await event.request.json().catch(() => ({}));
	try {
		const skill = await createSystemSkillDefinition(event.locals.user!.id, readCreateInput(body));
		return json({ skill }, { status: 201 });
	} catch (error) {
		if (error instanceof UserSkillValidationError) {
			return validationResponse(error);
		}
		throw error;
	}
};
