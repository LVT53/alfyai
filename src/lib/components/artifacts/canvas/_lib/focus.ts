/**
 * Focuses an element that may not be focusable yet, and keeps trying for a few
 * frames. Svelte Flow draws a node hidden (`visibility: hidden`) until it has
 * measured it, and a hidden element cannot take focus — so a field that opens
 * the moment its block is inserted has to wait for the block to show. Returns
 * the function that stops trying (an effect's cleanup).
 */
export function focusWhenShown(
	element: HTMLElement,
	onFocused?: () => void,
): () => void {
	let frame = 0;
	let attempts = 0;
	const attempt = () => {
		element.focus();
		if (document.activeElement === element) {
			onFocused?.();
			return;
		}
		attempts += 1;
		if (attempts < 40) frame = requestAnimationFrame(attempt);
	};
	attempt();
	return () => cancelAnimationFrame(frame);
}
