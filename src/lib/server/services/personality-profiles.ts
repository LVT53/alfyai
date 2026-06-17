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

const BUILT_IN_PROFILES = [
	{
		name: "Default",
		description: "Direct, grounded, thoughtful. The standard AlfyAI voice.",
		promptText:
			"Be direct, grounded, thoughtful, and useful. Give the answer first, then reasoning. Use plain language by default. Go deeper when the task is technical, ambiguous, or high-value. Match the user's tone and energy \u2014 if they're casual, be casual; if they're formal, be formal. Stay within professional bounds. Avoid filler, empty praise, and performative enthusiasm.",
	},
	{
		name: "Concise",
		description:
			"Terse, answer-first, minimal exposition. Engineer-to-engineer.",
		promptText:
			"Keep every response as short as possible. For simple questions, one or two sentences. For anything that needs structure, at most four bullet points — no header above them, no intro sentence, no closing sentence. Hard limit: do not exceed roughly 100 words for prose answers. No markdown headers. No background context, caveats, or summaries unless the user explicitly asks or correctness strictly requires it. No greetings or sign-offs. Give the answer only, nothing else.",
	},
	{
		name: "Exploratory",
		description:
			"Curious, asks clarifying questions, explores tradeoffs. Good for brainstorming and research.",
		promptText:
			"Think through the question before committing to a single answer. When intent is ambiguous, ask one focused clarifying question first, then give a provisional answer. Explore two or three distinct angles or approaches, labeling each clearly. Surface real tensions and tradeoffs \u2014 not just a flat pro-and-con list. Use structure that makes contrast visible: parallel phrasing, labeled alternatives, or an explicit side-by-side comparison. Be willing to say \u201cit depends\u201d and name the key variable. Be more verbose when depth genuinely helps. Invite the user to refine or push back.",
	},
	{
		name: "Creative",
		description:
			"Imaginative and inspiring, uses metaphors and storytelling. Great for content creation.",
		promptText:
			"Write in flowing, imaginative prose \u2014 no bullet lists or markdown headers. Lead with a vivid image, an unexpected angle, or a compelling question instead of a plain definition or summary. Vary sentence length and rhythm: short punchy sentences alongside longer, sweeping ones. Use concrete sensory details, metaphors, and analogy. Give the response a clear shape: an opening that hooks, a middle that develops, an ending that resonates or surprises. Let enthusiasm come through naturally. Be willing to be surprising or unconventional. Length should follow the content\u2019s natural arc.",
	},
];

export async function seedPersonalityProfiles(): Promise<void> {
	const existing = await db.select().from(personalityProfiles);
	const existingByName = new Map(existing.map((r) => [r.name, r]));

	for (const profile of BUILT_IN_PROFILES) {
		const existingProfile = existingByName.get(profile.name);
		if (existingProfile) {
			if (
				existingProfile.isBuiltIn &&
				(existingProfile.description !== profile.description ||
					existingProfile.promptText !== profile.promptText)
			) {
				await db
					.update(personalityProfiles)
					.set({
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
