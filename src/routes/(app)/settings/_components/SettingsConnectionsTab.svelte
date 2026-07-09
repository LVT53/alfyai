<script lang="ts">
// Issue 7.1 — Connections settings panel. "Dumb prop component" style
// (mirrors SettingsProfileTab.svelte): all data comes in via props, all
// mutations go out via callback props. State/handlers (optimistic update +
// revert, fetch-on-first-visit) live in +page.svelte.
//
// The CONNECT WIZARDS (the actual forms to add/reconnect a connection) are
// ConnectWizardModal.svelte (Issue 7.3), rendered by +page.svelte — this
// component only raises the intent (onStartConnect/onReconnect) via
// callback props.
import {
	Apple,
	Calendar,
	CirclePlay,
	Cloud,
	Contact,
	Image,
	Mail,
	MapPin,
	X,
} from "@lucide/svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";
import type { ConnectionPublic } from "$lib/client/api/connections";
import {
	CONNECTABLE_PROVIDER_LIST,
	type ConnectionProvider,
	getProviderCatalogEntry,
} from "$lib/client/connections/provider-catalog";
import { t } from "$lib/i18n";

const ICONS: Record<string, typeof Cloud> = {
	Apple,
	Calendar,
	CirclePlay,
	Cloud,
	Contact,
	Image,
	Mail,
	MapPin,
};

function iconFor(name: string) {
	return ICONS[name] ?? Cloud;
}

const STATUS_KEY: Record<ConnectionPublic["status"], string> = {
	connected: "connections.status.connected",
	needs_reauth: "connections.status.needsReauth",
	error: "connections.status.error",
	disconnected: "connections.status.disconnected",
};

let {
	connections,
	loading = false,
	onToggleCapability,
	onToggleAllowWrites,
	onToggleDefaultOn,
	onUpdateWriteAllowlist,
	onDisconnect,
	onStartConnect,
	onReconnect,
}: {
	connections: ConnectionPublic[];
	loading?: boolean;
	onToggleCapability: (
		id: string,
		capability: string,
		next: boolean,
	) => void | Promise<void>;
	onToggleAllowWrites: (id: string, next: boolean) => void | Promise<void>;
	onToggleDefaultOn: (id: string, next: boolean) => void | Promise<void>;
	onUpdateWriteAllowlist: (id: string, next: string[]) => void | Promise<void>;
	onDisconnect: (id: string) => void | Promise<void>;
	onStartConnect: (provider: ConnectionProvider) => void;
	onReconnect: (connectionId: string) => void;
} = $props();

// Per-card "new folder" input text, keyed by connection id.
let newAllowlistEntry = $state<Record<string, string>>({});
let disconnectCandidate = $state<ConnectionPublic | null>(null);

// Drives the "already connected" hint in the persistent "Add a connection"
// section below — multiple accounts per provider are supported, so a
// provider already having a connection doesn't remove it from the list, it
// just gets a hint next to its Connect button.
const connectedProviders = $derived(
	new Set(connections.map((conn) => conn.provider)),
);

function addAllowlistEntry(conn: ConnectionPublic) {
	const raw = (newAllowlistEntry[conn.id] ?? "").trim();
	if (!raw) return;
	onUpdateWriteAllowlist(conn.id, [...conn.writeAllowlist, raw]);
	newAllowlistEntry = { ...newAllowlistEntry, [conn.id]: "" };
}

function removeAllowlistEntry(conn: ConnectionPublic, path: string) {
	onUpdateWriteAllowlist(
		conn.id,
		conn.writeAllowlist.filter((entry) => entry !== path),
	);
}
</script>

<p class="settings-group-label">{$t('connections.title')}</p>
<p class="settings-help-text mb-3">{$t('connections.subtitle')}</p>

{#if loading}
	<section class="settings-card mb-4">
		<p class="text-sm text-text-secondary">{$t('common.loading')}</p>
	</section>
{:else}
	{#if connections.length === 0}
		<section class="settings-card mb-4" data-testid="connections-empty">
			<p class="text-sm text-text-secondary">{$t('connections.empty')}</p>
		</section>
	{/if}
	{#each connections as conn (conn.id)}
		{@const entry = getProviderCatalogEntry(conn.provider)}
		{@const Icon = iconFor(entry.icon)}
		{@const needsAttention = conn.status === 'needs_reauth' || conn.status === 'error'}
		<section class="settings-card mb-4 connection-card" data-testid={`connection-card-${conn.id}`}>
			<div class="connection-header">
				<div class="connection-header-identity">
					<Icon size={22} strokeWidth={2} aria-hidden="true" />
					<div class="connection-header-text">
						<h2 class="settings-section-title">{entry.displayName}</h2>
						{#if conn.accountIdentifier}
							<p class="connection-account">{conn.accountIdentifier}</p>
						{/if}
					</div>
				</div>
				<div class="connection-header-status">
					<span
						class="status-chip"
						class:status-connected={conn.status === 'connected'}
						class:status-needs_reauth={conn.status === 'needs_reauth'}
						class:status-error={conn.status === 'error'}
						class:status-disconnected={conn.status === 'disconnected'}
					>
						{$t(STATUS_KEY[conn.status] as Parameters<typeof $t>[0])}
					</span>
					{#if needsAttention}
						<button
							type="button"
							class="btn-secondary connection-reconnect-btn"
							aria-label={`${$t('connections.actions.reconnect')} ${entry.displayName}`}
							onclick={() => onReconnect(conn.id)}
						>
							{$t('connections.actions.reconnect')}
						</button>
					{/if}
				</div>
			</div>
			{#if needsAttention}
				<p class="connection-status-detail">
					{conn.statusDetail ?? $t('connections.status.noDetail')}
				</p>
			{/if}

			{#if entry.capabilities.length > 0}
				<div class="connection-section">
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
				</div>
			{/if}

			<div class="connection-section connection-toggle-row">
				<div class="connection-toggle-text">
					<span class="settings-label">{$t('connections.defaultOn.label')}</span>
					<InfoTooltip text={$t('connections.defaultOn.help')} />
				</div>
				<Toggle
					checked={conn.defaultOn}
					ariaLabel={`${$t('connections.defaultOn.label')} — ${entry.displayName}`}
					onChange={(next) => onToggleDefaultOn(conn.id, next)}
				/>
			</div>

			{#if entry.writable}
				<div class="connection-section connection-toggle-row">
					<span class="settings-label">{$t('connections.allowWrites.label')}</span>
					<Toggle
						checked={conn.allowWrites}
						ariaLabel={`${$t('connections.allowWrites.label')} — ${entry.displayName}`}
						onChange={(next) => onToggleAllowWrites(conn.id, next)}
					/>
				</div>
				{#if conn.allowWrites}
					<p class="connection-write-warning">{$t('connections.allowWrites.warning')}</p>

					{#if entry.pathBasedWrites}
						<div class="connection-section">
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
									value={newAllowlistEntry[conn.id] ?? ''}
									oninput={(e) => {
										newAllowlistEntry = {
											...newAllowlistEntry,
											[conn.id]: (e.currentTarget as HTMLInputElement).value,
										};
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
						</div>
					{:else}
						<p class="settings-help-text">{$t('connections.writeAllowlist.confirmNote')}</p>
					{/if}
				{/if}
			{/if}

			<div class="connection-section connection-footer">
				<button
					type="button"
					class="btn-danger"
					aria-label={`${$t('connections.actions.disconnect')} ${entry.displayName}`}
					onclick={() => (disconnectCandidate = conn)}
				>
					{$t('connections.actions.disconnect')}
				</button>
			</div>
		</section>
	{/each}

	<section class="settings-card mb-4" data-testid="connections-add">
		<p class="settings-label mb-2">{$t('connections.addConnection.title')}</p>
		<div class="connections-provider-grid">
			{#each CONNECTABLE_PROVIDER_LIST as provider}
				{@const entry = getProviderCatalogEntry(provider)}
				{@const Icon = iconFor(entry.icon)}
				{@const alreadyConnected = connectedProviders.has(provider)}
				<button
					type="button"
					class="pref-pill connections-provider-pill"
					aria-label={`${$t('connections.actions.connect')} ${entry.displayName}`}
					onclick={() => onStartConnect(provider)}
				>
					<Icon size={16} strokeWidth={2} aria-hidden="true" />
					{entry.displayName}
					{#if alreadyConnected}
						<span class="connections-provider-connected-hint">{$t('connections.status.connected')}</span>
					{/if}
				</button>
			{/each}
		</div>
	</section>
{/if}

{#if disconnectCandidate}
	{@const target = disconnectCandidate}
	{@const targetEntry = getProviderCatalogEntry(target.provider)}
	<ConfirmDialog
		title={$t('connections.disconnectConfirm.title', { provider: targetEntry.displayName })}
		message={$t('connections.disconnectConfirm.message', { provider: targetEntry.displayName })}
		confirmText={$t('connections.actions.disconnect')}
		confirmVariant="danger"
		onCancel={() => (disconnectCandidate = null)}
		onConfirm={() => {
			const id = target.id;
			disconnectCandidate = null;
			void onDisconnect(id);
		}}
	/>
{/if}

<style>
	.settings-group-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		margin: 0 0 var(--space-sm) 0;
	}

	.settings-help-text {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.connections-provider-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.connections-provider-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.connections-provider-connected-hint {
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--success);
	}

	.connection-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.connection-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.connection-header-identity {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
	}

	.connection-header-text {
		min-width: 0;
	}

	.connection-account {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.connection-header-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
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

	.connection-reconnect-btn {
		min-height: 2rem;
		padding: 0.25rem 0.75rem;
		font-size: 0.75rem;
	}

	.connection-status-detail {
		margin: -0.375rem 0 0 0;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.connection-section {
		border-top: 1px solid var(--border-default);
		padding-top: 0.75rem;
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

	.connection-write-warning {
		margin: 0;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-md);
		background-color: color-mix(in srgb, var(--warning) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
		color: var(--warning);
		font-size: 0.75rem;
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

	.connection-footer {
		display: flex;
		justify-content: flex-end;
	}
</style>
