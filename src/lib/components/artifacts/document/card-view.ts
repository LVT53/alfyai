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
import type { ArtifactMetadata } from "$lib/server/services/artifacts/types";
import { parseDocument } from "$lib/shared/artifact-document/blocks";

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

/** A `taskList` block's checked state — the first line's `[x]`/`[ ]`, mirroring `patch.ts`'s own `toggleTaskItem` reader. */
function isTaskChecked(blockMarkdown: string): boolean {
	return /^\s*[-*+]\s+\[[xX]\]/.test(blockMarkdown.split("\n")[0] ?? "");
}

/** A task item's visible text, stripped of its `- [ ]`/`- [x]` marker. */
function taskItemText(blockMarkdown: string): string {
	return blockMarkdown.replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, "").trim();
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
 * Builds the Document's `ArtifactCardView`. `tickable` is `null` when the
 * document has no task list at all — `ArtifactCard.svelte` renders nothing
 * for a `null` `tickable`, so a Document with no checklist looks like any
 * other card.
 */
export function documentArtifactCardView(
	params: DocumentCardViewParams,
): ArtifactCardView {
	const blocks = params.body
		? parseDocument(params.body, { mint: false }).blocks
		: [];
	const taskBlocks = blocks.filter((block) => block.kind === "taskList");
	const items: ArtifactCardTickableItem[] = taskBlocks.map((block) => ({
		id: block.id,
		text: taskItemText(block.markdown),
		done: isTaskChecked(block.markdown),
	}));

	return {
		id: params.artifactId,
		kind: "document",
		title: params.title,
		subtitle: params.subtitle ?? null,
		madeBy: params.madeBy ?? null,
		versionNumber: params.versionNumber,
		openTargetId: params.artifactId,
		tickable:
			items.length > 0
				? {
						items,
						onToggle: (id) => {
							const item = items.find((candidate) => candidate.id === id);
							if (item) params.onToggleTask(id, !item.done);
						},
					}
				: null,
	};
}
