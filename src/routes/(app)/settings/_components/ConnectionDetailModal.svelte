<script lang="ts">
// ADR 0044 Decision 3 — the full-screen Connection Detail modal. Holds every
// per-connection control that used to live inline in the always-expanded
// SettingsConnectionsTab card: capabilities, default-on, allow-writes (its
// reversible/allowlist warning now behind the shared InfoTooltip instead of
// an always-visible amber paragraph), the nextcloud write-allowlist editor,
// and disconnect. The compact list row (SettingsConnectionsTab) stays
// glance-only; this overlay is where the rarely-touched controls live.
//
// `connection` is nullable on purpose (mirrors the "open when non-null"
// contract) so the parent can mount this component unconditionally and just
// flip the prop — DialogShell (and its focus trap / body-scroll-lock) is
// only actually mounted while a connection is set, since the whole thing is
// gated behind `{#if connection}` below.
import { Unplug, X } from "@lucide/svelte";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";
import type { ConnectionPublic } from "$lib/client/api/connections";
import { getProviderCatalogEntry } from "$lib/client/connections/provider-catalog";
import { t } from "$lib/i18n";

const STATUS_KEY: Record<ConnectionPublic["status"], string> = {
	connected: "connections.status.connected",
	needs_reauth: "connections.status.needsReauth",
	error: "connections.status.error",
	disconnected: "connections.status.disconnected",
};

let {
	connection,
	onClose,
	onToggleCapability,
	onToggleAllowWrites,
	onToggleDefaultOn,
	onUpdateWriteAllowlist,
	onDisconnect,
}: {
	connection: ConnectionPublic | null;
	onClose: () => void;
	onToggleCapability: (
		id: string,
		capability: string,
		next: boolean,
	) => void | Promise<void>;
	onToggleAllowWrites: (id: string, next: boolean) => void | Promise<void>;
	onToggleDefaultOn: (id: string, next: boolean) => void | Promise<void>;
	onUpdateWriteAllowlist: (id: string, next: string[]) => void | Promise<void>;
	onDisconnect: (id: string) => void | Promise<void>;
} = $props();

let newAllowlistEntry = $state("");
let disconnectConfirmOpen = $state(false);

// Reset transient UI state whenever the open connection changes (including
// closing back to null) so a stale confirm dialog / draft folder path never
// leaks into the next connection's detail view.
$effect(() => {
	void connection;
	disconnectConfirmOpen = false;
	newAllowlistEntry = "";
});

function addAllowlistEntry(conn: ConnectionPublic) {
	const raw = newAllowlistEntry.trim();
	if (!raw) return;
	onUpdateWriteAllowlist(conn.id, [...conn.writeAllowlist, raw]);
	newAllowlistEntry = "";
}

function removeAllowlistEntry(conn: ConnectionPublic, path: string) {
	onUpdateWriteAllowlist(
		conn.id,
		conn.writeAllowlist.filter((entry) => entry !== path),
	);
}
</script>

{#if connection}
	{@const conn = connection}
	{@const entry = getProviderCatalogEntry(conn.provider)}
	{@const needsAttention = conn.status === 'needs_reauth' || conn.status === 'error'}
	<DialogShell
		title={entry.displayName}
		onClose={onClose}
		fullScreen
		zIndexClass="z-[100]"
	>
		<div class="connection-detail" data-testid={`connection-detail-${conn.id}`}>
			<div class="connection-detail-header">
				<BrandIcon provider={conn.provider} size={24} ariaHidden />
				{#if conn.accountIdentifier}
					<span class="connection-detail-account">{conn.accountIdentifier}</span>
				{/if}
				<span
					class="status-chip"
					class:status-connected={conn.status === 'connected'}
					class:status-needs_reauth={conn.status === 'needs_reauth'}
					class:status-error={conn.status === 'error'}
					class:status-disconnected={conn.status === 'disconnected'}
				>
					{$t(STATUS_KEY[conn.status] as Parameters<typeof $t>[0])}
				</span>
			</div>
			{#if needsAttention}
				<p class="connection-detail-status-note">
					{conn.statusDetail ?? $t('connections.status.noDetail')}
				</p>
			{/if}

			{#if entry.capabilities.length > 0}
				<section class="connection-detail-section">
					<p class="settings-label">{$t('connections.capabilities.label')}</p>
					<div class="connection-capabilities">
						{#each entry.capabilities as capability}
							<label class="connection-capability-row">
								<span>{$t(`connections.capability.${capability}` as Parameters<typeof $t>[0])}</span>
								<Toggle
									checked={conn.capabilities.includes(capability)}
									ariaLabel={`${$t(`connections.capability.${capability}` as Parameters<typeof $t>[0])} — ${entry.displayName}`}
									onChange={(next) => onToggleCapability(conn.id, capability, next)}
								/>
							</label>
						{/each}
					</div>
				</section>
			{/if}

			<section class="connection-detail-section connection-toggle-row">
				<div class="connection-toggle-text">
					<span class="settings-label">{$t('connections.defaultOn.label')}</span>
					<InfoTooltip text={$t('connections.defaultOn.help')} />
				</div>
				<Toggle
					checked={conn.defaultOn}
					ariaLabel={`${$t('connections.defaultOn.label')} — ${entry.displayName}`}
					onChange={(next) => onToggleDefaultOn(conn.id, next)}
				/>
			</section>

			{#if entry.writable}
				<section class="connection-detail-section connection-toggle-row">
					<div class="connection-toggle-text">
						<span class="settings-label">{$t('connections.allowWrites.label')}</span>
						<InfoTooltip text={$t('connections.allowWrites.warning')} />
					</div>
					<Toggle
						checked={conn.allowWrites}
						ariaLabel={`${$t('connections.allowWrites.label')} — ${entry.displayName}`}
						onChange={(next) => onToggleAllowWrites(conn.id, next)}
					/>
				</section>

				{#if conn.allowWrites}
					{#if entry.pathBasedWrites}
						<section class="connection-detail-section">
							<p class="settings-label">{$t('connections.writeAllowlist.label')}</p>
							{#if conn.writeAllowlist.length === 0}
								<p class="settings-help-text">{$t('connections.writeAllowlist.empty')}</p>
							{:else}
								<ul class="connection-allowlist-chips">
									{#each conn.writeAllowlist as path}
										<li class="connection-allowlist-chip">
											<span>{path}</span>
											<button
												type="button"
												class="btn-icon-bare connection-allowlist-remove"
												aria-label={$t('connections.writeAllowlist.removeA11y', { path })}
												onclick={() => removeAllowlistEntry(conn, path)}
											>
												<X size={12} strokeWidth={2} aria-hidden="true" />
											</button>
										</li>
									{/each}
								</ul>
							{/if}
							<div class="connection-allowlist-add">
								<input
									type="text"
									class="settings-input"
									placeholder={$t('connections.writeAllowlist.addPlaceholder')}
									aria-label={$t('connections.writeAllowlist.label')}
									value={newAllowlistEntry}
									oninput={(e) => {
										newAllowlistEntry = (e.currentTarget as HTMLInputElement).value;
									}}
									onkeydown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											addAllowlistEntry(conn);
										}
									}}
								/>
								<button
									type="button"
									class="btn-secondary"
									onclick={() => addAllowlistEntry(conn)}
								>
									{$t('connections.writeAllowlist.add')}
								</button>
							</div>
						</section>
					{:else}
						<p class="settings-help-text">{$t('connections.writeAllowlist.confirmNote')}</p>
					{/if}
				{/if}
			{/if}

			<section class="connection-detail-section connection-detail-footer">
				<button
					type="button"
					class="btn-danger"
					aria-label={`${$t('connections.actions.disconnect')} ${entry.displayName}`}
					onclick={() => (disconnectConfirmOpen = true)}
				>
					<Unplug size={16} strokeWidth={2} aria-hidden="true" />
					{$t('connections.actions.disconnect')}
				</button>
			</section>
		</div>
	</DialogShell>

	{#if disconnectConfirmOpen}
		<ConfirmDialog
			title={$t('connections.disconnectConfirm.title', { provider: entry.displayName })}
			message={$t('connections.disconnectConfirm.message', { provider: entry.displayName })}
			confirmText={$t('connections.actions.disconnect')}
			confirmVariant="danger"
			onCancel={() => (disconnectConfirmOpen = false)}
			onConfirm={() => {
				const id = conn.id;
				disconnectConfirmOpen = false;
				void onDisconnect(id);
			}}
		/>
	{/if}
{/if}

<style>
	.connection-detail {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.connection-detail-header {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex-wrap: wrap;
	}

	.connection-detail-account {
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.connection-detail-status-note {
		margin: -0.5rem 0 0 0;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.connection-detail-section {
		border-top: 1px solid var(--border-default);
		padding-top: 0.875rem;
	}

	.connection-capabilities {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.connection-capability-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		font-size: 0.8125rem;
		color: var(--text-primary);
	}

	.connection-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.connection-toggle-text {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.connection-allowlist-chips {
		list-style: none;
		margin: 0.5rem 0 0 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.connection-allowlist-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		border-radius: 9999px;
		background: var(--surface-elevated, var(--surface-overlay));
		border: 1px solid var(--border-default);
		font-size: 0.75rem;
	}

	.connection-allowlist-remove {
		min-height: 1.25rem;
		min-width: 1.25rem;
		height: 1.25rem;
		width: 1.25rem;
	}

	.connection-allowlist-add {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.connection-allowlist-add .settings-input {
		flex: 1;
	}

	.connection-detail-footer {
		display: flex;
		justify-content: flex-end;
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		padding: 0.1875rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 600;
		border: 1px solid transparent;
	}

	.status-chip.status-connected {
		background-color: color-mix(in srgb, var(--success) 14%, transparent);
		color: var(--success);
		border-color: color-mix(in srgb, var(--success) 40%, transparent);
	}

	.status-chip.status-needs_reauth {
		background-color: color-mix(in srgb, var(--warning) 16%, transparent);
		color: var(--warning);
		border-color: color-mix(in srgb, var(--warning) 42%, transparent);
	}

	.status-chip.status-error {
		background-color: color-mix(in srgb, var(--danger) 14%, transparent);
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
	}

	.status-chip.status-disconnected {
		background-color: color-mix(in srgb, var(--text-muted) 16%, transparent);
		color: var(--text-muted);
		border-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
	}
</style>
