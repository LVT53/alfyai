<script lang="ts">
// THE chip (chips redesign, owner-approved boards 2026-09-15). One pill for
// everything the composer and the stream have to name:
//
//   [14px stroke icon] · label · optional muted meta · 20px ×
//
// 999px radius, 28px tall in the composer and 22px inside a message. Kind is
// carried by the icon and — for a skill or Atlas only — a 7% tint; never by
// the shape and never by an uppercase eyebrow. The label is sentence case in
// the user's own words (a skill name, a filename, the first clause of a
// quote), ellipsised and never wrapped; the meta sits after a middle dot and
// is dropped (ellipsised) BEFORE the label when the row runs out of room,
// which is what the lopsided `flex` shrink factors below buy.
//
// There is exactly one control inside a chip: the remove ×. Anything else a
// chip used to carry (the Atlas notify bell) is a disclosure BESIDE it — see
// ComposerChipRow's `after` snippet and MessageInput's Atlas chip.
import {
	Clock,
	FileText,
	Globe,
	Image as ImageIcon,
	Library,
	Orbit,
	Quote,
	Sparkles,
	X,
} from "@lucide/svelte";
import { getContext, tick } from "svelte";
import {
	COMPOSER_CHIP_ROW_CONTEXT,
	type ComposerChipKind,
	type ComposerChipRowContext,
	composerChipTint,
	composerChipUsesThumbnail,
} from "./composer-chip-kinds";

let {
	kind,
	label,
	meta = null,
	thumbnailUrl = null,
	size = "composer",
	removable = false,
	removeLabel = "",
	onRemove,
	onActivate,
	activateLabel = "",
	status = null,
	disabled = false,
	dashed = false,
	testId,
}: {
	kind: ComposerChipKind;
	label: string;
	/** Muted clause after the middle dot. Truncated before the label. */
	meta?: string | null;
	/** Object URL / preview endpoint for an image attachment's 18px crop. */
	thumbnailUrl?: string | null;
	size?: "composer" | "message";
	removable?: boolean;
	removeLabel?: string;
	onRemove?: (() => void) | undefined;
	/** Makes the chip's body a button (an attachment opens its workspace). */
	onActivate?: (() => void) | undefined;
	activateLabel?: string;
	/** A short danger clause (e.g. "Unavailable") shown after the meta. */
	status?: string | null;
	disabled?: boolean;
	/** The queued chip's dashed edge — "waiting", not "attached". */
	dashed?: boolean;
	testId?: string | undefined;
} = $props();

let tint = $derived(composerChipTint(kind));
let showThumbnail = $derived(composerChipUsesThumbnail(kind, thumbnailUrl));
// An image whose thumbnail fails to load (revoked object URL, 404 preview)
// must not leave a broken-image box in the pill: it falls back to the same
// stroke-icon mark every other kind uses.
let thumbnailBroken = $state(false);
// A new source is a new chance: the flag belongs to the URL that failed,
// not to the chip.
$effect(() => {
	void thumbnailUrl;
	thumbnailBroken = false;
});
let thumbnailVisible = $derived(showThumbnail && !thumbnailBroken);
let iconSize = $derived(size === "message" ? 12 : 14);
let isInteractive = $derived(Boolean(onActivate) && !disabled);

const rowContext = getContext<ComposerChipRowContext | undefined>(
	COMPOSER_CHIP_ROW_CONTEXT,
);
let removeButton = $state<HTMLButtonElement | null>(null);

function handleRemove(event: MouseEvent) {
	event.stopPropagation();
	if (disabled) return;
	onRemove?.();
}

// Keyboard removal: with the chip's × focused — the chip's own focus stop —
// Delete or Backspace removes it, so a chip row is navigable end to end
// without reaching for the mouse. The element under the caret is about to
// leave the DOM, so focus is handed on first: to the next chip's × (or the
// previous one's), and when this was the last chip, to wherever the row says
// (the composer's textarea). Otherwise focus would land on <body>.
function handleKeydown(event: KeyboardEvent) {
	if (!removable || disabled || !onRemove) return;
	if (event.key !== "Delete" && event.key !== "Backspace") return;
	event.preventDefault();
	event.stopPropagation();
	const successor = nextRemoveControl();
	onRemove();
	void tick().then(() => {
		if (successor?.isConnected) {
			successor.focus();
		} else {
			rowContext?.focusFallback();
		}
	});
}

function nextRemoveControl(): HTMLElement | null {
	const item = removeButton?.closest("li") ?? removeButton?.parentElement;
	if (!item) return null;
	const sibling = item.nextElementSibling ?? item.previousElementSibling;
	return sibling?.querySelector<HTMLElement>(".composer-chip__remove") ?? null;
}

function handleActivate() {
	if (!isInteractive) return;
	onActivate?.();
}

function handleBodyKeydown(event: KeyboardEvent) {
	if (!isInteractive) return;
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	onActivate?.();
}
</script>

<span
	class="composer-chip"
	class:composer-chip--accent={tint === 'accent'}
	class:composer-chip--warning={tint === 'warning'}
	class:composer-chip--message={size === 'message'}
	class:composer-chip--quote={kind === 'quote'}
	class:composer-chip--dashed={dashed}
	class:composer-chip--disabled={disabled}
	class:composer-chip--interactive={isInteractive}
	data-chip-kind={kind}
	data-chip-tint={tint}
	data-chip-size={size}
	data-testid={testId}
>
	<svelte:element
		this={isInteractive ? 'button' : 'span'}
		class="composer-chip__body"
		type={isInteractive ? 'button' : undefined}
		role={isInteractive ? undefined : 'presentation'}
		tabindex={isInteractive ? 0 : undefined}
		aria-label={isInteractive ? (activateLabel || label) : undefined}
		onclick={isInteractive ? handleActivate : undefined}
		onkeydown={isInteractive ? handleBodyKeydown : undefined}
	>
		{#if thumbnailVisible}
			<img
				class="composer-chip__thumb"
				src={thumbnailUrl}
				alt=""
				aria-hidden="true"
				onerror={() => (thumbnailBroken = true)}
			/>
		{:else}
			<span class="composer-chip__icon" aria-hidden="true">
				{#if kind === 'skill'}
					<Sparkles size={iconSize} strokeWidth={2} />
				{:else if kind === 'web'}
					<Globe size={iconSize} strokeWidth={2} />
				{:else if kind === 'atlas'}
					<Orbit size={iconSize} strokeWidth={2} />
				{:else if kind === 'quote'}
					<Quote size={iconSize} strokeWidth={2} />
				{:else if kind === 'library'}
					<Library size={iconSize} strokeWidth={2} />
				{:else if kind === 'queued'}
					<Clock size={iconSize} strokeWidth={2} />
				{:else if kind === 'image'}
					<ImageIcon size={iconSize} strokeWidth={2} />
				{:else}
					<FileText size={iconSize} strokeWidth={2} />
				{/if}
			</span>
		{/if}
		<span class="composer-chip__label">{label}</span>
		{#if meta}
			<span class="composer-chip__meta" data-testid="composer-chip-meta">· {meta}</span>
		{/if}
		{#if status}
			<span class="composer-chip__status">{status}</span>
		{/if}
	</svelte:element>
	{#if removable && onRemove}
		<button
			bind:this={removeButton}
			type="button"
			class="composer-chip__remove"
			aria-label={removeLabel || label}
			disabled={disabled}
			onclick={handleRemove}
			onkeydown={handleKeydown}
		>
			<X size={13} strokeWidth={2} aria-hidden="true" />
		</button>
	{/if}
</span>

<style lang="postcss">
	/* The recipe is the board's, expressed against the app's own tokens: the
	   border and fill are one `color-mix` off a single `--chip-ink`, so a
	   tinted chip and a neutral chip are literally the same rule. */
	.composer-chip {
		--chip-ink: var(--text-muted);
		display: inline-flex;
		align-items: center;
		gap: 2px;
		box-sizing: border-box;
		min-width: 0;
		max-width: 280px;
		height: 28px;
		padding: 0 4px 0 9px;
		border: 1px solid color-mix(in srgb, var(--chip-ink) 26%, var(--border-default) 74%);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--chip-ink) 7%, var(--surface-page) 93%);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			opacity var(--duration-standard) var(--ease-out);
	}

	.composer-chip--accent {
		--chip-ink: var(--accent);
	}

	.composer-chip--warning {
		--chip-ink: var(--warning);
	}

	.composer-chip--dashed {
		border-style: dashed;
		background: transparent;
	}

	.composer-chip--disabled {
		opacity: 0.45;
	}

	.composer-chip:hover {
		background: color-mix(in srgb, var(--chip-ink) 13%, var(--surface-page) 87%);
		border-radius: var(--radius-full);
	}

	.composer-chip--dashed:hover {
		background: color-mix(in srgb, var(--chip-ink) 8%, transparent);
	}

	.composer-chip--disabled:hover {
		background: color-mix(in srgb, var(--chip-ink) 7%, var(--surface-page) 93%);
	}

	/* The body holds the mark, the label and the meta. It is a <span> for a
	   plain chip and a <button> for an attachment that opens its workspace —
	   either way it never contains the ×, so a chip has exactly one control
	   even when its body is clickable. */
	.composer-chip__body {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		height: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		letter-spacing: inherit;
		text-align: left;
	}

	.composer-chip__body:is(button) {
		cursor: pointer;
	}

	.composer-chip__body:focus-visible {
		outline: none;
		border-radius: var(--radius-full);
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.composer-chip__icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--chip-ink);
	}

	/* An image attachment's real crop — the only colour a neutral chip has. */
	.composer-chip__thumb {
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		border-radius: 4px;
		object-fit: cover;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 12%, transparent);
	}

	.composer-chip__label {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-weight: 600;
	}

	/* `flex-shrink: 20` against the label's 1: the meta gives up its width
	   first, so "Overview · ~2-5 min" degrades to "Overview · ~2…" long
	   before the skill's own name starts disappearing. */
	.composer-chip__meta {
		flex: 0 20 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--text-muted);
		font-size: var(--text-2xs);
		font-weight: 400;
	}

	.composer-chip__status {
		flex: 0 0 auto;
		color: var(--danger);
		font-size: var(--text-2xs);
		font-weight: 600;
	}

	.composer-chip__remove {
		display: inline-grid;
		place-items: center;
		position: relative;
		flex: 0 0 auto;
		width: 20px;
		height: 20px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	/* The drawn size stays 20px; the TOUCH target is 44px, painted by a
	   pseudo-element so it cannot change the pill's geometry. */
	.composer-chip__remove::after {
		content: "";
		position: absolute;
		top: 50%;
		left: 50%;
		width: 44px;
		height: 44px;
		transform: translate(-50%, -50%);
	}

	@media (pointer: fine) {
		.composer-chip__remove::after {
			width: 20px;
			height: 20px;
		}
	}

	.composer-chip__remove:hover,
	.composer-chip__remove:focus-visible {
		background: color-mix(in srgb, var(--chip-ink) 16%, transparent);
		border-radius: var(--radius-full);
		color: var(--chip-ink);
	}

	.composer-chip__remove:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.composer-chip__remove:active {
		transform: scale(0.94);
	}

	.composer-chip__remove:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* In a message: the same pill six pixels shorter and one type step down.
	   Nothing else is redrawn — and it is never removable, because it is a
	   record of what happened rather than a promise about the next turn. */
	.composer-chip--message {
		height: 22px;
		padding: 0 8px;
		gap: 5px;
		font-size: var(--text-2xs);
	}

	.composer-chip--message .composer-chip__body {
		gap: 5px;
	}

	.composer-chip--message .composer-chip__meta {
		font-size: 0.68rem;
	}

	.composer-chip--message .composer-chip__thumb {
		width: 14px;
		height: 14px;
		border-radius: 3px;
	}

	/* A quote wears the serif the message body is set in, so the words read
	   as the document's rather than the app's. */
	.composer-chip--quote .composer-chip__label {
		font-family: var(--font-serif);
		font-weight: 400;
	}

	/* On the user bubble the surface is already elevated, so a neutral chip
	   needs two more points of tint to separate from it. */
	:global(.composer-chip-on-bubble) .composer-chip {
		background: color-mix(in srgb, var(--chip-ink) 9%, var(--surface-page) 91%);
	}
</style>
