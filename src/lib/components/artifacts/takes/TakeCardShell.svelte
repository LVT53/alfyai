<script lang="ts">
// The one shell of a picture or video card under `ArtifactCard`'s head (the
// one-shell waiver in docs/plans/ltx-video): the stage reserved from the
// take's shape, the layers stacked in it (gone, the result, the shimmer, the
// state box with Try again), the sr-only status, the actions row (Another,
// Stop in the shared slot, "…") and the More menu. The kind's body draws only
// what is its own, through the snippets: the picture or the player, the stage's
// chips, a takes strip, Use this, and the menu's rows.
//
// Motion (MOTION-PARITY): nothing here changes height when the take changes
// state. The state and the result are layers stacked in the stage that
// crossfade (opacity only). While a take waits, starts or is made the stage
// shows only the shimmer (one layer for all three, so it never restarts) and
// the words are the sr-only status (Task 11). The time is the card's head's to
// show, beside the kind (`onTime`, the owner's call of 17 Nov, option C): this
// shell keeps the countdown and hands its words up.
//
// Everything it shows is worked out in `take-card-view.ts`.
import {
	Ellipsis,
	EyeOff,
	ImageOff,
	RefreshCw,
	TriangleAlert,
	VideoOff,
} from "@lucide/svelte";
import { type Snippet, untrack } from "svelte";
import { fade } from "svelte/transition";
import { t } from "$lib/i18n";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import AnchoredPopover from "../AnchoredPopover.svelte";
import {
	COUNTDOWN_TICK_MS,
	createEtaCountdown,
	goneWords,
	type TakeCardState,
	type TakeKind,
	type TakeLike,
	takeCardState,
	takeStateWords,
	takeTimeLine,
} from "./take-card-view";
import "./take-card.css";

let {
	kind,
	take,
	landed,
	box,
	cardId,
	title,
	gone = null,
	canAct,
	anotherDisabled,
	onAnother,
	onStop,
	onRetry,
	onTime = undefined,
	result,
	stage = undefined,
	below = undefined,
	swap = undefined,
	menu,
}: {
	kind: TakeKind;
	/** The take the card shows; null while it waits for one (an Another the card does not hold yet). */
	take: TakeLike | null;
	/** The shown take's result can be drawn: a picture's file, a clip. */
	landed: boolean;
	/** The stage's shape, kept from the first paint. */
	box: { width: number; height: number };
	cardId: string;
	title: string;
	/**
	 * The item this card is about was deleted, or is out of this chat's reach
	 * (made in the chat this one was forked from). The card keeps its box and
	 * rows, says so in the box, and offers nothing to press.
	 */
	gone?: "deleted" | "unreachable" | null;
	/** A page answers the card's buttons: a button that would do nothing is a disabled one. */
	canAct: boolean;
	anotherDisabled: boolean;
	onAnother: () => void | Promise<void>;
	onStop: () => void;
	onRetry: () => void;
	/**
	 * The words the card's head shows beside the kind while the take is on its
	 * way ("Next up", "About 24 s left", "Almost done…"), null once it is not:
	 * the head is `ArtifactCard`'s, the countdown is this shell's.
	 */
	onTime?: ((words: string | null) => void) | undefined;
	/** The landed result, in the stage's top layer: the picture, or the player. */
	result: Snippet;
	/** Laid over the stage whatever it shows (a kind's own chips). */
	stage?: Snippet<[{ ready: boolean }]>;
	/** Between the stage and the actions row (a takes strip, "Made from"). */
	below?: Snippet<[{ now: number }]>;
	/** The kind's own button in Stop's slot, after it (Use this). */
	swap?: Snippet<[{ ready: boolean }]>;
	/** The More menu's rows. `close` shuts the menu; `ready` says the result is there. */
	menu: Snippet<[{ close: () => void; ready: boolean }]>;
} = $props();

const crossfade = reducedMotionAware(fade);

/** The card's clock: the countdown and the "starting up" line read it. */
let now = $state(Date.now());
/** The shown take's countdown, on this browser's clock (`createEtaCountdown`). */
const countdown = createEtaCountdown();
/** Bumped by every reading, so the countdown is read again once it is re-aimed. */
let readings = $state(0);
let menuOpen = $state(false);

let cardState: TakeCardState = $derived(
	take
		? takeCardState(take, now, kind, landed)
		: { kind: "waiting", ahead: null },
);
let words = $derived(takeStateWords(cardState, kind, $t));
let ready = $derived(!gone && cardState.kind === "ready");
/**
 * Waiting, starting up and being made are one look: the shimmer, kept as one
 * layer from the first state to the last, so it never restarts between them.
 */
let busy = $derived(
	!gone &&
		(cardState.kind === "waiting" ||
			cardState.kind === "starting" ||
			cardState.kind === "making"),
);
let canRetry = $derived(
	take !== null &&
		(cardState.kind === "failed" ||
			cardState.kind === "stopped" ||
			(cardState.kind === "blocked" && cardState.unchecked)),
);
let GoneIcon = $derived(kind === "video" ? VideoOff : ImageOff);
let menuAnchorId = $derived(`${kind}-card-more-${cardId}`);

// Each reading of the shown take's estimate (every poll) re-aims the countdown.
$effect(() => {
	const current = take;
	if (!current) return;
	countdown.read(
		current.id,
		current.status === "running" ? current.etaSeconds : null,
		Date.now(),
	);
	now = Date.now();
	// The countdown is not reactive itself: a reading that lands in the same
	// millisecond as the last tick must still be shown.
	untrack(() => (readings += 1));
});

// The card's clock ticks while the shown take is running, so the countdown
// moves on its own between polls. Keyed by the take, not its object: every
// poll brings a new object, and the timer must outlive it.
let ticking = $derived(!gone && take?.status === "running" ? take.id : null);
$effect(() => {
	if (!ticking) return;
	const timer = setInterval(() => (now = Date.now()), COUNTDOWN_TICK_MS);
	return () => clearInterval(timer);
});

/** Where the countdown stands: the finish time it counts to, or null. */
let deadline = $derived.by(() => {
	void readings;
	return countdown.at(now);
});
/** The head's words while the take is on its way (`takeTimeLine`). */
let timeLine = $derived(
	busy ? takeTimeLine(cardState, deadline, now, $t) : null,
);
$effect(() => {
	onTime?.(timeLine);
});
/**
 * What the shimmer means, for screen readers. The live region says the state
 * ("Next up", "Making the picture…") and is read out when it changes; the time
 * left, which moves every second, sits beside it outside the live region, so
 * it is there to read but never re-announced (Task 11 fix round 1). It is the
 * head's own words, which are hidden from screen readers there.
 */
let statusText = $derived(busy ? words.line : "");
let statusDetail = $derived(
	!busy || cardState.kind === "waiting" ? "" : (timeLine ?? words.detail ?? ""),
);
</script>

<div class="take-card-body" data-testid="{kind}-card-body" data-state={cardState.kind}>
	<div
		class="take-card-stage"
		style:--box-ratio={box.width / box.height}
		style:aspect-ratio="{box.width} / {box.height}"
		data-testid="{kind}-card-stage"
	>
		{#if gone}
			<!-- The item is gone, or lives in another chat: the box keeps its shape
			     and says so; nothing in the card can be pressed. -->
			<div
				class="take-card-layer take-card-state"
				data-testid="{kind}-card-gone"
				transition:crossfade={{ duration: MOTION_DURATION.standard }}
			>
				<GoneIcon size={20} strokeWidth={1.75} aria-hidden="true" />
				<span class="take-card-state-detail">{goneWords(gone, kind, $t)}</span>
			</div>
		{:else if ready}
			<div class="take-card-layer" transition:crossfade={{ duration: MOTION_DURATION.standard }}>
				{@render result()}
			</div>
		{:else if busy}
			<!-- Waiting, starting up, being made: only a calm light sweeping across
			     the whole box. The words are the sr-only status below. -->
			<div
				class="take-card-layer take-shimmer"
				data-testid="{kind}-card-shimmer"
				aria-hidden="true"
				transition:crossfade={{ duration: MOTION_DURATION.standard }}
			>
				<span class="take-shimmer-band"></span>
			</div>
		{:else}
			{#key cardState.kind}
				<!-- A result the explicit-picture filter kept back is not a failure: a
				     quiet eye-off and two calm lines; Try again only when the check
				     could not run (the same seed would make a blocked result again,
				     and Another is still there for a new one). -->
				<div
					class="take-card-layer take-card-state"
					class:take-card-blocked={cardState.kind === 'blocked'}
					data-testid={cardState.kind === 'blocked' ? `${kind}-card-blocked` : `${kind}-card-state`}
					transition:crossfade={{ duration: MOTION_DURATION.standard }}
				>
					<span class="take-card-state-line">
						{#if cardState.kind === 'failed'}
							<TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
						{:else if cardState.kind === 'blocked'}
							<EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
						{/if}
						<span>{words.line}</span>
					</span>
					<span class="take-card-state-detail">{words.detail ?? ''}</span>
					{#if canRetry}
						<button
							type="button"
							class="take-card-button"
							data-testid="{kind}-card-retry"
							disabled={!canAct}
							onclick={onRetry}
						>
							{$t('artifacts.take.tryAgain')}
						</button>
					{/if}
				</div>
			{/key}
		{/if}
		{@render stage?.({ ready })}
	</div>
	<span class="sr-only" role="status" data-testid="{kind}-card-status">{statusText}</span>
	<span class="sr-only" data-testid="{kind}-card-status-detail">{statusDetail}</span>

	{@render below?.({ now })}

	<div class="take-card-actions" data-testid="{kind}-card-actions">
		<button
			type="button"
			class="take-card-button"
			data-testid="{kind}-card-another"
			disabled={anotherDisabled}
			onclick={() => void onAnother()}
		>
			<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
			{$t('artifacts.take.another')}
		</button>
		<!-- Stop and the kind's own button share one slot (one grid cell): when a
		     take lands, Use this fades in where Stop fades out, and never jumps
		     sideways once Stop has gone (Task 11 fix round 1). -->
		<span class="take-card-swap" data-testid="{kind}-card-swap">
			{#if take && busy}
				<button
					type="button"
					class="take-card-button"
					data-testid="{kind}-card-stop"
					disabled={!canAct}
					transition:crossfade={{ duration: MOTION_DURATION.standard }}
					onclick={onStop}
				>
					{$t('artifacts.take.stop')}
				</button>
			{/if}
			{@render swap?.({ ready })}
		</span>
		<span class="take-card-grow"></span>
		<button
			type="button"
			class="take-card-icon-button"
			aria-label={$t('artifacts.take.more')}
			aria-haspopup="dialog"
			disabled={Boolean(gone)}
			data-testid={menuAnchorId}
			onclick={() => (menuOpen = !menuOpen)}
		>
			<Ellipsis size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
</div>

{#if menuOpen}
	<AnchoredPopover
		{title}
		anchorTestId={menuAnchorId}
		popoverTestId="{kind}-card-menu"
		closeLabel={$t('common.close')}
		width={220}
		boundarySelector=".chat-main"
		onClose={() => (menuOpen = false)}
	>
		<div class="take-card-menu" role="menu" aria-label={$t('artifacts.take.more')}>
			{@render menu({ close: () => (menuOpen = false), ready })}
		</div>
	</AnchoredPopover>
{/if}
