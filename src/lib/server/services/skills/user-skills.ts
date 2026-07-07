import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { userSkillDefinitions, users } from "$lib/server/db/schema";

export type SkillOwnership = "user" | "system";
export type SkillKind = "user_skill" | "skill_pack" | "skill_variant";
export type SkillDurationPolicy = "next_message" | "session";
export type SkillQuestionPolicy = "none" | "ask_when_needed";
export type SkillNotesPolicy = "none" | "create_private_notes";
export type SkillSourceScope = "current_conversation" | "selected_sources_only";
export type SkillCreationSource = "user_created" | "ai_draft" | "system_seed";

export interface UserSkillDefinition {
	id: string;
	ownership: SkillOwnership;
	skillKind: SkillKind;
	baseSkillId: string | null;
	baseSkillVersion: number | null;
	baseSkillDisplayName?: string | null;
	baseSkillLocalizedDefaults?: SystemSkillSummaryLocalizedDefaults | null;
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

export interface UserSkillVariantDefinition extends UserSkillDefinition {
	skillKind: "skill_variant";
	baseSkillId: string;
	baseSkillVersion: number | null;
	baseSkillDisplayName: string | null;
	baseSkillAvailable: boolean;
	baseSkillAvailabilityReason: SkillAvailabilityReason;
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

export interface ManagedSkillResourceMetadata {
	id: string;
	title: string;
	kind: "guidance" | "domain_template";
	summary: string;
	whenToUse: string;
}

export interface ManagedSkillPromptResource
	extends ManagedSkillResourceMetadata {
	content: string;
	keywords: string[];
}

export interface SystemSkillDefinition {
	id: string;
	ownership: "system";
	skillKind: "skill_pack";
	baseSkillId: null;
	baseSkillVersion: null;
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
	managedResources: ManagedSkillResourceMetadata[];
}

export type SystemSkillSummary = Omit<
	SystemSkillDefinition,
	"instructions" | "localizedDefaults" | "managedResources"
> & {
	localizedDefaults: SystemSkillSummaryLocalizedDefaults;
};

export type SkillDiscoverySummary =
	| Omit<UserSkillDefinition, "instructions">
	| SystemSkillSummary;

export type SkillAvailabilityReason =
	| "available"
	| "not_found"
	| "hidden"
	| "disabled"
	| "unpublished"
	| "base_pack_missing"
	| "base_pack_disabled"
	| "base_pack_unpublished";

export interface EffectiveSkillSourceIds {
	skillId: string;
	skillVersion: number;
	packSkillId: string | null;
	packSkillVersion: number | null;
	variantSkillId: string | null;
	variantSkillVersion: number | null;
}

export type EffectiveSkillDefinition =
	| {
			available: true;
			availabilityReason: "available";
			id: string;
			ownership: SkillOwnership;
			skillKind: SkillKind;
			displayName: string;
			description: string;
			effectiveInstructions: string;
			effectiveInstructionsHash: string;
			publicSummary: SkillDiscoverySummary;
			durationPolicy: SkillDurationPolicy;
			questionPolicy: SkillQuestionPolicy;
			notesPolicy: SkillNotesPolicy;
			sourceScope: SkillSourceScope;
			promptResources: ManagedSkillPromptResource[];
			sourceIds: EffectiveSkillSourceIds;
	  }
	| {
			available: false;
			availabilityReason: Exclude<SkillAvailabilityReason, "available">;
			id: string;
			ownership: SkillOwnership;
			skillKind: SkillKind | null;
			displayName: string | null;
			description: string | null;
			effectiveInstructions: "";
			effectiveInstructionsHash: null;
			publicSummary: SkillDiscoverySummary | null;
			sourceIds: EffectiveSkillSourceIds | null;
	  };

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

export interface CreateUserSkillVariantDefinitionInput {
	baseSkillId: string;
	displayName: string;
	description?: string;
	instructions: string;
	activationExamples?: string[];
	enabled?: boolean;
	creationSource?: SkillCreationSource;
}

export type UpdateUserSkillVariantDefinitionInput = Partial<
	Omit<CreateUserSkillVariantDefinitionInput, "baseSkillId">
>;

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

const spreadsheetManagedResources = [
	{
		id: "spreadsheet-style-quality",
		title: "Spreadsheet style and workbook quality",
		kind: "guidance",
		summary:
			"Workbook structure, visual hierarchy, formulas, assumptions, source separation, validation, and dashboard/KPI layout guidance adapted for AlfyAI XLSX delivery.",
		whenToUse:
			"Use for every spreadsheet or workbook request, especially new XLSX creation, analytical tables, dashboards, templates, trackers, and workbook edits.",
	},
	{
		id: "spreadsheet-finance-models",
		title: "Finance and operating model conventions",
		kind: "domain_template",
		summary:
			"Finance, accounting, valuation, forecasting, FP&A, sensitivity, scenario, and operating-model conventions with clear assumptions, checks, sources, and formula-driven outputs.",
		whenToUse:
			"Use only when the request is finance, accounting, valuation, budgeting, forecasting, investing, KPI, operations metrics, or investment-banking related.",
	},
	{
		id: "spreadsheet-healthcare-admin",
		title: "Healthcare workbook conventions",
		kind: "domain_template",
		summary:
			"Healthcare and clinical-administration workbook conventions for raw-data preservation, units, identifiers, thresholds, legends, and urgent scannability.",
		whenToUse:
			"Use only for healthcare, clinical, hospital, patient, staffing, care-delivery, or healthcare-administration workbooks.",
	},
	{
		id: "spreadsheet-marketing-analytics",
		title: "Marketing analytics conventions",
		kind: "domain_template",
		summary:
			"Marketing, advertising, funnel, CRM, attribution, ROI, and campaign-reporting conventions for source data, KPI dashboards, helper tables, and metric formatting.",
		whenToUse:
			"Use only for marketing, advertising, campaign, funnel, lead, CRM, growth, attribution, ROI, web, or ad-performance workbooks.",
	},
	{
		id: "spreadsheet-scientific-research",
		title: "Scientific research workbook conventions",
		kind: "domain_template",
		summary:
			"Scientific and research workbook conventions for raw measurements, processed-data copies, units in headers, reproducible calculations, and transparent helper columns.",
		whenToUse:
			"Use only for scientific research, experiments, lab measurements, surveys, statistics, reproducibility, protocols, or raw/processed research data.",
	},
] satisfies ManagedSkillResourceMetadata[];

const spreadsheetPromptResources = [
	{
		...spreadsheetManagedResources[0],
		content: [
			"Default workbook shape: summary or dashboard first when useful, then source data, assumptions, calculations, checks, and detail sheets.",
			"Use formula-driven derived values, readable labels, number/date formats, sensible widths, freeze panes, filters, validation lists, light borders, and restrained fills.",
			"Keep source facts and assumptions separate. Put source references in workbook cells or compact source/audit sheets.",
			"For visuals, use chart-ready helper tables, KPI blocks, conditional formats, heatmaps, timelines, and static worksheet layouts.",
			"Verify with bounded sandbox-local checks: output file count, workbook reload, expected sheets, representative formulas, and obvious formula-error scans.",
		].join(" "),
		keywords: [],
	},
	{
		...spreadsheetManagedResources[1],
		content: [
			"Use a finance model structure — assumptions, drivers, model, outputs, scenarios, checks, sources/audit — with assumptions in labeled cells, not hardcoded in formulas.",
			"Build explicit scenario columns (base / downside / upside) from those assumption cells, and surface trigger points such as cash falling below one payroll.",
			"Include unit economics where relevant (gross/contribution margin, CAC payback, LTV/CAC) and flag any line operating below breakeven.",
			"Apply finance number formats and visible checks (totals, sign/units, scenario inputs, balance/cash-flow ties).",
			'End recommendations with an explicit "what would change this conclusion" note or cell.',
		].join(" "),
		keywords: [
			"finance",
			"financial",
			"valuation",
			"dcf",
			"budget",
			"forecast",
			"fp&a",
			"kpi",
			"operating model",
			"sensitivity",
			"scenario",
			"investment",
			"lbo",
			"three-statement",
		],
	},
	{
		...spreadsheetManagedResources[2],
		content: [
			"Preserve raw healthcare data and use separate calculation/report sheets. Label units, identifiers, thresholds, normal ranges, and code definitions clearly.",
			"Use legends and conditional formats for critical or attention-needed values, and keep clinical or staffing views printable and scannable.",
		].join(" "),
		keywords: [
			"healthcare",
			"clinical",
			"patient",
			"medical",
			"hospital",
			"staffing",
			"care delivery",
			"clinic",
		],
	},
	{
		...spreadsheetManagedResources[3],
		content: [
			"Separate source exports, processing/analysis, and dashboard/report sheets. Keep raw marketing data intact and make cleaning steps formula-driven or documented.",
			"Format common metrics clearly: budget, spend, CPA, CPC, CPM, CTR, conversion rate, ROAS, funnel conversion, leads, pipeline, and attribution notes.",
		].join(" "),
		keywords: [
			"marketing",
			"advertising",
			"campaign",
			"funnel",
			"lead",
			"crm",
			"growth",
			"attribution",
			"roi",
			"roas",
			"ad performance",
		],
	},
	{
		...spreadsheetManagedResources[4],
		content: [
			"Keep raw measurements separate from processed data and results. Put units in headers, one variable per column, and one observation per row.",
			"Document cleaning steps, conversions, reproducibility notes, and helper-column calculations so results remain auditable.",
		].join(" "),
		keywords: [
			"scientific",
			"research",
			"experiment",
			"lab",
			"measurement",
			"survey",
			"statistical",
			"protocol",
			"reproducibility",
		],
	},
] satisfies ManagedSkillPromptResource[];

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
				"Tag each finding with a severity — Blocker (breaks correctness or a hard constraint), Major (likely rework), or Minor (polish) — and lead with Blockers.",
				'For every Blocker, name the concrete failure it causes if the plan ships as-is, not just that it is "risky".',
				"Give the plan one overall risk read (Low / Medium / High) with a one-line rationale, so the user knows whether it is safe to proceed.",
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
				"Minden megállapítást láss el súlyossággal — Blokkoló (helyességet vagy kemény korlátot sért), Jelentős (valószínűleg újramunkát igényel) vagy Kisebb (csiszolás) —, és a Blokkolókkal kezdj.",
				'Minden Blokkolónál nevezd meg a konkrét hibát, amit okoz, ha a terv változatlanul kerül végrehajtásra, ne csak azt, hogy "kockázatos".',
				"Adj a tervnek egy összesített kockázati besorolást (Alacsony / Közepes / Magas) egysoros indoklással, hogy a felhasználó tudja, biztonságos-e a folytatás.",
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
				"Lead with a one-line takeaway, then a short plain-language summary, then the detailed breakdown, so the user can stop at the depth they need.",
				'For any claim that is uncertain or that the document leaves ambiguous, add an explicit inline "Confidence: high/medium/low" label with a one-line reason — never bury the uncertainty in prose.',
				"Keep visibly separate: what the document actually states, what you are inferring, and what needs outside verification.",
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
				"Kezdd egy egysoros lényegi megállapítással, majd egy rövid közérthető összefoglalóval, majd a részletes bontással, hogy a felhasználó ott álljon meg, ameddig szüksége van rá.",
				'Minden bizonytalan vagy a dokumentum által kétértelműen hagyott állításnál adj kifejezett, beágyazott "Megbízhatóság: magas/közepes/alacsony" jelölést egysoros indoklással — a bizonytalanságot soha ne rejtsd el a szövegben.',
				"Láthatóan különítsd el: mit állít ténylegesen a dokumentum, mit következtetsz te, és mit kell külsőleg ellenőrizni.",
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
				"When comparing options, present them as a comparison table across the criteria that matter to this user (price, the two or three specs they care about, key differentiators), not as prose paragraphs.",
				"For your leading recommendation, always name at least one real weakness or who should skip it — never present a pick as flawless.",
				"End with a clear call — buy now / wait / skip, tied to this user's use case — or the single missing fact that would decide it.",
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
				"Ha lehetőségeket hasonlítasz össze, összehasonlító táblázatként mutasd be őket a felhasználó számára fontos szempontok mentén (ár, a két-három legfontosabb specifikáció, kulcsfontosságú megkülönböztető jegyek), ne folyószövegben.",
				"A vezető ajánlásodnál mindig nevezz meg legalább egy valódi gyengeséget vagy azt, kinek nem ajánlott — sose mutass be egy választást hibátlanként.",
				"Zárd egyértelmű döntéssel — vedd meg most / várj / hagyd ki, a felhasználó konkrét felhasználási esetéhez kötve — vagy azzal az egy hiányzó ténnyel, amely eldöntené a kérdést.",
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
				"Lead with the actions that matter most before the appointment, not with background — the user may be reading this minutes beforehand.",
				'Add a short "verify / flag" section for anything high-stakes or rule-dependent: what to confirm with an official source or professional, and how urgently.',
				"Where relevant, call out what to avoid saying or committing to, and what to preserve or bring (documents, evidence, references).",
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
				"Az időpont előtt legfontosabb teendőkkel kezdj, ne a háttérrel — előfordulhat, hogy a felhasználó ezt percekkel előtte olvassa.",
				"Adj rövid „ellenőrizni / jelezni” szakaszt minden nagy tétű vagy szabályfüggő ponthoz: mit kell hivatalos forrásból vagy szakembertől megerősíteni, és milyen sürgősséggel.",
				"Ahol releváns, emeld ki, mit kerüljön el kimondani vagy vállalni, és mit őrizzen meg vagy vigyen magával (dokumentumok, bizonyítékok, hivatkozások).",
			].join("\n"),
		},
		activationExamples: [
			"prepare me for this appointment",
			"help me plan this meeting",
			"make questions for this call",
			"build an appointment checklist",
		],
	},
	{
		id: "system:spreadsheet-builder",
		en: {
			displayName: "Spreadsheet Builder",
			description:
				"Creates polished XLSX workbooks with formulas, tables, assumptions, dashboards, and AlfyAI file-production delivery.",
			instructions: [
				"Use this skill when the user asks to create, edit, analyze, visualize, or work with spreadsheet files such as .xlsx, .xls, .csv, or .tsv.",
				'For downloadable XLSX creation, route the work through produce_file with structured tool input: sourceMode: "program", requestedOutputs: [{ "type": "xlsx" }], program: { language: "javascript", sourceCode, filename }, idempotencyKey, requestTitle, and documentIntent.',
				'The JavaScript program.sourceCode should use exceljs and write final requested files under /output with workbook.xlsx.writeFile("/output/<name>.xlsx"). When program.filename is provided, produce exactly one final requested workbook at /output/<name>.xlsx and do not write scratch diagnostics or unrelated files under /output.',
				"Use bounded sheets, tables, and helper ranges. Keep raw/source data, assumptions, calculations, outputs, checks, and dashboard or KPI views separated when the task is analytical.",
				"Use formula-driven workbook logic for derived values. Avoid magic numbers in formulas; put assumptions in labeled cells or sheets and reference them.",
				"When formulas are included, set workbook.calcProperties.fullCalcOnLoad = true. Verify only with sandbox-local assertions, formula-text/error scans, ZIP/workbook reload checks, and representative worksheet checks.",
				"Use exceljs tables, freeze panes, filters, data validation, number formats, column widths, fills, borders, conditional formatting where supported, and clear titles to make the workbook usable and polished.",
				"For visual summaries, create chart-ready helper tables, KPI/dashboard layouts, heatmaps, timelines, and tested static worksheet visuals. Do not use embedded plotting APIs until the runtime has explicit support for them.",
				"Keep domain-specific guidance selective: include finance, healthcare, marketing, or scientific conventions only when the user's request clearly matches that domain.",
				"Be explicit about source facts versus assumptions. Cite sources inside workbook cells or source/audit sheets when the task depends on external or user-provided data.",
			].join("\n"),
		},
		hu: {
			displayName: "Táblázatkészítő",
			description:
				"Átgondolt XLSX munkafüzeteket készít képletekkel, táblákkal, feltételezésekkel, irányítópultokkal és AlfyAI fájl-előállítással.",
			instructions: [
				"Akkor használd ezt a skillt, amikor a felhasználó táblázatfájlokkal, például .xlsx, .xls, .csv vagy .tsv fájlokkal szeretne létrehozási, szerkesztési, elemzési vagy vizualizációs munkát végezni.",
				'Letölthető XLSX létrehozásához a munkát strukturált produce_file eszközbemenettel indítsd: sourceMode: "program", requestedOutputs: [{ "type": "xlsx" }], program: { language: "javascript", sourceCode, filename }, idempotencyKey, requestTitle és documentIntent mezők.',
				'A JavaScript program.sourceCode exceljs-t használjon, és a végleges kért fájlokat a /output alá írja a workbook.xlsx.writeFile("/output/<name>.xlsx") hívással. Ha a program.filename adott, pontosan egy végleges kért munkafüzet készüljön a /output/<name>.xlsx útvonalon, és ne kerüljenek segédnaplók vagy nem kért fájlok a /output alá.',
				"Használj korlátozott méretű munkalapokat, táblákat és segédtartományokat. Elemző feladatnál válaszd szét a nyers/forrásadatokat, feltételezéseket, számításokat, kimeneteket, ellenőrzéseket és dashboard vagy KPI nézeteket.",
				"A származtatott értékek munkafüzetbeli logikája képletekből álljon. Ne rejts üzleti feltételezéseket képletekbe; tedd őket címkézett cellákba vagy lapokra, és hivatkozz rájuk.",
				"Ha képletek vannak a munkafüzetben, állítsd be: workbook.calcProperties.fullCalcOnLoad = true. Az ellenőrzés csak sandboxon belüli állításokra, képlet- és hibakeresésre, ZIP/munkafüzet újratöltésre és reprezentatív munkalapellenőrzésre támaszkodjon.",
				"Használj exceljs táblákat, rögzített paneleket, szűrőket, adatvalidációt, számformátumokat, oszlopszélességeket, kitöltéseket, szegélyeket, támogatott feltételes formázást és világos címeket.",
				"Vizuális összefoglalókhoz diagramkész segédtáblákat, KPI/dashboard elrendezéseket, hőtérképeket, ütemterveket és ellenőrzött statikus munkalapi vizuális elemeket készíts. Ne használj beágyazott rajzolási API-kat, amíg a futtatókörnyezet ezt külön nem támogatja.",
				"Domain-specifikus útmutatást csak akkor használj, ha a felhasználói kérés egyértelműen illeszkedik a pénzügyi, egészségügyi, marketing vagy tudományos területhez.",
				"Különítsd el a forrástényeket és a feltételezéseket. Ha a feladat külső vagy felhasználói adatoktól függ, a forrásokat cellákban vagy forrás/audit lapon tüntesd fel.",
			].join("\n"),
		},
		activationExamples: [
			"build a spreadsheet",
			"create an xlsx workbook",
			"make a KPI dashboard",
			"turn this into a financial model",
			"format this CSV as a workbook",
		],
		managedResources: spreadsheetManagedResources,
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
	"system:grill-with-docs:v3": {
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
		activationExamples: [
			"criticize this plan",
			"challenge this against our ADRs",
			"stress-test this implementation plan",
			"find the weak assumptions",
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
	"system:document-explainer:v2": {
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
		activationExamples: [
			"explain this document",
			"summarize this source",
			"what does this file mean",
			"extract the important caveats",
		],
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
	"system:purchase-helper:v2": {
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
		activationExamples: [
			"help me choose what to buy",
			"compare these options",
			"which option fits my needs",
			"make a buying decision matrix",
		],
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
	"system:appointment-prep:v2": {
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
		activationExamples: [
			"prepare me for this appointment",
			"help me plan this meeting",
			"make questions for this call",
			"build an appointment checklist",
		],
	},
} as const;

export function previousDefaultsForBuiltInSkill(id: string) {
	return Object.entries(previousBuiltInSystemSkillDefaults)
		.filter(([key]) => key === id || key.startsWith(`${id}:`))
		.map(([, value]) => value);
}

export function getBuiltInSystemSkillEnInstructions(id: string): string {
	const builtIn = builtInSystemSkills.find((skill) => skill.id === id);
	if (!builtIn) {
		throw new Error(`Unknown built-in system skill id: ${id}`);
	}
	return builtIn.en.instructions;
}

export function getSpreadsheetFinanceModelsResourceContent(): string {
	const resource = spreadsheetPromptResources.find(
		(resource) => resource.id === "spreadsheet-finance-models",
	);
	if (!resource) {
		throw new Error("Missing spreadsheet-finance-models resource.");
	}
	return resource.content;
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

function isManagedResourceKind(
	value: unknown,
): value is ManagedSkillResourceMetadata["kind"] {
	return value === "guidance" || value === "domain_template";
}

function parseManagedResources(
	value: string | null,
): ManagedSkillResourceMetadata[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((item): ManagedSkillResourceMetadata[] => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return [];
			const record = item as Record<string, unknown>;
			if (
				typeof record.id !== "string" ||
				typeof record.title !== "string" ||
				!isManagedResourceKind(record.kind) ||
				typeof record.summary !== "string" ||
				typeof record.whenToUse !== "string"
			) {
				return [];
			}
			return [
				{
					id: record.id,
					title: record.title,
					kind: record.kind,
					summary: record.summary,
					whenToUse: record.whenToUse,
				},
			];
		});
	} catch {
		return [];
	}
}

function builtInManagedResourcesForSkill(
	skillId: string,
): ManagedSkillResourceMetadata[] {
	const builtIn = builtInSystemSkills.find((skill) => skill.id === skillId);
	if (!builtIn || !("managedResources" in builtIn)) return [];
	return [...(builtIn.managedResources ?? [])];
}

function builtInPromptResourcesForSkill(
	skillId: string,
): ManagedSkillPromptResource[] {
	if (skillId === "system:spreadsheet-builder") {
		return [...spreadsheetPromptResources];
	}
	return [];
}

function serializeManagedResources(
	resources: readonly ManagedSkillResourceMetadata[] | undefined,
): string | null {
	return resources?.length ? JSON.stringify(resources) : null;
}

const hiddenSystemPackPreferenceDescription =
	"__alfyai_hidden_system_skill_pack__";

function hiddenSystemPackPreferenceId(
	userId: string,
	packSkillId: string,
): string {
	return `hidden-system-pack:${createHash("sha256")
		.update(`${userId}\0${packSkillId}`)
		.digest("hex")
		.slice(0, 32)}`;
}

function toUnixSeconds(value: Date): number {
	return Math.floor(value.getTime() / 1000);
}

function rowSkillKind(
	row: typeof userSkillDefinitions.$inferSelect,
): SkillKind {
	if (
		row.skillKind === "user_skill" ||
		row.skillKind === "skill_pack" ||
		row.skillKind === "skill_variant"
	) {
		return row.skillKind;
	}
	return row.ownership === "system" ? "skill_pack" : "user_skill";
}

function toUserSkillDefinition(
	row: typeof userSkillDefinitions.$inferSelect,
): UserSkillDefinition {
	return {
		id: row.id,
		ownership: "user",
		skillKind: rowSkillKind(row),
		baseSkillId: row.baseSkillId ?? null,
		baseSkillVersion: row.baseSkillVersion ?? null,
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
	const managedResources = parseManagedResources(row.resourceMetadataJson);
	return {
		id: row.id,
		ownership: "system",
		skillKind: "skill_pack",
		baseSkillId: null,
		baseSkillVersion: null,
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
		managedResources:
			managedResources.length > 0
				? managedResources
				: builtInManagedResourcesForSkill(row.id),
	};
}

function toSystemSkillSummary(
	row: typeof userSkillDefinitions.$inferSelect,
): SystemSkillSummary {
	const {
		instructions: _instructions,
		localizedDefaults,
		managedResources: _managedResources,
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

function toUserSkillVariantDefinition(
	row: typeof userSkillDefinitions.$inferSelect,
	packRow: typeof userSkillDefinitions.$inferSelect | undefined,
): UserSkillVariantDefinition {
	const packUnavailableReason = unavailablePackReason(packRow);
	return {
		...toUserSkillDefinition(row),
		skillKind: "skill_variant",
		baseSkillId: row.baseSkillId ?? "",
		baseSkillVersion: packRow?.version ?? row.baseSkillVersion ?? null,
		baseSkillDisplayName: packRow?.displayName ?? null,
		baseSkillLocalizedDefaults: packRow
			? toSystemSkillSummary(packRow).localizedDefaults
			: null,
		baseSkillAvailable: packUnavailableReason === null,
		baseSkillAvailabilityReason: packUnavailableReason ?? "available",
	};
}

function toUserSkillVariantSummary(
	row: typeof userSkillDefinitions.$inferSelect,
	packRow: typeof userSkillDefinitions.$inferSelect,
): Omit<UserSkillVariantDefinition, "instructions"> {
	const { instructions: _instructions, ...summary } =
		toUserSkillVariantDefinition(row, packRow);
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
	if (skill.ownership === "system" && "localizedDefaults" in skill) {
		displayNames.push(
			skill.localizedDefaults.en.displayName,
			skill.localizedDefaults.hu.displayName,
		);
		descriptions.push(
			skill.localizedDefaults.en.description,
			skill.localizedDefaults.hu.description,
		);
	}
	if (skill.skillKind === "skill_variant") {
		if (skill.baseSkillDisplayName)
			displayNames.push(skill.baseSkillDisplayName);
		if (skill.baseSkillLocalizedDefaults) {
			displayNames.push(
				skill.baseSkillLocalizedDefaults.en.displayName,
				skill.baseSkillLocalizedDefaults.hu.displayName,
			);
			descriptions.push(
				skill.baseSkillLocalizedDefaults.en.description,
				skill.baseSkillLocalizedDefaults.hu.description,
			);
		}
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

function localizeVariantBaseSkillName<
	T extends {
		baseSkillDisplayName?: string | null;
		baseSkillLocalizedDefaults?: SystemSkillSummaryLocalizedDefaults | null;
	},
>(skill: T, language: "en" | "hu" | undefined): T {
	if (language !== "hu" || !skill.baseSkillLocalizedDefaults) return skill;
	const localized = skill.baseSkillLocalizedDefaults[language];
	const english = skill.baseSkillLocalizedDefaults.en;
	const baseSkillDisplayName =
		skill.baseSkillDisplayName === english.displayName ||
		skill.baseSkillDisplayName === localized.displayName
			? localized.displayName
			: skill.baseSkillDisplayName;
	return {
		...skill,
		baseSkillDisplayName,
	};
}

export function localizeUserSkillVariantDefinition(
	variant: UserSkillVariantDefinition,
	language: "en" | "hu" | undefined,
): UserSkillVariantDefinition {
	return localizeVariantBaseSkillName(variant, language);
}

export function localizeSkillDiscoverySummary(
	skill: SkillDiscoverySummary,
	language: "en" | "hu" | undefined,
): SkillDiscoverySummary {
	if (skill.ownership === "system" && "localizedDefaults" in skill) {
		return localizeSystemSkillSummary(skill, language);
	}
	return skill.skillKind === "skill_variant"
		? localizeVariantBaseSkillName(skill, language)
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
		skillKind: "user_skill",
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
		skillKind: "skill_pack",
		published: input.published ?? false,
	};
}

async function requireAvailablePackForVariant(
	baseSkillId: unknown,
): Promise<typeof userSkillDefinitions.$inferSelect> {
	const packSkillId = cleanRequiredText(
		baseSkillId,
		"skillVariant.baseSkillRequired",
		"Skill Pack is required.",
		200,
	);
	const packRow = await getPackRow(packSkillId);
	const unavailableReason = unavailablePackReason(packRow);
	if (unavailableReason || !packRow) {
		throw new UserSkillValidationError(
			`skillVariant.${unavailableReason ?? "base_pack_missing"}`,
			"Selected Skill Pack is not available.",
		);
	}
	return packRow;
}

async function buildVariantCreateValues(
	userId: string,
	input: CreateUserSkillVariantDefinitionInput,
) {
	const packRow = await requireAvailablePackForVariant(input.baseSkillId);
	return {
		id: randomUUID(),
		userId,
		ownership: "user",
		skillKind: "skill_variant",
		baseSkillId: packRow.id,
		baseSkillVersion: packRow.version,
		displayName: cleanRequiredText(
			input.displayName,
			"skill.displayNameRequired",
			"Display name is required.",
			120,
		),
		description: cleanOptionalText(input.description, 600),
		instructions: cleanOptionalText(input.instructions, 8000),
		activationExamplesJson: JSON.stringify(
			cleanExamples(input.activationExamples),
		),
		enabled: input.enabled ?? true,
		published: false,
		durationPolicy: "next_message",
		questionPolicy: "none",
		notesPolicy: "none",
		sourceScope: "current_conversation",
		creationSource: cleanEnum(
			input.creationSource,
			creationSources,
			"user_created",
			"skill.invalidCreationSource",
		),
	};
}

function buildEffectiveInstructions(parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
}

function hashEffectiveInstructions(params: {
	instructions: string;
	sourceIds: EffectiveSkillSourceIds;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				instructions: params.instructions,
				sourceIds: params.sourceIds,
			}),
		)
		.digest("hex");
}

function unavailableResolution(params: {
	id: string;
	ownership: SkillOwnership;
	reason: Exclude<SkillAvailabilityReason, "available">;
	row?: typeof userSkillDefinitions.$inferSelect | null;
	publicSummary?: SkillDiscoverySummary | null;
}): EffectiveSkillDefinition {
	return {
		available: false,
		availabilityReason: params.reason,
		id: params.id,
		ownership: params.ownership,
		skillKind: params.row ? rowSkillKind(params.row) : null,
		displayName: params.row?.displayName ?? null,
		description: params.row?.description ?? null,
		effectiveInstructions: "",
		effectiveInstructionsHash: null,
		publicSummary: params.publicSummary ?? null,
		sourceIds: null,
	};
}

function availableResolution(params: {
	row: typeof userSkillDefinitions.$inferSelect;
	publicSummary: SkillDiscoverySummary;
	instructions: string;
	durationPolicy: SkillDurationPolicy;
	questionPolicy: SkillQuestionPolicy;
	notesPolicy: SkillNotesPolicy;
	sourceScope: SkillSourceScope;
	promptResources?: ManagedSkillPromptResource[];
	sourceIds: EffectiveSkillSourceIds;
}): EffectiveSkillDefinition {
	const effectiveInstructionsHash = hashEffectiveInstructions({
		instructions: params.instructions,
		sourceIds: params.sourceIds,
	});
	return {
		available: true,
		availabilityReason: "available",
		id: params.row.id,
		ownership: params.row.ownership as SkillOwnership,
		skillKind: rowSkillKind(params.row),
		displayName: params.row.displayName,
		description: params.row.description,
		effectiveInstructions: params.instructions,
		effectiveInstructionsHash,
		publicSummary: params.publicSummary,
		durationPolicy: params.durationPolicy,
		questionPolicy: params.questionPolicy,
		notesPolicy: params.notesPolicy,
		sourceScope: params.sourceScope,
		promptResources: params.promptResources ?? [],
		sourceIds: params.sourceIds,
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

function buildVariantUpdateValues(
	input: UpdateUserSkillVariantDefinitionInput,
) {
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
	if ("instructions" in input)
		values.instructions = cleanOptionalText(input.instructions, 8000);
	if ("activationExamples" in input) {
		values.activationExamplesJson = JSON.stringify(
			cleanExamples(input.activationExamples),
		);
	}
	if ("enabled" in input && typeof input.enabled === "boolean")
		values.enabled = input.enabled;
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
				eq(userSkillDefinitions.skillKind, "user_skill"),
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
				eq(userSkillDefinitions.skillKind, "user_skill"),
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
				eq(userSkillDefinitions.skillKind, "user_skill"),
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
				eq(userSkillDefinitions.skillKind, "user_skill"),
			),
		)
		.run();

	return result.changes > 0;
}

async function getVariantPackRow(
	row: typeof userSkillDefinitions.$inferSelect,
) {
	return row.baseSkillId ? getPackRow(row.baseSkillId) : undefined;
}

export async function listUserSkillVariantDefinitions(
	userId: string,
): Promise<UserSkillVariantDefinition[]> {
	const rows = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
				eq(userSkillDefinitions.skillKind, "skill_variant"),
			),
		)
		.orderBy(desc(userSkillDefinitions.updatedAt));

	return Promise.all(
		rows.map(async (row) =>
			toUserSkillVariantDefinition(row, await getVariantPackRow(row)),
		),
	);
}

export async function getUserSkillVariantDefinition(
	userId: string,
	skillId: string,
): Promise<UserSkillVariantDefinition | null> {
	const row = await db
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.id, skillId),
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
				eq(userSkillDefinitions.skillKind, "skill_variant"),
			),
		)
		.get();

	return row
		? toUserSkillVariantDefinition(row, await getVariantPackRow(row))
		: null;
}

export async function createUserSkillVariantDefinition(
	userId: string,
	input: CreateUserSkillVariantDefinitionInput,
): Promise<UserSkillVariantDefinition> {
	const [row] = await db
		.insert(userSkillDefinitions)
		.values(await buildVariantCreateValues(userId, input))
		.returning();

	return toUserSkillVariantDefinition(row, await getVariantPackRow(row));
}

export async function updateUserSkillVariantDefinition(
	userId: string,
	skillId: string,
	input: UpdateUserSkillVariantDefinitionInput,
): Promise<UserSkillVariantDefinition | null> {
	const values = buildVariantUpdateValues(input);
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
				eq(userSkillDefinitions.skillKind, "skill_variant"),
			),
		)
		.returning();

	return row
		? toUserSkillVariantDefinition(row, await getVariantPackRow(row))
		: null;
}

export async function deleteUserSkillVariantDefinition(
	userId: string,
	skillId: string,
): Promise<boolean> {
	const result = await db
		.delete(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.id, skillId),
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
				eq(userSkillDefinitions.skillKind, "skill_variant"),
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
		const builtInResourceMetadataJson = serializeManagedResources(
			"managedResources" in builtIn ? builtIn.managedResources : undefined,
		);
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
			if (existing.resourceMetadataJson !== builtInResourceMetadataJson) {
				nextValues.resourceMetadataJson = builtInResourceMetadataJson;
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
				skillKind: "skill_pack",
				displayName: builtIn.en.displayName,
				description: builtIn.en.description,
				instructions: builtIn.en.instructions,
				activationExamplesJson: JSON.stringify(builtIn.activationExamples),
				resourceMetadataJson: builtInResourceMetadataJson,
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

async function listHiddenSystemSkillPackIds(
	userId: string,
): Promise<Set<string>> {
	const rows = await db
		.select({ baseSkillId: userSkillDefinitions.baseSkillId })
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
				eq(userSkillDefinitions.skillKind, "skill_pack"),
				eq(
					userSkillDefinitions.description,
					hiddenSystemPackPreferenceDescription,
				),
			),
		);

	return new Set(
		rows
			.map((row) => row.baseSkillId)
			.filter((id): id is string => typeof id === "string" && id.length > 0),
	);
}

async function isSystemSkillPackHiddenForUser(
	userId: string,
	packSkillId: string,
): Promise<boolean> {
	return (await listHiddenSystemSkillPackIds(userId)).has(packSkillId);
}

export async function setSystemSkillPackHiddenForUser(
	userId: string,
	packSkillId: string,
	hidden: boolean,
): Promise<void> {
	const preferenceId = hiddenSystemPackPreferenceId(userId, packSkillId);
	if (!hidden) {
		await db
			.delete(userSkillDefinitions)
			.where(
				and(
					eq(userSkillDefinitions.id, preferenceId),
					eq(userSkillDefinitions.userId, userId),
					eq(userSkillDefinitions.ownership, "user"),
					eq(userSkillDefinitions.skillKind, "skill_pack"),
				),
			)
			.run();
		return;
	}

	await db
		.insert(userSkillDefinitions)
		.values({
			id: preferenceId,
			userId,
			ownership: "user",
			skillKind: "skill_pack",
			baseSkillId: packSkillId,
			displayName: "Hidden Skill Pack preference",
			description: hiddenSystemPackPreferenceDescription,
			instructions: "",
			activationExamplesJson: "[]",
			enabled: false,
			published: false,
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "current_conversation",
			creationSource: "user_created",
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: userSkillDefinitions.id,
			set: {
				baseSkillId: packSkillId,
				description: hiddenSystemPackPreferenceDescription,
				enabled: false,
				updatedAt: new Date(),
			},
		})
		.run();
}

export async function listEnabledSystemSkillSummaries(
	userId?: string,
): Promise<SystemSkillSummary[]> {
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

	const hiddenIds = userId
		? await listHiddenSystemSkillPackIds(userId)
		: new Set<string>();
	return rows.filter((row) => !hiddenIds.has(row.id)).map(toSystemSkillSummary);
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
	const hiddenSystemSkillIds = await listHiddenSystemSkillPackIds(userId);

	const userSummaries = await Promise.all(
		userRows.map(async (row) => {
			if (rowSkillKind(row) !== "skill_variant") return toUserSkillSummary(row);
			const packRow = await getVariantPackRow(row);
			if (unavailablePackReason(packRow) || !packRow) return null;
			return toUserSkillVariantSummary(row, packRow);
		}),
	);

	return [
		...userSummaries.filter(
			(skill): skill is SkillDiscoverySummary => skill !== null,
		),
		...systemRows
			.filter((row) => !hiddenSystemSkillIds.has(row.id))
			.map(toSystemSkillSummary),
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
	if (
		row.ownership === "system" &&
		(await isSystemSkillPackHiddenForUser(userId, row.id))
	) {
		return null;
	}
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
	if (
		row.ownership === "system" &&
		(await isSystemSkillPackHiddenForUser(userId, row.id))
	) {
		return null;
	}
	return row.ownership === "system"
		? toSystemSkillDefinition(row)
		: toUserSkillDefinition(row);
}

async function getSkillRowForResolution(
	userId: string,
	selection: { id: string; ownership: SkillOwnership },
) {
	return db
		.select()
		.from(userSkillDefinitions)
		.where(
			selection.ownership === "user"
				? and(
						eq(userSkillDefinitions.id, selection.id),
						eq(userSkillDefinitions.userId, userId),
						eq(userSkillDefinitions.ownership, "user"),
					)
				: and(
						eq(userSkillDefinitions.id, selection.id),
						eq(userSkillDefinitions.ownership, "system"),
					),
		)
		.get();
}

async function getPackRow(packSkillId: string) {
	return db
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.id, packSkillId),
				eq(userSkillDefinitions.ownership, "system"),
			),
		)
		.get();
}

function unavailablePackReason(
	packRow: typeof userSkillDefinitions.$inferSelect | undefined,
): "base_pack_missing" | "base_pack_disabled" | "base_pack_unpublished" | null {
	if (!packRow) return "base_pack_missing";
	if (!packRow.enabled) return "base_pack_disabled";
	if (!packRow.published) return "base_pack_unpublished";
	return null;
}

function variantSummary(
	row: typeof userSkillDefinitions.$inferSelect,
	packRow: typeof userSkillDefinitions.$inferSelect,
): Omit<UserSkillDefinition, "instructions"> {
	return {
		...toUserSkillSummary(row),
		baseSkillId: packRow.id,
		baseSkillVersion: packRow.version,
		baseSkillDisplayName: packRow.displayName,
	};
}

export async function resolveEffectiveSkillDefinition(
	userId: string,
	selection: { id: string; ownership: SkillOwnership },
): Promise<EffectiveSkillDefinition> {
	const row = await getSkillRowForResolution(userId, selection);
	if (!row) {
		return unavailableResolution({
			id: selection.id,
			ownership: selection.ownership,
			reason: "not_found",
		});
	}
	if (!row.enabled) {
		return unavailableResolution({
			id: selection.id,
			ownership: selection.ownership,
			reason: "disabled",
			row,
		});
	}
	if (row.ownership === "system" && !row.published) {
		return unavailableResolution({
			id: selection.id,
			ownership: selection.ownership,
			reason: "unpublished",
			row,
			publicSummary: toSystemSkillSummary(row),
		});
	}

	const kind = rowSkillKind(row);
	if (
		row.ownership === "system" &&
		kind === "skill_pack" &&
		(await isSystemSkillPackHiddenForUser(userId, row.id))
	) {
		return unavailableResolution({
			id: selection.id,
			ownership: selection.ownership,
			reason: "hidden",
			row,
			publicSummary: toSystemSkillSummary(row),
		});
	}
	if (kind === "skill_variant") {
		const packSkillId = row.baseSkillId;
		const packRow = packSkillId ? await getPackRow(packSkillId) : undefined;
		const packUnavailableReason = unavailablePackReason(packRow);
		if (packUnavailableReason || !packRow) {
			return unavailableResolution({
				id: selection.id,
				ownership: selection.ownership,
				reason: packUnavailableReason ?? "base_pack_missing",
				row,
				publicSummary: toUserSkillSummary(row),
			});
		}
		const instructions = buildEffectiveInstructions([
			packRow.instructions,
			row.instructions,
		]);
		const sourceIds: EffectiveSkillSourceIds = {
			skillId: row.id,
			skillVersion: row.version,
			packSkillId: packRow.id,
			packSkillVersion: packRow.version,
			variantSkillId: row.id,
			variantSkillVersion: row.version,
		};
		return availableResolution({
			row,
			publicSummary: variantSummary(row, packRow),
			instructions,
			durationPolicy: packRow.durationPolicy as SkillDurationPolicy,
			questionPolicy: packRow.questionPolicy as SkillQuestionPolicy,
			notesPolicy: packRow.notesPolicy as SkillNotesPolicy,
			sourceScope: packRow.sourceScope as SkillSourceScope,
			promptResources: builtInPromptResourcesForSkill(packRow.id),
			sourceIds,
		});
	}

	const instructions = buildEffectiveInstructions([row.instructions]);
	const sourceIds: EffectiveSkillSourceIds = {
		skillId: row.id,
		skillVersion: row.version,
		packSkillId: kind === "skill_pack" ? row.id : null,
		packSkillVersion: kind === "skill_pack" ? row.version : null,
		variantSkillId: null,
		variantSkillVersion: null,
	};
	return availableResolution({
		row,
		publicSummary:
			row.ownership === "system"
				? toSystemSkillSummary(row)
				: toUserSkillSummary(row),
		instructions,
		durationPolicy: row.durationPolicy as SkillDurationPolicy,
		questionPolicy: row.questionPolicy as SkillQuestionPolicy,
		notesPolicy: row.notesPolicy as SkillNotesPolicy,
		sourceScope: row.sourceScope as SkillSourceScope,
		promptResources:
			kind === "skill_pack" ? builtInPromptResourcesForSkill(row.id) : [],
		sourceIds,
	});
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
