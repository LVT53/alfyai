<script lang="ts">
// The App's panel body (Feature 2 · Artifacts, Slice 2; redesigned Wave 2.5
// Step 13): a status row (fact-check line, Alfy's note, glitches), a
// segmented Preview/Code control beside "Change this app…", the running
// frame (AppFrame owns its own sandbox bar) or the read-only code view, and
// the regenerate popover. This is the whole App surface (Owner decision 8) —
// no debug gallery, no attempt history, no "show the prompt". Download lives
// in the shared panel header now (`registerPanelActions`), never here.
//
// `ArtifactBodyProps.body` is always null at this call site
// (`DocumentWorkspace.svelte` never passes a body today), so this component
// fetches its own detail — the same pattern any other kind's body will need
// once it, too, wants more than the id/kind/title the registry hands it.
import {
	Check,
	ChevronDown,
	CodeXml,
	Copy,
	Eye,
	Info,
	Shield,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	TriangleAlert,
	X,
} from "@lucide/svelte";
import { untrack } from "svelte";
import { scale } from "svelte/transition";
import DialogShell, {
	deregisterDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import type { ArtifactPanelBodyActions } from "$lib/components/artifacts/artifact-bodies";
import { t, type I18nKey } from "$lib/i18n";
import { isDark } from "$lib/stores/theme";
import { showToast } from "$lib/stores/toast";
import { focusTrap } from "$lib/utils/focus-trap";
import { reducedMotionAware } from "$lib/utils/motion";
import { portalToBody } from "$lib/utils/portal";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import {
	downloadAppAsHtml,
	fetchArtifact,
	regenerateApp,
	restoreArtifactVersion,
	type ArtifactDetailResponse,
} from "$lib/client/api/artifacts";
import type { AppContractRuleId } from "$lib/server/services/artifacts/app/contract";
import type { AppVerificationVerdict } from "$lib/server/services/artifacts/app/verify";
import { APP_VERIFY_LINE_KEYS } from "$lib/shared/artifacts/app-verify-labels";
import { renderHighlightedText } from "$lib/services/markdown";
import AppFrame from "./AppFrame.svelte";

interface Props {
	artifactId: string;
	kind: string;
	title: string;
	body: string | null;
	/** The conversation the PANEL is showing (ruling 51) — passed to fetchArtifact and every artifact route this body calls, so an incognito conversation's own App resolves. Distinct from the artifact's OWN conversationId (below), which is a fact about the artifact, not about where it is being viewed from. */
	conversationId?: string | null;
	/** Wave 2.5 Step 13: hands the panel header a direct download trigger — App has no Versions sheet, so only `openDownload` is ever registered. See `ArtifactBodyProps`'s own doc comment. */
	registerPanelActions?: (actions: ArtifactPanelBodyActions) => void;
}

let {
	artifactId,
	title,
	conversationId = null,
	registerPanelActions,
}: Props = $props();

let detail = $state<ArtifactDetailResponse | null>(null);
let loadFailed = $state(false);
let activeTab = $state<"preview" | "code">("preview");
let highlightedCode = $state<string | null>(null);
let copyLabel = $state<"copy" | "copied">("copy");
let noteOpen = $state(false);

let downloadBusy = $state(false);
let downloadError = $state<string | null>(null);

let regeneratePopoverOpen = $state(false);
let regeneratePromptText = $state("");
let regenerateBusy = $state(false);
let regenerateError = $state<string | null>(null);
let regenerateTriggerEl = $state<HTMLButtonElement | null>(null);
let regenerateTextareaEl = $state<HTMLTextAreaElement | null>(null);
let regeneratePopoverStyle = $state<string | undefined>(undefined);
let isPhone = $state(isPhoneViewport());

// The panel reuses this body when its rail switches from one App to another,
// so `artifactId` can change under a live component. Another App's detail is
// dropped at once (the card shows the loading state, never the last App's
// verification line or code under the next App's frame), and an answer that
// arrives for an App the card has already left is discarded. A reload of the
// SAME App (after a regenerate) keeps the old detail until the new one lands.
// The read of `detail` is untracked: `load` runs inside the effect below, and
// a tracked read would re-run that effect on every detail it writes.
async function load(id: string): Promise<void> {
	loadFailed = false;
	const shown = untrack(() => detail);
	if (shown && shown.artifact.id !== id) {
		detail = null;
		// Wave 2.5 Step 13: transient UI state belongs to whichever App is on
		// screen, not to this component instance across a switch — a note left
		// open, or a regenerate error/veil for the app just left, must not
		// bleed onto the next one.
		noteOpen = false;
		activeTab = "preview";
		regeneratePopoverOpen = false;
		regenerateError = null;
		regenerateBusy = false;
	}
	try {
		const next = await fetchArtifact(id, conversationId);
		if (id !== artifactId) return;
		detail = next;
	} catch {
		if (id !== artifactId) return;
		loadFailed = true;
	}
}

$effect(() => {
	void load(artifactId);
});

let htmlBody = $derived(detail?.artifact.body ?? "");
let versionNumber = $derived(detail?.artifact.versionNumber ?? 0);
/** Whether the App is linked to ANY conversation at all (spec §4: a project-linked App has none) — the domain fact that gates download, independent of which conversation the panel happens to be showing it from. */
let artifactConversationId = $derived(detail?.artifact.conversationId ?? null);
let metadata = $derived(
	(detail?.artifact.metadata ?? {}) as Record<string, unknown>,
);
let glitchRuleIds = $derived(
	Array.isArray(metadata.glitchRuleIds)
		? (metadata.glitchRuleIds as AppContractRuleId[])
		: [],
);
let verification = $derived(
	metadata.verification as
		| {
				checked: boolean;
				verdict: AppVerificationVerdict;
				reason: string | null;
		  }
		| undefined,
);
let verificationNote = $derived(
	detail?.comments.find(
		(comment) => comment.author === "alfy" && comment.parentId === null,
	) ?? null,
);

const GLITCH_MESSAGE_KEYS: Partial<Record<AppContractRuleId, I18nKey>> = {
	"no-network-api": "artifacts.app.glitch.network",
	"no-web-storage": "artifacts.app.glitch.storage",
	"no-script-src": "artifacts.app.glitch.external",
	"no-link-href": "artifacts.app.glitch.external",
	"no-remote-img": "artifacts.app.glitch.external",
};
let glitchMessageKeys = $derived(
	// The five glitch rules collapse into three user-visible sentences
	// (Contracts) — de-duplicated, in a stable order.
	[...new Set(glitchRuleIds.map((rule) => GLITCH_MESSAGE_KEYS[rule]))].filter(
		(key): key is I18nKey => Boolean(key),
	),
);

/** Redesign §6.2: ShieldCheck for clean/repaired, ShieldAlert for uncertain, a muted Shield for unavailable. */
const VERIFY_ICONS: Record<AppVerificationVerdict, typeof ShieldCheck> = {
	clean: ShieldCheck,
	repaired: ShieldCheck,
	uncertain: ShieldAlert,
	unavailable: Shield,
};
let VerifyIcon = $derived(
	verification ? VERIFY_ICONS[verification.verdict] : ShieldCheck,
);

/**
 * Ruling 58 (RV-2A open question 10): loads the highlighter — and the "html"
 * grammar — ON DEMAND when the Code tab opens, through the existing async
 * Shiki path, rather than relying on the chat surface having already called
 * `initHighlighter()` for its own markdown rendering. Without this,
 * `renderCodeBlock`'s own synchronous fallback (safe, but unhighlighted
 * escaped plain text) is what a card shows whenever nothing else in the app
 * happened to initialise Shiki first.
 */
async function ensureCodeHighlighted(): Promise<void> {
	if (!htmlBody) return;
	highlightedCode = await renderHighlightedText(htmlBody, "html", $isDark);
}

$effect(() => {
	if (activeTab === "code") void ensureCodeHighlighted();
});

async function copyCode(): Promise<void> {
	try {
		await navigator.clipboard.writeText(htmlBody);
		copyLabel = "copied";
		setTimeout(() => {
			copyLabel = "copy";
		}, 1500);
	} catch {
		// Clipboard access can be refused by the browser; there is nothing
		// actionable beyond leaving the button in its normal state.
	}
}

async function handleDownload(): Promise<void> {
	if (!artifactConversationId || downloadBusy) return;
	downloadBusy = true;
	downloadError = null;
	try {
		const result = await downloadAppAsHtml(artifactId, conversationId);
		if (!result.ok) downloadError = result.reason;
	} catch {
		downloadError = "failed";
	} finally {
		downloadBusy = false;
	}
}

/**
 * Wave 2.5 Step 13: hands the panel header a download trigger whenever the
 * App actually has one to save (registered `undefined` otherwise, so the
 * header shows no button at all rather than one that would silently no-op —
 * `DocumentWorkspace.svelte`'s own header only renders the action when
 * `bodyPanelActions?.openDownload` is truthy). Re-registers whenever this
 * changes, an `$effect` rather than a one-time call for the same reason
 * `DocumentBody.svelte`'s own version does (see `registerPanelActions`'s doc
 * comment in artifact-bodies.ts).
 */
$effect(() => {
	registerPanelActions?.({
		openDownload: artifactConversationId ? handleDownload : undefined,
	});
});

const REGENERATE_FAILURE_KEYS: Record<string, I18nKey> = {
	empty_content: "artifacts.app.failed.emptyContent",
	no_fence: "artifacts.app.failed.noFence",
	tool_call: "artifacts.app.failed.toolCall",
	too_long: "artifacts.app.failed.tooLong",
};

/**
 * Ruling 58: the download error is always a localized sentence, never
 * `result.reason` (a wire-level reason/intake-error code) or the bare word
 * "failed" shown straight to the user. `conversation_required` is the
 * server's own backstop for the same case the disabled button already
 * explains proactively (no conversation), so it reuses that copy; every
 * other reason — a race where the artifact vanished, a file-production
 * intake failure, the request itself throwing — falls back to one generic
 * "could not prepare this for download" sentence.
 */
const DOWNLOAD_FAILURE_KEYS: Partial<Record<string, I18nKey>> = {
	conversation_required: "artifacts.app.download.unavailable",
};
function localizeDownloadFailure(reason: string): string {
	return $t(DOWNLOAD_FAILURE_KEYS[reason] ?? "artifacts.app.download.failed");
}

/** The main "Change this app…" button — starts clean (empty prompt, no stale error from a previous attempt). */
function openRegeneratePopoverFresh(): void {
	regenerateError = null;
	regeneratePromptText = "";
	regeneratePopoverOpen = true;
}

/** The failed status row's "Try again" — reopens WITHOUT discarding the prompt the user already wrote (redesign §6.3's own "failed" state, same spirit as the old dialog's 409 handling). */
function retryRegenerate(): void {
	regeneratePopoverOpen = true;
}

function closeRegeneratePopover(): void {
	regeneratePopoverOpen = false;
}

async function submitRegenerate(): Promise<void> {
	if (!regeneratePromptText.trim() || regenerateBusy) return;
	// Snapshotted so a switch to a DIFFERENT App while this call is still in
	// flight can never write this call's result onto the wrong App's UI —
	// `load()`'s own id check already guards its half; every write below is
	// guarded the same way.
	const id = artifactId;
	const promptText = regeneratePromptText.trim();
	const expectVersion = versionNumber;
	const scopedConversationId = conversationId;
	// Wave 2.5 Step 13: the CURRENT version's own id, captured before the
	// call below writes a new one — this is what the v2 toast's Undo restores
	// through `restoreArtifactVersion` (a real, already-existing mechanism:
	// versions.ts's `restoreVersion`, the same one the Document History sheet
	// uses), never a fabricated affordance with nothing behind it.
	const restoreVersionId = untrack(() => detail)?.versions[0]?.id ?? null;
	regeneratePopoverOpen = false;
	regenerateError = null;
	regenerateBusy = true;
	try {
		const result = await regenerateApp(
			id,
			promptText,
			expectVersion,
			scopedConversationId,
		);
		if (id !== artifactId) return;
		if (result.ok) {
			await load(id);
			showToast({
				type: "success",
				message: $t("artifacts.app.toast.v2Ready"),
				duration: 5200,
				...(restoreVersionId
					? {
							actionLabel: $t("artifacts.app.toast.undo"),
							onAction: () => handleUndoRegenerate(id, restoreVersionId),
						}
					: {}),
			});
			return;
		}
		regenerateError =
			result.reason === "version_conflict" ? "version_conflict" : result.reason;
	} catch {
		if (id !== artifactId) return;
		regenerateError = "provider_error";
	} finally {
		if (id === artifactId) regenerateBusy = false;
	}
}

/** The v2 toast's Undo — a real restore, not a fabricated one (see `submitRegenerate`'s own note). */
async function handleUndoRegenerate(
	id: string,
	versionId: string,
): Promise<void> {
	try {
		await restoreArtifactVersion(id, versionId, conversationId);
		if (id !== artifactId) return;
		await load(id);
	} catch {
		if (id !== artifactId) return;
		showToast({ type: "error", message: $t("artifacts.app.toast.undoFailed") });
	}
}

// ---- Wave 2.5 Step 13: the regenerate popover — anchored to its button on
// desktop, a DialogShell sheet on phones. Joins DialogShell's own topmost
// stack (registerDialog/isTopmostDialog/deregisterDialog, exported from its
// module context for exactly this — see that file's own comment) so Escape
// here does not also reach some OTHER dialog open at the same time, and vice
// versa.
const regeneratePopoverId = Symbol("app-regenerate-popover");
const popoverScale = reducedMotionAware(scale);

function measureRegeneratePopover(): void {
	if (typeof window === "undefined" || !regenerateTriggerEl) return;
	const rect = regenerateTriggerEl.getBoundingClientRect();
	const right = Math.max(12, window.innerWidth - rect.right);
	regeneratePopoverStyle = `top: ${rect.bottom + 8}px; right: ${right}px;`;
}

$effect(() => {
	const stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});
	return stopWatchingViewport;
});

$effect(() => {
	if (!regeneratePopoverOpen || isPhone) return;
	registerDialog(regeneratePopoverId);
	measureRegeneratePopover();
	const handleReflow = () => measureRegeneratePopover();
	const handlePointerDown = (event: MouseEvent | TouchEvent) => {
		const target = event.target as Node;
		if (regenerateTriggerEl?.contains(target)) return;
		const popover = document.querySelector(
			'[data-testid="app-regenerate-popover"]',
		);
		if (popover && !popover.contains(target)) closeRegeneratePopover();
	};
	window.addEventListener("resize", handleReflow);
	window.addEventListener("scroll", handleReflow, true);
	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });
	return () => {
		deregisterDialog(regeneratePopoverId);
		window.removeEventListener("resize", handleReflow);
		window.removeEventListener("scroll", handleReflow, true);
		document.removeEventListener("mousedown", handlePointerDown);
		document.removeEventListener("touchstart", handlePointerDown);
	};
});

const regeneratePopoverFocusTrap = focusTrap({
	isTopmost: () => isTopmostDialog(regeneratePopoverId),
	onEscape: (event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		closeRegeneratePopover();
	},
	focus: { target: () => regenerateTextareaEl, defer: true },
	restoreFocusOnCleanup: true,
});
</script>

{#snippet regenerateFormContent()}
	<label class="app-regen-label" for="app-regen-input-{artifactId}">
		{$t('artifacts.app.regenerate.prompt')}
	</label>
	<textarea
		id="app-regen-input-{artifactId}"
		bind:this={regenerateTextareaEl}
		class="app-regen-textarea"
		bind:value={regeneratePromptText}
		disabled={regenerateBusy}
	></textarea>
	{#if regenerateError}
		<p class="app-regen-error">
			{regenerateError === 'version_conflict'
				? $t('artifacts.error.load')
				: $t(REGENERATE_FAILURE_KEYS[regenerateError] ?? 'artifacts.app.serve.failed')}
		</p>
	{/if}
	<div class="app-regen-footer">
		<span class="app-regen-grow"></span>
		<button type="button" class="btn-ghost btn-sm" onclick={closeRegeneratePopover}>
			{$t('artifacts.app.regenerate.cancel')}
		</button>
		<button
			type="button"
			class="btn-primary btn-sm"
			disabled={!regeneratePromptText.trim() || regenerateBusy}
			onclick={submitRegenerate}
		>
			<Sparkles size={13} strokeWidth={1.75} aria-hidden="true" />
			{$t('artifacts.app.regenerate.makeV2')}
		</button>
	</div>
	<div class="app-regen-effect">
		<Info size={13} strokeWidth={1.75} aria-hidden="true" />
		<span>{$t('artifacts.app.regenerate.effect')}</span>
	</div>
{/snippet}

<div class="app-body">
	{#if loadFailed}
		<div class="app-body-state app-body-error" role="alert">
			<p>{$t('artifacts.app.serve.failed')}</p>
			<button type="button" class="app-body-retry" onclick={() => load(artifactId)}>
				{$t('artifacts.action.retry')}
			</button>
		</div>
	{:else if !detail}
		<div class="app-body-state app-body-loading" aria-busy="true">
			<p>{$t('artifacts.app.generating')}</p>
			<p class="app-body-hint">{$t('artifacts.app.generating.hint')}</p>
		</div>
	{:else}
		<!-- Redesign §6.2: the status row sits directly under the shared header,
		     above Preview/Code — never inside the preview tab panel, so it stays
		     visible (and meaningful) on the Code tab too. -->
		<div class="app-status" data-testid="app-status-row">
			{#if regenerateBusy}
				<div class="app-status-row" role="status" aria-live="polite">
					<span class="app-status-spinner" aria-hidden="true"></span>
					<span>{$t('artifacts.app.verify.checking')}</span>
				</div>
			{:else if regenerateError && !regeneratePopoverOpen}
				<div class="app-status-row app-status-warning" role="alert">
					<TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
					<span>{$t('artifacts.app.regenerate.failed')}</span>
					<span class="app-status-grow"></span>
					<button type="button" class="btn-ghost btn-sm" onclick={retryRegenerate}>
						{$t('artifacts.action.retry')}
					</button>
				</div>
			{:else if verification?.checked}
				<div
					class="app-status-row"
					class:app-status-warning={verification.verdict === 'uncertain'}
					class:app-status-muted={verification.verdict === 'unavailable'}
				>
					<VerifyIcon size={16} strokeWidth={1.75} aria-hidden="true" />
					<span>{$t(APP_VERIFY_LINE_KEYS[verification.verdict])}</span>
					<span class="app-status-grow"></span>
					{#if (verification.verdict === 'repaired' || verification.verdict === 'uncertain') && verificationNote}
						<button
							type="button"
							class="btn-ghost btn-sm"
							aria-expanded={noteOpen}
							aria-controls="app-note-{artifactId}"
							onclick={() => (noteOpen = !noteOpen)}
						>
							{$t('artifacts.app.verify.readNote')}
							<span class="app-status-note-chevron" class:app-status-note-chevron-open={noteOpen}>
								<ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
							</span>
						</button>
					{/if}
				</div>
			{/if}

			{#if verificationNote}
				<div class="app-note-wrap" class:app-note-open={noteOpen} id="app-note-{artifactId}">
					<div class="app-note-inner">
						<div class="app-note" data-testid="app-verify-note">
							<div class="app-note-title">{$t('artifacts.app.verify.noteTitle')}</div>
							<div class="app-note-body">{verificationNote.body}</div>
						</div>
					</div>
				</div>
			{/if}

			{#each glitchMessageKeys as key (key)}
				<div class="app-status-row app-status-warning">
					<TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
					<span>{$t(key)}</span>
				</div>
			{/each}
		</div>

		<div class="app-bar">
			<div class="app-seg" role="tablist" aria-label={$t('artifacts.app.tabs.a11y')}>
				<span
					class="app-seg-thumb"
					class:app-seg-thumb-code={activeTab === 'code'}
					aria-hidden="true"
				></span>
				<button
					type="button"
					role="tab"
					id="app-tab-preview-{artifactId}"
					aria-selected={activeTab === 'preview'}
					aria-controls="app-panel-preview-{artifactId}"
					class="app-seg-tab"
					onclick={() => (activeTab = 'preview')}
				>
					<Eye size={14} strokeWidth={1.75} aria-hidden="true" />
					{$t('artifacts.app.tab.preview')}
				</button>
				<button
					type="button"
					role="tab"
					id="app-tab-code-{artifactId}"
					aria-selected={activeTab === 'code'}
					aria-controls="app-panel-code-{artifactId}"
					class="app-seg-tab"
					onclick={() => (activeTab = 'code')}
				>
					<CodeXml size={14} strokeWidth={1.75} aria-hidden="true" />
					{$t('artifacts.app.tab.code')}
				</button>
			</div>
			<span class="app-bar-grow"></span>
			<button
				type="button"
				class="btn-primary btn-sm"
				bind:this={regenerateTriggerEl}
				aria-haspopup="dialog"
				aria-expanded={regeneratePopoverOpen}
				disabled={regenerateBusy}
				onclick={openRegeneratePopoverFresh}
			>
				<Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
				{$t('artifacts.app.action.regenerate')}
			</button>
		</div>

		{#if !artifactConversationId}
			<p class="app-body-hint" data-testid="app-download-unavailable-hint">
				{$t('artifacts.app.download.unavailable')}
			</p>
		{/if}
		{#if downloadError}
			<p class="app-body-hint app-body-error-text">
				{localizeDownloadFailure(downloadError)}
			</p>
		{/if}

		<div class="app-stage">
			{#if activeTab === 'preview'}
				<div
					id="app-panel-preview-{artifactId}"
					role="tabpanel"
					aria-labelledby="app-tab-preview-{artifactId}"
					class="app-body-frame-wrap"
					inert={regenerateBusy}
				>
					<AppFrame {artifactId} version={versionNumber} {title} {conversationId} />
				</div>
			{:else}
				<div
					id="app-panel-code-{artifactId}"
					role="tabpanel"
					aria-labelledby="app-tab-code-{artifactId}"
					class="app-body-code"
				>
					<div class="app-body-code-actions">
						<button type="button" class="app-body-copy" onclick={copyCode}>
							{#if copyLabel === 'copied'}
								<Check size={14} strokeWidth={1.75} aria-hidden="true" />
								{$t('artifacts.app.code.copied')}
							{:else}
								<Copy size={14} strokeWidth={1.75} aria-hidden="true" />
								{$t('artifacts.app.code.copy')}
							{/if}
						</button>
					</div>
					<div class="app-body-code-block">
						{#if highlightedCode}
							{@html highlightedCode}
						{:else}
							<pre><code>{htmlBody}</code></pre>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Redesign §6.2/§6.4: non-blocking — v1 stays visible, dimmed, under
			     this veil while v2 is built; the frame itself is `inert` above so
			     keyboard users cannot type into an app about to be replaced. Never
			     traps focus (no focusTrap here on purpose). -->
			{#if regenerateBusy}
				<div class="app-busy-veil" role="status" aria-live="polite" data-testid="app-busy-veil">
					<div class="app-busy-card">
						<Sparkles size={20} strokeWidth={1.75} class="app-busy-spark" aria-hidden="true" />
						<p>{$t('artifacts.app.regenerate.building')}</p>
						<span class="app-busy-progress" aria-hidden="true"><i></i></span>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

{#if regeneratePopoverOpen}
	{#if isPhone}
		<DialogShell
			title={$t('artifacts.app.regenerate.prompt')}
			phonePresentation="sheet"
			onClose={closeRegeneratePopover}
		>
			{@render regenerateFormContent()}
		</DialogShell>
	{:else}
		<div
			class="app-regen-popover"
			style={regeneratePopoverStyle}
			role="dialog"
			aria-modal="true"
			aria-label={$t('artifacts.app.action.regenerate')}
			data-testid="app-regenerate-popover"
			use:portalToBody
			{@attach regeneratePopoverFocusTrap}
			transition:popoverScale={{ duration: 150, start: 0.98 }}
		>
			<div class="app-regen-pop-head">
				<h4>{$t('artifacts.app.regenerate.prompt')}</h4>
				<button
					type="button"
					class="btn-icon-bare"
					aria-label={$t('artifacts.action.dismiss')}
					onclick={closeRegeneratePopover}
				>
					<X size={16} strokeWidth={2} aria-hidden="true" />
				</button>
			</div>
			<div class="app-regen-pop-body">
				{@render regenerateFormContent()}
			</div>
		</div>
	{/if}
{/if}

<style>
	.app-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		height: 100%;
	}

	.app-body-state {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs, 0.375rem);
		min-height: 420px;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	.app-body-error {
		color: var(--danger);
	}

	.app-body-retry {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		padding: 0.3rem 0.7rem;
		color: var(--text-primary);
		cursor: pointer;
	}

	.app-body-hint {
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	/* ── Status row (redesign §6.2/§6.4) ──────────────────────────── */
	.app-status {
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.app-status-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.app-status-row :global(svg) {
		flex: 0 0 auto;
		color: var(--success);
	}

	.app-status-warning :global(svg) {
		color: var(--warning-text, var(--text-muted));
	}

	.app-status-warning {
		color: var(--text-primary);
	}

	.app-status-muted :global(svg) {
		color: var(--icon-muted);
	}

	.app-status-grow {
		flex: 1;
	}

	.app-status-note-chevron {
		display: inline-flex;
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.app-status-note-chevron-open {
		transform: rotate(180deg);
	}

	.app-status-spinner {
		width: 14px;
		height: 14px;
		flex: 0 0 auto;
		border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: app-status-spin 0.8s linear infinite;
	}

	@keyframes app-status-spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* Height 0↔auto via the CSS grid trick — a plain CSS transition, so the
	   app-wide prefers-reduced-motion override (app.css) already collapses it
	   to instant, exactly like every other §7.2 height animation. */
	.app-note-wrap {
		display: grid;
		grid-template-rows: 0fr;
		transition: grid-template-rows var(--duration-emphasis) var(--ease-emphasis);
	}

	.app-note-open {
		grid-template-rows: 1fr;
	}

	.app-note-inner {
		overflow: hidden;
		min-height: 0;
	}

	.app-note {
		border: 1px solid var(--border-subtle, var(--border-default));
		border-radius: var(--radius-md);
		padding: var(--space-sm);
		margin-top: 0.25rem;
	}

	.app-note-title {
		font-weight: 600;
		font-size: var(--text-xs);
		color: var(--text-primary);
	}

	.app-note-body {
		font-size: var(--text-sm);
		color: var(--text-primary);
	}

	/* ── The segmented Preview/Code control + "Change this app…" ─── */
	.app-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.app-bar-grow {
		flex: 1;
	}

	.app-seg {
		position: relative;
		display: inline-flex;
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		padding: 2px;
	}

	.app-seg-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: calc(50% - 2px);
		height: calc(100% - 4px);
		border-radius: calc(var(--radius-md) - 2px);
		background: var(--surface-page);
		box-shadow: var(--shadow-sm);
		transition: transform var(--duration-standard) var(--ease-emphasis);
	}

	.app-seg-thumb-code {
		transform: translateX(100%);
	}

	.app-seg-tab {
		position: relative;
		z-index: 1;
		display: inline-flex;
		flex: 1 1 0;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		border: none;
		background: transparent;
		padding: 0.35rem 0.7rem;
		color: var(--text-muted);
		font-size: var(--text-sm);
		cursor: pointer;
		white-space: nowrap;
	}

	.app-seg-tab[aria-selected='true'] {
		color: var(--text-primary);
		font-weight: 600;
	}

	.app-seg-tab:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
		border-radius: calc(var(--radius-md) - 2px);
	}

	/* ── The stage: frame/code + the busy veil ───────────────────── */
	.app-stage {
		position: relative;
		flex: 1;
		min-height: 320px;
		display: flex;
		flex-direction: column;
	}

	.app-body-frame-wrap {
		flex: 1;
		min-height: 320px;
		transition: opacity var(--duration-standard) var(--ease-out);
	}

	.app-body-frame-wrap[inert] {
		opacity: 0.55;
	}

	.app-busy-veil {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-md, 1rem);
		pointer-events: none;
	}

	.app-busy-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.375rem;
		max-width: 280px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg, 12px);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-lg);
		padding: var(--space-md, 1rem) var(--space-lg, 1.25rem);
		text-align: center;
		color: var(--text-primary);
		font-size: var(--text-sm);
	}

	.app-busy-card p {
		margin: 0;
	}

	.app-busy-card :global(.app-busy-spark) {
		color: var(--accent-text);
	}

	.app-busy-progress {
		display: block;
		width: 100%;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		overflow: hidden;
	}

	.app-busy-progress i {
		display: block;
		width: 40%;
		height: 100%;
		border-radius: var(--radius-full);
		background: var(--accent);
		animation: app-busy-progress 1.2s ease-in-out infinite;
	}

	@keyframes app-busy-progress {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(250%);
		}
	}

	/* Redesign §7.3: a loop becomes a STATIC state, never an animated sweep
	   at one random frame — app.css's global override already forces one
	   0.01ms iteration (landing on the keyframe's END, fully translated
	   away), so this holds the fill at a plain resting position instead. */
	@media (prefers-reduced-motion: reduce) {
		.app-busy-progress i {
			animation: none;
			transform: none;
		}
	}

	.app-body-code {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs, 0.375rem);
		flex: 1;
		min-height: 0;
	}

	.app-body-code-actions {
		display: flex;
		justify-content: flex-end;
	}

	.app-body-copy {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		padding: 0.2rem 0.5rem;
		color: var(--text-primary);
		font-size: var(--text-xs);
		cursor: pointer;
	}

	.app-body-code-block {
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		overflow: auto;
		font-family: var(--font-mono);
		font-size: var(--text-xs);
	}

	.app-body-code-block :global(pre) {
		margin: 0;
		padding: var(--space-sm);
	}

	.app-body-error-text {
		color: var(--danger);
		font-size: var(--text-xs);
	}

	/* ── The regenerate popover (desktop) ────────────────────────── */
	.app-regen-popover {
		position: fixed;
		z-index: 60;
		width: min(340px, calc(100vw - 24px));
		border-radius: var(--radius-lg, 12px);
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		box-shadow: var(--shadow-lg);
	}

	.app-regen-pop-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.75rem 0.625rem 0.5rem 0.875rem;
	}

	.app-regen-pop-head h4 {
		flex: 1;
		margin: 0;
		font-size: 0.84rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.app-regen-pop-body {
		padding: 0 0.875rem 0.875rem;
	}

	.app-regen-label {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-primary);
		margin-bottom: var(--space-xs, 0.375rem);
	}

	.app-regen-textarea {
		width: 100%;
		min-height: 64px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-primary);
		padding: var(--space-xs, 0.375rem) 0.5rem;
		font-family: var(--font-sans);
		resize: none;
	}

	.app-regen-textarea:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.app-regen-error {
		margin: 0.375rem 0 0;
		color: var(--danger);
		font-size: var(--text-xs);
	}

	.app-regen-footer {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-top: 0.625rem;
	}

	.app-regen-grow {
		flex: 1;
	}

	.app-regen-effect {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		margin-top: 0.625rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border-subtle, var(--border-default));
		color: var(--text-muted);
		font-size: 0.72rem;
		line-height: 1.45;
	}

	.app-regen-effect :global(svg) {
		flex: 0 0 auto;
		margin-top: 0.1rem;
	}

	/* ── Phone: 44px touch targets (redesign §6.4) ───────────────── */
	@media (max-width: 639px) {
		.app-seg-tab,
		.app-bar > .btn-primary {
			min-height: 44px;
		}
	}
</style>
