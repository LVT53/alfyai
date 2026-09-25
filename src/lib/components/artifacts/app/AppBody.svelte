<script lang="ts">
// The App's panel body (Feature 2 · Artifacts, Slice 2): Preview (the
// running AppFrame), Code (read-only, Shiki-highlighted), Download and
// Regenerate. This is the whole App surface (Owner decision 8) — no debug
// gallery, no attempt history, no "show the prompt".
//
// `ArtifactBodyProps.body` is always null at this call site
// (`DocumentWorkspace.svelte` never passes a body today), so this component
// fetches its own detail — the same pattern any other kind's body will need
// once it, too, wants more than the id/kind/title the registry hands it.
import {
	AppWindow,
	Check,
	Code as CodeIcon,
	Copy,
	Download,
	Eye,
	RefreshCw,
	TriangleAlert,
} from "@lucide/svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t, type I18nKey } from "$lib/i18n";
import { isDark } from "$lib/stores/theme";
import {
	downloadAppAsHtml,
	fetchArtifact,
	regenerateApp,
	type ArtifactDetailResponse,
} from "$lib/client/api/artifacts";
import type { AppContractRuleId } from "$lib/server/services/artifacts/app/contract";
import type { AppVerificationVerdict } from "$lib/server/services/artifacts/app/verify";
import { renderCodeBlock } from "$lib/services/markdown";
import AppFrame from "./AppFrame.svelte";

interface Props {
	artifactId: string;
	kind: string;
	title: string;
	body: string | null;
}

let { artifactId, title }: Props = $props();

let detail = $state<ArtifactDetailResponse | null>(null);
let loadFailed = $state(false);
let activeTab = $state<"preview" | "code">("preview");
let highlightedCode = $state<string | null>(null);
let copyLabel = $state<"copy" | "copied">("copy");

let downloadBusy = $state(false);
let downloadError = $state<string | null>(null);

let regenerateOpen = $state(false);
let regeneratePromptText = $state("");
let regenerateBusy = $state(false);
let regenerateError = $state<string | null>(null);

async function load(id: string): Promise<void> {
	loadFailed = false;
	try {
		detail = await fetchArtifact(id);
	} catch {
		loadFailed = true;
	}
}

$effect(() => {
	void load(artifactId);
});

let htmlBody = $derived(detail?.artifact.body ?? "");
let versionNumber = $derived(detail?.artifact.versionNumber ?? 0);
let conversationId = $derived(detail?.artifact.conversationId ?? null);
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

const VERIFY_LINE_KEYS: Record<AppVerificationVerdict, I18nKey> = {
	clean: "artifacts.app.verify.clean",
	repaired: "artifacts.app.verify.repaired",
	uncertain: "artifacts.app.verify.uncertain",
	unavailable: "artifacts.app.verify.unavailable",
};

async function ensureCodeHighlighted(): Promise<void> {
	if (!htmlBody) return;
	highlightedCode = renderCodeBlock(htmlBody, "html", $isDark);
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
	if (!conversationId || downloadBusy) return;
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

function openRegenerateDialog(): void {
	regenerateError = null;
	regeneratePromptText = "";
	regenerateOpen = true;
}

async function submitRegenerate(): Promise<void> {
	if (!regeneratePromptText.trim() || regenerateBusy) return;
	regenerateBusy = true;
	regenerateError = null;
	try {
		const result = await regenerateApp(
			artifactId,
			regeneratePromptText.trim(),
			versionNumber,
		);
		if (result.ok) {
			regenerateOpen = false;
			await load(artifactId);
			return;
		}
		regenerateError =
			result.reason === "version_conflict" ? "version_conflict" : result.reason;
	} catch {
		regenerateError = "provider_error";
	} finally {
		regenerateBusy = false;
	}
}

const REGENERATE_FAILURE_KEYS: Record<string, I18nKey> = {
	empty_content: "artifacts.app.failed.emptyContent",
	no_fence: "artifacts.app.failed.noFence",
	tool_call: "artifacts.app.failed.toolCall",
	too_long: "artifacts.app.failed.tooLong",
};
</script>

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
		<div class="app-body-tabs" role="tablist" aria-label={$t('artifacts.app.tabs.a11y')}>
			<button
				type="button"
				role="tab"
				id="app-tab-preview-{artifactId}"
				aria-selected={activeTab === 'preview'}
				aria-controls="app-panel-preview-{artifactId}"
				class="app-body-tab"
				class:app-body-tab-active={activeTab === 'preview'}
				onclick={() => (activeTab = 'preview')}
			>
				<Eye size={16} strokeWidth={1.75} aria-hidden="true" />
				{$t('artifacts.app.tab.preview')}
			</button>
			<button
				type="button"
				role="tab"
				id="app-tab-code-{artifactId}"
				aria-selected={activeTab === 'code'}
				aria-controls="app-panel-code-{artifactId}"
				class="app-body-tab"
				class:app-body-tab-active={activeTab === 'code'}
				onclick={() => (activeTab = 'code')}
			>
				<CodeIcon size={16} strokeWidth={1.75} aria-hidden="true" />
				{$t('artifacts.app.tab.code')}
			</button>
		</div>

		{#if activeTab === 'preview'}
			<div
				id="app-panel-preview-{artifactId}"
				role="tabpanel"
				aria-labelledby="app-tab-preview-{artifactId}"
				class="app-body-preview"
			>
				<div class="app-body-frame-wrap">
					<AppFrame {artifactId} version={versionNumber} {title} {conversationId} />
				</div>
				<div class="app-body-title-row">
					<AppWindow size={14} strokeWidth={1.75} aria-hidden="true" />
					<span>{title}</span>
				</div>

				{#if verification?.checked}
					<div class="app-body-verify-line">
						{$t(VERIFY_LINE_KEYS[verification.verdict])}
					</div>
				{/if}
				{#if (verification?.verdict === 'repaired' || verification?.verdict === 'uncertain') && verificationNote}
					<div class="app-body-note" data-testid="app-verify-note">
						<div class="app-body-note-title">{$t('artifacts.app.verify.noteTitle')}</div>
						<div class="app-body-note-body">{verificationNote.body}</div>
					</div>
				{/if}

				{#each glitchMessageKeys as key (key)}
					<div class="app-body-glitch">
						<TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
						<span>{$t(key)}</span>
					</div>
				{/each}
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

		<div class="app-body-actions">
			<button
				type="button"
				class="app-body-action"
				disabled={!conversationId || downloadBusy}
				title={conversationId ? undefined : $t('artifacts.app.download.unavailable')}
				onclick={handleDownload}
			>
				<Download size={16} strokeWidth={1.75} aria-hidden="true" />
				{$t('artifacts.app.action.download')}
			</button>
			<button type="button" class="app-body-action" onclick={openRegenerateDialog}>
				<RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
				{$t('artifacts.app.action.regenerate')}
			</button>
		</div>
		{#if !conversationId}
			<p class="app-body-hint">{$t('artifacts.app.download.unavailable')}</p>
		{/if}
		{#if downloadError}
			<p class="app-body-hint app-body-error-text">{downloadError}</p>
		{/if}
	{/if}
</div>

{#if regenerateOpen}
	<DialogShell
		title={$t('artifacts.app.action.regenerate')}
		description={$t('artifacts.app.regenerate.confirm')}
		onClose={() => (regenerateOpen = false)}
	>
		<label class="app-body-regenerate-label" for="app-regenerate-input-{artifactId}">
			{$t('artifacts.app.regenerate.prompt')}
		</label>
		<textarea
			id="app-regenerate-input-{artifactId}"
			class="app-body-regenerate-input"
			bind:value={regeneratePromptText}
			disabled={regenerateBusy}
		></textarea>
		{#if regenerateError}
			<p class="app-body-error-text">
				{regenerateError === 'version_conflict'
					? $t('artifacts.error.load')
					: $t(REGENERATE_FAILURE_KEYS[regenerateError] ?? 'artifacts.app.serve.failed')}
			</p>
		{/if}
		<div class="app-body-regenerate-footer">
			<button type="button" onclick={() => (regenerateOpen = false)}>
				{$t('artifacts.action.dismiss')}
			</button>
			<button
				type="button"
				disabled={!regeneratePromptText.trim() || regenerateBusy}
				onclick={submitRegenerate}
			>
				{$t('artifacts.app.action.regenerate')}
			</button>
		</div>
	</DialogShell>
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

	.app-body-tabs {
		display: flex;
		gap: var(--space-xs, 0.375rem);
		border-bottom: 1px solid var(--border-default);
	}

	.app-body-tab {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		border: none;
		background: none;
		padding: 0.4rem 0.6rem;
		color: var(--text-muted);
		font-size: var(--text-sm);
		cursor: pointer;
		border-bottom: 2px solid transparent;
	}

	.app-body-tab-active {
		color: var(--text-primary);
		border-bottom-color: var(--accent);
	}

	.app-body-preview {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs, 0.375rem);
		flex: 1;
		min-height: 0;
	}

	.app-body-frame-wrap {
		flex: 1;
		min-height: 320px;
	}

	.app-body-title-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--text-primary);
		font-size: var(--text-sm);
	}

	.app-body-verify-line {
		color: var(--text-muted);
		font-size: var(--text-xs);
	}

	.app-body-note {
		border: 1px solid var(--border-subtle, var(--border-default));
		border-radius: var(--radius-md);
		padding: var(--space-sm);
	}

	.app-body-note-title {
		font-weight: 600;
		font-size: var(--text-xs);
		color: var(--text-primary);
	}

	.app-body-note-body {
		font-size: var(--text-sm);
		color: var(--text-primary);
	}

	.app-body-glitch {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		color: var(--icon-muted);
		font-size: var(--text-xs);
	}

	.app-body-glitch span {
		color: var(--text-muted);
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

	.app-body-actions {
		display: flex;
		gap: var(--space-xs, 0.375rem);
		flex-wrap: wrap;
	}

	.app-body-action {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-elevated);
		padding: 0.35rem 0.7rem;
		color: var(--text-primary);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.app-body-action:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.app-body-error-text {
		color: var(--danger);
		font-size: var(--text-xs);
	}

	.app-body-regenerate-label {
		display: block;
		font-size: var(--text-sm);
		color: var(--text-primary);
		margin-bottom: var(--space-xs, 0.375rem);
	}

	.app-body-regenerate-input {
		width: 100%;
		min-height: 80px;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
		color: var(--text-primary);
		padding: var(--space-xs, 0.375rem);
		font-family: var(--font-sans);
	}

	.app-body-regenerate-footer {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-xs, 0.375rem);
		margin-top: var(--space-sm);
	}
</style>
