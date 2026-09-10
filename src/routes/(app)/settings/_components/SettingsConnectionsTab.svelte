<script lang="ts">
// Connections redesign — the Connections tab.
//
// Three things changed about the shape of this screen:
//
// 1. ONE GRAMMAR. Every row is a coloured dot, a word and a sentence saying
//    what happened and when (see status-grammar.ts). Previously a healthy
//    connection rendered no indicator at all, a broken one rendered an icon
//    explained only by a `title` tooltip, and a disconnected one rendered a
//    text chip — three grammars for a single axis.
// 2. PRIVACY FIRST. The on-device processing switch is the main privacy
//    decision here and used to be the last card on the page.
// 3. EVERY FAILURE HAS A WAY OUT. A failed load, a failed toggle and a
//    partial OAuth grant were all silent; each now names what was and was
//    not changed and offers the one action that fixes it.
//
// The component keeps its "dumb prop component" posture: data in via props,
// mutations out via callbacks, with +page.svelte owning the fetches. What it
// owns locally is view state — which detail dialog is open, and which
// mutation just failed — because neither is data.
import { AlertTriangle, Info, RefreshCw } from "@lucide/svelte";
import type { ConnectionPublic } from "$lib/client/api/connections";
import {
	type Capability,
	type ConnectionProvider,
	getProviderCatalogEntry,
} from "$lib/client/connections/provider-catalog";
import {
	missingFromGrant,
	takeRequestedCapabilities,
} from "$lib/client/connections/oauth-request-memo";
import {
	grantedCapabilitiesOf,
	makeGrammarFormatters,
} from "$lib/client/connections/status-grammar";
import { t } from "$lib/i18n";
import { uiLanguage } from "$lib/stores/settings";
import ConnectionDetailModal from "./ConnectionDetailModal.svelte";
import AddConnectionGrid from "./connections/AddConnectionGrid.svelte";
import ConnectionRow from "./connections/ConnectionRow.svelte";
import PrivacyCard from "./connections/PrivacyCard.svelte";
import RecoveryCard from "./connections/RecoveryCard.svelte";

let {
	connections,
	loading = false,
	// Connections redesign — a failed load is no longer indistinguishable
	// from an empty account (the old code rendered "No connections yet" for
	// both, with a comment saying the user could retry by revisiting).
	loadFailed = false,
	onRetryLoad,
	onToggleCapability,
	onToggleAllowWrites,
	onToggleDefaultOn,
	onUpdateWriteAllowlist,
	onUpdateOwnTracksHome,
	onDisconnect,
	onStartConnect,
	onReconnect,
	// Connections redesign — re-runs the provider's consent flow asking for a
	// capability it previously denied. The only thing that can actually fix a
	// denied capability, and there was no way to trigger it before.
	onAskAgain,
	localDistill = false,
	localityLoading = false,
	onToggleLocalDistill,
}: {
	connections: ConnectionPublic[];
	loading?: boolean;
	loadFailed?: boolean;
	onRetryLoad?: () => void | Promise<void>;
	// Every mutation callback below REJECTS on failure so this component can
	// tell the user. They used to swallow, which is what made a failed toggle
	// snap back in silence.
	onToggleCapability: (
		id: string,
		capability: string,
		next: boolean,
	) => void | Promise<void>;
	onToggleAllowWrites: (id: string, next: boolean) => void | Promise<void>;
	onToggleDefaultOn: (id: string, next: boolean) => void | Promise<void>;
	onUpdateWriteAllowlist: (id: string, next: string[]) => void | Promise<void>;
	onUpdateOwnTracksHome: (
		id: string,
		next: { homeLat: number | null; homeLon: number | null },
	) => void | Promise<void>;
	onDisconnect: (id: string) => void | Promise<void>;
	onStartConnect: (provider: ConnectionProvider) => void;
	onReconnect: (connectionId: string) => void;
	onAskAgain?: (connectionId: string, capability: string) => void;
	localDistill?: boolean;
	localityLoading?: boolean;
	onToggleLocalDistill: (next: boolean) => void | Promise<void>;
} = $props();

let selectedConnectionId = $state<string | null>(null);
const selectedConnection = $derived(
	selectedConnectionId
		? (connections.find((conn) => conn.id === selectedConnectionId) ?? null)
		: null,
);

const connectedProviders = $derived(
	new Set(connections.map((conn) => conn.provider)),
);

// Dates and relative phrases follow the UI language, not the browser's — the
// rest of the sentence they sit inside is translated.
const formatters = $derived(makeGrammarFormatters($uiLanguage));

// ── A change that did not save ───────────────────────────────────
//
// Every mutation goes through `runChange`, which records what was attempted
// and how to attempt it again. The card names the exact change ("Turning off
// Contacts for Nextcloud"), because "something went wrong" leaves the user
// unable to tell which of five switches they need to look at.
type ChangeFailure = {
	changeKey: Parameters<typeof $t>[0];
	changeParams: Record<string, string>;
	retry: () => Promise<void>;
};

let changeFailure = $state<ChangeFailure | null>(null);

async function runChange(
	changeKey: Parameters<typeof $t>[0],
	changeParams: Record<string, string>,
	run: () => void | Promise<void>,
): Promise<void> {
	try {
		await run();
		changeFailure = null;
	} catch {
		changeFailure = {
			changeKey,
			changeParams,
			retry: () => runChange(changeKey, changeParams, run),
		};
	}
}

function providerNameOf(id: string): string {
	const conn = connections.find((item) => item.id === id);
	return conn ? getProviderCatalogEntry(conn.provider).displayName : id;
}

function capabilityName(capability: string): string {
	return $t(`connections.capability.${capability}` as Parameters<typeof $t>[0]);
}

const guardedToggleCapability = (
	id: string,
	capability: string,
	next: boolean,
) =>
	runChange(
		next
			? "connections.states.saveFailed.capabilityOn"
			: "connections.states.saveFailed.capabilityOff",
		{ capability: capabilityName(capability), provider: providerNameOf(id) },
		() => onToggleCapability(id, capability, next),
	);

const guardedToggleDefaultOn = (id: string, next: boolean) =>
	runChange(
		next
			? "connections.states.saveFailed.defaultOnOn"
			: "connections.states.saveFailed.defaultOnOff",
		{ provider: providerNameOf(id) },
		() => onToggleDefaultOn(id, next),
	);

const guardedToggleAllowWrites = (id: string, next: boolean) =>
	runChange(
		next
			? "connections.states.saveFailed.writesOn"
			: "connections.states.saveFailed.writesOff",
		{ provider: providerNameOf(id) },
		() => onToggleAllowWrites(id, next),
	);

const guardedUpdateAllowlist = (id: string, next: string[]) =>
	runChange(
		"connections.states.saveFailed.folders",
		{ provider: providerNameOf(id) },
		() => onUpdateWriteAllowlist(id, next),
	);

const guardedToggleLocalDistill = (next: boolean) =>
	runChange(
		next
			? "connections.states.saveFailed.privacyOn"
			: "connections.states.saveFailed.privacyOff",
		{},
		() => onToggleLocalDistill(next),
	);

const guardedDisconnect = async (id: string) => {
	const provider = providerNameOf(id);
	await runChange(
		"connections.states.saveFailed.disconnect",
		{ provider },
		() => onDisconnect(id),
	);
	// Close the dialog only when the disconnect actually happened — a failed
	// one used to close silently, leaving the row in place with no explanation.
	if (!changeFailure) selectedConnectionId = null;
};

// ── A partial OAuth grant ────────────────────────────────────────
//
// The wizard writes down what it asked for before the browser leaves for the
// consent screen; on return we compare it with what the connection was
// actually granted. Nothing else in the system knows both halves.
type PartialGrant = {
	connectionId: string;
	provider: string;
	allowed: string[];
	missing: string[];
};

let partialGrant = $state<PartialGrant | null>(null);
let partialGrantChecked = $state(false);

$effect(() => {
	if (loading || partialGrantChecked || connections.length === 0) return;
	partialGrantChecked = true;
	for (const conn of connections) {
		const requested = takeRequestedCapabilities(conn.provider);
		if (!requested) continue;
		const granted = grantedCapabilitiesOf(conn);
		const missing = missingFromGrant(requested, granted);
		if (missing.length === 0) continue;
		partialGrant = {
			connectionId: conn.id,
			provider: getProviderCatalogEntry(conn.provider).displayName,
			allowed: granted.filter((capability) => requested.includes(capability)),
			missing,
		};
		break;
	}
});

function nameList(capabilities: string[]): string {
	return capabilities.map(capabilityName).join(", ");
}
</script>

<p class="settings-group-label">{$t('connections.title')}</p>
<p class="settings-help-text mb-3">{$t('connections.subtitle')}</p>

<div class="connections-stack">
	<PrivacyCard
		{localDistill}
		loading={localityLoading}
		onToggle={guardedToggleLocalDistill}
	/>

	{#if changeFailure}
		<RecoveryCard
			tone="danger"
			icon={AlertTriangle}
			testId="connections-change-failed"
			title={$t('connections.states.saveFailed.title')}
			body={$t('connections.states.saveFailed.body', {
				change: $t(changeFailure.changeKey, changeFailure.changeParams),
			})}
			primaryLabel={$t('connections.actions.tryAgain')}
			primaryIcon={RefreshCw}
			onPrimary={() => changeFailure?.retry()}
			secondaryLabel={$t('connections.actions.dismiss')}
			onSecondary={() => (changeFailure = null)}
		/>
	{/if}

	{#if partialGrant}
		{@const missingNames = nameList(partialGrant.missing)}
		<RecoveryCard
			tone="warn"
			icon={Info}
			testId="connections-partial-grant"
			title={partialGrant.allowed.length > 0
				? $t('connections.states.partialGrant.title', {
						allowed: nameList(partialGrant.allowed),
						missing: missingNames,
					})
				: $t('connections.states.partialGrant.titleNoneAllowed', {
						provider: partialGrant.provider,
						missing: missingNames,
					})}
			body={$t('connections.states.partialGrant.body', {
				provider: partialGrant.provider,
				missing: missingNames,
			})}
			primaryLabel={$t('connections.states.partialGrant.ask', {
				missing: missingNames,
			})}
			onPrimary={() => {
				const target = partialGrant;
				partialGrant = null;
				if (target) onAskAgain?.(target.connectionId, target.missing[0]);
			}}
			secondaryLabel={$t('connections.states.partialGrant.keep')}
			onSecondary={() => (partialGrant = null)}
		/>
	{/if}

	{#if loading}
		<section class="settings-card">
			<p class="text-sm text-text-secondary">{$t('common.loading')}</p>
		</section>
	{:else if loadFailed}
		<RecoveryCard
			tone="danger"
			icon={AlertTriangle}
			testId="connections-load-failed"
			title={$t('connections.states.loadFailed.title')}
			body={$t('connections.states.loadFailed.body')}
			primaryLabel={$t('connections.actions.tryAgain')}
			primaryIcon={RefreshCw}
			onPrimary={() => onRetryLoad?.()}
		/>
	{:else if connections.length === 0}
		<section class="settings-card" data-testid="connections-empty">
			<p class="text-sm text-text-secondary">{$t('connections.empty')}</p>
		</section>
	{:else}
		<section class="settings-card list-card" data-testid="connections-list">
			<header class="list-head">
				<h3 class="list-title">{$t('connections.yourConnections')}</h3>
				<span class="list-count">
					{$t('connections.accountCount', { count: connections.length })}
				</span>
			</header>
			<div class="list-body">
				{#each connections as conn (conn.id)}
					<ConnectionRow
						connection={conn}
						{formatters}
						onOpenDetail={(id) => (selectedConnectionId = id)}
						onRecover={onReconnect}
					/>
				{/each}
			</div>
		</section>
	{/if}

	<AddConnectionGrid {connectedProviders} {onStartConnect} />
</div>

<ConnectionDetailModal
	connection={selectedConnection}
	{formatters}
	{changeFailure}
	onDismissChangeFailure={() => (changeFailure = null)}
	onClose={() => (selectedConnectionId = null)}
	onToggleCapability={guardedToggleCapability}
	onToggleAllowWrites={guardedToggleAllowWrites}
	onToggleDefaultOn={guardedToggleDefaultOn}
	onUpdateWriteAllowlist={guardedUpdateAllowlist}
	{onUpdateOwnTracksHome}
	onDisconnect={guardedDisconnect}
	onReconnect={(id) => {
		selectedConnectionId = null;
		onReconnect(id);
	}}
	onAskAgain={(id, capability) => {
		selectedConnectionId = null;
		onAskAgain?.(id, capability);
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

	.connections-stack {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	/* The list card is flush so its rows can carry their own padding and
	   full-bleed separators. */
	.list-card {
		padding: 0;
		overflow: hidden;
	}

	.list-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.875rem 1rem 0.625rem;
	}

	.list-title {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.list-count {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.list-body {
		border-top: 1px solid var(--border-default);
	}
</style>
