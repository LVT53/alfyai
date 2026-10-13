<script lang="ts">
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import { portalToBody } from "$lib/utils/portal";
import { isTouchDevice } from "$lib/utils/viewport.svelte";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type {
	ArtifactSummary,
	MemoryLayer,
} from "$lib/server/services/knowledge/types";
import { followAnchor } from "./anchored-popup";

let {
	contextStatus = null,
	attachedArtifacts = [],
	contextDebug = null,
	totalCostUsd = 0,
	lastTurnCostUsd = 0,
	totalTokens = 0,
}: {
	contextStatus?: ConversationContextStatus | null;
	attachedArtifacts?: ArtifactSummary[];
	contextDebug?: ContextDebugState | null;
	totalCostUsd?: number;
	lastTurnCostUsd?: number;
	totalTokens?: number;
} = $props();

// What the popup is and where it stands.
//
// It is a read-out, not a menu: nothing in it takes the keyboard, so (unlike
// the outline list beside an attachment) there is no focus to move into it and
// nothing for Tab to miss when it is painted far from the ring in the page's
// order. What opens it is the ring's own: a tap or a click pins it open until
// the next tap, a press elsewhere or Escape; a mouse over the ring shows it for
// as long as the mouse stays; so does the keyboard's focus on the ring. These
// used to be the rules `.ring-root:hover .ring-popover` and
// `.ring-root:focus-within .ring-popover`, which name the popup as the ring's
// descendant and cannot match it once it is painted in <body>.
//
// Where it stands depends on the screen. On a desktop it hangs off the ring by
// CSS (absolute, 10px above it). On a phone, on a touch screen of any width and
// in any window narrower than 768px (where there is not 25rem to the right of
// the ring to grow into) it is a fixed box measured against the window. A fixed
// box is only the window's while no ancestor has a transform, and the home page
// (and a project's) centres its composer with `transform: translateY(-50%)`:
// the old sheet's `bottom: 5.5rem` was counted from THAT layer's bottom edge, so
// the popup opened wherever the layer happened to end (over the composer's
// toolbar row, ring included, in a short window; under it on a project's page).
// So in those cases it is painted in <body> (`portalToBody`, as the composer's
// other popups are), where fixed means the window whatever the composer sits
// in, and is placed from the ring's rectangle and its own size
// (`followAnchor`): above the ring when it fits there, below it when it does
// not and there is more room, always inside the window, and following the ring
// for as long as it is open.
const uid = $props.id();
const popoverId = `context-usage-popover-${uid}`;
/** The phone sheet's old cap, 30rem: the most it grows before it scrolls. */
const POPOVER_MAX_HEIGHT = 480;
/** How close it comes to the window's sides: the 0.25rem the phone sheet always kept. */
const POPOVER_SIDE_MARGIN = 4;
/** Narrower than this is a phone's room whatever the pointer is (a narrow window on a mouse is not "touch"). */
const NARROW_QUERY = "(max-width: 767px)";

let root = $state<HTMLDivElement | null>(null);
let ringButton = $state<HTMLButtonElement | null>(null);
let popover = $state<HTMLDivElement | null>(null);
let popoverStyle = $state<string | undefined>(undefined);
let pinned = $state(false);
let hovered = $state(false);
let focused = $state(false);
let mobile = $state(false);
let narrow = $state(false);

let visible = $derived(pinned || hovered || focused);
let fixed = $derived(mobile || narrow);

const size = 38;
const strokeWidth = 3;
const radius = (size - strokeWidth) / 2;
const circumference = 2 * Math.PI * radius;

function detectLayout() {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		mobile = false;
		narrow = false;
		return;
	}

	mobile = isTouchDevice();
	narrow = window.matchMedia(NARROW_QUERY).matches;
}

onMount(() => {
	detectLayout();
	window.addEventListener("resize", detectLayout);

	// A press anywhere but the ring and the popup lets it go. The popup is not
	// inside `root` once it is in <body>, so the check names both.
	const handlePointerDown = (event: MouseEvent | TouchEvent) => {
		const target = event.target as Node;
		if (root?.contains(target) || popover?.contains(target)) return;
		pinned = false;
	};

	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });

	return () => {
		window.removeEventListener("resize", detectLayout);
		document.removeEventListener("mousedown", handlePointerDown);
		document.removeEventListener("touchstart", handlePointerDown);
	};
});

// Placed once its own box exists and followed for as long as it is open
// (anchored-popup.ts says how): the home composer glides to its place for
// 420ms after a resize, and an attachment's pill growing moves the ring with no
// event at all. Left where it stood when it closes, so the fade-out plays in
// place.
$effect(() => {
	const panel = popover;
	if (!fixed || !visible || !panel) return;
	return followAnchor({
		anchor: () => ringButton,
		popup: panel,
		maxHeight: POPOVER_MAX_HEIGHT,
		sideMargin: POPOVER_SIDE_MARGIN,
		onPlace: (style) => {
			popoverStyle = style;
		},
	});
});

// Escape puts it away, whatever showed it: the ring has to be entered or
// focused again, or pressed, to bring it back.
$effect(() => {
	if (!visible) return;
	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") dismiss();
	};
	window.addEventListener("keydown", handleKeydown);
	return () => window.removeEventListener("keydown", handleKeydown);
});

function dismiss() {
	pinned = false;
	hovered = false;
	focused = false;
}

// A press on the ring pins the popup, and a press on it again puts it away
// even while the mouse is still over the ring (hovering alone would keep it).
function handleClick() {
	if (pinned) dismiss();
	else pinned = true;
}

// Only a mouse hovers: a finger's "enter" is the tap that pins it.
function handlePointerEnter(event: PointerEvent) {
	if (event.pointerType !== "touch") hovered = true;
}

function handlePointerLeave() {
	hovered = false;
}

// The keyboard's focus shows the numbers; the focus a click or a tap gives the
// button does not (it pins them, and a second press puts them away).
function handleFocus(event: FocusEvent) {
	const target = event.currentTarget;
	try {
		focused = target instanceof Element && target.matches(":focus-visible");
	} catch {
		// A browser that does not know `:focus-visible` cannot tell the two apart.
		focused = true;
	}
}

function handleBlur() {
	focused = false;
}

function formatLayer(layer: MemoryLayer): string {
	switch (layer) {
		case "session":
			return $t("contextUsageRing.layer.session");
		case "capsule":
			return $t("contextUsageRing.layer.capsule");
		case "documents":
			return $t("contextUsageRing.layer.documents");
		case "outputs":
			return $t("contextUsageRing.layer.outputs");
		case "working_set":
			return $t("contextUsageRing.layer.workingSet");
		case "task_state":
			return $t("contextUsageRing.layer.taskState");
	}
}

function formatCompactionMode(
	mode: ConversationContextStatus["compactionMode"] | undefined,
): string {
	switch (mode) {
		case "deterministic":
			return $t("contextUsageRing.compaction.deterministic");
		case "llm_fallback":
			return $t("contextUsageRing.compaction.llmFallback");
		default:
			return $t("contextUsageRing.compaction.notNeeded");
	}
}

function formatCostUsd(costUsd: number): string {
	return `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
	return tokens.toLocaleString();
}

let showCost = $derived(totalCostUsd > 0 || totalTokens > 0);
let costText = $derived(
	showCost
		? `${formatCostUsd(totalCostUsd)} \u00b7 ${formatTokenCount(totalTokens)} ${$t("contextUsageRing.tokens")}`
		: "",
);
let showLastTurnCost = $derived(lastTurnCostUsd > 0);
let lastTurnCostText = $derived(
	showLastTurnCost ? formatCostUsd(lastTurnCostUsd) : "",
);

// The ring reports the best-known prompt size of the last completed turn
// (provider-reported input tokens when available, otherwise a full-prompt
// estimate) against the model's real context window. estimatedTokens /
// targetTokens remain the compaction inputs and are not shown here.
let contextWindow = $derived(
	contextStatus ? Math.max(contextStatus.maxContextTokens, 1) : 1,
);
let promptTokens = $derived(
	contextStatus ? Math.max(0, contextStatus.promptTokens) : 0,
);
let ratio = $derived(
	contextStatus ? Math.max(0, Math.min(1, promptTokens / contextWindow)) : 0,
);
let promptTokensSourceText = $derived(
	contextStatus?.promptTokensSource === "provider"
		? $t("contextUsageRing.promptTokensSource.provider")
		: $t("contextUsageRing.promptTokensSource.estimated"),
);
let dashOffset = $derived(circumference * (1 - ratio));
let percent = $derived(Math.round(ratio * 100));
let toneClass = $derived(
	!contextStatus
		? "ring-button--idle"
		: contextStatus.compactionMode === "llm_fallback"
			? "ring-button--compact"
			: contextStatus.compactionMode === "deterministic"
				? "ring-button--high"
				: ratio >= 0.9
					? "ring-button--high"
					: ratio >= 0.75
						? "ring-button--medium"
						: "ring-button--normal",
);

// Near-trigger heads-up: the prompt is filling the real context window and
// compaction may run soon. Shares the 0.75 warning band with toneClass.
// Only when not already compacted/reduced (those states already handled).
let isNearTrigger = $derived(
	contextStatus !== null &&
		ratio >= 0.75 &&
		contextStatus.compactionMode === "none",
);
</script>

<div
	bind:this={root}
	class="ring-root relative"
>
	<button
		bind:this={ringButton}
		type="button"
		data-testid="context-usage-ring"
		class={`ring-button ${toneClass}`}
		aria-label={contextStatus
			? $t('contextUsageRing.contextWindowUsage', {
				percent,
				tokens: promptTokens.toLocaleString(),
				max: contextWindow.toLocaleString(),
			})
			: $t('contextUsageRing.noContext')}
		aria-haspopup="dialog"
		aria-expanded={visible}
		aria-controls={popoverId}
		onclick={handleClick}
		onpointerenter={handlePointerEnter}
		onpointerleave={handlePointerLeave}
		onfocus={handleFocus}
		onblur={handleBlur}
	>
		<svg class="ring-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
			<circle
				class="ring-track"
				cx={size / 2}
				cy={size / 2}
				r={radius}
				stroke-width={strokeWidth}
			/>
			<circle
				class="ring-progress"
				cx={size / 2}
				cy={size / 2}
				r={radius}
				stroke-width={strokeWidth}
				stroke-dasharray={circumference}
				stroke-dashoffset={dashOffset}
			/>
		</svg>
		<span class="ring-value">{contextStatus ? `${percent}` : '0'}</span>
	</button>

	<div
		bind:this={popover}
		id={popoverId}
		data-testid="context-usage-popover"
		class="ring-popover"
		class:ring-popover--fixed={fixed}
		class:ring-popover--visible={visible}
		style={fixed ? popoverStyle : undefined}
		role="dialog"
		aria-label={$t('contextUsageRing.focusPanel')}
		use:portalToBody={fixed}
	>
		{#if showCost}
			<!-- Two cost lines (ADR #6): conversation running total as the hero,
			     plus the last turn's per-message cost (ChatMessage.costUsd) as a
			     muted secondary line. -->
			<div class="popover-section">
				<div class="popover-cost-row">
					<span class="popover-label">{$t('contextUsageRing.conversationCost')}</span>
					<span class="popover-cost-hero">{costText}</span>
				</div>
				{#if showLastTurnCost}
					<div class="popover-cost-row popover-cost-row--secondary">
						<span class="popover-cost-secondary-label">{$t('contextUsageRing.lastTurn')}</span>
						<span class="popover-cost-secondary">{lastTurnCostText}</span>
					</div>
				{/if}
			</div>
		{/if}

		<div class="popover-section">
			<div class="popover-label">{$t('contextUsageRing.context')}</div>
			{#if contextStatus}
				<div
					class={`popover-context-room popover-context-room-tooltip-container${isNearTrigger ? ' popover-context-room--near' : ''}`}
				>
					<div class="popover-context-room-header">
						<span class="popover-label">{$t('contextUsageRing.contextRoom')}</span>
						<span class="popover-context-room-pct">{$t('contextUsageRing.usageFormat', { percent })}</span>
					</div>
					<div class="popover-context-room-bar" aria-hidden="true">
						<div class="popover-context-room-fill" style={`width: ${percent}%`}></div>
					</div>
					{#if isNearTrigger}
						<p class="popover-near-trigger">{$t('contextUsageRing.nearTriggerNote')}</p>
					{/if}
					<div class="popover-context-room-tooltip" role="tooltip">
						<span class="popover-context-room-tooltip-label">{$t('contextUsageRing.contextWindow')}</span>
						<span class="popover-context-room-tooltip-value">{promptTokens.toLocaleString()} / {contextWindow.toLocaleString()}</span>
						<span class="popover-context-room-tooltip-source">{promptTokensSourceText}</span>
					</div>
				</div>
				<div class="popover-stat">
					<span>{$t('contextUsageRing.compaction')}</span>
					<span class:compaction-active={contextStatus.compactionMode !== 'none'}>
						{formatCompactionMode(contextStatus.compactionMode)}
					</span>
				</div>
				{#if contextDebug}
					<div class="popover-stat">
						<span>{$t('contextUsageRing.sourcesIncluded')}</span>
						<span>{contextDebug.selectedEvidence.length}</span>
					</div>
				{/if}
				{#if attachedArtifacts.length > 0}
					<div class="popover-stat">
						<span>{$t('contextUsageRing.attachedFiles')}</span>
						<span>{attachedArtifacts.length}</span>
					</div>
				{/if}
				<div class="popover-stat">
						<span>{$t('contextUsageRing.whatAlfyRemembers')}</span>
						<span>{contextStatus.recentTurnCount}</span>
					</div>
				{#if contextStatus.layersUsed.length > 0}
					<div class="popover-chips">
						{#each contextStatus.layersUsed as layer}
							<span class="popover-chip">{formatLayer(layer)}</span>
						{/each}
					</div>
				{/if}
			{:else}
				<div class="popover-empty">{$t('contextUsageRing.noContext')}</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.ring-root {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.ring-button {
		position: relative;
		display: flex;
		height: 44px;
		width: 44px;
		align-items: center;
		justify-content: center;
		border: 1px solid color-mix(in srgb, var(--border-default) 80%, transparent 20%);
		border-radius: 9999px;
		background: color-mix(in srgb, var(--surface-page) 76%, var(--surface-elevated) 24%);
		color: var(--text-muted);
		transition:
			border-color var(--duration-standard) var(--ease-out),
			background-color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.ring-button:hover,
	.ring-button:focus-visible {
		transform: translateY(-1px);
		outline: none;
	}

	.ring-button--normal {
		color: var(--accent);
	}

	.ring-button--medium {
		color: color-mix(in srgb, var(--accent) 70%, var(--warning) 30%);
	}

	.ring-button--high {
		color: var(--danger);
	}

	.ring-button--compact {
		color: color-mix(in srgb, var(--accent) 62%, var(--danger) 38%);
	}

	.ring-button--idle {
		color: var(--text-muted);
	}

	.ring-svg {
		transform: rotate(-90deg);
	}

	.ring-track,
	.ring-progress {
		fill: none;
	}

	.ring-track {
		stroke: color-mix(in srgb, var(--border-default) 72%, transparent 28%);
	}

	.ring-progress {
		stroke: currentColor;
		stroke-linecap: round;
		transition: stroke-dashoffset 180ms ease-out;
	}

	.ring-value {
		position: absolute;
		font-family: var(--font-sans);
		font-size: 9px;
		font-weight: 600;
		line-height: 1;
		color: var(--text-primary);
		text-transform: lowercase;
	}

	/* On a desktop the popup hangs off the ring by CSS: absolute inside
	   `.ring-root`, 10px above it. It is always in the page and is shown by
	   `.ring-popover--visible`, which the component sets from what the ring
	   knows (a press, a mouse over it, the keyboard's focus). While it is away
	   it is hidden from the page and from assistive technology, not only
	   transparent: `visibility` flips when the fade-out ends. */
	.ring-popover {
		position: absolute;
		left: 0;
		bottom: calc(100% + 10px);
		z-index: 40;
		/* Wide enough that the cost hero ("$x · yK tokens") never wraps the
		   "tokens" word onto its own line on desktop. A phone is narrower than
		   that: the 2rem keeps it off the window's edges. */
		width: min(25rem, calc(100vw - 2rem));
		border: 1px solid color-mix(in srgb, var(--border-default) 82%, transparent 18%);
		border-radius: 1rem;
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		box-shadow: var(--shadow-lg);
		padding: 0.9rem;
		backdrop-filter: blur(14px);
		opacity: 0;
		visibility: hidden;
		transform: translateY(6px);
		pointer-events: none;
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
	}

	.ring-popover--visible {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
		pointer-events: auto;
	}

	/* On a phone, on a touch screen and in a window narrower than 768px the
	   popup is a box of the window's, painted in <body> and placed from the
	   ring's rectangle (anchored-popup.ts): `left`, `top` or `bottom` and
	   `max-height` arrive inline. It stands above the app's own chrome, as the
	   incognito card does, and scrolls inside the room it has. */
	.ring-popover--fixed {
		position: fixed;
		left: auto;
		bottom: auto;
		z-index: 60;
		/* As wide as the phone sheet always was: 0.25rem from each side. */
		width: min(25rem, calc(100vw - 0.5rem));
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.popover-section + .popover-section {
		margin-top: 0.85rem;
		padding-top: 0.85rem;
		border-top: 1px solid color-mix(in srgb, var(--border-default) 75%, transparent 25%);
	}

	.popover-label {
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--text-muted);
	}

	.popover-stat {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 0.55rem;
		font-size: var(--text-sm);
		color: var(--text-primary);
	}

	.popover-cost-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		margin-top: 0.45rem;
	}

	.popover-cost-hero {
		font-size: var(--text-base, 0.95rem);
		font-weight: 600;
		color: var(--accent);
		/* Keep "$x · yK tokens" together on one line. */
		white-space: nowrap;
	}

	/* Secondary "Last turn" line — muted and smaller than the hero. */
	.popover-cost-row--secondary {
		margin-top: 0.2rem;
	}

	.popover-cost-secondary-label {
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-muted);
	}

	.popover-cost-secondary {
		font-size: var(--text-xs);
		color: var(--text-muted);
	}

	/* Context room bar — the bar communicates remaining capacity, so the old
	   "plenty left" sub-text is removed; the percent speaks for itself. Sits
	   directly under the "Context" subtitle; the exact prompt-tokens /
	   context-window figures and their source (provider-reported or
	   estimated) live in a hover tooltip instead of a permanent row. */
	.popover-context-room {
		position: relative;
		margin-top: 0.55rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--border-default) 82%);
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--accent) 6%, var(--surface-elevated) 94%);
	}

	.popover-context-room-tooltip {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		width: max-content;
		max-width: 16rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		padding: var(--space-sm) var(--space-md);
		opacity: 0;
		visibility: hidden;
		transform: translateY(4px);
		transition:
			opacity var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out),
			visibility var(--duration-standard);
		pointer-events: none;
		z-index: 10;
	}

	.popover-context-room-tooltip-container:hover .popover-context-room-tooltip {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
	}

	.popover-context-room-tooltip-label {
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.popover-context-room-tooltip-value {
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}

	.popover-context-room-tooltip-source {
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.popover-context-room--near {
		border-color: color-mix(in srgb, var(--warning) 38%, var(--border-default) 62%);
		background: color-mix(in srgb, var(--warning) 9%, var(--surface-elevated) 91%);
	}

	.popover-context-room-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 0.35rem;
	}

	.popover-context-room-pct {
		font-size: var(--text-xs);
		color: var(--text-primary);
	}

	.popover-context-room--near .popover-context-room-pct {
		color: var(--warning-hover);
		font-weight: 600;
	}

	.popover-context-room-bar {
		height: 5px;
		overflow: hidden;
		border-radius: 999px;
		background: color-mix(in srgb, var(--border-default) 60%, transparent 40%);
	}

	.popover-context-room-fill {
		height: 100%;
		border-radius: 999px;
		background: var(--accent);
		transition: width var(--duration-standard) var(--ease-out);
	}

	.popover-context-room--near .popover-context-room-fill {
		background: var(--warning);
	}

	.popover-near-trigger {
		margin: 0.4rem 0 0;
		font-size: var(--text-xs);
		color: var(--warning-hover);
		line-height: 1.4;
	}

	.compaction-active {
		color: var(--accent);
	}

	.popover-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.65rem;
	}

	.popover-chip {
		border: 1px solid color-mix(in srgb, var(--border-default) 75%, transparent 25%);
		border-radius: 9999px;
		padding: 0.25rem 0.5rem;
		font-size: var(--text-2xs);
		text-transform: capitalize;
		color: var(--text-muted);
	}

	.popover-empty {
		margin-top: 0.5rem;
		font-size: var(--text-sm);
		color: var(--text-muted);
	}
</style>
