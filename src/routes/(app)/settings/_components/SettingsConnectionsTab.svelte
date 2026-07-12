<script lang="ts">
// Issue 7.1, reworked per ADR 0044 Decisions 2 & 3 — Connections settings is
// now a compact glance-able list (brand icon · account · capability
// mini-icons · status chip · quick icon actions) instead of always-expanded
// dense cards. Every rarely-touched control (capabilities, default-on,
// allow-writes, write-allowlist, disconnect) moved out of the row and into
// the full-screen ConnectionDetailModal, opened by clicking a row (or its
// detail icon). "Dumb prop component" style is unchanged (mirrors
// SettingsProfileTab.svelte): all data comes in via props, all mutations go
// out via callback props; state/handlers (optimistic update + revert,
// fetch-on-first-visit) live in +page.svelte. This component now also owns
// one small piece of local UI state — which connection's detail modal is
// open — since that's purely a view concern, not data.
//
// The CONNECT WIZARDS (the actual forms to add/reconnect a connection) are
// ConnectWizardModal.svelte (Issue 7.3), rendered by +page.svelte — this
// component only raises the intent (onStartConnect/onReconnect) via
// callback props.
import {
	AlertCircle,
	AlertTriangle,
	Calendar,
	Check,
	Clapperboard,
	Folder,
	GitBranch,
	Image as ImageIcon,
	ListTodo,
	Mail,
	MapPin,
	RefreshCw,
	Settings2,
	Users,
} from "@lucide/svelte";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";
import type { ConnectionPublic } from "$lib/client/api/connections";
import {
	type Capability,
	type ConnectionProvider,
	getProviderCatalogEntry,
	groupConnectableProviders,
} from "$lib/client/connections/provider-catalog";
import { t } from "$lib/i18n";
import ConnectionDetailModal from "./ConnectionDetailModal.svelte";

// Small Lucide glyph per capability, shown as a glance-only mini-icon row on
// each compact list row (distinct from BrandIcon, which identifies the
// provider). Deliberately a fixed local map, not provider-catalog data — the
// catalog's `icon` field is one icon per PROVIDER, this is one icon per
// CAPABILITY.
const CAPABILITY_ICONS: Record<Capability, typeof Calendar> = {
	calendar: Calendar,
	files: Folder,
	photos: ImageIcon,
	email: Mail,
	media: Clapperboard,
	location: MapPin,
	contacts: Users,
	repos: GitBranch,
	tasks: ListTodo,
};

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
	onUpdateOwnTracksHome,
	onDisconnect,
	onStartConnect,
	onReconnect,
	localDistill = false,
	localityLoading = false,
	onToggleLocalDistill,
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
	// Task 10 — see ConnectionDetailModal.svelte's onUpdateOwnTracksHome doc.
	onUpdateOwnTracksHome: (
		id: string,
		next: { homeLat: number | null; homeLon: number | null },
	) => void | Promise<void>;
	onDisconnect: (id: string) => void | Promise<void>;
	onStartConnect: (provider: ConnectionProvider) => void;
	onReconnect: (connectionId: string) => void;
	// Issue 7.4 — Option A: per-user "keep connector data on this device"
	// toggle. Independent of the connections list load/loading state above.
	localDistill?: boolean;
	localityLoading?: boolean;
	onToggleLocalDistill: (next: boolean) => void | Promise<void>;
} = $props();

// Which connection's full-screen detail modal is open, if any. Kept as an id
// (not the object itself) so the modal always reflects the LIVE connection
// from the `connections` prop — including optimistic updates/revert applied
// by the parent — rather than a stale snapshot taken at open time.
let selectedConnectionId = $state<string | null>(null);
const selectedConnection = $derived(
	selectedConnectionId
		? (connections.find((conn) => conn.id === selectedConnectionId) ?? null)
		: null,
);

// Drives the "already connected" hint in the persistent "Add a connection"
// section below — multiple accounts per provider are supported, so a
// provider already having a connection doesn't remove it from the list, it
// just gets a hint next to its Connect button.
const connectedProviders = $derived(
	new Set(connections.map((conn) => conn.provider)),
);

// ADR-0051 Decision 2 (slice E1) — the "Add a connection" list separates
// branded products from generic custom integrations with a labeled divider.
// Ordering within each group is preserved from the catalog (see
// groupConnectableProviders).
const providerGroups = $derived(groupConnectableProviders());

function capabilitiesA11yLabel(conn: ConnectionPublic): string {
	const names = conn.capabilities.map((capability) =>
		$t(`connections.capability.${capability}` as Parameters<typeof $t>[0]),
	);
	return $t("connections.row.capabilitiesA11y", { list: names.join(", ") });
}
</script>

<!-- R3-fix2 #3 — "Connected" as a quiet check icon is now ONLY used in the
     "Add a connection" strip's already-connected hint below, to show which
     providers the user already has linked. R3-fix2 #2 removed it from the
     compact list ROW entirely: connected is the implied normal state there,
     so a healthy row shows no status indicator at all — only needs_reauth
     and error do (see the row markup below). It keeps an accessible label
     so it's never color/icon-only. -->
{#snippet connectedIcon()}
	<span
		class="connection-connected-icon"
		role="img"
		aria-label={$t('connections.status.connected')}
		title={$t('connections.status.connected')}
	>
		<Check size={14} strokeWidth={2.5} aria-hidden="true" />
	</span>
{/snippet}

<!-- One brand-icon connect button in the "Add a connection" list. Shared by
     the products and custom-integrations groups so the two only differ by
     which providers they iterate. -->
{#snippet providerPill(provider: ConnectionProvider)}
	{@const entry = getProviderCatalogEntry(provider)}
	{@const alreadyConnected = connectedProviders.has(provider)}
	<button
		type="button"
		class="pref-pill connections-provider-pill"
		aria-label={`${$t('connections.actions.connect')} ${entry.displayName}`}
		onclick={() => onStartConnect(provider)}
	>
		<BrandIcon provider={provider} size={16} ariaHidden />
		{entry.displayName}
		{#if alreadyConnected}
			{@render connectedIcon()}
		{/if}
	</button>
{/snippet}

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
	{:else}
		<section class="settings-card mb-4 connections-list" data-testid="connections-list">
			{#each connections as conn (conn.id)}
				{@const entry = getProviderCatalogEntry(conn.provider)}
				{@const needsAttention = conn.status === 'needs_reauth' || conn.status === 'error'}
				<div class="connection-row" data-testid={`connection-row-${conn.id}`}>
					<button
						type="button"
						class="connection-row-main"
						aria-label={`${$t('connections.actions.viewDetails')} ${entry.displayName}`}
						onclick={() => (selectedConnectionId = conn.id)}
					>
						<BrandIcon provider={conn.provider} size={22} ariaHidden />
						<span class="connection-row-identity">
							<span class="connection-row-name">{entry.displayName}</span>
							{#if conn.accountIdentifier}
								<span class="connection-row-account">{conn.accountIdentifier}</span>
							{/if}
						</span>
						{#if conn.capabilities.length > 0}
							<span
								class="connection-row-capabilities"
								role="img"
								aria-label={capabilitiesA11yLabel(conn)}
							>
								{#each conn.capabilities as capability}
									{@const CapIcon = CAPABILITY_ICONS[capability as Capability]}
									{#if CapIcon}
										<CapIcon size={14} strokeWidth={2} aria-hidden="true" />
									{/if}
								{/each}
							</span>
						{/if}
						{#if conn.status === 'needs_reauth'}
							<!-- R3-fix2 #2 — problem states get a small status icon
							     (aria-label + tooltip), not a text pill; healthy/
							     connected rows show nothing here at all. -->
							<span
								class="status-icon status-icon-warning"
								role="img"
								aria-label={$t('connections.status.needsReauth')}
								title={$t('connections.status.needsReauth')}
							>
								<AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />
							</span>
						{:else if conn.status === 'error'}
							<span
								class="status-icon status-icon-error"
								role="img"
								aria-label={$t('connections.status.error')}
								title={conn.statusDetail ?? $t('connections.status.noDetail')}
							>
								<AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
							</span>
						{:else if conn.status === 'disconnected'}
							<span class="status-chip status-disconnected">
								{$t(STATUS_KEY.disconnected as Parameters<typeof $t>[0])}
							</span>
						{/if}
					</button>
					<div class="connection-row-actions">
						{#if needsAttention}
							<button
								type="button"
								class="btn-icon-bare btn-icon-sm"
								aria-label={`${$t('connections.actions.reconnect')} ${entry.displayName}`}
								title={$t('connections.actions.reconnect')}
								onclick={() => onReconnect(conn.id)}
							>
								<RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
							</button>
						{/if}
						<button
							type="button"
							class="btn-icon-bare btn-icon-sm"
							aria-label={`${$t('connections.actions.viewDetails')} ${entry.displayName}`}
							title={$t('connections.actions.viewDetails')}
							onclick={() => (selectedConnectionId = conn.id)}
						>
							<Settings2 size={16} strokeWidth={2} aria-hidden="true" />
						</button>
					</div>
				</div>
			{/each}
		</section>
	{/if}

	<!-- R3-fix #3 — Google is a plain BrandIcon brand button here, same shape
	     as every other provider (no more branded GoogleSignInButton in the
	     add strip). The connect action is unchanged: it still calls
	     onStartConnect('google'), which opens the OAuth wizard. -->
	<section class="settings-card mb-4" data-testid="connections-add">
		<p class="settings-label mb-2">{$t('connections.addConnection.title')}</p>
		<!-- ADR-0051 Decision 2 (E1) — branded products and generic custom
		     integrations are shown as two labeled groups split by a divider so a
		     concrete product reads distinctly from a protocol adapter. -->
		<p class="connections-group-heading">{$t('connections.addConnection.groupProducts')}</p>
		<div class="connections-provider-grid" data-testid="connections-add-products">
			{#each providerGroups.product as provider (provider)}
				{@render providerPill(provider)}
			{/each}
		</div>
		{#if providerGroups.custom.length > 0}
			<hr class="connections-group-divider" data-testid="connections-add-divider" />
			<p class="connections-group-heading">{$t('connections.addConnection.groupCustom')}</p>
			<div class="connections-provider-grid" data-testid="connections-add-custom">
				{#each providerGroups.custom as provider (provider)}
					{@render providerPill(provider)}
				{/each}
			</div>
		{/if}
	</section>

	<p class="settings-group-label">{$t('connections.locality.title')}</p>
	<section class="settings-card mb-4" data-testid="connections-locality">
		<div class="connection-toggle-row">
			<div class="connection-toggle-text">
				<span class="settings-label connection-toggle-label">{$t('connections.locality.toggleLabel')}</span>
				<InfoTooltip text={$t('connections.locality.help')} />
			</div>
			<Toggle
				checked={localDistill}
				disabled={localityLoading}
				ariaLabel={$t('connections.locality.toggleLabel')}
				onChange={(next) => onToggleLocalDistill(next)}
			/>
		</div>
		<p class="settings-help-text mt-2">{$t('connections.locality.fidelityNote')}</p>
	</section>
{/if}

<ConnectionDetailModal
	connection={selectedConnection}
	onClose={() => (selectedConnectionId = null)}
	{onToggleCapability}
	{onToggleAllowWrites}
	{onToggleDefaultOn}
	{onUpdateWriteAllowlist}
	{onUpdateOwnTracksHome}
	onDisconnect={async (id) => {
		await onDisconnect(id);
		selectedConnectionId = null;
	}}
/>

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

	.connections-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.connection-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.connection-row:not(:last-child) {
		border-bottom: 1px solid var(--border-default);
		padding-bottom: 0.5rem;
	}

	.connection-row-main {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		flex: 1;
		min-width: 0;
		padding: 0.375rem 0.25rem;
		background: transparent;
		border: none;
		border-radius: var(--radius-md, 0.375rem);
		text-align: left;
		cursor: pointer;
		color: inherit;
		font: inherit;
	}

	.connection-row-main:hover {
		background: color-mix(in srgb, var(--surface-overlay) 60%, transparent);
	}

	.connection-row-main:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	/* Name and account sit on ONE line with a tight, fixed gap — the old
	   card reused `.settings-section-title` (a SECTION heading with a large
	   margin-bottom meant to separate a heading from the content below it)
	   for the connection name directly above the account line, which left a
	   visible empty-looking gap between them. The row uses its own compact
	   name/account styles instead, both with zero vertical margin. */
	.connection-row-identity {
		display: flex;
		align-items: baseline;
		gap: 0.375rem;
		min-width: 0;
		flex-shrink: 1;
	}

	.connection-row-name {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.connection-row-account {
		font-size: 0.75rem;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.connection-row-capabilities {
		display: flex;
		align-items: center;
		gap: 0.3125rem;
		color: var(--icon-muted);
		flex-shrink: 0;
	}

	.connection-row-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
		flex-shrink: 0;
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		padding: 0.1875rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 600;
		border: 1px solid transparent;
	}

	/* R3-fix2 #3 — the "connected" indicator itself is now this quiet check
	   icon ONLY in the add-strip's already-connected hint (see below); the
	   row no longer renders it at all (R3-fix2 #2). */
	.connection-connected-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--success);
	}

	/* R3-fix2 #2 — the row's problem-state indicator: a small icon (not a
	   text pill) with an accessible label and a title tooltip, shown ONLY
	   for needs_reauth/error. A healthy/connected row renders neither this
	   nor the status-chip below — no status indicator at all. */
	.status-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.status-icon-warning {
		color: var(--warning);
	}

	.status-icon-error {
		color: var(--danger);
	}

	.status-chip.status-disconnected {
		background-color: color-mix(in srgb, var(--text-muted) 16%, transparent);
		color: var(--text-muted);
		border-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
	}

	.connections-provider-grid {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	/* ADR-0051 Decision 2 (E1) — group heading + divider for the two
	   "Add a connection" groups (products vs custom integrations). The heading
	   reuses the quiet uppercase-caption language of .settings-group-label. */
	.connections-group-heading {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
		margin: 0 0 var(--space-sm) 0;
	}

	.connections-group-divider {
		border: none;
		border-top: 1px solid var(--border-default);
		margin: 1rem 0 0.75rem;
	}

	.connections-provider-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
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

	/* R3-fix #6 — `.settings-label` (global) carries a `margin-bottom` meant
	   for when it sits ABOVE an input; that bottom-only margin shifts its
	   flex-centered position up relative to the InfoTooltip icon next to it,
	   which has no margin. Zero it out here so the two line up. */
	.connection-toggle-label {
		margin-bottom: 0;
	}
</style>
