import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "$lib/server/db";
import { userSkillDefinitions, users } from "$lib/server/db/schema";

export type SkillOwnership = "user" | "system";
export type SkillDurationPolicy = "next_message" | "session";
export type SkillQuestionPolicy = "none" | "ask_when_needed";
export type SkillNotesPolicy = "none" | "create_private_notes";
export type SkillSourceScope = "current_conversation" | "selected_sources_only";
export type SkillCreationSource = "user_created" | "ai_draft" | "system_seed";

export interface UserSkillDefinition {
	id: string;
	ownership: SkillOwnership;
	displayName: string;
	description: string;
	instructions: string;
	activationExamples: string[];
	enabled: boolean;
	durationPolicy: SkillDurationPolicy;
	questionPolicy: SkillQuestionPolicy;
	notesPolicy: SkillNotesPolicy;
	sourceScope: SkillSourceScope;
	creationSource: SkillCreationSource;
	version: number;
	createdAt: number;
	updatedAt: number;
}

export interface SystemSkillLocalizedDefaults {
	en: {
		displayName: string;
		description: string;
		instructions: string;
	};
	hu: {
		displayName: string;
		description: string;
		instructions: string;
	};
}

export interface SystemSkillSummaryLocalizedDefaults {
	en: {
		displayName: string;
		description: string;
	};
	hu: {
		displayName: string;
		description: string;
	};
}

export interface SystemSkillDefinition {
	id: string;
	ownership: "system";
	displayName: string;
	description: string;
	instructions: string;
	activationExamples: string[];
	enabled: boolean;
	published: boolean;
	durationPolicy: SkillDurationPolicy;
	questionPolicy: SkillQuestionPolicy;
	notesPolicy: SkillNotesPolicy;
	sourceScope: SkillSourceScope;
	creationSource: SkillCreationSource;
	version: number;
	createdAt: number;
	updatedAt: number;
	localizedDefaults: SystemSkillLocalizedDefaults;
}

export type SystemSkillSummary = Omit<
	SystemSkillDefinition,
	"instructions" | "localizedDefaults"
> & {
	localizedDefaults: SystemSkillSummaryLocalizedDefaults;
};

export type SkillDiscoverySummary =
	| Omit<UserSkillDefinition, "instructions">
	| SystemSkillSummary;

export interface CreateUserSkillDefinitionInput {
	displayName: string;
	description?: string;
	instructions: string;
	activationExamples?: string[];
	enabled?: boolean;
	durationPolicy?: SkillDurationPolicy;
	questionPolicy?: SkillQuestionPolicy;
	notesPolicy?: SkillNotesPolicy;
	sourceScope?: SkillSourceScope;
	creationSource?: SkillCreationSource;
}

export type UpdateUserSkillDefinitionInput = Partial<CreateUserSkillDefinitionInput>;

export interface CreateSystemSkillDefinitionInput extends CreateUserSkillDefinitionInput {
	published?: boolean;
}

export type UpdateSystemSkillDefinitionInput = Partial<CreateSystemSkillDefinitionInput>;

export class UserSkillValidationError extends Error {
	status = 400;
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "UserSkillValidationError";
		this.code = code;
	}
}

const durationPolicies = new Set<SkillDurationPolicy>(["next_message", "session"]);
const questionPolicies = new Set<SkillQuestionPolicy>(["none", "ask_when_needed"]);
const notesPolicies = new Set<SkillNotesPolicy>(["none", "create_private_notes"]);
const sourceScopes = new Set<SkillSourceScope>(["current_conversation", "selected_sources_only"]);
const creationSources = new Set<SkillCreationSource>(["user_created", "ai_draft", "system_seed"]);

const builtInSystemSkills = [
	{
		id: "system:grill-with-docs",
		en: {
			displayName: "Plan Critic",
			description: "Stress-tests a plan against attached or selected project documents.",
			instructions:
				"Stress-test the user's plan against available documents. Identify contradictions, weak assumptions, missing decisions, and terminology drift. Prefer document-grounded questions and concrete revisions.",
		},
		hu: {
			displayName: "Tervkritikus",
			description: "A tervet csatolt vagy kijelölt projektdokumentumok alapján teszteli.",
			instructions:
				"Tedd próbára a felhasználó tervét az elérhető dokumentumok alapján. Mutasd ki az ellentmondásokat, gyenge feltételezéseket, hiányzó döntéseket és terminológiai eltéréseket.",
		},
		activationExamples: ["criticize this plan", "challenge this against our ADRs"],
	},
	{
		id: "system:document-explainer",
		en: {
			displayName: "Document Explainer",
			description: "Explains selected documents in plain language with source-grounded structure.",
			instructions:
				"Explain the selected or attached document clearly. Start with the main point, define important terms, call out assumptions or caveats, and ground claims in the document instead of guessing beyond it.",
		},
		hu: {
			displayName: "Dokumentummagyarázó",
			description: "Kijelölt dokumentumokat magyaráz el érthetően, forráshoz kötötten.",
			instructions:
				"Magyarázd el világosan a kijelölt vagy csatolt dokumentumot. Kezdd a fő üzenettel, definiáld a fontos fogalmakat, jelezd a feltételezéseket vagy fenntartásokat, és a dokumentumra támaszkodj.",
		},
		activationExamples: ["explain this document", "summarize this source"],
	},
	{
		id: "system:study-coach",
		en: {
			displayName: "Study Coach",
			description: "Helps learn material through guided questions, checks, and study plans.",
			instructions:
				"Help the user study actively. Break material into learnable chunks, ask brief check-for-understanding questions when useful, correct misunderstandings, and suggest practical next study steps.",
		},
		hu: {
			displayName: "Tanulási coach",
			description: "Irányított kérdésekkel, ellenőrzésekkel és tanulási tervvel segít tanulni.",
			instructions:
				"Segíts aktív tanulással. Bontsd az anyagot tanulható részekre, szükség esetén tegyél fel rövid ellenőrző kérdéseket, javítsd a félreértéseket, és adj gyakorlati következő lépéseket.",
		},
		activationExamples: ["help me study this", "quiz me on this topic"],
	},
	{
		id: "system:purchase-helper",
		en: {
			displayName: "Purchase Helper",
			description: "Compares buying options against needs, constraints, tradeoffs, and current facts.",
			instructions:
				"Help the user make a purchase decision. Clarify needs and constraints when needed, compare options by practical tradeoffs, flag uncertainty or freshness-sensitive facts, and avoid overconfident recommendations.",
		},
		hu: {
			displayName: "Vásárlási segítő",
			description:
				"Vásárlási lehetőségeket hasonlít össze igények, korlátok, kompromisszumok és aktuális tények alapján.",
			instructions:
				"Segíts a felhasználónak vásárlási döntést hozni. Szükség esetén tisztázd az igényeket és korlátokat, hasonlítsd össze a gyakorlati kompromisszumokat, jelezd a bizonytalanságot vagy frissességfüggő tényeket, és kerüld a túlzott magabiztosságot.",
		},
		activationExamples: ["help me choose what to buy", "compare these options"],
	},
	{
		id: "system:translate-rewrite",
		en: {
			displayName: "Translate & Rewrite",
			description: "Translates, rewrites, and adapts text while preserving intent and audience fit.",
			instructions:
				"Translate or rewrite the user's text while preserving meaning, intent, and audience fit. Keep terminology consistent, explain material changes when helpful, and ask before changing ambiguous meaning.",
		},
		hu: {
			displayName: "Fordítás és átírás",
			description:
				"Szöveget fordít, átír és célközönséghez igazít a szándék megőrzésével.",
			instructions:
				"Fordítsd vagy írd át a felhasználó szövegét úgy, hogy megmaradjon a jelentés, szándék és célközönséghez illeszkedés. Tartsd következetesen a terminológiát, szükség esetén magyarázd a lényegi módosításokat, és kérdezz, ha a jelentés kétértelmű.",
		},
		activationExamples: ["translate this", "rewrite this more clearly"],
	},
	{
		id: "system:appointment-prep",
		en: {
			displayName: "Appointment Prep",
			description: "Prepares agendas, questions, context, and follow-up plans for appointments.",
			instructions:
				"Help the user prepare for an appointment or meeting. Organize the goal, relevant context, questions to ask, materials to bring, risks to mention, and concrete follow-up items.",
		},
		hu: {
			displayName: "Időpontfelkészítő",
			description:
				"Napirendet, kérdéseket, kontextust és utánkövetési tervet készít időpontokra.",
			instructions:
				"Segíts a felhasználónak felkészülni egy időpontra vagy megbeszélésre. Rendezd a célt, releváns kontextust, felteendő kérdéseket, szükséges anyagokat, említendő kockázatokat és konkrét utánkövetési teendőket.",
		},
		activationExamples: ["prepare me for this appointment", "help me plan this meeting"],
	},
] as const;

const retiredBuiltInSystemSkillIds = [
	"system:interview",
	"system:code-review",
	"system:writing-coach",
] as const;

const previousBuiltInSystemSkillDefaults = {
	"system:grill-with-docs": {
		displayName: "Grill With Docs",
		description: "Challenges a plan against attached or selected project documents.",
		instructions:
			"Stress-test the user's plan against available documents. Identify contradictions, weak assumptions, missing decisions, and terminology drift. Prefer document-grounded questions and concrete revisions.",
		activationExamples: ["grill this plan with the docs", "challenge this against our ADRs"],
	},
} as const;

function parseExamples(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

function toUnixSeconds(value: Date): number {
	return Math.floor(value.getTime() / 1000);
}

function toUserSkillDefinition(
	row: typeof userSkillDefinitions.$inferSelect,
): UserSkillDefinition {
	return {
		id: row.id,
		ownership: "user",
		displayName: row.displayName,
		description: row.description,
		instructions: row.instructions,
		activationExamples: parseExamples(row.activationExamplesJson),
		enabled: Boolean(row.enabled),
		durationPolicy: row.durationPolicy as SkillDurationPolicy,
		questionPolicy: row.questionPolicy as SkillQuestionPolicy,
		notesPolicy: row.notesPolicy as SkillNotesPolicy,
		sourceScope: row.sourceScope as SkillSourceScope,
		creationSource: row.creationSource as SkillCreationSource,
		version: row.version,
		createdAt: toUnixSeconds(row.createdAt),
		updatedAt: toUnixSeconds(row.updatedAt),
	};
}

function localizedDefaultsForSystemSkill(row: typeof userSkillDefinitions.$inferSelect) {
	const builtIn = builtInSystemSkills.find((skill) => skill.id === row.id);
	return {
		en: {
			displayName: builtIn?.en.displayName ?? row.displayName,
			description: builtIn?.en.description ?? row.description,
			instructions: builtIn?.en.instructions ?? row.instructions,
		},
		hu: {
			displayName: builtIn?.hu.displayName ?? row.displayName,
			description: builtIn?.hu.description ?? row.description,
			instructions: builtIn?.hu.instructions ?? row.instructions,
		},
	};
}

function toSystemSkillDefinition(
	row: typeof userSkillDefinitions.$inferSelect,
): SystemSkillDefinition {
	return {
		id: row.id,
		ownership: "system",
		displayName: row.displayName,
		description: row.description,
		instructions: row.instructions,
		activationExamples: parseExamples(row.activationExamplesJson),
		enabled: Boolean(row.enabled),
		published: Boolean(row.published),
		durationPolicy: row.durationPolicy as SkillDurationPolicy,
		questionPolicy: row.questionPolicy as SkillQuestionPolicy,
		notesPolicy: row.notesPolicy as SkillNotesPolicy,
		sourceScope: row.sourceScope as SkillSourceScope,
		creationSource: row.creationSource as SkillCreationSource,
		version: row.version,
		createdAt: toUnixSeconds(row.createdAt),
		updatedAt: toUnixSeconds(row.updatedAt),
		localizedDefaults: localizedDefaultsForSystemSkill(row),
	};
}

function toSystemSkillSummary(row: typeof userSkillDefinitions.$inferSelect): SystemSkillSummary {
	const { instructions: _instructions, localizedDefaults, ...summary } = toSystemSkillDefinition(row);
	return {
		...summary,
		localizedDefaults: {
			en: {
				displayName: localizedDefaults.en.displayName,
				description: localizedDefaults.en.description,
			},
			hu: {
				displayName: localizedDefaults.hu.displayName,
				description: localizedDefaults.hu.description,
			},
		},
	};
}

function toUserSkillSummary(row: typeof userSkillDefinitions.$inferSelect): Omit<UserSkillDefinition, "instructions"> {
	const { instructions: _instructions, ...summary } = toUserSkillDefinition(row);
	return summary;
}

function builtInSystemSkillOrder(id: string): number {
	const index = builtInSystemSkills.findIndex((skill) => skill.id === id);
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function normalizeDiscoveryText(value: string): string {
	return value.trim().toLowerCase();
}

function discoveryMatchRank(skill: SkillDiscoverySummary, query: string): number {
	if (!query) return 0;
	const displayName = normalizeDiscoveryText(skill.displayName);
	if (displayName.includes(query)) return 0;
	if (skill.activationExamples.some((example) => normalizeDiscoveryText(example).includes(query))) {
		return 1;
	}
	if (normalizeDiscoveryText(skill.description).includes(query)) return 2;
	return Number.MAX_SAFE_INTEGER;
}

function compareDiscoverySummaries(
	query: string,
	left: SkillDiscoverySummary,
	right: SkillDiscoverySummary,
): number {
	const leftRank = discoveryMatchRank(left, query);
	const rightRank = discoveryMatchRank(right, query);
	if (leftRank !== rightRank) return leftRank - rightRank;
	if (left.ownership !== right.ownership) return left.ownership === "user" ? -1 : 1;
	if (!query && left.ownership === "system" && right.ownership === "system") {
		const orderDelta = builtInSystemSkillOrder(left.id) - builtInSystemSkillOrder(right.id);
		if (orderDelta !== 0) return orderDelta;
	}
	if (left.ownership === "user" && right.ownership === "user") {
		const updatedDelta = right.updatedAt - left.updatedAt;
		if (updatedDelta !== 0) return updatedDelta;
	}
	return left.displayName.localeCompare(right.displayName, "en", { sensitivity: "base" });
}

function cleanOptionalText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function cleanRequiredText(value: unknown, code: string, message: string, maxLength: number): string {
	const text = cleanOptionalText(value, maxLength);
	if (!text) {
		throw new UserSkillValidationError(code, message);
	}
	return text;
}

function cleanExamples(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === "string" ? item.trim() : ""))
		.filter(Boolean)
		.slice(0, 12)
		.map((item) => item.slice(0, 160));
}

function cleanEnum<T extends string>(
	value: unknown,
	allowed: Set<T>,
	fallback: T,
	code: string,
): T {
	if (typeof value === "string" && allowed.has(value as T)) {
		return value as T;
	}
	if (value === undefined || value === null) {
		return fallback;
	}
	throw new UserSkillValidationError(code, "Invalid skill policy.");
}

function shouldRefreshSeededDefault(
	existingValue: string,
	currentDefault: string,
	previousDefault?: string,
): boolean {
	if (existingValue === currentDefault) return false;
	return previousDefault !== undefined && existingValue === previousDefault;
}

async function resolveSystemSkillSeedOwnerId(createdByUserId: string): Promise<string> {
	const existingSystemOwner = await db
		.select({ userId: userSkillDefinitions.userId })
		.from(userSkillDefinitions)
		.where(eq(userSkillDefinitions.ownership, "system"))
		.orderBy(asc(userSkillDefinitions.createdAt))
		.limit(1)
		.get();
	if (existingSystemOwner) return existingSystemOwner.userId;

	const adminOwner = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.role, "admin"))
		.orderBy(asc(users.createdAt))
		.limit(1)
		.get();
	return adminOwner?.id ?? createdByUserId;
}

function buildCreateValues(userId: string, input: CreateUserSkillDefinitionInput) {
	return {
		id: randomUUID(),
		userId,
		ownership: "user",
		displayName: cleanRequiredText(
			input.displayName,
			"skill.displayNameRequired",
			"Display name is required.",
			120,
		),
		description: cleanOptionalText(input.description, 600),
		instructions: cleanRequiredText(
			input.instructions,
			"skill.instructionsRequired",
			"Instructions are required.",
			8000,
		),
		activationExamplesJson: JSON.stringify(cleanExamples(input.activationExamples)),
		enabled: input.enabled ?? true,
		durationPolicy: cleanEnum(
			input.durationPolicy,
			durationPolicies,
			"next_message",
			"skill.invalidDurationPolicy",
		),
		questionPolicy: cleanEnum(
			input.questionPolicy,
			questionPolicies,
			"none",
			"skill.invalidQuestionPolicy",
		),
		notesPolicy: cleanEnum(input.notesPolicy, notesPolicies, "none", "skill.invalidNotesPolicy"),
		sourceScope: cleanEnum(
			input.sourceScope,
			sourceScopes,
			"current_conversation",
			"skill.invalidSourceScope",
		),
		creationSource: cleanEnum(
			input.creationSource,
			creationSources,
			"user_created",
			"skill.invalidCreationSource",
		),
	};
}

function buildSystemCreateValues(userId: string, input: CreateSystemSkillDefinitionInput) {
	return {
		...buildCreateValues(userId, {
			...input,
			creationSource: input.creationSource ?? "user_created",
		}),
		ownership: "system",
		published: input.published ?? false,
	};
}

function buildUpdateValues(input: UpdateUserSkillDefinitionInput) {
	const values: Partial<typeof userSkillDefinitions.$inferInsert> = {
		updatedAt: new Date(),
	};

	if ("displayName" in input) {
		values.displayName = cleanRequiredText(
			input.displayName,
			"skill.displayNameRequired",
			"Display name is required.",
			120,
		);
	}
	if ("description" in input) values.description = cleanOptionalText(input.description, 600);
	if ("instructions" in input) {
		values.instructions = cleanRequiredText(
			input.instructions,
			"skill.instructionsRequired",
			"Instructions are required.",
			8000,
		);
	}
	if ("activationExamples" in input) {
		values.activationExamplesJson = JSON.stringify(cleanExamples(input.activationExamples));
	}
	if ("enabled" in input && typeof input.enabled === "boolean") values.enabled = input.enabled;
	if ("durationPolicy" in input) {
		values.durationPolicy = cleanEnum(
			input.durationPolicy,
			durationPolicies,
			"next_message",
			"skill.invalidDurationPolicy",
		);
	}
	if ("questionPolicy" in input) {
		values.questionPolicy = cleanEnum(
			input.questionPolicy,
			questionPolicies,
			"none",
			"skill.invalidQuestionPolicy",
		);
	}
	if ("notesPolicy" in input) {
		values.notesPolicy = cleanEnum(
			input.notesPolicy,
			notesPolicies,
			"none",
			"skill.invalidNotesPolicy",
		);
	}
	if ("sourceScope" in input) {
		values.sourceScope = cleanEnum(
			input.sourceScope,
			sourceScopes,
			"current_conversation",
			"skill.invalidSourceScope",
		);
	}
	if ("creationSource" in input) {
		values.creationSource = cleanEnum(
			input.creationSource,
			creationSources,
			"user_created",
			"skill.invalidCreationSource",
		);
	}

	return values;
}

function buildSystemUpdateValues(input: UpdateSystemSkillDefinitionInput) {
	const values = buildUpdateValues(input);
	if ("published" in input && typeof input.published === "boolean") {
		values.published = input.published;
	}
	return values;
}

export async function listUserSkillDefinitions(userId: string): Promise<UserSkillDefinition[]> {
	const rows = await db
		.select()
		.from(userSkillDefinitions)
		.where(and(eq(userSkillDefinitions.userId, userId), eq(userSkillDefinitions.ownership, "user")))
		.orderBy(desc(userSkillDefinitions.updatedAt));

	return rows.map(toUserSkillDefinition);
}

export async function getUserSkillDefinition(
	userId: string,
	skillId: string,
): Promise<UserSkillDefinition | null> {
	const row = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.id, skillId),
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
			),
		)
		.get();

	return row ? toUserSkillDefinition(row) : null;
}

export async function createUserSkillDefinition(
	userId: string,
	input: CreateUserSkillDefinitionInput,
): Promise<UserSkillDefinition> {
	const [row] = await db
		.insert(userSkillDefinitions)
		.values(buildCreateValues(userId, input))
		.returning();

	return toUserSkillDefinition(row);
}

export async function updateUserSkillDefinition(
	userId: string,
	skillId: string,
	input: UpdateUserSkillDefinitionInput,
): Promise<UserSkillDefinition | null> {
	const values = buildUpdateValues(input);
	const [row] = await db
		.update(userSkillDefinitions)
		.set({
			...values,
			version: sql`${userSkillDefinitions.version} + 1`,
		})
		.where(
			and(
				eq(userSkillDefinitions.id, skillId),
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
			),
		)
		.returning();

	return row ? toUserSkillDefinition(row) : null;
}

export async function deleteUserSkillDefinition(userId: string, skillId: string): Promise<boolean> {
	// Private User Skills are hard-deleted in v1; no discovery surface should see deleted rows.
	const result = await db
		.delete(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.id, skillId),
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
			),
		)
		.run();

	return result.changes > 0;
}

export async function seedBuiltInSystemSkillDefinitions(createdByUserId: string): Promise<void> {
	const seedOwnerId = await resolveSystemSkillSeedOwnerId(createdByUserId);

	for (const skillId of retiredBuiltInSystemSkillIds) {
		const existing = await db
			.select({
				enabled: userSkillDefinitions.enabled,
				published: userSkillDefinitions.published,
			})
			.from(userSkillDefinitions)
			.where(and(eq(userSkillDefinitions.id, skillId), eq(userSkillDefinitions.ownership, "system")))
			.get();
		if (!existing || (!existing.enabled && !existing.published)) continue;

		await db
			.update(userSkillDefinitions)
			.set({
				enabled: false,
				published: false,
				updatedAt: new Date(),
				version: sql`${userSkillDefinitions.version} + 1`,
			})
			.where(and(eq(userSkillDefinitions.id, skillId), eq(userSkillDefinitions.ownership, "system")))
			.run();
	}

	for (const builtIn of builtInSystemSkills) {
		const existing = await db
			.select()
			.from(userSkillDefinitions)
			.where(and(eq(userSkillDefinitions.id, builtIn.id), eq(userSkillDefinitions.ownership, "system")))
			.get();
		if (existing) {
			const previousDefaults =
				previousBuiltInSystemSkillDefaults[
					builtIn.id as keyof typeof previousBuiltInSystemSkillDefaults
				];
			const nextValues: Partial<typeof userSkillDefinitions.$inferInsert> = {
				updatedAt: new Date(),
			};

			if (
				shouldRefreshSeededDefault(
					existing.displayName,
					builtIn.en.displayName,
					previousDefaults?.displayName,
				)
			) {
				nextValues.displayName = builtIn.en.displayName;
			}
			if (
				shouldRefreshSeededDefault(
					existing.description,
					builtIn.en.description,
					previousDefaults?.description,
				)
			) {
				nextValues.description = builtIn.en.description;
			}
			if (
				shouldRefreshSeededDefault(
					existing.instructions,
					builtIn.en.instructions,
					previousDefaults?.instructions,
				)
			) {
				nextValues.instructions = builtIn.en.instructions;
			}
			const builtInActivationExamplesJson = JSON.stringify(builtIn.activationExamples);
			if (
				shouldRefreshSeededDefault(
					existing.activationExamplesJson,
					builtInActivationExamplesJson,
					previousDefaults ? JSON.stringify(previousDefaults.activationExamples) : undefined,
				)
			) {
				nextValues.activationExamplesJson = builtInActivationExamplesJson;
			}

			if (Object.keys(nextValues).length > 1) {
				await db
					.update(userSkillDefinitions)
					.set({
						...nextValues,
						version: sql`${userSkillDefinitions.version} + 1`,
					})
					.where(
						and(eq(userSkillDefinitions.id, builtIn.id), eq(userSkillDefinitions.ownership, "system")),
					)
					.run();
			}
			continue;
		}

		await db
			.insert(userSkillDefinitions)
			.values({
				id: builtIn.id,
				userId: seedOwnerId,
				ownership: "system",
				displayName: builtIn.en.displayName,
				description: builtIn.en.description,
				instructions: builtIn.en.instructions,
				activationExamplesJson: JSON.stringify(builtIn.activationExamples),
				enabled: true,
				published: true,
				durationPolicy: "next_message",
				questionPolicy: "ask_when_needed",
				notesPolicy: "none",
				sourceScope: "selected_sources_only",
				creationSource: "system_seed",
			})
			.run();
	}
}

export async function listAdminSystemSkillDefinitions(): Promise<SystemSkillDefinition[]> {
	const rows = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.ownership, "system"),
				notInArray(userSkillDefinitions.id, [...retiredBuiltInSystemSkillIds]),
			),
		)
		.orderBy(asc(userSkillDefinitions.displayName));

	return rows.map(toSystemSkillDefinition);
}

export async function listEnabledSystemSkillSummaries(): Promise<SystemSkillSummary[]> {
	const rows = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.ownership, "system"),
				eq(userSkillDefinitions.enabled, true),
				eq(userSkillDefinitions.published, true),
			),
		)
		.orderBy(asc(userSkillDefinitions.displayName));

	return rows.map(toSystemSkillSummary);
}

export async function discoverSkillSummaries(
	userId: string,
	query = "",
): Promise<SkillDiscoverySummary[]> {
	const normalizedQuery = normalizeDiscoveryText(query);
	const [userRows, systemRows] = await Promise.all([
		db
			.select()
			.from(userSkillDefinitions)
			.where(
				and(
					eq(userSkillDefinitions.userId, userId),
					eq(userSkillDefinitions.ownership, "user"),
					eq(userSkillDefinitions.enabled, true),
				),
			)
			.orderBy(desc(userSkillDefinitions.updatedAt)),
		db
			.select()
			.from(userSkillDefinitions)
			.where(
				and(
					eq(userSkillDefinitions.ownership, "system"),
					eq(userSkillDefinitions.enabled, true),
					eq(userSkillDefinitions.published, true),
				),
			)
			.orderBy(asc(userSkillDefinitions.displayName)),
	]);

	return [...userRows.map(toUserSkillSummary), ...systemRows.map(toSystemSkillSummary)]
		.filter((skill) => discoveryMatchRank(skill, normalizedQuery) < Number.MAX_SAFE_INTEGER)
		.sort((left, right) => compareDiscoverySummaries(normalizedQuery, left, right));
}

export async function getAvailableSkillSummary(
	userId: string,
	selection: { id: string; ownership: SkillOwnership },
): Promise<SkillDiscoverySummary | null> {
	const row = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			selection.ownership === "user"
				? and(
						eq(userSkillDefinitions.id, selection.id),
						eq(userSkillDefinitions.userId, userId),
						eq(userSkillDefinitions.ownership, "user"),
						eq(userSkillDefinitions.enabled, true),
					)
				: and(
						eq(userSkillDefinitions.id, selection.id),
						eq(userSkillDefinitions.ownership, "system"),
						eq(userSkillDefinitions.enabled, true),
						eq(userSkillDefinitions.published, true),
					),
		)
		.get();

	if (!row) return null;
	return row.ownership === "system" ? toSystemSkillSummary(row) : toUserSkillSummary(row);
}

export async function getAvailableSkillDefinition(
	userId: string,
	selection: { id: string; ownership: SkillOwnership },
): Promise<UserSkillDefinition | SystemSkillDefinition | null> {
	const row = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			selection.ownership === "user"
				? and(
						eq(userSkillDefinitions.id, selection.id),
						eq(userSkillDefinitions.userId, userId),
						eq(userSkillDefinitions.ownership, "user"),
						eq(userSkillDefinitions.enabled, true),
					)
				: and(
						eq(userSkillDefinitions.id, selection.id),
						eq(userSkillDefinitions.ownership, "system"),
						eq(userSkillDefinitions.enabled, true),
						eq(userSkillDefinitions.published, true),
					),
		)
		.get();

	if (!row) return null;
	return row.ownership === "system" ? toSystemSkillDefinition(row) : toUserSkillDefinition(row);
}

export async function getSystemSkillDefinition(
	skillId: string,
): Promise<SystemSkillDefinition | null> {
	const row = await db
		.select()
		.from(userSkillDefinitions)
		.where(and(eq(userSkillDefinitions.id, skillId), eq(userSkillDefinitions.ownership, "system")))
		.get();

	return row ? toSystemSkillDefinition(row) : null;
}

export async function createSystemSkillDefinition(
	createdByUserId: string,
	input: CreateSystemSkillDefinitionInput,
): Promise<SystemSkillDefinition> {
	const [row] = await db
		.insert(userSkillDefinitions)
		.values(buildSystemCreateValues(createdByUserId, input))
		.returning();

	return toSystemSkillDefinition(row);
}

export async function updateSystemSkillDefinition(
	skillId: string,
	input: UpdateSystemSkillDefinitionInput,
): Promise<SystemSkillDefinition | null> {
	const values = buildSystemUpdateValues(input);
	const [row] = await db
		.update(userSkillDefinitions)
		.set({
			...values,
			version: sql`${userSkillDefinitions.version} + 1`,
		})
		.where(and(eq(userSkillDefinitions.id, skillId), eq(userSkillDefinitions.ownership, "system")))
		.returning();

	return row ? toSystemSkillDefinition(row) : null;
}
