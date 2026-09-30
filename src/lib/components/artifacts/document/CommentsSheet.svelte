<script lang="ts">
/**
 * Comments away from the inline column (Feature 2 · Artifacts, Wave 2.5 Step
 * 8, redesign.md §3.2/§3.3/§9.2/§9.3; reworked after the owner's walk-through
 * of the redesign): a phone bottom sheet from the header's Comments button or
 * a tapped highlight, and a drawer over the right edge of the text on a
 * panel too narrow to hold the column beside it.
 *
 * Wraps `MarginPanel.svelte` AS ITS CONTENT — this file owns presentation
 * only, never comment state (`DocumentBody.svelte` does) — in its `grouped`
 * layout: there is no text beside a sheet or a drawer to sit next to, so it
 * is a plain stack, the refusal note first, then every tab's threads under
 * that tab's name, then the removed-text group (§3.2 "Phone"). The sheet and
 * the drawer themselves are `../CommentsSurface.svelte`, which every kind's
 * comments share.
 */
import type { ComponentProps } from "svelte";
import { t } from "$lib/i18n";
import CommentsSurface from "../CommentsSurface.svelte";
// MarginPanel is a genuine runtime import for the <MarginPanel {...} /> mount in
// the template below, on top of typing MarginPanelProps via
// ComponentProps<typeof MarginPanel> — biome's import-usage check only sees
// this script block, not the template, so it reads as type-only.
// biome-ignore lint/style/useImportType: see above — import type would break the template mount
import MarginPanel from "./MarginPanel.svelte";

type MarginPanelProps = Omit<
	ComponentProps<typeof MarginPanel>,
	"layout" | "onClose" | "revealRequest"
>;

let {
	presentation,
	onClose,
	bottomInset = 0,
	...marginPanelProps
}: MarginPanelProps & {
	/** "sheet" on phones (a `DialogShell`), "drawer" on a narrow desktop panel (redesign §3.2) — the caller already knows which from its own viewport/container-width tracking, so this component only ever renders ONE shape at a time. */
	presentation: "sheet" | "drawer";
	onClose: () => void;
	/** The drawer stops this many pixels above the panel's bottom edge, so something pinned there — the review bar, whose Keep all / Undo all are the very thing someone reading comments about a change wants next — is never covered by it. The sheet has its own scrim and ignores it. */
	bottomInset?: number;
} = $props();

/** The quote button and a click on a card jump back into the main text — closing first so the reader can actually see the flash-scroll it triggers, on both the phone sheet (which otherwise fully covers the text) and the narrow drawer (which covers its own edge of it). */
function handleGotoAnchor(blockId: string, from: number, to: number): void {
	marginPanelProps.onGotoAnchor?.(blockId, from, to);
	onClose();
}
</script>

<CommentsSurface
	{presentation}
	title={$t('artifacts.document.margin.title')}
	{onClose}
	{bottomInset}
>
	{#snippet children({ presentation: shown })}
		<!-- The drawer's header carries the close button (given `onClose`); the
		     sheet's dialog has its own. -->
		<MarginPanel
			{...marginPanelProps}
			layout="grouped"
			onGotoAnchor={handleGotoAnchor}
			onClose={shown === 'drawer' ? onClose : undefined}
		/>
	{/snippet}
</CommentsSurface>
