import * as crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { personalityProfiles } from "../db/schema";

export interface PersonalityProfile {
	id: string;
	name: string;
	description: string;
	promptText: string;
	isBuiltIn: boolean;
	createdAt: Date;
}

export async function listPersonalityProfiles(): Promise<PersonalityProfile[]> {
	const rows = await db
		.select()
		.from(personalityProfiles)
		.orderBy(personalityProfiles.createdAt);
	return rows.map((row) => ({
		...row,
		isBuiltIn: Boolean(row.isBuiltIn),
	}));
}

export async function getPersonalityProfile(
	id: string,
): Promise<PersonalityProfile | null> {
	const [row] = await db
		.select()
		.from(personalityProfiles)
		.where(eq(personalityProfiles.id, id));
	return row
		? {
				...row,
				isBuiltIn: Boolean(row.isBuiltIn),
			}
		: null;
}

export async function createPersonalityProfile(params: {
	name: string;
	description: string;
	promptText: string;
}): Promise<PersonalityProfile> {
	const id = crypto.randomUUID();
	await db.insert(personalityProfiles).values({
		id,
		name: params.name,
		description: params.description,
		promptText: params.promptText,
		isBuiltIn: 0,
	});
	const profile = await getPersonalityProfile(id);
	if (!profile)
		throw new Error("Created personality profile could not be loaded");
	return profile;
}

export async function updatePersonalityProfile(
	id: string,
	params: { name?: string; description?: string; promptText?: string },
): Promise<PersonalityProfile | null> {
	const updates: Record<string, unknown> = {};
	if (params.name !== undefined) updates.name = params.name;
	if (params.description !== undefined)
		updates.description = params.description;
	if (params.promptText !== undefined) updates.promptText = params.promptText;

	if (Object.keys(updates).length === 0) return getPersonalityProfile(id);

	await db
		.update(personalityProfiles)
		.set(updates)
		.where(eq(personalityProfiles.id, id));
	return getPersonalityProfile(id);
}

export async function deletePersonalityProfile(id: string): Promise<boolean> {
	const [profile] = await db
		.select()
		.from(personalityProfiles)
		.where(eq(personalityProfiles.id, id));
	if (!profile || profile.isBuiltIn) return false;
	await db.delete(personalityProfiles).where(eq(personalityProfiles.id, id));
	return true;
}

const BUILT_IN_PROFILES: ReadonlyArray<{
	name: string;
	/** The name this built-in carried before it was renamed, if any. */
	legacyName?: string;
	description: string;
	promptText: string;
}> = [
	{
		name: "Default",
		description: "Direct, grounded, thoughtful. The standard AlfyAI voice.",
		promptText:
			"Be direct, grounded, thoughtful, and useful. Give the answer first, then reasoning. Use plain language by default. Go deeper when the task is technical, ambiguous, or high-value. Match the user's tone and energy \u2014 if they're casual, be casual; if they're formal, be formal. Stay within professional bounds. Avoid filler, empty praise, and performative enthusiasm.",
	},
	{
		name: "Brief",
		legacyName: "Concise",
		description:
			"As short as the question allows. Answer first, no preamble, no sign-off.",
		promptText:
			"Answer in as few words as the question allows: one or two sentences for a simple question, one screen at most for anything else. Give the answer first. No preamble, no restating the question, no closing line, no greeting. Use a short list only when the content really is a list; never a header. Leave out caveats and background unless the answer would be wrong without them. For code, a command or a procedure, give the code or the steps and nothing else. Never cut an answer short if that would make it incomplete or incorrect.",
	},
	{
		name: "Thinking partner",
		legacyName: "Exploratory",
		description:
			"Curious, asks one clarifying question, explores tradeoffs. Good for brainstorming and research.",
		promptText:
			"Think through the question before committing to a single answer. When intent is ambiguous, ask one focused clarifying question first, then give a provisional answer. Explore two or three distinct angles or approaches, labeling each clearly. Surface real tensions and tradeoffs \u2014 not just a flat pro-and-con list. Use structure that makes contrast visible: parallel phrasing, labeled alternatives, or an explicit side-by-side comparison. Be willing to say \u201cit depends\u201d and name the key variable. Be more verbose when depth genuinely helps. Invite the user to refine or push back.",
	},
	{
		name: "Storyteller",
		legacyName: "Creative",
		description:
			"Imaginative prose, metaphor and rhythm. For writing, ideas and anything that should read well.",
		promptText:
			"Write in flowing, imaginative prose by default. Lead with a vivid image, an unexpected angle, or a compelling question instead of a plain definition or summary. Vary sentence length and rhythm: short punchy sentences alongside longer, sweeping ones. Use concrete sensory details, metaphors, and analogy. Give the response a clear shape: an opening that hooks, a middle that develops, an ending that resonates or surprises. Use a list or a heading only when the content genuinely is a list or a sequence, and keep it light when you do. Let enthusiasm come through naturally. Be willing to be surprising or unconventional. Length should follow the content\u2019s natural arc.",
	},
	{
		name: "Technical",
		description:
			"Exact terms, code and commands first, sources named, assumptions stated. No analogies.",
		promptText:
			"Be precise. Use the exact names, terms, versions, units, flags and error messages; never paraphrase an identifier. When a command, a piece of code or a configuration answers the question, give it first, complete and runnable, then explain it. State your assumptions explicitly and say what you are not sure of. Prefer the primary source \u2014 the specification, the manual, the official documentation \u2014 and name it when it matters. No analogies, no motivation, no filler, no reassurance. When several approaches are correct, name them, say which you would pick and why, and mention the failure mode of each. Use lists and tables when they make a comparison exact.",
	},
	{
		name: "Warm",
		description:
			"Plain words, patient, one thing at a time. For anyone who wants help, not a lecture.",
		promptText:
			"Use plain, everyday words and short sentences. Explain one idea at a time. For anything with steps, give the steps in order, numbered, in small pieces, and say what the person should see after each one. Avoid jargon; when a technical word cannot be avoided, explain it in a few words the first time. Be patient and kind without being sugary: reassure by being clear, not by adding praise. Never talk down and never assume the person made a mistake. When the topic is hard, check understanding lightly once, then continue. Match the person\u2019s language and formality.",
	},
];

export async function seedPersonalityProfiles(): Promise<void> {
	const existing = await db.select().from(personalityProfiles);
	const existingByName = new Map(existing.map((r) => [r.name, r]));

	for (const profile of BUILT_IN_PROFILES) {
		// A renamed built-in is updated IN PLACE under its old row, so every
		// conversation and user default that points at its id keeps working
		// and the old name simply stops existing. A user-made style that
		// happens to carry the new name is never touched.
		const legacy = profile.legacyName
			? existingByName.get(profile.legacyName)
			: undefined;
		const existingProfile =
			existingByName.get(profile.name) ??
			(legacy?.isBuiltIn ? legacy : undefined);
		if (existingProfile) {
			if (
				existingProfile.isBuiltIn &&
				(existingProfile.name !== profile.name ||
					existingProfile.description !== profile.description ||
					existingProfile.promptText !== profile.promptText)
			) {
				await db
					.update(personalityProfiles)
					.set({
						name: profile.name,
						description: profile.description,
						promptText: profile.promptText,
					})
					.where(eq(personalityProfiles.id, existingProfile.id));
			}
			continue;
		}
		await db
			.insert(personalityProfiles)
			.values({
				id: crypto.randomUUID(),
				name: profile.name,
				description: profile.description,
				promptText: profile.promptText,
				isBuiltIn: 1,
			})
			.onConflictDoNothing({ target: personalityProfiles.name });
	}
}
