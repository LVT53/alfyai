<script lang="ts">
/**
 * A read-aloud note (spec §4.8): calm for something that is not wrong (a
 * language with no voice, a busy voice, offline), amber when the voice failed.
 * Amber, never red: red is for actions where the person loses something.
 * Anchored above the speaker in a reply's row, below it in a panel's header (no
 * room above), or centred above the player; in the voice editor it sits in the
 * flow at full width (`inline`).
 */
import { CircleAlert, Clock, WifiOff, X } from "@lucide/svelte";
import { t } from "$lib/i18n";

let {
	tone,
	icon,
	text,
	actionLabel = undefined,
	onAction = undefined,
	onDismiss = undefined,
	placement,
}: {
	tone: "calm" | "warn";
	icon: "alert" | "clock" | "wifi";
	text: string;
	actionLabel?: string;
	onAction?: () => void;
	onDismiss?: () => void;
	placement: "speaker" | "header" | "player" | "inline";
} = $props();
</script>

<div class="read-aloud-note" class:warn={tone === "warn"} data-placement={placement} role="status">
	<span class="read-aloud-note-icon" aria-hidden="true">
		{#if icon === "alert"}
			<CircleAlert size={15} strokeWidth={2} />
		{:else if icon === "clock"}
			<Clock size={15} strokeWidth={2} />
		{:else}
			<WifiOff size={15} strokeWidth={2} />
		{/if}
	</span>
	<span class="read-aloud-note-body">
		<span class="read-aloud-note-text">{text}</span>
		{#if actionLabel && onAction}
			<button type="button" class="read-aloud-note-action" onclick={onAction}>{actionLabel}</button>
		{/if}
	</span>
	{#if onDismiss}
		<button
			type="button"
			class="read-aloud-note-dismiss"
			aria-label={$t("readAloud.dismiss")}
			onclick={onDismiss}
		>
			<X size={14} strokeWidth={2} aria-hidden="true" />
		</button>
	{/if}
</div>

<style>
	.read-aloud-note {
		position: absolute;
		bottom: calc(100% + 8px);
		z-index: 40;
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: max-content;
		max-width: min(330px, calc(100vw - 2rem));
		padding: 9px 10px 9px 12px;
		border: 1px solid var(--border-default);
		border-radius: 12px;
		/* The raised surface of the row's tooltips: in the dark theme the page's own
		   surface melts into the thread. */
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 12.5px;
		line-height: 1.45;
		text-align: left;
		white-space: normal;
	}

	/* In a dialog's flow (the voice editor's Listen section): full width, no lift. */
	.read-aloud-note[data-placement="inline"] {
		position: relative;
		bottom: auto;
		z-index: auto;
		width: 100%;
		max-width: none;
		box-shadow: none;
	}

	.read-aloud-note[data-placement="speaker"] {
		left: 0;
	}

	/* Below a header's speaker, from its right edge, so it stays inside the panel. */
	.read-aloud-note[data-placement="header"] {
		top: calc(100% + 8px);
		right: 0;
		bottom: auto;
		left: auto;
		transform: none;
	}

	.read-aloud-note[data-placement="player"] {
		left: 50%;
		transform: translateX(-50%);
		align-items: center;
		border-radius: 999px;
		padding: 6px 8px 6px 11px;
		white-space: nowrap;
		max-width: calc(100% - 8px);
	}

	@media (max-width: 767px) {
		.read-aloud-note[data-placement="player"] {
			width: calc(100% - 8px);
			border-radius: 14px;
			white-space: normal;
		}
	}

	.read-aloud-note-icon {
		display: inline-flex;
		flex: none;
		margin-top: 1px;
		color: var(--text-muted);
	}

	.warn .read-aloud-note-icon {
		color: var(--warning-text);
	}

	.read-aloud-note-body {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: 10px;
		row-gap: 4px;
	}

	.read-aloud-note-action {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.read-aloud-note-dismiss {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		padding: 0 0 0 4px;
		border: 0;
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}

	.read-aloud-note-action:focus-visible,
	.read-aloud-note-dismiss:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
		border-radius: 4px;
	}
</style>
