/**
 * The Document's own text anchor resolver (Feature 2 · Artifacts, Slice 1,
 * Task T10; ruling 35 keeps the Document's pure engine under
 * `artifact-document/`). Pure and dependency-free — no Tiptap/ProseMirror
 * import here or transitively (the editor is lazy; the margin must not pull
 * it in to render a comment). Reading the live selection out of the editor is
 * `document-editor.ts`'s job; this module only ever sees plain strings and
 * `DocumentBlock[]`.
 *
 * Ruling 11: this is ONE of the family's per-type resolvers. The shared
 * vocabulary it resolves onto (`AnchorResolution`, `anchorStateFor`,
 * `ORPHANED_ANCHOR_RESOLUTION`) lives in `$lib/shared/artifacts/anchor.ts` and
 * is never redeclared here — Slice 3's node/point resolver will feed the same
 * three states through the same thresholds, not a second vocabulary.
 */
import {
	type AnchorResolution,
	anchorStateFor,
	ORPHANED_ANCHOR_RESOLUTION,
} from "$lib/shared/artifacts/anchor";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { DocumentBlock } from "./blocks";

/** How much surrounding text a text anchor carries on each side of its quote. */
export const ANCHOR_CONTEXT_CHARS = 24;

/** A candidate scan is capped at this many quote occurrences across the whole document (T10.9). */
const MAX_CANDIDATES = 50;

const QUOTE_POINTS = 1;
const PREFIX_POINTS = 1;
const SUFFIX_POINTS = 1;
/**
 * The tie-breaker that makes "two identical sentences in different blocks"
 * resolve to the one this anchor was actually created against (T10.3): worth
 * more than a full context match (quote+prefix+suffix = 3) elsewhere, so the
 * original block always outscores a coincidental duplicate, but on its own —
 * without the quote and its context also matching — it still lands below the
 * `anchorStateFor` "exact" threshold (T10.2's "edited nearby" case).
 */
const SAME_BLOCK_BONUS = 2;

/**
 * Builds a `text` anchor from a selection's quote and the plain-text context
 * captured around it (the caller — the editor-lazy `document-editor.ts` — is
 * the one that knows how to read that context off a live ProseMirror
 * selection; this function only validates and trims). `null` for a
 * whitespace-only quote: there is nothing to anchor a comment to.
 */
export function makeAnchor(params: {
	blockId: string;
	quote: string;
	prefix: string;
	suffix: string;
}): Anchor | null {
	const quote = params.quote.trim();
	if (!quote) return null;
	return {
		kind: "text",
		blockId: params.blockId,
		quote,
		prefix: params.prefix.slice(-ANCHOR_CONTEXT_CHARS),
		suffix: params.suffix.slice(0, ANCHOR_CONTEXT_CHARS),
	};
}

/** The anchor's own block first, so the cap below can never exclude it — everything else follows in document order. */
function candidateBlockOrder(
	blocks: DocumentBlock[],
	originalBlockId: string,
): DocumentBlock[] {
	const original: DocumentBlock[] = [];
	const rest: DocumentBlock[] = [];
	for (const block of blocks) {
		(block.id === originalBlockId ? original : rest).push(block);
	}
	return [...original, ...rest];
}

/**
 * Resolves a `text` anchor against the CURRENT blocks. Pure, and asserted
 * against the same three outcomes (exact/moved/orphaned) the Canvas resolver
 * will be (ruling 11, T10.8): scans quote occurrences block by block (the
 * anchor's own block first), scores each by how much of the anchor's
 * original context still surrounds it, and keeps the best. Never mutates
 * anything and never throws — an anchor that cannot resolve is `orphaned`,
 * not an error.
 */
export function resolveTextAnchor(
	anchor: Anchor,
	blocks: DocumentBlock[],
): AnchorResolution {
	if (anchor.kind !== "text") return ORPHANED_ANCHOR_RESOLUTION;

	let best: { score: number; blockId: string; from: number; to: number } | null =
		null;
	let scanned = 0;

	for (const block of candidateBlockOrder(blocks, anchor.blockId)) {
		const text = block.markdown;
		let searchFrom = 0;
		for (;;) {
			if (scanned >= MAX_CANDIDATES) break;
			const idx = text.indexOf(anchor.quote, searchFrom);
			if (idx === -1) break;
			scanned += 1;

			const before = text.slice(Math.max(0, idx - anchor.prefix.length), idx);
			const afterEnd = idx + anchor.quote.length;
			const after = text.slice(afterEnd, afterEnd + anchor.suffix.length);

			let score = QUOTE_POINTS;
			if (before === anchor.prefix) score += PREFIX_POINTS;
			if (after === anchor.suffix) score += SUFFIX_POINTS;
			if (block.id === anchor.blockId) score += SAME_BLOCK_BONUS;

			if (!best || score > best.score) {
				best = { score, blockId: block.id, from: idx, to: afterEnd };
			}
			searchFrom = idx + 1;
		}
		if (scanned >= MAX_CANDIDATES) break;
	}

	if (!best) return ORPHANED_ANCHOR_RESOLUTION;
	return {
		state: anchorStateFor(best.score),
		blockId: best.blockId,
		from: best.from,
		to: best.to,
	};
}

/**
 * Re-baselines an anchor onto where it resolves NOW: a fresh `blockId` (a
 * block split mints new ids for both halves — neither is the original, so
 * only a live re-resolve can find the right one) and freshly recomputed
 * prefix/suffix. Orphaned resolves to nothing, so the original anchor comes
 * back unchanged — its quote stays visible rather than the comment losing
 * its own anchor to a `null`.
 */
export function reanchor(anchor: Anchor, blocks: DocumentBlock[]): Anchor {
	if (anchor.kind !== "text") return anchor;
	const resolution = resolveTextAnchor(anchor, blocks);
	if (resolution.state === "orphaned" || !resolution.blockId) return anchor;
	const block = blocks.find((candidate) => candidate.id === resolution.blockId);
	if (!block) return anchor;

	const text = block.markdown;
	const prefix = text.slice(
		Math.max(0, resolution.from - ANCHOR_CONTEXT_CHARS),
		resolution.from,
	);
	const suffix = text.slice(resolution.to, resolution.to + ANCHOR_CONTEXT_CHARS);
	return {
		kind: "text",
		blockId: resolution.blockId,
		quote: anchor.quote,
		prefix,
		suffix,
	};
}
