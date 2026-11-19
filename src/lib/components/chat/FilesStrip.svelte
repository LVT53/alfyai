<script lang="ts">
/**
 * A reply's found files, drawn the compact way the second pass decided
 * (docs/superpowers/specs/2026-11-15-nextcloud-file-cards-compact-design.md):
 * one file as the single card, two or more as a strip of 78px tiles and a
 * chevron. A tile is a FILE: a picture draws its picture, a document draws its
 * type. A picture tile and the single card's picture open the app's viewer; a
 * document tile opens that file in Nextcloud; the chevron and the count tile
 * open the compact file list. The viewer is loaded on the first press
 * (`image-lightbox-loader.ts`) and never in the chat's first paint.
 *
 * The reply draws ONE block, however many `files` calls it made: the caller
 * merges them before handing `cards` here, so a reply that searched twice does
 * not stack two strips.
 *
 * Everything is a sibling, never nested: a tile is a `<button>` (or an `<a>` for
 * a document), a list row is one `<a>` to the file in Nextcloud (its 40px
 * picture included), and the single card's picture button stands beside its
 * link.
 */
import { ChevronDown } from "@lucide/svelte";
import { tick } from "svelte";
import FileTypeIcon from "$lib/components/ui/FileTypeIcon.svelte";
import { t } from "$lib/i18n";
import type { ToolCallFileCard } from "$lib/server/services/messages-types";
import {
	type AttachmentFileType,
	fileExtension,
	getFileType,
} from "./attachment-file-type";
import {
	fileCardFacts,
	filesStripTiles,
	STRIP_SLOTS_NARROW,
	STRIP_SLOTS_WIDE,
	stripPictureCards,
} from "./files-strip-view";
import {
	type ImageLightboxComponent,
	loadImageLightbox,
} from "./image-lightbox-loader";
import { replayEarlyImageEvent } from "$lib/utils/early-image-event";

let { cards }: { cards: ToolCallFileCard[] } = $props();

/** The list's id, so the chevron can name what it opens and closes. */
const listId = $props.id();

/** Chat is narrow at 480px and below, where three tiles fit instead of four. */
const NARROW_QUERY = "(max-width: 480px)";

/**
 * Whether the chat is narrow. Unmeasured — no browser, or no `matchMedia` in it
 * — stays wide, so the first paint is the wide strip and only a real narrow
 * window narrows it.
 */
let narrow = $state(false);

$effect(() => {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return;
	}
	const query = window.matchMedia(NARROW_QUERY);
	narrow = query.matches;
	if (typeof query.addEventListener !== "function") return;
	const onChange = (event: MediaQueryListEvent) => {
		narrow = event.matches;
	};
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
});

let listOpen = $state(false);

/**
 * The previews that failed to load, by their address. A failed picture's square
 * draws the file-type glyph instead (and, in the strip, stays a button: the
 * viewer's larger copy may still load) — never a broken image.
 */
let failedPreviews = $state.raw<ReadonlySet<string>>(new Set());

function markPreviewFailed(url: string | null) {
	if (!url || failedPreviews.has(url)) return;
	failedPreviews = new Set([...failedPreviews, url]);
}

/** A card's picture, unless it has none or its own failed to load. */
function previewFor(url: string | null): string | null {
	if (!url || failedPreviews.has(url)) return null;
	return url;
}

/** One tile of the strip, with the words and the glyph it needs to be drawn. */
type StripTileView =
	| {
			kind: "picture";
			key: string;
			pictureIndex: number;
			label: string;
			preview: string | null;
			fileType: AttachmentFileType;
	  }
	| {
			kind: "document";
			key: string;
			label: string;
			fileType: AttachmentFileType;
			webUrl: string;
			ext: string;
	  }
	| {
			kind: "count";
			key: string;
			label: string;
			cover: string | null;
			hidden: number;
	  };

const slots = $derived(narrow ? STRIP_SLOTS_NARROW : STRIP_SLOTS_WIDE);
const pictures = $derived(stripPictureCards(cards));

const rowViews = $derived(
	cards.map((card) => ({
		card,
		preview: previewFor(card.previewUrl),
		fileType: getFileType(card.contentType, card.name),
		facts: fileCardFacts(card, $t),
	})),
);

/** One file is the card; everything else is a strip or the quiet line. */
const singleCard = $derived(rowViews.length === 1 ? rowViews[0] : null);

const tileViews = $derived.by((): StripTileView[] =>
	filesStripTiles(cards, slots).map((tile) => {
		if (tile.kind === "file") {
			const fileType = getFileType(tile.card.contentType, tile.card.name);
			if (tile.pictureIndex === null) {
				return {
					kind: "document",
					key: tile.card.path,
					label: $t("toolActivity.filesOpenFile", { name: tile.card.name }),
					fileType,
					webUrl: tile.card.webUrl,
					ext: fileExtension(tile.card.name),
				};
			}
			return {
				kind: "picture",
				key: tile.card.path,
				pictureIndex: tile.pictureIndex,
				label: $t("toolActivity.filesOpenPicture", {
					name: tile.card.name,
					index: tile.pictureIndex + 1,
					total: pictures.length,
				}),
				preview: previewFor(tile.card.previewUrl),
				fileType,
			};
		}
		return {
			kind: "count",
			key: `count-${tile.hidden}`,
			label: $t("toolActivity.filesShowAll", { count: cards.length }),
			cover: previewFor(tile.cover),
			hidden: tile.hidden,
		};
	}),
);

const listLabel = $derived(
	listOpen
		? $t("toolActivity.filesHideList")
		: $t("toolActivity.filesShowList"),
);

/** The viewer's pictures: the call's pictures, at the viewer's size when known. */
const viewerImages = $derived(
	pictures.map((card) => ({
		src: card.viewUrl ?? card.previewUrl ?? "",
		alt: card.name,
	})),
);

/** The viewer is the app's one full-screen view, loaded on the first press. */
let Viewer = $state.raw<ImageLightboxComponent | null>(null);
let viewerIndex = $state<number | null>(null);

/**
 * The control the viewer was opened from. The viewer's own focus restore is not
 * dependable here: it hands focus back to whatever had focus when its trap
 * installed — the pressed tile on Chromium, which focuses a clicked button, but
 * <body> on Safari, which does not — and it runs only after the viewer's exit
 * transition, so no tick can wait for it. This component therefore focuses the
 * tile itself once the close has applied.
 *
 * Known limit: if focus moves somewhere else while the lazy viewer chunk is
 * still loading, the trap installs around that other element instead, and its
 * late restore can win over this focus.
 */
let viewerOpener: HTMLElement | null = null;

function openViewerAt(index: number, opener: HTMLElement) {
	viewerOpener = opener;
	viewerIndex = index;
	if (Viewer) return;
	loadImageLightbox().then(
		(component) => {
			Viewer = component;
		},
		// The viewer could not load (a deploy swapped the chunks): nothing opens.
		() => {
			viewerIndex = null;
		},
	);
}

async function closeViewer() {
	viewerIndex = null;
	const opener = viewerOpener;
	viewerOpener = null;
	// Let the close apply first, so focus can leave the viewer's controls before
	// they unmount; the viewer's own restore runs later still (see above).
	await tick();
	// A press in the same tick reopened the viewer: that open owns the focus.
	if (viewerIndex !== null) return;
	if (opener?.isConnected) opener.focus({ preventScroll: true });
}
</script>

{#if cards.length === 0}
	<!-- A call that found nothing draws nothing at all: the quiet line would
	     read "Searched your files · 0 files" over an empty list. -->
{:else if singleCard}
	{@const card = singleCard.card}
	<div class="fs-card">
		{#if card.previewUrl}
			<!-- A file with a picture, whose picture may have failed to load: the
			     square then draws the glyph but stays a button, because the
			     viewer's larger copy may still load. -->
			<button
				type="button"
				class="fs-card-picture"
				aria-label={$t("toolActivity.filesOpenPicture", {
					name: card.name,
					index: 1,
					total: 1,
				})}
				onclick={(event) => openViewerAt(0, event.currentTarget)}
			>
				{#if singleCard.preview}
					<img
						src={singleCard.preview}
						width="56"
						height="56"
						loading="lazy"
						alt=""
						use:replayEarlyImageEvent
						onerror={() => markPreviewFailed(singleCard.preview)}
					/>
				{:else}
					<FileTypeIcon type={singleCard.fileType} size={26} />
				{/if}
			</button>
		{:else}
			<span class="fs-card-picture">
				<FileTypeIcon type={singleCard.fileType} size={26} />
			</span>
		{/if}
		<a
			class="fs-card-text"
			href={card.webUrl}
			target="_blank"
			rel="noopener noreferrer external"
		>
			<span class="fs-card-name" title={card.name}>{card.name}</span>
			<span class="fs-card-facts">{singleCard.facts}</span>
			<span class="fs-card-open">{$t("toolActivity.filesOpen")}</span>
		</a>
	</div>
{:else}
	<div class="fs-block" data-testid="files-strip">
		<div class="fs-head">
			<div class="fs-strip">
				{#each tileViews as tile (tile.key)}
					{#if tile.kind === "picture"}
							<button
								type="button"
								class="fs-tile"
								data-testid="files-strip-tile"
								aria-label={tile.label}
								onclick={(event) =>
									openViewerAt(tile.pictureIndex, event.currentTarget)}
							>
								{#if tile.preview}
									<img
										src={tile.preview}
										width="78"
										height="78"
										loading="lazy"
										alt=""
										use:replayEarlyImageEvent
										onerror={() => markPreviewFailed(tile.preview)}
									/>
								{:else}
									<FileTypeIcon type={tile.fileType} size={30} />
								{/if}
							</button>
						{:else if tile.kind === "document"}
							<a
								class="fs-tile fs-tile-doc"
								data-testid="files-strip-tile"
								href={tile.webUrl}
								target="_blank"
								rel="noopener noreferrer external"
								aria-label={tile.label}
							>
								<FileTypeIcon type={tile.fileType} size={28} />
								{#if tile.ext}
									<span class="fs-tile-ext" aria-hidden="true">{tile.ext}</span>
								{/if}
							</a>
						{:else}
							<button
								type="button"
								class="fs-tile fs-tile-count"
								data-testid="files-strip-count"
								aria-label={tile.label}
								onclick={() => (listOpen = true)}
							>
								{#if tile.cover}
									<img
										src={tile.cover}
										width="78"
										height="78"
										loading="lazy"
										alt=""
										use:replayEarlyImageEvent
										onerror={() => markPreviewFailed(tile.cover)}
									/>
								{/if}
								<span class="fs-tile-more" aria-hidden="true"
									>+{tile.hidden}</span
								>
							</button>
						{/if}
					{/each}
			</div>
			<button
				type="button"
				class="fs-chevron"
				data-testid="files-strip-chevron"
				aria-expanded={listOpen}
				aria-controls={listId}
				aria-label={listLabel}
				onclick={() => (listOpen = !listOpen)}
			>
				<span class="fs-chevron-icon" class:is-open={listOpen} aria-hidden="true">
					<ChevronDown size={16} strokeWidth={2} />
				</span>
			</button>
		</div>
		{#if listOpen}
			<ul id={listId} class="fs-list" data-testid="files-strip-list">
				{#each rowViews as row (row.card.path)}
					<li class="fs-list-item">
						<a
							class="fs-row"
							href={row.card.webUrl}
							target="_blank"
							rel="noopener noreferrer external"
						>
							<span class="fs-row-picture">
								{#if row.preview}
									<img
										src={row.preview}
										width="40"
										height="40"
										loading="lazy"
										alt=""
										use:replayEarlyImageEvent
										onerror={() => markPreviewFailed(row.preview)}
									/>
								{:else}
									<FileTypeIcon type={row.fileType} size={22} />
								{/if}
							</span>
							<span class="fs-row-text">
								<span
									class="fs-row-name"
									data-testid="files-strip-name"
									title={row.card.name}>{row.card.name}</span
								>
								<span class="fs-row-facts">{row.facts}</span>
							</span>
							<span class="fs-row-open">{$t("toolActivity.filesOpen")}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

{#if Viewer}
	<Viewer
		images={viewerImages}
		index={viewerIndex}
		onClose={closeViewer}
		onNavigate={(next) => (viewerIndex = next)}
	/>
{/if}

<style>
	/* The single card: one 56px picture or glyph, the name, the facts and the
	   way to the file. It takes the width it needs and never more — a long name
	   truncates instead of widening the card. */
	.fs-card {
		display: flex;
		align-items: center;
		gap: 10px;
		width: fit-content;
		max-width: min(100%, 420px);
		min-width: 0;
		margin: 2px 0 0;
	}

	.fs-card-picture {
		flex: 0 0 56px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 56px;
		padding: 0;
		border: none;
		border-radius: 8px;
		overflow: hidden;
		background: var(--surface-page);
		box-shadow: 0 0 0 1px var(--border-subtle);
		color: var(--icon-muted);
	}

	.fs-card-picture img {
		width: 56px;
		height: 56px;
		object-fit: cover;
	}

	button.fs-card-picture {
		cursor: zoom-in;
		transition: box-shadow var(--duration-standard) var(--ease-out);
	}

	button.fs-card-picture:hover,
	button.fs-card-picture:focus-visible {
		box-shadow: 0 0 0 2px var(--accent-tint-strong);
	}

	button.fs-card-picture:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.fs-card-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		/* The text block may shrink; without this a long name pushes the card
		   wider instead of truncating. */
		min-width: 0;
		overflow: hidden;
		color: inherit;
		text-decoration: none;
		border-radius: 4px;
	}

	.fs-card-name {
		font-size: var(--text-sm);
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.fs-card-facts {
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.fs-card-open {
		font-size: var(--text-xs);
		color: var(--accent-text);
		white-space: nowrap;
	}

	.fs-card-text:hover .fs-card-name,
	.fs-card-text:focus-visible .fs-card-name {
		text-decoration: underline;
	}

	.fs-card-text:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* The strip and its chevron: exactly as wide as the pictures. */
	.fs-block {
		min-width: 0;
		margin: 12px 0 0;
	}

	.fs-head {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}

	.fs-strip {
		display: flex;
		gap: 7px;
		min-width: 0;
	}

	.fs-tile {
		position: relative;
		flex: 0 0 78px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 78px;
		height: 78px;
		padding: 0;
		border: none;
		border-radius: 10px;
		overflow: hidden;
		background: var(--surface-page);
		box-shadow: 0 0 0 1px var(--border-subtle);
		color: var(--icon-muted);
		cursor: zoom-in;
		transition: box-shadow var(--duration-standard) var(--ease-out);
	}

	.fs-tile img {
		width: 78px;
		height: 78px;
		object-fit: cover;
	}

	.fs-tile:hover {
		box-shadow: 0 0 0 2px var(--accent-tint-strong);
	}

	.fs-tile:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* The count tile: the next picture, dimmed, with the number of pictures the
	   strip leaves out. It is the way into the list, so it does not zoom. */
	.fs-tile-count {
		cursor: pointer;
	}

	/* The app's one dimming value, laid twice: 32% once leaves the small white
	   +N at about 2:1 over a bright picture (and over the neutral square a
	   failed cover leaves), while two layers give about 4.6:1 worst case, which
	   is what small text needs. The dark theme's 55% is darker still. */
	.fs-tile-doc {
		flex-direction: column;
		gap: 3px;
		cursor: pointer;
		background: var(--surface-elevated);
	}

	.fs-tile-ext {
		font-size: 10px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.fs-tile-more {
		position: absolute;
		inset: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--accent-contrast);
		background:
			linear-gradient(var(--scrim), var(--scrim)),
			linear-gradient(var(--scrim), var(--scrim));
	}

	.fs-chevron {
		flex: 0 0 26px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: none;
		border-radius: var(--radius-full);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.fs-chevron:hover,
	.fs-chevron:focus-visible {
		background: var(--surface-overlay);
		color: var(--text-primary);
	}

	.fs-chevron:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.fs-chevron-icon {
		display: inline-flex;
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.fs-chevron-icon.is-open {
		transform: rotate(180deg);
	}

	/* The list: one line per file, one link per line, its 40px picture inside
	   it. */
	.fs-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 10px 0 0;
		padding: 0;
		list-style: none;
		min-width: 0;
	}

	.fs-list-item {
		min-width: 0;
	}

	.fs-row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		margin: 0 -6px;
		padding: 4px 6px;
		border-radius: 6px;
		color: inherit;
		text-decoration: none;
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.fs-row:hover,
	.fs-row:focus-visible {
		background: var(--surface-overlay);
	}

	.fs-row:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.fs-row-picture {
		flex: 0 0 40px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: 6px;
		overflow: hidden;
		background: var(--surface-page);
		box-shadow: 0 0 0 1px var(--border-subtle);
		color: var(--icon-muted);
	}

	.fs-row-picture img {
		width: 40px;
		height: 40px;
		object-fit: cover;
	}

	.fs-row-text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		overflow: hidden;
	}

	.fs-row-name {
		font-size: var(--text-sm);
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}

	.fs-row-facts {
		font-size: var(--text-xs);
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.fs-row-open {
		flex: 0 0 auto;
		margin-left: auto;
		font-size: var(--text-xs);
		color: var(--accent-text);
		white-space: nowrap;
	}

	@media (prefers-reduced-motion: reduce) {
		.fs-tile,
		.fs-card-picture,
		.fs-row,
		.fs-chevron,
		.fs-chevron-icon {
			transition: none;
		}
	}
</style>
