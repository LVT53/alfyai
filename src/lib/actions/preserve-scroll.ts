/**
 * Svelte action that preserves scroll position when a collapsible element
 * (e.g., code block, thinking block) expands or collapses.
 *
 * Usage:
 * ```svelte
 * <button onclick={toggle}>
 *   Toggle
 * </button>
 * {#if expanded}
 *   <div use:preserveScroll={container}>
 *     Content
 *   </div>
 * {/if}
 * ```
 *
 * Or call the action directly on the container element when toggling:
 * ```svelte
 * <div bind:this={container}>
 *   <button onclick={handleToggle}>Toggle</button>
 *   <!-- content -->
 * </div>
 *
 * <script>
 * const preserveScrollAction = preserveScroll(container, { onToggle: () => expanded = !expanded });
 * </script>
 * ```
 */

/**
 * Options for the preserveScroll action.
 * @param container - The element to track for scroll preservation
 * @param onToggle - Optional callback called when toggle is triggered
 *                   (for use with action that wraps a toggle button)
 * @param topPadding - Additional top padding to maintain (default: 0)
 * @param bottomPadding - Additional bottom padding to maintain (default: 0)
 * @param extraCheck - Optional function to check additional scroll conditions
 *                     (receives scrollContainer, container, groupsElement and returns adjustment delta)
 */
export interface PreserveScrollOptions {
	container: HTMLElement;
	onToggle?: () => void;
	topPadding?: number;
	bottomPadding?: number;
	extraCheck?: (
		scrollContainer: HTMLElement,
		containerEl: HTMLElement,
		groupsEl: HTMLElement | null,
	) => number;
}

/**
 * Simple scroll preservation for toggle-style collapsibles.
 * Call this in your toggle handler after changing the expanded state.
 *
 * @param container - The collapsible block's root element (must be bound with bind:this)
 * @param expandedState - Reactive state variable for expanded/collapsed
 * @param onToggle - Function to call to toggle the state
 */
export async function preserveScrollOnToggle(
	container: HTMLElement | undefined,
	_expandedState: boolean,
	onToggle: () => void,
): Promise<void> {
	const scrollEl = container?.closest(
		".scroll-container",
	) as HTMLElement | null;
	const blockTop = container?.getBoundingClientRect().top ?? 0;
	onToggle();
	if (!scrollEl || container === undefined) return;

	// Wait for DOM update then adjust scroll
	await Promise.resolve();
	requestAnimationFrame(() => {
		const newBlockTop = container?.getBoundingClientRect().top ?? 0;
		scrollEl.scrollTop += newBlockTop - blockTop;
	});
}
