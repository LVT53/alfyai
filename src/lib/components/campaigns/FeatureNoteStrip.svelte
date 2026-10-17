<script lang="ts">
/**
 * One feature note, as the landing strip draws it.
 *
 * Presentational only: the shell owns eligibility, the showing event and the
 * terminal completion calls, and hands this component callbacks. The note is
 * a labelled region, not a dialog — no scrim, no focus trap, no autofocus.
 * The admin preview renders the same card with `preview`, inside an inert
 * wrapper (Task 3), so its X and CTA stay visible but do nothing.
 */
import { ArrowRight, Sparkles, X } from "@lucide/svelte";
import { cubicOut } from "svelte/easing";
import { fly } from "svelte/transition";
import {
	INTERNAL_ACTION_PREFIX,
	isAllowedActionDestination,
} from "$lib/campaign-action-destinations";
import type { CampaignLocale, FeatureNote } from "$lib/client/api/campaigns";
import { t } from "$lib/i18n";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";

let {
	note,
	locale = "en",
	preview = false,
	onDismiss,
	onAction,
}: {
	note: FeatureNote;
	locale?: CampaignLocale;
	preview?: boolean;
	onDismiss?: () => void;
	onAction?: (destination: string) => void;
} = $props();

const titleId = $props.id();
const noteEnter = reducedMotionAware(fly);

// The reader's language first, the other one only as a defensive fallback: a
// published note always carries both, and a draft preview may not yet.
function localized(
	value: { en: string; hu: string } | null | undefined,
): string {
	if (!value) return "";
	const preferred = value[locale]?.trim();
	if (preferred) return preferred;
	return value[locale === "hu" ? "en" : "hu"]?.trim() ?? "";
}

let title = $derived(localized(note.title));
let body = $derived(localized(note.body));
let actionLabel = $derived(localized(note.actionLabel));

/**
 * The stored destination is admin-authored data that becomes a navigation
 * target for every reader, so the shared allow-list is checked here as well
 * as at publish time. A note never uses an `internal:` action: notes link to
 * app routes only (the campaign modal owns in-app actions).
 */
let actionDestination = $derived((note.actionDestination ?? "").trim());
let hasAction = $derived(
	actionDestination.length > 0 &&
		!actionDestination.startsWith(INTERNAL_ACTION_PREFIX) &&
		isAllowedActionDestination(actionDestination) &&
		actionLabel.length > 0,
);

/**
 * The live region mounts empty and receives its text in this effect: a
 * `role="status"` that already carries text when it mounts is commonly not
 * announced, while a later text change on the mounted region is. The card is
 * one line for sighted readers; this is how a screen reader is told what
 * arrived.
 */
let announcement = $state("");
$effect(() => {
	announcement = title ? $t("featureNote.announcement", { title }) : "";
});

function dismiss(): void {
	if (preview) return;
	onDismiss?.();
}

// No preventDefault: the `<a>` itself navigates, and the shell's callback
// only latches the note and writes the terminal state before it does.
function followAction(): void {
	if (preview || !hasAction) return;
	onAction?.(actionDestination);
}
</script>

<!-- svelte-ignore a11y_no_redundant_roles -- the note is specified as an
     explicit named region; keeping the role on the section makes that contract
     visible in the markup rather than relying on the implicit mapping. -->
<section
	class="feature-note"
	role="region"
	aria-labelledby={title ? titleId : undefined}
	aria-label={title ? undefined : $t("featureNote.region")}
	data-testid="feature-note"
	in:noteEnter={{ y: -8, duration: MOTION_DURATION.emphasis, easing: cubicOut }}
>
	<!-- The sparkle tile is the card's only "new" signal. It is decorative;
	     a screen reader gets the same signal from the live line. -->
	<div class="feature-note-tile" aria-hidden="true">
		<Sparkles size={24} strokeWidth={1.8} />
	</div>

	<div class="feature-note-copy">
		<h2 class="feature-note-title" id={titleId}>{title}</h2>
		{#if hasAction}
			<div class="feature-note-line">
				<p class="feature-note-body">{body}</p>
				<a class="feature-note-cta" href={actionDestination} onclick={followAction}>
					{actionLabel}<ArrowRight size={13} strokeWidth={2.4} aria-hidden="true" />
				</a>
			</div>
		{:else}
			<p class="feature-note-body">{body}</p>
		{/if}
	</div>

	<button
		type="button"
		class="feature-note-close"
		aria-label={$t("featureNote.dismiss")}
		title={$t("featureNote.dismiss")}
		onclick={dismiss}
	>
		<X size={14} strokeWidth={2} aria-hidden="true" />
	</button>

	<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
		{announcement}
	</p>
</section>

<style>
	.feature-note {
		position: relative;
		display: grid;
		grid-template-columns: 42px minmax(0, 1fr) 32px;
		align-items: start;
		gap: 12px;
		width: 100%;
		max-width: 620px;
		padding: 10px 12px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-lg);
		color: var(--text-primary);
		font-family: var(--font-sans);
	}

	/* The tile: a dotted 42px square, not an uploaded image. */
	.feature-note-tile {
		display: grid;
		place-items: center;
		width: 42px;
		height: 42px;
		overflow: hidden;
		border: 1px solid var(--border-default);
		border-radius: 7px;
		background-color: var(--surface-page);
		background-image: radial-gradient(
			color-mix(in srgb, var(--text-muted) 32%, transparent) 1px,
			transparent 1px
		);
		background-size: 7px 7px;
		color: var(--accent);
	}

	.feature-note-copy {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
		padding-top: 1px;
	}

	.feature-note-title {
		min-width: 0;
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-serif);
		font-size: 15px;
		font-weight: 400;
		line-height: 1.3;
	}

	/* A body with no action still needs its one line of breathing room. */
	.feature-note-copy > .feature-note-body {
		margin-top: 2px;
	}

	/* The sentence and the action share one row: the body takes what it
	   needs, the action stays at the end of it. No third line. */
	.feature-note-line {
		display: flex;
		align-self: stretch;
		align-items: baseline;
		justify-content: flex-start;
		gap: 7px;
		min-width: 0;
		margin-top: 2px;
	}

	.feature-note-body {
		min-width: 0;
		margin: 0;
		color: var(--text-muted);
		font-size: 13px;
		line-height: 1.45;
	}

	/* The action is its own control: a link at the end of the body row,
	   never a continuation of the sentence. */
	.feature-note-cta {
		display: inline-flex;
		flex: none;
		align-items: baseline;
		gap: 4px;
		padding: 2px 0;
		border-radius: var(--radius-sm);
		color: var(--accent-text);
		font-size: 12.5px;
		font-weight: 600;
		white-space: nowrap;
		text-decoration: none;
	}

	.feature-note-cta:hover {
		color: var(--accent);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 2px;
	}

	.feature-note-cta:focus-visible,
	.feature-note-close:focus-visible {
		outline: 2px solid var(--border-focus);
		outline-offset: 2px;
	}

	.feature-note-close {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		margin: -5px -5px 0 0;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.feature-note-close:hover {
		background: var(--surface-overlay);
		color: var(--text-primary);
	}

	/* The phone card loses the desktop padding and gap; the words stay the
	   same size so the one-line body still fits beside the action. */
	@media (max-width: 640px) {
		.feature-note {
			gap: 10px;
			padding: 7px 10px;
		}

		.feature-note-tile {
			width: 40px;
			height: 40px;
		}
	}
</style>
