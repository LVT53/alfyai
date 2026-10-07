/**
 * How tall a diagram block is drawn (decisions.md ruling 74). A diagram is the
 * one block whose height nobody stores and nothing in its data says: Mermaid
 * lays the source out, and the panel scales the picture down to the block's
 * width. The model plans a board with sizes, and the placer keeps blocks apart
 * by them, so a diagram taller than what was reserved for it ends up under the
 * block placed below it. This reads the source the way the layout does (ranks,
 * lanes, messages), and the numbers are what Mermaid 11.17 drew in headless
 * Chromium, measured on 40 sources (`mermaid-size.test.ts` holds them):
 *
 *  - a flowchart is a stack of ranks (top to bottom) or of lanes (left to
 *    right): 49 per box, 50 between ranks and between neighbours, 23 more
 *    across an arrow that carries a label, a decision (diamond) as tall as it is
 *    wide (54 + 0.86 of its words), 16 around it all;
 *  - a sequence diagram is 171 plus 46 per message, as wide as 200 per
 *    participant;
 *  - the panel draws the picture no wider than the block, so a wide diagram is
 *    shorter on the board than it is in its own units (a Gantt chart, 1184
 *    wide, is drawn at a third of its height).
 *
 * The answer is an estimate, and on purpose never a short one: it is the same
 * number the model's read reports and the placer reserves, and ground left over
 * is better than a diagram laid over its neighbour. A source it cannot read (a
 * kind it does not know) gets what the Insert menu reserves.
 */

/** What is reserved for a diagram when its source says too little to read a size from. */
export const DIAGRAM_FALLBACK_HEIGHT = 420;
const DIAGRAM_MIN_HEIGHT = 80;
const DIAGRAM_MAX_HEIGHT = 3000;
/** The block's card and the diagram's own margin: what the picture is drawn inside of. */
const CARD_INSET = 24;
/** The estimate is the layout's height plus a tenth and a little: slack, never a shortfall. */
const SAFETY_FACTOR = 1.1;
const SAFETY_ADD = 12;

const CHAR_WIDTH = 8.4;
const WRAP_WIDTH = 200;
const BOX_HEIGHT = 49;
const EXTRA_LINE = 18;
const BOX_SIDE_PAD = 60;
const NODE_SEP = 50;
const RANK_SEP = 50;
const LABEL_HOP = 23;
const SVG_PAD = 16;
const SUBGRAPH_PAD = 50;
const MAX_SUBGRAPHS_COUNTED = 3;

interface Natural {
	width: number;
	height: number;
}

interface FlowNode {
	label: string;
	diamond: boolean;
}

interface FlowEdge {
	from: string;
	to: string;
	label: string;
}

/** The source's own statements: no blank lines, no comments, no front matter. */
function statementsOf(code: string): string[] {
	const lines = code
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("%%"));
	if (lines[0] === "---") {
		const end = lines.indexOf("---", 1);
		if (end > 0) lines.splice(0, end + 1);
	}
	return lines;
}

// ── Flowcharts ───────────────────────────────────────────────────────────

const ID_CHARACTER = /[\p{L}\p{N}_]/u;
const CLOSERS = new Set(["]", ")", "}"]);

/** A node's words and shape, read from where its bracket opens; the bracket's end, or null when there is none. */
function readShape(
	text: string,
	start: number,
): { label: string; diamond: boolean; end: number } | null {
	const first = text[start];
	if (first !== "[" && first !== "(" && first !== "{" && first !== ">") {
		return null;
	}
	let at = start;
	while (at < text.length && "[({>/\\".includes(text[at])) at += 1;
	const opener = text.slice(start, at);
	const diamond = opener === "{";
	let label: string;
	if (text[at] === '"') {
		const close = text.indexOf('"', at + 1);
		if (close < 0) return null;
		label = text.slice(at + 1, close);
		at = close + 1;
	} else {
		const from = at;
		while (at < text.length && !CLOSERS.has(text[at])) at += 1;
		label = text.slice(from, at);
	}
	while (at < text.length && "])}/\\".includes(text[at])) at += 1;
	return { label: label.trim(), diamond, end: at };
}

/** An arrow, with the words written on it: `-->`, `-.->`, `==>`, `---`, `-->|yes|`, `-- yes -->`. */
function readArrow(
	text: string,
	start: number,
): { label: string; end: number } | null {
	const rest = text.slice(start);
	const inline =
		/^(?:<)?(--|==|-\.)\s+(.+?)\s+(-->|---|==>|===|\.->|-->>|--[ox>])/.exec(
			rest,
		);
	if (inline) return { label: inline[2], end: start + inline[0].length };
	const plain = /^(?:<)?(?:-{2,}|={2,}|-\.+-?|\.-+)[>ox]?/.exec(rest);
	if (!plain) return null;
	let end = start + plain[0].length;
	let label = "";
	if (text[end] === "|") {
		const close = text.indexOf("|", end + 1);
		if (close > 0) {
			label = text.slice(end + 1, close);
			end = close + 1;
		}
	}
	return { label: label.trim(), end };
}

function readFlowStatement(
	statement: string,
	nodes: Map<string, FlowNode>,
	edges: FlowEdge[],
): void {
	let at = 0;
	let previous: string[] | null = null;
	let pending = "";
	while (at < statement.length) {
		const group: string[] = [];
		for (;;) {
			while (statement[at] === " ") at += 1;
			const from = at;
			while (at < statement.length && ID_CHARACTER.test(statement[at])) at += 1;
			if (at === from) break;
			const id = statement.slice(from, at);
			const shape = readShape(statement, at);
			if (shape) at = shape.end;
			if (statement.startsWith(":::", at)) {
				at += 3;
				while (at < statement.length && ID_CHARACTER.test(statement[at])) {
					at += 1;
				}
			}
			const known = nodes.get(id);
			nodes.set(id, {
				label: shape?.label ?? known?.label ?? id,
				diamond: shape ? shape.diamond : (known?.diamond ?? false),
			});
			group.push(id);
			while (statement[at] === " ") at += 1;
			if (statement[at] === "&") {
				at += 1;
				continue;
			}
			break;
		}
		if (group.length === 0) return;
		if (previous) {
			for (const a of previous) {
				for (const b of group) edges.push({ from: a, to: b, label: pending });
			}
		}
		while (statement[at] === " ") at += 1;
		const arrow = readArrow(statement, at);
		if (!arrow) return;
		at = arrow.end;
		pending = arrow.label;
		previous = group;
	}
}

/** Each box's own size: its words, wrapped at 200, a decision as tall as it is wide. */
function boxSize(node: FlowNode): { width: number; height: number } {
	const lines = node.label
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.split("\n");
	const widest = Math.max(1, ...lines.map((line) => Array.from(line).length));
	const textWidth = widest * CHAR_WIDTH;
	const wrapped = lines.reduce(
		(sum, line) =>
			sum +
			Math.max(
				1,
				Math.ceil((Array.from(line).length * CHAR_WIDTH) / WRAP_WIDTH),
			),
		0,
	);
	const extra = EXTRA_LINE * (wrapped - 1);
	if (node.diamond) {
		const side = Math.round(
			54 + 0.86 * Math.min(textWidth, WRAP_WIDTH) + extra,
		);
		return { width: side, height: side };
	}
	return {
		width: Math.round(Math.min(textWidth, WRAP_WIDTH) + BOX_SIDE_PAD),
		height: BOX_HEIGHT + extra,
	};
}

/** A rank for every node: its longest path from a start, with an arrow back to a node already on the path left out. */
function ranksOf(
	nodes: ReadonlyMap<string, FlowNode>,
	edges: readonly FlowEdge[],
): Map<string, number> {
	const out = new Map<string, string[]>();
	for (const edge of edges) {
		if (edge.from === edge.to) continue;
		out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
	}
	const state = new Map<string, 1 | 2>();
	const forward: Array<[string, string]> = [];
	const visit = (from: string): void => {
		state.set(from, 1);
		for (const to of out.get(from) ?? []) {
			if (state.get(to) === 1) continue;
			forward.push([from, to]);
			if (!state.has(to)) visit(to);
		}
		state.set(from, 2);
	};
	for (const id of nodes.keys()) if (!state.has(id)) visit(id);
	const ranks = new Map([...nodes.keys()].map((id) => [id, 0]));
	for (let pass = 0; pass < nodes.size; pass += 1) {
		let moved = false;
		for (const [from, to] of forward) {
			const next = (ranks.get(from) ?? 0) + 1;
			if (next > (ranks.get(to) ?? 0)) {
				ranks.set(to, next);
				moved = true;
			}
		}
		if (!moved) break;
	}
	return ranks;
}

function flowSize(
	statements: readonly string[],
	direction: "down" | "across",
	inStatesDialect = false,
): Natural {
	const nodes = new Map<string, FlowNode>();
	const edges: FlowEdge[] = [];
	let subgraphs = 0;
	for (const line of statements.slice(1)) {
		for (const part of line.split(";")) {
			const statement = part.trim();
			if (statement === "") continue;
			if (/^subgraph\b/i.test(statement)) {
				subgraphs += 1;
				continue;
			}
			if (
				/^(end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr)\b/.test(
					statement,
				)
			) {
				continue;
			}
			if (inStatesDialect) readStateTransition(statement, nodes, edges);
			else readFlowStatement(statement, nodes, edges);
		}
	}
	if (nodes.size === 0) {
		return { width: 480, height: DIAGRAM_FALLBACK_HEIGHT };
	}
	const ranks = ranksOf(nodes, edges);
	const rankCount = Math.max(...ranks.values()) + 1;
	const byRank: Array<Array<{ width: number; height: number }>> = Array.from(
		{ length: rankCount },
		() => [],
	);
	for (const [id, rank] of ranks) {
		const node = nodes.get(id);
		if (node) byRank[rank].push(boxSize(node));
	}
	// An arrow with words on it makes room for them between its two ranks.
	const labelled = new Map<number, number>();
	for (const edge of edges) {
		if (edge.label === "") continue;
		const from = ranks.get(edge.from) ?? 0;
		const to = ranks.get(edge.to) ?? 0;
		if (to <= from) continue;
		const wide = Math.round(Array.from(edge.label).length * CHAR_WIDTH) + 16;
		for (let rank = from; rank < to; rank += 1) {
			labelled.set(rank, Math.max(labelled.get(rank) ?? 0, wide));
		}
	}
	const packed = (
		rank: Array<{ width: number; height: number }>,
		side: "width" | "height",
	): number =>
		rank.reduce((sum, box) => sum + box[side], 0) +
		NODE_SEP * Math.max(0, rank.length - 1);
	const along = (side: "width" | "height"): number =>
		byRank.reduce(
			(sum, rank, index) =>
				sum +
				Math.max(0, ...rank.map((box) => box[side])) +
				(index < rankCount - 1
					? RANK_SEP +
						(labelled.has(index)
							? side === "height"
								? LABEL_HOP
								: (labelled.get(index) ?? 0)
							: 0)
					: 0),
			0,
		);
	const groups =
		SUBGRAPH_PAD * Math.min(subgraphs, MAX_SUBGRAPHS_COUNTED) + SVG_PAD;
	return direction === "down"
		? {
				width:
					Math.max(...byRank.map((rank) => packed(rank, "width"))) + groups,
				height: along("height") + groups,
			}
		: {
				width: along("width") + groups,
				height:
					Math.max(...byRank.map((rank) => packed(rank, "height"))) + groups,
			};
}

/** A state diagram's transition: `A --> B`, `[*] --> A`, `A --> B : words`. */
function readStateTransition(
	statement: string,
	nodes: Map<string, FlowNode>,
	edges: FlowEdge[],
): void {
	const found =
		/^(\[\*\]|[\p{L}\p{N}_.-]+)\s*-->\s*(\[\*\]|[\p{L}\p{N}_.-]+)(?:\s*:\s*(.*))?$/u.exec(
			statement,
		);
	if (!found) return;
	for (const id of [found[1], found[2]]) {
		if (!nodes.has(id)) {
			nodes.set(id, { label: id === "[*]" ? "" : id, diamond: false });
		}
	}
	edges.push({ from: found[1], to: found[2], label: (found[3] ?? "").trim() });
}

// ── The other diagram kinds ──────────────────────────────────────────────

function sequenceSize(statements: readonly string[]): Natural {
	const people = new Set<string>();
	let messages = 0;
	let notes = 0;
	let blocks = 0;
	let branches = 0;
	for (const line of statements.slice(1)) {
		const declared = /^(?:participant|actor)\s+(\S+)/i.exec(line);
		if (declared) {
			people.add(declared[1]);
			continue;
		}
		if (/^note\b/i.test(line)) {
			notes += 1;
			continue;
		}
		if (/^(alt|opt|loop|par|critical|break|rect)\b/i.test(line)) {
			blocks += 1;
			continue;
		}
		if (/^(else|and|option)\b/i.test(line)) {
			branches += 1;
			continue;
		}
		const message =
			/^(\S+?)\s*(?:--?>>|--?>|--?x|--?\)|<<--?>>)\s*[+-]?(\S+?)\s*:/.exec(
				line,
			);
		if (message) {
			messages += 1;
			people.add(message[1]);
			people.add(message[2]);
		}
	}
	return {
		width: 200 * Math.max(2, people.size) + 50,
		height: 171 + 46 * messages + 55 * notes + 45 * blocks + 30 * branches,
	};
}

function ganttSize(statements: readonly string[]): Natural {
	const tasks = statements
		.slice(1)
		.filter(
			(line) =>
				line.includes(":") &&
				!/^(title|dateFormat|axisFormat|section|excludes|includes|tickInterval|todayMarker|weekday|accTitle|accDescr)\b/i.test(
					line,
				),
		).length;
	// Its width is the window's: a Gantt chart is as wide as the page it was drawn on.
	return { width: 1100, height: 70 + 25 * Math.max(1, tasks) };
}

function entityRelationSize(statements: readonly string[]): Natural {
	let relations = 0;
	let attributes = 0;
	let inside = false;
	for (const line of statements.slice(1)) {
		if (line.endsWith("{")) inside = true;
		else if (line === "}") inside = false;
		else if (inside) attributes += 1;
		else if (
			/(\|\||\}o|\}\||o\{|\|\{)\s*--|--\s*(\|\||o\{|\|\{|o\||\}o)/.test(line)
		) {
			relations += 1;
		}
	}
	return {
		width: 420,
		height: 100 + 120 * Math.min(8, Math.max(1, relations)) + 22 * attributes,
	};
}

function classSize(statements: readonly string[]): Natural {
	return { width: 300, height: 120 + 20 * (statements.length - 1) };
}

function naturalSizeOf(code: string): Natural {
	const statements = statementsOf(code);
	const header = (statements[0] ?? "").toLowerCase();
	const flow = /^(?:flowchart|graph)(?:-elk)?\s*(tb|td|bt|lr|rl)?\b/.exec(
		header,
	);
	if (flow) {
		const across = flow[1] === "lr" || flow[1] === "rl";
		return flowSize(statements, across ? "across" : "down");
	}
	if (/^statediagram/.test(header)) return flowSize(statements, "down", true);
	if (/^sequencediagram/.test(header)) return sequenceSize(statements);
	if (/^gantt/.test(header)) return ganttSize(statements);
	if (/^pie\b/.test(header)) return { width: 560, height: 450 };
	if (/^erdiagram/.test(header)) return entityRelationSize(statements);
	if (/^classdiagram/.test(header)) return classSize(statements);
	if (/^(timeline|journey)\b/.test(header)) {
		return { width: 950, height: 500 };
	}
	return { width: 480, height: DIAGRAM_FALLBACK_HEIGHT };
}

/**
 * The height, in board units, a diagram of this source is drawn at in a block
 * `width` wide: its layout's own height, scaled the way the picture is when it
 * is wider than the block, plus the slack described above. Whole numbers.
 */
export function estimatedDiagramHeight(code: string, width: number): number {
	const natural = naturalSizeOf(code);
	const inner = Math.max(120, width - CARD_INSET);
	const scale = Math.min(1, inner / natural.width);
	const drawn = natural.height * scale * SAFETY_FACTOR + SAFETY_ADD;
	return Math.min(
		DIAGRAM_MAX_HEIGHT,
		Math.max(DIAGRAM_MIN_HEIGHT, Math.ceil(drawn)),
	);
}
