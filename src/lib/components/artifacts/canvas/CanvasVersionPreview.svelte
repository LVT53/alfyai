<script module lang="ts">
import type {
	SvelteFlowProvider as SvelteFlowProviderComponent,
	ViewportPortal as ViewportPortalComponent,
} from "@xyflow/svelte";
import type { sameCamera as sameCameraFunction } from "./_lib/board-model";
import type CanvasBoardComponent from "./CanvasBoard.svelte";

/**
 * What the preview draws its board with: the editor's own `CanvasBoard` and the
 * flow library's two parts it needs, handed over by `CanvasEditor.svelte` when
 * History's registry asks for this entry (`loadHistoryPreview`). They are not
 * imported here on purpose: see `history-parts.ts`.
 */
export type BoardParts = {
	CanvasBoard: typeof CanvasBoardComponent;
	SvelteFlowProvider: typeof SvelteFlowProviderComponent;
	ViewportPortal: typeof ViewportPortalComponent;
	/** The board's own "is the camera still where it was put" (`board-model.ts`). */
	sameCamera: typeof sameCameraFunction;
};

let boardParts: BoardParts | null = null;
export function provideBoardParts(next: BoardParts): void {
	boardParts = next;
}
</script>

<script lang="ts">
/**
 * A board's version, read-only, with its changes marked (ruling 76,
 * versioning.md §5.4): the board as it was, drawn by the editor's own board (so
 * every block looks exactly as it does when it is edited) with nothing to pick,
 * move or type in, and the changes of "This version's changes" (against the
 * version before) or "Compared with now" (against the newest) drawn over it: a
 * ring on every block touched, "New" and "Moved" tags, a faint trail from where a
 * moved block stood and a dashed ghost where something is gone
 * (`HistoryDiffLayer.svelte`). The camera is fitted to the marked blocks, and
 * stays where the reader puts it once they pan or zoom.
 *
 * The same changes are a list of buttons for a screen reader and the keyboard
 * ("Rainy day frame, added"): visually hidden until it has the focus, each button
 * takes the camera to its block. The stepper in the toolbar walks the same list.
 *
 * The bodies come from the existing version route, kept by `version-bodies.ts`.
 * What is compared is `diffBoards`, the comparison the review landing and the
 * server's count of waiting changes are made from.
 */
import { untrack } from "svelte";
import type { HistoryPreviewProps } from "$lib/components/artifacts/history/history-previews";
import { versionBody } from "$lib/components/artifacts/history/version-bodies";
import { t, type I18nKey } from "$lib/i18n";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import {
	emptyCanvasBody,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import { metaFor } from "./_lib/block-meta";
import type { BoardLayerApi } from "./_lib/board-layers";
import {
	type BoardChange,
	type Camera,
	buildHistoryView,
	fitCamera,
	focusRects,
	type HistoryBoardView,
	unionOf,
} from "./_lib/history-view";
import HistoryDiffLayer from "./HistoryDiffLayer.svelte";

let {
	artifactId,
	conversationId,
	versionId,
	baseVersionId,
	compare,
	author,
	nowVersionId,
	nowHash,
	label,
	changeCursor,
	onState,
}: HistoryPreviewProps = $props();

// Handed over before this component is made (`provideBoardParts`), and never again:
// read once, so there is nothing to react to.
const parts = boardParts;

/** A body over this many characters is not compared (the server does not diff it either): "Too large to compare". */
const LARGE_BODY_CHARS = 256 * 1024;

const NO_VIEW: HistoryBoardView = {
	changes: [],
	ringIds: [],
	newIds: [],
	moved: [],
	ghosts: [],
};

let status = $state<"loading" | "ready" | "error" | "large">("loading");
let view = $state.raw<HistoryBoardView>(NO_VIEW);
/** The board shown: the selected version's own, with the camera fitted to what it changed. Read once by a board when it mounts, so a different version mounts a new board. */
let boardBody = $state.raw<CanvasBody | null>(null);
let boardKey = $state(0);
let shownVersionId: string | null = null;
let hadBase = $state(false);
let paneWidth = $state(0);
let paneHeight = $state(0);
let boardApi = $state<{
	getCamera: () => Camera;
	setCamera: (camera: Camera) => Promise<boolean>;
} | null>(null);
/** The camera as this preview last put it: while the camera is still there it is the preview's to fit, and once the reader moves it, it is theirs. */
let fittedCamera: Camera | null = null;
let flash = $state.raw<{ id: string; nonce: number } | null>(null);
let flashCount = 0;
let token = 0;

function parse(raw: string): CanvasBody {
	try {
		return normalizeCanvasBody(raw.trim() ? JSON.parse(raw) : {}).body;
	} catch {
		return emptyCanvasBody();
	}
}

function bodyOf(id: string): Promise<string> {
	return versionBody({
		artifactId,
		versionId: id,
		conversationId,
		nowVersionId,
		nowHash,
	});
}

function cameraFor(
	nextView: HistoryBoardView,
	body: CanvasBody,
	width: number,
	height: number,
): Camera | null {
	const box = unionOf(focusRects(nextView, body.nodes));
	return box ? fitCamera(box, { width, height }) : null;
}

async function load(id: string, baseId: string | null): Promise<void> {
	const mine = ++token;
	// What is already drawn stays while the comparison is swapped (the same version
	// against another base); only a version nothing is drawn for shows the skeleton.
	if (shownVersionId !== id) {
		status = "loading";
		onState({ status: "loading", changeCount: 0 });
	}
	try {
		const [targetRaw, baseRaw] = await Promise.all([
			bodyOf(id),
			baseId ? bodyOf(baseId) : Promise.resolve<string | null>(null),
		]);
		const large =
			targetRaw.length > LARGE_BODY_CHARS ||
			(baseRaw !== null && baseRaw.length > LARGE_BODY_CHARS);
		const target = parse(targetRaw);
		const base = baseRaw === null || large ? null : parse(baseRaw);
		const nextView = buildHistoryView(base, target);
		if (mine !== token) return;
		if (shownVersionId !== id || boardBody === null) {
			shownVersionId = id;
			const camera = cameraFor(nextView, target, paneWidth, paneHeight);
			fittedCamera = camera;
			boardApi = null;
			boardBody = camera ? { ...target, viewport: camera } : target;
			boardKey += 1;
		}
		view = nextView;
		hadBase = base !== null;
		status = large ? "large" : "ready";
		onState({ status, changeCount: large ? 0 : nextView.changes.length });
	} catch {
		if (mine !== token) return;
		status = "error";
		onState({ status: "error", changeCount: 0 });
	}
}

$effect(() => {
	const id = versionId;
	const baseId = baseVersionId;
	// What the compared-with body is when the newest row's burst saved again.
	nowHash;
	void load(id, baseId);
});

// The camera follows the pane and the comparison until the reader moves it: a
// layout that changes (the rail, the window), or "Compared with now" marking
// other blocks than "This version's changes" did.
$effect(() => {
	const api = boardApi;
	const body = boardBody;
	const current = view;
	const width = paneWidth;
	const height = paneHeight;
	if (!api || !body || width <= 0 || height <= 0) return;
	untrack(() => {
		const camera = cameraFor(current, body, width, height);
		if (!camera) return;
		if (
			fittedCamera !== null &&
			!parts?.sameCamera(api.getCamera(), fittedCamera)
		) {
			return;
		}
		if (fittedCamera !== null && parts?.sameCamera(camera, fittedCamera)) {
			return;
		}
		fittedCamera = camera;
		void api.setCamera(camera);
	});
});

// The stepper: ring the change and bring the camera to it.
let seenCursor = -1;
$effect(() => {
	const { index, nonce } = changeCursor;
	if (nonce === seenCursor) return;
	seenCursor = nonce;
	if (index < 0 || status !== "ready") return;
	const change = view.changes[index];
	if (change) flash = { id: change.id, nonce: ++flashCount };
});

function showChange(change: BoardChange): void {
	flash = { id: change.id, nonce: ++flashCount };
}

function nameOf(change: BoardChange): string {
	const words =
		change.label ?? $t(metaFor(change.blockKind).labelKey as I18nKey);
	return $t(`artifacts.history.canvas.change.${change.kind}` as I18nKey, {
		label: words,
	});
}

const note = $derived(
	status === "large"
		? $t("artifacts.history.tooLarge")
		: status === "ready" &&
				hadBase &&
				compare === "step" &&
				view.changes.length === 0
			? $t("artifacts.history.noChanges")
			: null,
);
const tone = $derived(
	compare === "step" && author === "alfy" ? "alfy" : "user",
);
const tagLabels = $derived({
	new: $t("artifacts.history.canvas.tagNew"),
	moved: $t("artifacts.history.canvas.tagMoved"),
	removed: $t("artifacts.history.canvas.tagRemoved"),
});
</script>

{#snippet previewLayers(api: BoardLayerApi)}
	{#if parts}
		{@const Portal = parts.ViewportPortal}
		<!-- What the version changed, in board space: rings, tags, trails, ghosts. -->
		<Portal target="front">
			<HistoryDiffLayer
				nodes={api.nodes}
				viewport={api.viewport}
				{view}
				{tone}
				{flash}
				oncenter={api.centerOn}
				labels={tagLabels}
			/>
		</Portal>
	{/if}
{/snippet}

<div
	class="history-board"
	role="group"
	aria-label={label}
	aria-busy={status === 'loading'}
	data-testid="history-preview"
	data-kind="canvas"
	bind:clientWidth={paneWidth}
	bind:clientHeight={paneHeight}
>
	{#if status === 'error'}
		<div class="state" role="alert">
			<span>{$t('artifacts.history.previewError')}</span>
			<button type="button" class="btn-secondary btn-sm" onclick={() => load(versionId, baseVersionId)}>
				{$t('common.retry')}
			</button>
		</div>
	{:else if boardBody === null}
		<div class="skeleton" aria-hidden="true">
			<span class="card card-a"></span>
			<span class="card card-b"></span>
			<span class="card card-c"></span>
		</div>
	{:else}
		{#key boardKey}
			{#if parts}
				{@const Provider = parts.SvelteFlowProvider}
				{@const Board = parts.CanvasBoard}
				<Provider>
					<Board
						bind:this={boardApi}
						body={boardBody}
						readonly
						preview
						onchange={() => {}}
						layers={previewLayers}
						emptyLine={$t('artifacts.history.canvas.emptyBoard')}
					/>
				</Provider>
			{/if}
		{/key}
		{#if note}
			<p class="note" data-testid="history-preview-note">{note}</p>
		{/if}
		{#if view.changes.length > 0}
			<!-- The changes as a list of buttons: out of sight until one has the focus,
			     then a small card over the board's corner; each takes the camera to its block. -->
			<ul class="changes" aria-label={$t('artifacts.history.canvas.changesLabel')} data-testid="history-board-changes">
				{#each view.changes as change (change.id)}
					<li>
						<button type="button" class="change" onclick={() => showChange(change)}>{nameOf(change)}</button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>

<style>
	.history-board {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		background: var(--surface-page);
	}

	.state {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 2rem 1rem;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.skeleton {
		position: relative;
		flex: 1 1 auto;
		min-height: 14rem;
	}

	.card {
		position: absolute;
		display: block;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		animation: history-board-pulse 1.4s ease-in-out infinite;
	}

	.card-a {
		left: 12%;
		top: 18%;
		width: 26%;
		height: 4.5rem;
	}

	.card-b {
		left: 46%;
		top: 30%;
		width: 24%;
		height: 3.5rem;
	}

	.card-c {
		left: 22%;
		top: 56%;
		width: 30%;
		height: 5rem;
	}

	@keyframes history-board-pulse {
		50% {
			opacity: 0.55;
		}
	}

	/* What the comparison found (or did not), over the top of the board. */
	.note {
		position: absolute;
		top: 0.75rem;
		left: 50%;
		margin: 0;
		padding: 0.25rem 0.75rem;
		transform: translateX(-50%);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-full);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 600;
		pointer-events: none;
	}

	/* Hidden from the eye, not from a screen reader or the keyboard; a card in the corner once a button has the focus. */
	.changes {
		position: absolute;
		top: 0.5rem;
		left: 0.5rem;
		z-index: 3;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.changes:not(:focus-within) {
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.changes:focus-within {
		max-width: min(22rem, 70%);
		max-height: 40%;
		overflow-y: auto;
		padding: 0.25rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-md);
	}

	.change {
		display: block;
		width: 100%;
		min-height: 2rem;
		padding: 0.25rem 0.625rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-primary);
		font-size: 0.8125rem;
		text-align: left;
		cursor: pointer;
	}

	.change:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: -2px;
	}
</style>
