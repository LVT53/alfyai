import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store";
import type { Artifact } from "$lib/server/services/knowledge/types";
import type { WorkingSetReasonCode } from "$lib/server/services/working-set";
import { resolveCurrentGeneratedDocumentSelection } from "./document-resolution";

const DOCUMENT_FOCUS_RE =
	/\b(document|doc|file|pdf|attachment|attached|resume|cv|recipe|job description|contract|report)\b/i;
const DOCUMENT_ACTION_RE =
	/\b(summarize|summarise|summary|review|analyze|analyse|rewrite|revise|refine|edit|update|fix|correct|shorten|shorter|expand|polish|translate|extract|compare|convert|format|make)\b/i;
const DOCUMENT_REFERENCE_RE =
	/\b(this|that|it|same|current|open|opened|selected|previous|earlier)\b/i;
const USER_CORRECTION_RE =
	/\b(actually|instead|rather than|use the previous|use the earlier|change it to|revise this|refine this|update this|fix this|correct this|replace that|not that one)\b/i;
const CONTEXT_RESET_RE =
	/\b(done with (?:that|this|it)|finished with (?:that|this|it)|finished (?:that|this|it)|completed (?:that|this|it)|that(?:'s| is) done|wrapped up|move on|switch topics|new topic|another topic|something else|let's talk about something else)\b/i;
const NEW_GENERATED_DOCUMENT_REQUEST_RE =
	/\b(create|generate|make|produce|export|convert|build)\b[\s\S]{0,140}\b(pdf|docx|xlsx|pptx|csv|html|file|document|report|deck|slide deck|slides|spreadsheet|workbook)\b|\b(pdf|docx|xlsx|pptx|csv|html)\b[\s\S]{0,80}\b(called|named)\b/i;
const EXPLICIT_DOCUMENT_INPUT_REFERENCE_RE =
	/\b(this|that|same|current|open|opened|selected|attached|attachment|uploaded|source)\b|\bthe\s+(?:document|doc|file|pdf|attachment|report|source)\b|\b(from|based on|using|use|with)\s+(?:the\s+)?(?:this|that|it|current|open|opened|selected|attached|attachment|uploaded|document|doc|file|pdf|report|source)\b/i;

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");
const escapeRegex = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const LETTERS = "[\\p{L}]*";
const NOT_LETTER = "(?![\\p{L}])";
const START = "(?<![\\p{L}])";

// "dokumentum*" = the word with any ending; "írd át" = two words; a RegExp is used as written.
type HungarianEntry = string | RegExp;
function entrySource(entry: HungarianEntry) {
	if (entry instanceof RegExp) return fold(entry.source);
	const open = entry.endsWith("*");
	const words = fold(open ? entry.slice(0, -1) : entry)
		.split(" ")
		.map(escapeRegex)
		.join("\\s+");
	return words + (open ? LETTERS : NOT_LETTER);
}
const alternation = (entries: HungarianEntry[]) =>
	entries.map(entrySource).join("|");
const hungarian = (entries: HungarianEntry[]) =>
	new RegExp(`${START}(?:${alternation(entries)})`, "iu");

// ---- document nouns ---------------------------------------------------------
const REPORT =
	/jelentés(?!e(?:t|ről|ben|ből|vel|re|hez|nek)?(?![\p{L}]))[\p{L}]*/u;
const RECIPE =
	/recept(?:et|em|je|e[kmdt]?|ek(?:et|ben|re|hez|ről|ből|nek|kel)|jé?[nt]?|jei[tk]?|ben|be|re|hez|ről|ből|nek|tel|ért)(?![\p{L}])/u;
const FOCUS_NOUNS = [
	"dokumentum*",
	"doksi*",
	/fájl(?!al)[\p{L}]*/u,
	"csatolmány*",
	"csatolt",
	"csatolva",
	"mellékelt",
	"mellékelve",
	"melléklet*",
	"önéletrajz*",
	"állásleírás*",
	"munkaköri leírás*",
	"szerződés*",
	"riport*",
	"beszámoló*",
	RECIPE,
	REPORT,
];

// ---- verbs: "any" = the message asks for it in any form, "def" = forms that hold their own object ("it")
const FRAME_INFINITIVES =
	"foglalni|nézni|olvasni|írni|fogalmazni|dolgozni|javítani|rövidíteni|bővíteni|fordítani|hasonlítani|alakítani|szedni|csiszolni|finomítani|pontosítani|korrigálni|frissíteni|formázni|elemezni";
const VERBS = [
	{
		en: "summarize",
		refine: true,
		any: [
			"összefoglal*",
			"összefoglaló*",
			"összegez*",
			/foglal[\p{L}]*\s+össze/u,
		],
		def: [
			"foglald össze",
			"foglalnád össze",
			"összefoglalnád",
			"összegezd",
			"összegeznéd",
		],
	},
	{
		en: "review",
		refine: true,
		any: [
			"átnéz*",
			"átolvas*",
			"áttekint*",
			"felülvizsgál*",
			/néz[\p{L}]*\s+át/u,
			/olvas[\p{L}]*\s+át/u,
			/tekints[\p{L}]*\s+át/u,
		],
		def: [
			"nézd át",
			"olvasd át",
			"tekintsd át",
			"átnéznéd",
			"átolvasnád",
			"felülvizsgálnád",
		],
	},
	{
		en: "analyze",
		refine: true,
		any: ["elemez*", "analizál*"],
		def: ["elemezd", "elemeznéd", "analizáld"],
	},
	{
		en: "rewrite/revise",
		refine: true,
		any: [
			"átír*",
			"újraír*",
			"átfogalmaz*",
			"újrafogalmaz*",
			"átdolgoz*",
			"módosít*",
			"írd át",
			"írj át",
			"írd újra",
			"írj újra",
			/fogalmaz[\p{L}]*\s+(?:át|újra)/u,
			/dolgoz[\p{L}]*\s+(?:át|újra)/u,
		],
		def: [
			"írd át",
			"írd újra",
			"átírnád",
			"újraírnád",
			"fogalmazd át",
			"fogalmazd újra",
			"átfogalmaznád",
			"dolgozd át",
			"dolgozd újra",
			"átdolgoznád",
			"módosítsd",
			"módosítanád",
		],
	},
	{
		en: "refine/polish",
		refine: true,
		any: ["finomít*", "pontosít*", "csiszol*", "tökéletesít*"],
		def: [
			"finomítsd",
			"finomítanád",
			"pontosítsd",
			"pontosítanád",
			"csiszold",
			"csiszolnád",
			"tökéletesítsd",
		],
	},
	{
		en: "edit",
		refine: true,
		any: ["szerkes*"],
		def: ["szerkeszd", "szerkesztenéd"],
	},
	{
		en: "update",
		refine: true,
		any: ["frissít*", "aktualizál*"],
		def: ["frissítsd", "frissítenéd", "aktualizáld", "aktualizálnád"],
	},
	{
		en: "fix/correct",
		refine: true,
		any: [/javít(?!ero)[\p{L}]*/u, "kijavít*", "korrigál*", "helyesbít*"],
		def: [
			"javítsd ki",
			"javítanád",
			"kijavítanád",
			"korrigáld",
			"korrigálnád",
			"helyesbítsd",
			/javítsd(?!\s+meg(?![\p{L}]))(?![\p{L}])/u,
		],
	},
	{
		en: "shorten",
		refine: true,
		any: ["rövidít*", "lerövidít*", "rövidebb*", "tömörít*"],
		def: [
			"rövidítsd",
			"rövidítenéd",
			"lerövidítenéd",
			"tömörítsd",
			"tömörítenéd",
			"vágd rövidebbre",
		],
	},
	{
		en: "expand",
		refine: true,
		any: [
			"bővít*",
			"kibővít*",
			"részletez*",
			"kiegészít*",
			/fejt[\p{L}]*\s+ki/u,
			/egészít[\p{L}]*\s+ki/u,
		],
		def: [
			"bővítsd",
			"bővítenéd",
			"kibővítenéd",
			"fejtsd ki",
			"részletezd",
			"egészítsd ki",
			"kiegészítenéd",
		],
	},
	{
		en: "translate",
		refine: true,
		any: ["fordít*", "lefordít*"],
		def: [
			"fordítsd le",
			"fordítanád",
			"lefordítanád",
			/fordítsd(?!\s+(?:meg|el|vissza|fel|be|ki)(?![\p{L}]))(?![\p{L}])/u,
		],
	},
	{
		en: "extract",
		refine: true,
		any: [
			"kinyer*",
			"kigyűjt*",
			"kiszed*",
			"kiemel*",
			"szedd ki",
			"nyerd ki",
			"emeld ki",
			/gyűjts[\p{L}]*\s+ki/u,
		],
		def: [
			"szedd ki",
			"gyűjtsd ki",
			"nyerd ki",
			"emeld ki",
			"kiszednéd",
			"kigyűjtenéd",
		],
	},
	{
		en: "compare",
		refine: true,
		any: [
			"összehasonlít*",
			"összevet*",
			"vesd össze",
			/hasonlít[\p{L}]*\s+össze/u,
		],
		def: [
			"hasonlítsd össze",
			"vesd össze",
			"összehasonlítanád",
			"hasonlítanád össze",
		],
	},
	{
		en: "convert",
		refine: false,
		any: [
			"átalakít*",
			"átvált*",
			"konvertál*",
			"exportál*",
			/alakít[\p{L}]*\s+át/u,
			/válts[\p{L}]*\s+át/u,
		],
		def: [
			"alakítsd át",
			"alakítanád át",
			"átalakítanád",
			"konvertáld",
			"konvertálnád",
			"exportáld",
			"váltsd át",
		],
	},
	{
		en: "format",
		refine: false,
		any: [/formáz(?!yl)[\p{L}]*/u, "megformáz*"],
		def: ["formázd", "formáznád", "megformáznád"],
	},
	{
		en: "make",
		refine: false,
		any: [
			"csinál*",
			"készít*",
			new RegExp(
				`(?:össze|át|le|ki|újra)\\s+tud(?:nád|nál)\\s+(?:${FRAME_INFINITIVES})(?![\\p{L}])`,
			),
		],
		def: [
			/tedd\s+(?:[\p{L}]+\s+){0,2}[\p{L}]*bb[ae](?![\p{L}])/u,
			/(?:legyen|hangozzon)\s+(?:[\p{L}]+\s+){0,2}[\p{L}]*bb(?:an|en)?(?![\p{L}])/u,
			new RegExp(
				`(?:össze|át|le|ki|újra)\\s+tudnád\\s+(?:${FRAME_INFINITIVES})(?![\\p{L}])`,
			),
		],
	},
];

const DEMONSTRATIVES = [
	"ez",
	"ezt",
	"ezen",
	"ennek",
	"ebben",
	"ebbe",
	"ebből",
	"erre",
	"ezzel",
	"ezek",
	"ezeket",
	"ezekben",
	"ezekből",
	"azt",
	"annak",
	"abból",
	"arra",
	"azzal",
	"azokat",
	"azokban",
];
const SAME_CURRENT_OPEN = [
	"ugyanaz*",
	"ugyanez*",
	"ugyanab*",
	"ugyanar*",
	"jelenlegi*",
	"aktuális*",
	"mostani*",
	"nyitott*",
	"megnyitott*",
	"kijelölt*",
	"kiválasztott*",
];
const PREVIOUS_EARLIER = ["előző*", "korábbi*", "korábban", "előbbi*"];

const CORRECTION = [
	"valójában",
	"tulajdonképpen",
	"igazából",
	"mégsem",
	"inkább",
	"helyett",
	"helyette",
	/(?:használd|vedd|maradj|maradjunk|térj\s+vissza|menj\s+vissza|menjünk\s+vissza)\s+(?:az?\s+)?(?:előző|korábbi|előbbi)[\p{L}]*/u,
	/(?:előző|korábbi|előbbi)[\p{L}]*\s+(?:[\p{L}]+\s+)?használd(?![\p{L}])/u,
	/(?:változtasd|cseréld|állítsd)\s+(?:át\s+|le\s+|meg\s+)?(?:[\p{L}]+\s+){0,3}?[\p{L}]+(?:ra|re)(?![\p{L}])/u,
	/(?:javítsd|frissítsd|finomítsd|pontosítsd|korrigáld|módosítsd|dolgozd\s+át|cseréld\s+le)\s+(?:ki\s+)?(?:ezt|azt)(?![\p{L}])/u,
	/(?:ezt|azt)\s+(?:a\s+[\p{L}]+\s+)?(?:javítsd|frissítsd|finomítsd|pontosítsd|korrigáld|módosítsd)(?![\p{L}])/u,
	/nem\s+(?:azt|ezt|erre|arra)(?![\p{L}])/u,
];

const RESET = [
	"végeztem vele",
	"végeztem ezzel",
	"végeztem azzal",
	"végeztünk vele",
	"végeztünk ezzel",
	"végeztünk azzal",
	"kész vagyok vele",
	"kész vagyok ezzel",
	"kész vagyok azzal",
	"kész vagyunk vele",
	"kész vagyunk ezzel",
	"kész vagyunk azzal",
	"ezzel kész vagyok",
	"ezzel kész vagyunk",
	"ezzel befejeztem",
	"ezzel befejeztük",
	"befejeztem",
	"befejeztük",
	"befejezte",
	"befejezték",
	"lezártam",
	"lezártuk",
	"lezárták",
	"lezárult",
	"elkészültem",
	"elkészültünk",
	"elkészült",
	/(?:ez|az)\s+(?:már\s+|most\s+már\s+)?(?:kész|megvan|megvolt)(?![\p{L}])/u,
	"lépjünk tovább",
	"menjünk tovább",
	"haladjunk tovább",
	"térjünk át",
	"térjünk rá",
	/továbblép[\p{L}]*/u,
	/tovább\s+(?:akarok\s+)?lépni(?![\p{L}])/u,
	/(?:váltsunk|váltok|váltanék|válthatunk|váltanánk)\s+témát(?![\p{L}])/u,
	/témát\s+váltani(?![\p{L}])/u,
	"témaváltás*",
	/(?:új|másik)\s+téma[\p{L}]*/u,
	/valami\s+(?:egészen\s+|teljesen\s+)?más(?:ról|ra|t|ba|ban|nal|hoz)?(?![\p{L}])/u,
	/másról\s+beszél[\p{L}]*/u,
];

const FILE_NOUNS_HU = [
	"dokumentum*",
	"doksi*",
	"fájl*",
	"riport*",
	"prezentáció*",
	"diasor*",
	"táblázatkezelő*",
	"excel",
	"munkafüzet*",
	REPORT,
	"pdf",
	"docx",
	"xlsx",
	"pptx",
	"csv",
	"html",
	"file",
	"document",
	"report",
	"deck",
	"slides",
	"spreadsheet",
	"workbook",
];
const CREATE_VERBS_HU = [
	"készít*",
	"csinál*",
	/generál(?:j|d|ni|ok|sz|t|ás|ná|nád|jon|jak|ja|ják|juk)(?![\p{L}])/u,
	"exportál*",
	"létrehoz*",
	"előállít*",
	"átalakít*",
	"konvertál*",
	/hoz[\p{L}]*\s+létre/u,
	/állít[\p{L}]*\s+elő/u,
	/alakít[\p{L}]*\s+át/u,
];

const INPUT_EXTRA = [
	"csatolt*",
	"csatolva",
	"mellékelt*",
	"mellékelve",
	"csatolmány*",
	"melléklet*",
	"feltöltött*",
	/forrás(?:t|ból|ról|ban|ba|hoz|nak|sal|ra|ként|ok(?:at|ból|ról|hoz|ban)?|aim?|ai(?:t|ból|ról)?)?(?![\p{L}])/u,
	"belőle",
	"dokumentum*",
	"doksi*",
	"fájl*",
	REPORT,
	/(?:pdf|docx|xlsx|pptx|csv|html)(?:-[\p{L}]+)?\s+alapján/u,
	/(?:pdf|docx|xlsx|pptx|csv|html)-(?:ből|ről|ben|hez|val|vel|re|nek)(?![\p{L}])/u,
];

function defEntries(
	verbsFilter: (verb: (typeof VERBS)[number]) => boolean = () => true,
) {
	return VERBS.filter(verbsFilter).flatMap((v) => v.def);
}
function anyEntries(
	verbsFilter: (verb: (typeof VERBS)[number]) => boolean = () => true,
) {
	return VERBS.filter(verbsFilter).flatMap((v) => [...v.any, ...v.def]);
}

// A definite verb carries "it" unless an accusative object follows (with or without an article).
const PREVERB = `(?:\\s+(?:le|ki|at|meg|ossze|ujra|fel|el|be|vissza)${NOT_LETTER})?`;
const ADVERB_WITH_T = "(?:most|kicsit|picit|keveset|ismet|ujfent|rogvest)";
const BARE_TAIL = `(?!${PREVERB}\\s+(?:(?:a|az)\\s+)?(?:[\\p{L}\\d]+\\s+){0,2}(?!${ADVERB_WITH_T}${NOT_LETTER})[\\p{L}]*t${NOT_LETTER})`;

export interface DocumentWording {
	focusNoun: boolean;
	action: boolean;
	reference: boolean;
	refine: boolean;
	correction: boolean;
	reset: boolean;
	inputRef: boolean;
	newFile: boolean;
}

// Compile once. Unicode letter boundaries also work for accented and unaccented typing.
const HU_FOCUS_RE = hungarian(FOCUS_NOUNS);
const HU_ACTION_RE = hungarian(anyEntries());
const HU_REFINE_RE = hungarian(anyEntries((v) => v.refine));
const HU_REFERENCE_RE = hungarian([
	...DEMONSTRATIVES,
	...SAME_CURRENT_OPEN,
	...PREVIOUS_EARLIER,
]);
const HU_BARE_DEFINITE_RE = new RegExp(
	`${START}(?:${alternation(defEntries())})${BARE_TAIL}`,
	"iu",
);
const HU_CORRECTION_RE = hungarian(CORRECTION);
const HU_RESET_RE = hungarian(RESET);
const HU_RESET_MATCHES_RE = new RegExp(HU_RESET_RE.source, "giu");

// A completion question asks about the work; a negated reset keeps it in play.
// Move-on questions ("Válthatunk témát?") remain explicit reset requests.
function hasHungarianReset(text: string): boolean {
	let clauseEnd = -1;
	let clauseIsQuestion = false;
	for (const match of text.matchAll(HU_RESET_MATCHES_RE)) {
		const start = match.index;
		const prefix = text.slice(Math.max(0, start - 120), start);
		if (/(?<![\p{L}])(?:ne|nem)(?:\s+[\p{L}]+){0,3}\s*$/iu.test(prefix))
			continue;
		const completion =
			/^(?:vegez|kesz|ezzel|befejez|lezar|elkeszul|(?:ez|az)\s)/iu.test(
				match[0],
			);
		if (completion) {
			if (start > clauseEnd) {
				const offset = start + match[0].length;
				const end = text.slice(offset).search(/[.!?;\n]/u);
				clauseEnd = end < 0 ? text.length : offset + end;
				clauseIsQuestion = text[clauseEnd] === "?";
			}
			if (clauseIsQuestion) continue;
		}
		return true;
	}
	return false;
}
const HU_INPUT_RE = hungarian([
	...DEMONSTRATIVES,
	...SAME_CURRENT_OPEN,
	...INPUT_EXTRA,
]);
const HU_NEW_FILE_RE = new RegExp(
	`${START}(?:${alternation(CREATE_VERBS_HU)})[\\s\\S]{0,140}${START}(?:${alternation(FILE_NOUNS_HU)})|${START}(?:pdf|docx|xlsx|pptx|csv|html)[\\p{L}-]*[\\s\\S]{0,80}(?:${fold("néven|nevű|nevezd el|neve legyen").replace(/ /g, "\\s+")})|${START}(?:${fold("nevű|nevezetű")})\\s+(?:pdf|docx|xlsx|pptx|csv|html)`,
	"iu",
);

/** Reads document cues only; never selects a reply language or writes prompt text. */
export function readHungarianWording(message: string): DocumentWording {
	const text = fold(message);
	return {
		focusNoun: HU_FOCUS_RE.test(text),
		action: HU_ACTION_RE.test(text),
		reference: HU_REFERENCE_RE.test(text) || HU_BARE_DEFINITE_RE.test(text),
		refine: HU_REFINE_RE.test(text),
		correction: HU_CORRECTION_RE.test(text),
		reset: hasHungarianReset(text),
		inputRef: HU_INPUT_RE.test(text),
		newFile: HU_NEW_FILE_RE.test(text),
	};
}

function readEnglishWording(message: string): DocumentWording {
	return {
		focusNoun: DOCUMENT_FOCUS_RE.test(message),
		action: DOCUMENT_ACTION_RE.test(message),
		reference: DOCUMENT_REFERENCE_RE.test(message),
		correction: USER_CORRECTION_RE.test(message),
		reset: CONTEXT_RESET_RE.test(message),
		inputRef: EXPLICIT_DOCUMENT_INPUT_REFERENCE_RE.test(message),
		newFile: NEW_GENERATED_DOCUMENT_REQUEST_RE.test(message),
		refine:
			/\b(summarize|summarise|summary|review|analyze|analyse|rewrite|revise|refine|edit|update|fix|correct|shorten|shorter|expand|polish|translate|extract|compare)\b/i.test(
				message,
			),
	};
}
function followsUp(wording: DocumentWording): boolean {
	return wording.correction || (wording.action && wording.reference);
}
function asksForNewFile(wording: DocumentWording): boolean {
	return wording.newFile && !(wording.inputRef && wording.refine);
}

interface WorkingDocumentSignalState {
	documentFocused: boolean;
	hasRecentUserCorrection: boolean;
	hasContextResetSignal: boolean;
	hasNewGeneratedDocumentRequest: boolean;
	activeDocumentIds: Set<string>;
	correctionTargetIds: Set<string>;
	recentlyRefinedFamilyId: string | null;
	recentlyRefinedArtifactIds: Set<string>;
	currentGeneratedArtifactId: string | null;
	latestGeneratedArtifactIds: string[];
	currentGeneratedReasonCodes: Set<WorkingSetReasonCode>;
}

const LIVE_DOCUMENT_REASON_CODES: WorkingSetReasonCode[] = [
	"attached_this_turn",
	"active_document_focus",
	"recent_user_correction",
	"recently_refined_document_family",
	"current_generated_document",
	"latest_generated_output",
	"matched_current_turn",
];

export interface WorkingDocumentIdentity {
	artifactId: string;
	familyId: string | null;
	reasonCodes: WorkingSetReasonCode[];
	source: "active_focus" | "generated_document";
}

export interface WorkingDocumentWorkingSetCandidateSignals {
	isAttachedThisTurn: boolean;
	isActiveDocumentFocus: boolean;
	isRecentUserCorrection: boolean;
	isRecentlyRefinedDocumentFamily: boolean;
	isCurrentGeneratedDocument: boolean;
	isSelectedCurrentGeneratedDocument: boolean;
}

export interface WorkingDocumentSelection {
	documentFocused: boolean;
	currentDocument: WorkingDocumentIdentity | null;
	latestGeneratedDocumentIds: string[];
	activeFocus: {
		artifactIds: string[];
	};
	correction: {
		hasSignal: boolean;
		targetArtifactIds: string[];
	};
	recentRefinement: {
		familyId: string | null;
		artifactIds: string[];
	};
	reset: {
		hasSignal: boolean;
		suppressCarryover: boolean;
	};
	currentTurnReasonCodesByArtifactId: Map<string, WorkingSetReasonCode[]>;
	prompt: {
		reasonCodesByArtifactId: Map<string, WorkingSetReasonCode[]>;
	};
	workingSet: {
		candidateArtifactIds: string[];
		candidateSignalsByArtifactId: Map<
			string,
			WorkingDocumentWorkingSetCandidateSignals
		>;
	};
	retrieval: {
		preferredArtifactId: string | null;
		preferredGeneratedFamilyId: string | null;
		suppressGeneratedCarryover: boolean;
		hasExplicitResetSignal: boolean;
	};
	taskEvidence: {
		protectedArtifactIds: string[];
		workingDocumentProtectedArtifactIds: string[];
	};
}

export interface ResolveWorkingDocumentSelectionParams {
	artifacts: Artifact[];
	message: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	preferredGeneratedArtifactId?: string | null;
	currentConversationId?: string | null;
	reasonCodesByArtifactId?:
		| ReadonlyMap<string, WorkingSetReasonCode[]>
		| Record<string, WorkingSetReasonCode[]>;
}

function orderedIds(values: Iterable<string | null | undefined>): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		ids.push(value);
	}
	return ids;
}

function isReasonCodeMap(
	source:
		| ReadonlyMap<string, WorkingSetReasonCode[]>
		| Record<string, WorkingSetReasonCode[]>,
): source is ReadonlyMap<string, WorkingSetReasonCode[]> {
	return typeof source.get === "function";
}

function getBaseReasonCodes(
	source:
		| ReadonlyMap<string, WorkingSetReasonCode[]>
		| Record<string, WorkingSetReasonCode[]>
		| undefined,
	artifactId: string,
): WorkingSetReasonCode[] {
	if (!source) return [];
	if (isReasonCodeMap(source)) return source.get(artifactId) ?? [];
	return source[artifactId] ?? [];
}

function getArtifactFamilyId(artifact: Artifact | null): string | null {
	if (!artifact) return null;
	return (
		parseWorkingDocumentMetadata(artifact.metadata).documentFamilyId ?? null
	);
}

function deriveWorkingDocumentReasonCodes(params: {
	artifactId: string;
	reasonCodes: WorkingSetReasonCode[];
	workingDocumentSignalState: WorkingDocumentSignalState;
}): WorkingSetReasonCode[] {
	const nextReasonCodes = new Set(params.reasonCodes);
	for (const code of LIVE_DOCUMENT_REASON_CODES) {
		nextReasonCodes.delete(code);
	}

	if (
		params.workingDocumentSignalState.activeDocumentIds.has(params.artifactId)
	) {
		nextReasonCodes.add("active_document_focus");
	}
	if (
		params.workingDocumentSignalState.correctionTargetIds.has(params.artifactId)
	) {
		nextReasonCodes.add("recent_user_correction");
	}
	if (
		params.workingDocumentSignalState.recentlyRefinedArtifactIds.has(
			params.artifactId,
		)
	) {
		nextReasonCodes.add("recently_refined_document_family");
	}
	if (
		params.workingDocumentSignalState.currentGeneratedArtifactId ===
		params.artifactId
	) {
		for (const code of params.workingDocumentSignalState
			.currentGeneratedReasonCodes) {
			nextReasonCodes.add(code);
		}
	}

	return Array.from(nextReasonCodes);
}

function hasGeneratedDocumentRefinementMetadata(artifact: Artifact): boolean {
	const metadata = parseWorkingDocumentMetadata(artifact.metadata);
	const recentVersionIds = Array.isArray(
		artifact.metadata?.recentGeneratedVersionIds,
	)
		? artifact.metadata.recentGeneratedVersionIds.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			)
		: [];

	return Boolean(
		metadata.documentFamilyId &&
			((metadata.versionNumber ?? 0) > 1 ||
				metadata.supersedesArtifactId ||
				recentVersionIds.length > 0 ||
				(typeof artifact.metadata?.previousGeneratedArtifactId === "string" &&
					artifact.metadata.previousGeneratedArtifactId.trim().length > 0)),
	);
}

function resolveRecentlyRefinedGeneratedFamily(params: {
	artifacts: Artifact[];
	preferredArtifactId?: string | null;
	currentConversationId?: string | null;
}): {
	familyId: string | null;
	latestArtifactIds: string[];
} {
	const allGeneratedArtifacts = params.artifacts
		.filter((artifact) => artifact.type === "generated_output")
		.slice()
		.sort((left, right) => right.updatedAt - left.updatedAt);
	const sameConversationArtifacts = params.currentConversationId
		? allGeneratedArtifacts.filter(
				(artifact) => artifact.conversationId === params.currentConversationId,
			)
		: [];
	const generatedArtifacts =
		sameConversationArtifacts.length > 0
			? sameConversationArtifacts
			: allGeneratedArtifacts;

	const preferredArtifact = params.preferredArtifactId
		? (generatedArtifacts.find(
				(artifact) => artifact.id === params.preferredArtifactId,
			) ?? null)
		: null;
	const preferredMetadata = preferredArtifact
		? parseWorkingDocumentMetadata(preferredArtifact.metadata)
		: null;

	if (
		preferredArtifact &&
		preferredMetadata?.documentFamilyId &&
		hasGeneratedDocumentRefinementMetadata(preferredArtifact)
	) {
		return {
			familyId: preferredMetadata.documentFamilyId,
			latestArtifactIds: [preferredArtifact.id],
		};
	}

	const recentRefinedArtifact =
		generatedArtifacts.find((artifact) =>
			hasGeneratedDocumentRefinementMetadata(artifact),
		) ?? null;
	const recentRefinedMetadata = recentRefinedArtifact
		? parseWorkingDocumentMetadata(recentRefinedArtifact.metadata)
		: null;

	if (!recentRefinedMetadata?.documentFamilyId) {
		return {
			familyId: null,
			latestArtifactIds: [],
		};
	}

	const latestArtifactForFamily =
		generatedArtifacts.find((artifact) => {
			const metadata = parseWorkingDocumentMetadata(artifact.metadata);
			return (
				metadata.documentFamilyId === recentRefinedMetadata.documentFamilyId
			);
		}) ?? null;

	return {
		familyId: recentRefinedMetadata.documentFamilyId,
		latestArtifactIds: latestArtifactForFamily
			? [latestArtifactForFamily.id]
			: [],
	};
}

function buildWorkingDocumentSignalState(params: {
	artifacts: Artifact[];
	message: string;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	preferredGeneratedArtifactId?: string | null;
	currentConversationId?: string | null;
}): WorkingDocumentSignalState {
	// Keep each reading complete: "Update ezt" must not join an English verb to a Hungarian reference.
	const readings = [
		readEnglishWording(params.message),
		readHungarianWording(params.message),
	];
	const hasContextResetSignal = readings.some((w) => w.reset);
	const hasNewGeneratedDocumentRequest = readings.some(asksForNewFile);
	const hasExplicitDocumentInputReference = readings.some((w) => w.inputRef);
	const shouldContinueDocumentState = !hasContextResetSignal;
	const hasRecentUserCorrection = readings.some((w) => w.correction);
	const hasActiveDocument =
		typeof params.activeDocumentArtifactId === "string" &&
		params.activeDocumentArtifactId.trim().length > 0;
	const activeDocumentFocused =
		shouldContinueDocumentState &&
		hasActiveDocument &&
		readings.some((w) => w.focusNoun || followsUp(w)) &&
		(!hasNewGeneratedDocumentRequest || hasExplicitDocumentInputReference);
	const shouldContinueGeneratedDocumentState =
		shouldContinueDocumentState &&
		(!hasNewGeneratedDocumentRequest || activeDocumentFocused);
	const recentRefinedState = shouldContinueGeneratedDocumentState
		? resolveRecentlyRefinedGeneratedFamily({
				artifacts: params.artifacts,
				preferredArtifactId:
					(activeDocumentFocused ? params.activeDocumentArtifactId : null) ??
					params.preferredGeneratedArtifactId ??
					null,
				currentConversationId: params.currentConversationId ?? null,
			})
		: {
				familyId: null,
				latestArtifactIds: [],
			};
	const documentFocused =
		shouldContinueDocumentState &&
		(Boolean(params.attachmentIds?.length) ||
			readings.some((w) => w.focusNoun) ||
			((hasActiveDocument || Boolean(recentRefinedState.familyId)) &&
				readings.some(followsUp)));
	const selection = shouldContinueGeneratedDocumentState
		? resolveCurrentGeneratedDocumentSelection({
				artifacts: params.artifacts,
				preferredArtifactId:
					(activeDocumentFocused ? params.activeDocumentArtifactId : null) ??
					params.preferredGeneratedArtifactId,
				preferredFamilyId: documentFocused ? recentRefinedState.familyId : null,
				query: params.message.trim(),
				currentConversationId: params.currentConversationId ?? null,
				allowFallbackToLatest:
					documentFocused && !hasNewGeneratedDocumentRequest,
			})
		: {
				primaryArtifactId: null,
				latestArtifactIds: [],
				latestArtifacts: [],
				primaryReasonCodes: [],
			};
	const activeDocumentIds = new Set(
		activeDocumentFocused && params.activeDocumentArtifactId
			? [params.activeDocumentArtifactId]
			: [],
	);
	const correctionTargetIds = new Set<string>();
	if (shouldContinueDocumentState && hasRecentUserCorrection) {
		for (const artifactId of activeDocumentIds) {
			correctionTargetIds.add(artifactId);
		}
		if (selection.primaryArtifactId) {
			correctionTargetIds.add(selection.primaryArtifactId);
		}
	}

	return {
		documentFocused,
		hasRecentUserCorrection,
		hasContextResetSignal,
		hasNewGeneratedDocumentRequest,
		activeDocumentIds,
		correctionTargetIds,
		recentlyRefinedFamilyId: recentRefinedState.familyId,
		recentlyRefinedArtifactIds: new Set(recentRefinedState.latestArtifactIds),
		currentGeneratedArtifactId: selection.primaryArtifactId,
		latestGeneratedArtifactIds: selection.latestArtifactIds,
		currentGeneratedReasonCodes: new Set(selection.primaryReasonCodes),
	};
}

export function resolveWorkingDocumentSelection(
	params: ResolveWorkingDocumentSelectionParams,
): WorkingDocumentSelection {
	const attachmentIds = params.attachmentIds ?? [];
	const workingDocumentSignalState = buildWorkingDocumentSignalState({
		artifacts: params.artifacts,
		message: params.message,
		attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		preferredGeneratedArtifactId: params.preferredGeneratedArtifactId,
		currentConversationId: params.currentConversationId,
	});

	const artifactsById = new Map(
		params.artifacts.map((artifact) => [artifact.id, artifact]),
	);
	const activeFocusArtifactIds = orderedIds(
		workingDocumentSignalState.activeDocumentIds,
	);
	const correctionTargetArtifactIds = orderedIds(
		workingDocumentSignalState.correctionTargetIds,
	);
	const recentlyRefinedArtifactIds = orderedIds(
		workingDocumentSignalState.recentlyRefinedArtifactIds,
	);
	const latestGeneratedDocumentIds = orderedIds(
		workingDocumentSignalState.latestGeneratedArtifactIds,
	);
	const currentGeneratedArtifactId =
		workingDocumentSignalState.currentGeneratedArtifactId;
	const reasonCodeArtifactIds = orderedIds([
		...params.artifacts.map((artifact) => artifact.id),
		...activeFocusArtifactIds,
		...correctionTargetArtifactIds,
		...recentlyRefinedArtifactIds,
		currentGeneratedArtifactId,
	]);
	const reasonCodesByArtifactId = new Map<string, WorkingSetReasonCode[]>();
	for (const artifactId of reasonCodeArtifactIds) {
		reasonCodesByArtifactId.set(
			artifactId,
			deriveWorkingDocumentReasonCodes({
				artifactId,
				reasonCodes: getBaseReasonCodes(
					params.reasonCodesByArtifactId,
					artifactId,
				),
				workingDocumentSignalState,
			}),
		);
	}

	const currentArtifactId =
		activeFocusArtifactIds[0] ?? currentGeneratedArtifactId ?? null;
	const currentArtifact = currentArtifactId
		? (artifactsById.get(currentArtifactId) ?? null)
		: null;
	const currentDocument =
		currentArtifactId && !workingDocumentSignalState.hasContextResetSignal
			? {
					artifactId: currentArtifactId,
					familyId: getArtifactFamilyId(currentArtifact),
					reasonCodes: reasonCodesByArtifactId.get(currentArtifactId) ?? [],
					source: activeFocusArtifactIds.includes(currentArtifactId)
						? ("active_focus" as const)
						: ("generated_document" as const),
				}
			: null;

	const candidateArtifactIds = orderedIds([
		...attachmentIds,
		...activeFocusArtifactIds,
		...correctionTargetArtifactIds,
		...recentlyRefinedArtifactIds,
		currentGeneratedArtifactId,
		...latestGeneratedDocumentIds,
	]);
	const candidateSignalsByArtifactId = new Map<
		string,
		WorkingDocumentWorkingSetCandidateSignals
	>();
	for (const artifactId of candidateArtifactIds) {
		candidateSignalsByArtifactId.set(artifactId, {
			isAttachedThisTurn: attachmentIds.includes(artifactId),
			isActiveDocumentFocus:
				workingDocumentSignalState.activeDocumentIds.has(artifactId),
			isRecentUserCorrection:
				workingDocumentSignalState.correctionTargetIds.has(artifactId),
			isRecentlyRefinedDocumentFamily:
				workingDocumentSignalState.recentlyRefinedArtifactIds.has(artifactId),
			isCurrentGeneratedDocument:
				currentGeneratedArtifactId === artifactId &&
				workingDocumentSignalState.currentGeneratedReasonCodes.has(
					"current_generated_document",
				),
			isSelectedCurrentGeneratedDocument:
				currentGeneratedArtifactId === artifactId,
		});
	}

	const workingDocumentProtectedArtifactIds = orderedIds([
		...activeFocusArtifactIds,
		...correctionTargetArtifactIds,
		...recentlyRefinedArtifactIds,
		currentGeneratedArtifactId,
	]);
	const protectedArtifactIds = orderedIds([
		...attachmentIds,
		...workingDocumentProtectedArtifactIds,
	]);

	return {
		documentFocused: workingDocumentSignalState.documentFocused,
		currentDocument,
		latestGeneratedDocumentIds,
		activeFocus: {
			artifactIds: activeFocusArtifactIds,
		},
		correction: {
			hasSignal:
				!workingDocumentSignalState.hasContextResetSignal &&
				workingDocumentSignalState.hasRecentUserCorrection,
			targetArtifactIds: correctionTargetArtifactIds,
		},
		recentRefinement: {
			familyId: workingDocumentSignalState.recentlyRefinedFamilyId,
			artifactIds: recentlyRefinedArtifactIds,
		},
		reset: {
			hasSignal: workingDocumentSignalState.hasContextResetSignal,
			suppressCarryover: workingDocumentSignalState.hasContextResetSignal,
		},
		currentTurnReasonCodesByArtifactId: reasonCodesByArtifactId,
		prompt: {
			reasonCodesByArtifactId,
		},
		workingSet: {
			candidateArtifactIds,
			candidateSignalsByArtifactId,
		},
		retrieval: {
			preferredArtifactId: currentDocument?.artifactId ?? null,
			preferredGeneratedFamilyId:
				workingDocumentSignalState.recentlyRefinedFamilyId,
			suppressGeneratedCarryover:
				workingDocumentSignalState.hasContextResetSignal ||
				workingDocumentSignalState.hasNewGeneratedDocumentRequest,
			hasExplicitResetSignal: workingDocumentSignalState.hasContextResetSignal,
		},
		taskEvidence: {
			protectedArtifactIds,
			workingDocumentProtectedArtifactIds,
		},
	};
}
