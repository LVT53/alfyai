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
import {
	CHECKLIST_BASE_HEIGHT,
	CHECKLIST_ROW_HEIGHT,
	charsPerLine,
	defaultNodeWidth,
	estimatedNodeHeight,
	NODE_WIDTH,
	NOTE_LINE_HEIGHT,
	NOTE_MIN_HEIGHT,
} from "$lib/shared/artifacts/canvas-blocks";
import type { CreatableArtifactKind } from "./kind-registry";

/**
 * The sizes of what a model adds to a board, said the way the panel draws them
 * (RV-3 C2, RC-3 N1): a block is `NODE_WIDTH` wide unless its kind has a width of
 * its own (the app stores that width when it adds one: a checklist's rows and a
 * chart's plot need more than a note's), and only a frame has a height of its
 * own — a note is as tall as its words, a checklist as its items, a chart as its
 * plot (a square one for a pie, a doughnut, a radar or a polar area chart, so
 * taller). Built from the constants and the estimate the read, the eval and the
 * board share, so the sentence cannot drift from what is drawn.
 */
const CHECKLIST_WIDTH = defaultNodeWidth("checklist");
const CHART_WIDTH = defaultNodeWidth("chart");
const chartHeightOf = (type: string): number =>
	estimatedNodeHeight({
		type: "chart",
		data: { kind: "chart", code: JSON.stringify({ type, data: {} }) },
	});
const CHART_HEIGHT = chartHeightOf("bar");
const ROUND_CHART_HEIGHT = chartHeightOf("pie");
const DIAGRAM_WIDTH = defaultNodeWidth("mermaid");
const SIZE_FACTS = `a block you add is ${NODE_WIDTH} wide (a checklist ${CHECKLIST_WIDTH}, a chart ${CHART_WIDTH}, a diagram ${DIAGRAM_WIDTH}, a frame the size you give it); a note is ${NOTE_MIN_HEIGHT} tall for up to two lines (about ${charsPerLine()} characters a line), plus ${NOTE_LINE_HEIGHT} for each further line; a checklist is ${CHECKLIST_BASE_HEIGHT} plus ${CHECKLIST_ROW_HEIGHT} an item; a chart is ${CHART_HEIGHT} tall (${ROUND_CHART_HEIGHT} for a pie, doughnut, radar or polar chart)`;

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
			data: { kind: "frame", label: "Saturday", width: 300, height: 240 },
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
	label: string;
	/** create_artifact's "Choose artifactType by what you are keeping" clause. */
	createChoice: string;
	/** create_artifact's opening "Use it for..." example phrase. Slides has
	 *  none — the original prose never named one there, and dropping a kind
	 *  must not invent wording it never had. */
	useCase?: string;
	/** create_artifact's `body` field description. */
	bodyFormat: string;
	/** edit_artifact's own per-kind rule sentence (used when this kind is not
	 *  part of the document/slides patches merge below). */
	editRule: string;
}

const KIND_COPY: Record<CreatableArtifactKind, KindCopy> = {
	document: {
		label: "Document",
		createChoice:
			"document for rich text read and edited over time — plans, checklists, itineraries, letters, drafts, trackers",
		useCase: "checklist, plan, itinerary, letter, draft, tracker",
		bodyFormat: "Documents: Markdown.",
		editRule:
			"Documents: send patches, one op per block, each with the baseHash you read.",
	},
	app: {
		label: "App",
		createChoice:
			"app for an interactive tool with inputs and results — a calculator, splitter, quiz",
		useCase: "small interactive tool",
		bodyFormat:
			"Apps: a brief of what the app is for and does, in the user's words — never HTML (the app is built from it).",
		editRule:
			"Apps: send instruction — what to change, in one call (no read first); the whole App is rebuilt before the call returns.",
	},
	canvas: {
		label: "Canvas",
		createChoice:
			"canvas for a board of notes and frames arranged in space, with arrows between them",
		useCase: "board",
		bodyFormat: `Canvas: the board as JSON, e.g. ${JSON.stringify(CREATE_ARTIFACT_CANVAS_BODY_EXAMPLE)} — or {} for an empty board. Edges go in "edges", never in "nodes". Sizes: ${SIZE_FACTS}. Leave 10 or more between blocks, and make each frame big enough for its blocks; or leave a block's position out and it is placed in its parentId frame's next free place (the frame grows to fit).`,
		editRule: `Canvas: send ops, one per change to the board, addressing nodes and edges by the ids read_artifact gave (there is no baseHash) — at most ${MAX_OPS_PER_DIFF} ops and ${MAX_NEW_NODES_PER_DIFF} new nodes. A frame goes earlier in the list than what goes inside it. Sizes: ${SIZE_FACTS}. Leave position out and the block is placed for you (beside near, else in its parentId frame, else on free ground); a position you give is kept if free, else moved. A block's kind cannot change: remove it and add a new one.`,
	},
	// Not yet advertised (no create handler registered — see
	// advertisedArtifactKinds() in create.ts). Kept ready for Wave 4.
	slides: {
		label: "Slides",
		createChoice:
			"slides for a small ordered deck to present, with a beginning and an end",
		bodyFormat: "Slides: the deck JSON.",
		editRule:
			"Slides: send patches, one op per slide field, each with the baseHash you read.",
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
 *  ("Use it for a ${phrase} ..."). */
export function createArtifactUseCasePhrase(
	kinds: readonly CreatableArtifactKind[],
): string {
	return joinOr(pick(kinds, (c) => c.useCase));
}

/** The "Choose artifactType by what you are keeping: ..." clause, including
 *  its trailing period. */
export function createArtifactChoiceClause(
	kinds: readonly CreatableArtifactKind[],
): string {
	return `${pick(kinds, (c) => c.createChoice).join("; ")}.`;
}

/** The `body` field's own `.describe()` text. */
export function createArtifactBodyFormat(
	kinds: readonly CreatableArtifactKind[],
): string {
	return pick(kinds, (c) => c.bodyFormat).join(" ");
}

// ── kind-name lists (read_artifact, edit_artifact's opening clause, and the
//    base prompt paragraph all name "which kinds exist" the same way) ──────

export function artifactKindListEn(
	kinds: readonly CreatableArtifactKind[],
	options: { withFile?: boolean } = {},
): string {
	const labels = pick(kinds, (c) => c.label);
	return joinOr(options.withFile ? [...labels, "File"] : labels);
}

// ── edit_artifact rules (top-level description, and the `patches`/`ops`
//    field descriptions on its advertised schema) ──────────────────────────

const DOCUMENT_AND_SLIDES_MERGED_RULE =
	"Documents and Slides: send patches, one op per block or slide field, each with the baseHash you read.";

/** The edit rules sentence(s): Document and Slides share one merged sentence
 *  when both are advertised (matching the shipped prose), Canvas and App
 *  keep their own independent sentence. Order matches the original text:
 *  the document/slides rule, then canvas, then app. */
export function editArtifactRuleClause(
	kinds: readonly CreatableArtifactKind[],
): string {
	const has = (kind: CreatableArtifactKind) => kinds.includes(kind);
	const parts: string[] = [];
	if (has("document") && has("slides")) {
		parts.push(DOCUMENT_AND_SLIDES_MERGED_RULE);
	} else if (has("document")) {
		parts.push(KIND_COPY.document.editRule);
	} else if (has("slides")) {
		parts.push(KIND_COPY.slides.editRule);
	}
	if (has("canvas")) parts.push(KIND_COPY.canvas.editRule);
	if (has("app")) parts.push(KIND_COPY.app.editRule);
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

/**
 * edit_artifact's ONE worked example for an App (F2, ruling 77): an App is
 * changed by saying what to change, and the whole App is rebuilt from the
 * current one (`regenerateApp`, the same function the panel's "Change this app"
 * runs). Exported for the same reason the others are: the test feeds this value
 * to the executed schema (`editArtifactInputSchema`) and to the advertised one.
 */
export const EDIT_ARTIFACT_APP_EXAMPLE = {
	artifactId: "a3",
	instruction: "Add a Reset button.",
} as const;

/** edit_artifact's compact worked examples, one per kind that edits in place
 *  and is advertised: the Document's, the Canvas's, then the App's. Slides would
 *  need its own once it has a create handler and an op schema of its own. */
export function editArtifactExampleClause(
	kinds: readonly CreatableArtifactKind[],
): string {
	const examples: string[] = [];
	if (kinds.includes("document")) {
		examples.push(
			`Example: ${JSON.stringify(EDIT_ARTIFACT_DOCUMENT_EXAMPLE)}.`,
		);
	}
	if (kinds.includes("canvas")) {
		examples.push(
			`Canvas example: ${JSON.stringify(EDIT_ARTIFACT_CANVAS_EXAMPLE)}.`,
		);
	}
	if (kinds.includes("app")) {
		examples.push(`App example: ${JSON.stringify(EDIT_ARTIFACT_APP_EXAMPLE)}.`);
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

/** edit_artifact's `instruction` field description (EN only), or undefined while
 *  no App can be made: it is the App's one field, and says what the call is. */
export function editArtifactInstructionFieldDescription(
	kinds: readonly CreatableArtifactKind[],
): string | undefined {
	if (!kinds.includes("app")) return undefined;
	return "Apps only: what to change, in the user's own words (never HTML) — the App is rebuilt from the current one and this.";
}
