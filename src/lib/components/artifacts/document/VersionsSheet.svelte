<script lang="ts">
/**
 * The Document's version history (Slice 1, T6; redesigned Wave 2.5 Step 8,
 * redesign.md §3.2/§9.2/§9.3, rebuilt in polish G1-B): a popover anchored under
 * the panel header's own version button (`v6 ▾`,
 * `[data-testid="artifact-version-pill"]`) on desktop, a bottom sheet on
 * phones — both are `AnchoredPopover.svelte`'s job (placement inside the
 * panel, dialog stack, Escape, focus return); this file is what goes in it.
 *
 * Compact two-line rows, as in the approved mockup: avatar (the signed-in
 * user's own, or Alfy's sparkle), name, version tag and relative time on the
 * first line — the newest row also carries a small "Current" pill — and the
 * version's summary, in the reader's language, on the second. Newest first,
 * as the server orders them; the newest is Current and carries no Restore,
 * since restoring it would be a no-op that still burns a version number. A
 * restore is itself a new version (never coalesced, ruling 47), so nothing
 * here can lose work: the version being replaced stays in the list too.
 *
 * Restore appears on hover or keyboard focus (always on touch) over the
 * row's right end WITHOUT taking space from it — the summary keeps its full
 * width at rest and every row keeps the same height — and asks inline (never
 * a separate modal — redesign §3.2), the question taking the row's action
 * area. On success it closes and hands a toast with Undo.
 */
import { RotateCcw, Sparkles } from "@lucide/svelte";
import { tick } from "svelte";
import type { Attachment } from "svelte/attachments";
import {
	fetchArtifactVersions,
	restoreArtifactVersion,
} from "$lib/client/api/artifacts";
import AnchoredPopover from "$lib/components/artifacts/AnchoredPopover.svelte";
import AvatarCircle from "$lib/components/ui/AvatarCircle.svelte";
import { t } from "$lib/i18n";
import type { ArtifactVersionSummary } from "$lib/server/services/artifacts/types";
import { showToast } from "$lib/stores/toast";
import { formatRelativeTime } from "$lib/utils/time";
import { localizeVersionSummary } from "./version-summary";

let {
	artifactId,
	conversationId = null,
	onClose,
	onRestored,
	currentUserId = null,
	currentUserName = null,
	currentUserProfilePicture = null,
}: {
	artifactId: string;
	conversationId?: string | null;
	onClose: () => void;
	/** Fires with the NEW version number after a successful restore. */
	onRestored?: (version: number) => void;
	/**
	 * rd/review-2-5.md:272-275: the signed-in user's own id/name/profile
	 * picture, for a "you" row's real avatar instead of the old literal
	 * `"user"` placeholder — see `ArtifactBodyProps.currentUser`'s own doc
	 * comment.
	 */
	currentUserId?: string | null;
	currentUserName?: string | null;
	currentUserProfilePicture?: string | null;
} = $props();

let versions = $state<ArtifactVersionSummary[]>([]);
let loading = $state(true);
let loadError = $state(false);
let restoringId = $state<string | null>(null);
let restoreError = $state(false);
/** The one row currently asking "Restore v4? …" inline — never a modal. */
let confirmTargetId = $state<string | null>(null);

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

async function confirmRestore(target: ArtifactVersionSummary) {
	confirmTargetId = null;
	// Captured BEFORE the restore so the toast's Undo can put back whatever
	// was current a moment ago — never `target` itself, restoring that again
	// would just recreate the version we are about to replace.
	const previousCurrentId = versions[0]?.id ?? null;
	restoringId = target.id;
	restoreError = false;
	try {
		const newVersion = await restoreArtifactVersion(
			artifactId,
			target.id,
			conversationId,
		);
		onRestored?.(newVersion);
		showToast({
			type: "success",
			message: $t("artifacts.document.versions.restoreToast", {
				from: target.versionNumber,
				to: newVersion,
			}),
			...(previousCurrentId
				? {
						actionLabel: $t("artifacts.document.versions.undo"),
						onAction: () => handleUndo(previousCurrentId),
					}
				: {}),
		});
	} catch {
		restoreError = true;
	} finally {
		restoringId = null;
	}
}

/** The toast's own Undo — a real restore of whatever was current a moment ago, mirroring `AppBody.svelte`'s `handleUndoRegenerate`. */
async function handleUndo(versionId: string): Promise<void> {
	try {
		const restored = await restoreArtifactVersion(
			artifactId,
			versionId,
			conversationId,
		);
		onRestored?.(restored);
	} catch {
		showToast({
			type: "error",
			message: $t("artifacts.document.versions.restoreError"),
		});
	}
}

// ---- keyboard focus around the inline confirm --------------------------
// Opening the question moves focus onto its confirming button; Cancel gives
// focus back to the row's own Restore button, so a keyboard user never loses
// their place in the list.
const restoreButtons = new Map<string, HTMLElement>();

function trackRestoreButton(versionId: string): Attachment<HTMLElement> {
	return (node) => {
		restoreButtons.set(versionId, node);
		return () => {
			if (restoreButtons.get(versionId) === node) {
				restoreButtons.delete(versionId);
			}
		};
	};
}

const focusOnMount: Attachment<HTMLElement> = (node) => {
	node.focus();
};

async function cancelRestore(versionId: string): Promise<void> {
	confirmTargetId = null;
	await tick();
	restoreButtons.get(versionId)?.focus();
}
</script>

{#snippet versionsList()}
	{#if loading}
		<div class="versions-state">{$t('common.loading')}</div>
	{:else if loadError}
		<div class="versions-state versions-state-error">
			<span>{$t('artifacts.document.versions.loadError')}</span>
			<button type="button" class="btn-secondary" onclick={load}>
				{$t('common.retry')}
			</button>
		</div>
	{:else if versions.length === 0}
		<div class="versions-state">{$t('artifacts.document.versions.empty')}</div>
	{:else}
		<ul class="versions-list" data-testid="versions-list">
			{#each versions as version, index (version.id)}
				{@const current = index === 0}
				<li
					class="versions-row"
					class:versions-row-current={current}
					data-testid="version-row"
					data-version={version.versionNumber}
				>
					<span class="versions-avatar">
						{#if version.author === 'alfy'}
							<span class="versions-alfy-avatar" aria-hidden="true">
								<Sparkles size={12} strokeWidth={2} />
							</span>
						{:else}
							<AvatarCircle
								userId={currentUserId ?? 'user'}
								name={currentUserName}
								profilePicture={currentUserProfilePicture}
								size={22}
							/>
						{/if}
					</span>
					<span class="versions-line1">
						<span class="versions-author">{authorLabel(version.author)}</span>
						<span class="versions-num">
							{$t('artifacts.card.version', { n: version.versionNumber })}
						</span>
						<span class="versions-time">
							{formatRelativeTime(version.createdAt, { t: $t })}
						</span>
						{#if current}
							<span class="versions-current">
								{$t('artifacts.document.versions.current')}
							</span>
						{/if}
					</span>
					<span class="versions-summary">
						{localizeVersionSummary(version.summary, $t)}
					</span>
					{#if !current}
						{#if confirmTargetId === version.id}
							<div class="versions-confirm">
								<span class="versions-confirm-text">
									{$t('artifacts.document.versions.restoreConfirm', {
										v: version.versionNumber,
									})}
								</span>
								<span class="versions-confirm-actions">
									<button
										type="button"
										class="btn-ghost btn-sm"
										onclick={() => cancelRestore(version.id)}
									>
										{$t('common.cancel')}
									</button>
									<button
										type="button"
										class="btn-primary btn-sm"
										disabled={restoringId === version.id}
										onclick={() => confirmRestore(version)}
										{@attach focusOnMount}
									>
										<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
										{$t('artifacts.document.versions.restore')}
									</button>
								</span>
							</div>
						{:else}
							<span class="versions-action">
								<button
									type="button"
									class="versions-restore"
									disabled={restoringId === version.id}
									onclick={() => (confirmTargetId = version.id)}
									{@attach trackRestoreButton(version.id)}
								>
									<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
									{$t('artifacts.document.versions.restore')}
								</button>
							</span>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if restoreError}
		<div class="versions-state versions-state-error">
			{$t('artifacts.document.versions.restoreError')}
		</div>
	{/if}
{/snippet}

<AnchoredPopover
	title={$t('artifacts.document.versions.title')}
	anchorTestId="artifact-version-pill"
	popoverTestId="document-versions-popover"
	closeLabel={$t('common.close')}
	width={340}
	{onClose}
>
	{@render versionsList()}
</AnchoredPopover>

<style>
	.versions-state {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 14px 14px;
		color: var(--text-muted);
		font-size: 13px;
	}

	.versions-state-error {
		color: var(--danger);
	}

	.versions-list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0 6px 8px;
		list-style: none;
	}

	/* Two lines, one grid: the avatar spans both, the summary sits under the
	   first line. Every row is the same height whether or not it offers
	   Restore — that button is overlaid on the right end while hovered or
	   focused, never laid out beside the text. */
	.versions-row {
		position: relative;
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr);
		column-gap: 10px;
		row-gap: 2px;
		align-items: center;
		padding: 8px;
		border-radius: 9px;
	}

	/* The newest row has nothing to act on, so it has no hover state. */
	.versions-row:not(.versions-row-current):hover,
	.versions-row:focus-within {
		background: var(--surface-elevated);
	}

	.versions-avatar {
		grid-column: 1;
		grid-row: 1 / span 2;
		display: inline-flex;
	}

	.versions-alfy-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		border-radius: var(--radius-full, 999px);
		background-color: var(--accent-tint);
		color: var(--accent-text);
	}

	.versions-line1 {
		grid-column: 2;
		grid-row: 1;
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		font-size: 12.5px;
		line-height: 1.25;
	}

	.versions-author {
		font-weight: 700;
		color: var(--text-primary);
	}

	.versions-num {
		font-size: 11px;
		font-weight: 700;
		color: var(--text-muted);
	}

	.versions-time {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
	}

	.versions-current {
		display: inline-flex;
		align-items: center;
		align-self: center;
		height: 20px;
		padding: 0 7px;
		border-radius: var(--radius-full, 999px);
		background: var(--surface-elevated);
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.versions-summary {
		grid-column: 2;
		grid-row: 2;
		min-height: 1.25em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
		line-height: 1.25;
		color: var(--text-muted);
	}

	/* Restore, redesign §3.2: "appears on hover or focus (always shown on
	   touch)". Overlaid on the row's right end, vertically centred, over a
	   short fade so the text it covers is not cut off hard; a keyboard user
	   still reaches it with Tab whatever its opacity, and focusing it shows
	   it. */
	.versions-action {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		padding: 0 8px 0 28px;
		border-radius: 0 9px 9px 0;
		background: linear-gradient(
			to right,
			transparent,
			var(--surface-elevated) 24px
		);
		opacity: 0;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.versions-row:hover .versions-action,
	.versions-row:focus-within .versions-action {
		opacity: 1;
	}

	.versions-restore {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 24px;
		padding: 0 9px;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-page);
		color: var(--text-primary);
		font-size: 11.5px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}

	.versions-restore:hover {
		background: var(--surface-overlay);
	}

	.versions-restore:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.versions-restore:disabled {
		opacity: 0.6;
		cursor: default;
	}

	/* The question takes the row's action area: on its own line under the
	   summary, spanning the text column. */
	.versions-confirm {
		grid-column: 2;
		grid-row: 3;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 8px;
		padding-top: 6px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.versions-confirm-text {
		flex: 1 1 12rem;
	}

	.versions-confirm-actions {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-left: auto;
	}

	/* Touch: no hover to reveal it, so Restore is always there, as its own
	   column beside the text (44px target) rather than over it. */
	@media (hover: none) and (pointer: coarse) {
		.versions-row {
			grid-template-columns: 22px minmax(0, 1fr) auto;
		}

		.versions-action {
			position: static;
			grid-column: 3;
			grid-row: 1 / span 2;
			padding: 0;
			border-radius: 0;
			background: none;
			opacity: 1;
		}

		.versions-restore {
			min-height: 44px;
			min-width: 44px;
			padding: 0 10px;
			font-size: 12px;
		}

		/* Its own column costs the summary room, so the summary may take a
		   second line instead of being cut off — a phone has the height. */
		.versions-summary {
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			white-space: normal;
		}

		.versions-confirm {
			grid-column: 2 / span 2;
		}
	}
</style>
