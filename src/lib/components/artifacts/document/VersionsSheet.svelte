<script lang="ts">
import { RotateCcw, X } from "@lucide/svelte";
import {
	fetchArtifactVersions,
	restoreArtifactVersion,
} from "$lib/client/api/artifacts";
import { t } from "$lib/i18n";
import type { ArtifactVersionSummary } from "$lib/server/services/artifacts/types";
import { formatRelativeTime } from "$lib/utils/time";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";

/**
 * The Document's version history (Slice 1, T6). Newest first, as the server
 * already orders them; the newest row is "Current" and carries no Restore
 * button — restoring it would be a no-op that still burns a version number.
 * A restore is itself a new version (never coalesced, ruling 47), so nothing
 * here can lose work: the version being replaced stays in the list too.
 */
let {
	artifactId,
	conversationId = null,
	onClose,
	onRestored,
}: {
	artifactId: string;
	conversationId?: string | null;
	onClose: () => void;
	/** Fires with the NEW version number after a successful restore. */
	onRestored?: (version: number) => void;
} = $props();

let versions = $state<ArtifactVersionSummary[]>([]);
let loading = $state(true);
let loadError = $state(false);
let restoringId = $state<string | null>(null);
let restoreError = $state(false);
let confirmTarget = $state<ArtifactVersionSummary | null>(null);

async function load() {
	loading = true;
	loadError = false;
	try {
		versions = await fetchArtifactVersions(artifactId, conversationId);
	} catch {
		loadError = true;
	} finally {
		loading = false;
	}
}

$effect(() => {
	void load();
});

function authorLabel(author: string): string {
	return author === "alfy"
		? $t("artifacts.document.versions.byAlfy")
		: $t("artifacts.document.versions.byUser");
}

async function confirmRestore() {
	const target = confirmTarget;
	confirmTarget = null;
	if (!target) return;
	restoringId = target.id;
	restoreError = false;
	try {
		const version = await restoreArtifactVersion(
			artifactId,
			target.id,
			conversationId,
		);
		onRestored?.(version);
		await load();
	} catch {
		restoreError = true;
	} finally {
		restoringId = null;
	}
}
</script>

<div
	class="versions-sheet"
	role="dialog"
	aria-label={$t('artifacts.document.versions.title')}
>
	<div class="versions-sheet-header">
		<h2 class="versions-sheet-title">{$t('artifacts.document.versions.title')}</h2>
		<button
			type="button"
			class="btn-icon-bare"
			onclick={onClose}
			aria-label={$t('common.close')}
		>
			<X size={16} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>

	{#if loading}
		<div class="versions-sheet-state">{$t('common.loading')}</div>
	{:else if loadError}
		<div class="versions-sheet-state versions-sheet-error">
			<span>{$t('artifacts.document.versions.loadError')}</span>
			<button type="button" class="btn-secondary" onclick={load}>
				{$t('common.retry')}
			</button>
		</div>
	{:else if versions.length === 0}
		<div class="versions-sheet-state">{$t('artifacts.document.versions.empty')}</div>
	{:else}
		<ul class="versions-sheet-list">
			{#each versions as version, index (version.id)}
				{@const current = index === 0}
				<li
					class="versions-sheet-row"
					class:versions-sheet-row-current={current}
				>
					<div class="versions-sheet-row-main">
						<span class="versions-sheet-author">{authorLabel(version.author)}</span>
						<span class="versions-sheet-time">
							{formatRelativeTime(version.createdAt, { t: $t })}
						</span>
						{#if current}
							<span class="versions-sheet-badge">
								{$t('artifacts.document.versions.current')}
							</span>
						{/if}
					</div>
					{#if version.summary}
						<div class="versions-sheet-summary">{version.summary}</div>
					{/if}
					{#if !current}
						<button
							type="button"
							class="btn-secondary versions-sheet-restore"
							disabled={restoringId === version.id}
							onclick={() => {
								confirmTarget = version;
							}}
						>
							<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							{$t('artifacts.document.versions.restore')}
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if restoreError}
		<div class="versions-sheet-state versions-sheet-error">
			{$t('artifacts.document.versions.restoreError')}
		</div>
	{/if}
</div>

{#if confirmTarget}
	<ConfirmDialog
		title={$t('artifacts.document.versions.restore')}
		message={$t('artifacts.document.versions.restoreConfirm')}
		confirmText={$t('artifacts.document.versions.restore')}
		cancelText={$t('common.cancel')}
		onConfirm={confirmRestore}
		onCancel={() => {
			confirmTarget = null;
		}}
	/>
{/if}

<style>
	.versions-sheet {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		background: var(--surface-elevated);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		min-width: 260px;
		max-width: 360px;
	}

	.versions-sheet-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.versions-sheet-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.versions-sheet-state {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 4px;
		color: var(--text-muted);
		font-size: 13px;
	}

	.versions-sheet-error {
		color: var(--status-danger-text, var(--text-primary));
	}

	.versions-sheet-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 320px;
		overflow-y: auto;
	}

	.versions-sheet-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
	}

	.versions-sheet-row-current {
		border-color: var(--border-subtle);
		background: var(--surface-page);
	}

	.versions-sheet-row-main {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
	}

	.versions-sheet-author {
		font-weight: 600;
		color: var(--text-primary);
	}

	.versions-sheet-time {
		color: var(--text-muted);
	}

	.versions-sheet-badge {
		margin-left: auto;
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: 1px 6px;
	}

	.versions-sheet-summary {
		font-size: 12px;
		color: var(--text-muted);
	}

	.versions-sheet-restore {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
	}
</style>
