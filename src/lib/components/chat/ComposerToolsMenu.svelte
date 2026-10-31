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
//   (switches)     Thinking
//   (conversation) Model · Style
//
// Incognito used to be a third switch here (and a second copy of the same
// switch in the face's own popover). Neither exists any more: incognito
// redesign (one-way) moved arming it to a single mask button on the landing
// page, before a conversation exists, because the flag can never be turned
// back off once a conversation has it — a switch in this menu would have
// kept implying it could be.
//
// Web search used to be a fourth switch and is not one any more: the owner's
// word for it was "confusing", and the confusion was structural — a switch
// implies the thing is off, while the model grounds itself whenever a
// question needs it. Forcing a search is still one `/web` away, and the chip
// above the composer is where you see and cancel it.
//
// Model and Style are not icon-and-label rows like the ones above them. Each
// is a single full-width control — "Model" on the left, the current value and
// a chevron on the right — because the whole row IS the dropdown, and an icon
// in front of it only made the hit target narrower than the switch rows it
// sits under. The Model row keeps its "?" beside the control, not inside it:
// the guide is a different destination from the picker.
//
// What those two rows and the Atlas row open is one picker, three times:
// ComposerSubmenu (a flyout beside the menu, a sheet on a phone) holding
// ComposerSubmenuOption rows. It used to be three designs.
//
// Accounts are not among them. The plug on the bar opens the per-account
// popover, so the accounts section in here was a second copy of the same
// switches — two places showing one state, and the one behind the plus was
// the one you could not see the count on.
//
// Two behaviours the old menu did not have, and the board asks for by name:
// a switch row flips IN PLACE and the menu stays open, and the whole thing
// is a real menu for the keyboard — arrow keys walk it, Escape closes it,
// and focus returns to the plus that opened it.
//
// On a phone it becomes a bottom sheet. An anchored popover pinned to a 19px
// icon at the bottom of a 390px screen sits under the thumb that opened it,
// and its 30px rows are half the size of everything else on that screen.
import { onMount, tick } from "svelte";
import {
	Brain,
	ChevronDown,
	ChevronRight,
	Library,
	Orbit,
	Paperclip,
	Sparkles,
} from "@lucide/svelte";
import ComposerSubmenu from "./ComposerSubmenu.svelte";
import ComposerSubmenuOption from "./ComposerSubmenuOption.svelte";
import ModelSelector from "./ModelSelector.svelte";
import {
	buildComposerMenuRows,
	type ComposerMenuSectionId,
	groupComposerMenuRows,
	nextMenuIndex,
} from "./composer-bar";
import {
	computeMenuPlacement,
	type MenuPlacement,
	type PlacementRect,
} from "./composer-placement";
import { hasOpenDialog } from "$lib/components/ui/DialogShell.svelte";
import { t, type I18nKey } from "$lib/i18n";
import { maxFileUploadSizeMb } from "$lib/stores/upload-limits";
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
	// Defaults to the server-reported limit rather than a hardcoded 100 (spec
	// section 4.3). An explicit prop still wins, which is what the tests use.
	maxUploadMb = undefined,
	onClose,
	onAttach,
	onOpenLibrary,
	personalityProfiles = [],
	selectedPersonalityId = null,
	onPersonalityChange = undefined,
	onModelChange = undefined,
	initialOpen = null,
	atlasAvailability = null,
	atlasProfile = null,
	onAtlasProfileChange = undefined,
	// Moved in from the bar (Direction B keeps three icons out there;
	// everything else lives here).
	thinkingAvailable = false,
	thinkingOn = false,
	onToggleThinking = undefined,
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
	onOpenLibrary?: () => void;
	personalityProfiles?: Array<{
		id: string;
		name: string;
		description: string;
	}>;
	selectedPersonalityId?: string | null;
	onPersonalityChange?: ((id: string | null) => void) | undefined;
	onModelChange?: ((modelId: ModelId) => void) | undefined;
	initialOpen?: "model" | "style" | null;
	atlasAvailability?: AtlasAvailability | null;
	atlasProfile?: AtlasProfile | null;
	onAtlasProfileChange?: ((profile: AtlasProfile) => void) | undefined;
	thinkingAvailable?: boolean;
	thinkingOn?: boolean;
	onToggleThinking?: (() => void) | undefined;
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

// ── Where the menu lands ─────────────────────────────────────────────
//
// It used to be a CSS offset from whatever it sat inside, and an offset
// cannot see the window: the menu opened upward from `bottom: calc(100% +
// 8px)` and had its top cut off on a 720px screen with the composer at the
// bottom of a conversation. The arithmetic is in composer-placement.ts; the
// only thing that happens here is reading the rects and writing the style.
// The pickers it opens place themselves (ComposerSubmenu), beside it.
//
// It is portalled to <body> for the same reason the phone sheet is: this
// menu has a `backdrop-filter`, which makes it the containing block for any
// `position: fixed` descendant — measured against the viewport, drawn
// relative to the menu.

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

function measurePlacement() {
	menuPlacement = isPhone ? null : measureMenu();
}

// Re-measure whenever what is on screen changes shape. The reads below are
// the dependencies; the measuring itself happens after the DOM has caught
// up, so nothing it touches is tracked.
$effect(() => {
	isPhone;
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

function selectPersonality(id: string | null) {
	onPersonalityChange?.(id);
	closeMenu();
}

// Escape or a sheet's grabber: the picker goes, the menu stays, and focus is
// back on the row that opened it so the arrow keys carry on from there.
function closeSubmenu(rowId: "style" | "atlas") {
	activeDropdown = null;
	void focusRow(rowIndex(rowId));
}

// Parts of this menu that live in <body> rather than inside `root`: the
// pickers it opens (ComposerSubmenu portals itself, so its `position: fixed`
// means the viewport — see utils/portal). The outside-click handler would
// otherwise read a tap on an Atlas profile or a model as "somewhere else"
// and close the menu out from under it, before the click that chooses
// anything ever landed. The model guide's backdrop is here for the same
// reason: it is rendered at the top level by ModelSelector.
const OWN_OVERLAY_SELECTOR = [
	// The menu itself: on a desktop it is now portalled to <body> too, so
	// "inside the menu" is no longer a question about this component's
	// subtree in the composer.
	".tools-menu",
	".model-guide-backdrop",
	".composer-submenu",
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
		// A dialog opened from this menu (the model guide) is the layer on top
		// and takes the key. Asked of the open-dialog stack, not of
		// `defaultPrevented`: this listener is registered before the dialog's,
		// so it runs first and sees nothing prevented yet.
		if (event.key === "Escape" && !activeDropdown && !hasOpenDialog()) {
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
				title={attachmentsEnabled ? $t('composerTools.attachFileMaxSize', { max: maxUploadMb ?? $maxFileUploadSizeMb }) : $t('composerTools.uploadsUnavailable')}
				onfocus={() => (focusedIndex = index)}
				onclick={handleAttach}
			>
				<span class="menu-row__icon" aria-hidden="true"><Paperclip size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerTools.attachFile')}</span>
				<span class="menu-row__value">{$t('composerMenu.attachHint', { max: maxUploadMb ?? $maxFileUploadSizeMb })}</span>
			</button>

		{:else if row.id === 'library'}
			<button
				type="button"
				class="menu-row"
				role="menuitem"
				tabindex={focusedIndex === index ? 0 : -1}
				use:registerRow={row.id}
				data-testid="composer-menu-library"
				onfocus={() => (focusedIndex = index)}
				onclick={() => {
					onClose?.();
					onOpenLibrary?.();
				}}
			>
				<span class="menu-row__icon" aria-hidden="true"><Library size={16} strokeWidth={2} /></span>
				<span class="menu-row__label">{$t('composerTools.fromLibrary')}</span>
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
								: $t('composerMenu.skillsAvailable', { count: skillCount }))}
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
					<ComposerSubmenu
						title={$t('composerTools.atlasProfileTitle')}
						subtitle={$t('composerTools.atlasProfileSubtitle')}
						listLabel={$t('composerTools.atlasProfile')}
						sheet={isPhone}
						rowElement={rowElements.get('atlas') ?? null}
						surfaceElement={root ?? null}
						onDismiss={() => closeSubmenu('atlas')}
						testId="composer-submenu-atlas"
					>
						{#each ATLAS_PROFILE_OPTIONS as profile (profile)}
							<ComposerSubmenuOption
								label={atlasProfileLabel(profile)}
								meta={$t(atlasProfileTimeKey(profile))}
								description={$t(atlasProfileDescriptionKey(profile))}
								selected={atlasProfile === profile}
								onSelect={() => selectAtlasProfile(profile)}
								optionId={profile}
							/>
						{/each}
					</ComposerSubmenu>
				{/if}
				{#if row.disabled}
					<p id="atlas-unavailable-reason" class="menu-row__hint">{atlasUnavailableReason}</p>
				{/if}
			</div>

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

		{:else if row.id === 'model'}
			<div class="menu-row-wrap menu-row-wrap--static">
				<ModelSelector
					open={activeDropdown === 'model'}
					onOpenChange={(open) => activeDropdown = open ? 'model' : null}
					onSelect={selectModel}
					onTriggerRef={(element) => bindRowElement('model', element)}
					ownsScrim={!isPhone}
					flyoutAnchor={root ?? null}
					leadingLabel={$t('composerTools.model')}
				/>
			</div>

		{:else if row.id === 'style'}
			<div class="menu-row-wrap menu-row-wrap--static">
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
						<span class="model-selector__lead">{$t('composerTools.style')}</span>
						<span class="model-selector__text">
							{selectedProfile
								? getPersonalityProfileDisplayName(selectedProfile, $t)
								: $t('composerTools.defaultStyle')}
						</span>
						<span class="model-selector__chevron" aria-hidden="true">
							<ChevronDown size={15} strokeWidth={2} />
						</span>
					</button>
					{#if styleOpen}
						<ComposerSubmenu
							title={$t('composerTools.styleTitle')}
							subtitle={$t('composerTools.styleSubtitle')}
							listLabel={$t('composerTools.style')}
							sheet={isPhone}
							rowElement={rowElements.get('style') ?? null}
							surfaceElement={root ?? null}
							onDismiss={() => closeSubmenu('style')}
							testId="composer-submenu-style"
						>
							<!-- What a style does is said on its row: a tooltip
							     never reaches a phone, and the names alone
							     ("Warm", "Technical") leave the user guessing. -->
							<ComposerSubmenuOption
								label={$t('composerTools.defaultStyle')}
								description={$t('personalityProfile.default.description')}
								selected={!selectedPersonalityId}
								onSelect={() => selectPersonality(null)}
							/>
							{#each personalityProfiles as profile (profile.id)}
								<ComposerSubmenuOption
									label={getPersonalityProfileDisplayName(profile, $t)}
									description={getPersonalityProfileDisplayDescription(profile, $t) || null}
									selected={selectedPersonalityId === profile.id}
									onSelect={() => selectPersonality(profile.id)}
									optionId={profile.id}
								/>
							{/each}
						</ComposerSubmenu>
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
		/* The surface the pickers it opens share (ComposerSubmenu). */
		border: 1px solid var(--menu-border);
		border-radius: 0.72rem;
		background: var(--menu-surface);
		box-shadow: var(--menu-shadow);
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

	/* Sits under the sheet (z 60) and the picker sheets (z 70) but over the
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
		/* The title clips for its ellipsis, and a line box of 1.2 leaves no room above a
		   capital for a diaeresis: "EZ AZ ÜZENET" was drawn "EZ AZ UZENET". The padding is
		   room inside the clip, and the negative margin gives back the space it took. */
		padding-block: 0.25em;
		margin-block: -0.25em;
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

	/* Model and Style are one full-width control each, so the row is a flex
	   line rather than the four-column grid the icon rows use: nothing has to
	   line up with an icon well that is no longer there. */
	.menu-row-wrap--static {
		display: flex;
		gap: 0.35rem;
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

	/* ── The two static rows (Model, Style) are their own trigger ──
	   The control spans the row, so its hover target and its border are the
	   same width as the switch rows above it. `:global` because the Model
	   row's trigger belongs to ModelSelector; the Style row's is local, and
	   the same rules catch both. */
	.menu-row-wrap--static :global(.model-selector) {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		min-width: 0;
	}

	.menu-row-wrap--static :global(.model-selector__controls) {
		display: flex;
		flex: 1 1 auto;
		gap: 0.35rem;
		min-width: 0;
	}

	/* ModelSelector is drawn for the settings page's density (36px, --text-sm)
	   and Style is drawn for the menu's (30px, --text-2xs). Side by side as
	   two full-width rows the difference is the first thing you see, so the
	   menu states its own density for both. */
	.menu-row-wrap--static :global(.model-selector__trigger) {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 30px;
		padding: 0.3rem 0.48rem;
		border-radius: 0.5rem;
		border-color: color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		font-size: var(--text-2xs);
		transition: all var(--duration-standard) var(--ease-out);
	}

	.menu-row-wrap--static :global(.model-selector__trigger:hover:not(:disabled)) {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
	}

	.menu-row-wrap--static :global(.model-selector__guide-trigger) {
		height: auto;
		min-height: 30px;
		width: 28px;
		min-width: 28px;
		border-radius: 0.5rem;
		border-color: color-mix(in srgb, var(--border-default) 78%, transparent 22%);
		transition: all var(--duration-standard) var(--ease-out);
	}

	.menu-row-wrap--static :global(.model-selector__guide-trigger:hover:not(:disabled)) {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--border-default) 70%);
	}

	.tools-menu--sheet .menu-row-wrap--static :global(.model-selector__trigger),
	.tools-menu--sheet .menu-row-wrap--static :global(.model-selector__guide-trigger) {
		min-height: 34px;
	}

	.menu-row-wrap--static :global(.model-selector__text) {
		max-width: 8rem;
	}

	.model-selector {
		position: relative;
		display: flex;
		min-width: 0;
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

	/* The row's name, now the trigger's leading text. `margin-right: auto`
	   is what makes the row read as one control: the label sits at the left
	   edge, the current value and its chevron at the right, and the gap
	   between them belongs to the button. */
	.model-selector__lead {
		flex: 0 0 auto;
		margin-right: auto;
		padding-right: 0.5rem;
		white-space: nowrap;
		color: var(--text-primary);
	}

	.model-selector__text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 108px;
		color: var(--text-secondary);
	}

	.model-selector__chevron {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--text-secondary);
	}

	:global(.dark) .model-selector__trigger {
		color: var(--text-primary);
		border-color: color-mix(in srgb, var(--border-default) 84%, transparent 16%);
	}

	:global(.dark) .model-selector__trigger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent) 26%, transparent);
	}

	@media (prefers-reduced-motion: reduce) {
		.menu-row,
		.menu-row__icon,
		.switch-face,
		.switch-face__thumb,
		.model-selector__trigger {
			transition: none;
		}
	}
</style>
