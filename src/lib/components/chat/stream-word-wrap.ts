/**
 * Streaming word-reveal wrapping (C3).
 *
 * During streaming, `MarkdownRenderer.svelte` wraps each newly-arrived word in a
 * `.word-new` span so it can fade in. On a long, fast answer that unbounded
 * per-word wrapping thrashes the DOM (thousands of freshly-created spans). This
 * module owns the pure DOM-walking wrap plus the two guards that keep it
 * bounded, so both the walk and the thresholds are unit-testable in isolation
 * (jsdom) instead of only reachable through the 1k-line component.
 *
 * The mitigation is deliberately conservative — the normal-length answer keeps
 * the exact same per-word animation; only pathologically long answers degrade
 * to the coarser whole-block fade-in (which the component already applies to new
 * blocks via `.block-fade-in`).
 */

/**
 * Length threshold (characters of the full message content). Once a streamed
 * message grows past this, per-word wrapping is skipped entirely and the answer
 * relies on the whole-block fade-in instead. ~12k chars is roughly 2000 words;
 * beyond that the churn of creating thousands of spans costs more than the
 * reveal is worth. A normal chat answer is far below this and is unaffected.
 */
export const WORD_ANIMATION_MAX_CHARS = 12_000;

/**
 * Per-tick cap on freshly-wrapped words. A single streamed chunk can deliver a
 * large burst of words at once; wrapping every one in a span thrashes layout.
 * Beyond this cap the extra new words are inserted as plain text (they still
 * appear immediately, just without the individual fade). With the renderer's
 * ~40ms throttle this bounds span creation to a sane rate.
 */
export const MAX_NEW_WORDS_PER_TICK = 80;

/**
 * Whether the per-word reveal should run at all for a message of this length.
 * Past {@link WORD_ANIMATION_MAX_CHARS} the caller skips wrapping (fallback to
 * the whole-block fade-in). Pure and side-effect free.
 */
export function shouldAnimateWords(contentLength: number): boolean {
	return contentLength <= WORD_ANIMATION_MAX_CHARS;
}

/**
 * Walk `element`'s DOM and wrap newly-arrived words in an animated `.word-new`
 * span.
 *
 * Words at index `< startIndex` are already rendered and left untouched; only
 * words `>= startIndex` are candidates. At most `maxNewWords` words are wrapped
 * in this call — any new words beyond that cap are inserted as plain text so the
 * DOM churn per tick stays bounded. `<script>`/`<style>` subtrees and
 * `.source-link-chip` anchors are skipped (their contents are not animated).
 *
 * Returns the total word count after processing, which the caller feeds back as
 * the next `startIndex`.
 */
export function wrapNewWords(
	element: HTMLElement,
	startIndex: number,
	maxNewWords: number = MAX_NEW_WORDS_PER_TICK,
): number {
	let wordIndex = 0;
	let wrappedThisTick = 0;

	function countWords(parts: string[]): void {
		for (const part of parts) {
			if (part.trim()) wordIndex++;
		}
	}

	function processNode(node: Node): void {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? "";
			const parts = text.split(/(\s+)/);

			// Fast path: check whether any word in this text node is new.
			let tempCount = wordIndex;
			let nodeHasNew = false;
			for (const part of parts) {
				if (part.trim()) {
					if (tempCount >= startIndex) {
						nodeHasNew = true;
						break;
					}
					tempCount++;
				}
			}

			// Skip rebuilding the node when it has no new words, OR once the
			// per-tick cap is already spent (remaining new words render as plain
			// text with no wrapping) — we only need to advance the count.
			if (!nodeHasNew || wrappedThisTick >= maxNewWords) {
				countWords(parts);
				return;
			}

			const fragment = document.createDocumentFragment();
			for (const part of parts) {
				if (!part.trim()) {
					fragment.appendChild(document.createTextNode(part));
				} else {
					if (wordIndex >= startIndex && wrappedThisTick < maxNewWords) {
						const span = document.createElement("span");
						span.className = "word-new";
						span.textContent = part;
						fragment.appendChild(span);
						wrappedThisTick++;
					} else {
						fragment.appendChild(document.createTextNode(part));
					}
					wordIndex++;
				}
			}
			node.parentNode?.replaceChild(fragment, node);
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const el = node as Element;
			const tagName = el.tagName;
			if (tagName === "SCRIPT" || tagName === "STYLE") return;
			if (el.matches(".source-link-chip")) return;
			Array.from(node.childNodes).forEach(processNode);
		}
	}

	Array.from(element.childNodes).forEach(processNode);
	return wordIndex;
}
