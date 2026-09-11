<script lang="ts">
// Everyday redesign — the "+" menu.
//
// The old menu was four rows: model, style, Atlas, web search, attach. Every
// other thing the composer could do was a lit icon on the bar, and the bar
// had five of them plus a bare "0". The redesign moves the rarely-reached
// controls in here (the board's Direction A menu) and leaves three on the bar
// (Direction B), so one menu now holds everything the composer can do, in the
// order it is reached for:
//
//   THIS MESSAGE   Attach file · Skills · Atlas report
//   (switches)     Web search · Thinking · Incognito
//   ACCOUNTS       Use my connections · each account · Manage connections
//   (conversation) Model · Style
//
// Two behaviours the old menu did not have, and the board asks for by name:
// a switch row flips IN PLACE and the menu stays open (turning Thinking on
// and picking an account is one visit, not three), and the whole thing is a
// real menu for the keyboard — arrow keys walk it, Escape closes it, and
// focus returns to the plus that opened it.
//
// On a phone it becomes a bottom sheet. An anchored popover pinned to a 19px
// icon at the bottom of a 390px screen sits under the thumb that opened it,
// and its 30px rows are half the size of everything else on that screen.
import { onMount, tick } from "svelte";
import {
	Brain,
	ChevronRight,
	Globe,
	Orbit,
	Paperclip,
	Plug,
	Sparkles,
	Type,
	VenetianMask,
} from "@lucide/svelte";
import ModelSelector from "./ModelSelector.svelte";
import {
	buildComposerMenuRows,
	type ComposerMenuRow,
	isSectionStart,
	nextMenuIndex,
} from "./composer-bar";
import type { ActiveCapabilitiesConnection } from "$lib/client/api/connections";
import {
	isAccountOn,
	isReady,
	readyCount,
} from "$lib/client/connections/composer-selection";
import { getProviderCatalogEntry } from "$lib/client/connections/provider-catalog";
import BrandIcon from "$lib/components/ui/BrandIcon.svelte";
import { t, type I18nKey } from "$lib/i18n";
import {
	getPersonalityProfileDisplayDescription,
	getPersonalityProfileDisplayName,
} from "$lib/utils/personality-profile-labels";
import { reducedMotionAware } from "$lib/utils/motion";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import { portalToBody } from "$lib/utils/portal";
import { fade, fly } from "svelte/transition";
import type { ModelId } from "$lib/model-types";
import type {
	AtlasAvailability,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";

let {
	canAttach = false,
	attachmentsEnabled = false,
	maxUploadMb = 100,
	onClose,
	onAttach,
	personalityProfiles = [],
	selectedPersonalityId = null,
	onPersonalityChange = undefined,
	onModelChange = undefined,
	initialOpen = null,
	forceWebSearch = false,
	onForceWebSearchChange = undefined,
	atlasAvailability = null,
	atlasProfile = null,
	onAtlasProfileChange = undefined,
	// Moved in from the bar (Direction B keeps three icons out there;
	// everything else lives here).
	thinkingAvailable = false,
	thinkingOn = false,
	onToggleThinking = undefined,
	incognitoOn = false,
	incognitoBusy = false,
	onToggleIncognito = undefined,
	// The same per-account selection the bar's accounts popover edits — one
	// state, two ways in, so turning an account off here and reading the count
	// on the bar agree.
	connections = [],
	flippedIds = new Set<string>(),
	connectionsMasterOn = false,
	onToggleConnectionsMaster = undefined,
	onToggleConnectionAccount = undefined,
	onManageConnections = undefined,
	// Skills used to be reachable only by typing "$". The row says how many
	// are active so the menu is also where you find out that you have any.
	skillCount = null,
	pendingSkillName = null,
	onOpenSkills = undefined,
}: {
	canAttach?: boolean;
	attachmentsEnabled?: boolean;
	maxUploadMb?: number;
	onClose?: () => void;
	onAttach?: () => void;
	personalityProfiles?: Array<{
		id: string;
		name: string;
		description: string;
	}>;
	selectedPersonalityId?: string | null;
	onPersonalityChange?: ((id: string | null) => void) | undefined;
	onModelChange?: ((modelId: ModelId) => void) | undefined;
	initialOpen?: "model" | "style" | null;
	forceWebSearch?: boolean;
	onForceWebSearchChange?: ((enabled: boolean) => void) | undefined;
	atlasAvailability?: AtlasAvailability | null;
	atlasProfile?: AtlasProfile | null;
	onAtlasProfileChange?: ((profile: AtlasProfile) => void) | undefined;
	thinkingAvailable?: boolean;
	thinkingOn?: boolean;
	onToggleThinking?: (() => void) | undefined;
	incognitoOn?: boolean;
	incognitoBusy?: boolean;
	onToggleIncognito?: (() => void) | undefined;
	connections?: ActiveCapabilitiesConnection[];
	flippedIds?: ReadonlySet<string>;
	connectionsMasterOn?: boolean;
	onToggleConnectionsMaster?: (() => void) | undefined;
	onToggleConnectionAccount?: ((id: string) => void) | undefined;
	onManageConnections?: (() => void) | undefined;
	skillCount?: number | null;
	pendingSkillName?: string | null;
	onOpenSkills?: (() => void) | undefined;
} = $props();

let root = $state<HTMLDivElement | undefined>(undefined);
let activeDropdown = $state<"model" | "style" | "atlas" | null>(null);
let appliedInitialOpen = $state<"model" | "style" | null>(null);
let focusedIndex = $state(-1);
let isPhone = $state(isPhoneViewport());
let stopWatchingViewport: (() => void) | null = null;
const rowElements = new Map<string, HTMLButtonElement>();

// Both ways, not just in: a menu that appears softly and then vanishes on a
// frame reads as a glitch. Wrapped so it is instant under reduced motion,
// which the CSS override alone cannot reach for a Svelte transition.
const menuFly = reducedMotionAware(fly);
const scrimFade = reducedMotionAware(fade);

let styleOpen = $derived(activeDropdown === "style");
let atlasOpen = $derived(activeDropdown === "atlas");
let atlasAvailable = $derived(
	Boolean(atlasAvailability?.enabled && atlasAvailability.configured),
);
let atlasUnavailableReason = $derived(
	atlasAvailability?.reasonCode === "disabled"
		? $t("composerTools.atlasUnavailableDisabled")
		: atlasAvailability?.reasonCode === "missing_parallel"
			? $t("composerTools.atlasUnavailableParallel")
			: $t("composerTools.atlasUnavailableReason"),
);

let selectedProfile = $derived(
	personalityProfiles.find((p) => p.id === selectedPersonalityId) ?? null,
);
let readyAccounts = $derived(connections.filter(isReady));
let accountCounts = $derived(readyCount(connections, flippedIds));
let hasConnections = $derived(connections.length > 0);

let rows = $derived(
	buildComposerMenuRows({
		canAttach,
		skillsEnabled: true,
		atlasVisible: Boolean(atlasAvailability),
		atlasAvailable,
		thinkingAvailable,
		hasConnections,
		readyAccountIds: readyAccounts.map((conn) => conn.id),
		personalityCount: personalityProfiles.length,
	}),
);

const ATLAS_PROFILE_OPTIONS = [
	"overview",
	"in-depth",
	"exhaustive",
] as const satisfies readonly AtlasProfile[];

$effect(() => {
	if (initialOpen === appliedInitialOpen) return;
	activeDropdown = initialOpen;
	appliedInitialOpen = initialOpen;
});

function closeMenu() {
	activeDropdown = null;
	onClose?.();
}

function selectModel(payload: { modelId: ModelId }) {
	onModelChange?.(payload.modelId);
	closeMenu();
}

function handleAttach() {
	onAttach?.();
	onClose?.();
}

// The board's rule for the switch rows: they flip in place and the menu stays
// open, so turning Thinking on and then picking an account is one visit.
function toggleWebSearch() {
	onForceWebSearchChange?.(!forceWebSearch);
}

function atlasProfileLabel(profile: AtlasProfile): string {
	if (profile === "exhaustive") return $t("composerTools.atlasExhaustive");
	if (profile === "in-depth") return $t("composerTools.atlasInDepth");
	return $t("composerTools.atlasOverview");
}

function atlasProfileDescriptionKey(profile: AtlasProfile): I18nKey {
	if (profile === "exhaustive")
		return "composerTools.atlasExhaustiveDescription";
	if (profile === "in-depth") return "composerTools.atlasInDepthDescription";
	return "composerTools.atlasOverviewDescription";
}

function atlasProfileTimeKey(profile: AtlasProfile): I18nKey {
	if (profile === "exhaustive") return "composerTools.atlasExhaustiveTime";
	if (profile === "in-depth") return "composerTools.atlasInDepthTime";
	return "composerTools.atlasOverviewTime";
}

function selectAtlasProfile(profile: AtlasProfile) {
	onAtlasProfileChange?.(profile);
	closeMenu();
}

// Parts of this menu that are moved to <body> on a phone so their
// `position: fixed` means the viewport (see utils/portal). Once moved they
// are no longer inside `root`, so the outside-click handler would read a tap
// on an Atlas profile card or a model row as "somewhere else" and close the
// menu out from under it — before the click that would have chosen anything
// ever landed. The model guide's backdrop is here for the same reason: it is
// rendered at the top level by ModelSelector.
const OWN_OVERLAY_SELECTOR = [
	".model-guide-backdrop",
	".atlas-profile-picker",
	".model-selector__dropdown",
	".model-selector__scrim",
].join(",");

function isOwnOverlayTarget(target: EventTarget | null): boolean {
	const element =
		target instanceof Element
			? target
			: target instanceof Node
				? target.parentElement
				: null;
	return Boolean(element?.closest(OWN_OVERLAY_SELECTOR));
}

function registerRow(node: HTMLButtonElement, id: string) {
	rowElements.set(id, node);
	return {
		destroy() {
			if (rowElements.get(id) === node) rowElements.delete(id);
		},
	};
}

// Model and Style keep their own triggers (a dropdown each), so they hand
// their button in rather than being wrapped by the action. Without this the
// arrow keys would walk a list two rows shorter than the one on screen.
function bindRowElement(id: string, element: HTMLButtonElement | null) {
	if (element) rowElements.set(id, element);
	else rowElements.delete(id);
}

async function focusRow(index: number) {
	focusedIndex = index;
	await tick();
	rowElements.get(rows[index]?.id ?? "")?.focus();
}

// Roving focus: the menu owns the arrow keys, Home/End and Escape; anything
// else (Tab, typing) is left alone so the browser's own behaviour survives.
function handleMenuKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		// A sub-picker eats the first Escape, so the menu does not vanish out
		// from under a list you were only backing out of.
		if (activeDropdown) {
			event.preventDefault();
			event.stopPropagation();
			activeDropdown = null;
			void focusRow(focusedIndex >= 0 ? focusedIndex : 0);
			return;
		}
		return; // the composer's own handler closes and returns focus
	}
	if (activeDropdown) return;
	const next = nextMenuIndex(rows, focusedIndex, event.key);
	if (next === null) return;
	event.preventDefault();
	void focusRow(next);
}

function rowIndex(id: string): number {
	return rows.findIndex((row) => row.id === id);
}

function accountFor(row: ComposerMenuRow) {
	return readyAccounts.find((conn) => conn.id === row.accountId);
}

onMount(() => {
	stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});

	const handlePointerDown = (event: MouseEvent | TouchEvent) => {
		if (isOwnOverlayTarget(event.target)) return;
		if (root && !root.contains(event.target as Node)) {
			activeDropdown = null;
			onClose?.();
		}
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape" && !activeDropdown) {
			onClose?.();
		}
	};

	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });
	window.addEventListener("keydown", handleKeyDown);

	// Opened from the keyboard or the pointer, the first row takes focus so
	// the arrow keys have somewhere to start.
	void focusRow(0);

	return () => {
		stopWatchingViewport?.();
		document.removeEventListener("mousedown", handlePointerDown);
		document.removeEventListener("touchstart", handlePointerDown);
		window.removeEventListener("keydown", handleKeyDown);
	};
});
</script>

{#snippet switchFace(on: boolean)}
	<!-- The same 44x24 face as ui/Toggle, drawn as a span: the row itself is
	     the menuitemcheckbox, and a button inside a button is invalid. -->
	<span class="switch-face" class:switch-face--on={on} aria-hidden="true">
		<span class="switch-face__thumb"></span>
	</span>
{/snippet}

{#snippet sectionHeading(row: ComposerMenuRow)}
	<div class="menu-section" role="presentation">
		{#if row.section === 'message'}
			{$t('composerMenu.sectionMessage')}
		{:else if row.section === 'switches'}
			{$t('composerMenu.sectionSwitches')}
		{:else if row.section === 'accounts'}
			{hasConnections
				? $t('composerMenu.sectionAccounts', {
						on: accountCounts.on,
						total: accountCounts.total,
					})
				: $t('composerMenu.sectionAccountsEmpty')}
		{:else}
			{$t('composerMenu.sectionConversation')}
		{/if}
	</div>
{/snippet}

{#if isPhone}
	<!-- "The thing they were anchored to stays visible above the scrim" —
	     the board's rule for every sheet. It also gives the sheet the same
	     way out as the rest of the system: tap the page. -->
	<button
		type="button"
		class="tools-menu__scrim"
		data-testid="composer-tools-menu-scrim"
		aria-label={$t('composerSheet.close')}
		use:portalToBody
		transition:scrimFade={{ duration: 200 }}
		onclick={closeMenu}
	></button>
{/if}

<div
	bind:this={root}
	class="tools-menu"
	class:tools-menu--sheet={isPhone}
	data-testid="composer-tools-menu"
	role="menu"
	tabindex="-1"
	aria-label={$t('composerMenu.label')}
	use:portalToBody={isPhone}
	onkeydown={handleMenuKeydown}
	transition:menuFly={isPhone
		? { duration: 250, y: 260, opacity: 1 }
		: { duration: 140, y: 6 }}
>
	{#if isPhone}
		<button
			type="button"
			class="tools-menu__grabber"
			data-testid="composer-tools-menu-grabber"
			aria-label={$t('composerSheet.close')}
			onclick={closeMenu}
		><span class="tools-menu__grabber-bar"></span></button>
	{/if}

	<div class="tools-menu__rows">
	{#each rows as row, index (row.id)}
		{#if isSectionStart(rows, index)}
			{@render sectionHeading(row)}
		{/if}

		{#if row.id === 'attach'}
			<button
				type="button"
				class="menu-row"
				role="menuitem"
				tabindex={focusedIndex === index ? 0 : -1}
				use:registerRow={row.id}
				data-testid="composer-menu-attach"
				disabled={!canAttach}
				title={attachmentsEnabled ? $t('composerTools.attachFileMaxSize', { max: maxUploadMb }) : $t('composerTools.uploadsUnavailable')}
				onfocus={() => (focusedIndex = index)}
				onclick={handleAttach}
			>
				<span class="menu-row__icon" aria-hidden="true"><Paperclip size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerTools.attachFile')}</span>
				<span class="menu-row__value">{$t('composerMenu.attachHint', { max: maxUploadMb })}</span>
			</button>

		{:else if row.id === 'skills'}
			<button
				type="button"
				class="menu-row"
				role="menuitem"
				aria-haspopup="dialog"
				tabindex={focusedIndex === index ? 0 : -1}
				use:registerRow={row.id}
				data-testid="composer-menu-skills"
				onfocus={() => (focusedIndex = index)}
				onclick={() => { onOpenSkills?.(); }}
			>
				<span class="menu-row__icon" aria-hidden="true"><Sparkles size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerMenu.skills')}</span>
				<span class="menu-row__value">
					{pendingSkillName
						?? (skillCount === null
							? ''
							: skillCount === 0
								? $t('composerMenu.skillsNone')
								: $t('composerMenu.skillsActive', { count: skillCount }))}
				</span>
				<span class="menu-row__chevron" aria-hidden="true"><ChevronRight size={15} strokeWidth={2} /></span>
			</button>

		{:else if row.id === 'atlas'}
			<div class="menu-row-wrap">
				<button
					type="button"
					class="menu-row"
					class:menu-row--selected={Boolean(atlasProfile)}
					role="menuitem"
					aria-haspopup="listbox"
					aria-expanded={atlasOpen}
					aria-label={atlasAvailable
						? $t('composerMenu.atlasReport')
						: $t('composerTools.atlasUnavailable')}
					aria-describedby={row.disabled ? 'atlas-unavailable-reason' : undefined}
					tabindex={focusedIndex === index ? 0 : -1}
					use:registerRow={row.id}
					data-testid="composer-menu-atlas"
					disabled={row.disabled}
					title={atlasAvailable ? $t('composerTools.atlasDescription') : atlasUnavailableReason}
					onfocus={() => (focusedIndex = index)}
					onclick={() => { activeDropdown = atlasOpen ? null : 'atlas'; }}
				>
					<span class="menu-row__icon" aria-hidden="true"><Orbit size={16} strokeWidth={2} /></span>
					<span class="menu-row__label">{$t('composerMenu.atlasReport')}</span>
					<span class="menu-row__value">
						{atlasProfile ? atlasProfileLabel(atlasProfile) : $t('composerMenu.atlasOff')}
					</span>
					<span class="menu-row__chevron" aria-hidden="true"><ChevronRight size={15} strokeWidth={2} /></span>
				</button>
				{#if atlasOpen}
					<section
						class="atlas-profile-picker"
						class:atlas-profile-picker--sheet={isPhone}
						use:portalToBody={isPhone}
						transition:menuFly={isPhone ? { duration: 250, y: 220, opacity: 1 } : { duration: 150, y: 4 }}
						aria-label={$t('composerTools.atlasProfileTitle')}
					>
						{#if isPhone}
							<button
								type="button"
								class="tools-menu__grabber"
								aria-label={$t('composerSheet.close')}
								onclick={() => { activeDropdown = null; }}
							><span class="tools-menu__grabber-bar"></span></button>
						{/if}
						<h3 class="atlas-profile-picker__title">{$t('composerTools.atlasProfileTitle')}</h3>
						<p class="atlas-profile-picker__subtitle">{$t('composerTools.atlasProfileSubtitle')}</p>
						<ul class="atlas-profile-options" role="listbox" aria-label={$t('composerTools.atlasProfile')}>
							{#each ATLAS_PROFILE_OPTIONS as profile}
								<li
									role="option"
									aria-selected={atlasProfile === profile}
									class="atlas-profile-card"
									class:atlas-profile-card--selected={atlasProfile === profile}
									onclick={() => selectAtlasProfile(profile)}
									onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && selectAtlasProfile(profile)}
									tabindex="0"
									aria-labelledby={`atlas-profile-${profile}-name`}
									aria-describedby={`atlas-profile-${profile}-time atlas-profile-${profile}-desc`}
								>
									<span class="atlas-profile-radio" aria-hidden="true"></span>
									<span class="atlas-profile-info">
										<span class="atlas-profile-row">
											<span class="atlas-profile-name" id={`atlas-profile-${profile}-name`}>{atlasProfileLabel(profile)}</span>
											<span class="atlas-profile-time" id={`atlas-profile-${profile}-time`}>{$t(atlasProfileTimeKey(profile))}</span>
										</span>
										<span class="atlas-profile-desc" id={`atlas-profile-${profile}-desc`}>{$t(atlasProfileDescriptionKey(profile))}</span>
									</span>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
				{#if row.disabled}
					<p id="atlas-unavailable-reason" class="menu-row__hint">{atlasUnavailableReason}</p>
				{/if}
			</div>

		{:else if row.id === 'web-search'}
			<button
				type="button"
				class="menu-row"
				role="menuitemcheckbox"
				aria-checked={forceWebSearch}
				tabindex={focusedIndex === index ? 0 : -1}
				use:registerRow={row.id}
				data-testid="composer-menu-web-search"
				onfocus={() => (focusedIndex = index)}
				onclick={toggleWebSearch}
			>
				<span class="menu-row__icon" aria-hidden="true"><Globe size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerTools.webSearch')}</span>
				{@render switchFace(forceWebSearch)}
			</button>

		{:else if row.id === 'thinking'}
			<button
				type="button"
				class="menu-row"
				role="menuitemcheckbox"
				aria-checked={thinkingOn}
				tabindex={focusedIndex === index ? 0 : -1}
				use:registerRow={row.id}
				data-testid="thinking-toggle"
				onfocus={() => (focusedIndex = index)}
				onclick={() => onToggleThinking?.()}
			>
				<span class="menu-row__icon" aria-hidden="true"><Brain size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerMenu.thinking')}</span>
				{@render switchFace(thinkingOn)}
			</button>

		{:else if row.id === 'incognito'}
			<button
				type="button"
				class="menu-row"
				role="menuitemcheckbox"
				aria-checked={incognitoOn}
				aria-label={$t('chat.incognitoToggle')}
				tabindex={focusedIndex === index ? 0 : -1}
				use:registerRow={row.id}
				data-testid="incognito-toggle"
				disabled={incognitoBusy}
				onfocus={() => (focusedIndex = index)}
				onclick={() => onToggleIncognito?.()}
			>
				<span class="menu-row__icon" aria-hidden="true"><VenetianMask size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerMenu.incognito')}</span>
				{@render switchFace(incognitoOn)}
			</button>

		{:else if row.id === 'accounts-master'}
			<button
				type="button"
				class="menu-row"
				role="menuitemcheckbox"
				aria-checked={connectionsMasterOn}
				aria-label={$t('connections.chat.useMyConnections')}
				tabindex={focusedIndex === index ? 0 : -1}
				use:registerRow={row.id}
				data-testid="composer-menu-connections-master"
				disabled={readyAccounts.length === 0}
				onfocus={() => (focusedIndex = index)}
				onclick={() => onToggleConnectionsMaster?.()}
			>
				<span class="menu-row__icon" aria-hidden="true"><Plug size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('connections.chat.useMyConnections')}</span>
				{@render switchFace(connectionsMasterOn)}
			</button>

		{:else if row.accountId}
			{@const conn = accountFor(row)}
			{#if conn}
				{@const entry = getProviderCatalogEntry(conn.provider)}
				<button
					type="button"
					class="menu-row menu-row--account"
					role="menuitemcheckbox"
					aria-checked={isAccountOn(conn, flippedIds)}
					aria-label={entry.displayName}
					tabindex={focusedIndex === index ? 0 : -1}
					use:registerRow={row.id}
					data-testid={`composer-menu-account-${conn.id}`}
					onfocus={() => (focusedIndex = index)}
					onclick={() => onToggleConnectionAccount?.(conn.id)}
				>
					<span class="menu-row__icon" aria-hidden="true">
						<BrandIcon provider={conn.provider} size={14} ariaHidden />
					</span>
					<span class="menu-row__label">{entry.displayName}</span>
					{@render switchFace(isAccountOn(conn, flippedIds))}
				</button>
			{/if}

		{:else if row.id === 'manage-connections'}
			<button
				type="button"
				class="menu-row menu-row--link"
				role="menuitem"
				tabindex={focusedIndex === index ? 0 : -1}
				use:registerRow={row.id}
				data-testid="composer-menu-manage-connections"
				onfocus={() => (focusedIndex = index)}
				onclick={() => { onManageConnections?.(); }}
			>
				<span class="menu-row__label">{$t('composerMenu.manageConnections')}</span>
			</button>

		{:else if row.id === 'model'}
			<div class="menu-row-wrap menu-row-wrap--static">
				<span class="menu-row__icon menu-row__icon--static" aria-hidden="true"><Orbit size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerTools.model')}</span>
				<ModelSelector
					open={activeDropdown === 'model'}
					onOpenChange={(open) => activeDropdown = open ? 'model' : null}
					onSelect={selectModel}
					onTriggerRef={(element) => bindRowElement('model', element)}
					ownsScrim={!isPhone}
				/>
			</div>

		{:else if row.id === 'style'}
			<div class="menu-row-wrap menu-row-wrap--static">
				<span class="menu-row__icon menu-row__icon--static" aria-hidden="true"><Type size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerTools.style')}</span>
				<div class="model-selector">
					<button
						type="button"
						class="model-selector__trigger"
						data-testid="composer-menu-style"
						use:registerRow={'style'}
						onclick={() => activeDropdown = styleOpen ? null : 'style'}
						aria-haspopup="listbox"
						aria-expanded={styleOpen}
					>
						<span class="model-selector__text">
							{selectedProfile
								? getPersonalityProfileDisplayName(selectedProfile, $t)
								: $t('composerTools.defaultStyle')}
						</span>
						<span class="model-selector__chevron" aria-hidden="true">
							<ChevronRight size={15} strokeWidth={2} />
						</span>
					</button>
					{#if styleOpen}
						<ul class="model-selector__dropdown" role="listbox">
							<li
								role="option"
								aria-selected={!selectedPersonalityId}
								class="model-selector__option"
								class:model-selector__option--selected={!selectedPersonalityId}
								onclick={() => { onPersonalityChange?.(null); closeMenu(); }}
								onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (onPersonalityChange?.(null), closeMenu())}
								tabindex="0"
							>{$t('composerTools.defaultStyle')}</li>
							{#each personalityProfiles as profile}
								<li
									role="option"
									aria-selected={selectedPersonalityId === profile.id}
									class="model-selector__option"
									class:model-selector__option--selected={selectedPersonalityId === profile.id}
									title={getPersonalityProfileDisplayDescription(profile, $t)}
									onclick={() => { onPersonalityChange?.(profile.id); closeMenu(); }}
									onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (onPersonalityChange?.(profile.id), closeMenu())}
									tabindex="0"
								>{getPersonalityProfileDisplayName(profile, $t)}</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>
		{/if}
	{/each}
	</div>
</div>

<style>
	.tools-menu {
		position: absolute;
		left: 0;
		bottom: calc(100% + 8px);
		z-index: 40;
		width: min(17.5rem, calc(100vw - 2rem));
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, var(--surface-page) 24%);
		border-radius: 0.72rem;
		background: color-mix(in srgb, var(--surface-overlay) 88%, var(--surface-page) 12%);
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
		padding: 0.32rem;
		backdrop-filter: blur(14px);
	}

	.tools-menu:focus-visible {
		outline: none;
	}

	/* On a phone the menu is a sheet: the rows are 44px, they start at the
	   bottom edge where the thumb is, and the grabber is the same one every
	   other sheet in the system has. */
	.tools-menu--sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		width: auto;
		max-height: min(80dvh, 40rem);
		overflow-y: auto;
		overscroll-behavior: contain;
		border-radius: 16px 16px 0 0;
		border-bottom: 0;
		padding: 0 0.5rem calc(0.5rem + env(safe-area-inset-bottom));
		z-index: 60;
	}

	/* Sits under the sheet (z 60) and the Atlas sub-sheet (z 70) but over the
	   composer, so the message you were writing is still legible behind it. */
	.tools-menu__scrim {
		position: fixed;
		inset: 0;
		z-index: 59;
		border: 0;
		padding: 0;
		background: var(--scrim);
		cursor: default;
	}

	.tools-menu__grabber {
		display: grid;
		place-items: center;
		width: 100%;
		height: 44px;
		border: 0;
		background: transparent;
		cursor: pointer;
	}

	.tools-menu__grabber-bar {
		width: 36px;
		height: 4px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-muted) 42%, transparent 58%);
	}

	.tools-menu__grabber:hover .tools-menu__grabber-bar,
	.tools-menu__grabber:focus-visible .tools-menu__grabber-bar {
		background: color-mix(in srgb, var(--text-muted) 78%, transparent 22%);
	}

	:global(.dark) .tools-menu {
		background: color-mix(in srgb, var(--surface-page) 90%, #000 10%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
		box-shadow:
			0 16px 32px rgba(0, 0, 0, 0.4),
			0 0 0 1px color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	/* A section says what the rows under it are about — and the accounts one
	   also says how many are on, so the count is readable without counting
	   the switches. */
	.menu-section {
		padding: 0.5rem 0.5rem 0.22rem;
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		font-weight: 700;
		letter-spacing: 0.08em;
		line-height: 1.2;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.menu-section:first-child {
		padding-top: 0.28rem;
	}

	.menu-row,
	.menu-row-wrap--static {
		display: grid;
		grid-template-columns: 1.15rem minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 2.2rem;
		border: 0;
		border-radius: 0.5rem;
		background: transparent;
		padding: 0.34rem 0.5rem;
		text-align: left;
		color: var(--text-primary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.menu-row-wrap--static {
		cursor: default;
	}

	.tools-menu--sheet .menu-row,
	.tools-menu--sheet .menu-row-wrap--static {
		min-height: 44px;
	}

	.menu-row:hover:not(:disabled),
	.menu-row:focus-visible {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		outline: none;
	}

	.menu-row:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 40%, transparent 60%);
	}

	.menu-row--selected {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.menu-row:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.menu-row-wrap {
		position: relative;
	}

	.menu-row__icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
	}

	.menu-row:hover:not(:disabled) .menu-row__icon,
	.menu-row:focus-visible .menu-row__icon {
		color: var(--accent);
	}

	.menu-row__label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.2;
	}

	.menu-row__value {
		grid-column: 3;
		justify-self: end;
		max-width: 8rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		color: var(--text-muted);
	}

	.menu-row__chevron {
		grid-column: 4;
		display: inline-flex;
		color: var(--text-muted);
	}

	.menu-row--account .menu-row__label {
		padding-left: 0.15rem;
	}

	.menu-row--link {
		grid-template-columns: minmax(0, 1fr);
		min-height: 2rem;
	}

	.menu-row--link .menu-row__label {
		grid-column: 1;
		color: var(--accent);
		font-weight: 600;
	}

	.menu-row__hint {
		margin: -0.1rem 0 0.22rem;
		padding: 0 0.5rem;
		font-size: var(--text-2xs);
		line-height: 1.35;
		color: var(--text-secondary);
	}

	/* ── The switch face ── mirrors ui/Toggle exactly, drawn as a span so the
	   row itself can be the menuitemcheckbox. */
	.switch-face {
		position: relative;
		grid-column: 3 / span 2;
		justify-self: end;
		width: 34px;
		height: 20px;
		flex-shrink: 0;
		border-radius: 9999px;
		background: var(--border-default);
		transition: background var(--duration-standard) var(--ease-out);
	}

	.switch-face--on {
		background: var(--accent);
	}

	.switch-face__thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 9999px;
		background: white;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
		transition: transform var(--duration-standard) var(--ease-out);
	}

	.switch-face--on .switch-face__thumb {
		transform: translateX(14px);
	}

	.tools-menu--sheet .switch-face {
		width: 44px;
		height: 24px;
	}

	.tools-menu--sheet .switch-face__thumb {
		width: 20px;
		height: 20px;
	}

	.tools-menu--sheet .switch-face--on .switch-face__thumb {
		transform: translateX(20px);
	}

	/* ── The two static rows (Model, Style) keep their own trigger ── */
	.menu-row-wrap--static :global(.model-selector) {
		grid-column: 3 / span 2;
		justify-self: end;
		min-width: 0;
	}

	.menu-row-wrap--static :global(.model-selector__text) {
		max-width: 8rem;
	}

	.menu-row__icon--static {
		grid-column: 1;
	}

	.model-selector {
		position: relative;
		display: flex;
		justify-content: flex-end;
	}

	.model-selector__trigger {
		display: flex;
		align-items: center;
		gap: var(--space-xs, 4px);
		padding: 0.3rem 0.48rem;
		background: transparent;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 0.5rem;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-2xs);
		cursor: pointer;
		transition: all 150ms ease-out;
		min-height: 30px;
	}

	.tools-menu--sheet .model-selector__trigger {
		min-height: 34px;
	}

	.model-selector__trigger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
	}

	.model-selector__trigger:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 34%, transparent 66%);
	}

	.model-selector__text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 108px;
	}

	.model-selector__chevron {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--text-secondary);
	}

	.model-selector__dropdown {
		position: absolute;
		bottom: 100%;
		right: 0;
		margin: 0 0 0.25rem;
		padding: 0.24rem;
		background: color-mix(in srgb, var(--surface-overlay) 92%, var(--surface-page) 8%);
		display: flex;
		flex-direction: column;
		gap: 0.12rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 0.55rem;
		box-shadow:
			0 14px 30px rgba(0, 0, 0, 0.14),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
		list-style: none;
		min-width: 100%;
		z-index: 100;
		animation: dropdownFadeIn 150ms ease-out;
	}

	.model-selector__option {
		padding: 0.38rem 0.5rem;
		border-radius: 0.42rem;
		cursor: pointer;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.15;
		color: var(--text-primary);
		transition: background-color 150ms ease-out;
		white-space: nowrap;
	}

	.model-selector__option:hover,
	.model-selector__option:focus {
		background: color-mix(in srgb, var(--accent) 24%, transparent);
		outline: none;
	}

	.model-selector__option--selected {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		font-weight: 500;
	}

	/* "Nothing you tap here is smaller than 44px" — the Style rows are the
	   last list in this menu that was still drawn at desktop density, which
	   on a phone put three ~26px targets inside a sheet whose every other
	   row is 44. */
	.tools-menu--sheet .model-selector__option {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0.5rem 0.75rem;
		font-size: var(--text-sm);
	}

	/* ── The Atlas profile picker ── */
	.atlas-profile-picker {
		position: absolute;
		right: 0;
		bottom: 100%;
		z-index: 120;
		width: min(19rem, calc(100vw - 2rem));
		margin-bottom: 0.35rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		border-radius: 0.7rem;
		background: color-mix(in srgb, var(--surface-overlay) 94%, var(--surface-page) 6%);
		box-shadow:
			0 16px 34px rgba(0, 0, 0, 0.16),
			0 1px 0 color-mix(in srgb, var(--border-default) 88%, transparent 12%);
		padding: 0.7rem;
	}

	.atlas-profile-picker--sheet {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		width: auto;
		margin: 0;
		max-height: min(80dvh, 36rem);
		overflow-y: auto;
		overscroll-behavior: contain;
		border-radius: 16px 16px 0 0;
		border-bottom: 0;
		padding: 0 0.75rem calc(0.75rem + env(safe-area-inset-bottom));
		z-index: 70;
	}

	:global(.dark) .atlas-profile-picker {
		background: color-mix(in srgb, var(--surface-page) 90%, #000 10%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
		box-shadow:
			0 18px 36px rgba(0, 0, 0, 0.42),
			0 0 0 1px color-mix(in srgb, var(--border-default) 88%, transparent 12%);
	}

	.atlas-profile-picker__title {
		margin: 0;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 700;
		line-height: 1.2;
	}

	.atlas-profile-picker__subtitle {
		margin: 0.25rem 0 0.65rem;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		line-height: 1.3;
	}

	.atlas-profile-options {
		display: grid;
		gap: 0.45rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.atlas-profile-card {
		display: flex;
		gap: 0.58rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, transparent 24%);
		border-radius: 0.55rem;
		background: color-mix(in srgb, var(--surface-page) 72%, transparent 28%);
		padding: 0.62rem;
		color: var(--text-primary);
		cursor: pointer;
		transition:
			border-color 150ms ease-out,
			background-color 150ms ease-out,
			box-shadow 150ms ease-out,
			transform 150ms ease-out;
	}

	.atlas-profile-card:hover,
	.atlas-profile-card:focus {
		border-color: color-mix(in srgb, var(--accent) 55%, var(--border-default) 45%);
		background: color-mix(in srgb, var(--accent) 10%, var(--surface-page) 90%);
		box-shadow: var(--shadow-sm);
		outline: none;
	}

	.atlas-profile-card:active {
		transform: translateY(1px);
	}

	.atlas-profile-card--selected {
		border-color: color-mix(in srgb, var(--accent) 68%, var(--border-default) 32%);
		background: color-mix(in srgb, var(--accent) 14%, var(--surface-page) 86%);
	}

	.atlas-profile-radio {
		width: 0.9rem;
		height: 0.9rem;
		flex: 0 0 auto;
		border: 1.5px solid var(--border-default);
		border-radius: 999px;
		margin-top: 0.12rem;
		box-shadow: inset 0 0 0 3px var(--surface-overlay);
	}

	.atlas-profile-card--selected .atlas-profile-radio {
		border-color: var(--accent);
		background: var(--accent);
	}

	.atlas-profile-info {
		display: grid;
		min-width: 0;
		gap: 0.22rem;
	}

	.atlas-profile-row {
		display: flex;
		min-width: 0;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.atlas-profile-name {
		overflow: hidden;
		color: var(--text-primary);
		font-family: var(--font-sans);
		font-size: var(--text-sm);
		font-weight: 700;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.atlas-profile-time {
		flex: 0 0 auto;
		color: var(--text-muted);
		font-size: var(--text-2xs);
		line-height: 1.2;
		white-space: nowrap;
	}

	.atlas-profile-desc {
		color: var(--text-secondary);
		font-size: var(--text-xs);
		line-height: 1.32;
	}

	:global(.dark) .model-selector__trigger {
		color: var(--text-primary);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	:global(.dark) .model-selector__trigger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 26%, transparent);
	}

	:global(.dark) .model-selector__dropdown {
		background: color-mix(in srgb, var(--surface-page) 90%, #000 10%);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	:global(.dark) .model-selector__option {
		color: var(--text-primary);
	}

	:global(.dark) .model-selector__option:hover,
	:global(.dark) .model-selector__option:focus {
		background: color-mix(in srgb, var(--accent) 30%, transparent);
	}

	:global(.dark) .model-selector__option--selected {
		background: color-mix(in srgb, var(--accent) 24%, transparent);
	}

	@keyframes dropdownFadeIn {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.model-selector__dropdown {
			animation: none;
		}

		.menu-row,
		.menu-row__icon,
		.switch-face,
		.switch-face__thumb,
		.model-selector__trigger,
		.model-selector__option {
			transition: none;
		}
	}
</style>
