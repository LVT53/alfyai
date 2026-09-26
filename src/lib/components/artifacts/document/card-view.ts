/**
 * The Document's own mapping onto the shared `ArtifactCardView` (Feature 2 ·
 * Artifacts, Slice 1, T9): the tab-count subtitle and the first-five-item
 * tickable checklist (spec §2.3), both derived from data a caller already has
 * once a Document's body and metadata are loaded (the panel, or a future
 * chat card). Pure — no `@tiptap/*`, no Svelte, no `$lib/server/**` value
 * import (only `ArtifactMetadata`'s TYPE, which SvelteKit erases at build
 * time and never actually reaches the browser bundle) — so this module is
 * safe for `ArtifactCard.svelte` and any other browser caller.
 *
 * `subtitle` and `madeBy` are both ALREADY-LOCALISED strings the caller
 * builds through `$t(...)` before calling this function, mirroring
 * `ArtifactCard.svelte`'s existing `madeBy` convention (`DocumentWorkspace.svelte`'s
 * own list-building code already does this for every kind) — this module
 * stays free of i18n so it does not need a Svelte reactive context to run.
 */
import type {
	ArtifactCardTickableItem,
	ArtifactCardView,
} from "$lib/components/artifacts/ArtifactCard.svelte";
import type {
	ArtifactMetadata,
	DocumentCardPreview,
} from "$lib/server/services/artifacts/types";
import {
	parseDocument,
	readTaskBlock,
} from "$lib/shared/artifact-document/blocks";

export interface DocumentCardTabInfo {
	id: string;
	title: string;
	startBlockId: string;
}

/**
 * `metadata.tabs`, read defensively — the client-side twin of
 * `document-ops.ts`'s `documentTabsFromMetadata`, kept separate because that
 * one lives under `$lib/server/**` and importing it here would pull a
 * server-only module into the browser bundle. Malformed or missing reads as
 * `[]`, never a throw, exactly like its server-side counterpart.
 */
export function documentTabsFromCardMetadata(
	metadata: ArtifactMetadata | null | undefined,
): DocumentCardTabInfo[] {
	const raw = (metadata as { tabs?: unknown } | null | undefined)?.tabs;
	if (!Array.isArray(raw)) return [];
	const tabs: DocumentCardTabInfo[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const { id, title, startBlockId } = entry as Record<string, unknown>;
		if (
			typeof id === "string" &&
			typeof title === "string" &&
			typeof startBlockId === "string"
		) {
			tabs.push({ id, title, startBlockId });
		}
	}
	return tabs;
}

/** The tab count the `artifacts.document.cardSubtitle` template's `{count}` needs. */
export function documentCardTabCount(
	metadata: ArtifactMetadata | null | undefined,
): number {
	return documentTabsFromCardMetadata(metadata).length;
}

export interface DocumentCardViewParams {
	artifactId: string;
	title: string;
	versionNumber: number;
	/** Already-localised, e.g. `$t('artifacts.card.madeBy', {...})`. */
	madeBy?: string | null;
	/** Already-localised, e.g. `$t('artifacts.document.cardSubtitle', {count: documentCardTabCount(metadata)})`. */
	subtitle?: string | null;
	body: string | null;
	/**
	 * Fires with the toggled item's id and its NEW checked state. The caller
	 * writes it back through the SAME patch path every other edit uses
	 * (`toggleTask`) — never a second write path (T9.7) — and the checkbox
	 * only shows its new state once that write is reflected back into `body`
	 * on the next render; a refused toggle simply leaves `body` (and so the
	 * checkbox) exactly as it was.
	 */
	onToggleTask: (blockId: string, checked: boolean) => void;
}

/**
 * The one `tickable` builder both card views share: given the checklist
 * items a caller already resolved (from a full body, or from the bounded
 * server preview) and how many task items REALLY exist (`totalCount` —
 * equal to `items.length` unless the caller is working from a bounded
 * subset), returns `ArtifactCardView["tickable"]`. `null` when there is no
 * checklist at all, so `ArtifactCard.svelte` renders nothing and a Document
 * with no tasks looks like any other card.
 */
function buildTickable(
	items: ArtifactCardTickableItem[],
	totalCount: number,
	onToggleTask: (blockId: string, checked: boolean) => void,
): ArtifactCardView["tickable"] {
	if (totalCount === 0) return null;
	return {
		items,
		totalCount,
		onToggle: (id) => {
			const item = items.find((candidate) => candidate.id === id);
			if (item) onToggleTask(id, !item.done);
		},
	};
}

/**
 * Builds the Document's `ArtifactCardView` from a FULL body (the panel,
 * which already has one loaded) — see `documentArtifactCardViewFromPreview`
 * below for the chat card's bounded-preview counterpart.
 */
export function documentArtifactCardView(
	params: DocumentCardViewParams,
): ArtifactCardView {
	const blocks = params.body
		? parseDocument(params.body, { mint: false }).blocks
		: [];
	const items: ArtifactCardTickableItem[] = [];
	for (const block of blocks) {
		const task = readTaskBlock(block);
		if (task) items.push({ id: block.id, text: task.text, done: task.checked });
	}

	return {
		id: params.artifactId,
		kind: "document",
		title: params.title,
		subtitle: params.subtitle ?? null,
		madeBy: params.madeBy ?? null,
		versionNumber: params.versionNumber,
		openTargetId: params.artifactId,
		tickable: buildTickable(items, items.length, params.onToggleTask),
	};
}

export interface DocumentCardViewFromPreviewParams {
	artifactId: string;
	title: string;
	versionNumber: number;
	/** Already-localised, e.g. `$t('artifacts.card.madeBy', {...})`. */
	madeBy?: string | null;
	/** Already-localised, e.g. `$t('artifacts.document.cardSubtitle', {count: preview.tabCount})`. */
	subtitle?: string | null;
	/** `ArtifactCardSummary.documentPreview` — bounded, server-computed, never the whole body (T9 steps 4/7). */
	preview: DocumentCardPreview;
	/** Same contract as `DocumentCardViewParams.onToggleTask`. */
	onToggleTask: (blockId: string, checked: boolean) => void;
}

/**
 * The chat card's own builder (T9 steps 4/7): identical shape to
 * `documentArtifactCardView`, but reads the bounded, ALREADY-COMPUTED server
 * preview instead of parsing a full body this caller never has (and must
 * never fetch just to render a card) — `preview.totalTaskCount` is what lets
 * `ArtifactCard.svelte` show "+N more" correctly even though `preview.tasks`
 * itself never carries more than the first five.
 */
export function documentArtifactCardViewFromPreview(
	params: DocumentCardViewFromPreviewParams,
): ArtifactCardView {
	const items: ArtifactCardTickableItem[] = params.preview.tasks.map(
		(task) => ({ id: task.blockId, text: task.text, done: task.checked }),
	);
	return {
		id: params.artifactId,
		kind: "document",
		title: params.title,
		subtitle: params.subtitle ?? null,
		madeBy: params.madeBy ?? null,
		versionNumber: params.versionNumber,
		openTargetId: params.artifactId,
		tickable: buildTickable(
			items,
			params.preview.totalTaskCount,
			params.onToggleTask,
		),
	};
}
