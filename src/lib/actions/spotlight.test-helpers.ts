import { vi } from "vitest";

/**
 * Puts a property on `Element.prototype` and returns the function that puts
 * back what was there: the property as it was, or no property at all.
 */
function replaceOnElementPrototype(
	name: "getClientRects" | "scrollIntoView",
	value: unknown,
): () => void {
	const original = Object.getOwnPropertyDescriptor(Element.prototype, name);
	Object.defineProperty(Element.prototype, name, {
		configurable: true,
		writable: true,
		value,
	});
	return () => {
		if (original) Object.defineProperty(Element.prototype, name, original);
		else Reflect.deleteProperty(Element.prototype, name);
	};
}

/**
 * For a test of anything that carries `use:spotlightTarget`. jsdom has no
 * layout engine, so every element answers `getClientRects()` with an empty list
 * (which the action reads as "not on screen") and `scrollIntoView` does not
 * exist. This gives every element one rect and a `scrollIntoView` mock, and
 * returns the function that undoes both.
 *
 * The mock is one for all elements: read it as `node.scrollIntoView`, and use
 * its `mock.contexts` to tell which element a call was made on.
 *
 * A control that should count as not on screen gets its own empty list:
 * `node.getClientRects = () => [] as unknown as DOMRectList`.
 *
 * For tests only: the name keeps vitest from running it as a test file.
 */
export function stubLayoutForSpotlight(): () => void {
	const restoreRects = replaceOnElementPrototype(
		"getClientRects",
		() => [new DOMRect(0, 0, 120, 32)] as unknown as DOMRectList,
	);
	const restoreScroll = replaceOnElementPrototype("scrollIntoView", vi.fn());
	return () => {
		restoreScroll();
		restoreRects();
	};
}
