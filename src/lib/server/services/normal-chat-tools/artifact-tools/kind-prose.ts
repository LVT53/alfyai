// Per-kind prose fragments for everything that tells the model which
// artifact kinds create_artifact/read_artifact/edit_artifact currently offer
// (Feature 2 · Artifacts). Deciding WHICH kinds are live is
// kind-registry.ts's job (`advertisedArtifactKinds()`, derived from
// CREATE_ARTIFACT_HANDLERS) — this file only holds the words for each kind
// and assembles them for whatever list it is handed, so it never needs the
// heavy artifact-creation machinery create.ts's own handlers pull in (this
// file's only import is a TYPE, erased at compile time — no runtime edge to
// anything). The base prompt's own artifact paragraph (`prompts.ts`) does
// NOT call into this file at request time — it stays a hand-edited literal,
// cross-checked against this file's output by a test — see its own comment
// for why.
//
// Canvas and Slides keep their fragments here, unemitted while
// advertisedArtifactKinds() excludes them, so registering their create
// handler (Wave 3 / Wave 4) is the only thing that makes them appear —
// nobody has to remember a second place to update the model-facing text.
import type { CreatableArtifactKind } from "./kind-registry";

/** No-Oxford-comma list join matching this tool family's existing prose
 *  style: "a" / "a or b" / "a, b or c". */
function joinList(items: readonly string[], connector: string): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0];
	if (items.length === 2) return `${items[0]} ${connector} ${items[1]}`;
	return `${items.slice(0, -1).join(", ")} ${connector} ${items[items.length - 1]}`;
}

export function joinOr(items: readonly string[]): string {
	return joinList(items, "or");
}

function joinVagy(items: readonly string[]): string {
	return joinList(items, "vagy");
}

interface KindCopy {
	labelEn: string;
	labelHu: string;
	/** edit_artifact's opening clause needs Hungarian's accusative case
	 *  ("Dokumentumot", not "Dokumentum") — nowhere else does. */
	labelHuAccusative: string;
	/** create_artifact's "Choose artifactType by what you are keeping" clause. */
	createChoiceEn: string;
	createChoiceHu: string;
	/** create_artifact's opening "Use it for..." example phrase. Slides has
	 *  none in either language — the original prose never named one there,
	 *  and dropping a kind must not invent wording it never had. */
	useCaseEn?: string;
	useCaseHu?: string;
	/** create_artifact's `body` field description (EN only: every field-level
	 *  `.describe()` in this tool family is EN-only; only the top-level
	 *  TOOL_I18N description/errorPrefix are bilingual). */
	bodyFormatEn: string;
	/** edit_artifact's own per-kind rule sentence (used when this kind is not
	 *  part of the document/slides patches merge below). */
	editRuleEn: string;
	editRuleHu: string;
}

const KIND_COPY: Record<CreatableArtifactKind, KindCopy> = {
	document: {
		labelEn: "Document",
		labelHu: "Dokumentum",
		labelHuAccusative: "Dokumentumot",
		createChoiceEn:
			"document for rich text read and edited over time — plans, checklists, itineraries, letters, drafts, trackers",
		createChoiceHu:
			"document gazdag szövegű, idővel olvasott és szerkesztett tartalomhoz — tervek, feladatlisták, útitervek, levelek, vázlatok, nyomkövetők",
		useCaseEn: "checklist, plan, itinerary, letter, draft, tracker",
		useCaseHu:
			"feladatlistához, tervhez, útitervhez, levélhez, vázlathoz, nyomkövetőhöz",
		bodyFormatEn: "Documents: Markdown.",
		editRuleEn:
			"Documents: send patches, one op per block, each with the baseHash you read.",
		editRuleHu:
			"Dokumentumoknál: küldj patches-t, blokkonként egy műveletet, mindegyikhez az általad olvasott baseHash-sel.",
	},
	app: {
		labelEn: "App",
		labelHu: "Alkalmazás",
		labelHuAccusative: "Alkalmazást",
		createChoiceEn:
			"app for an interactive tool with inputs and results — a calculator, splitter, quiz",
		createChoiceHu:
			"app interaktív eszközhöz bemenetekkel és eredményekkel — kalkulátor, költségosztó, kvíz",
		useCaseEn: "small interactive tool",
		useCaseHu: "kis interaktív eszközhöz",
		bodyFormatEn: "Apps: the HTML document.",
		editRuleEn:
			"Apps are not edited here — make a new App with the changes instead.",
		editRuleHu:
			"Az Alkalmazásokat itt nem szerkesztjük — készíts helyette egy új Alkalmazást a változtatásokkal.",
	},
	// Not yet advertised (no create handler registered — see
	// advertisedArtifactKinds() in create.ts). Kept ready for Wave 3.
	canvas: {
		labelEn: "Canvas",
		labelHu: "Tábla",
		labelHuAccusative: "Táblát",
		createChoiceEn:
			"canvas for a board of things arranged in space — frames, notes, arrows, blocks",
		createChoiceHu:
			"canvas térben elrendezett dolgok tábájához — keretek, jegyzetek, nyilak, blokkok",
		useCaseEn: "board",
		useCaseHu: "táblához",
		bodyFormatEn: "Canvas: the board JSON, or empty for a new board.",
		editRuleEn:
			"Canvas: send ops (add_frame, add_node, move, add_edge, remove_edge, update_node, remove_node, highlight), at most 40.",
		editRuleHu:
			"Tábláknál: küldj ops-ot (add_frame, add_node, move, add_edge, remove_edge, update_node, remove_node, highlight), legfeljebb 40-et.",
	},
	// Not yet advertised (no create handler registered — see
	// advertisedArtifactKinds() in create.ts). Kept ready for Wave 4.
	slides: {
		labelEn: "Slides",
		labelHu: "Diasor",
		labelHuAccusative: "Diasort",
		createChoiceEn:
			"slides for a small ordered deck to present, with a beginning and an end",
		createChoiceHu:
			"slides kis, sorrendben bemutatható diasorhoz, elejével és végével",
		bodyFormatEn: "Slides: the deck JSON.",
		editRuleEn:
			"Slides: send patches, one op per slide field, each with the baseHash you read.",
		editRuleHu:
			"Diasoroknál: küldj patches-t, diamezőnként egy műveletet, mindegyikhez az általad olvasott baseHash-sel.",
	},
};

function pick<T>(
	kinds: readonly CreatableArtifactKind[],
	select: (copy: KindCopy) => T | undefined,
): T[] {
	const values: T[] = [];
	for (const kind of kinds) {
		const value = select(KIND_COPY[kind]);
		if (value !== undefined) values.push(value);
	}
	return values;
}

// ── create_artifact ──────────────────────────────────────────────

/** The `artifactType` field's own `.describe()` phrase, e.g. "document or app". */
export function artifactKindEnumPhrase(
	kinds: readonly CreatableArtifactKind[],
): string {
	return joinOr(kinds);
}

/** The opening "Use it for a ... the user keeps working on" example phrase
 *  (EN: "Use it for a ${phrase} ..."; HU: "Használd ${phrase}, ..."). */
export function createArtifactUseCasePhrase(
	kinds: readonly CreatableArtifactKind[],
	lang: "en" | "hu",
): string {
	const items = pick(kinds, (c) => (lang === "en" ? c.useCaseEn : c.useCaseHu));
	return lang === "en" ? joinOr(items) : joinVagy(items);
}

/** The "Choose artifactType by what you are keeping: ..." clause, including
 *  its trailing period. */
export function createArtifactChoiceClause(
	kinds: readonly CreatableArtifactKind[],
	lang: "en" | "hu",
): string {
	const items = pick(kinds, (c) =>
		lang === "en" ? c.createChoiceEn : c.createChoiceHu,
	);
	return `${items.join("; ")}.`;
}

/** The `body` field's own `.describe()` text (EN only). */
export function createArtifactBodyFormat(
	kinds: readonly CreatableArtifactKind[],
): string {
	return pick(kinds, (c) => c.bodyFormatEn).join(" ");
}

// ── kind-name lists (read_artifact, edit_artifact's opening clause, and the
//    base prompt paragraph all name "which kinds exist" the same way) ──────

export function artifactKindListEn(
	kinds: readonly CreatableArtifactKind[],
	options: { withFile?: boolean } = {},
): string {
	const labels = pick(kinds, (c) => c.labelEn);
	return joinOr(options.withFile ? [...labels, "File"] : labels);
}

export function artifactKindListHu(
	kinds: readonly CreatableArtifactKind[],
	options: { withFile?: boolean } = {},
): string {
	const labels = pick(kinds, (c) => c.labelHu);
	return joinVagy(options.withFile ? [...labels, "Fájl"] : labels);
}

/** edit_artifact's own opening clause needs Hungarian's accusative case. */
export function artifactKindListHuAccusative(
	kinds: readonly CreatableArtifactKind[],
): string {
	return joinVagy(pick(kinds, (c) => c.labelHuAccusative));
}

// ── edit_artifact rules (top-level description, and the `patches`/`ops`
//    field descriptions on its advertised schema) ──────────────────────────

const DOCUMENT_AND_SLIDES_MERGED_RULE = {
	en: "Documents and Slides: send patches, one op per block or slide field, each with the baseHash you read.",
	hu: "Dokumentumoknál és Diasoroknál: küldj patches-t, blokkonként vagy diamezőnként egy műveletet, mindegyikhez az általad olvasott baseHash-sel.",
} as const;

/** The edit rules sentence(s): Document and Slides share one merged sentence
 *  when both are advertised (matching the shipped prose), Canvas and App
 *  keep their own independent sentence. Order matches the original text:
 *  the document/slides rule, then canvas, then app. */
export function editArtifactRuleClause(
	kinds: readonly CreatableArtifactKind[],
	lang: "en" | "hu",
): string {
	const has = (kind: CreatableArtifactKind) => kinds.includes(kind);
	const parts: string[] = [];
	if (has("document") && has("slides")) {
		parts.push(DOCUMENT_AND_SLIDES_MERGED_RULE[lang]);
	} else if (has("document")) {
		parts.push(
			lang === "en"
				? KIND_COPY.document.editRuleEn
				: KIND_COPY.document.editRuleHu,
		);
	} else if (has("slides")) {
		parts.push(
			lang === "en" ? KIND_COPY.slides.editRuleEn : KIND_COPY.slides.editRuleHu,
		);
	}
	if (has("canvas")) {
		parts.push(
			lang === "en" ? KIND_COPY.canvas.editRuleEn : KIND_COPY.canvas.editRuleHu,
		);
	}
	if (has("app")) {
		parts.push(
			lang === "en" ? KIND_COPY.app.editRuleEn : KIND_COPY.app.editRuleHu,
		);
	}
	return parts.join(" ");
}

const PATCHES_FIELD_DESCRIPTION = {
	documentAndSlides:
		"Documents and Slides only: [{op, blockId|slideId, fieldId, baseHash, text}]. Read the artifact first; baseHash must be the hash you last read.",
	documentOnly:
		"Documents only: [{op, blockId, baseHash, text}]. Read the artifact first; baseHash must be the hash you last read.",
	slidesOnly:
		"Slides only: [{op, slideId, fieldId, baseHash, text}]. Read the artifact first; baseHash must be the hash you last read.",
} as const;

/** edit_artifact's `patches` field description (EN only), or undefined when
 *  neither Document nor Slides is advertised — patches would have nothing to
 *  patch. */
export function editArtifactPatchesFieldDescription(
	kinds: readonly CreatableArtifactKind[],
): string | undefined {
	const documentAdvertised = kinds.includes("document");
	const slidesAdvertised = kinds.includes("slides");
	if (documentAdvertised && slidesAdvertised)
		return PATCHES_FIELD_DESCRIPTION.documentAndSlides;
	if (documentAdvertised) return PATCHES_FIELD_DESCRIPTION.documentOnly;
	if (slidesAdvertised) return PATCHES_FIELD_DESCRIPTION.slidesOnly;
	return undefined;
}

/** edit_artifact's `ops` field description (EN only), or undefined while
 *  Canvas is not advertised — ops would have nothing to operate on. */
export function editArtifactOpsFieldDescription(
	kinds: readonly CreatableArtifactKind[],
): string | undefined {
	if (!kinds.includes("canvas")) return undefined;
	return "Canvas only: [{op:'add_frame'|'add_node'|'move'|'add_edge'|'remove_edge'|'update_node'|'remove_node'|'highlight', ...}], at most 40.";
}
