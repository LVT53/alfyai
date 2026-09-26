<script lang="ts">
// The one card every artifact kind renders as, in chat and in the panel's
// list (Slice 0 Task S6). Two chrome modes share one body-dispatch:
// "full" draws the header row (icon, title, kind label, version pill, Open)
// for the panel list; "body" renders only the kind's body — no title, icon,
// kind label or version pill of its own — for a host that already draws its
// own header.
//
// Every kind hosted by ToolActivityRow is such a host: the row chrome always
// renders its own icon and its own verb+object line (`item.object`) before
// the body ever opens — a produced file's ("Produced budget.xlsx") exactly
// as much as a create_artifact/edit_artifact call's ("Created Weekend
// plan"). chrome="body" must never repeat that line: the File body
// (`FileProductionCard.svelte`, moved here from ToolActivityRow, imported
// lazily so a chat page with no file-producing turn never pays for its
// chunk) never has, and the other four kinds' chat card follows the same
// rule — subtitle, tickable items and Open still render under chrome="body",
// only the header does not. Asserted by ArtifactCard.test.ts and
// ToolActivityRow.test.ts: the composed row+body markup shows a title
// exactly once, for every kind.
import {
	AppWindow,
	FileText,
	Presentation,
	Shapes,
	SquarePen,
} from "@lucide/svelte";
import type { Component } from "svelte";
import { t, type I18nKey } from "$lib/i18n";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";

export interface ArtifactCardTickableItem {
	id: string;
	text: string;
	done: boolean;
}

export interface ArtifactCardView {
	id: string;
	kind: ArtifactKind;
	title: string;
	/**
	 * A second line under the title, e.g. the Document's "Document · 3 tabs"
	 * (T9.4, `documentArtifactCardView` in `document/card-view.ts`) —
	 * already-localised by the caller, exactly like `madeBy`. `null`/omitted
	 * renders nothing, so every other kind is unaffected by this field.
	 */
	subtitle?: string | null;
	/** Rendered as "made by Alfy {when}"; the caller supplies the already-localised time. */
	madeBy?: string | null;
	versionNumber?: number | null;
	/** Null while a job is still running, so Open is not offered. */
	openTargetId?: string | null;
	tickable?: {
		items: ArtifactCardTickableItem[];
		/**
		 * How many task items REALLY exist — equal to `items.length` unless the
		 * caller is working from a bounded subset (the chat card's server
		 * preview, T9 steps 4/7, never carries more than the first five).
		 * Falls back to `items.length` when omitted, so a full-body caller
		 * (the panel) needs no change.
		 */
		totalCount?: number;
		onToggle: (id: string) => void;
	} | null;
}

let {
	view,
	job = null,
	chrome = "full",
	onOpen = undefined,
	onOpenDocument = undefined,
	onRetry = undefined,
	onCancel = undefined,
	onDismiss = undefined,
}: {
	view: ArtifactCardView;
	/** Live job state for the File kind in the chat. */
	job?: FileProductionJob | null;
	/** "full" draws the header row; "body" renders only the body, for a host that draws its own header. */
	chrome?: "full" | "body";
	onOpen?: ((artifactId: string) => void) | undefined;
	/**
	 * The File body's own per-file Open action (one job can produce several
	 * files, each its own DocumentWorkspaceItem) — narrower than `onOpen`'s
	 * one artifact id, so it is its own prop rather than overloading `onOpen`.
	 */
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onRetry?: ((jobId: string) => void) | undefined;
	onCancel?: ((jobId: string) => void) | undefined;
	onDismiss?: ((jobId: string) => void) | undefined;
} = $props();

const TICKABLE_VISIBLE_LIMIT = 5;

const KIND_ICONS: Record<ArtifactKind, Component> = {
	file: FileText,
	document: SquarePen,
	app: AppWindow,
	canvas: Shapes,
	slides: Presentation,
};

let KindIcon = $derived(KIND_ICONS[view.kind]);
let visibleTickableItems = $derived(
	view.tickable?.items.slice(0, TICKABLE_VISIBLE_LIMIT) ?? [],
);
let hiddenTickableCount = $derived(
	Math.max(
		0,
		(view.tickable?.totalCount ?? view.tickable?.items.length ?? 0) -
			TICKABLE_VISIBLE_LIMIT,
	),
);

// The File body is lazy: a chat page with no file-producing turn must not
// pay for FileProductionCard's chunk. Cached so re-opening the same job
// does not re-request the module.
let FileProductionBody = $state<
	typeof import("../chat/FileProductionCard.svelte").default | null
>(null);
$effect(() => {
	if (view.kind !== "file" || !job || FileProductionBody) return;
	// Guard against setting state once this effect is no longer live: the
	// card can unmount (row collapsed, panel closed) before the dynamic
	// import resolves, and an unguarded `.then()` would still write to
	// `FileProductionBody` after teardown. The cleanup below runs
	// synchronously on unmount (and before any re-run of this effect), so
	// `cancelled` is already true by the time a stale import settles.
	let cancelled = false;
	void import("../chat/FileProductionCard.svelte").then((module) => {
		if (!cancelled) FileProductionBody = module.default;
	});
	return () => {
		cancelled = true;
	};
});

function handleOpen(): void {
	if (view.openTargetId) onOpen?.(view.openTargetId);
}
</script>

{#if chrome === 'body' && view.kind === 'file'}
	{#if job && FileProductionBody}
		<FileProductionBody {job} {onOpenDocument} {onRetry} {onCancel} {onDismiss} />
	{/if}
{:else}
	<div class="artifact-card" data-testid="artifact-card">
		{#if chrome === 'full'}
			<div class="artifact-card-header">
				<span class="artifact-card-icon" aria-hidden="true">
					<KindIcon size={16} strokeWidth={1.75} aria-hidden="true" />
				</span>
				<span class="artifact-card-title">{view.title}</span>
				<span class="artifact-card-kind">{$t(`artifacts.type.${view.kind}` as I18nKey)}</span>
				{#if view.versionNumber}
					<span class="artifact-card-version">{$t('artifacts.card.version', { n: view.versionNumber })}</span>
				{/if}
			</div>
		{/if}

		{#if view.subtitle}
			<div class="artifact-card-subtitle">{view.subtitle}</div>
		{/if}

		{#if view.madeBy}
			<div class="artifact-card-madeby">{view.madeBy}</div>
		{/if}

		{#if view.tickable}
			<ul class="artifact-card-tickable">
				{#each visibleTickableItems as tickItem (tickItem.id)}
					<li>
						<label class="artifact-card-tick-row">
							<input
								type="checkbox"
								checked={tickItem.done}
								onchange={() => view.tickable?.onToggle(tickItem.id)}
							/>
							<span class:artifact-card-tick-done={tickItem.done}>{tickItem.text}</span>
						</label>
					</li>
				{/each}
			</ul>
			{#if hiddenTickableCount > 0}
				<div class="artifact-card-more">
					{$t('artifacts.card.moreItems', { count: hiddenTickableCount })}
				</div>
			{/if}
		{/if}

		{#if view.openTargetId}
			<button type="button" class="artifact-card-open" onclick={handleOpen}>
				{$t('artifacts.card.open')}
			</button>
		{/if}
	</div>
{/if}

<style>
	.artifact-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs, 0.375rem);
	}

	.artifact-card-header {
		display: flex;
		align-items: center;
		gap: var(--space-xs, 0.375rem);
		min-width: 0;
	}

	.artifact-card-icon {
		display: inline-flex;
		flex: 0 0 auto;
		color: var(--icon-muted);
	}

	.artifact-card-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-primary);
		font-weight: 600;
	}

	.artifact-card-kind,
	.artifact-card-version {
		flex: 0 0 auto;
		padding: 0.05rem 0.42rem;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: var(--text-2xs, 0.66rem);
		font-weight: 600;
	}

	.artifact-card-subtitle,
	.artifact-card-madeby {
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.artifact-card-tickable {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.artifact-card-tick-row {
		display: flex;
		align-items: center;
		gap: var(--space-xs, 0.375rem);
		color: var(--text-primary);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.artifact-card-tick-done {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.artifact-card-more {
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.artifact-card-open {
		align-self: flex-start;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		padding: 0.3rem 0.7rem;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.artifact-card-open:hover {
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-elevated));
	}

	.artifact-card-open:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
