<script lang="ts">
// The picture card's body under `ArtifactCard`'s head (plan 2b T2, design
// 5.3, wireframe frames 1, 2 and 7). Top to bottom: the shown take in a box
// reserved from its known size (or the take's state drawn in the same box),
// the takes strip when there is more than one take, "Made from" for a card
// made from pictures, and the actions (Another, Use this, "…").
//
// Motion (MOTION-PARITY): nothing here changes height when a take changes
// state. The picture box keeps the take's aspect ratio from the first paint;
// the state and the picture are two layers stacked in it that crossfade
// (opacity only); progress moves by `transform: scaleX()` and never goes
// backwards; Before / After floats over the picture, so it takes no row.
// Everything the card shows is worked out in `image-card-view.ts`.
import {
	Check,
	Clock,
	Ellipsis,
	History,
	Download,
	ImageOff,
	LoaderCircle,
	RefreshCw,
	TriangleAlert,
} from "@lucide/svelte";
import { fade } from "svelte/transition";
import { t } from "$lib/i18n";
import { MAX_VISIBLE_TAKES_PER_CARD } from "$lib/shared/artifacts/image-body";
import type {
	ImageCardView,
	ImageTakeView,
} from "$lib/server/services/images/read-model";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import AnchoredPopover from "../AnchoredPopover.svelte";
import {
	etaLabel,
	type ImageCardAction,
	type ImageCardActionHandler,
	type ImageCardState,
	isCheckingAgain,
	STARTING_SHOWN_AFTER_MS,
	shownTake,
	takeState,
	visibleTakes,
} from "./image-card-view";
import BeforeAfterSwitch from "./BeforeAfterSwitch.svelte";
import ImagePicture from "./ImagePicture.svelte";
import "./picture-tile.css";

let {
	card,
	conversationId = null,
	onAction = undefined,
	gone = null,
}: {
	card: ImageCardView;
	conversationId?: string | null;
	onAction?: ImageCardActionHandler | undefined;
	/**
	 * The Image this card is about was deleted, or is out of this chat's reach
	 * (made in the chat this one was forked from). The card keeps its box and
	 * rows, says so in the box, and offers nothing to press.
	 */
	gone?: "deleted" | "unreachable" | null;
} = $props();
/** A new picture's size, for a card that has no take to read one from. */
const FALLBACK_BOX = { width: 1248, height: 832 };
const PLACEHOLDER = "placeholder";

const crossfade = reducedMotionAware(fade);

/** The take the reader chose in the strip, or the Another that is on its way. */
let selectedTakeId = $state<string | null>(null);
let showing = $state<"after" | "before">("after");
let menuOpen = $state(false);
/** Anothers pressed whose take the card does not hold yet. */
let pendingAnothers = $state(0);
/** The takes the card held when the first of them was pressed. */
let takesBeforeAnother = $state.raw<ReadonlySet<string>>(new Set());
/** The clock the "starting up" line reads; ticks only while it can change. */
let now = $state(Date.now());

let takes = $derived(visibleTakes(card));
/**
 * Another's tiles still on their way: one per press, until a take of origin
 * "another" the card did not hold at the press arrives. Only those count, so a
 * held automatic retry joining the card does not take a tile away.
 */
let placeholders = $derived(
	Math.max(
		0,
		pendingAnothers -
			card.takes.filter(
				(take) => take.origin === "another" && !takesBeforeAnother.has(take.id),
			).length,
	),
);
$effect(() => {
	if (pendingAnothers > 0 && placeholders === 0) pendingAnothers = 0;
});

/**
 * An Another the card does not hold yet is shown as waiting, in the place it
 * will take, whether the reader is still on its placeholder or the page has
 * already named the take it queued.
 */
let waitingForAnother = $derived(
	placeholders > 0 &&
		(selectedTakeId === PLACEHOLDER ||
			(selectedTakeId !== null &&
				!card.takes.some((take) => take.id === selectedTakeId))),
);
let shown = $derived(
	waitingForAnother
		? null
		: shownTake(card, selectedTakeId === PLACEHOLDER ? null : selectedTakeId),
);
let cardState: ImageCardState = $derived(
	waitingForAnother
		? { kind: "waiting", ahead: null }
		: shown
			? takeState(shown, now)
			: { kind: "waiting", ahead: null },
);
let box = $derived(
	shown?.box ?? takes.at(-1)?.box ?? card.takes.at(-1)?.box ?? FALLBACK_BOX,
);
let ready = $derived(
	!gone && cardState.kind === "ready" && Boolean(shown?.fileId),
);
let checkingAgain = $derived(ready && isCheckingAgain(card, shown));
let canFlip = $derived(Boolean(ready && shown?.baseFileId));
let stripCount = $derived(takes.length + placeholders);
let canUse = $derived(
	Boolean(
		shown &&
			ready &&
			!gone &&
			!shown.held &&
			shown.id !== card.pickedTakeId &&
			shown.status === "succeeded",
	),
);
let madeFromIds = $derived(
	card.madeFrom === "pictures"
		? (shown?.sourceFileIds ?? card.takes[0]?.sourceFileIds ?? [])
		: [],
);
let anotherDisabled = $derived(
	Boolean(gone) || stripCount >= MAX_VISIBLE_TAKES_PER_CARD,
);

// Before / After is about the shown take: a new take starts on After.
$effect(() => {
	void shown?.id;
	showing = "after";
});

// "Starting up" shows once a take has sat in its starting phase for a while:
// the clock ticks once a second only until then.
$effect(() => {
	const take = shown;
	if (
		!take ||
		take.status !== "running" ||
		take.phase !== "starting" ||
		take.phaseAt === null
	) {
		return;
	}
	const phaseAt = take.phaseAt;
	now = Date.now();
	if (now - phaseAt >= STARTING_SHOWN_AFTER_MS) return;
	const timer = setInterval(() => {
		now = Date.now();
		if (now - phaseAt >= STARTING_SHOWN_AFTER_MS) clearInterval(timer);
	}, 1000);
	return () => clearInterval(timer);
});

/** Progress never goes backwards for one take, whatever a poll reports: the best seen per take. */
let progressSeen = $state.raw<Record<string, number>>({});
let progress = $derived.by(() => {
	if (cardState.kind !== "making" || !shown) return 0;
	const reported = Math.max(0, Math.min(100, cardState.progressPercent ?? 0));
	return Math.max(progressSeen[shown.id] ?? 0, reported);
});
$effect.pre(() => {
	const id = shown?.id;
	if (!id || progress <= (progressSeen[id] ?? 0)) return;
	progressSeen = { ...progressSeen, [id]: progress };
});

function send(action: ImageCardAction) {
	return onAction?.(action);
}

/**
 * An action the card does not wait on. The page has already said what went
 * wrong (its toast); the rejection is caught here so it never reaches the
 * window as an unhandled one.
 */
function fire(action: ImageCardAction): void {
	void send(action)?.catch(() => undefined);
}

function chooseTake(id: string): void {
	selectedTakeId = id;
}

async function pressAnother(): Promise<void> {
	if (anotherDisabled) return;
	if (pendingAnothers === 0) {
		takesBeforeAnother = new Set(card.takes.map((take) => take.id));
	}
	pendingAnothers += 1;
	selectedTakeId = PLACEHOLDER;
	try {
		const result = await send({ type: "another", cardId: card.id });
		if (result?.takeId && selectedTakeId === PLACEHOLDER) {
			selectedTakeId = result.takeId;
		}
	} catch {
		pendingAnothers = Math.max(0, pendingAnothers - 1);
		if (selectedTakeId === PLACEHOLDER) selectedTakeId = null;
	}
}

function pressUse(): void {
	if (shown && canUse) fire({ type: "use", takeId: shown.id });
}

function pressStop(): void {
	if (shown) fire({ type: "stop", takeId: shown.id });
}

function pressRetry(): void {
	if (shown) fire({ type: "retry", takeId: shown.id });
}

function pressOpen(): void {
	if (card.artifactId) fire({ type: "open", artifactId: card.artifactId });
}

function pressDownload(): void {
	menuOpen = false;
	if (shown?.fileId) {
		fire({ type: "download", fileId: shown.fileId, title: card.title });
	}
}

function pressHistory(): void {
	menuOpen = false;
	if (card.artifactId) {
		fire({ type: "history", artifactId: card.artifactId });
	}
}

function takeNumber(take: ImageTakeView): number {
	return takes.indexOf(take) + 1;
}

function stateWords(current: ImageCardState): {
	line: string;
	detail: string | null;
} {
	switch (current.kind) {
		case "waiting":
			return {
				line: $t("artifacts.image.card.waiting"),
				detail:
					current.ahead !== null
						? $t("artifacts.image.card.ahead", { count: current.ahead })
						: null,
			};
		case "starting":
			return {
				line: $t("artifacts.image.card.starting"),
				detail: $t("artifacts.image.card.startingDetail"),
			};
		case "making":
			return {
				line: $t("artifacts.image.card.making"),
				detail: etaLabel(current.etaSeconds, $t),
			};
		case "failed":
			return {
				line: current.unavailable
					? $t("artifacts.image.card.unavailable")
					: $t("artifacts.image.card.failed"),
				detail: $t("artifacts.image.card.nothingSaved"),
			};
		case "stopped":
			return { line: $t("artifacts.image.card.stopped"), detail: null };
		case "ready":
			return { line: "", detail: null };
	}
}

let words = $derived(stateWords(cardState));
let menuAnchorId = $derived(`image-card-more-${card.id}`);
</script>

<div class="image-card-body" data-testid="image-card-body" data-state={cardState.kind}>
	<div
		class="image-card-stage"
		style:--box-ratio={box.width / box.height}
		style:aspect-ratio="{box.width} / {box.height}"
		data-testid="image-card-stage"
	>
		{#if gone}
			<!-- The Image is gone, or lives in another chat: the box keeps its
			     shape and says so; nothing in the card can be pressed. -->
			<div
				class="image-card-layer image-card-state image-card-gone"
				data-testid="image-card-gone"
				transition:crossfade={{ duration: MOTION_DURATION.standard }}
			>
				<ImageOff size={20} strokeWidth={1.75} aria-hidden="true" />
				<span class="image-card-state-detail">
					{gone === 'unreachable'
						? $t('artifacts.image.card.elsewhereDetail')
						: $t('artifacts.image.card.goneDetail')}
				</span>
			</div>
		{:else if ready && shown?.fileId}
			<div class="image-card-layer" transition:crossfade={{ duration: MOTION_DURATION.standard }}>
				<button
					type="button"
					class="image-card-picture"
					disabled={!card.artifactId || Boolean(gone)}
					aria-label={card.title}
					data-testid="image-card-picture"
					onclick={pressOpen}
				>
					<ImagePicture
						fileId={shown.fileId}
						width={shown.width ?? box.width}
						height={shown.height ?? box.height}
						hasAlpha={shown.hasAlpha}
						alt={card.title}
						{conversationId}
						beforeFileId={shown.baseFileId}
						{showing}
					/>
				</button>
				{#if checkingAgain}
					<!-- The server's one automatic retry of this take is under way: the
					     take stays, a quiet note says so, and the better one takes its
					     place when the server decides (opacity only). -->
					<span
						class="image-card-checking"
						data-testid="image-card-checking"
						role="status"
						transition:crossfade={{ duration: MOTION_DURATION.standard }}
					>
						<LoaderCircle class="image-card-spin" size={13} strokeWidth={2} aria-hidden="true" />
						{$t('artifacts.image.card.checkingAgain')}
					</span>
				{/if}
				{#if canFlip}
					<div class="image-card-flip">
						<BeforeAfterSwitch
							{showing}
							onChange={(next) => (showing = next)}
							label={card.title}
							testIdPrefix="image-card"
						/>
					</div>
				{/if}
			</div>
		{:else}
			{#key cardState.kind}
				<div
					class="image-card-layer image-card-state"
					data-testid="image-card-state"
					transition:crossfade={{ duration: MOTION_DURATION.standard }}
				>
					<span class="image-card-state-line">
						{#if cardState.kind === 'failed'}
							<TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
						{:else if cardState.kind === 'waiting'}
							<Clock size={16} strokeWidth={2} aria-hidden="true" />
						{:else if cardState.kind !== 'stopped'}
							<LoaderCircle class="image-card-spin" size={16} strokeWidth={2} aria-hidden="true" />
						{/if}
						<span>{words.line}</span>
					</span>
					{#if cardState.kind === 'making'}
						<div
							class="image-card-progress"
							role="progressbar"
							aria-label={words.line}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={Math.round(progress)}
						>
							<span class="image-card-progress-bar" style:transform="scaleX({progress / 100})"></span>
						</div>
					{/if}
					<span class="image-card-state-detail">{words.detail ?? ''}</span>
					{#if shown && (cardState.kind === 'waiting' || cardState.kind === 'starting' || cardState.kind === 'making')}
						<button type="button" class="image-card-button" data-testid="image-card-stop" onclick={pressStop}>
							{$t('artifacts.image.card.stop')}
						</button>
					{:else if shown && (cardState.kind === 'failed' || cardState.kind === 'stopped')}
						<button type="button" class="image-card-button" data-testid="image-card-retry" onclick={pressRetry}>
							{$t('artifacts.image.card.tryAgain')}
						</button>
					{/if}
				</div>
			{/key}
		{/if}
	</div>

	{#if stripCount > 1}
		<div class="image-card-strip" role="group" aria-label={$t('artifacts.image.subtitle.takes', { count: stripCount })} data-testid="image-card-strip">
			{#each takes as take (take.id)}
				{@const isShown = shown?.id === take.id && !waitingForAnother}
				{@const tileState = takeState(take, now)}
				<button
					type="button"
					class="image-card-tile picture-tile"
					class:is-chosen={isShown}
					style:--tile-ratio={take.box.width / take.box.height}
					aria-pressed={isShown}
					aria-label={$t('artifacts.image.card.takeAlt', { title: card.title, number: takeNumber(take) })}
					data-testid="image-card-tile"
					data-take-id={take.id}
					disabled={Boolean(gone)}
					onclick={() => chooseTake(take.id)}
				>
					{#if gone}
						<span class="image-card-tile-state"><ImageOff size={14} strokeWidth={2} aria-hidden="true" /></span>
					{:else if tileState.kind === 'ready' && take.fileId}
						<ImagePicture
							fileId={take.fileId}
							width={take.width ?? take.box.width}
							height={take.height ?? take.box.height}
							hasAlpha={take.hasAlpha}
							alt=""
							{conversationId}
							variant="thumb"
						/>
					{:else if tileState.kind === 'failed' || tileState.kind === 'stopped'}
						<span class="image-card-tile-state"><TriangleAlert size={14} strokeWidth={2} aria-hidden="true" /></span>
					{:else}
						<span class="image-card-tile-state"><LoaderCircle class="image-card-spin" size={14} strokeWidth={2} aria-hidden="true" /></span>
					{/if}
					{#if take.id === card.pickedTakeId}
						<span class="image-card-badge" title={$t('artifacts.image.card.inUse')} data-testid="image-card-in-use">
							<Check size={11} strokeWidth={2.6} aria-hidden="true" />
							<span class="sr-only">{$t('artifacts.image.card.inUse')}</span>
						</span>
					{/if}
				</button>
			{/each}
			{#each Array.from({ length: placeholders }, (_, index) => index) as index (index)}
				<button
					type="button"
					class="image-card-tile picture-tile"
					class:is-chosen={waitingForAnother && index === placeholders - 1}
					style:--tile-ratio={box.width / box.height}
					aria-pressed={waitingForAnother && index === placeholders - 1}
					aria-label={$t('artifacts.image.card.waiting')}
					data-testid="image-card-tile-placeholder"
					onclick={() => (selectedTakeId = PLACEHOLDER)}
				>
					<span class="image-card-tile-state"><LoaderCircle class="image-card-spin" size={14} strokeWidth={2} aria-hidden="true" /></span>
				</button>
			{/each}
		</div>
	{/if}

	{#if madeFromIds.length > 0}
		<div class="image-card-sources" data-testid="image-card-made-from">
			<span>{$t('artifacts.image.card.madeFrom')}</span>
			{#each madeFromIds as sourceId, index (sourceId)}
				<span class="image-card-source">
					<span class="image-card-source-pic">
						<ImagePicture fileId={sourceId} width={1} height={1} alt="" {conversationId} variant="thumb" />
					</span>
					<span class="image-card-number" aria-hidden="true">{index + 1}</span>
				</span>
			{/each}
		</div>
	{/if}

	<div class="image-card-actions">
		<button
			type="button"
			class="image-card-button"
			data-testid="image-card-another"
			disabled={anotherDisabled}
			onclick={pressAnother}
		>
			<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
			{$t('artifacts.image.card.another')}
		</button>
		{#if canUse}
			<button
				type="button"
				class="image-card-button image-card-button-accent"
				data-testid="image-card-use"
				transition:crossfade={{ duration: MOTION_DURATION.standard }}
				onclick={pressUse}
			>
				<Check size={14} strokeWidth={2} aria-hidden="true" />
				{$t('artifacts.image.card.useThis')}
			</button>
		{/if}
		<span class="image-card-grow"></span>
		<button
			type="button"
			class="image-card-icon-button"
			aria-label={$t('artifacts.image.card.more')}
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
		title={card.title}
		anchorTestId={menuAnchorId}
		popoverTestId="image-card-menu"
		closeLabel={$t('common.close')}
		width={220}
		boundarySelector=".chat-main"
		onClose={() => (menuOpen = false)}
	>
		<div class="image-card-menu" role="menu" aria-label={$t('artifacts.image.card.more')}>
			<button
				type="button"
				role="menuitem"
				class="image-card-menu-row"
				data-testid="image-card-download"
				disabled={!ready || !shown?.fileId}
				onclick={pressDownload}
			>
				<Download size={16} strokeWidth={1.75} aria-hidden="true" />
				<span>{$t('artifacts.image.card.download')}</span>
			</button>
			<button
				type="button"
				role="menuitem"
				class="image-card-menu-row"
				data-testid="image-card-history"
				disabled={!card.artifactId}
				onclick={pressHistory}
			>
				<History size={16} strokeWidth={1.75} aria-hidden="true" />
				<span>{$t('artifacts.image.card.history')}</span>
			</button>
		</div>
	</AnchoredPopover>
{/if}

<style>
	.image-card-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0 0.75rem 0.75rem;
	}

	/* The reserved box: the shown take's shape from its first paint, never
	   taller than 22rem or 45% of the window, centred when that narrows it. */
	.image-card-stage {
		position: relative;
		display: grid;
		width: min(100%, calc(min(22rem, 45vh) * var(--box-ratio)));
		margin-inline: auto;
		overflow: hidden;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
	}

	/* Every layer fills the box: the state and the picture are stacked in one
	   grid cell and crossfade, so a state change never changes the box. */
	.image-card-layer {
		grid-area: 1 / 1;
		position: relative;
		min-width: 0;
		min-height: 0;
	}

	.image-card-picture {
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		border-radius: inherit;
		cursor: zoom-in;
	}

	.image-card-picture:disabled {
		cursor: default;
	}

	.image-card-picture:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring) inset;
	}

	/* Before / After floats over the picture's corner (BeforeAfterSwitch). */
	.image-card-flip {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
	}

	/* "Alfy is trying once more…": a quiet chip over the picture, never a row. */
	.image-card-checking {
		position: absolute;
		left: 0.5rem;
		bottom: 0.5rem;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: calc(100% - 1rem);
		padding: 0.25rem 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.75rem;
		pointer-events: none;
	}

	.image-card-gone {
		color: var(--icon-muted);
	}

	.image-card-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.375rem;
		padding: 0.75rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		text-align: center;
	}

	.image-card-state-line {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text-primary);
		font-weight: 600;
	}

	.image-card-state-detail {
		min-height: 1.2em;
		max-width: 22rem;
		font-size: 0.75rem;
	}

	.image-card-progress {
		width: min(12rem, 70%);
		height: 4px;
		overflow: hidden;
		border-radius: var(--radius-full);
		background: var(--border-default);
	}

	/* Progress eases between polls and only ever grows (F21). */
	.image-card-progress-bar {
		display: block;
		width: 100%;
		height: 100%;
		background: var(--accent);
		transform-origin: left center;
		transition: transform var(--duration-settle) var(--ease-out);
	}

	.image-card-body :global(.image-card-spin) {
		animation: image-card-spin 1s linear infinite;
	}

	@keyframes image-card-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.image-card-body :global(.image-card-spin) {
			animation: none;
		}
	}

	.image-card-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	/* The tile's look is the shared picture tile (picture-tile.css); its size is the take's shape. */
	.image-card-tile {
		display: grid;
		place-items: center;
		width: calc(56px * var(--tile-ratio));
		max-width: 96px;
		height: 56px;
	}

	.image-card-tile:disabled {
		cursor: default;
	}

	.image-card-icon-button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.image-card-tile-state {
		display: grid;
		place-items: center;
		color: var(--icon-muted);
	}

	.image-card-badge {
		position: absolute;
		top: 3px;
		left: 3px;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--on-accent);
	}

	.image-card-sources {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.75rem;
	}

	.image-card-source {
		position: relative;
		display: inline-flex;
	}

	.image-card-source-pic {
		display: block;
		width: 30px;
		height: 30px;
		overflow: hidden;
		border-radius: var(--radius-sm);
	}

	.image-card-source-pic :global(.image-picture) {
		height: 100%;
	}

	.image-card-source-pic :global(.image-picture-img) {
		object-fit: cover;
	}

	.image-card-number {
		position: absolute;
		right: -4px;
		bottom: -4px;
		display: grid;
		place-items: center;
		width: 14px;
		height: 14px;
		border-radius: var(--radius-full);
		background: var(--text-primary);
		color: var(--surface-page);
		font-size: 9px;
		font-weight: 700;
	}

	.image-card-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.image-card-grow {
		flex: 1 1 auto;
	}

	.image-card-button {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 0.375rem;
		min-height: 2rem;
		padding: 0 0.625rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}

	.image-card-button:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	.image-card-button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.image-card-button:focus-visible,
	.image-card-icon-button:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.image-card-button-accent {
		border-color: color-mix(in srgb, var(--accent) 38%, transparent);
		background: var(--accent-tint);
		color: var(--accent-text);
	}

	.image-card-button-accent:hover:not(:disabled) {
		background: var(--accent-tint);
	}

	.image-card-icon-button {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--icon-muted);
		cursor: pointer;
	}

	.image-card-icon-button:hover {
		background: var(--surface-elevated);
	}

	.image-card-menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 0 6px 6px;
	}

	.image-card-menu-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-height: 2.25rem;
		padding: 0 0.625rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: 0.84rem;
		text-align: left;
		cursor: pointer;
	}

	.image-card-menu-row:hover:not(:disabled) {
		background: var(--surface-elevated);
	}

	.image-card-menu-row:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	@media (hover: none) and (pointer: coarse) {
		.image-card-button,
		.image-card-icon-button,
		.image-card-menu-row {
			min-height: 44px;
		}

		.image-card-icon-button {
			width: 44px;
		}
	}
</style>
