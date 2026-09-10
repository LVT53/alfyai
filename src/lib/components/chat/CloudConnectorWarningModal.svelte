<script lang="ts">
// Connections redesign — the one-time "this message would leave your machine"
// warning, shown before a send that would otherwise hand connected-account
// data to a third-party cloud model.
//
// It used to talk about "local mode", which is an internal name for a
// setting, and left the reader to work out who was about to see what. It now
// names both models and says what each one sees, and the middle button does
// the thing it describes: keep it on this machine.
//
// The three choices are unchanged in effect (cancel / keep local and send /
// send to the cloud model) — only what they say and what they show.
import { Cloud, ShieldCheck } from "@lucide/svelte";
import { onMount } from "svelte";
import { fetchAvailableModels } from "$lib/client/api/models";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { t } from "$lib/i18n";

let {
	// The model the user picked. Used only to name it; when it can't be
	// resolved the copy falls back to saying "a cloud model", which is still
	// true and still actionable.
	cloudModelId = null,
	onCancel,
	onContinue,
	onEnableLocalMode,
}: {
	cloudModelId?: string | null;
	onCancel: () => void;
	onContinue: () => void | Promise<void>;
	onEnableLocalMode: () => void | Promise<void>;
} = $props();

let busy = $state(false);
let cloudModelName = $state<string | null>(null);
let cloudVendorName = $state<string | null>(null);
let localModelName = $state<string | null>(null);

// Resolved here rather than threaded down from the page: the page's model
// list carries ids and icons only, and this dialog opens rarely enough that
// one small request beats plumbing display names through the whole chat page.
// Every failure path simply leaves the generic copy in place.
onMount(() => {
	let cancelled = false;
	fetchAvailableModels()
		.then(({ providers }) => {
			if (cancelled) return;
			for (const provider of providers) {
				for (const model of provider.models) {
					if (cloudModelId && model.id === cloudModelId) {
						cloudModelName = model.displayName;
						cloudVendorName = provider.displayName;
					}
					// The on-box models are the ones without a provider-scoped id.
					if (!model.id.startsWith("provider:") && !localModelName) {
						localModelName = model.displayName;
					}
				}
			}
		})
		.catch(() => {
			/* generic copy — see the note above */
		});
	return () => {
		cancelled = true;
	};
});

const description = $derived(
	cloudModelName && cloudVendorName
		? $t("connections.chat.cloudBody", {
				cloudModel: cloudModelName,
				vendor: cloudVendorName,
			})
		: cloudModelName
			? $t("connections.chat.cloudBodyNoVendor", { cloudModel: cloudModelName })
			: $t("connections.cloudWarning.description"),
);

async function run(action: () => void | Promise<void>) {
	if (busy) return;
	busy = true;
	try {
		await action();
	} finally {
		busy = false;
	}
}
</script>

<DialogShell
	title={$t('connections.chat.cloudTitle')}
	onClose={onCancel}
	maxWidthClass="max-w-[28rem]"
	titleVisuallyHidden
>
	<div class="cloud-warning" data-testid="cloud-connector-warning">
		<header class="cloud-head">
			<span class="cloud-head-icon" aria-hidden="true">
				<Cloud size={18} strokeWidth={2} />
			</span>
			<h3 class="cloud-title">{$t('connections.chat.cloudTitle')}</h3>
		</header>

		<p class="cloud-body">{description}</p>

		<!-- Who sees what, side by side — the comparison the old copy left the
		     reader to make for themselves. -->
		<div class="cloud-compare">
			<div class="cloud-row">
				<span class="cloud-row-icon ok" aria-hidden="true">
					<ShieldCheck size={13} strokeWidth={2} />
				</span>
				<span class="cloud-row-name">
					{localModelName
						? $t('connections.chat.cloudLocalRow', { localModel: localModelName })
						: $t('connections.chat.cloudLocalRowGeneric')}
				</span>
				<span class="cloud-row-note">{$t('connections.chat.cloudLocalNote')}</span>
			</div>
			<div class="cloud-row">
				<span class="cloud-row-icon warn" aria-hidden="true">
					<Cloud size={13} strokeWidth={2} />
				</span>
				<span class="cloud-row-name">
					{cloudModelName && cloudVendorName
						? $t('connections.chat.cloudRemoteRow', {
								cloudModel: cloudModelName,
								vendor: cloudVendorName,
							})
						: cloudModelName
							? $t('connections.chat.cloudRemoteRowNoVendor', {
									cloudModel: cloudModelName,
								})
							: $t('connections.chat.cloudRemoteRowNoVendor', {
									cloudModel: $t('connections.cloudWarning.title'),
								})}
				</span>
				<span class="cloud-row-note">{$t('connections.chat.cloudRemoteNote')}</span>
			</div>
		</div>

		<div class="cloud-actions">
			<button
				type="button"
				class="btn-secondary text-xs"
				disabled={busy}
				onclick={onCancel}
			>
				{$t('common.cancel')}
			</button>
			<!-- The middle button does what it says: turns on on-device
			     processing and sends. -->
			<button
				type="button"
				class="btn-secondary keep-local text-xs"
				disabled={busy}
				data-testid="cloud-warning-keep-local"
				onclick={() => run(onEnableLocalMode)}
			>
				<ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
				{$t('connections.chat.cloudKeepLocal')}
			</button>
			<button
				type="button"
				class="btn-primary text-xs"
				disabled={busy}
				data-testid="cloud-warning-send"
				onclick={() => run(onContinue)}
			>
				{cloudModelName
					? $t('connections.chat.cloudSend', { cloudModel: cloudModelName })
					: $t('connections.chat.cloudSendGeneric')}
			</button>
		</div>

		<p class="cloud-footnote">{$t('connections.chat.cloudAskedOnce')}</p>
	</div>
</DialogShell>

<style>
	.cloud-head {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
	}

	.cloud-head-icon {
		display: inline-flex;
		margin-top: 0.0625rem;
		flex-shrink: 0;
		color: var(--warning);
	}

	.cloud-title {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		line-height: 1.35;
	}

	.cloud-body {
		margin: 0.625rem 0 0 0;
		font-size: 0.8125rem;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.cloud-compare {
		margin-top: 0.875rem;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-overlay);
	}

	.cloud-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0;
	}

	.cloud-row-icon {
		display: inline-flex;
		flex-shrink: 0;
	}

	.cloud-row-icon.ok {
		color: var(--success);
	}

	.cloud-row-icon.warn {
		color: var(--warning);
	}

	.cloud-row-name {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.75rem;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cloud-row-note {
		flex-shrink: 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.cloud-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.875rem;
	}

	.keep-local {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.cloud-footnote {
		margin: 0.625rem 0 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
</style>
