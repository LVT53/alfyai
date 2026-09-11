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

{#snippet footer()}
	<!-- The chassis's one button rule: negative left, positive right. The
	     middle button is a second positive — it sends too, just not there —
	     so it travels with the positive one rather than beside Cancel. -->
	<button type="button" class="dialog-btn" disabled={busy} onclick={onCancel}>
		{$t('common.cancel')}
	</button>
	<span class="cloud-actions-right">
		<button
			type="button"
			class="dialog-btn keep-local"
			disabled={busy}
			data-testid="cloud-warning-keep-local"
			onclick={() => run(onEnableLocalMode)}
		>
			<ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
			{$t('connections.chat.cloudKeepLocal')}
		</button>
		<button
			type="button"
			class="dialog-btn dialog-btn--positive"
			disabled={busy}
			data-testid="cloud-warning-send"
			onclick={() => run(onContinue)}
		>
			{cloudModelName
				? $t('connections.chat.cloudSend', { cloudModel: cloudModelName })
				: $t('connections.chat.cloudSendGeneric')}
		</button>
	</span>
{/snippet}

<DialogShell
	title={$t('connections.chat.cloudTitle')}
	onClose={onCancel}
	maxWidthClass="max-w-[28rem]"
	phonePresentation="sheet"
	titleVisuallyHidden
	{footer}
>
	<div class="cloud-warning" data-testid="cloud-connector-warning">
		<!-- The approved chassis: an intent mark, the title, and one muted
		     qualifier line. "Asked once per conversation" used to be a footnote
		     under the buttons, where it answered a question you had already
		     stopped asking by the time you got there. -->
		<header class="dialog-head">
			<span class="dialog-head__mark cloud-head-icon" aria-hidden="true">
				<Cloud size={16} strokeWidth={2} />
			</span>
			<span>
				<h3 class="dialog-head__title">{$t('connections.chat.cloudTitle')}</h3>
				<p class="dialog-head__qualifier">{$t('connections.chat.cloudAskedOnce')}</p>
			</span>
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

	</div>
</DialogShell>

<style>
	/* The mark keeps its warning tint on the chassis's neutral tile. */
	.cloud-head-icon {
		color: var(--warning);
		background: color-mix(in srgb, var(--warning) 12%, var(--surface-elevated) 88%);
	}

	.cloud-body {
		margin: 0.25rem 0 0 0;
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

	/* The two positives travel together on the right; only Cancel sits left.
	   On a phone sheet the shell makes every direct footer child an
	   equal-width 44px target, so the pair becomes one of the two halves and
	   splits it between them. */
	.cloud-actions-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	@media (max-width: 639px) {
		.cloud-actions-right {
			flex: 1 1 0;
		}

		.cloud-actions-right :global(.dialog-btn) {
			flex: 1 1 0;
			min-height: 44px;
		}
	}
</style>
