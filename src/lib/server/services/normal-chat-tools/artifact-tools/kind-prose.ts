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
// Slides keeps its fragment here, unemitted while advertisedArtifactKinds()
// excludes it, so registering its create handler (Wave 4) is the only thing
// that makes it appear — nobody has to remember a second place to update the
// model-facing text. Canvas registered in Wave 3: its limits are read off the
// board vocabulary (`board-ops.ts`), never re-typed, and the op names live only
// in the `ops` schema the model is shown — prose that listed them a second time
// could drift from it (ruling 62), and the schema already carries them.
import {
	MAX_NEW_NODES_PER_DIFF,
	MAX_OPS_PER_DIFF,
} from "$lib/shared/artifacts/board-ops";
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

/**
 * create_artifact's ONE worked example of a Canvas `body` (the board JSON the
 * `body` field describes) — a frame with two notes inside it and an arrow
 * between them. Exported so a test can feed it to the real create parser
 * (`canvas-model.ts`'s `parseCanvasCreateBody`) and prove it makes a board with
 * nothing refused: what the description shows is what the handler accepts.
 * Child positions are relative to their frame's top-left corner.
 */
export const CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE = {
	nodes: [
		{
			id: "sat",
			type: "frame",
			position: { x: 40, y: 40 },
			data: { kind: "frame", label: "Saturday", width: 300, height: 220 },
		},
		{
			id: "museum",
			type: "sticky",
			parentId: "sat",
			position: { x: 20, y: 60 },
			data: { kind: "sticky", text: "Museum, 10:00", tone: "yellow" },
		},
		{
			id: "lunch",
			type: "sticky",
			parentId: "sat",
			position: { x: 20, y: 150 },
			data: { kind: "sticky", text: "Lunch at the market", tone: "mint" },
		},
	],
	edges: [{ id: "e1", source: "museum", target: "lunch" }],
} as const;

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
	canvas: {
		labelEn: "Canvas",
		labelHu: "Tábla",
		labelHuAccusative: "Táblát",
		createChoiceEn:
			"canvas for a board of notes and frames arranged in space, with arrows between them",
		createChoiceHu:
			"canvas térben elrendezett jegyzetek és keretek táblájához, nyilakkal összekötve",
		useCaseEn: "board",
		useCaseHu: "táblához",
		bodyFormatEn: `Canvas: the board as JSON, e.g. ${JSON.stringify(CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE)} — or {} for an empty board. Edges go in "edges", never in "nodes". A note is 190 wide and 84 tall: leave 10 or more between notes, and make each frame big enough for its notes.`,
		editRuleEn: `Canvas: send ops, one per change to the board, addressing nodes and edges by the ids read_artifact gave (there is no baseHash) — at most ${MAX_OPS_PER_DIFF} ops and ${MAX_NEW_NODES_PER_DIFF} new nodes. A frame goes earlier in the list than what goes inside it. A note is 190 wide and 84 tall: keep notes apart and inside their frame (update_node can enlarge a frame).`,
		editRuleHu: `Tábláknál: küldj ops-ot, a tábla minden módosításához egy műveletet, a blokkokat és nyilakat a read_artifact által adott azonosítókkal címezve (baseHash nincs) — legfeljebb ${MAX_OPS_PER_DIFF} műveletet és ${MAX_NEW_NODES_PER_DIFF} új blokkot. A keret előbb szerepeljen a listában, mint ami benne van. Egy jegyzet 190 széles és 84 magas: tartsd őket távol egymástól és a keretükön belül (az update_node megnagyíthatja a keretet).`,
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
		"Documents and Slides only, one op per block or slide field — each op's exact fields are in this array's own schema. Read the artifact first; baseHash must be the hash you last read.",
	documentOnly:
		"Documents only, one op per block — each op's exact fields are in this array's own schema. Read the artifact first; baseHash must be the hash you last read.",
	slidesOnly:
		"Slides only, one op per slide field — each op's exact fields are in this array's own schema. Read the artifact first; baseHash must be the hash you last read.",
} as const;

/**
 * edit_artifact's ONE worked example (Document, `replaceBlock`) — the exact
 * literal the top-level description shows the model, exported so a test can
 * feed this SAME value to the real validator
 * (`$lib/shared/artifact-document/patch.ts`'s `patchOpInputSchema`) and prove
 * the two can never disagree (a dev incident, 2026-09-26: the model never
 * discovered a valid `op` value from prose alone and burned seven refused
 * edit_artifact calls guessing synonyms before giving up and duplicating the
 * document with create_artifact instead).
 */
export const EDIT_ARTIFACT_DOCUMENT_EXAMPLE = {
	artifactId: "a1",
	patches: [
		{
			op: "replaceBlock",
			blockId: "b3",
			baseHash: "9f2c1a04",
			text: "New text for this block.",
		},
	],
} as const;

/**
 * edit_artifact's ONE worked example for a Canvas: a frame, a note inside it
 * (frame-relative position), an arrow to a note that is already on the board,
 * and a move — the four shapes a model gets wrong when it has only prose (a flat
 * op against a nested `node`/`edge`, a frame's child in board coordinates). It
 * names ids from `sampleBoard()`, the fixture a test lands it on. Exported for
 * the same reason the Document's is: the test feeds `ops` to the executed schema
 * (`boardOpsArraySchema`) and to `validateBoardDiff` and proves nothing is refused.
 */
export const EDIT_ARTIFACT_CANVAS_EXAMPLE = {
	artifactId: "a2",
	ops: [
		{
			op: "add_frame",
			id: "sun",
			label: "Sunday",
			position: { x: 40, y: 480 },
			size: { width: 360, height: 260 },
		},
		{
			op: "add_node",
			node: {
				id: "brunch",
				type: "sticky",
				parentId: "sun",
				position: { x: 20, y: 60 },
				data: { kind: "sticky", text: "Brunch, 10:30", tone: "yellow" },
			},
		},
		{
			op: "add_edge",
			edge: { id: "e2", source: "brunch", target: "note-museum" },
		},
		{ op: "move", id: "note-museum", to: { x: 500, y: 140 } },
	],
	summary: "Planned Sunday",
} as const;

/** edit_artifact's compact worked examples, one per kind that edits in place
 *  and is advertised: the Document's, then the Canvas's. Slides would need its
 *  own once it has a create handler and an op schema of its own. */
export function editArtifactExampleClause(
	kinds: readonly CreatableArtifactKind[],
	lang: "en" | "hu",
): string {
	const examples: string[] = [];
	if (kinds.includes("document")) {
		const json = JSON.stringify(EDIT_ARTIFACT_DOCUMENT_EXAMPLE);
		examples.push(lang === "en" ? `Example: ${json}.` : `Példa: ${json}.`);
	}
	if (kinds.includes("canvas")) {
		const json = JSON.stringify(EDIT_ARTIFACT_CANVAS_EXAMPLE);
		examples.push(
			lang === "en" ? `Canvas example: ${json}.` : `Tábla-példa: ${json}.`,
		);
	}
	return examples.join(" ");
}

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
 *  Canvas is not advertised — ops would have nothing to operate on. Like the
 *  `patches` description it points at the schema, which carries each op's
 *  fields: the words here are only what a schema cannot say. */
export function editArtifactOpsFieldDescription(
	kinds: readonly CreatableArtifactKind[],
): string | undefined {
	if (!kinds.includes("canvas")) return undefined;
	return "Canvas only, one op per change to the board — each op's exact fields are in this array's own schema. Address nodes and edges by the ids read_artifact gave; you choose the id of anything you add.";
}
