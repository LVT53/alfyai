<script lang="ts">
/**
 * The Document's comment margin (Feature 2 · Artifacts, Slice 1, T10): one
 * thread per root comment, each shown against the anchor's CURRENT
 * resolution against `blocks` — recomputed on every render, never persisted,
 * since the stored anchor (quote/prefix/suffix) is the one ground truth and
 * the resolution is a pure read (ruling 11: this Document resolver is the
 * text half of the shared anchor interface).
 *
 * A `null` or malformed anchor (T10.9 — `parseArtifactAnchor` already turned
 * an unparseable row into `null` before this component ever sees it) renders
 * exactly like a resolved-orphan: the body and thread stay visible, never a
 * crash. This is the one comment state a user cannot cause on purpose, which
 * is exactly why it must never be the one that ships broken.
 */
import { t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import {
	anchorTone,
	ORPHANED_ANCHOR_RESOLUTION,
	type AnchorResolution,
} from "$lib/shared/artifacts/anchor";
import { resolveTextAnchor } from "$lib/shared/artifact-document/anchor";
import type { DocumentBlock } from "$lib/shared/artifact-document/blocks";
import CommentThread from "./CommentThread.svelte";

let {
	comments,
	blocks,
	onResolve,
	onSubmitReply,
}: {
	comments: ArtifactComment[];
	blocks: DocumentBlock[];
	onResolve: (commentId: string, resolved: boolean) => void | Promise<void>;
	onSubmitReply: (parentId: string, body: string) => void | Promise<void>;
} = $props();

function resolutionFor(comment: ArtifactComment): AnchorResolution {
	if (!comment.anchor || comment.anchor.kind !== "text") {
		return ORPHANED_ANCHOR_RESOLUTION;
	}
	return resolveTextAnchor(comment.anchor, blocks);
}

function toneLabel(resolution: AnchorResolution): string {
	switch (resolution.state) {
		case "exact":
			return $t("artifacts.document.anchor.exact");
		case "moved":
			return $t("artifacts.document.anchor.moved");
		case "orphaned":
			return $t("artifacts.document.anchor.orphaned");
	}
}
</script>

<div class="margin-panel" aria-label={$t('artifacts.document.margin.title')}>
	{#if comments.length === 0}
		<p class="margin-panel-empty">{$t('artifacts.document.margin.empty')}</p>
	{:else}
		{#each comments as comment (comment.id)}
			{@const resolution = resolutionFor(comment)}
			<section class="margin-panel-item">
				<span
					class="margin-panel-tone"
					class:margin-panel-tone-warning={anchorTone(resolution.state) === 'warning'}
					class:margin-panel-tone-faint={anchorTone(resolution.state) === 'faint'}
				>
					{toneLabel(resolution)}
				</span>
				{#if comment.anchor?.kind === 'text'}
					<blockquote class="margin-panel-quote">"{comment.anchor.quote}"</blockquote>
				{/if}
				<CommentThread
					thread={comment}
					onResolve={(resolved) => onResolve(comment.id, resolved)}
					{onSubmitReply}
				/>
			</section>
		{/each}
	{/if}
</div>

<style>
	.margin-panel {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		overflow-y: auto;
	}

	.margin-panel-empty {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.margin-panel-item {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.margin-panel-tone {
		align-self: flex-start;
		padding: 0.0625rem 0.375rem;
		border-radius: var(--radius-full, 999px);
		background-color: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
	}

	.margin-panel-tone-warning {
		color: var(--status-warning-text, #8a6100);
		background-color: var(--status-warning-surface, #fff3cd);
	}

	.margin-panel-tone-faint {
		opacity: 0.6;
	}

	.margin-panel-quote {
		margin: 0;
		padding-left: 0.5rem;
		border-left: 2px solid var(--border-default);
		color: var(--text-muted);
		font-size: 0.75rem;
		font-style: italic;
	}
</style>
