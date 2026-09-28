<script lang="ts">
/**
 * Export through `produce_file` (Feature 2 · Artifacts, Slice 1, T12): PDF,
 * Word and Markdown, offered against the document's own title (never the
 * word "Artifact", ADR-0066). Submits and then gets out of the way — the
 * resulting job is an ordinary produced file, so the File card (retry,
 * progress, download) is what the user watches next, not a second progress
 * UI here (the plan's own rule: "the panel does not poll a second time").
 *
 * Redesigned Wave 2.5 Step 8 (redesign.md §3.2/§9.2/§9.3): a popover anchored
 * to the panel header's own Download button
 * (`[data-testid="artifact-download-button"]` — `DocumentWorkspace.svelte`'s
 * `artifactHeaderActionsSnippet`, rendered once per mobile/desktop shell) on
 * desktop, a `DialogShell` sheet on phones — the exact
 * anchored-popover-desktop/sheet-phone shape `VersionsSheet.svelte` (and,
 * before it, `AppBody.svelte`'s regenerate popover) already use.
 */
import { X } from "@lucide/svelte";
import { scale } from "svelte/transition";
import {
	exportArtifactDocument,
	type ExportArtifactDocumentFormat,
} from "$lib/client/api/artifacts";
import DialogShell, {
	deregisterDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";
import { focusTrap } from "$lib/utils/focus-trap";
import { reducedMotionAware } from "$lib/utils/motion";
import { portalToBody } from "$lib/utils/portal";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";

let {
	artifactId,
	title,
	conversationId = null,
	onClose,
}: {
	artifactId: string;
	title: string;
	conversationId?: string | null;
	onClose: () => void;
} = $props();

type ExportError = "failed" | "tooLarge" | "noConversation";

let submitting = $state(false);
let error = $state<ExportError | null>(null);

function errorText(kind: ExportError): string {
	switch (kind) {
		case "tooLarge":
			return $t("artifacts.document.export.tooLarge");
		case "noConversation":
			return $t("artifacts.document.export.noConversation");
		case "failed":
			return $t("artifacts.document.export.failed");
	}
}

async function download(format: ExportArtifactDocumentFormat): Promise<void> {
	if (submitting) return;
	submitting = true;
	error = null;
	try {
		const result = await exportArtifactDocument(
			artifactId,
			format,
			conversationId,
		);
		if (result.ok) {
			onClose();
			return;
		}
		error =
			result.reason === "source_too_large"
				? "tooLarge"
				: result.reason === "no_conversation"
					? "noConversation"
					: "failed";
	} catch {
		error = "failed";
	} finally {
		submitting = false;
	}
}

function retry(): void {
	error = null;
}

// ---- Wave 2.5 Step 8: anchored popover (desktop) / sheet (phone) ----------
let isPhone = $state(isPhoneViewport());
let popoverStyle = $state<string | undefined>(undefined);
const popoverId = Symbol("document-download-popover");
const popoverScale = reducedMotionAware(scale);

/** The Download button lives in `DocumentWorkspace.svelte`'s shared header-actions snippet, rendered once per shell (mobile/desktop) — both copies share this testid, so this picks whichever one is actually rendered (the other is `display: none` behind a breakpoint). Same query shape as `VersionsSheet.svelte`'s own anchor lookup. */
function findAnchorEl(): HTMLElement | null {
	const candidates = document.querySelectorAll<HTMLElement>(
		'[data-testid="artifact-download-button"]',
	);
	for (const el of candidates) {
		if (el.getClientRects().length > 0) return el;
	}
	return null;
}

function measurePopover(): void {
	if (typeof window === "undefined") return;
	const anchor = findAnchorEl();
	if (!anchor) return;
	const rect = anchor.getBoundingClientRect();
	const right = Math.max(12, window.innerWidth - rect.right);
	popoverStyle = `top: ${rect.bottom + 8}px; right: ${right}px;`;
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
			'[data-testid="document-download-popover"]',
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

{#snippet downloadOptions()}
	{#if error}
		<div class="download-popover-options download-popover-options-column">
			<p class="download-popover-error" role="alert">{errorText(error)}</p>
			<button type="button" class="btn-secondary" onclick={retry}>
				{$t('artifacts.document.export.tryAgain')}
			</button>
		</div>
	{:else}
		<div class="download-popover-options">
			<button
				type="button"
				class="btn-secondary"
				disabled={submitting}
				onclick={() => download('pdf')}
			>
				{$t('artifacts.document.export.pdf')}
			</button>
			<button
				type="button"
				class="btn-secondary"
				disabled={submitting}
				onclick={() => download('docx')}
			>
				{$t('artifacts.document.export.docx')}
			</button>
			<button
				type="button"
				class="btn-secondary"
				disabled={submitting}
				onclick={() => download('markdown')}
			>
				{$t('artifacts.document.export.markdown')}
			</button>
		</div>
		{#if submitting}
			<p class="download-popover-status" role="status">
				{$t('artifacts.document.export.preparing')}
			</p>
		{/if}
	{/if}
{/snippet}

{#if isPhone}
	<!-- zIndexClass: opened from a button inside the mobile shell, whose own
	     `.workspace-mobile-backdrop` sits at `z-index: 95` — DialogShell's
	     default `z-50` would paint behind it. Same fix, same value, as
	     `MobileToolbar.svelte`'s own "More" sheet / `CommentsSheet.svelte`. -->
	<DialogShell
		title={$t('artifacts.document.export.title', { title })}
		phonePresentation="sheet"
		zIndexClass="z-[150]"
		onClose={onClose}
	>
		{@render downloadOptions()}
	</DialogShell>
{:else}
	<div
		class="download-popover"
		style={popoverStyle}
		role="dialog"
		aria-modal="true"
		aria-label={$t('artifacts.document.export.title', { title })}
		data-testid="document-download-popover"
		use:portalToBody
		{@attach popoverFocusTrap}
		transition:popoverScale={{ duration: 150, start: 0.98 }}
	>
		<div class="download-popover-head">
			<h2>{$t('artifacts.document.export.title', { title })}</h2>
			<button
				type="button"
				class="btn-icon-bare"
				aria-label={$t('artifacts.document.export.close')}
				onclick={onClose}
			>
				<X size={16} strokeWidth={2} aria-hidden="true" />
			</button>
		</div>
		{@render downloadOptions()}
	</div>
{/if}

<style>
	.download-popover {
		position: fixed;
		z-index: 60;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		width: min(300px, calc(100vw - 24px));
		padding-bottom: 1rem;
		border-radius: var(--radius-lg, 12px);
		background-color: var(--surface-overlay);
		border: 1px solid var(--border-default);
		box-shadow: var(--shadow-lg);
	}

	.download-popover-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.625rem 0 0.875rem;
	}

	.download-popover-head h2 {
		flex: 1;
		margin: 0;
		font-size: 0.84rem;
		font-weight: 700;
		color: var(--text-primary);
		overflow-wrap: break-word;
	}

	.download-popover-options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0 0.875rem;
	}

	.download-popover-options-column {
		flex-direction: column;
		align-items: flex-start;
	}

	.download-popover-error {
		margin: 0;
		font-size: 0.8125rem;
		color: var(--danger);
	}

	.download-popover-status {
		margin: 0;
		padding: 0 0.875rem;
		font-size: 0.8125rem;
		color: var(--text-muted);
	}
</style>
