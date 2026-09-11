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
//   (conversation) Model · Style
//
// Accounts are not among them. The plug on the bar opens the per-account
// popover, so the accounts section in here was a second copy of the same
// switches — two places showing one state, and the one behind the plus was
// the one you could not see the count on.
//
// Two behaviours the old menu did not have, and the board asks for by name:
// a switch row flips IN PLACE and the menu stays open (turning Thinking on
// and then Incognito is one visit, not two), and the whole thing is a
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
	Sparkles,
	Type,
	VenetianMask,
} from "@lucide/svelte";
import ModelSelector from "./ModelSelector.svelte";
import {
	buildComposerMenuRows,
	type ComposerMenuSectionId,
	groupComposerMenuRows,
	nextMenuIndex,
} from "./composer-bar";
import {
	computeFlyoutPlacement,
	computeMenuPlacement,
	type FlyoutPlacement,
	type MenuPlacement,
	type PlacementRect,
} from "./composer-placement";
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
	// The "+" that opened this menu. On a desktop the menu is portalled to
	// <body> and positioned from this element's rect — see
	// `composer-placement`. Without one it falls back to opening in place,
	// which is what a bare render in a test gets.
	//
	// Named `triggerElement` rather than `anchor` because `anchor` is one of
	// Svelte's own mount options, and a prop that shadows one cannot be
	// passed by name.
	triggerElement = null,
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
	// Skills used to be reachable only by typing "$". The row says how many
	// are active so the menu is also where you find out that you have any.
	skillCount = null,
	pendingSkillName = null,
	onOpenSkills = undefined,
}: {
	triggerElement?: HTMLElement | null;
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
let rows = $derived(
	buildComposerMenuRows({
		canAttach,
		skillsEnabled: true,
		atlasVisible: Boolean(atlasAvailability),
		atlasAvailable,
		thinkingAvailable,
		personalityCount: personalityProfiles.length,
	}),
);

let sections = $derived(groupComposerMenuRows(rows));

const ATLAS_PROFILE_OPTIONS = [
	"overview",
	"in-depth",
	"exhaustive",
] as const satisfies readonly AtlasProfile[];

// ── Where the menu and its flyouts land ──────────────────────────────
//
// All three used to be CSS offsets from whatever they sat inside, which is
// the same bug three times: an offset cannot see the window. The menu opened
// upward from `bottom: calc(100% + 8px)` and had its top cut off on a 720px
// screen with the composer at the bottom of a conversation; the Model and
// Atlas pickers opened upward from their own rows and covered the rows above
// them. The arithmetic is in composer-placement.ts; the only thing that
// happens here is reading the rects and writing the style.
//
// They are portalled to <body> for the same reason the phone sheet is: this
// menu has a `backdrop-filter`, which makes it the containing block for any
// `position: fixed` descendant — measured against the viewport, drawn
// relative to the menu.

/** Roughly the Style list's width; it is a column of short profile names. */
const STYLE_FLYOUT_WIDTH = 224;
/** `min(19rem, …)`, the Atlas picker's own width. */
const ATLAS_FLYOUT_WIDTH = 304;

function rectOf(element: Element | null | undefined): PlacementRect | null {
	if (!element) return null;
	const box = element.getBoundingClientRect();
	return {
		top: box.top,
		left: box.left,
		right: box.right,
		bottom: box.bottom,
		width: box.width,
		height: box.height,
	};
}

function measureMenu(): MenuPlacement | null {
	if (typeof window === "undefined" || isPhoneViewport()) return null;
	const triggerRect = rectOf(triggerElement);
	if (!triggerRect) return null;
	return computeMenuPlacement(triggerRect, {
		width: window.innerWidth,
		height: window.innerHeight,
	});
}

// Measured before the menu is in the DOM — the trigger is all it needs — so
// the first frame is already in the right place rather than flying in from
// the top-left corner of the page.
let menuPlacement = $state<MenuPlacement | null>(measureMenu());
let styleFlyout = $state<FlyoutPlacement | null>(null);
let atlasFlyout = $state<FlyoutPlacement | null>(null);

/** Positioned from the trigger rather than opening in place. */
let anchored = $derived(!isPhone && Boolean(triggerElement));
let portaled = $derived(isPhone || anchored);

let menuStyle = $derived.by(() => {
	if (isPhone || !anchored || !menuPlacement) return undefined;
	const edge =
		menuPlacement.top !== null
			? `top: ${menuPlacement.top}px;`
			: `bottom: ${menuPlacement.bottom}px;`;
	return `left: ${menuPlacement.left}px; ${edge} max-height: ${menuPlacement.maxHeight}px;`;
});

function flyoutStyle(
	placement: FlyoutPlacement | null,
	width: number,
): string | undefined {
	if (!placement) return undefined;
	return `left: ${placement.left}px; top: ${placement.top}px; width: ${width}px; max-height: ${placement.maxHeight}px;`;
}

function measureFlyout(rowId: string, width: number): FlyoutPlacement | null {
	if (typeof window === "undefined") return null;
	const menuRect = rectOf(root);
	if (!menuRect) return null;
	return computeFlyoutPlacement(
		rectOf(rowElements.get(rowId)) ?? menuRect,
		menuRect,
		{ width: window.innerWidth, height: window.innerHeight },
		{ width },
	);
}

function measurePlacement() {
	if (isPhone) {
		menuPlacement = null;
		styleFlyout = null;
		atlasFlyout = null;
		return;
	}
	menuPlacement = measureMenu();
	styleFlyout =
		anchored && activeDropdown === "style"
			? measureFlyout("style", STYLE_FLYOUT_WIDTH)
			: null;
	atlasFlyout =
		anchored && activeDropdown === "atlas"
			? measureFlyout("atlas", ATLAS_FLYOUT_WIDTH)
			: null;
}

// Re-measure whenever what is on screen changes shape. The reads below are
// the dependencies; the measuring itself happens after the DOM has caught
// up, so nothing it touches is tracked.
$effect(() => {
	isPhone;
	activeDropdown;
	rows.length;
	void tick().then(measurePlacement);
});

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
// open, so turning Thinking on and then Incognito is one visit.
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
	// The menu itself: on a desktop it is now portalled to <body> too, so
	// "inside the menu" is no longer a question about this component's
	// subtree in the composer.
	".tools-menu",
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

	// The menu is fixed to the trigger's rect, so anything that moves the
	// trigger moves the menu: a resized window, and a scroll anywhere on the
	// page (captured, because scroll does not bubble).
	const handleReflow = () => measurePlacement();
	window.addEventListener("resize", handleReflow);
	window.addEventListener("scroll", handleReflow, true);

	document.addEventListener("mousedown", handlePointerDown);
	document.addEventListener("touchstart", handlePointerDown, { passive: true });
	window.addEventListener("keydown", handleKeyDown);

	measurePlacement();

	// Opened from the keyboard or the pointer, the first row takes focus so
	// the arrow keys have somewhere to start.
	void focusRow(0);

	return () => {
		stopWatchingViewport?.();
		window.removeEventListener("resize", handleReflow);
		window.removeEventListener("scroll", handleReflow, true);
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

{#snippet sectionHeading(section: ComposerMenuSectionId)}
	<div class="menu-section" role="presentation">
		<span class="menu-section__title">
			{#if section === 'message'}
				{$t('composerMenu.sectionMessage')}
			{:else if section === 'switches'}
				{$t('composerMenu.sectionSwitches')}
			{:else}
				{$t('composerMenu.sectionConversation')}
			{/if}
		</span>
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
	class:tools-menu--anchored={!isPhone && anchored}
	style={menuStyle}
	data-testid="composer-tools-menu"
	role="menu"
	tabindex="-1"
	aria-label={$t('composerMenu.label')}
	use:portalToBody={portaled}
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
	{#each sections as group (group.section)}
		{@render sectionHeading(group.section)}

		{#each group.entries as { row, index } (row.id)}
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
					{@const asFlyout = !isPhone && anchored && atlasFlyout !== null}
					<section
						class="atlas-profile-picker"
						class:atlas-profile-picker--sheet={isPhone}
						class:atlas-profile-picker--flyout={asFlyout}
						style={asFlyout ? flyoutStyle(atlasFlyout, ATLAS_FLYOUT_WIDTH) : undefined}
						use:portalToBody={isPhone || asFlyout}
						transition:menuFly={isPhone
							? { duration: 250, y: 220, opacity: 1 }
							: asFlyout
								? { duration: 150, x: -4, y: 0 }
								: { duration: 150, y: 4 }}
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
					flyout={!isPhone && anchored}
					flyoutAnchor={root ?? null}
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
						{@const asFlyout = !isPhone && anchored && styleFlyout !== null}
						<ul
							class="model-selector__dropdown"
							class:model-selector__dropdown--flyout={asFlyout}
							style={asFlyout ? flyoutStyle(styleFlyout, STYLE_FLYOUT_WIDTH) : undefined}
							use:portalToBody={asFlyout}
							role="listbox"
						>
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

	/* Positioned from the trigger's rect against the viewport, not offset
	   from the composer — see composer-placement.ts. The offset version
	   opened upward from `bottom: calc(100% + 8px)` with no idea how much
	   room was up there, so on a 1280x720 window with the composer at the
	   bottom of a conversation the top of the menu was simply cut off.

	   `left`, the vertical edge and `max-height` all arrive inline; what is
	   here is everything that does not depend on the measurement. */
	.tools-menu--anchored {
		position: fixed;
		bottom: auto;
		z-index: 60;
		overflow-y: auto;
		overscroll-behavior: contain;
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

	/* A section says what the rows under it are about. */
	.menu-section {
		display: flex;
		align-items: baseline;
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

	.menu-section__title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	/* Beside the menu rather than above the row, so the list no longer
	   covers the rows it was opened from. Fixed and portalled to <body>:
	   this menu has a backdrop-filter, which would otherwise make it the
	   containing block for a fixed child. */
	.model-selector__dropdown--flyout {
		position: fixed;
		right: auto;
		bottom: auto;
		margin: 0;
		min-width: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		z-index: 140;
		animation-name: flyoutFadeIn;
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

	.atlas-profile-picker--flyout {
		position: fixed;
		right: auto;
		bottom: auto;
		width: auto;
		margin: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		z-index: 140;
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

	/* A flyout arrives from the side it opens on, not from below. */
	@keyframes flyoutFadeIn {
		from {
			opacity: 0;
			transform: translateX(-4px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
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
