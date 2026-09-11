<script lang="ts">
// Connections redesign — the composer's plug, opened.
//
// The plug was one switch: every connection or none. Leaving a single account
// out of one conversation meant disconnecting it, which affected every other
// conversation too. This opens the same list of accounts the settings tab
// shows, so the choice can be per-message without being permanent.
//
// It also finally says what state the accounts are in: how many are ready,
// and which one needs attention, with a way through to fix it.
import { AlertTriangle } from "@lucide/svelte";
import { onMount } from "svelte";
import { fade, fly } from "svelte/transition";
import type { ActiveCapabilitiesConnection } from "$lib/client/api/connections";
import { getProviderCatalogEntry } from "$lib/client/connections/provider-catalog";
import {
	isAccountOn,
	isReady,
	needsAttention,
	readyCount,
} from "$lib/client/connections/composer-selection";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import Toggle from "$lib/components/ui/Toggle.svelte";
import { t } from "$lib/i18n";
import { portalToBody } from "$lib/utils/portal";
import { reducedMotionAware } from "$lib/utils/motion";

let {
	connections,
	flippedIds,
	// Owned by the composer, not derived here: with no per-account list from
	// the server this is the old all-or-nothing switch's state, and the
	// popover must show that rather than computing "nothing is on" from an
	// empty list.
	masterOn,
	onToggleMaster,
	onToggleAccount,
	onManage,
	onClose,
}: {
	connections: ActiveCapabilitiesConnection[];
	// The accounts flipped away from their own "Use it without asking"
	// setting for this conversation — see composer-selection's isAccountOn.
	flippedIds: ReadonlySet<string>;
	masterOn: boolean;
	onToggleMaster: () => void;
	onToggleAccount: (id: string) => void;
	onManage: () => void;
	onClose: () => void;
} = $props();

let root = $state<HTMLDivElement | undefined>(undefined);

// Applied as `transition:` rather than a CSS `animation`, so the popover
// plays on the way OUT as well as in — the composer's command tray next to it
// already animates both ways, and a menu that appears softly and then
// vanishes on a frame reads as a glitch. Wrapped in reducedMotionAware
// because Svelte's css transitions interpolate styles directly and the
// app-wide reduced-motion override cannot reach them.
const popoverFly = reducedMotionAware(fly);
const scrimFade = reducedMotionAware(fade);

// On a phone the panel is a bottom sheet, not a popover: anchored to the
// plug button it ran 96px past the right edge of a 390px screen and its
// switches were unreachable. Read once at mount — the composer re-creates
// the component every time it opens, so a resize between opens is seen.
const isSheet =
	typeof window !== "undefined" &&
	typeof window.matchMedia === "function" &&
	window.matchMedia("(max-width: 640px)").matches;
const flyDistance = isSheet ? 24 : 4;

const counts = $derived(readyCount(connections, flippedIds));
const master = $derived(masterOn);
const attention = $derived(needsAttention(connections));
const ready = $derived(connections.filter(isReady));

function capabilityList(conn: ActiveCapabilitiesConnection): string {
	return conn.capabilities
		.map((capability) =>
			$t(`connections.capability.${capability}` as Parameters<typeof $t>[0]),
		)
		.join(", ");
}

onMount(() => {
	const handlePointerDown = (event: MouseEvent | TouchEvent) => {
		if (root && !root.contains(event.target as Node)) onClose();
	};
	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") onClose();
	};
	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });
	window.addEventListener("keydown", handleKeyDown);
	return () => {
		document.removeEventListener("mousedown", handlePointerDown);
		document.removeEventListener("touchstart", handlePointerDown);
		window.removeEventListener("keydown", handleKeyDown);
	};
});
</script>

{#if isSheet}
	<div
		class="connections-scrim"
		use:portalToBody
		transition:scrimFade={{ duration: 140 }}
		aria-hidden="true"
	></div>
{/if}
<div
	bind:this={root}
	class="connections-popover"
	class:connections-popover--sheet={isSheet}
	use:portalToBody={isSheet}
	transition:popoverFly={{ duration: isSheet ? 200 : 140, y: flyDistance }}
	data-testid="connections-popover"
	role="group"
	aria-label={$t('connections.chat.useMyConnections')}
>
	{#if isSheet}
		<!-- Dismissal #1 of three, and the same grabber every other sheet in
		     the system draws. It was a decorative div: the one affordance a
		     sheet advertises as "drag or tap me to put this away" did nothing
		     at all here, and a screen reader was told to ignore the only
		     labelled way out. -->
		<button
			type="button"
			class="sheet-grip"
			data-testid="connections-popover-grabber"
			aria-label={$t('composerSheet.close')}
			onclick={onClose}
		><span></span></button>
	{/if}
	<div class="master-row">
		<div class="master-text">
			<p class="master-label">{$t('connections.chat.useMyConnections')}</p>
			{#if connections.length > 0}
				<p class="master-sub">
					{$t('connections.chat.accountsReady', {
						ready: counts.on,
						total: counts.total,
					})}
				</p>
			{/if}
		</div>
		<!-- Locked only when the account list is present AND nothing in it can
		     serve anything. An empty list means the server didn't send one, and
		     the master switch is then the all-or-nothing control it always was —
		     locking it there would take away the only choice the user has. -->
		<Toggle
			checked={master}
			disabled={connections.length > 0 && ready.length === 0}
			ariaLabel={$t('connections.chat.useMyConnections')}
			onChange={() => onToggleMaster()}
		/>
	</div>

	{#if ready.length > 0}
		<div class="account-list">
			{#each ready as conn (conn.id)}
				{@const entry = getProviderCatalogEntry(conn.provider)}
				<div class="account-row" data-testid={`connections-popover-account-${conn.id}`}>
					<span class="account-mark">
						<BrandIcon provider={conn.provider} size={13} ariaHidden />
					</span>
					<span class="account-text">
						<span class="account-name">{entry.displayName}</span>
						<span class="account-caps">· {capabilityList(conn)}</span>
					</span>
					<Toggle
						checked={isAccountOn(conn, flippedIds)}
						ariaLabel={entry.displayName}
						onChange={() => onToggleAccount(conn.id)}
					/>
				</div>
			{/each}
		</div>
	{/if}

	{#if attention.length > 0}
		<div class="attention-row">
			<span class="attention-icon" aria-hidden="true">
				<AlertTriangle size={12} strokeWidth={2} />
			</span>
			<span class="attention-text">
				{$t('connections.chat.needsAttention', {
					provider: getProviderCatalogEntry(attention[0].provider).displayName,
				})}
			</span>
			<button type="button" class="attention-manage" onclick={onManage}>
				{$t('connections.actions.manage')}
			</button>
		</div>
	{:else}
		<div class="attention-row">
			<span class="attention-text">
				{connections.length === 0
					? $t('connections.chat.noAccounts')
					: $t('connections.title')}
			</span>
			<button type="button" class="attention-manage" onclick={onManage}>
				{$t('connections.actions.manage')}
			</button>
		</div>
	{/if}
</div>

<style>
	.connections-popover {
		position: absolute;
		left: 0;
		bottom: calc(100% + 8px);
		z-index: 40;
		width: min(19rem, calc(100vw - 2rem));
		padding: 0.75rem 0.875rem;
		border: 1px solid
			color-mix(in srgb, var(--border-default) 76%, var(--surface-page) 24%);
		border-radius: 0.72rem;
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		box-shadow: 0 14px 30px rgba(0, 0, 0, 0.14);
		backdrop-filter: blur(14px);
	}

	:global(.dark) .connections-popover {
		background: color-mix(in srgb, var(--surface-page) 92%, #000 8%);
		box-shadow: 0 16px 32px rgba(0, 0, 0, 0.4);
	}

	/* Phone: a bottom sheet over the page. `position: fixed` alone is not
	   enough — the landing page centres its composer with
	   `translateY(-50%)`, which makes that composer the containing block and
	   left this sheet floating in the middle of the screen. `portalToBody`
	   moves it out to the body, where fixed means the viewport. */
	.connections-scrim {
		position: fixed;
		inset: 0;
		z-index: 59;
		background: var(--scrim);
	}

	.connections-popover--sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		width: auto;
		z-index: 60;
		max-height: min(72vh, 34rem);
		overflow-y: auto;
		padding: 0 1rem calc(1rem + env(safe-area-inset-bottom, 0px));
		border-radius: 1rem 1rem 0 0;
		border-bottom: 0;
		box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.18);
	}

	/* 44px drag strip holding the 36×4 bar. */
	.sheet-grip {
		position: sticky;
		top: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: calc(100% + 2rem);
		height: 44px;
		margin: 0 -1rem 0.25rem;
		border: 0;
		padding: 0;
		background: inherit;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	.sheet-grip span {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--border-default);
		transition: background-color var(--duration-standard) var(--ease-out);
	}

	.sheet-grip:hover span,
	.sheet-grip:focus-visible span {
		background: var(--text-muted);
	}

	.sheet-grip:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--focus-ring);
	}

	@media (prefers-reduced-motion: reduce) {
		.sheet-grip span {
			transition: none;
		}
	}

	.connections-popover--sheet .account-row,
	.connections-popover--sheet .master-row {
		min-height: 44px;
	}

	/* The switch stays 44×24 to the eye; its tap target is the full row
	   height. */
	.connections-popover--sheet :global(.toggle-btn)::before {
		content: "";
		position: absolute;
		inset: -10px -4px;
	}

	.connections-popover--sheet .attention-manage {
		min-height: 44px;
	}

	.master-row {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding-bottom: 0.625rem;
		border-bottom: 1px solid var(--border-subtle);
	}

	.master-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.master-label {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.master-sub {
		margin: 0.125rem 0 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.account-list {
		padding-top: 0.25rem;
	}

	.account-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.4375rem 0;
	}

	.account-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		flex-shrink: 0;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		color: var(--text-secondary);
	}

	.account-text {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.account-name {
		font-size: 0.75rem;
		color: var(--text-primary);
	}

	.account-caps {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.attention-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.375rem;
		padding-top: 0.5rem;
		border-top: 1px solid var(--border-subtle);
	}

	.attention-icon {
		display: inline-flex;
		flex-shrink: 0;
		color: var(--warning);
	}

	.attention-text {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 0.75rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.attention-manage {
		flex-shrink: 0;
		padding: 0.1875rem 0.5rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		font-size: 0.6875rem;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			border-color var(--duration-standard),
			color var(--duration-standard);
	}

	.attention-manage:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.attention-manage:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
