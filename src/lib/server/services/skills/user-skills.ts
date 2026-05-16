import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
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

export type UpdateUserSkillDefinitionInput =
	Partial<CreateUserSkillDefinitionInput>;

export interface CreateSystemSkillDefinitionInput
	extends CreateUserSkillDefinitionInput {
	published?: boolean;
}

export type UpdateSystemSkillDefinitionInput =
	Partial<CreateSystemSkillDefinitionInput>;

export class UserSkillValidationError extends Error {
	status = 400;
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "UserSkillValidationError";
		this.code = code;
	}
}

const durationPolicies = new Set<SkillDurationPolicy>([
	"next_message",
	"session",
]);
const questionPolicies = new Set<SkillQuestionPolicy>([
	"none",
	"ask_when_needed",
]);
const notesPolicies = new Set<SkillNotesPolicy>([
	"none",
	"create_private_notes",
]);
const sourceScopes = new Set<SkillSourceScope>([
	"current_conversation",
	"selected_sources_only",
]);
const creationSources = new Set<SkillCreationSource>([
	"user_created",
	"ai_draft",
	"system_seed",
]);

const builtInSystemSkills = [
	{
		id: "system:grill-with-docs",
		en: {
			displayName: "Plan Critic",
			description:
				"Stress-tests plans against selected sources, product language, constraints, and implementation reality.",
			instructions: [
				"Run a focused plan-critique workflow. Your job is to improve correctness before execution, not to rubber-stamp the plan.",
				"Use the current user message, conversation context, and selected linked sources. Do not claim to have read documents or code that were not provided in context.",
				"When source material is available, separate source-backed findings from reasoned concerns. Quote or reference source facts only when they are actually present.",
				"Check for contradictions, weak assumptions, missing decisions, overloaded terminology, unverified dependencies, scope creep, and cases where the plan conflicts with product language or prior decisions.",
				"If a question is needed, ask one focused question and include your recommended answer. If the answer can be discovered from available context, discover it instead of asking.",
				"Prefer concrete revisions: changed wording, added acceptance criteria, removed scope, renamed terms, or an explicit decision that should be recorded.",
				"Output with the highest-impact issues first. Keep summaries brief and make the next action obvious.",
			].join("\n"),
		},
		hu: {
			displayName: "Tervkritikus",
			description:
				"Terveket tesztel kijelölt források, terméknyelv, korlátok és megvalósítási realitás alapján.",
			instructions: [
				"Végezz fókuszált tervkritikai munkafolyamatot. A cél a terv helyességének javítása végrehajtás előtt, nem a terv automatikus jóváhagyása.",
				"A jelenlegi felhasználói üzenetre, beszélgetési kontextusra és kijelölt forrásokra támaszkodj. Ne állítsd, hogy olyan dokumentumot vagy kódot olvastál, amely nincs a kontextusban.",
				"Ha van forrásanyag, különítsd el a forrással alátámasztott megállapításokat a következtetésen alapuló aggályoktól.",
				"Keresd az ellentmondásokat, gyenge feltételezéseket, hiányzó döntéseket, túlterhelt fogalmakat, ellenőrizetlen függőségeket, scope creep-et és a korábbi döntésekkel ütköző részeket.",
				"Ha kérdés szükséges, egyetlen fókuszált kérdést tegyél fel, és add meg az általad ajánlott választ is. Ha a válasz kideríthető az elérhető kontextusból, inkább derítsd ki.",
				"Konkrét javításokat javasolj: szövegmódosítást, elfogadási kritériumot, scope-csökkentést, terminológiai pontosítást vagy rögzítendő döntést.",
				"A legnagyobb hatású problémákkal kezdj. A következő lépés legyen egyértelmű.",
			].join("\n"),
		},
		activationExamples: [
			"criticize this plan",
			"challenge this against our ADRs",
			"stress-test this implementation plan",
			"find the weak assumptions",
		],
	},
	{
		id: "system:document-explainer",
		en: {
			displayName: "Document Explainer",
			description:
				"Explains selected documents in plain language while preserving source facts, caveats, and structure.",
			instructions: [
				"Explain the selected or attached document so the user can act on it.",
				"Start with the main point in plain language, then unpack the important terms, obligations, decisions, numbers, and caveats.",
				"Ground claims in the provided document. If the user asks for something the document does not answer, say that clearly and separate inference from source fact.",
				"Preserve important concrete details such as dates, thresholds, names, requirements, and exceptions. Do not flatten them into vague summaries.",
				"Adapt depth to the user's apparent familiarity. For beginners, define terms before using them; for advanced users, focus on implications and edge cases.",
				"When useful, end with a short list of decisions, risks, or follow-up questions the document implies.",
			].join("\n"),
		},
		hu: {
			displayName: "Dokumentummagyarázó",
			description:
				"Kijelölt dokumentumokat magyaráz el érthetően, a forrástényeket, fenntartásokat és szerkezetet megőrizve.",
			instructions: [
				"Úgy magyarázd el a kijelölt vagy csatolt dokumentumot, hogy a felhasználó cselekedni tudjon belőle.",
				"Kezdd a fő üzenettel közérthetően, majd bontsd ki a fontos fogalmakat, kötelezettségeket, döntéseket, számokat és fenntartásokat.",
				"Állításaidat a megadott dokumentumra alapozd. Ha a dokumentum nem válaszolja meg a kérdést, mondd ki, és különítsd el a következtetést a forrásténytől.",
				"Őrizd meg a lényeges konkrétumokat, például dátumokat, küszöbértékeket, neveket, követelményeket és kivételeket.",
				"A részletességet igazítsd a felhasználó tudásszintjéhez. Kezdőnél definiáld a fogalmakat, haladónál fókuszálj a következményekre és szélső esetekre.",
				"Ha hasznos, zárj rövid döntés-, kockázat- vagy utánkövetési kérdéslistával.",
			].join("\n"),
		},
		activationExamples: [
			"explain this document",
			"summarize this source",
			"what does this file mean",
			"extract the important caveats",
		],
	},
	{
		id: "system:study-coach",
		en: {
			displayName: "Study Coach",
			description:
				"Turns material into active learning through chunking, recall checks, correction, and study plans.",
			instructions: [
				"Coach the user through active learning rather than only summarizing material.",
				"Break the topic into learnable chunks, identify prerequisites, and explain the first chunk before moving deeper.",
				"Use retrieval practice: ask one short check-for-understanding question when useful, then adapt based on the user's answer.",
				"Correct misunderstandings directly and kindly. Explain why the correction matters, not just what the right answer is.",
				"Use examples, contrasts, and small exercises. Prefer concrete practice over abstract encouragement.",
				"End with practical next study steps, spaced repetition prompts, or a small self-test when appropriate.",
			].join("\n"),
		},
		hu: {
			displayName: "Tanulási coach",
			description:
				"Az anyagot aktív tanulássá alakítja darabolással, visszakérdezéssel, javítással és tanulási tervvel.",
			instructions: [
				"A felhasználót aktív tanulásban segítsd, ne csak összefoglalót adj.",
				"Bontsd a témát tanulható részekre, azonosítsd az előfeltételeket, és az első részt magyarázd el, mielőtt mélyebbre mész.",
				"Használj előhívási gyakorlást: szükség esetén tegyél fel egy rövid ellenőrző kérdést, majd a válasz alapján igazítsd a folytatást.",
				"A félreértéseket közvetlenül és tárgyilagosan javítsd. Magyarázd el, miért számít a javítás.",
				"Használj példákat, összehasonlításokat és kis gyakorlatokat. A konkrét gyakorlást részesítsd előnyben az általános biztatással szemben.",
				"Ha helyénvaló, zárj gyakorlati következő lépésekkel, ismétlési kérdésekkel vagy rövid önellenőrzéssel.",
			].join("\n"),
		},
		activationExamples: [
			"help me study this",
			"quiz me on this topic",
			"teach me this step by step",
			"make a study plan",
		],
	},
	{
		id: "system:purchase-helper",
		en: {
			displayName: "Purchase Helper",
			description:
				"Compares buying options against user needs, constraints, tradeoffs, risks, and current evidence.",
			instructions: [
				"Help the user make a purchase decision that fits their actual constraints, not a generic best-product ranking.",
				"First identify the decision criteria: budget, location, timeline, must-haves, nice-to-haves, dealbreakers, ownership costs, compatibility, warranty, support, and risk tolerance.",
				"Compare options by practical tradeoffs. Include why an option may be wrong for this user even if it is objectively strong.",
				"Treat prices, availability, laws, insurance terms, and product specifications as freshness-sensitive. Use available current sources when possible; otherwise label uncertainty clearly.",
				"Preserve concrete user facts from the conversation, such as owned items, existing subscriptions, region, compatibility requirements, and prior preferences.",
				"End with a recommendation only when the evidence supports it. Otherwise provide a shortlist, decision matrix, or the one missing fact that would decide it.",
			].join("\n"),
		},
		hu: {
			displayName: "Vásárlási segítő",
			description:
				"Vásárlási lehetőségeket hasonlít össze igények, korlátok, kompromisszumok, kockázatok és aktuális bizonyítékok alapján.",
			instructions: [
				"Segíts olyan vásárlási döntést hozni, amely a felhasználó valós korlátaihoz illik, nem általános toplistát ad.",
				"Először azonosítsd a döntési szempontokat: költségkeret, hely, időzítés, kötelező elemek, jó-ha-van elemek, kizáró okok, fenntartási költség, kompatibilitás, garancia, támogatás és kockázattűrés.",
				"A lehetőségeket gyakorlati kompromisszumok alapján hasonlítsd össze. Írd le azt is, miért lehet egy opció rossz ennek a felhasználónak akkor is, ha általában erős.",
				"Az árakat, elérhetőséget, jogszabályokat, biztosítási feltételeket és termékspecifikációkat frissességfüggőnek kezeld. Ha lehet, aktuális forrást használj; ha nem, egyértelműen jelezd a bizonytalanságot.",
				"Őrizd meg a beszélgetés konkrét felhasználói tényeit, például tulajdonolt eszközöket, meglévő előfizetéseket, régiót, kompatibilitási igényeket és korábbi preferenciákat.",
				"Csak akkor adj végső ajánlást, ha a bizonyítékok ezt alátámasztják. Ellenkező esetben adj shortlistet, döntési mátrixot vagy azt az egy hiányzó tényt, amely eldöntené a kérdést.",
			].join("\n"),
		},
		activationExamples: [
			"help me choose what to buy",
			"compare these options",
			"which option fits my needs",
			"make a buying decision matrix",
		],
	},
	{
		id: "system:translate-rewrite",
		en: {
			displayName: "Translate & Rewrite",
			description:
				"Translates, rewrites, and adapts text while preserving meaning, voice, terminology, and audience fit.",
			instructions: [
				"Transform the user's text while preserving meaning, intent, facts, and audience fit.",
				"Before changing ambiguous meaning, ask a focused question or provide the safest version with a brief note about the ambiguity.",
				"Keep terminology, names, dates, numbers, and formatting-sensitive details consistent unless the user asks to change them.",
				"For translation, prefer natural target-language phrasing over word-for-word literalism, while preserving register and nuance.",
				"For rewriting, match the requested tone and medium. Remove clutter, improve structure, and keep the user's voice where possible.",
				"Usually provide the revised text first. Add a short explanation only when changes are material or the user asked for reasoning.",
			].join("\n"),
		},
		hu: {
			displayName: "Fordítás és átírás",
			description:
				"Szöveget fordít, átír és célközönséghez igazít a jelentés, hang, terminológia és szándék megőrzésével.",
			instructions: [
				"Alakítsd át a felhasználó szövegét úgy, hogy megmaradjon a jelentés, szándék, tényanyag és célközönséghez illeszkedés.",
				"Kétértelmű jelentés módosítása előtt tegyél fel fókuszált kérdést, vagy adj biztonságos változatot rövid megjegyzéssel a bizonytalanságról.",
				"A terminológiát, neveket, dátumokat, számokat és formázásérzékeny részleteket tartsd következetesen, hacsak a felhasználó nem kér mást.",
				"Fordításnál természetes célnyelvi megfogalmazást használj a szó szerinti fordítás helyett, de őrizd meg a regisztert és árnyalatot.",
				"Átírásnál igazodj a kért hangnemhez és médiumhoz. Csökkentsd a zajt, javítsd a szerkezetet, és ahol lehet, őrizd meg a felhasználó hangját.",
				"Általában a javított szöveget add először. Rövid magyarázatot csak lényegi változtatásnál vagy kérésre adj.",
			].join("\n"),
		},
		activationExamples: [
			"translate this",
			"rewrite this more clearly",
			"make this more professional",
			"adapt this for a different audience",
		],
	},
	{
		id: "system:appointment-prep",
		en: {
			displayName: "Appointment Prep",
			description:
				"Prepares agendas, context briefs, questions, materials, risks, and follow-up plans for appointments.",
			instructions: [
				"Prepare the user for an appointment, meeting, call, or administrative interaction.",
				"Identify the goal, counterpart, timing, constraints, prior context, required documents, decisions needed, and what a good outcome looks like.",
				"Organize the preparation into agenda, context to mention, questions to ask, materials to bring or send, risks or sensitive points, and follow-up actions.",
				"Preserve concrete facts from the conversation and selected sources. Do not invent appointment details, eligibility rules, deadlines, or legal/medical/financial advice.",
				"If the situation is high-stakes or current-rule-dependent, flag what should be verified with an official source or professional.",
				"Keep the output usable during the appointment: concise phrasing, prioritized questions, and a short checklist.",
			].join("\n"),
		},
		hu: {
			displayName: "Időpontfelkészítő",
			description:
				"Napirendet, kontextusbriefet, kérdéseket, anyagokat, kockázatokat és utánkövetési tervet készít időpontokra.",
			instructions: [
				"Készítsd fel a felhasználót időpontra, megbeszélésre, hívásra vagy ügyintézésre.",
				"Azonosítsd a célt, a másik felet, időzítést, korlátokat, előzményeket, szükséges dokumentumokat, döntési pontokat és azt, milyen a jó kimenet.",
				"A felkészülést rendezd napirendbe, említendő kontextusba, felteendő kérdésekbe, hozandó vagy küldendő anyagokba, kockázatokba vagy érzékeny pontokba, valamint utánkövetési teendőkbe.",
				"Őrizd meg a beszélgetés és kijelölt források konkrét tényeit. Ne találj ki időpontadatokat, jogosultsági szabályokat, határidőket vagy jogi/orvosi/pénzügyi tanácsot.",
				"Nagy tétű vagy aktuális szabályoktól függő helyzetben jelezd, mit kell hivatalos forrásból vagy szakemberrel ellenőrizni.",
				"A kimenet legyen használható az időpont alatt: tömör megfogalmazás, priorizált kérdések és rövid ellenőrzőlista.",
			].join("\n"),
		},
		activationExamples: [
			"prepare me for this appointment",
			"help me plan this meeting",
			"make questions for this call",
			"build an appointment checklist",
		],
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
		description:
			"Challenges a plan against attached or selected project documents.",
		instructions:
			"Stress-test the user's plan against available documents. Identify contradictions, weak assumptions, missing decisions, and terminology drift. Prefer document-grounded questions and concrete revisions.",
		activationExamples: [
			"grill this plan with the docs",
			"challenge this against our ADRs",
		],
	},
	"system:grill-with-docs:v2": {
		displayName: "Plan Critic",
		description:
			"Stress-tests a plan against attached or selected project documents.",
		instructions:
			"Stress-test the user's plan against available documents. Identify contradictions, weak assumptions, missing decisions, and terminology drift. Prefer document-grounded questions and concrete revisions.",
		activationExamples: [
			"criticize this plan",
			"challenge this against our ADRs",
		],
	},
	"system:document-explainer": {
		displayName: "Document Explainer",
		description:
			"Explains selected documents in plain language with source-grounded structure.",
		instructions:
			"Explain the selected or attached document clearly. Start with the main point, define important terms, call out assumptions or caveats, and ground claims in the document instead of guessing beyond it.",
		activationExamples: ["explain this document", "summarize this source"],
	},
	"system:study-coach": {
		displayName: "Study Coach",
		description:
			"Helps learn material through guided questions, checks, and study plans.",
		instructions:
			"Help the user study actively. Break material into learnable chunks, ask brief check-for-understanding questions when useful, correct misunderstandings, and suggest practical next study steps.",
		activationExamples: ["help me study this", "quiz me on this topic"],
	},
	"system:purchase-helper": {
		displayName: "Purchase Helper",
		description:
			"Compares buying options against needs, constraints, tradeoffs, and current facts.",
		instructions:
			"Help the user make a purchase decision. Clarify needs and constraints when needed, compare options by practical tradeoffs, flag uncertainty or freshness-sensitive facts, and avoid overconfident recommendations.",
		activationExamples: ["help me choose what to buy", "compare these options"],
	},
	"system:translate-rewrite": {
		displayName: "Translate & Rewrite",
		description:
			"Translates, rewrites, and adapts text while preserving intent and audience fit.",
		instructions:
			"Translate or rewrite the user's text while preserving meaning, intent, and audience fit. Keep terminology consistent, explain material changes when helpful, and ask before changing ambiguous meaning.",
		activationExamples: ["translate this", "rewrite this more clearly"],
	},
	"system:appointment-prep": {
		displayName: "Appointment Prep",
		description:
			"Prepares agendas, questions, context, and follow-up plans for appointments.",
		instructions:
			"Help the user prepare for an appointment or meeting. Organize the goal, relevant context, questions to ask, materials to bring, risks to mention, and concrete follow-up items.",
		activationExamples: [
			"prepare me for this appointment",
			"help me plan this meeting",
		],
	},
} as const;

function previousDefaultsForBuiltInSkill(id: string) {
	return Object.entries(previousBuiltInSystemSkillDefaults)
		.filter(([key]) => key === id || key.startsWith(`${id}:`))
		.map(([, value]) => value);
}

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

function localizedDefaultsForSystemSkill(
	row: typeof userSkillDefinitions.$inferSelect,
) {
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

function toSystemSkillSummary(
	row: typeof userSkillDefinitions.$inferSelect,
): SystemSkillSummary {
	const {
		instructions: _instructions,
		localizedDefaults,
		...summary
	} = toSystemSkillDefinition(row);
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

function toUserSkillSummary(
	row: typeof userSkillDefinitions.$inferSelect,
): Omit<UserSkillDefinition, "instructions"> {
	const { instructions: _instructions, ...summary } =
		toUserSkillDefinition(row);
	return summary;
}

function builtInSystemSkillOrder(id: string): number {
	const index = builtInSystemSkills.findIndex((skill) => skill.id === id);
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function normalizeDiscoveryText(value: string): string {
	return value.trim().toLowerCase();
}

function discoveryMatchRank(
	skill: SkillDiscoverySummary,
	query: string,
): number {
	if (!query) return 0;
	const displayNames = [skill.displayName];
	const descriptions = [skill.description];
	if (skill.ownership === "system") {
		displayNames.push(
			skill.localizedDefaults.en.displayName,
			skill.localizedDefaults.hu.displayName,
		);
		descriptions.push(
			skill.localizedDefaults.en.description,
			skill.localizedDefaults.hu.description,
		);
	}
	if (
		displayNames.some((displayName) =>
			normalizeDiscoveryText(displayName).includes(query),
		)
	) {
		return 0;
	}
	if (
		skill.activationExamples.some((example) =>
			normalizeDiscoveryText(example).includes(query),
		)
	) {
		return 1;
	}
	if (
		descriptions.some((description) =>
			normalizeDiscoveryText(description).includes(query),
		)
	) {
		return 2;
	}
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
	if (left.ownership !== right.ownership)
		return left.ownership === "user" ? -1 : 1;
	if (!query && left.ownership === "system" && right.ownership === "system") {
		const orderDelta =
			builtInSystemSkillOrder(left.id) - builtInSystemSkillOrder(right.id);
		if (orderDelta !== 0) return orderDelta;
	}
	if (left.ownership === "user" && right.ownership === "user") {
		const updatedDelta = right.updatedAt - left.updatedAt;
		if (updatedDelta !== 0) return updatedDelta;
	}
	return left.displayName.localeCompare(right.displayName, "en", {
		sensitivity: "base",
	});
}

export function localizeSystemSkillSummary(
	skill: SystemSkillSummary,
	language: "en" | "hu" | undefined,
): SystemSkillSummary {
	if (language !== "hu") return skill;
	const localized = skill.localizedDefaults[language];
	const english = skill.localizedDefaults.en;
	const displayName =
		skill.displayName === english.displayName ||
		skill.displayName === localized.displayName
			? localized.displayName
			: skill.displayName;
	const description =
		skill.description === english.description ||
		skill.description === localized.description
			? localized.description
			: skill.description;
	return {
		...skill,
		displayName,
		description,
	};
}

export function localizeSkillDiscoverySummary(
	skill: SkillDiscoverySummary,
	language: "en" | "hu" | undefined,
): SkillDiscoverySummary {
	return skill.ownership === "system"
		? localizeSystemSkillSummary(skill, language)
		: skill;
}

function cleanOptionalText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function cleanRequiredText(
	value: unknown,
	code: string,
	message: string,
	maxLength: number,
): string {
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
	previousDefault?: string | string[],
): boolean {
	if (existingValue === currentDefault) return false;
	if (previousDefault === undefined) return false;
	const previousDefaults = Array.isArray(previousDefault)
		? previousDefault
		: [previousDefault];
	return previousDefaults.includes(existingValue);
}

async function resolveSystemSkillSeedOwnerId(
	createdByUserId: string,
): Promise<string> {
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

function buildCreateValues(
	userId: string,
	input: CreateUserSkillDefinitionInput,
) {
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
		activationExamplesJson: JSON.stringify(
			cleanExamples(input.activationExamples),
		),
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
		notesPolicy: cleanEnum(
			input.notesPolicy,
			notesPolicies,
			"none",
			"skill.invalidNotesPolicy",
		),
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

function buildSystemCreateValues(
	userId: string,
	input: CreateSystemSkillDefinitionInput,
) {
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
	if ("description" in input)
		values.description = cleanOptionalText(input.description, 600);
	if ("instructions" in input) {
		values.instructions = cleanRequiredText(
			input.instructions,
			"skill.instructionsRequired",
			"Instructions are required.",
			8000,
		);
	}
	if ("activationExamples" in input) {
		values.activationExamplesJson = JSON.stringify(
			cleanExamples(input.activationExamples),
		);
	}
	if ("enabled" in input && typeof input.enabled === "boolean")
		values.enabled = input.enabled;
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

export async function listUserSkillDefinitions(
	userId: string,
): Promise<UserSkillDefinition[]> {
	const rows = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
			),
		)
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

export async function deleteUserSkillDefinition(
	userId: string,
	skillId: string,
): Promise<boolean> {
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

export async function seedBuiltInSystemSkillDefinitions(
	createdByUserId: string,
): Promise<void> {
	const seedOwnerId = await resolveSystemSkillSeedOwnerId(createdByUserId);

	for (const skillId of retiredBuiltInSystemSkillIds) {
		const existing = await db
			.select({
				enabled: userSkillDefinitions.enabled,
				published: userSkillDefinitions.published,
			})
			.from(userSkillDefinitions)
			.where(
				and(
					eq(userSkillDefinitions.id, skillId),
					eq(userSkillDefinitions.ownership, "system"),
				),
			)
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
			.where(
				and(
					eq(userSkillDefinitions.id, skillId),
					eq(userSkillDefinitions.ownership, "system"),
				),
			)
			.run();
	}

	for (const builtIn of builtInSystemSkills) {
		const existing = await db
			.select()
			.from(userSkillDefinitions)
			.where(
				and(
					eq(userSkillDefinitions.id, builtIn.id),
					eq(userSkillDefinitions.ownership, "system"),
				),
			)
			.get();
		if (existing) {
			const previousDefaults = previousDefaultsForBuiltInSkill(builtIn.id);
			const nextValues: Partial<typeof userSkillDefinitions.$inferInsert> = {
				updatedAt: new Date(),
			};

			if (
				shouldRefreshSeededDefault(
					existing.displayName,
					builtIn.en.displayName,
					previousDefaults.map((defaults) => defaults.displayName),
				)
			) {
				nextValues.displayName = builtIn.en.displayName;
			}
			if (
				shouldRefreshSeededDefault(
					existing.description,
					builtIn.en.description,
					previousDefaults.map((defaults) => defaults.description),
				)
			) {
				nextValues.description = builtIn.en.description;
			}
			if (
				shouldRefreshSeededDefault(
					existing.instructions,
					builtIn.en.instructions,
					previousDefaults.map((defaults) => defaults.instructions),
				)
			) {
				nextValues.instructions = builtIn.en.instructions;
			}
			const builtInActivationExamplesJson = JSON.stringify(
				builtIn.activationExamples,
			);
			if (
				shouldRefreshSeededDefault(
					existing.activationExamplesJson,
					builtInActivationExamplesJson,
					previousDefaults.map((defaults) =>
						JSON.stringify(defaults.activationExamples),
					),
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
						and(
							eq(userSkillDefinitions.id, builtIn.id),
							eq(userSkillDefinitions.ownership, "system"),
						),
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

export async function listAdminSystemSkillDefinitions(): Promise<
	SystemSkillDefinition[]
> {
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

export async function listEnabledSystemSkillSummaries(): Promise<
	SystemSkillSummary[]
> {
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

	return [
		...userRows.map(toUserSkillSummary),
		...systemRows.map(toSystemSkillSummary),
	]
		.filter(
			(skill) =>
				discoveryMatchRank(skill, normalizedQuery) < Number.MAX_SAFE_INTEGER,
		)
		.sort((left, right) =>
			compareDiscoverySummaries(normalizedQuery, left, right),
		);
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
	return row.ownership === "system"
		? toSystemSkillSummary(row)
		: toUserSkillSummary(row);
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
	return row.ownership === "system"
		? toSystemSkillDefinition(row)
		: toUserSkillDefinition(row);
}

export async function getSystemSkillDefinition(
	skillId: string,
): Promise<SystemSkillDefinition | null> {
	const row = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.id, skillId),
				eq(userSkillDefinitions.ownership, "system"),
			),
		)
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
		.where(
			and(
				eq(userSkillDefinitions.id, skillId),
				eq(userSkillDefinitions.ownership, "system"),
			),
		)
		.returning();

	return row ? toSystemSkillDefinition(row) : null;
}
