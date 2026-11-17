/**
 * A standard report's text as units both sides of read aloud's report bridge agree
 * on. The page reads a report from its own inert copy (`DOMParser`: nothing runs,
 * nothing loads), the frame shows the report itself, and the two only ever speak of
 * a place in it as a block and a character offset. So both run the same walk: these
 * functions are self-contained on purpose, and the bridge carries their own source
 * into the frame (`report-bridge.ts`), with the same rules.
 *
 * The walk is markup only, never computed style: the report's own scripts change
 * classes, inline styles and `hidden` after it loads (the section menu, the
 * tooltips, a favicon's fallback), never its text, so a walk that reads tags and the
 * report's fixed class names gives the same blocks on both sides. Its chrome (the
 * source chips and their tooltips, the basis markers, the final Sources, scripts and
 * styles) is never a unit.
 */

/** What a walk reads: which elements are the report's chrome, and which make a block. */
export type ReportUnitRules = { chrome: string; blocks: string };

/**
 * The report's chrome (`renderers/standard-report-html.ts`): never read, never a
 * unit. Also what the speech script skips (`DocumentReadingSource.skip`).
 */
export const REPORT_CHROME = [
	".source-chip",
	".inline-source-chips",
	".source-tooltip",
	".basis-marker",
	".basis-tooltip",
	".honesty-marker",
	".honesty-tooltip",
	".cite-dot",
	".cite-legend",
	".source-list",
	".source-subheading",
	"#sources",
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"button",
	"input",
	"select",
	"textarea",
].join(",");

export const REPORT_UNIT_RULES: ReportUnitRules = {
	chrome: REPORT_CHROME,
	blocks:
		"h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,dt,dd,figcaption,summary,aside",
};

/** The report's content: its `#report-content`, else its body. The section menu is outside it. */
export function reportRoot(doc: Document): Element {
	return doc.getElementById("report-content") ?? doc.body;
}

/**
 * The report's text nodes under `root`, grouped by block, in document order: a
 * text node's block is its nearest ancestor that `rules.blocks` names, else the
 * root; blocks are numbered as their first text appears. Nothing under an element
 * `rules.chrome` names is read, and an empty text node is not a unit.
 * Self-contained: the bridge carries this function's source into the frame.
 */
export function reportBlocks(root: Element, rules: ReportUnitRules): Text[][] {
	const blocks: Text[][] = [];
	const numbers = new Map<Element, number>();
	const blockOf = (text: Text): Element => {
		for (
			let element = text.parentElement;
			element && element !== root;
			element = element.parentElement
		) {
			if (element.matches(rules.blocks)) return element;
		}
		return root;
	};
	const walk = (node: Node): void => {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === 3) {
				const text = child as Text;
				if (text.data.length === 0) continue;
				const block = blockOf(text);
				let number = numbers.get(block);
				if (number === undefined) {
					number = blocks.length;
					numbers.set(block, number);
					blocks.push([]);
				}
				blocks[number]?.push(text);
			} else if (
				child.nodeType === 1 &&
				!(child as Element).matches(rules.chrome)
			) {
				walk(child);
			}
		}
	};
	walk(root);
	return blocks;
}

/**
 * Where a point of a text node is, as a block and a character offset; null when
 * the node is not one of the blocks' own. Self-contained, as `reportBlocks` is.
 */
export function positionInBlocks(
	blocks: Text[][],
	node: Node,
	offset: number,
): { block: number; offset: number } | null {
	for (let block = 0; block < blocks.length; block++) {
		let start = 0;
		for (const text of blocks[block] ?? []) {
			if (text === node) {
				return offset >= 0 && offset <= text.data.length
					? { block, offset: start + offset }
					: null;
			}
			start += text.data.length;
		}
	}
	return null;
}

/**
 * The text node and offset a block's character offset falls at: the end of a
 * block is the end of its last node. Null for a block or an offset that does not
 * exist. Self-contained, as `reportBlocks` is.
 */
export function pointInBlocks(
	blocks: Text[][],
	block: number,
	offset: number,
): { node: Text; offset: number } | null {
	const nodes = blocks[block];
	if (!nodes || !Number.isInteger(offset) || offset < 0) return null;
	let start = 0;
	for (let i = 0; i < nodes.length; i++) {
		const text = nodes[i] as Text;
		const end = start + text.data.length;
		if (offset < end || (offset === end && i === nodes.length - 1))
			return { node: text, offset: offset - start };
		start = end;
	}
	return null;
}
