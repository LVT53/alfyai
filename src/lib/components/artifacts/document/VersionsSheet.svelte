<script lang="ts">
/**
 * The Document's version history (Slice 1, T6; redesigned Wave 2.5 Step 8,
 * redesign.md §3.2/§9.2/§9.3): a popover anchored to the panel header's own
 * version button (`v6 ▾`, `[data-testid="artifact-version-pill"]` —
 * `ArtifactPanelHeader.svelte`, rendered once per mobile/desktop shell in
 * `DocumentWorkspace.svelte`, so the lookup picks whichever copy is actually
 * visible) on desktop, a `DialogShell` sheet on phones — the same
 * anchored-popover-desktop/sheet-phone shape `AppBody.svelte`'s regenerate
 * popover already established (rd5b's own hand-off note): rect-based
 * `position: fixed` placement, `focusTrap` joined to `DialogShell`'s own
 * topmost stack so Escape here never also closes some OTHER open dialog, and
 * `portalToBody` so the panel's own overflow can never clip it.
 *
 * Newest first, as the server already orders them; the newest row is
 * "Current" and carries no Restore button — restoring it would be a no-op
 * that still burns a version number. A restore is itself a new version
 * (never coalesced, ruling 47), so nothing here can lose work: the version
 * being replaced stays in the list too. Restoring asks inline (never a
 * separate modal — redesign §3.2: "asks inline") and, on success, closes
 * (matching the mockup's own `doRestore`) and hands a toast with Undo.
 */
import { RotateCcw, Sparkles, X } from "@lucide/svelte";
import { scale } from "svelte/transition";
import {
	fetchArtifactVersions,
	restoreArtifactVersion,
} from "$lib/client/api/artifacts";
import AvatarCircle from "$lib/components/ui/AvatarCircle.svelte";
import DialogShell, {
	deregisterDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import { showToast } from "$lib/stores/toast";
import type { ArtifactVersionSummary } from "$lib/server/services/artifacts/types";
import { focusTrap } from "$lib/utils/focus-trap";
import { reducedMotionAware } from "$lib/utils/motion";
import { portalToBody } from "$lib/utils/portal";
import { formatRelativeTime } from "$lib/utils/time";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";

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

// ---- Wave 2.5 Step 8: anchored popover (desktop) / sheet (phone) ----------
let isPhone = $state(isPhoneViewport());
let popoverStyle = $state<string | undefined>(undefined);
const popoverId = Symbol("document-versions-popover");
const popoverScale = reducedMotionAware(scale);

/** The version button lives in `ArtifactPanelHeader.svelte`, rendered once per shell (mobile/desktop) by `DocumentWorkspace.svelte` — both copies share this testid, so this picks whichever one is actually rendered (the other is `display: none` behind a breakpoint). Same query shape as `AppBody.svelte`'s own click-outside check. */
function findAnchorEl(): HTMLElement | null {
	const candidates = document.querySelectorAll<HTMLElement>(
		'[data-testid="artifact-version-pill"]',
	);
	for (const el of candidates) {
		if (el.getClientRects().length > 0) return el;
	}
	return null;
}

// Review 2.5 (rd/review-2-5.md:168-175): right-aligning to the trigger's
// RIGHT edge (extending `POPOVER_WIDTH` further left from there) put the
// popover off-screen entirely in the expanded panel (the version button
// sits near the panel's own left edge) and bleeding out of the panel over
// the chat column in docked mode. Anchoring to the trigger's LEFT edge
// instead, clamped into the viewport on both sides, keeps the popover
// beside its own trigger in every presentation.
const POPOVER_WIDTH = 340;
const VIEWPORT_MARGIN = 12;

function measurePopover(): void {
	if (typeof window === "undefined") return;
	const anchor = findAnchorEl();
	if (!anchor) return;
	const rect = anchor.getBoundingClientRect();
	const width = Math.min(
		POPOVER_WIDTH,
		window.innerWidth - VIEWPORT_MARGIN * 2,
	);
	const maxLeft = Math.max(
		VIEWPORT_MARGIN,
		window.innerWidth - width - VIEWPORT_MARGIN,
	);
	const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), maxLeft);
	popoverStyle = `top: ${rect.bottom + 8}px; left: ${left}px;`;
}

$effect(() => {
	const stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});
	return stopWatchingViewport;
});

$effect(() => {
	if (isPhone) return;
	registerDialog(popoverId);
	measurePopover();
	const handleReflow = () => measurePopover();
	const handlePointerDown = (event: MouseEvent | TouchEvent) => {
		const target = event.target as Node;
		if (findAnchorEl()?.contains(target)) return;
		const popover = document.querySelector(
			'[data-testid="document-versions-popover"]',
		);
		if (popover && !popover.contains(target)) onClose();
	};
	window.addEventListener("resize", handleReflow);
	window.addEventListener("scroll", handleReflow, true);
	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });
	return () => {
		deregisterDialog(popoverId);
		window.removeEventListener("resize", handleReflow);
		window.removeEventListener("scroll", handleReflow, true);
		document.removeEventListener("mousedown", handlePointerDown);
		document.removeEventListener("touchstart", handlePointerDown);
	};
});

const popoverFocusTrap = focusTrap({
	isTopmost: () => isTopmostDialog(popoverId),
	onEscape: (event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		onClose();
	},
	focus: { defer: true },
	restoreFocusOnCleanup: true,
});
</script>

{#snippet versionsList()}
	{#if loading}
		<div class="versions-popover-state">{$t('common.loading')}</div>
	{:else if loadError}
		<div class="versions-popover-state versions-popover-error">
			<span>{$t('artifacts.document.versions.loadError')}</span>
			<button type="button" class="btn-secondary" onclick={load}>
				{$t('common.retry')}
			</button>
		</div>
	{:else if versions.length === 0}
		<div class="versions-popover-state">{$t('artifacts.document.versions.empty')}</div>
	{:else}
		<ul class="versions-popover-list">
			{#each versions as version, index (version.id)}
				{@const current = index === 0}
				<li
					class="versions-popover-row"
					class:versions-popover-row-current={current}
				>
					<div class="versions-popover-row-avatar">
						{#if version.author === 'alfy'}
							<span class="versions-popover-alfy-avatar" aria-hidden="true">
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
					</div>
					<div class="versions-popover-row-main">
						<div class="versions-popover-row-line1">
							<span class="versions-popover-author">{authorLabel(version.author)}</span>
							<span class="versions-popover-version">
								{$t('artifacts.card.version', { n: version.versionNumber })}
							</span>
							<span class="versions-popover-time">
								{formatRelativeTime(version.createdAt, { t: $t })}
							</span>
							{#if current}
								<span class="versions-popover-badge">
									{$t('artifacts.document.versions.current')}
								</span>
							{/if}
						</div>
						{#if version.summary}
							<div class="versions-popover-summary">{version.summary}</div>
						{/if}
						{#if !current}
							{#if confirmTargetId === version.id}
								<div class="versions-popover-confirm">
									<span>
										{$t('artifacts.document.versions.restoreConfirm', {
											v: version.versionNumber,
										})}
									</span>
									<span class="versions-popover-confirm-grow"></span>
									<button
										type="button"
										class="btn-ghost btn-sm"
										onclick={() => (confirmTargetId = null)}
									>
										{$t('common.cancel')}
									</button>
									<button
										type="button"
										class="btn-primary btn-sm"
										disabled={restoringId === version.id}
										onclick={() => confirmRestore(version)}
									>
										<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
										{$t('artifacts.document.versions.restore')}
									</button>
								</div>
							{:else}
								<button
									type="button"
									class="btn-secondary btn-sm versions-popover-restore"
									disabled={restoringId === version.id}
									onclick={() => (confirmTargetId = version.id)}
								>
									<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
									{$t('artifacts.document.versions.restore')}
								</button>
							{/if}
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if restoreError}
		<div class="versions-popover-state versions-popover-error">
			{$t('artifacts.document.versions.restoreError')}
		</div>
	{/if}
{/snippet}

{#if isPhone}
	<!-- zIndexClass: opened from a button inside the mobile shell, whose own
	     `.workspace-mobile-backdrop` sits at `z-index: 95` — DialogShell's
	     default `z-50` would paint behind it. Same fix, same value, as
	     `MobileToolbar.svelte`'s own "More" sheet / `CommentsSheet.svelte`. -->
	<DialogShell
		title={$t('artifacts.document.versions.title')}
		phonePresentation="sheet"
		zIndexClass="z-[150]"
		onClose={onClose}
	>
		{@render versionsList()}
	</DialogShell>
{:else}
	<div
		class="versions-popover"
		style={popoverStyle}
		role="dialog"
		aria-modal="true"
		aria-label={$t('artifacts.document.versions.title')}
		data-testid="document-versions-popover"
		use:portalToBody
		{@attach popoverFocusTrap}
		transition:popoverScale={{ duration: 150, start: 0.98 }}
	>
		<div class="versions-popover-head">
			<h2>{$t('artifacts.document.versions.title')}</h2>
			<button
				type="button"
				class="btn-icon-bare"
				onclick={onClose}
				aria-label={$t('common.close')}
			>
				<X size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
		{@render versionsList()}
	</div>
{/if}

<style>
	.versions-popover {
		position: fixed;
		/* Review 2.5 (rd/review-2-5.md:168-175): 60 rendered UNDER the
		   expanded panel shell (`DocumentWorkspace.svelte`'s
		   `.workspace-shell-expanded`, z-index 115). 130 clears it, matching
		   the existing precedent `ConfirmDialog.svelte` already sets as its
		   own default `zIndexClass="z-[130]"` for "must be above other
		   floating chrome". */
		z-index: 130;
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: min(340px, calc(100vw - 24px));
		border-radius: var(--radius-lg, 12px);
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		box-shadow: var(--shadow-lg);
	}

	.versions-popover-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.625rem 0.375rem 0.875rem;
	}

	.versions-popover-head h2 {
		flex: 1;
		margin: 0;
		font-size: 0.84rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.versions-popover-state {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 14px 14px;
		color: var(--text-muted);
		font-size: 13px;
	}

	.versions-popover-error {
		color: var(--danger);
	}

	.versions-popover-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: 0 6px 8px;
		list-style: none;
		max-height: 330px;
		overflow-y: auto;
	}

	.versions-popover-row {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr);
		gap: 2px 8px;
		align-items: start;
		padding: 8px;
		border-radius: var(--radius-md);
	}

	.versions-popover-row:hover,
	.versions-popover-row:focus-within {
		background: var(--surface-elevated);
	}

	.versions-popover-row-current {
		background: var(--surface-page);
	}

	.versions-popover-row-avatar {
		grid-row: 1 / span 2;
		padding-top: 1px;
	}

	.versions-popover-alfy-avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		border-radius: var(--radius-full, 999px);
		background-color: var(--accent-tint);
		color: var(--accent-text);
		font-size: 11px;
	}

	.versions-popover-row-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.versions-popover-row-line1 {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 4px 6px;
		font-size: 12.5px;
	}

	.versions-popover-author {
		font-weight: 700;
		color: var(--text-primary);
	}

	.versions-popover-version {
		font-size: 11px;
		font-weight: 700;
		color: var(--text-muted);
	}

	.versions-popover-time {
		color: var(--text-muted);
	}

	.versions-popover-badge {
		margin-left: auto;
		font-size: 11px;
		color: var(--text-muted);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		padding: 1px 6px;
	}

	.versions-popover-summary {
		font-size: 12.5px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Redesign §3.2: "Restore appears on hover or focus (always shown on
	   touch)". A keyboard user still reaches it via Tab regardless of
	   opacity — this only hides it visually until the row is meaningfully
	   engaged with. */
	.versions-popover-restore {
		align-self: flex-start;
		opacity: 0;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.versions-popover-row:hover .versions-popover-restore,
	.versions-popover-row:focus-within .versions-popover-restore {
		opacity: 1;
	}

	@media (hover: none) and (pointer: coarse) {
		.versions-popover-restore {
			opacity: 1;
		}
	}

	.versions-popover-confirm {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding-top: 4px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.versions-popover-confirm-grow {
		flex: 1 1 auto;
	}
</style>
