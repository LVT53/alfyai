// Atlas v3's language standard (ADR 0063).
//
// v2 translated its writer prompt into Hungarian and called that
// multilingual support. The result was officialese: a tautological opener
// ("the change in the 2026 minimum wage against the 2025 base determines the
// size of the annual rise"), nominalised civil-service register, section
// titles that read like database labels, and hungarian.hr-portal aggregators
// cited where the Magyar Közlöny was the actual source.
//
// A language standard is three separable things, and this module owns all
// three:
//
//   1. REGISTER rules the writer is given and the critic checks;
//   2. NATIVE PRIMARY SOURCES for the jurisdictions a question is about,
//      which the source tiering promotes; and
//   3. deterministic REGISTER PROBES, so the cheap failures (a tautological
//      opener, a label-shaped title) are caught without a model call.

import type { SupportedLanguage } from "$lib/server/services/language";

// ---------------------------------------------------------------------------
// 1. Register rules
// ---------------------------------------------------------------------------

export interface AtlasV3LanguageStandard {
	/** Appended to the writer's system prompt. */
	writerAddendum: string;
	/** Appended to the critic's system prompt. */
	criticAddendum: string;
}

export const ATLAS_V3_LANGUAGE_STANDARDS: Record<
	SupportedLanguage,
	AtlasV3LanguageStandard
> = {
	en: {
		writerAddendum: [
			"REGISTER (English):",
			'- Open a section with a claim, never with a topic. "Shipping is not one cycle" is a claim; "This section examines the shipping cycle" is not.',
			'- Prefer verbs to nominalisations: "prices fell 4%", not "a decline in prices was observed".',
			'- A section title names the finding or the decision, never a data label. "Rooftop demand fell, utility-scale grew", not "2025 reference data".',
			"- No sentence may restate its own subject as its own predicate.",
			'- Date every volatile figure inline, in one clause: "38.7% (as of February 2026)".',
			"- No blanket hedges. Uncertainty is attached to a specific claim with a reason and what would resolve it.",
		].join("\n"),
		criticAddendum: [
			'REGISTER CHECKS (English): flag a topic-sentence opener, a nominalised passive where a verb would do, a tautological sentence, a label-shaped section title, an undated volatile figure, and any blanket hedge ("results may vary", "further research is needed").',
		].join("\n"),
	},
	hu: {
		writerAddendum: [
			"REGISZTER (magyar):",
			"- A szakasz ÁLLÍTÁSSAL kezdődik, ne témamegjelöléssel. „A lakossági kereslet esett, a nagyerőművi nőtt” állítás; „Ez a szakasz a keresletet vizsgálja” nem az.",
			"- Kerüld a hivatali nominalizációt: „az árak 4%-kal estek”, ne „az árak csökkenése volt megfigyelhető”. Kerüld a „kerül sor”, „történik meg”, „valósul meg”, „biztosításra kerül” szerkezeteket.",
			"- Tilos a tautológia: egy mondat alanya nem lehet a saját állítmánya („a változás határozza meg a változás mértékét”).",
			"- A szakaszcím a megállapítást nevezi meg, ne adatbázis-címkét: „A minimálbér 2026-ban 16%-kal nő”, ne „2025-ös referenciaadat”.",
			"- Minden változékony számhoz tartozzon dátum, egyetlen tagmondatban: „38,7% (2026. februári adat)”.",
			"- Magyar helyesírás szerinti számformátum: tizedesvessző, ezres szóköz (65,1 GW; 1 200 000 Ft).",
			"- Elsődleges magyar forrásokat használj, ha van: KSH, Magyar Közlöny / njt.hu, minisztériumi közlemény, MNB. Hírportál- és tanácsadói összefoglaló csak akkor, ha az elsődleges forrás nem elérhető.",
			"- Semmilyen általános mentegetőzés („további vizsgálat szükséges”); a bizonytalanság konkrét állításhoz kötődik, okkal.",
		].join("\n"),
		criticAddendum: [
			"REGISZTER-ELLENŐRZÉS (magyar): jelezd a témamegjelölő nyitómondatot, a hivatali nominalizációt („kerül sor”, „megvalósításra kerül”, „megfigyelhető volt”), a tautológiát, az adatbázis-címke jellegű szakaszcímet, a dátum nélküli változékony számot, az általános mentegetőzést, és azt, ha másodlagos hírportál szerepel ott, ahol magyar elsődleges forrás (KSH, Magyar Közlöny, njt.hu, minisztérium, MNB) elérhető lett volna.",
		].join("\n"),
	},
};

/**
 * The writer/critic addendum for a language. The Hungarian standard is behind
 * `ATLAS_V3_LANGUAGE_STANDARD_HU` (on by default) so it can be turned off on a
 * deployment that finds it over-constrains the local model, without turning off
 * Hungarian reports.
 */
export function atlasV3LanguageStandard(input: {
	language: SupportedLanguage;
	hungarianEnabled?: boolean;
}): AtlasV3LanguageStandard | null {
	if (input.language === "hu" && input.hungarianEnabled === false) return null;
	return ATLAS_V3_LANGUAGE_STANDARDS[input.language] ?? null;
}

// ---------------------------------------------------------------------------
// 2. Native primary sources
// ---------------------------------------------------------------------------

/**
 * Jurisdictions whose own institutions outrank international coverage of the
 * same question. Keyed by a short region id; `hostSuffixes` are matched as
 * host suffixes so `www.ksh.hu` and `statinfo.ksh.hu` both hit.
 *
 * These promote a source to `primary` in the tiering (source-tier.ts) and are
 * named in the researcher's prompt so its searches reach for them.
 */
export interface AtlasV3NativeSourceSet {
	region: string;
	/** Words in the request that suggest the question is about this place. */
	cues: readonly string[];
	hostSuffixes: readonly string[];
	/** Named in the researcher prompt, so searches reach for them. */
	preferredNames: readonly string[];
}

export const ATLAS_V3_NATIVE_SOURCES: readonly AtlasV3NativeSourceSet[] = [
	{
		region: "hu",
		cues: [
			"hungary",
			"hungarian",
			"budapest",
			"magyar",
			"magyarország",
			"forint",
			"huf",
		],
		hostSuffixes: [
			"ksh.hu",
			"njt.hu",
			"magyarkozlony.hu",
			"kozlonyok.hu",
			"mnb.hu",
			"kormany.hu",
			"nav.gov.hu",
			"oep.hu",
			"neak.gov.hu",
			"met.hu",
			"mekh.hu",
			"nkfih.gov.hu",
			"parlament.hu",
		],
		preferredNames: [
			"KSH",
			"Magyar Közlöny",
			"njt.hu",
			"MNB",
			"kormany.hu",
			"NAV",
		],
	},
	{
		region: "ie",
		cues: ["ireland", "irish", "dublin", "éire"],
		hostSuffixes: [
			"cso.ie",
			"gov.ie",
			"oireachtas.ie",
			"revenue.ie",
			"centralbank.ie",
			"citizensinformation.ie",
			"npws.ie",
			"epa.ie",
			"seai.ie",
		],
		preferredNames: [
			"CSO",
			"gov.ie",
			"Oireachtas",
			"Revenue",
			"Central Bank of Ireland",
		],
	},
	{
		region: "nl",
		cues: ["netherlands", "dutch", "nederland", "amsterdam", "holland"],
		hostSuffixes: [
			"cbs.nl",
			"rijksoverheid.nl",
			"overheid.nl",
			"tweedekamer.nl",
			"dnb.nl",
			"belastingdienst.nl",
			"rvo.nl",
		],
		preferredNames: [
			"CBS",
			"rijksoverheid.nl",
			"Tweede Kamer",
			"DNB",
			"Belastingdienst",
		],
	},
];

/** The jurisdictions a request mentions, best guess, deterministic. */
export function atlasV3NativeSourcesForRequest(input: {
	query: string;
	language: SupportedLanguage;
}): AtlasV3NativeSourceSet[] {
	const haystack = input.query.toLowerCase();
	const matched = ATLAS_V3_NATIVE_SOURCES.filter((entry) =>
		entry.cues.some((cue) => haystack.includes(cue)),
	);
	// A Hungarian-language request is about Hungary unless it says otherwise:
	// the v2 minimum-wage report was written in Hungarian and cited four
	// aggregators because nothing pointed it at the Magyar Közlöny.
	if (
		input.language === "hu" &&
		!matched.some((entry) => entry.region === "hu")
	) {
		const hungarian = ATLAS_V3_NATIVE_SOURCES.find(
			(entry) => entry.region === "hu",
		);
		if (hungarian) matched.unshift(hungarian);
	}
	return matched;
}

/** True when the host is a native primary source for one of these regions. */
export function isAtlasV3NativePrimaryHost(
	host: string,
	sets: readonly AtlasV3NativeSourceSet[],
): boolean {
	const normalized = host.toLowerCase().replace(/\.$/, "");
	return sets.some((set) =>
		set.hostSuffixes.some(
			(suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
		),
	);
}

// ---------------------------------------------------------------------------
// 3. Deterministic register probes
// ---------------------------------------------------------------------------

/** Hungarian civil-service constructions that carry no information. */
const HU_OFFICIALESE = [
	/\bkerül\s+sor\b/iu,
	/\b\w+ra\s+kerül\b/iu,
	/\b\w+re\s+kerül\b/iu,
	/\bmegvalósításra\b/iu,
	/\bbiztosításra\b/iu,
	/\bmegfigyelhető\s+volt\b/iu,
	/\bvégrehajtásra\b/iu,
];

const EN_HOLLOW = [
	/\bthis\s+(section|report|analysis)\s+(examines|explores|discusses|reviews)\b/iu,
	/\bresults?\s+(may|could)\s+vary\b/iu,
	/\bfurther\s+research\s+is\s+needed\b/iu,
	/\bit\s+(is|may be)\s+(worth noting|argued)\b/iu,
	/\bplays?\s+a\s+(key|critical|crucial|significant)\s+role\b/iu,
	/\b(highlights?|reveals?|underscores?)\s+(a\s+)?(clear\s+)?(trade-?off|difference|significant)\b/iu,
];

const HU_HOLLOW = [
	/\bez\s+a\s+(szakasz|fejezet|jelentés)\s+\w*(vizsgálja|mutatja be|tárgyalja)\b/iu,
	/\btovábbi\s+(vizsgálat|kutatás)\s+szükséges\b/iu,
	/\bfontos\s+szerepet\s+játszik\b/iu,
	/\bmeghatározó\s+jelentőségű\b/iu,
];

/**
 * A sentence whose subject noun is repeated as its own object/predicate: "a
 * változás ... a változás mértékét", "the change determines the change". Word
 * stems of five characters or more, so short function words never trip it.
 */
export function isTautologicalSentence(text: string): boolean {
	const words = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((word) => word.length >= 6);
	if (words.length < 4) return false;
	const stems = words.map((word) => word.slice(0, 6));
	const seen = new Map<string, number>();
	for (const stem of stems) {
		const count = (seen.get(stem) ?? 0) + 1;
		if (count >= 2) return true;
		seen.set(stem, count);
	}
	return false;
}

/** A section title that names a data label rather than a finding. */
export function isLabelShapedTitle(title: string): boolean {
	const normalized = title.replace(/\s+/g, " ").trim();
	if (!normalized) return true;
	// No verb, three words or fewer, or a bare year/data label.
	if (/^\d{4}(-(e|a)s)?\b/u.test(normalized)) return true;
	if (/^(reference|referencia)\b/iu.test(normalized)) return true;
	// `entity — metric`: a spaced dash joining two noun phrases. This is what the
	// deterministic outline used to mint and what the staging reports shipped
	// eight times ("providers — compliance deadline for pre-2025 models"). The
	// sentence-shaped replacement uses a COLON — "Commission: enforcement powers
	// entry into application 2 August 2026" — so a colon exempts a title.
	if (/\s[—–-]\s/u.test(normalized) && !normalized.includes(":")) return true;
	return false;
}

export interface AtlasV3RegisterProbe {
	code: "hollow" | "officialese" | "tautology";
	detail: string;
}

/** Cheap, deterministic register defects in one sentence. No model call. */
export function probeAtlasV3Register(input: {
	text: string;
	language: SupportedLanguage;
}): AtlasV3RegisterProbe[] {
	const probes: AtlasV3RegisterProbe[] = [];
	const hollow = input.language === "hu" ? HU_HOLLOW : EN_HOLLOW;
	for (const pattern of hollow) {
		if (pattern.test(input.text)) {
			probes.push({
				code: "hollow",
				detail: "the sentence states no fact a reader could act on",
			});
			break;
		}
	}
	if (input.language === "hu") {
		for (const pattern of HU_OFFICIALESE) {
			if (pattern.test(input.text)) {
				probes.push({
					code: "officialese",
					detail: "nominalised civil-service construction",
				});
				break;
			}
		}
	}
	if (isTautologicalSentence(input.text)) {
		probes.push({
			code: "tautology",
			detail: "the sentence restates its own subject as its predicate",
		});
	}
	return probes;
}
