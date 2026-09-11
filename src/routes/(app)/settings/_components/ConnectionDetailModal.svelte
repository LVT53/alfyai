<script lang="ts">
// Connections redesign — the per-connection detail dialog.
//
// Same chassis for every provider, five things different from before:
//
// 1. Switches only for what was actually GRANTED. A denied capability is a
//    greyed line with "Ask again", not a switch that turns on with no
//    permission behind it.
// 2. Every switch carries the sentence that used to live in a tooltip, and
//    the labels say what they do: "Use it without asking" rather than
//    "Default on", "Let Alfy write" rather than "Allow writes".
// 3. A broken connection opens with a banner that says what happened, when,
//    and offers the sign-in — instead of a bare status chip and the
//    provider's raw error string as a paragraph.
// 4. Disconnect is a labelled danger button in a footer, not an unlabelled
//    plug glyph in the header, and its confirmation says what is lost (the
//    write folders) and what is not (your files).
// 5. A switch is disabled while its own write is in flight, and a failed one
//    says so instead of silently snapping back.
import { AlertTriangle, Plus, RefreshCw, Unplug, X } from "@lucide/svelte";
import { untrack } from "svelte";
import {
	type ConnectionPublic,
	fetchNextcloudFolders,
	type NextcloudFolderSuggestion,
} from "$lib/client/api/connections";
import { getProviderCatalogEntry } from "$lib/client/connections/provider-catalog";
import {
	connectionStatusGrammar,
	deniedCapabilitiesOf,
	type GrammarFormatters,
	grantedCapabilitiesOf,
	makeGrammarFormatters,
} from "$lib/client/connections/status-grammar";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import ConfirmDialog from "$lib/components/ui/ConfirmDialog.svelte";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import InfoTooltip from "$lib/components/ui/InfoTooltip.svelte";
import { t } from "$lib/i18n";
import BehaviourRow from "./connections/BehaviourRow.svelte";
import CapabilityRow from "./connections/CapabilityRow.svelte";
import ConnectionStatusCell from "./connections/ConnectionStatusCell.svelte";
import Disclosure from "./connections/Disclosure.svelte";
import RecoveryCard from "./connections/RecoveryCard.svelte";

// Default so a caller that only cares about the switches (a test, a future
// embedding) doesn't have to build a formatter set to open the dialog.
const DEFAULT_FORMATTERS = makeGrammarFormatters("en");

let {
	connection,
	formatters = DEFAULT_FORMATTERS,
	changeFailure = null,
	onDismissChangeFailure,
	onClose,
	onToggleCapability,
	onToggleAllowWrites,
	onToggleDefaultOn,
	onUpdateWriteAllowlist,
	onUpdateOwnTracksHome,
	onDisconnect,
	onReconnect,
	onAskAgain,
}: {
	connection: ConnectionPublic | null;
	formatters?: GrammarFormatters;
	// The tab owns "a change didn't save" so the notice survives the dialog
	// being closed; the dialog renders it too, because that is where the user
	// was standing when it failed.
	changeFailure?: {
		changeKey: Parameters<typeof $t>[0];
		changeParams: Record<string, string>;
		retry: () => Promise<void>;
	} | null;
	onDismissChangeFailure?: () => void;
	onClose: () => void;
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
	onReconnect?: (id: string) => void;
	onAskAgain?: (id: string, capability: string) => void;
} = $props();

let newAllowlistEntry = $state("");
let disconnectConfirmOpen = $state(false);

// Which writes are in flight, keyed by what they change. A switch is disabled
// while its own write is running, so rapid toggling can't race two PATCHes
// against each other — the old dialog left every switch live during the
// request (unlike the locality switch, which already did this).
let pending = $state<Set<string>>(new Set());

function isPending(key: string): boolean {
	return pending.has(key);
}

async function withPending(key: string, run: () => void | Promise<void>) {
	if (pending.has(key)) return;
	pending = new Set([...pending, key]);
	try {
		await run();
	} finally {
		const next = new Set(pending);
		next.delete(key);
		pending = next;
	}
}

// Task 10 — OwnTracks home editor. Kept as strings so an in-progress value
// ("-", "47.") isn't coerced to NaN on every keystroke.
let homeLatInput = $state("");
let homeLonInput = $state("");
let homeError = $state<string | null>(null);
let homeSaving = $state(false);

let ncFolderSuggestions = $state<NextcloudFolderSuggestion[]>([]);
let ncSuggestionsLoading = $state(false);
let ncSuggestionsFailed = $state(false);
let ncSuggestionsOpen = $state(false);
let ncActiveIndex = $state(-1);

// Resets the dialog's own view state when a DIFFERENT connection is shown
// (including "none", i.e. the dialog closing).
//
// Keyed on the id, not on the object: the tab hands us a fresh object on
// every local patch (patchConnectionLocal spreads into a new one), so an
// effect that merely read `connection` re-ran on every recheck, every
// capability toggle and every allowlist edit — wiping the folder path the
// user was halfway through typing, dropping the fetched folder suggestions
// the second effect had already loaded (it wouldn't refetch, since its own
// inputs hadn't changed), and clearing `pending` out from under a write that
// was still in flight.
let resetForConnectionId: string | null = null;

$effect(() => {
	const id = connection?.id ?? null;
	if (id === resetForConnectionId) return;
	resetForConnectionId = id;
	untrack(() => {
		disconnectConfirmOpen = false;
		newAllowlistEntry = "";
		ncFolderSuggestions = [];
		ncSuggestionsLoading = false;
		ncSuggestionsFailed = false;
		ncSuggestionsOpen = false;
		ncActiveIndex = -1;
		pending = new Set();
		const lat = connection?.config?.homeLat;
		const lon = connection?.config?.homeLon;
		homeLatInput = typeof lat === "number" ? String(lat) : "";
		homeLonInput = typeof lon === "number" ? String(lon) : "";
		homeError = null;
	});
});

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
	void withPending("folders", () =>
		onUpdateWriteAllowlist(conn.id, [...conn.writeAllowlist, raw]),
	);
	newAllowlistEntry = "";
	ncSuggestionsOpen = false;
	ncActiveIndex = -1;
}

function pickSuggestion(
	conn: ConnectionPublic,
	suggestion: NextcloudFolderSuggestion,
) {
	if (!conn.writeAllowlist.includes(suggestion.path)) {
		void withPending("folders", () =>
			onUpdateWriteAllowlist(conn.id, [
				...conn.writeAllowlist,
				suggestion.path,
			]),
		);
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
	void withPending("folders", () =>
		onUpdateWriteAllowlist(
			conn.id,
			conn.writeAllowlist.filter((entry) => entry !== path),
		),
	);
}

async function saveOwnTracksHome(conn: ConnectionPublic) {
	const latRaw = homeLatInput.trim();
	const lonRaw = homeLonInput.trim();

	if (latRaw === "" && lonRaw === "") {
		homeError = null;
		await persistHome(conn, { homeLat: null, homeLon: null });
		return;
	}

	const lat = Number(latRaw);
	const lon = Number(lonRaw);
	if (latRaw === "" || Number.isNaN(lat) || lat < -90 || lat > 90) {
		homeError = $t("connections.ownTracksHome.invalidLat");
		return;
	}
	if (lonRaw === "" || Number.isNaN(lon) || lon < -180 || lon > 180) {
		homeError = $t("connections.ownTracksHome.invalidLon");
		return;
	}

	homeError = null;
	await persistHome(conn, { homeLat: lat, homeLon: lon });
}

async function persistHome(
	conn: ConnectionPublic,
	next: { homeLat: number | null; homeLon: number | null },
) {
	homeSaving = true;
	try {
		// A rejection here is reported by the tab's "that change didn't save"
		// card, in the same words as every other change on this screen — this
		// used to be a second dialect for failure, a red line under the fields
		// saying something different from the card two inches above it. The
		// INVALID-range messages above stay inline, because those are about
		// what is in the box, not about whether the save reached the server.
		await onUpdateOwnTracksHome(conn.id, next);
	} finally {
		homeSaving = false;
	}
}

async function clearOwnTracksHome(conn: ConnectionPublic) {
	homeLatInput = "";
	homeLonInput = "";
	homeError = null;
	await persistHome(conn, { homeLat: null, homeLon: null });
}

function capabilityLabel(provider: string, capability: string): string {
	// Plex's library is films and shows, not "media".
	if (provider === "plex" && capability === "media") {
		return $t("connections.capability.mediaPlex");
	}
	return $t(`connections.capability.${capability}` as Parameters<typeof $t>[0]);
}

function capabilityAbout(capability: string): string {
	return $t(
		`connections.capabilityAbout.${capability}` as Parameters<typeof $t>[0],
	);
}
</script>

{#if connection}
	{@const conn = connection}
	{@const entry = getProviderCatalogEntry(conn.provider)}
	{@const grammar = connectionStatusGrammar(conn, formatters)}
	{@const granted = grantedCapabilitiesOf(conn)}
	{@const denied = deniedCapabilitiesOf(conn)}
	{@const isOAuth = entry.connectMethod === 'oauth'}
	<DialogShell
		title={entry.displayName}
		onClose={onClose}
		maxWidthClass="max-w-[30rem]"
		zIndexClass="z-[100]"
		titleVisuallyHidden
	>
		<div class="detail" data-testid={`connection-detail-${conn.id}`}>
			<header class="detail-head">
				<span class="detail-mark">
					<BrandIcon provider={conn.provider} size={19} ariaHidden />
				</span>
				<span class="detail-identity">
					<span class="detail-name">{entry.displayName}</span>
					{#if conn.accountIdentifier}
						<span class="detail-account">{conn.accountIdentifier}</span>
					{/if}
				</span>
				<ConnectionStatusCell {grammar} compact />
			</header>

			<!-- A broken connection leads with what happened and the way out,
			     instead of a chip plus the provider's raw error string. -->
			{#if grammar.recovery}
				<div class="state-banner" data-tone={grammar.tone} data-testid="connection-detail-banner">
					<span class="state-banner-icon" aria-hidden="true">
						<AlertTriangle size={14} strokeWidth={2} />
					</span>
					<div class="state-banner-text">
						<p class="state-banner-body">
							{#if conn.status === 'needs_reauth'}
								{conn.statusChangedAt
									? $t('connections.detail.signInBanner', {
											provider: entry.displayName,
											when: formatters.date(conn.statusChangedAt),
										})
									: $t('connections.detail.signInBannerNoDate', {
											provider: entry.displayName,
										})}
							{:else if conn.status === 'error'}
								{conn.statusChangedAt
									? $t('connections.detail.unreachableBanner', {
											provider: entry.displayName,
											when: formatters.dateTime(conn.statusChangedAt),
										})
									: $t('connections.detail.unreachableBannerNoDate', {
											provider: entry.displayName,
										})}
							{:else}
								{$t('connections.detail.turnedOffBanner')}
							{/if}
						</p>
						<div class="state-banner-actions">
							<button
								type="button"
								class="btn-primary text-xs"
								data-testid="connection-detail-recover"
								onclick={() => onReconnect?.(conn.id)}
							>
								{$t(grammar.recovery.label)}
							</button>
						</div>
						<!-- The provider's own words stay reachable, but they are
						     backend phrasing and never the first thing read. -->
						{#if grammar.technicalDetail}
							<Disclosure
								label={$t('connections.actions.whatWentWrong')}
								testId="connection-detail-technical"
							>
								<p class="technical-detail">{grammar.technicalDetail}</p>
							</Disclosure>
						{/if}
					</div>
				</div>
			{/if}

			{#if changeFailure}
				<RecoveryCard
					tone="danger"
					icon={AlertTriangle}
					testId="connection-detail-change-failed"
					title={$t('connections.states.saveFailed.title')}
					body={$t('connections.states.saveFailed.body', {
						change: $t(changeFailure.changeKey, changeFailure.changeParams),
					})}
					primaryLabel={$t('connections.actions.tryAgain')}
					primaryIcon={RefreshCw}
					onPrimary={() => changeFailure?.retry()}
					secondaryLabel={$t('connections.actions.dismiss')}
					onSecondary={() => onDismissChangeFailure?.()}
				/>
			{/if}

			{#if entry.capabilities.length > 0}
				<section class="detail-section">
					<p class="detail-eyebrow">{$t('connections.detail.whatAlfyMayUse')}</p>
					{#each granted as capability (capability)}
						<CapabilityRow
							label={capabilityLabel(conn.provider, capability)}
							description={isOAuth
								? $t('connections.detail.grantedOn', {
										when: formatters.date(conn.createdAt),
									})
								: capabilityAbout(capability)}
							granted
							checked={conn.capabilities.includes(capability)}
							busy={isPending(`capability:${capability}`)}
							testId={`capability-${capability}`}
							onChange={(next) =>
								withPending(`capability:${capability}`, () =>
									onToggleCapability(conn.id, capability, next),
								)}
						/>
					{/each}
					<!-- A denied capability is only ever reachable again by re-running
					     the flow that decided it: the consent screen for an OAuth
					     account, the discovery PROPFIND for a CalDAV one. Both are
					     the reconnect wizard, so both get the button — only the verb
					     differs, because a CalDAV server refused nothing, it just had
					     no address book when we looked. Leaving the non-OAuth case
					     without a button made the line inert: a CalDAV account that
					     grew an address book had no way back to it. -->
					{#each denied as capability (capability)}
						<CapabilityRow
							label={capabilityLabel(conn.provider, capability)}
							description={isOAuth
								? $t('connections.detail.deniedSub')
								: $t('connections.detail.deniedSubDiscovered')}
							granted={false}
							askAgainLabel={isOAuth
								? $t('connections.actions.askAgain')
								: $t('connections.actions.lookAgain')}
							testId={`capability-${capability}`}
							onAskAgain={() => onAskAgain?.(conn.id, capability)}
						/>
					{/each}
					{#if !entry.writable}
						<p class="detail-note">
							{$t('connections.detail.readOnlyNote', { provider: entry.displayName })}
						</p>
					{/if}
				</section>
			{/if}

			<section class="detail-section">
				<p class="detail-eyebrow">{$t('connections.detail.howItBehaves')}</p>
				<BehaviourRow
					label={$t('connections.detail.useWithoutAsking')}
					description={$t('connections.detail.useWithoutAskingSub', {
						provider: entry.displayName,
					})}
					help={$t('connections.detail.useWithoutAskingHelp', {
						provider: entry.displayName,
					})}
					checked={conn.defaultOn}
					busy={isPending('defaultOn')}
					testId="behaviour-default-on"
					onChange={(next) =>
						withPending('defaultOn', () => onToggleDefaultOn(conn.id, next))}
				/>

				{#if entry.writable}
					<BehaviourRow
						label={$t('connections.detail.letAlfyWrite')}
						description={conn.provider === 'google' || conn.provider === 'apple'
							? $t('connections.detail.writeConfirmNoteCalendar')
							: $t('connections.detail.letAlfyWriteSub')}
						help={$t('connections.detail.letAlfyWriteHelp')}
						checked={conn.allowWrites}
						busy={isPending('allowWrites')}
						testId="behaviour-allow-writes"
						onChange={(next) =>
							withPending('allowWrites', () => onToggleAllowWrites(conn.id, next))}
					/>

					{#if conn.allowWrites}
						{#if entry.pathBasedWrites}
							<div class="folder-box">
								<p class="folder-label">{$t('connections.detail.foldersLabel')}</p>
								{#if conn.writeAllowlist.length === 0}
									<p class="folder-empty">{$t('connections.writeAllowlist.empty')}</p>
								{:else}
									<ul class="folder-chips">
										{#each conn.writeAllowlist as path (path)}
											<li class="folder-chip">
												<span>{path}</span>
												<button
													type="button"
													class="folder-chip-remove"
													aria-label={$t('connections.writeAllowlist.removeA11y', { path })}
													onclick={() => removeAllowlistEntry(conn, path)}
												>
													<X size={11} strokeWidth={2.2} aria-hidden="true" />
												</button>
											</li>
										{/each}
									</ul>
								{/if}
								<div class="folder-add">
									<div class="folder-combobox">
										<input
											type="text"
											class="settings-input"
											placeholder={$t('connections.writeAllowlist.addPlaceholder')}
											aria-label={$t('connections.detail.foldersLabel')}
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
												setTimeout(() => {
													ncSuggestionsOpen = false;
												}, 150);
											}}
											onkeydown={(e) => onAllowlistInputKeydown(e, conn)}
										/>
										{#if showSuggestions}
											<ul
												class="folder-suggestions"
												id="nc-folder-suggestions"
												role="listbox"
												aria-label={$t('connections.writeAllowlist.suggestionsA11y')}
											>
												{#each filteredSuggestions as suggestion, i (suggestion.path)}
													<!-- Per the ARIA combobox pattern the option itself is the
													     target; keyboard selection runs through the input's
													     aria-activedescendant, so this is deliberately not its
													     own tab stop. -->
													<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
													<li
														role="option"
														id={`nc-folder-suggestion-${i}`}
														aria-selected={i === ncActiveIndex}
														class="folder-suggestion"
														class:active={i === ncActiveIndex}
														onmousedown={(e) => e.preventDefault()}
														onclick={() => pickSuggestion(conn, suggestion)}
													>
														{suggestion.path}
													</li>
												{/each}
												{#if ncSuggestionsLoading && filteredSuggestions.length === 0}
													<li class="folder-suggestion-status">
														{$t('connections.writeAllowlist.suggestionsLoading')}
													</li>
												{/if}
											</ul>
										{/if}
									</div>
									<!-- R3-fix #9 in reverse: the add action is a LABELLED button
									     now, not a bare plus glyph. -->
									<button
										type="button"
										class="folder-add-btn"
										onclick={() => addAllowlistEntry(conn)}
									>
										<Plus size={12} strokeWidth={2.2} aria-hidden="true" />
										{$t('connections.writeAllowlist.addA11y')}
									</button>
								</div>
							</div>
						{:else}
							<p class="detail-note">{$t('connections.detail.writeConfirmNote')}</p>
						{/if}
					{/if}
				{/if}
			</section>

			{#if conn.provider === 'owntracks'}
				<section class="detail-section">
					<p class="detail-eyebrow">{$t('connections.detail.homeHeading')}</p>
					<p class="home-intro">
						{$t('connections.detail.homeIntro')}
						<InfoTooltip text={$t('connections.ownTracksHome.help')} />
					</p>
					<div class="home-fields">
						<label class="home-field">
							<span class="home-field-label">{$t('connections.ownTracksHome.latLabel')}</span>
							<input
								type="number"
								class="settings-input"
								step="any"
								min="-90"
								max="90"
								value={homeLatInput}
								oninput={(e) => {
									homeLatInput = (e.currentTarget as HTMLInputElement).value;
								}}
							/>
						</label>
						<label class="home-field">
							<span class="home-field-label">{$t('connections.ownTracksHome.lonLabel')}</span>
							<input
								type="number"
								class="settings-input"
								step="any"
								min="-180"
								max="180"
								value={homeLonInput}
								oninput={(e) => {
									homeLonInput = (e.currentTarget as HTMLInputElement).value;
								}}
							/>
						</label>
					</div>
					{#if homeError}
						<p class="home-error">
							<AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
							{homeError}
						</p>
					{/if}
					<div class="home-actions">
						<button
							type="button"
							class="quiet-btn"
							disabled={homeSaving}
							onclick={() => clearOwnTracksHome(conn)}
						>
							{$t('connections.ownTracksHome.clear')}
						</button>
						<button
							type="button"
							class="quiet-btn accent"
							disabled={homeSaving}
							onclick={() => saveOwnTracksHome(conn)}
						>
							{$t('connections.ownTracksHome.saveHome')}
						</button>
					</div>
				</section>
			{/if}

			<footer class="detail-foot">
				<button
					type="button"
					class="danger-btn"
					data-testid="connection-disconnect"
					onclick={() => (disconnectConfirmOpen = true)}
				>
					<Unplug size={14} strokeWidth={2} aria-hidden="true" />
					{$t('connections.actions.disconnectProvider', {
						provider: entry.displayName,
					})}
				</button>
				<!-- Reconnect is reachable from every connection, not only broken
				     ones — a working connection whose permissions need widening had
				     no way here before. -->
				{#if !grammar.recovery}
					<button
						type="button"
						class="quiet-btn"
						data-testid="connection-reconnect"
						onclick={() => onReconnect?.(conn.id)}
					>
						<RefreshCw size={13} strokeWidth={2} aria-hidden="true" />
						{$t('connections.actions.reconnect')}
					</button>
				{/if}
				<span class="detail-foot-spacer"></span>
				<button type="button" class="btn-secondary text-xs" onclick={onClose}>
					{$t('connections.actions.done')}
				</button>
			</footer>
		</div>
	</DialogShell>

	{#if disconnectConfirmOpen}
		{@const lostCapabilities = granted
			.map((capability) => capabilityLabel(conn.provider, capability))
			.join(', ')}
		<ConfirmDialog
			title={$t('connections.disconnectConfirm.title', { provider: entry.displayName })}
			message={`${
				lostCapabilities
					? $t('connections.disconnectConfirm.body', {
							what: lostCapabilities,
							provider: entry.displayName,
						})
					: $t('connections.disconnectConfirm.bodyNoCapabilities', {
							provider: entry.displayName,
						})
			}${
				conn.allowWrites && conn.writeAllowlist.length > 0
					? ` ${
							conn.writeAllowlist.length === 1
								? $t('connections.disconnectConfirm.foldersNoteOne')
								: $t('connections.disconnectConfirm.foldersNoteMany', {
										count: conn.writeAllowlist.length,
									})
						}`
					: ''
			}`}
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
	.detail {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}

	.detail-head {
		display: flex;
		align-items: center;
		gap: 0.6875rem;
	}

	.detail-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.125rem;
		height: 2.125rem;
		flex-shrink: 0;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-overlay);
		color: var(--text-secondary);
	}

	.detail-identity {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-width: 0;
	}

	.detail-name {
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.detail-account {
		margin-top: 0.125rem;
		font-size: 0.75rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.state-banner {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.75rem 0.875rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
	}

	.state-banner[data-tone='warn'] {
		border-color: color-mix(in srgb, var(--warning) 32%, transparent);
		background: color-mix(in srgb, var(--warning) 7%, var(--surface-page));
	}

	.state-banner[data-tone='warn'] .state-banner-icon {
		color: var(--warning);
	}

	.state-banner[data-tone='danger'] {
		border-color: color-mix(in srgb, var(--danger) 32%, transparent);
		background: color-mix(in srgb, var(--danger) 5%, var(--surface-page));
	}

	.state-banner[data-tone='danger'] .state-banner-icon {
		color: var(--danger);
	}

	.state-banner[data-tone='muted'] .state-banner-icon {
		color: var(--text-muted);
	}

	.state-banner-icon {
		display: inline-flex;
		margin-top: 0.125rem;
		flex-shrink: 0;
	}

	.state-banner-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.state-banner-body {
		margin: 0;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.state-banner-actions {
		margin-top: 0.625rem;
	}

	.technical-detail {
		margin: 0;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-sm);
		background: var(--surface-code);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.6875rem;
		line-height: 1.5;
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}

	.detail-section {
		border-top: 1px solid var(--border-default);
		padding-top: 0.875rem;
	}

	.detail-eyebrow {
		margin: 0 0 0.5rem 0;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-muted);
	}

	.detail-note {
		margin: 0.625rem 0 0 0;
		font-size: 0.75rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.folder-box {
		margin-top: 0.625rem;
		padding: 0.75rem 0.8125rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		background: var(--surface-page);
	}

	.folder-label {
		margin: 0 0 0.5rem 0;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.folder-empty {
		margin: 0 0 0.5rem 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.folder-chips {
		list-style: none;
		margin: 0 0 0.5625rem 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.folder-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.1875rem 0.4375rem;
		border-radius: 9999px;
		background: var(--surface-overlay);
		border: 1px solid var(--border-default);
		font-size: 0.6875rem;
		color: var(--text-secondary);
	}

	.folder-chip-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		border: none;
		background: transparent;
		border-radius: 9999px;
		color: var(--text-muted);
		cursor: pointer;
		transition: color var(--duration-standard) var(--ease-out), background var(--duration-standard) var(--ease-out);
	}

	.folder-chip-remove:hover {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}

	.folder-chip-remove:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.folder-add {
		display: flex;
		gap: 0.5rem;
	}

	.folder-combobox {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
	}

	.folder-add-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		flex-shrink: 0;
		padding: 0.375rem 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		font-size: 0.75rem;
		color: var(--text-secondary);
		white-space: nowrap;
		cursor: pointer;
		transition: border-color var(--duration-standard) var(--ease-out), color var(--duration-standard) var(--ease-out);
	}

	.folder-add-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.folder-add-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.folder-suggestions {
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
		background: var(--surface-elevated);
		border: 1px solid var(--border-default);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
	}

	.folder-suggestion {
		display: block;
		width: 100%;
		padding: 0.375rem 0.5rem;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-primary);
		font-size: 0.8125rem;
		text-align: left;
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.folder-suggestion:hover,
	.folder-suggestion:focus-visible,
	.folder-suggestion.active {
		background: var(--surface-overlay);
	}

	.folder-suggestion-status {
		padding: 0.375rem 0.5rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.home-intro {
		margin: 0 0 0.625rem 0;
		font-size: 0.75rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.home-intro :global(.info-tooltip) {
		vertical-align: middle;
	}

	.home-fields {
		display: flex;
		gap: 0.625rem;
	}

	.home-field {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.home-field-label {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.home-error {
		display: flex;
		align-items: center;
		gap: 0.3125rem;
		margin: 0.4375rem 0 0 0;
		font-size: 0.75rem;
		color: var(--danger);
	}

	.home-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.detail-foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		border-top: 1px solid var(--border-default);
		padding-top: 0.875rem;
	}

	.detail-foot-spacer {
		flex: 1 1 auto;
	}

	.danger-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4375rem;
		padding: 0.4375rem 0.75rem;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--danger) 38%, transparent);
		background: color-mix(in srgb, var(--danger) 6%, transparent);
		font-size: 0.8125rem;
		color: var(--danger);
		cursor: pointer;
		transition: background var(--duration-standard) var(--ease-out), border-color var(--duration-standard) var(--ease-out);
	}

	.danger-btn:hover {
		border-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
	}

	.danger-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--danger);
	}

	.quiet-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		padding: 0.375rem 0.625rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-default);
		background: var(--surface-page);
		font-size: 0.75rem;
		color: var(--text-secondary);
		cursor: pointer;
		transition: border-color var(--duration-standard) var(--ease-out), color var(--duration-standard) var(--ease-out);
	}

	.quiet-btn:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--text-primary);
	}

	.quiet-btn.accent {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 45%, transparent);
	}

	.quiet-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.quiet-btn:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
</style>
