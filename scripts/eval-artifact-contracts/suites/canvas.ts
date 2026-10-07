// The `canvas` eval suite (Feature 2 · Artifacts, Slice 3, Task T10 — decisions.md
// rulings 44, 59, 62). Can the real model hold the Canvas contract: read a board
// through `read_artifact`, change it with `edit_artifact` ops, and make one with
// `create_artifact`, when all it has is what the app tells it?
//
// WHAT IS CALLED. Each case is a real request sent THROUGH THE REAL TOOLS
// (ruling 62): the whole catalogue exactly as a chat turn sends it (`tool-path.ts`
// reads the app's frozen snapshot), `tool_choice: auto`, the real base system
// prompt with the turn's required-language sentence. An edit case also carries
// the artifact catalogue block the app appends to the user's message, and when
// the model reads the board it is handed the REAL `read_artifact` payload
// (`canvasReadBlocks`, the module the tool itself calls). The answer to score is
// the `edit_artifact` or `create_artifact` call the model makes.
//
// WHAT IS SCORED, automatically (slice-5.md's rubric for suite 3), against the
// board the call would leave, by the SAME code the app runs:
//   - the call: routing (did it edit the board it was shown, or make a new one),
//     arguments;
//   - every diff parses (`boardOpsArraySchema`), and lands: any refusal from
//     `validateBoardDiff` is a miss, `invalid_data` and `cycle` above all;
//   - every requested item is on the board (per-fixture);
//   - ids resolve (a refusal `unknown_id` says they did not);
//   - nothing is outside the frame it belongs to; no two nodes overlap;
//   - labels are non-empty; nothing was removed that the request did not name;
//   - the new words are in the fixture's DECLARED language (ruling 65).
// A create is judged through `parseCanvasCreateBody`, the tool's own parse.
// Every reason starts with the check that found it (`routing:`, `tool-args:`,
// `schema:`, `refusal:`, `request:`, `frames:`, `overlap:`, `labels:`,
// `removed:`, `language:`, `diagram:`, `note:`, `ok:`) so a run's results can be
// counted by kind without parsing prose. `diagram:` is the one check that needs an
// await (can the chat's own Mermaid read the source?), so it is read from the
// suite's evaluation (`canvas-diagrams.ts`), never run here.
//
// The known-bad answers are hand-written and served from disk (ruling 59).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALFYAI_NEMOTRON_PROMPT } from "$lib/server/prompts";
import { classifyLanguageSignal } from "$lib/server/services/language";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import { normalizeCanvasBody } from "$lib/shared/artifacts/canvas-body";
import { plannedNodeSize } from "$lib/shared/artifacts/node-size";
import { parseJsonLenient } from "$lib/utils/lenient-json";
import {
	decodeToolPathResponse,
	type ToolPathEnvelope,
	type ToolPathLanguage,
	type ToolPathRequestSpec,
	type ToolSuite,
} from "../tool-path";
import type { EvalCase, EvalScoreResult, SuiteScorer } from "../types";
import { diagramVerdict } from "./canvas-diagrams";
import { createCanvasTools } from "./canvas-tools";

// ── fixtures ─────────────────────────────────────────────────────────────

interface CanvasFixture {
	id: string;
	description: string;
	/** The language the request is asked in, and the board's new words must be written in (ruling 65). */
	language: ToolPathLanguage;
	kind: "edit" | "create";
	/** edit: the stored board the request is about (a file under `fixtures/canvas/boards/`). */
	board?: string;
	artifactId?: string;
	title?: string;
	request: string;
}

// dirname(fileURLToPath(import.meta.url)): see run.ts's note on Vite-loaded code.
const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"canvas",
);

function loadFixture(name: string): CanvasFixture {
	return JSON.parse(
		readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8"),
	) as CanvasFixture;
}

const boardCache = new Map<string, CanvasBody>();

/** A fixture board as the app would hold it: read without trust, and refused if anything had to be left out. */
export function loadFixtureBoard(name: string): CanvasBody {
	const cached = boardCache.get(name);
	if (cached) return structuredClone(cached);
	const raw = JSON.parse(
		readFileSync(join(FIXTURES_DIR, "boards", `${name}.json`), "utf8"),
	);
	const { body, dropped } = normalizeCanvasBody(raw);
	if (dropped.nodes.length + dropped.edges.length > 0) {
		throw new Error(
			`fixture board ${name} is not a valid board: dropped ${[...dropped.nodes, ...dropped.edges].join(", ")}`,
		);
	}
	boardCache.set(name, body);
	return structuredClone(body);
}

const FIXTURE_NAMES = [
	"arrange-saturday",
	"add-sunday",
	"remove-and-connect",
	"add-sunday-hu",
	"create-vienna-en",
	"create-vienna-hu",
	// Wave 4 (CV-A, ruling 74): what is added to a board that already has things
	// on it — one note beside another, a chart in a frame that is full, and the
	// owner's flowchart — each in both languages.
	"add-note-beside",
	"add-note-beside-hu",
	"chart-in-frame",
	"chart-in-frame-hu",
	"add-flowchart",
	"add-flowchart-hu",
] as const;
const FIXTURES = FIXTURE_NAMES.map(loadFixture);

const fixtureByCaseId = new Map<string, CanvasFixture>();

// ── the request a case sends ─────────────────────────────────────────────

/**
 * The catalogue block the app appends to the user's message for a conversation
 * that has made a board — `buildArtifactCatalogueBlock`'s exact output for one
 * entry "updated 2 min ago" (a test keeps the two in step; this file cannot
 * import that module, which reaches the database).
 */
export function artifactCatalogueBlockFor(fixture: CanvasFixture): string {
	return [
		"## In this chat",
		`- ${fixture.artifactId} · Canvas · "${fixture.title}" (updated 2 min ago)`,
		"",
		"Use read_artifact to see one before editing it. Never invent an id.",
	].join("\n");
}

/** What the user's message carries: the request, and for an edit the catalogue the app appends after it. */
export function userMessage(fixture: CanvasFixture): string {
	return fixture.kind === "edit"
		? `${fixture.request}\n\n## Turn Guidance\n${artifactCatalogueBlockFor(fixture)}`
		: fixture.request;
}

const REAL_CASES: EvalCase[] = FIXTURES.map((fixture) => {
	const evalCase: EvalCase = {
		id: `canvas-${fixture.id}`,
		suite: "canvas",
		description: fixture.description,
		prompt: userMessage(fixture),
		language: fixture.language,
		thinking: "off",
	};
	fixtureByCaseId.set(evalCase.id, fixture);
	return evalCase;
});

/**
 * The known-bad answers slice-5.md names for the canvas ("a diff that leaves two
 * nodes overlapping; a diff that moves a node out of its frame"), plus the two
 * the contract's other checks need to be seen failing: an op the vocabulary does
 * not have, and a removal the request did not ask for. Each is a hand-written
 * response under `fixtures/canvas/responses/`, and each request is the one it
 * answers.
 */
const KNOWN_BAD: Array<{ id: string; fixture: string; description: string }> = [
	{
		id: "canvas-known-bad-overlap",
		fixture: "arrange-saturday",
		description:
			"A diff that leaves two notes piled on each other — must score bad, proving the overlap check can fail.",
	},
	{
		id: "canvas-known-bad-out-of-frame",
		fixture: "arrange-saturday",
		description:
			"A diff that moves a note out of its frame — must score bad, proving the frame check can fail.",
	},
	{
		id: "canvas-known-bad-invented-op",
		fixture: "remove-and-connect",
		description:
			"A diff with an op the vocabulary does not have — must score bad, proving the parse check can fail.",
	},
	{
		id: "canvas-known-bad-removes-more",
		fixture: "remove-and-connect",
		description:
			"A diff that removes a note the request never named — must score bad, proving the removal check can fail.",
	},
];

const KNOWN_BAD_CASES: EvalCase[] = KNOWN_BAD.map((entry) => {
	const fixture = loadFixture(entry.fixture);
	const evalCase: EvalCase = {
		id: entry.id,
		suite: "canvas",
		description: entry.description,
		// Unique on purpose: the live runner tells a known-bad case from a real one
		// by its prompt, and serves it from disk instead of asking a model.
		prompt: `[known-bad ${entry.id}: a recorded answer, never sent to a model]\n${userMessage(fixture)}`,
		knownBad: true,
		language: fixture.language,
		thinking: "off",
	};
	fixtureByCaseId.set(evalCase.id, fixture);
	return evalCase;
});

export const CANVAS_EVAL_CASES: EvalCase[] = [
	...REAL_CASES,
	...KNOWN_BAD_CASES,
];

/**
 * The system prompt of a case: the real base prompt, then the turn's
 * required-language sentence exactly as `buildResponseLanguageGuard`
 * (`normal-chat-context.ts`) writes its first two bullets — a test keeps the two
 * in step. The rest of a real turn's system content (date, memory) is left out:
 * nothing in it bears on a board.
 */
export function canvasSystemPrompt(language: ToolPathLanguage): string {
	const label = language === "hu" ? "Hungarian" : "English";
	return [
		ALFYAI_NEMOTRON_PROMPT,
		"",
		"Response language policy:",
		`- Required response language for this turn: ${label}.`,
		`- Otherwise, you MUST respond in ${label}. This is a hard requirement. Only switch language if the user explicitly asks you to.`,
	].join("\n");
}

// A lookup the app answers and the model goes on from: an empty or failed one,
// carrying no fact a board could use (the same stubs, for the same reason, as the
// slides suite's first live runs found necessary).
const LOOKUP_STUBS: Record<string, string> = {
	image_search: "No images were found.",
	research_web: "The search failed and returned no results.",
	fetch_url: "The page could not be fetched.",
	read_generated_file: "No matching file was found.",
	files: "No matching file was found.",
	// Seen in the first live runs of "arrange the Saturday notes": the model checks
	// its spacing with a script, or looks a place up. The app answers both and the
	// model goes on; ending the conversation there measured the app's answer, not the model.
	run_python: "The code could not be run.",
	map_route: "No place or route was found.",
};

/** What a case's tools start from: the stored board of an edit case, nothing for a create. */
function toolsFor(fixture: CanvasFixture) {
	return createCanvasTools({
		board:
			fixture.kind === "edit" ? loadFixtureBoard(fixture.board ?? "") : null,
		artifactId: fixture.artifactId ?? "eval-board-0",
		title: fixture.title ?? "",
		allowCreate: fixture.kind === "create",
	});
}

/**
 * What `read_artifact` answers for the board of an edit case: the real payload,
 * shaped exactly as `runReadArtifactTool` shapes it for a canvas, or the tool's
 * own not-found answer. A test compares it with the real tool's answer for the
 * same board.
 */
export function readArtifactAnswer(
	fixture: CanvasFixture,
	args: unknown,
): string {
	return toolsFor(fixture).answer("read_artifact", args) ?? "";
}

/**
 * How the live runner asks the model for a case: through the tools, `auto`
 * choice (production's), and thinking off — the harness's default and the App
 * suite's policy. The conversation goes on the way the app's does: a lookup is
 * answered with a stub, and a call to one of the three artifact tools with the
 * app's own answer (`canvas-tools.ts`), for at most four steps — so a model
 * that reads the board, is refused, and tries again is seen doing so. A call the
 * suite has no answer for is the step that is scored.
 */
export const CANVAS_TOOL_SUITE: ToolSuite = {
	requestFor(evalCase: EvalCase): ToolPathRequestSpec {
		const language = evalCase.language ?? "en";
		const fixture = fixtureByCaseId.get(evalCase.id);
		const tools = fixture ? toolsFor(fixture) : null;
		return {
			system: canvasSystemPrompt(language),
			user: evalCase.prompt,
			language,
			toolChoice: "auto",
			// A fresh conversation has no memory to recall, no skill to use and no
			// instruction scope to suggest into (the snapshot's header lists these
			// three as withheld per conversation).
			withoutTools: ["memory_context", "use_skill", "suggest_instruction"],
			followUp: {
				maxSteps: 4,
				answer: (name, args) =>
					tools?.answer(name, args) ?? LOOKUP_STUBS[name] ?? null,
			},
			thinking: evalCase.thinking ?? "off",
		};
	},
};

// ── the board's geometry, as the app's own defaults see it ───────────────

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A node's footprint as the panel draws it, and as the model is told it
 * (`plannedNodeSize`, the one estimate the read, the tool text and this
 * rubric share): its stored size, a frame's own, or its kind's default width and
 * the height its words, items or plot take. A note is as tall as its words and a
 * chart has a plot, so a fixed 84 would let a board that spills out of its frames
 * on the reader's screen score clean (RV-3 C2, RC-3 N1).
 */
function sizeOf(node: CanvasNode): { width: number; height: number } {
	return plannedNodeSize(node);
}

function byIdOf(body: CanvasBody): Map<string, CanvasNode> {
	return new Map(body.nodes.map((node) => [node.id, node]));
}

/** The chain of frames a node sits in, nearest first. Loops (a board that was never normalised) end the walk. */
function ancestorsOf(
	node: CanvasNode,
	byId: Map<string, CanvasNode>,
): CanvasNode[] {
	const chain: CanvasNode[] = [];
	const seen = new Set<string>([node.id]);
	let cursor = node.parentId ? byId.get(node.parentId) : undefined;
	while (cursor && !seen.has(cursor.id)) {
		chain.push(cursor);
		seen.add(cursor.id);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	return chain;
}

function absoluteRect(node: CanvasNode, byId: Map<string, CanvasNode>): Rect {
	let { x, y } = node.position;
	for (const ancestor of ancestorsOf(node, byId)) {
		x += ancestor.position.x;
		y += ancestor.position.y;
	}
	return { x, y, ...sizeOf(node) };
}

/** Two rectangles overlap when they share more than a pixel of both axes: touching is not overlapping. */
function overlap(a: Rect, b: Rect): boolean {
	const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return across > 1 && down > 1;
}

function labelOf(node: CanvasNode): string {
	const data = node.data;
	if (data.kind === "sticky" || data.kind === "text") return data.text;
	if (data.kind === "frame") return data.label;
	if (
		data.kind === "checklist" ||
		data.kind === "chart" ||
		data.kind === "mermaid"
	) {
		return data.label ?? "";
	}
	return "";
}

function describeNode(node: CanvasNode): string {
	return `${node.type} "${node.id}"`;
}

// ── the rubric's checks ──────────────────────────────────────────────────

const MAX_LISTED = 3;

function listed(items: string[]): string {
	return items.length > MAX_LISTED
		? `${items.slice(0, MAX_LISTED).join("; ")} (+${items.length - MAX_LISTED} more)`
		: items.join("; ");
}

/** Pairs of nodes that share space. A frame and what is inside it do not count; `only` narrows the pairs to those that involve a node the change touched. */
export function overlapProblems(
	after: CanvasBody,
	only?: ReadonlySet<string>,
): string[] {
	const byId = byIdOf(after);
	const rects = after.nodes.map((node) => ({
		node,
		rect: absoluteRect(node, byId),
		lineage: new Set(ancestorsOf(node, byId).map((a) => a.id)),
	}));
	const problems: string[] = [];
	for (let i = 0; i < rects.length; i += 1) {
		for (let j = i + 1; j < rects.length; j += 1) {
			const a = rects[i];
			const b = rects[j];
			if (only && !only.has(a.node.id) && !only.has(b.node.id)) continue;
			if (a.lineage.has(b.node.id) || b.lineage.has(a.node.id)) continue;
			if (overlap(a.rect, b.rect)) {
				problems.push(`${describeNode(a.node)} covers ${describeNode(b.node)}`);
			}
		}
	}
	return problems;
}

/** A node inside a frame must lie inside its rectangle: the frame's own size, in the node's own space. */
export function frameProblems(after: CanvasBody): string[] {
	const byId = byIdOf(after);
	const problems: string[] = [];
	for (const node of after.nodes) {
		const parent = node.parentId ? byId.get(node.parentId) : undefined;
		if (!parent) continue;
		const { width, height } = sizeOf(node);
		const frame = sizeOf(parent);
		const within =
			node.position.x >= -1 &&
			node.position.y >= -1 &&
			node.position.x + width <= frame.width + 1 &&
			node.position.y + height <= frame.height + 1;
		if (!within) {
			problems.push(
				`${describeNode(node)} at (${node.position.x}, ${node.position.y}) sticks out of frame "${parent.id}" (${frame.width}x${frame.height})`,
			);
		}
	}
	return problems;
}

/** Every note, frame and checklist the board holds has words. */
export function labelProblems(after: CanvasBody): string[] {
	const problems: string[] = [];
	for (const node of after.nodes) {
		const data = node.data;
		if (data.kind === "checklist") {
			if (data.items.some((item) => item.text.trim() === "")) {
				problems.push(`${describeNode(node)} has an empty item`);
			}
		} else if (
			(data.kind === "sticky" ||
				data.kind === "text" ||
				data.kind === "frame") &&
			labelOf(node).trim() === ""
		) {
			problems.push(`${describeNode(node)} has no text`);
		}
	}
	return problems;
}

/** What went from the board that the request did not name: nodes not in `mayRemove`, and edges that are not the removed nodes' own. */
export function removedProblems(
	before: CanvasBody,
	after: CanvasBody,
	mayRemove: readonly string[],
): string[] {
	const still = new Set(after.nodes.map((node) => node.id));
	const goneNodes = before.nodes
		.filter((node) => !still.has(node.id))
		.map((node) => node.id);
	const problems: string[] = [];
	const unasked = goneNodes.filter((id) => !mayRemove.includes(id));
	if (unasked.length > 0) {
		problems.push(
			`the request did not name ${unasked.map((id) => `"${id}"`).join(", ")}`,
		);
	}
	const goneSet = new Set(goneNodes);
	const edgesLeft = new Set(after.edges.map((edge) => edge.id));
	const lostEdges = before.edges
		.filter(
			(edge) =>
				!edgesLeft.has(edge.id) &&
				!goneSet.has(edge.source) &&
				!goneSet.has(edge.target),
		)
		.map((edge) => edge.id);
	if (lostEdges.length > 0) {
		problems.push(
			`edge${lostEdges.length > 1 ? "s" : ""} ${lostEdges.map((id) => `"${id}"`).join(", ")} went too, and the request did not name ${lostEdges.length > 1 ? "them" : "it"}`,
		);
	}
	return problems;
}

/** The nodes a change added or moved or resized: the ones whose place is the model's doing. */
function touchedIds(before: CanvasBody, after: CanvasBody): Set<string> {
	const was = byIdOf(before);
	const touched = new Set<string>();
	for (const node of after.nodes) {
		const prior = was.get(node.id);
		if (!prior) {
			touched.add(node.id);
			continue;
		}
		const a = sizeOf(prior);
		const b = sizeOf(node);
		if (
			prior.position.x !== node.position.x ||
			prior.position.y !== node.position.y ||
			a.width !== b.width ||
			a.height !== b.height
		) {
			touched.add(node.id);
		}
	}
	return touched;
}

/** The words a board holds that were not there before: what the language check reads. */
function newWords(before: CanvasBody | null, after: CanvasBody): string {
	const had = new Set(
		(before?.nodes ?? []).map(
			(node) => `${node.id}\u0000${JSON.stringify(node.data)}`,
		),
	);
	const words: string[] = [];
	for (const node of after.nodes) {
		if (had.has(`${node.id}\u0000${JSON.stringify(node.data)}`)) continue;
		const data = node.data;
		// A diagram's words are a few proper nouns and a title, which the language
		// detector reads as English whatever they are; its stops are judged by name
		// in the request's own check instead (a Hungarian flowchart names "múzeum").
		if (data.kind === "mermaid") continue;
		if (data.kind === "checklist") {
			words.push(data.label ?? "", ...data.items.map((item) => item.text));
		} else {
			words.push(labelOf(node));
		}
	}
	// A fragment of one or two words ("Opera, 19:00", a frame's name) is a proper
	// noun or a time to the detector, whatever language it is in: only what is
	// written as a phrase says which language it was written in.
	return words
		.filter((word) => word.trim().split(/\s+/).length >= 3)
		.join("\n");
}

function languageProblem(
	text: string,
	declared: ToolPathLanguage,
): string | null {
	if (text.trim() === "") return null;
	const signal = classifyLanguageSignal(text);
	const other = declared === "hu" ? "en" : "hu";
	return signal === other
		? `the board's new words read as ${signal}, but the request declares ${declared}`
		: null;
}

function edgeBetween(
	board: CanvasBody,
	a: string,
	b: string,
): { source: string; target: string } | null {
	const found = board.edges.find(
		(edge) =>
			(edge.source === a && edge.target === b) ||
			(edge.source === b && edge.target === a),
	);
	return found ? { source: found.source, target: found.target } : null;
}

// ── per-fixture: what the request asked for ──────────────────────────────

interface RequestedCheck {
	/** Nodes that may go, and only those. */
	mayRemove: string[];
	/** Overlap is judged for the pairs that involve a node the change touched, or for every pair. */
	overlapScope: "touched" | "all";
	/** The request's own items: hard findings. The suite's evaluation is the third argument, for what needed an await to find out. */
	requested: (
		before: CanvasBody,
		after: CanvasBody,
		evaluation?: unknown,
	) => string[];
	/** Softer findings about how it was done. */
	notes?: (before: CanvasBody, after: CanvasBody) => string[];
}

const SATURDAY_NOTES = ["breakfast", "museum", "lunch", "walk", "opera"];

function hasWords(
	after: CanvasBody,
	pattern: RegExp,
	parentId: string,
): boolean {
	return after.nodes.some(
		(node) =>
			node.parentId === parentId &&
			node.data.kind === "sticky" &&
			pattern.test(node.data.text),
	);
}

function sundayCheck(patterns: RegExp[]): RequestedCheck["requested"] {
	return (before, after) => {
		const known = new Set(before.nodes.map((node) => node.id));
		const frames = after.nodes.filter(
			(node) =>
				!known.has(node.id) &&
				node.data.kind === "frame" &&
				/sunday|vas[aá]rnap/i.test(node.data.label),
		);
		if (frames.length === 0) {
			return ["request: no new frame is labelled for Sunday"];
		}
		const frame = frames[0];
		const stickies = after.nodes.filter(
			(node) =>
				!known.has(node.id) &&
				node.parentId === frame.id &&
				node.data.kind === "sticky",
		);
		const problems: string[] = [];
		if (stickies.length < 3) {
			problems.push(
				`request: ${stickies.length} new sticky note(s) sit inside the Sunday frame, three were asked for`,
			);
		}
		for (const pattern of patterns) {
			if (!hasWords(after, pattern, frame.id)) {
				problems.push(
					`request: no sticky in the Sunday frame matches ${pattern.source}`,
				);
			}
		}
		return problems;
	};
}

/** The blocks a change added: ids the board did not have. */
function addedNodes(before: CanvasBody, after: CanvasBody): CanvasNode[] {
	const known = new Set(before.nodes.map((node) => node.id));
	return after.nodes.filter((node) => !known.has(node.id));
}

/** The distance between two rectangles' nearest edges: 0 when they touch or share space. */
export function rectGap(a: Rect, b: Rect): number {
	const across = Math.max(
		0,
		Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width),
	);
	const down = Math.max(
		0,
		Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height),
	);
	return Math.hypot(across, down);
}

/**
 * "Next to" the block a request names: the new block's nearest edge within a
 * note's width of it. Generous on purpose — a frame that is full has no room at
 * the block's own side, and the nearest free ground can be a row below. Where it
 * lies (in the frame, on nothing) is judged by `frames:` and `overlap:`.
 */
const NEXT_TO_GAP = 160;

function noteBesideCheck(
	about: RegExp,
	besideId: string,
	besideName: string,
): RequestedCheck["requested"] {
	return (before, after) => {
		const note = addedNodes(before, after).find(
			(node) => node.data.kind === "sticky" && about.test(node.data.text),
		);
		if (!note) {
			return [`request: no new note is about ${about.source.split("|")[0]}`];
		}
		const byId = byIdOf(after);
		const beside = byId.get(besideId);
		if (!beside) return [];
		const gap = rectGap(absoluteRect(note, byId), absoluteRect(beside, byId));
		return gap > NEXT_TO_GAP
			? [
					`request: the new note is ${Math.round(gap)} away from the ${besideName} note, which is not next to it`,
				]
			: [];
	};
}

/**
 * The numbers a Chart.js config holds in its datasets, or null when it is not
 * JSON. Read the way the chat reads a chart fence (`parseJsonLenient`: a model
 * one closing brace short, or with a trailing comma, still draws a chart), so
 * what is judged is what is drawn.
 */
function chartValues(code: string): { type: string; values: number[] } | null {
	const config = parseJsonLenient(code) as
		| {
				type?: unknown;
				data?: { datasets?: Array<{ data?: unknown }> };
		  }
		| undefined;
	if (typeof config !== "object" || config === null) return null;
	const values = (config.data?.datasets ?? []).flatMap((dataset) =>
		Array.isArray(dataset.data)
			? dataset.data.filter((v): v is number => typeof v === "number")
			: [],
	);
	return { type: String(config.type ?? ""), values };
}

function chartInFrameCheck(
	frameId: string,
	frameName: string,
	values: number[],
): RequestedCheck["requested"] {
	return (before, after) => {
		const chart = addedNodes(before, after).find(
			(node) => node.data.kind === "chart",
		);
		if (!chart || chart.data.kind !== "chart") {
			return ["request: no new chart is on the board"];
		}
		const problems: string[] = [];
		const read = chartValues(chart.data.code);
		if (!read) {
			problems.push("request: the chart's config cannot be read as JSON");
		} else {
			if (read.type !== "bar") {
				problems.push(
					`request: a bar chart was asked for, this is "${read.type}"`,
				);
			}
			const missing = values.filter((value) => !read.values.includes(value));
			if (missing.length > 0) {
				problems.push(
					`request: the chart does not hold ${missing.join(", ")} of the ${values.join(", ")} asked for`,
				);
			}
		}
		if (chart.parentId !== frameId) {
			problems.push(`request: the chart is not inside the ${frameName} frame`);
		}
		return problems;
	};
}

/** At least this many of the plan's stops have to be in a flowchart that was asked to hold them. */
const FLOWCHART_MIN_STOPS = 4;

function flowchartCheck(stops: RegExp[]): RequestedCheck["requested"] {
	return (before, after) => {
		const added = addedNodes(before, after);
		const diagram = added.find((node) => node.data.kind === "mermaid");
		if (!diagram || diagram.data.kind !== "mermaid") {
			const notes = added.filter((node) => node.data.kind === "sticky").length;
			return [
				`request: no diagram block was added${notes > 0 ? ` (${notes} sticky note${notes === 1 ? "" : "s"} instead)` : ""}`,
			];
		}
		const problems: string[] = [];
		const source = diagram.data.code;
		const header = source
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line !== "" && !line.startsWith("%%"));
		if (!/^(flowchart|graph)\b/i.test(header ?? "")) {
			problems.push(
				`request: a flowchart was asked for, the diagram starts "${(header ?? "").slice(0, 30)}"`,
			);
		}
		const named = stops.filter((stop) => stop.test(source)).length;
		if (named < FLOWCHART_MIN_STOPS) {
			problems.push(
				`request: the flowchart names ${named} of the ${stops.length} stops`,
			);
		}
		return problems;
	};
}

/** What Mermaid made of every diagram a change added or rewrote: a source it cannot read is drawn as source text and an error note. */
export function diagramProblems(
	before: CanvasBody | null,
	after: CanvasBody,
	evaluation: unknown,
): string[] {
	const was = new Map((before?.nodes ?? []).map((node) => [node.id, node]));
	const problems: string[] = [];
	for (const node of after.nodes) {
		if (node.data.kind !== "mermaid") continue;
		const prior = was.get(node.id);
		if (prior?.data.kind === "mermaid" && prior.data.code === node.data.code) {
			continue;
		}
		const verdict = diagramVerdict(evaluation, node.data.code);
		if (verdict && !verdict.ok) {
			problems.push(
				`${describeNode(node)} does not draw: ${verdict.error ?? "Mermaid could not read it"}`,
			);
		}
	}
	return problems;
}

const REQUESTED: Record<string, RequestedCheck> = {
	"arrange-saturday": {
		mayRemove: [],
		overlapScope: "all",
		requested: (before, after) => {
			const problems: string[] = [];
			const at = byIdOf(after);
			const missing = SATURDAY_NOTES.filter(
				(id) => at.get(id)?.parentId !== "sat",
			);
			if (missing.length > 0) {
				problems.push(
					`request: ${missing.map((id) => `"${id}"`).join(", ")} is no longer inside the Saturday frame`,
				);
			}
			const was = byIdOf(before);
			const unmoved = SATURDAY_NOTES.filter((id) => {
				const a = was.get(id)?.position;
				const b = at.get(id)?.position;
				return a && b && a.x === b.x && a.y === b.y;
			});
			// Five notes piled up: at least four have to go somewhere to stop overlapping.
			if (unmoved.length > 1) {
				problems.push(
					`request: ${unmoved.map((id) => `"${id}"`).join(", ")} stayed where it was, in the pile`,
				);
			}
			return problems;
		},
		notes: (_before, after) => {
			// "In the order of the day": reading order by row, then by column — or by
			// column, then row — is the day's order. A soft finding: a grid can be
			// read either way.
			const at = byIdOf(after);
			const notes = SATURDAY_NOTES.map((id) => at.get(id)).filter(
				(node): node is CanvasNode => node !== undefined,
			);
			const order = (key: (n: CanvasNode) => number[]) =>
				[...notes]
					.sort((a, b) => {
						const ka = key(a);
						const kb = key(b);
						return ka[0] - kb[0] || ka[1] - kb[1];
					})
					.map((n) => n.id)
					.join(",");
			const day = SATURDAY_NOTES.join(",");
			const rowMajor = order((n) => [
				Math.round(n.position.y / 40),
				n.position.x,
			]);
			const columnMajor = order((n) => [
				Math.round(n.position.x / 40),
				n.position.y,
			]);
			return rowMajor === day || columnMajor === day
				? []
				: ["note: the notes are not in the order of the day"];
		},
	},
	"add-sunday": {
		mayRemove: [],
		overlapScope: "touched",
		requested: sundayCheck([/brunch/i, /prater|práter/i, /train|rail/i]),
	},
	"add-sunday-hu": {
		mayRemove: [],
		overlapScope: "touched",
		requested: sundayCheck([/brunch|reggeli/i, /prater|práter/i, /vonat/i]),
	},
	"add-note-beside": {
		mayRemove: [],
		overlapScope: "touched",
		requested: noteBesideCheck(/sacher/i, "museum", "museum"),
	},
	"add-note-beside-hu": {
		mayRemove: [],
		overlapScope: "touched",
		requested: noteBesideCheck(/sacher/i, "museum", "museum"),
	},
	"chart-in-frame": {
		mayRemove: [],
		overlapScope: "touched",
		requested: chartInFrameCheck("sat", "Saturday", [12, 21, 18, 8]),
	},
	"chart-in-frame-hu": {
		mayRemove: [],
		overlapScope: "touched",
		requested: chartInFrameCheck("sat", "Szombat", [12, 21, 18, 8]),
	},
	"add-flowchart": {
		mayRemove: [],
		overlapScope: "touched",
		requested: flowchartCheck([
			/breakfast/i,
			/museum/i,
			/lunch/i,
			/walk/i,
			/opera/i,
		]),
	},
	"add-flowchart-hu": {
		mayRemove: [],
		overlapScope: "touched",
		requested: flowchartCheck([
			/reggeli/i,
			/m[uú]zeum/i,
			/eb[eé]d/i,
			/s[eé]ta/i,
			/opera/i,
		]),
	},
	"remove-and-connect": {
		mayRemove: ["museum"],
		overlapScope: "touched",
		requested: (_before, after) => {
			const problems: string[] = [];
			if (after.nodes.some((node) => node.id === "museum")) {
				problems.push("request: the museum note is still on the board");
			}
			if (!edgeBetween(after, "lunch", "walk")) {
				problems.push("request: no edge connects lunch to the walk");
			}
			return problems;
		},
		notes: (_before, after) => {
			const edge = edgeBetween(after, "lunch", "walk");
			return edge && edge.source !== "lunch"
				? [
						"note: the arrow points from the walk to lunch, not from lunch to the walk",
					]
				: [];
		},
	},
};

// ── scoring ──────────────────────────────────────────────────────────────

function bad(...reasons: string[]): EvalScoreResult {
	return { verdict: "bad", reasons };
}

/** The lookups the model made before the last step, named for a reason that has to say what happened. */
function lookupsOf(envelope: ToolPathEnvelope): string[] {
	return (envelope.priorSteps ?? []).flatMap((step) =>
		step.toolCalls.map((call) => call.name),
	);
}

const BOARD_TOOLS = ["read_artifact", "create_artifact", "edit_artifact"];

/** What a create must leave: a plan with frames and enough on it — the request was open-ended, so this is the least a board for a weekend has. */
function createRubric(board: CanvasBody): string[] {
	const problems: string[] = [];
	const frames = board.nodes.filter((node) => node.data.kind === "frame");
	const withWords = board.nodes.filter(
		(node) => node.data.kind !== "frame" && labelOf(node).trim() !== "",
	);
	if (frames.length === 0) problems.push("request: the board has no frame");
	if (withWords.length < 5) {
		problems.push(
			`request: ${withWords.length} block(s) with words, a plan needs at least 5`,
		);
	}
	return problems;
}

/**
 * A recorded conversation, scored. The model's calls are replayed through the
 * app's own tools (`canvas-tools.ts`) in the order it made them — the ones the
 * live run answered and the last step, which it did not — so what is judged is
 * the board the conversation LEFT, and each call that was refused, in part or
 * whole, is named. A call refused on its first try is a miss even when the model
 * mended it in the next step (the contract's bar is a clean first try); a
 * `recovery:` line says when it did, because "a refusal names what would have
 * worked" is only true if the model then does it.
 */
function scoreTranscript(
	fixture: CanvasFixture,
	envelope: ToolPathEnvelope,
	evaluation?: unknown,
): EvalScoreResult {
	const tools = toolsFor(fixture);
	const before = fixture.kind === "edit" ? tools.board() : null;
	const steps = [
		...(envelope.priorSteps ?? []).map((step) => step.toolCalls),
		envelope.toolCalls,
	];
	let readBeforeWrite = false;
	let written = false;
	for (const calls of steps) {
		for (const call of calls) {
			if (!BOARD_TOOLS.includes(call.name)) continue;
			if (call.name === "read_artifact" && !written) readBeforeWrite = true;
			const wrote = tools.writes();
			tools.answer(call.name, call.arguments);
			if (tools.writes() > wrote) written = true;
		}
	}
	const lookups = lookupsOf(envelope);
	const afterLookups =
		lookups.length > 0 ? `after ${lookups.join(" and ")}, ` : "";
	const wanted = fixture.kind === "edit" ? "edit_artifact" : "create_artifact";
	const calledLast = envelope.toolCalls.map((call) => call.name);

	const called: string[] = [];
	for (const event of tools.events) called.push(...event.lines);
	const board = tools.board();
	if (!written || !board) {
		if (!calledLast.includes(wanted)) {
			called.push(
				calledLast.length > 0
					? `routing: ${afterLookups}the last step was ${calledLast.join(" and ")}, not ${wanted}, so the board was not ${fixture.kind === "edit" ? "changed" : "made"}`
					: `routing: ${afterLookups}no tool was called${envelope.content.trim() ? " (it answered in text)" : ""}, so the board was not ${fixture.kind === "edit" ? "changed" : "made"}`,
			);
		}
		return bad(...called);
	}

	// The board the conversation left, against the rubric.
	const rubric: string[] = [];
	const notes: string[] = [];
	if (fixture.kind === "edit") {
		const check = REQUESTED[fixture.id];
		const start = before as CanvasBody;
		rubric.push(...check.requested(start, board, evaluation));
		const frames = frameProblems(board);
		if (frames.length > 0) rubric.push(`frames: ${listed(frames)}`);
		const overlaps = overlapProblems(
			board,
			check.overlapScope === "all" ? undefined : touchedIds(start, board),
		);
		if (overlaps.length > 0) rubric.push(`overlap: ${listed(overlaps)}`);
		const labels = labelProblems(board);
		if (labels.length > 0) rubric.push(`labels: ${listed(labels)}`);
		const diagrams = diagramProblems(start, board, evaluation);
		if (diagrams.length > 0) rubric.push(`diagram: ${listed(diagrams)}`);
		const removed = removedProblems(start, board, check.mayRemove);
		if (removed.length > 0) rubric.push(`removed: ${listed(removed)}`);
		const language = languageProblem(newWords(start, board), fixture.language);
		if (language) rubric.push(`language: ${language}`);
		notes.push(...(check.notes?.(start, board) ?? []));
		if (!readBeforeWrite) {
			notes.push("note: the board was edited without reading it first");
		}
	} else {
		rubric.push(...createRubric(board));
		const frames = frameProblems(board);
		if (frames.length > 0) rubric.push(`frames: ${listed(frames)}`);
		const overlaps = overlapProblems(board);
		if (overlaps.length > 0) rubric.push(`overlap: ${listed(overlaps)}`);
		const labels = labelProblems(board);
		if (labels.length > 0) rubric.push(`labels: ${listed(labels)}`);
		const diagrams = diagramProblems(null, board, evaluation);
		if (diagrams.length > 0) rubric.push(`diagram: ${listed(diagrams)}`);
		const language = languageProblem(
			`${tools.title()}\n${newWords(null, board)}`,
			fixture.language,
		);
		if (language) rubric.push(`language: ${language}`);
		const creates = steps
			.flat()
			.filter((call) => call.name === "create_artifact").length;
		if (creates > 1) {
			notes.push(`note: ${creates} create_artifact calls in one conversation`);
		}
	}

	const hard = [...called, ...rubric];
	if (hard.length > 0) {
		// A call that was refused and then mended: the board passes, the first try did not.
		if (rubric.length === 0 && called.length > 0) {
			notes.push(
				"recovery: the board the conversation left passes the rubric; the model mended what was refused",
			);
		}
		return { verdict: "bad", reasons: [...hard, ...notes] };
	}
	if (notes.length > 0) return { verdict: "acceptable", reasons: notes };
	const edits = tools.events.filter(
		(event) => event.name === "edit_artifact",
	).length;
	return {
		verdict: "good",
		reasons: [
			fixture.kind === "edit"
				? `ok: ${tools.appliedOps()} ops applied in ${edits} edit call${edits === 1 ? "" : "s"}, ${board.nodes.length} nodes and ${board.edges.length} edges left${lookups.length > 0 ? `, ${afterLookups.replace(/, $/, "")}` : ""}`
				: `ok: a board of ${board.nodes.length} nodes (${board.nodes.filter((n) => n.data.kind === "frame").length} frame(s)) and ${board.edges.length} edges, in ${fixture.language}${lookups.length > 0 ? `, ${afterLookups.replace(/, $/, "")}` : ""}`,
		],
	};
}

export const scoreCanvasEval: SuiteScorer = (evalCase, attempt, evaluation) => {
	const fixture = fixtureByCaseId.get(evalCase.id);
	if (!fixture) {
		return bad(`no fixture is registered for case "${evalCase.id}"`);
	}
	const envelope = decodeToolPathResponse(attempt.response);
	if (!envelope) {
		return bad(
			"tool-call: the recorded answer is not a tool-call envelope (toolCalls, content, finishReason)",
		);
	}
	return scoreTranscript(fixture, envelope, evaluation);
};
