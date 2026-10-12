/**
 * jsdom lays nothing out: every element is 0 wide and there is no ResizeObserver.
 * A block that reads its own width (`bind:clientWidth`: a diagram, which is drawn
 * down or across by how wide its block is) is drawn in a test against this: every
 * element is `width` wide and nothing ever resizes. Returns what undoes it.
 */
export function stubLayout(width = 456): () => void {
	const holder = globalThis as unknown as { ResizeObserver?: unknown };
	const had = Object.hasOwn(holder, "ResizeObserver");
	const previous = holder.ResizeObserver;
	const own = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
	holder.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
	Object.defineProperty(Element.prototype, "clientWidth", {
		configurable: true,
		get: () => width,
	});
	return () => {
		if (had) holder.ResizeObserver = previous;
		else delete holder.ResizeObserver;
		if (own) Object.defineProperty(Element.prototype, "clientWidth", own);
		else delete (Element.prototype as { clientWidth?: number }).clientWidth;
	};
}
