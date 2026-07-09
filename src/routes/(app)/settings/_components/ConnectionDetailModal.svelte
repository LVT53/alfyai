<script lang="ts">
// ADR 0044 Decision 3 (revised by R3-fix #8) — the Connection Detail modal,
// a CENTERED, content-sized overlay (standard DialogShell — no `fullScreen`)
// that holds every per-connection control that used to live inline in the
// always-expanded SettingsConnectionsTab card: capabilities, default-on,
// allow-writes (its reversible/allowlist warning now behind the shared
// InfoTooltip instead of an always-visible amber paragraph), the nextcloud
// write-allowlist editor, and disconnect (a quiet icon action in the header
// row, not a bottom text button — R3-fix #5). The compact list row
// (SettingsConnectionsTab) stays glance-only; this overlay is where the
// rarely-touched controls live. DialogShell already caps height and scrolls
// internally (`max-height: 85dvh; overflow-y: auto`), so a tall connection
// (many capabilities + a long write-allowlist) still fits the viewport.
//
// `connection` is nullable on purpose (mirrors the "open when non-null"
// contract) so the parent can mount this component unconditionally and just
// flip the prop — DialogShell (and its focus trap / body-scroll-lock) is
// only actually mounted while a connection is set, since the whole thing is
// gated behind `{#if connection}` below.
import { Check, Plus, Unplug, X } from "@lucide/svelte";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";
import {
	fetchNextcloudFolders,
	type ConnectionPublic,
	type NextcloudFolderSuggestion,
} from "$lib/client/api/connections";
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

// Redesign R9 — folder suggestions for the write-allowlist editor, fetched
// from the connection's actual Nextcloud folder structure. `ncSuggestionsFailed`
// is the graceful-fallback flag: on a fetch error (offline / needs_reauth /
// anything else) the dropdown simply never opens and the existing manual
// text input keeps working exactly as before — this never blocks adding a
// path. `ncFolderSuggestions` only ever holds top-level (root) folders for
// v1; drilling into subfolders is a nice-to-have left for a later pass.
let ncFolderSuggestions = $state<NextcloudFolderSuggestion[]>([]);
let ncSuggestionsLoading = $state(false);
let ncSuggestionsFailed = $state(false);
let ncSuggestionsOpen = $state(false);
let ncActiveIndex = $state(-1);

// Reset transient UI state whenever the open connection changes (including
// closing back to null) so a stale confirm dialog / draft folder path never
// leaks into the next connection's detail view.
$effect(() => {
	void connection;
	disconnectConfirmOpen = false;
	newAllowlistEntry = "";
	ncFolderSuggestions = [];
	ncSuggestionsLoading = false;
	ncSuggestionsFailed = false;
	ncSuggestionsOpen = false;
	ncActiveIndex = -1;
});

// Fetches the connection's top-level Nextcloud folders as suggestions —
// only for a nextcloud connection with path-based writes and allow-writes
// on (the only case the allowlist editor below is even shown). Re-runs only
// when those tracked reads change, not on every unrelated field update
// (e.g. toggling a capability) that produces a new `connection` object.
$effect(() => {
	const id = connection?.id;
	const provider = connection?.provider;
	const allowWrites = connection?.allowWrites;
	if (!id || provider !== "nextcloud" || !allowWrites) return;
	if (!getProviderCatalogEntry(provider).pathBasedWrites) return;

	let cancelled = false;
	ncSuggestionsLoading = true;
	ncSuggestionsFailed = false;
	fetchNextcloudFolders(id)
		.then((folders) => {
			if (cancelled) return;
			ncFolderSuggestions = folders;
		})
		.catch(() => {
			if (cancelled) return;
			ncSuggestionsFailed = true;
			ncFolderSuggestions = [];
		})
		.finally(() => {
			if (!cancelled) ncSuggestionsLoading = false;
		});
	return () => {
		cancelled = true;
	};
});

const filteredSuggestions = $derived.by(() => {
	const query = newAllowlistEntry.trim().toLowerCase();
	const list = query
		? ncFolderSuggestions.filter(
				(f) =>
					f.path.toLowerCase().includes(query) ||
					f.name.toLowerCase().includes(query),
			)
		: ncFolderSuggestions;
	return list.slice(0, 8);
});

const showSuggestions = $derived(
	ncSuggestionsOpen &&
		!ncSuggestionsFailed &&
		(ncSuggestionsLoading || filteredSuggestions.length > 0),
);

function addAllowlistEntry(conn: ConnectionPublic) {
	const raw = newAllowlistEntry.trim();
	if (!raw) return;
	onUpdateWriteAllowlist(conn.id, [...conn.writeAllowlist, raw]);
	newAllowlistEntry = "";
	ncSuggestionsOpen = false;
	ncActiveIndex = -1;
}

function pickSuggestion(
	conn: ConnectionPublic,
	suggestion: NextcloudFolderSuggestion,
) {
	if (!conn.writeAllowlist.includes(suggestion.path)) {
		onUpdateWriteAllowlist(conn.id, [...conn.writeAllowlist, suggestion.path]);
	}
	newAllowlistEntry = "";
	ncSuggestionsOpen = false;
	ncActiveIndex = -1;
}

function onAllowlistInputKeydown(e: KeyboardEvent, conn: ConnectionPublic) {
	if (showSuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
		const count = filteredSuggestions.length;
		if (count === 0) return;
		e.preventDefault();
		const dir = e.key === "ArrowDown" ? 1 : -1;
		ncActiveIndex = (ncActiveIndex + dir + count) % count;
		return;
	}
	if (e.key === "Enter") {
		e.preventDefault();
		const picked =
			showSuggestions && ncActiveIndex >= 0
				? filteredSuggestions[ncActiveIndex]
				: undefined;
		if (picked) {
			pickSuggestion(conn, picked);
		} else {
			addAllowlistEntry(conn);
		}
		return;
	}
	if (e.key === "Escape" && showSuggestions) {
		ncSuggestionsOpen = false;
	}
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
		zIndexClass="z-[100]"
	>
		<div class="connection-detail" data-testid={`connection-detail-${conn.id}`}>
			<div class="connection-detail-header">
				<BrandIcon provider={conn.provider} size={24} ariaHidden />
				{#if conn.accountIdentifier}
					<span class="connection-detail-account">{conn.accountIdentifier}</span>
				{/if}
				{#if conn.status === 'connected'}
					<span
						class="connection-connected-icon"
						role="img"
						aria-label={$t('connections.status.connected')}
						title={$t('connections.status.connected')}
					>
						<Check size={15} strokeWidth={2.5} aria-hidden="true" />
					</span>
				{:else}
					<span
						class="status-chip"
						class:status-needs_reauth={conn.status === 'needs_reauth'}
						class:status-error={conn.status === 'error'}
						class:status-disconnected={conn.status === 'disconnected'}
					>
						{$t(STATUS_KEY[conn.status] as Parameters<typeof $t>[0])}
					</span>
				{/if}
				<!-- R3-fix #5 — disconnect is a quiet danger icon action pushed to
				     the far right of the header row (logo · account · status ·
				     disconnect), not a prominent bottom text button. Still opens
				     the same ConfirmDialog before calling onDisconnect. -->
				<button
					type="button"
					class="btn-icon-bare btn-icon-sm connection-detail-disconnect"
					aria-label={`${$t('connections.actions.disconnect')} ${entry.displayName}`}
					title={$t('connections.actions.disconnect')}
					onclick={() => (disconnectConfirmOpen = true)}
				>
					<Unplug size={16} strokeWidth={2} aria-hidden="true" />
				</button>
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
					<span class="settings-label connection-toggle-label">{$t('connections.defaultOn.label')}</span>
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
						<span class="settings-label connection-toggle-label">{$t('connections.allowWrites.label')}</span>
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
								<!-- Redesign R9 — a keyboard-navigable combobox: the plain
								     text input still works exactly as before (typing +
								     Enter/Add), and picking a suggestion is equivalent to
								     typing it + Add. Suggestions are best-effort: a fetch
								     failure (offline / needs_reauth) just never opens the
								     dropdown (`showSuggestions` stays false), so manual entry
								     is never blocked. -->
								<div class="connection-allowlist-combobox">
									<input
										type="text"
										class="settings-input"
										placeholder={$t('connections.writeAllowlist.addPlaceholder')}
										aria-label={$t('connections.writeAllowlist.label')}
										role="combobox"
										aria-expanded={showSuggestions}
										aria-controls="nc-folder-suggestions"
										aria-autocomplete="list"
										aria-activedescendant={showSuggestions && ncActiveIndex >= 0
											? `nc-folder-suggestion-${ncActiveIndex}`
											: undefined}
										value={newAllowlistEntry}
										oninput={(e) => {
											newAllowlistEntry = (e.currentTarget as HTMLInputElement).value;
											ncActiveIndex = -1;
											ncSuggestionsOpen = true;
										}}
										onfocus={() => {
											ncSuggestionsOpen = true;
										}}
										onblur={() => {
											// Deferred so a suggestion's onclick (which blurs the
											// input first) still fires before the listbox unmounts.
											setTimeout(() => {
												ncSuggestionsOpen = false;
											}, 150);
										}}
										onkeydown={(e) => onAllowlistInputKeydown(e, conn)}
									/>
									{#if showSuggestions}
										<ul
											class="connection-allowlist-suggestions"
											id="nc-folder-suggestions"
											role="listbox"
											aria-label={$t('connections.writeAllowlist.suggestionsA11y')}
										>
											{#each filteredSuggestions as suggestion, i (suggestion.path)}
												<!-- Per the ARIA combobox/listbox pattern, the option itself
												     is the interactive target (no nested focusable button) —
												     selection happens via a direct click here, or via the
												     input's keyboard nav (aria-activedescendant + Enter)
												     above, which is why this option is deliberately NOT its
												     own keydown/tab target. -->
												<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
												<li
													role="option"
													id={`nc-folder-suggestion-${i}`}
													aria-selected={i === ncActiveIndex}
													class="connection-allowlist-suggestion"
													class:active={i === ncActiveIndex}
													onmousedown={(e) => e.preventDefault()}
													onclick={() => pickSuggestion(conn, suggestion)}
												>
													{suggestion.path}
												</li>
											{/each}
											{#if ncSuggestionsLoading && filteredSuggestions.length === 0}
												<li class="connection-allowlist-suggestions-status">
													{$t('connections.writeAllowlist.suggestionsLoading')}
												</li>
											{/if}
										</ul>
									{/if}
								</div>
								<button
									type="button"
									class="btn-icon-bare connection-allowlist-add-btn"
									aria-label={$t('connections.writeAllowlist.addA11y')}
									title={$t('connections.writeAllowlist.addA11y')}
									onclick={() => addAllowlistEntry(conn)}
								>
									<Plus size={16} strokeWidth={2} aria-hidden="true" />
								</button>
							</div>
						</section>
					{:else}
						<p class="settings-help-text">{$t('connections.writeAllowlist.confirmNote')}</p>
					{/if}
				{/if}
			{/if}
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

	/* R3-fix #6 — `.settings-label` (global) carries a `margin-bottom` meant
	   for when it sits ABOVE an input; that bottom-only margin shifts its
	   flex-centered position up relative to the InfoTooltip icon next to it,
	   which has no margin. Zero it out here so the two line up. */
	.connection-toggle-label {
		margin-bottom: 0;
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

	/* R3-fix #7 — icon-only Plus button, sized to match the input's height. */
	.connection-allowlist-add-btn {
		flex-shrink: 0;
		min-height: 2.25rem;
		min-width: 2.25rem;
	}

	/* Redesign R9 — the combobox wrapper is the positioning context for the
	   suggestions dropdown, which floats below the input rather than pushing
	   the rest of the modal's layout down. */
	.connection-allowlist-combobox {
		position: relative;
		flex: 1;
		min-width: 0;
	}

	.connection-allowlist-suggestions {
		position: absolute;
		top: calc(100% + 0.25rem);
		left: 0;
		right: 0;
		z-index: 1;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		max-height: 12rem;
		overflow-y: auto;
		background: var(--surface-elevated, var(--surface-overlay));
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md, 0.375rem);
		box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.15));
	}

	.connection-allowlist-suggestion {
		display: block;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border: none;
		border-radius: var(--radius-sm, 0.25rem);
		background: transparent;
		color: var(--text-primary);
		font-size: 0.8125rem;
		text-align: left;
		cursor: pointer;
	}

	.connection-allowlist-suggestion:hover,
	.connection-allowlist-suggestion.active {
		background: color-mix(in srgb, var(--surface-overlay) 80%, transparent);
	}

	.connection-allowlist-suggestions-status {
		padding: 0.375rem 0.5rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	/* R3-fix #4 — the "connected" indicator itself (header) is this quiet
	   check icon, not a status-chip pill; the pill below is only used for the
	   problem states (needs_reauth/error/disconnected). */
	.connection-connected-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--success);
	}

	/* R3-fix #5 — a quiet danger icon action, pushed to the far right of the
	   header row (logo · account · status · disconnect). */
	.connection-detail-disconnect {
		margin-left: auto;
		color: var(--danger);
	}

	.connection-detail-disconnect:hover {
		color: var(--danger);
		opacity: 0.78;
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
