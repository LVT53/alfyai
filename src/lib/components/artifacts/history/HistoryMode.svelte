<script lang="ts">
/**
 * History, a MODE of the artifact panel (ruling 76, versioning.md §5.2): the
 * body gives way to a read-only preview of the selected version, and the
 * moments are a rail beside it. Done, Escape or the history button again return
 * to editing. The shell is the same for every kind; what shows one version is the
 * kind's preview (`history-previews.ts`).
 *
 * Three layouts, by the room it has: side by side (preview, then a 300 px rail)
 * in a panel at least 720 px wide; in a narrower panel the rail fills it and
 * choosing a moment pushes the preview over it, with a stepper so moving through
 * moments never needs the list; on a phone the same two-step flow is a full
 * sheet (`DialogShell`). Loading, paging, selection and the live announcements
 * live here; the rail, the toolbar and the preview only draw.
 */
import { ChevronLeft, ChevronRight, RotateCcw } from "@lucide/svelte";
import { type Component, onMount, tick, untrack } from "svelte";
import type { Attachment } from "svelte/attachments";
import { cubicOut } from "svelte/easing";
import { fade, fly } from "svelte/transition";
import {
	fetchArtifact,
	fetchArtifactHistory,
	nameArtifactVersion,
	restoreArtifactVersion,
	subscribeArtifactChanges,
	VersionRestoreRefusedError,
} from "$lib/client/api/artifacts";
import { documentTabsFromCardMetadata } from "$lib/components/artifacts/document/card-view";
import DialogShell from "$lib/components/ui/DialogShell.svelte";
import { type I18nKey, t } from "$lib/i18n";
import {
	type ArtifactMoment,
	normalizeVersionLabel,
} from "$lib/shared/artifacts/history";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import { historyShortcutLabel } from "$lib/components/artifacts/document/keyboard-shortcuts";
import { conversations } from "$lib/stores/conversations";
import { uiLanguage } from "$lib/stores/settings";
import { artifactHistoryHelpDismissed } from "$lib/stores/ui";
import { MOTION_DURATION, reducedMotionAware } from "$lib/utils/motion";
import {
	isPhoneViewport,
	watchPhoneViewport,
} from "$lib/utils/viewport.svelte";
import {
	type HistoryCompare,
	HISTORY_PREVIEWS,
	type HistoryPreviewProps,
	type HistoryPreviewState,
} from "./history-previews";
import MomentPreviewToolbar from "./MomentPreviewToolbar.svelte";
import MomentRail from "./MomentRail.svelte";
import {
	entryDetail,
	entryHeadline,
	type TextContext,
	whenLabel,
} from "./moment-text";
import {
	buildRailGroups,
	findRailEntry,
	flattenRailGroups,
	mergeFirstPage,
	newestEntryKey,
	newestRow,
	type RailEntry,
	type RailFilter,
	reconcileSelection,
} from "./rail-model";

let {
	artifactId,
	kind,
	title,
	conversationId = null,
	currentUser = null,
	onDone,
	onReview = undefined,
	onRestored = undefined,
	chatVersionIds = null,
	onFromChat = undefined,
}: {
	artifactId: string;
	kind: ArtifactKind;
	title: string;
	/** The conversation the panel shows, so an incognito chat's item stays in scope (ruling 51). */
	conversationId?: string | null;
	currentUser?: {
		id: string;
		displayName: string;
		profilePicture: string | null;
	} | null;
	/** Leaves History. Focus goes back to the history button (the panel's job). */
	onDone: () => void;
	/** Leaves History and steps the review to the change a waiting moment names. */
	onReview?: ((entry: RailEntry) => void) | undefined;
	/** A restore (or the Undo of one) wrote this version: what is stored changed under the open body, which loads it again when History is left. */
	onRestored?: ((version: number) => void) | undefined;
	/** The versions whose chat message this chat holds ("From the chat"). */
	chatVersionIds?: ReadonlySet<string> | null;
	onFromChat?: ((entry: RailEntry) => void) | undefined;
} = $props();

const WIDE_MIN_PX = 720;
const PAGE_SIZE = 50;

const sheetFade = reducedMotionAware(fade);
const railFly = reducedMotionAware(fly);
const toastFly = reducedMotionAware(fly);

// ---- what is loaded ---------------------------------------------------------

let status = $state<"loading" | "ready" | "error" | "deleted">("loading");
let moments = $state.raw<ArtifactMoment[]>([]);
let older = $state(false);
let nextBefore = $state<number | null>(null);
let newestVersion = $state(0);
let loadingOlder = $state(false);
let filter = $state<RailFilter>("all");
let selectedKey = $state<string | null>(null);
let compare = $state<HistoryCompare>("step");
/** The narrow layouts show the list, or the preview pushed over it. */
let view = $state<"list" | "preview">("list");
/** What the shown preview last told the shell (the stepper's total; an App version that can only be read). */
let previewState = $state<HistoryPreviewState>({
	status: "loading",
	changeCount: 0,
});

// What a restore and a name need to say (versioning.md §5.5, §5.6): how many tabs
// the Document has now, and the chat that made it when it is not this one.
let tabCount = $state(0);
let madeInConversationId = $state<string | null>(null);
let online = $state(typeof navigator === "undefined" ? true : navigator.onLine);

let restoreOpen = $state(false);
let restoring = $state(false);
let restoreProblem = $state<string | null>(null);
/**
 * The newest version the open question was asked over, and so what Restore
 * guards with (`expectVersion`). It is taken when the question opens, never when
 * the reader confirms: a version that arrives while they decide (a chat turn of
 * Alfy's in this very tab, which `refresh()` hears of and reads) would otherwise
 * be inside the guard, and the restore would bury a change nobody had looked at.
 */
let restoreGuard = 0;
let toast = $state<{
	message: string;
	/** The version the Undo brings back (the row the restore sat on), and the restore's own number. */
	undo: { versionId: string; restoreVersion: number } | null;
} | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const TOAST_MS = 5200;

let naming = $state(false);
let nameDraft = $state("");
let namingBusy = $state(false);
let nameProblem = $state<string | null>(null);
/** Naming the newest version closes its burst: said until the reader moves on. */
let nextEditsNote = $state(false);

/** What the rail lets its host do: put the keyboard on an option, and list the options drawn. */
interface RailHandle {
	focusOption: (key: string | null) => Promise<void>;
	optionElements: () => HTMLElement[];
}
let rail = $state<RailHandle | null>(null);
let rootWidth = $state(0);
let isPhone = $state(isPhoneViewport());

// ---- the words ----------------------------------------------------------------

// The clock moves the relative times on while History stays open.
let clock = $state(Date.now());
$effect(() => {
	const timer = setInterval(() => {
		clock = Date.now();
	}, 30_000);
	return () => clearInterval(timer);
});

const labels = $derived.by(() => {
	const map = new Map<string, string>();
	for (const moment of moments) {
		if (moment.label) map.set(moment.versionId, moment.label);
		for (const step of moment.steps) {
			if (step.label) map.set(step.versionId, step.label);
		}
	}
	return map;
});

const ctx: TextContext = $derived({
	t: $t,
	lang: $uiLanguage === "hu" ? "hu" : "en",
	now: clock,
	labelOf: (versionId: string) => labels.get(versionId) ?? null,
});

// ---- derived views -------------------------------------------------------------

const groups = $derived(buildRailGroups(moments, filter));
const allEntries = $derived(flattenRailGroups(buildRailGroups(moments, "all")));
const selected = $derived(findRailEntry(groups, selectedKey));
const hasNamed = $derived(labels.size > 0);
// The Named filter is only offered while a version is named: removing the last name
// puts the rail back on everything, not on an empty list.
$effect(() => {
	if (filter === "named" && !hasNamed) {
		filter = "all";
		selectedKey = reconcileSelection(
			buildRailGroups(
				untrack(() => moments),
				"all",
			),
			untrack(() => selectedKey),
		);
	}
});
const layout = $derived<"phone" | "wide" | "narrow">(
	isPhone
		? "phone"
		: rootWidth === 0 || rootWidth >= WIDE_MIN_PX
			? "wide"
			: "narrow",
);

/** The newest version's id and hash: what "compared with now" compares with. */
const nowRow = $derived.by(() => {
	const top = moments[0];
	if (!top) return { versionId: "", hash: "" };
	const step = top.steps.find((candidate) => candidate.isNewest);
	return step
		? { versionId: step.versionId, hash: `${step.versionId}` }
		: { versionId: top.versionId, hash: top.bodyHash };
});

const showCompare = $derived(
	selected !== null && !selected.isNewest && moments.length > 1,
);
const stepDisabled = $derived(
	selected !== null && selected.parentVersionId === null,
);
const compareEffective = $derived<HistoryCompare>(
	showCompare ? (stepDisabled ? "now" : compare) : "step",
);

function capitalize(text: string): string {
	return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

const selectedTitle = $derived(
	selected
		? `${capitalize(whenLabel(selected.at, ctx))} · ${entryHeadline(selected, ctx, kind)}`
		: "",
);
const selectedDetail = $derived(
	selected ? entryDetail(selected, ctx, kind) : null,
);

/** An App version the rules now forbid is shown as Code only; bringing it back would make it the live App (ruling 58). */
const codeOnly = $derived(kind === "app" && previewState.codeOnly === true);
const canRestore = $derived(
	selected !== null &&
		!selected.isNewest &&
		!selected.sameAsNow &&
		online &&
		!codeOnly,
);
const restoreDisabledReason = $derived(
	selected === null || selected.isNewest || selected.sameAsNow
		? null
		: !online
			? $t("artifacts.history.restoreOffline")
			: codeOnly
				? $t("artifacts.history.restoreNotRunnable")
				: null,
);
/** A change of Alfy's that still waits for the reader and is newer than the version being brought back goes with the restore. */
const restoreTakesWaiting = $derived(
	selected !== null &&
		moments.some(
			(moment) =>
				moment.status === "waiting" &&
				newestRow(moment) > selected.versionNumber,
		),
);
const madeInTitle = $derived.by(() => {
	if (!madeInConversationId || madeInConversationId === conversationId) {
		return null;
	}
	return (
		$conversations.find(
			(conversation) => conversation.id === madeInConversationId,
		)?.title ?? ""
	);
});
const restoreLines = $derived.by(() => {
	if (!selected) return null;
	const lines = [
		selected.label
			? $t("artifacts.history.restoreQNamed", { name: selected.label })
			: $t("artifacts.history.restoreQ", { when: whenLabel(selected.at, ctx) }),
	];
	if (kind === "document" && tabCount > 1) {
		lines.push($t("artifacts.history.restoreTabs"));
	}
	// An App's saved data is not part of a version: a restore brings the code back and
	// leaves what the App has saved as it is now (versioning.md §6).
	if (kind === "app") lines.push($t("artifacts.history.restoreAppData"));
	if (madeInTitle !== null) {
		lines.push(
			madeInTitle
				? $t("artifacts.history.restoreElsewhere", { chat: madeInTitle })
				: $t("artifacts.history.restoreElsewhereGeneric"),
		);
	}
	if (restoreTakesWaiting) lines.push($t("artifacts.history.restoreWaiting"));
	return lines;
});

const help = $derived(
	$artifactHistoryHelpDismissed || moments.length < 2
		? null
		: $t("artifacts.history.help", { keys: historyShortcutLabel("undo") }),
);

// ---- the preview ---------------------------------------------------------------

let PreviewComponent = $state<Component<HistoryPreviewProps> | null>(null);
$effect(() => {
	const loader = HISTORY_PREVIEWS[kind];
	if (!loader) return;
	let cancelled = false;
	void loader().then((module) => {
		if (!cancelled) PreviewComponent = module.default;
	});
	return () => {
		cancelled = true;
	};
});

let changeCursor = $state({ index: -1, nonce: 0 });
let live = $state("");

let announcedFor = "";
function handlePreviewState(next: HistoryPreviewState) {
	previewState = next;
	// A selection is announced once, when its preview has loaded; what the reader
	// then does to it (naming it, asking to restore it) says its own words.
	const announcement = `${selectedKey}|${compareEffective}|${next.changeCount}`;
	if (next.status === "ready" && selected && announcement !== announcedFor) {
		announcedFor = announcement;
		const changes =
			next.changeCount > 0
				? ` ${$t("artifacts.history.live.changes", { count: next.changeCount })}`
				: "";
		live = `${$t("artifacts.history.live.selected", {
			when: capitalize(whenLabel(selected.at, ctx)),
			headline: entryHeadline(selected, ctx, kind),
		})}${changes}`;
	}
}

// A new selection starts its change stepper over.
$effect(() => {
	selectedKey;
	compareEffective;
	changeCursor = { index: -1, nonce: untrack(() => changeCursor.nonce) };
});

function stepChange(direction: 1 | -1) {
	const count = previewState.changeCount;
	if (count === 0) return;
	const index =
		changeCursor.index === -1
			? direction === 1
				? 0
				: count - 1
			: (changeCursor.index + direction + count) % count;
	changeCursor = { index, nonce: changeCursor.nonce + 1 };
}

// ---- loading -------------------------------------------------------------------

/** What the restore question needs of the item itself; never fatal: without it the question just says less. */
async function learnItem(): Promise<void> {
	try {
		const detail = await fetchArtifact(artifactId, conversationId);
		tabCount = documentTabsFromCardMetadata(detail.artifact.metadata).length;
		madeInConversationId = detail.artifact.conversationId ?? null;
	} catch {
		// See above.
	}
}

async function load(): Promise<void> {
	status = "loading";
	void learnItem();
	try {
		const result = await fetchArtifactHistory(artifactId, {
			limit: PAGE_SIZE,
			conversationId,
		});
		if (!result.ok) {
			status = "deleted";
			return;
		}
		moments = result.moments;
		older = result.older;
		nextBefore = result.nextBefore;
		newestVersion = result.newestVersion;
		selectedKey = reconcileSelection(
			buildRailGroups(result.moments, filter),
			null,
		);
		status = "ready";
		await tick();
		focusSelected();
	} catch {
		status = "error";
	}
}

/** Opening History puts the keyboard on the newest moment; a phone's sheet moves its own focus first, so this waits for it. */
function focusSelected() {
	const key = selectedKey;
	if (!key) return;
	const focus = () => void rail?.focusOption(key);
	focus();
	if (isPhone) setTimeout(focus, 60);
}

async function loadOlder(): Promise<void> {
	if (loadingOlder || !older || nextBefore === null) return;
	loadingOlder = true;
	const beforeKeys = new Set(
		flattenRailGroups(groups).map((entry) => entry.key),
	);
	try {
		const result = await fetchArtifactHistory(artifactId, {
			before: nextBefore,
			limit: PAGE_SIZE,
			conversationId,
		});
		if (!result.ok) return;
		const known = new Set(moments.map((moment) => moment.versionId));
		moments = [
			...moments,
			...result.moments.filter((moment) => !known.has(moment.versionId)),
		];
		older = result.older;
		nextBefore = result.nextBefore;
		await tick();
		// The button stays (and keeps the focus) while there is more to page; when it
		// goes, the keyboard reader lands on the first row that came in.
		if (!older) {
			const firstNew = flattenRailGroups(groups).find(
				(entry) => !beforeKeys.has(entry.key),
			);
			if (firstNew) void rail?.focusOption(firstNew.key);
		}
	} catch {
		// The button stays: the reader can ask again.
	} finally {
		loadingOlder = false;
	}
}

/** A version written while History is open (a chat turn, another tab) rises in at the top; the selection and the preview stay where the reader is. */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
async function refresh(): Promise<void> {
	try {
		const result = await fetchArtifactHistory(artifactId, {
			limit: PAGE_SIZE,
			conversationId,
		});
		if (!result.ok) {
			status = "deleted";
			return;
		}
		const knownTop = moments[0]?.versionId ?? null;
		// The rail's clock catches up with a version that just landed.
		clock = Date.now();
		moments = mergeFirstPage(result.moments, moments);
		newestVersion = result.newestVersion;
		// A version arrived while the question stood open (not the restore's own,
		// which `confirmRestore` is still waiting for): the reader is told, over the
		// latest the rail now shows, and their next press is on that state.
		if (restoreOpen && !restoring && result.newestVersion > restoreGuard) {
			restoreProblem = $t("artifacts.history.restoreMoved");
			restoreGuard = result.newestVersion;
		}
		if (older || result.older) {
			// The older end is unchanged by a new top; keep the paging cursor of what is loaded.
			older = older || result.older;
		}
		selectedKey = reconcileSelection(
			buildRailGroups(moments, filter),
			selectedKey,
		);
		const top = result.moments[0];
		if (top && top.versionId !== knownTop && selected) {
			live = $t("artifacts.history.live.newMoment", {
				headline: entryHeadline(
					buildRailGroups([top], "all")[0].entries[0],
					ctx,
					kind,
				),
			});
		}
	} catch {
		// What is shown stays; the next change asks again.
	}
}

onMount(() => {
	void load();
	const stopWatchingViewport = watchPhoneViewport((phone) => {
		isPhone = phone;
	});
	const goOnline = () => {
		online = true;
	};
	const goOffline = () => {
		online = false;
	};
	window.addEventListener("online", goOnline);
	window.addEventListener("offline", goOffline);
	const stopListening = subscribeArtifactChanges((change) => {
		if (change.type === "deleted" && change.artifactId === artifactId) {
			status = "deleted";
			return;
		}
		if (
			change.type === "version" &&
			change.artifactId === artifactId &&
			status === "ready" &&
			change.version > newestVersion
		) {
			if (refreshTimer) clearTimeout(refreshTimer);
			refreshTimer = setTimeout(() => void refresh(), 150);
		}
	});
	return () => {
		stopWatchingViewport();
		stopListening();
		window.removeEventListener("online", goOnline);
		window.removeEventListener("offline", goOffline);
		if (refreshTimer) clearTimeout(refreshTimer);
		if (toastTimer) clearTimeout(toastTimer);
	};
});

// ---- the reader's moves --------------------------------------------------------

function select(key: string) {
	selectedKey = key;
}

function activate(key: string) {
	selectedKey = key;
	if (layout !== "wide") view = "preview";
}

// What the reader was doing about one version (asking to restore it, naming it)
// belongs to that version: another selection starts clean.
$effect(() => {
	selectedKey;
	untrack(() => {
		restoreOpen = false;
		restoreProblem = null;
		naming = false;
		nameProblem = null;
		nextEditsNote = false;
	});
});

function chooseFilter(next: RailFilter) {
	filter = next;
	selectedKey = reconcileSelection(buildRailGroups(moments, next), selectedKey);
}

/** The moment stepper of the narrow layouts: ‹ is the one before in time (older), › the one after. */
function stepMoment(direction: "older" | "newer") {
	const flat = flattenRailGroups(groups);
	const index = flat.findIndex((entry) => entry.key === selectedKey);
	const next = flat[direction === "older" ? index + 1 : index - 1];
	if (next) selectedKey = next.key;
}

const hasOlderEntry = $derived.by(() => {
	const flat = flattenRailGroups(groups);
	const index = flat.findIndex((entry) => entry.key === selectedKey);
	return index >= 0 && index < flat.length - 1;
});
const hasNewerEntry = $derived.by(() => {
	const flat = flattenRailGroups(groups);
	return flat.findIndex((entry) => entry.key === selectedKey) > 0;
});

function backToList() {
	view = "list";
	void tick().then(() => rail?.focusOption(selectedKey));
}

function handleRootKeydown(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
		event.preventDefault();
		stepChange(event.key === "ArrowDown" ? 1 : -1);
		return;
	}
	if (event.key === "Escape" && !isPhone) {
		event.preventDefault();
		event.stopPropagation();
		// One press closes the layer that is on top: the restore question, then the
		// pushed preview, then History itself.
		if (restoreOpen) {
			cancelRestore();
			return;
		}
		if (layout === "narrow" && view === "preview") {
			backToList();
			return;
		}
		onDone();
	}
}

/** The phone sheet's own dismissals (Escape, the grabber, a tap on the page) peel one layer: the preview first, then the sheet. */
function handleSheetClose() {
	if (restoreOpen) {
		cancelRestore();
		return;
	}
	if (view === "preview") {
		backToList();
		return;
	}
	onDone();
}

/** Puts the keyboard on the confirming button when the phone's restore question opens. */
const focusOnMount: Attachment<HTMLElement> = (element) => {
	element.focus();
};

function handleDismissHelp() {
	artifactHistoryHelpDismissed.set(true);
}

// ---- restore (versioning.md §5.5) -----------------------------------------------

function askRestore() {
	if (!canRestore) return;
	restoreProblem = null;
	restoreGuard = newestVersion;
	restoreOpen = true;
}

function cancelRestore() {
	restoreOpen = false;
	restoreProblem = null;
}

function showToast(
	message: string,
	undo: { versionId: string; restoreVersion: number } | null,
) {
	toast = { message, undo };
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		toast = null;
	}, TOAST_MS);
}

/**
 * After a write History made: read the top of the history again and land on the
 * entry that holds the newest row. A fold shows its OLDEST row as the moment (the
 * restore a toast's Undo reversed), so that is the step under it, never the moment:
 * the reader sees what is there now, and a name goes on the version that is current.
 * The new version is not named, so the Named filter would not list it: back to All.
 */
async function landOnTop() {
	await refresh();
	filter = "all";
	const key = newestEntryKey(buildRailGroups(moments, "all"));
	if (key) selectedKey = key;
	compare = "step";
}

async function confirmRestore() {
	const entry = selected;
	if (!entry || restoring || !canRestore) return;
	restoring = true;
	restoreProblem = null;
	// The toast's Undo brings back the row the restore sat on top of.
	const rowBelow = nowRow.versionId;
	try {
		// `expectVersion` is what the question was asked over: a restore over a
		// version that arrived since is refused, like a stale save.
		const version = await restoreArtifactVersion(
			artifactId,
			entry.versionId,
			conversationId,
			undefined,
			{ expectVersion: restoreGuard },
		);
		onRestored?.(version);
		const when = whenLabel(entry.at, ctx);
		restoreOpen = false;
		await landOnTop();
		live = $t("artifacts.history.restoredA11y", { when });
		showToast(
			$t("artifacts.history.restored", { when }),
			rowBelow ? { versionId: rowBelow, restoreVersion: version } : null,
		);
	} catch (error) {
		if (
			error instanceof VersionRestoreRefusedError &&
			error.reason === "version_conflict"
		) {
			// Something wrote a version since History loaded: say so, show the
			// latest, and let the reader ask again.
			restoreProblem = $t("artifacts.history.restoreMoved");
			await refresh();
			restoreGuard = newestVersion;
		} else if (
			error instanceof VersionRestoreRefusedError &&
			error.reason === "not_runnable"
		) {
			// The server's own audit (ruling 58): asked before the preview had said so.
			restoreProblem = $t("artifacts.history.restoreNotRunnable");
		} else {
			restoreProblem = $t("artifacts.history.restoreFailed");
		}
	} finally {
		restoring = false;
	}
}

/** The toast's own Undo: it reverses the restore it just made, so the two read as one quiet moment. */
async function undoRestore() {
	const current = toast;
	if (!current?.undo) return;
	toast = null;
	if (toastTimer) clearTimeout(toastTimer);
	try {
		const version = await restoreArtifactVersion(
			artifactId,
			current.undo.versionId,
			conversationId,
			undefined,
			{
				expectVersion: current.undo.restoreVersion,
				undoOf: current.undo.restoreVersion,
			},
		);
		onRestored?.(version);
		await landOnTop();
	} catch (error) {
		showToast(
			error instanceof VersionRestoreRefusedError &&
				error.reason === "version_conflict"
				? $t("artifacts.history.restoreMoved")
				: $t("artifacts.history.restoreFailed"),
			null,
		);
		await refresh();
	}
}

// ---- naming (versioning.md §5.6) ------------------------------------------------

function startName() {
	if (!selected) return;
	nameProblem = null;
	nameDraft = selected.label ?? "";
	naming = true;
}

function cancelName() {
	naming = false;
	nameProblem = null;
}

function withLabel(
	moment: ArtifactMoment,
	versionId: string,
	label: string | null,
): ArtifactMoment {
	const steps = moment.steps.map((step) =>
		step.versionId === versionId ? { ...step, label } : step,
	);
	return moment.versionId === versionId
		? { ...moment, label, steps }
		: { ...moment, steps };
}

async function applyName(raw: string | null) {
	const entry = selected;
	if (!entry || namingBusy) return;
	const normalized = normalizeVersionLabel(raw);
	if (!normalized.ok) {
		nameProblem = $t("artifacts.history.nameFailed");
		return;
	}
	namingBusy = true;
	nameProblem = null;
	try {
		const result = await nameArtifactVersion(
			artifactId,
			entry.versionId,
			normalized.label,
			conversationId,
		);
		if (!result.ok) {
			nameProblem = $t("artifacts.history.nameFailed");
			return;
		}
		moments = moments.map((moment) =>
			withLabel(moment, entry.versionId, result.label),
		);
		naming = false;
		live = result.label
			? $t("artifacts.history.named", { name: result.label })
			: "";
		// Naming the newest version closes its burst: the reader's next edits start a new one.
		nextEditsNote = result.label !== null && entry.isNewest;
	} catch {
		nameProblem = $t("artifacts.history.nameFailed");
	} finally {
		namingBusy = false;
	}
}

const regionLabel = $derived($t("artifacts.history.regionA11y", { title }));
const listLabel = $derived($t("artifacts.history.listA11y"));
const fine = $derived(
	selected
		? $t("artifacts.history.versionFine", { n: selected.versionNumber })
		: "",
);
const oneVersion = $derived(status === "ready" && allEntries.length === 1);
</script>

{#snippet toolbar()}
	{#if selected}
		<MomentPreviewToolbar
			title={selectedTitle}
			detail={selectedDetail}
			{fine}
			showCompare={showCompare}
			compare={compareEffective}
			stepDisabled={stepDisabled}
			changeCount={previewState.changeCount}
			changeIndex={changeCursor.index}
			nowLine={selected.isNewest}
			sameAsNow={selected.sameAsNow}
			label={selected.label}
			{nextEditsNote}
			canRestore={canRestore && !isPhone}
			{restoreDisabledReason}
			restoreQuestion={restoreOpen && !isPhone ? restoreLines : null}
			{restoring}
			{restoreProblem}
			{naming}
			bind:nameDraft
			{namingBusy}
			{nameProblem}
			narrow={layout !== 'wide'}
			onCompare={(next) => (compare = next)}
			onPrevChange={() => stepChange(-1)}
			onNextChange={() => stepChange(1)}
			onAskRestore={askRestore}
			onCancelRestore={cancelRestore}
			onConfirmRestore={confirmRestore}
			onStartName={startName}
			onSaveName={() => applyName(nameDraft)}
			onCancelName={cancelName}
			onRemoveName={() => applyName(null)}
		/>
	{/if}
{/snippet}

{#snippet previewBody()}
	{#if selected && PreviewComponent}
		{@const Preview = PreviewComponent}
		{#key selected.versionId}
			<div class="preview-fade" in:sheetFade={{ duration: MOTION_DURATION.standard, easing: cubicOut }}>
				<Preview
					{artifactId}
					{conversationId}
					versionId={selected.versionId}
					baseVersionId={compareEffective === 'step' ? selected.parentVersionId : nowRow.versionId}
					compare={compareEffective}
					author={selected.author}
					nowVersionId={nowRow.versionId}
					nowHash={nowRow.hash}
					label={selectedTitle}
					changeCursor={changeCursor}
					onState={handlePreviewState}
				/>
			</div>
		{/key}
	{/if}
{/snippet}

{#snippet railPane()}
	<MomentRail
		bind:this={rail}
		{groups}
		{selectedKey}
		{ctx}
		artifactKind={kind}
		{listLabel}
		{currentUser}
		{filter}
		showFilter={hasNamed}
		{older}
		{loadingOlder}
		help={help}
		{chatVersionIds}
		onSelect={select}
		onActivate={activate}
		onFilter={chooseFilter}
		onOlder={loadOlder}
		{onReview}
		{onFromChat}
		onDismissHelp={handleDismissHelp}
	/>
	{#if oneVersion}
		<p class="one-version">{$t('artifacts.history.oneVersion')}</p>
	{/if}
{/snippet}

{#snippet pushHeader()}
	<div class="push-head">
		<button type="button" class="back" onclick={backToList}>
			<ChevronLeft size={16} strokeWidth={2.2} aria-hidden="true" />
			{$t('artifacts.history.back')}
		</button>
		<span class="grow"></span>
		{#if isPhone}
			<!-- A phone's stepper is the bottom bar's; the top bar says which moment this is. -->
			{#if selected}
				<span class="push-when">{capitalize(whenLabel(selected.at, ctx))}</span>
			{/if}
		{:else}
			<span class="moment-stepper">
				<button
					type="button"
					class="step"
					data-testid="history-prev-moment"
					aria-label={$t('artifacts.history.momentPrev')}
					disabled={!hasOlderEntry}
					onclick={() => stepMoment('older')}
				>
					<ChevronLeft size={16} strokeWidth={2.2} aria-hidden="true" />
				</button>
				<button
					type="button"
					class="step"
					data-testid="history-next-moment"
					aria-label={$t('artifacts.history.momentNext')}
					disabled={!hasNewerEntry}
					onclick={() => stepMoment('newer')}
				>
					<ChevronRight size={16} strokeWidth={2.2} aria-hidden="true" />
				</button>
			</span>
		{/if}
	</div>
{/snippet}

{#snippet states()}
	{#if status === 'loading'}
		<div class="skeleton" aria-busy="true" data-testid="history-loading">
			<span class="sk"></span>
			<span class="sk short"></span>
			<span class="sk"></span>
		</div>
	{:else if status === 'error'}
		<div class="state" role="alert">
			<span>{$t('artifacts.history.loadError')}</span>
			<button type="button" class="btn-secondary btn-sm" onclick={load}>
				{$t('common.retry')}
			</button>
		</div>
	{:else if status === 'deleted'}
		<div class="state" data-testid="history-deleted">
			{$t(`artifacts.history.deleted.${kind}` as I18nKey)}
		</div>
	{/if}
{/snippet}

{#snippet toastView()}
	{#if toast}
		<div class="toast" role="status" data-testid="history-toast" transition:toastFly={{ y: 8, duration: MOTION_DURATION.standard, easing: cubicOut }}>
			<span class="toast-message">{toast.message}</span>
			{#if toast.undo}
				<button type="button" class="toast-undo" data-testid="history-toast-undo" onclick={undoRestore}>
					{$t('artifacts.history.undo')}
				</button>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet content()}
	{#if status !== 'ready'}
		{@render states()}
	{:else if layout === 'wide'}
		<!-- The rail comes first in the document (tab order: rail, then the preview's
		     toolbar, then its text; a screen reader meets the list before what it shows)
		     and sits on the right by `order`, where the comment column lives. -->
		<div class="split">
			<div class="rail-pane" in:railFly={{ x: 24, duration: MOTION_DURATION.emphasis, easing: cubicOut }}>
				{@render railPane()}
			</div>
			<div class="preview-pane">
				{@render toolbar()}
				{@render previewBody()}
			</div>
		</div>
	{:else if view === 'list'}
		<div class="list-pane">
			{@render railPane()}
		</div>
	{:else}
		<div class="push-pane">
			{@render pushHeader()}
			{@render toolbar()}
			{@render previewBody()}
		</div>
	{/if}
{/snippet}

<div class="live" aria-live="polite" aria-atomic="true" data-testid="artifact-history-live">{live}</div>

{#if isPhone}
	<DialogShell
		title={$t('artifacts.history.title')}
		titleVisuallyHidden
		phonePresentation="fullSheet"
		zIndexClass="z-[150]"
		onClose={handleSheetClose}
	>
		<div class="sheet" data-testid="artifact-history" data-layout="phone">
			<div class="sheet-head" aria-hidden="true">
				<span class="sheet-title">{$t('artifacts.history.title')}</span>
			</div>
			{@render content()}
			{@render toastView()}
		</div>
		{#snippet footer()}
			{#if view === 'preview' && selected && restoreOpen && restoreLines}
				<div class="bar-question" role="group" aria-label={$t('artifacts.history.restore')} data-testid="history-restore-question">
					{#each restoreLines as line, index (index)}
						<p class="bar-question-line" class:bar-question-main={index === 0}>{line}</p>
					{/each}
					{#if restoreProblem}
						<p class="bar-question-problem" role="alert">{restoreProblem}</p>
					{/if}
					<div class="bar-question-actions">
						<button type="button" class="btn-ghost" data-testid="history-restore-cancel" disabled={restoring} onclick={cancelRestore}>
							{$t('common.cancel')}
						</button>
						<button type="button" class="btn-primary" data-testid="history-restore-confirm" disabled={restoring} onclick={confirmRestore} {@attach focusOnMount}>
							<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							{$t('artifacts.history.restore')}
						</button>
					</div>
				</div>
			{:else if view === 'preview' && selected}
				<div class="bottom-bar">
					<button
						type="button"
						class="bar-step"
						aria-label={$t('artifacts.history.momentPrev')}
						disabled={!hasOlderEntry}
						onclick={() => stepMoment('older')}
					>
						<ChevronLeft size={18} strokeWidth={2.2} aria-hidden="true" />
					</button>
					<button
						type="button"
						class="bar-step"
						aria-label={$t('artifacts.history.momentNext')}
						disabled={!hasNewerEntry}
						onclick={() => stepMoment('newer')}
					>
						<ChevronRight size={18} strokeWidth={2.2} aria-hidden="true" />
					</button>
					<span class="grow"></span>
					{#if canRestore}
						<button type="button" class="bar-restore" data-testid="history-restore" onclick={askRestore}>
							<RotateCcw size={16} strokeWidth={2} aria-hidden="true" />
							{$t('artifacts.history.restore')}
						</button>
					{:else if restoreDisabledReason}
						<span class="same-note">{restoreDisabledReason}</span>
					{:else if selected.isNewest}
						<span class="same-note">{$t('artifacts.history.nowLine')}</span>
					{:else if selected.sameAsNow}
						<span class="same-note">{$t('artifacts.history.sameAsNow')}</span>
					{/if}
				</div>
			{/if}
		{/snippet}
	</DialogShell>
{:else}
	<!-- The region answers the shortcuts of the composite widget inside it
	     (Escape leaves History, ⌥↓/⌥↑ step the preview's changes): keys that
	     bubble up from the rail's options and the preview, never from the page. -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<section
		bind:clientWidth={rootWidth}
		class="history"
		aria-label={regionLabel}
		data-testid="artifact-history"
		data-layout={layout}
		onkeydown={handleRootKeydown}
	>
		{@render content()}
		{@render toastView()}
	</section>
{/if}

<style>
	.live {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.history {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		background: var(--surface-page);
	}

	.split {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
	}

	.preview-pane {
		order: 1;
		display: flex;
		flex: 1 1 0;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	/* A flex item's automatic minimum is its content's: a rail row whose detail
	   line does not wrap would stretch the pane past 300 px and squeeze the preview.
	   The pane is exactly 300 px and clips what does not fit (the rows ellipsise). */
	.rail-pane {
		order: 2;
		display: flex;
		flex: 0 0 300px;
		flex-direction: column;
		width: 300px;
		min-width: 0;
		overflow: hidden;
		min-height: 0;
		border-left: 1px solid var(--border-default);
		background: var(--surface-page);
	}

	.list-pane,
	.push-pane {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}

	.preview-fade {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
	}

	.push-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem 0;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.125rem;
		height: 1.75rem;
		padding: 0 0.5rem 0 0.25rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 700;
		cursor: pointer;
	}

	.back:hover {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.back:focus-visible,
	.step:focus-visible,
	.bar-step:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.grow {
		flex: 1 1 auto;
	}

	.moment-stepper {
		display: inline-flex;
		gap: 0.125rem;
	}

	.push-when {
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.step,
	.bar-step {
		display: inline-grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.step:disabled,
	.bar-step:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.step:hover:not(:disabled),
	.bar-step:hover:not(:disabled) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.sheet {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
	}

	.sheet-head {
		padding: 0 0 0.25rem;
	}

	.sheet-title {
		color: var(--text-primary);
		font-size: 1.125rem;
		font-weight: 600;
	}

	.one-version {
		margin: 0;
		padding: 0.75rem 1rem 1rem;
		color: var(--text-muted);
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.bottom-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
	}

	.bar-step {
		width: 2.75rem;
		height: 2.75rem;
	}

	.bar-restore {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-height: 2.75rem;
		padding: 0 1rem;
		border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		color: var(--accent-text);
		font-family: var(--font-sans);
		font-size: 0.875rem;
		font-weight: 700;
		cursor: pointer;
	}

	.same-note {
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.bar-question {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		width: 100%;
		padding: 0.75rem;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
		border-radius: var(--radius-md);
		background: var(--accent-tint);
	}

	.bar-question-line {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.8125rem;
		line-height: 1.4;
	}

	.bar-question-main {
		color: var(--text-primary);
		font-weight: 600;
	}

	.bar-question-problem {
		margin: 0;
		color: var(--danger);
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.bar-question-actions {
		display: flex;
		gap: 0.5rem;
	}

	.bar-question-actions :global(button) {
		display: inline-flex;
		flex: 1 1 0;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		min-height: 2.75rem;
	}

	/* The restore toast stands at the foot of the panel, never over the header's
	   actions (versioning.md §5.5; the redesign's #33). */
	.toast {
		position: absolute;
		left: 50%;
		bottom: 1rem;
		z-index: 5;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		max-width: calc(100% - 2rem);
		transform: translateX(-50%);
		padding: 0.5rem 0.75rem 0.5rem 1rem;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-elevated);
		box-shadow: 0 6px 24px color-mix(in srgb, var(--text-primary) 16%, transparent);
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.toast-message {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.toast-undo {
		flex-shrink: 0;
		min-height: 2rem;
		padding: 0 0.75rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--accent-text);
		font-family: var(--font-sans);
		font-size: 0.8125rem;
		font-weight: 800;
		cursor: pointer;
	}

	.toast-undo:hover {
		background: var(--accent-tint);
	}

	.toast-undo:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--focus-ring);
	}

	.state,
	.skeleton {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 0.625rem;
		padding: 1.25rem 1rem;
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.state {
		align-items: flex-start;
	}

	.sk {
		height: 0.875rem;
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
	}

	.sk.short {
		width: 55%;
	}

	@media (max-width: 639px) {
		.step {
			width: 2.75rem;
			height: 2.75rem;
		}

		.back {
			min-height: 2.75rem;
		}
	}
</style>
