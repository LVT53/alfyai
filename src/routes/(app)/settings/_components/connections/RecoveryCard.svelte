<script lang="ts">
// Connections redesign — the shape every failure takes: an icon, a title
// naming what happened, a sentence saying what was and was not changed, an
// optional body, and the one action that fixes it.
//
// Four of the states this renders did not exist at all before. A failed load
// showed the same "No connections yet" card as a genuinely empty account; a
// failed toggle snapped back in silence; a blocked pop-up left the Nextcloud
// flow stuck with no message; a partial OAuth grant said nothing whatsoever.
import type { AlertTriangle } from "@lucide/svelte";
import type { Snippet } from "svelte";
import { slide } from "svelte/transition";
import { reducedMotionAware } from "$lib/utils/motion";

export type RecoveryTone = "danger" | "warn" | "info";

// Any Lucide glyph. Typed off one of them rather than a hand-written
// signature so it stays correct if the icon package's props change.
type IconComponent = typeof AlertTriangle;

let {
	tone = "danger",
	icon,
	title,
	body,
	primaryLabel,
	primaryIcon,
	onPrimary,
	secondaryLabel,
	onSecondary,
	extra,
	testId,
}: {
	tone?: RecoveryTone;
	// Passed in rather than mapped from `tone` so a state can pick the glyph
	// that actually describes it (a blocked pop-up is a "ban", a partial grant
	// is an "info", neither is a generic triangle).
	icon?: IconComponent;
	title: string;
	body: string;
	primaryLabel?: string;
	primaryIcon?: IconComponent;
	onPrimary?: () => void | Promise<void>;
	secondaryLabel?: string;
	onSecondary?: () => void;
	/** Anything the specific state needs between the body and the buttons. */
	extra?: Snippet;
	testId?: string;
} = $props();

// Applied as `transition:` (not `in:`) so a dismissed card leaves as
// deliberately as it arrived — see ToolActivityRow for the same pattern.
const cardSlide = reducedMotionAware(slide);
</script>

<section
	class="recovery-card"
	data-tone={tone}
	data-testid={testId}
	role="status"
	transition:cardSlide={{ duration: 200 }}
>
	<div class="recovery-head">
		{#if icon}
			{@const Icon = icon}
			<span class="recovery-icon" aria-hidden="true">
				<Icon size={17} strokeWidth={2} />
			</span>
		{/if}
		<h3 class="recovery-title">{title}</h3>
	</div>
	<p class="recovery-body">{body}</p>
	{#if extra}
		<div class="recovery-extra">{@render extra()}</div>
	{/if}
	{#if primaryLabel || secondaryLabel}
		<div class="recovery-actions">
			{#if primaryLabel}
				<button type="button" class="btn-primary text-xs" onclick={() => onPrimary?.()}>
					{#if primaryIcon}
						{@const PrimaryIcon = primaryIcon}
						<PrimaryIcon size={14} strokeWidth={2} aria-hidden="true" />
					{/if}
					{primaryLabel}
				</button>
			{/if}
			{#if secondaryLabel}
				<button type="button" class="recovery-ghost" onclick={() => onSecondary?.()}>
					{secondaryLabel}
				</button>
			{/if}
		</div>
	{/if}
</section>

<style>
	.recovery-card {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-page);
		padding: 1rem 1.125rem;
	}

	.recovery-card[data-tone='danger'] {
		border-color: color-mix(in srgb, var(--danger) 32%, transparent);
		background: color-mix(in srgb, var(--danger) 5%, var(--surface-page));
	}

	.recovery-card[data-tone='warn'] {
		border-color: color-mix(in srgb, var(--warning) 32%, transparent);
		background: color-mix(in srgb, var(--warning) 6%, var(--surface-page));
	}

	.recovery-card[data-tone='info'] {
		border-color: color-mix(in srgb, var(--accent) 28%, transparent);
		background: color-mix(in srgb, var(--accent) 5%, var(--surface-page));
	}

	.recovery-head {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
	}

	.recovery-icon {
		display: inline-flex;
		margin-top: 0.0625rem;
		flex-shrink: 0;
	}

	[data-tone='danger'] .recovery-icon {
		color: var(--danger);
	}

	[data-tone='warn'] .recovery-icon {
		color: var(--warning);
	}

	[data-tone='info'] .recovery-icon {
		color: var(--accent);
	}

	.recovery-title {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		line-height: 1.35;
	}

	.recovery-body {
		margin: 0.5rem 0 0 0;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.recovery-extra {
		margin-top: 0.75rem;
	}

	.recovery-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.875rem;
	}

	.recovery-actions :global(.btn-primary) {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.recovery-ghost {
		border: none;
		background: transparent;
		padding: 0.375rem 0.5rem;
		border-radius: var(--radius-md);
		font-size: 0.8125rem;
		color: var(--text-secondary);
		cursor: pointer;
		transition: color var(--duration-standard), background var(--duration-standard);
	}

	.recovery-ghost:hover {
		color: var(--text-primary);
		background: var(--surface-overlay);
	}

	.recovery-ghost:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
