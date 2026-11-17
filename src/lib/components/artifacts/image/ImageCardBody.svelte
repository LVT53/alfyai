<script lang="ts">
// The picture card's body under `ArtifactCard`'s head (plan 2b T2, design
// 5.3, wireframe frames 1, 2 and 7), on the one card shell every take card
// shares (`takes/TakeCardShell.svelte`: the stage, its states and shimmer, the
// actions row, the More menu, the countdown handed to the head). What is the
// picture's own is here: the picture in the stage, with Enlarge, Before / After
// and the "trying once more" note over it; the takes strip when there is more
// than one take; "Made from" for a card made from pictures; Use this in Stop's
// slot; and Attach, Download and History in the menu.
//
// The picture opens the item in the panel; an Enlarge button on its corner
// opens the full-screen viewer (`PictureViewer`, Task 22) on the shown take's
// full-size file.
import {
	Check,
	Download,
	EyeOff,
	History,
	ImageOff,
	LoaderCircle,
	Maximize2,
	Paperclip,
	TriangleAlert,
} from "@lucide/svelte";
import { fade } from "svelte/transition";
import { t } from "$lib/i18n";
import { oneLineName } from "$lib/shared/one-line-name";
import { MAX_VISIBLE_TAKES_PER_CARD } from "$lib/shared/artifacts/image-body";
import type {
	ImageCardView,
	ImageTakeView,
} from "$lib/server/services/images/read-model";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import TakeCardShell from "../takes/TakeCardShell.svelte";
import { takeCardState } from "../takes/take-card-view";
import {
	type ImageCardAction,
	type ImageCardActionHandler,
	hasActiveImageTakes,
	isCheckingAgain,
	shownTake,
	visibleTakes,
} from "./image-card-view";
import BeforeAfterSwitch from "./BeforeAfterSwitch.svelte";
import ImagePicture from "./ImagePicture.svelte";
import PictureViewer from "./PictureViewer.svelte";
import "./picture-tile.css";

let {
	card,
	conversationId = null,
	onAction = undefined,
	gone = null,
	onTime = undefined,
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
	/**
	 * The words the card's head shows beside the kind while the shown take is
	 * on its way ("Next up", "About 24 s left", "Almost done…"), null once it
	 * is not: the head is `ArtifactCard`'s, the countdown is the shell's.
	 */
	onTime?: ((words: string | null) => void) | undefined;
} = $props();
/** A new picture's size, for a card that has no take to read one from. */
const FALLBACK_BOX = { width: 1248, height: 832 };
/** The stage's desktop width cap: 22rem. */
const DESKTOP_STAGE_WIDTH = 352;

/**
 * What the browser should assume the picture's box is: the stage is
 * `min(100%, min(22rem, 45vh) * ratio)` in CSS, and the desktop cap is
 * 22rem * ratio (45vh only narrows it further, so this is the conservative
 * truthful bound). `min(92vw, W)` keeps a phone from claiming the whole
 * window for a portrait. A flat 92vw asked a DPR-3 phone for ~1098 device px
 * on a 198 px portrait, past the 900w display copy, so it took the master.
 */
function pictureSizesOf(stage: { width: number; height: number }): string {
	const ratio = stage.height > 0 ? stage.width / stage.height : 1;
	const width = Math.max(1, Math.round(DESKTOP_STAGE_WIDTH * ratio));
	return `(max-width: 767px) min(92vw, ${width}px), ${width}px`;
}
const PLACEHOLDER = "placeholder";

const crossfade = reducedMotionAware(fade);

/** The take the reader chose in the strip, or the Another that is on its way. */
let selectedTakeId = $state<string | null>(null);
let showing = $state<"after" | "before">("after");
/** Anothers pressed whose take the card does not hold yet. */
let pendingAnothers = $state(0);
/** The takes the card held when the first of them was pressed. */
let takesBeforeAnother = $state.raw<ReadonlySet<string>>(new Set());

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
let box = $derived(
	shown?.box ?? takes.at(-1)?.box ?? card.takes.at(-1)?.box ?? FALLBACK_BOX,
);
/** The box's own width, for the browser's `srcset` choice. */
let pictureSizes = $derived(pictureSizesOf(box));
let stripCount = $derived(takes.length + placeholders);
/**
 * The request's own cap: the picture graphs have ten picture slots, so a take
 * is never made from more. A row written around a cap change still clips to
 * ten rather than overflowing the card.
 */
const MAX_MADE_FROM_PICTURES = 10;

/**
 * The pictures the shown take was made from, in the order the prompt addresses
 * them (the take's base first, then its references): the read model's one list,
 * so the numbers under the thumbnails are the prompt's own `<image1>` …
 * `<imageN>`. Never built by joining the base and the references here.
 */
let madeFromIds = $derived(
	card.madeFrom === "pictures"
		? (
				shown?.sourceFileIdsInPromptOrder ??
				card.takes[0]?.sourceFileIdsInPromptOrder ??
				[]
			).slice(0, MAX_MADE_FROM_PICTURES)
		: [],
);
// Another is offered once nothing of the card is on its way: not beside Stop
// while a take is made, and not again while the one pressed is (Task 17).
let anotherDisabled = $derived(
	Boolean(gone) ||
		stripCount >= MAX_VISIBLE_TAKES_PER_CARD ||
		placeholders > 0 ||
		hasActiveImageTakes([card]),
);

// Before / After is about the shown take: a new take starts on After.
$effect(() => {
	void shown?.id;
	showing = "after";
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

/** Use this: the shown take is a landed one the card does not use yet. */
function canUse(ready: boolean): boolean {
	return Boolean(
		shown &&
			ready &&
			!shown.held &&
			shown.id !== card.pickedTakeId &&
			shown.status === "succeeded",
	);
}

function pressUse(): void {
	if (shown) fire({ type: "use", takeId: shown.id });
}

function pressStop(): void {
	if (shown) fire({ type: "stop", takeId: shown.id });
}

function pressRetry(): void {
	if (shown) fire({ type: "retry", takeId: shown.id });
}

/** The take the viewer shows, held while it is open (a poll never swaps it under the reader). */
let enlarged = $state.raw<{
	fileId: string;
	width?: number;
	height?: number;
	hasAlpha: boolean;
} | null>(null);

function pressEnlarge(): void {
	if (!shown?.fileId) return;
	// Before is the base, whose shape the card does not know: the viewer reads it from the file.
	if (showing === "before" && shown.baseFileId) {
		enlarged = { fileId: shown.baseFileId, hasAlpha: shown.hasAlpha };
		return;
	}
	enlarged = {
		fileId: shown.fileId,
		width: shown.width ?? box.width,
		height: shown.height ?? box.height,
		hasAlpha: shown.hasAlpha,
	};
}

function pressOpen(): void {
	if (card.artifactId) fire({ type: "open", artifactId: card.artifactId });
}

function pressDownload(close: () => void): void {
	close();
	if (shown?.fileId) {
		fire({ type: "download", fileId: shown.fileId, title: card.title });
	}
}

/** Puts the shown picture in the composer, named after the card (plan 2b T5). */
function pressAttach(close: () => void): void {
	close();
	if (shown?.fileId) {
		fire({
			type: "attach",
			fileId: shown.fileId,
			name: oneLineName(card.title),
			at: shown.createdAt,
		});
	}
}

function pressHistory(close: () => void): void {
	close();
	if (card.artifactId) {
		fire({ type: "history", artifactId: card.artifactId });
	}
}

function takeNumber(take: ImageTakeView): number {
	return takes.indexOf(take) + 1;
}
</script>

<TakeCardShell
	kind="image"
	take={shown}
	landed={Boolean(shown?.fileId)}
	{box}
	cardId={card.id}
	title={card.title}
	{gone}
	canAct={Boolean(onAction)}
	{anotherDisabled}
	onAnother={pressAnother}
	onStop={pressStop}
	onRetry={pressRetry}
	{onTime}
>
	{#snippet result()}
		{#if shown?.fileId}
			<button
				type="button"
				class="image-card-picture"
				disabled={!card.artifactId}
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
					variant="display"
					sizes={pictureSizes}
				/>
			</button>
			{#if isCheckingAgain(card, shown)}
				<!-- The server's one automatic retry of this take is under way: the
				     take stays, a quiet note says so, and the better one takes its
				     place when the server decides (opacity only). -->
				<span
					class="take-card-chip image-card-checking"
					data-testid="image-card-checking"
					role="status"
					transition:crossfade={{ duration: MOTION_DURATION.standard }}
				>
					<LoaderCircle class="image-card-spin" size={13} strokeWidth={2} aria-hidden="true" />
					{$t('artifacts.image.card.checkingAgain')}
				</span>
			{/if}
			<button
				type="button"
				class="image-card-enlarge"
				aria-label={$t('artifacts.image.enlarge')}
				title={$t('artifacts.image.enlarge')}
				data-testid="image-card-enlarge"
				onclick={pressEnlarge}
			>
				<Maximize2 size={15} strokeWidth={2} aria-hidden="true" />
			</button>
			{#if shown.baseFileId}
				<div class="image-card-flip">
					<BeforeAfterSwitch
						{showing}
						onChange={(next) => (showing = next)}
						label={card.title}
						testIdPrefix="image-card"
					/>
				</div>
			{/if}
		{/if}
	{/snippet}

	{#snippet below({ now })}
		{#if stripCount > 1}
			<div class="image-card-strip" role="group" aria-label={$t('artifacts.image.subtitle.takes', { count: stripCount })} data-testid="image-card-strip">
				{#each takes as take (take.id)}
					{@const isShown = shown?.id === take.id && !waitingForAnother}
					{@const tileState = takeCardState(take, now, 'image', Boolean(take.fileId))}
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
						{:else if tileState.kind === 'blocked'}
							<span class="image-card-tile-state"><EyeOff size={14} strokeWidth={1.75} aria-hidden="true" /></span>
						{:else if tileState.kind === 'failed' || tileState.kind === 'stopped'}
							<span class="image-card-tile-state"><TriangleAlert size={14} strokeWidth={2} aria-hidden="true" /></span>
						{:else}
							<span class="image-card-tile-shimmer take-shimmer" aria-hidden="true"><span class="take-shimmer-band"></span></span>
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
						<span class="image-card-tile-shimmer take-shimmer" aria-hidden="true"><span class="take-shimmer-band"></span></span>
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
	{/snippet}

	{#snippet swap({ ready })}
		{#if canUse(ready)}
			<button
				type="button"
				class="take-card-button take-card-button-accent"
				data-testid="image-card-use"
				transition:crossfade={{ duration: MOTION_DURATION.standard }}
				onclick={pressUse}
			>
				<Check size={14} strokeWidth={2} aria-hidden="true" />
				{$t('artifacts.image.card.useThis')}
			</button>
		{/if}
	{/snippet}

	{#snippet menu({ close, ready })}
		<button
			type="button"
			role="menuitem"
			class="take-card-menu-row"
			data-testid="image-card-attach"
			disabled={!ready || !shown?.fileId}
			onclick={() => pressAttach(close)}
		>
			<Paperclip size={16} strokeWidth={1.75} aria-hidden="true" />
			<span>{$t('artifacts.image.card.attach')}</span>
		</button>
		<button
			type="button"
			role="menuitem"
			class="take-card-menu-row"
			data-testid="image-card-download"
			disabled={!ready || !shown?.fileId}
			onclick={() => pressDownload(close)}
		>
			<Download size={16} strokeWidth={1.75} aria-hidden="true" />
			<span>{$t('artifacts.take.download')}</span>
		</button>
		<button
			type="button"
			role="menuitem"
			class="take-card-menu-row"
			data-testid="image-card-history"
			disabled={!card.artifactId}
			onclick={() => pressHistory(close)}
		>
			<History size={16} strokeWidth={1.75} aria-hidden="true" />
			<span>{$t('artifacts.take.history')}</span>
		</button>
	{/snippet}
</TakeCardShell>

<PictureViewer
	picture={enlarged}
	title={card.title}
	{conversationId}
	onClose={() => (enlarged = null)}
/>

<style>
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

	/* Enlarge: a quiet round button on the picture's bottom-right corner. Hover
	   feedback is instant (only transform and opacity animate in the card). */
	.image-card-enlarge {
		position: absolute;
		right: 0.5rem;
		bottom: 0.5rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		padding: 0;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		cursor: pointer;
	}

	.image-card-enlarge:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	@media (hover: none) and (pointer: coarse) {
		.image-card-enlarge {
			width: 44px;
			height: 44px;
		}
	}

	/* Before / After floats over the picture's corner (BeforeAfterSwitch). */
	.image-card-flip {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
	}

	/* "Alfy is trying once more…": the card's chip (`take-card-chip`) on the
	   picture's bottom-left corner, clear of Enlarge in the opposite one. */
	.image-card-checking {
		left: 0.5rem;
		bottom: 0.5rem;
		max-width: calc(100% - 3.5rem);
	}

	:global(.image-card-spin) {
		animation: image-card-spin 1s linear infinite;
	}

	@keyframes image-card-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.image-card-spin) {
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

	/* A take still on its way, in the strip: the card's shimmer, tile-sized. */
	.image-card-tile-shimmer {
		position: absolute;
		inset: 0;
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
</style>
