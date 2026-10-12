<script lang="ts">
import { type Component, tick, untrack } from "svelte";
import { browser } from "$app/environment";
import { determinePreviewFileType } from "$lib/utils/file-preview";
import {
	computeSideBySideDiff,
	summarizeTextComparison,
} from "$lib/utils/text-compare";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import { handleDownloadAnchorClick } from "$lib/client/downloads";
import { dockedPanelWidth, dockedWidthCss } from "$lib/client/workspace-dock";
import { t, type I18nKey } from "$lib/i18n";
import { formatRelativeTime } from "$lib/utils/time";
import {
	MOTION_DURATION,
	MOTION_EASING,
	prefersReducedMotion,
	reducedMotionAnimate,
	reducedMotionAware,
} from "$lib/utils/motion";
import { fade } from "svelte/transition";
import {
	getArtifactTour,
	keepArtifactToursFor,
	markArtifactTourSeen,
	peekArtifactTour,
	refreshArtifactTour,
} from "$lib/client/api/artifact-tours";
import { ApiError } from "$lib/client/api/http";
import { fetchDocumentPreviewText } from "$lib/client/api/knowledge";
import {
	deregisterDialog,
	hasOpenDialog,
	isTopmostDialog,
	registerDialog,
} from "$lib/components/ui/DialogShell.svelte";
import { focusTrap } from "$lib/utils/focus-trap";
import OpenDocumentsRail from "./OpenDocumentsRail.svelte";
import MobileDocumentsSheet from "./MobileDocumentsSheet.svelte";
import ArtifactCard from "$lib/components/artifacts/ArtifactCard.svelte";
import ArtifactDeletePopover from "$lib/components/artifacts/ArtifactDeletePopover.svelte";
import ArtifactPanelHeader from "$lib/components/artifacts/ArtifactPanelHeader.svelte";
import { kindHasHistory } from "$lib/components/artifacts/history/history-previews";
import {
	type ArtifactTourCard,
	loadedTourCard,
	loadTourCard,
} from "$lib/components/artifacts/tour/tour-card";
import { latestMomentPhrase } from "$lib/components/artifacts/history/moment-phrase";
import {
	fileFacts,
	isShared,
	rowMadeAtLabel,
	sharedNames,
} from "$lib/components/artifacts/row-facts";
import { uiLanguage } from "$lib/stores/settings";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";
import {
	isShippedArtifactTourType,
	type LocalizedText,
	type ResolvedArtifactTour,
	type ShippedArtifactTourType,
} from "$lib/shared/artifacts/tours";
import {
	ARTIFACT_BODIES,
	type ArtifactBodyLoader,
	type ArtifactPanelBodyActions,
	type ArtifactBodyProps,
} from "$lib/components/artifacts/artifact-bodies";
import type { DocumentAlfyActivity } from "$lib/components/artifacts/document/alfy-activity";
import { documentArtifactCardViewFromPreview } from "$lib/components/artifacts/document/card-view";
import type { ArtifactCardView } from "$lib/components/artifacts/ArtifactCard.svelte";
import {
	ArrowUpRight,
	List,
	Download,
	FileText,
	Maximize2,
	Minimize2,
	MessageSquareText,
	X,
	Sparkles,
	ArrowLeftRight,
	Link,
	LayoutGrid,
	History,
	MoreHorizontal,
	Trash2,
} from "@lucide/svelte";

type DocumentPreviewRendererModule =
	typeof import("$lib/components/document-workspace/DocumentPreviewRenderer.svelte");

type WorkspaceDocument = DocumentWorkspaceItem & {
	currentPage?: number;
	totalPages?: number;
};

/** The panel's list view ("what this chat made"). Absent = the list is never shown. */
type WorkspaceList = {
	open: boolean;
	items: DocumentWorkspaceItem[];
	title?: string;
	/** Items being made again right now (Regenerate on a deleted card): rows that say so until the item exists (FB-5, F29). */
	pending?: ReadonlyArray<{ id: string; kind: ArtifactKind; title: string }>;
} | null;

let {
	open = false,
	presentation = "docked",
	returnToDockedOnExpandedClose = true,
	showPresentationToggle = true,
	reserveDock = false,
	onDockPreferredChange = undefined,
	documents = [],
	availableDocuments = [],
	activeDocumentId = null,
	conversationId = null,
	incognito = false,
	alfyActivity = null,
	list = null,
	onToggleDocumentTask = undefined,
	onSelectDocument,
	onOpenDocument = undefined,
	onJumpToSource = undefined,
	onCloseDocument,
	onCloseWorkspace,
	onPresentationChange = undefined,
	onListOpenChange = undefined,
	onPendingReviewCountChange = undefined,
	onDeleteArtifact = undefined,
	onFlushReady = undefined,
	artifactVersionMessages = undefined,
	onShowChatMessage = undefined,
	currentUser = null,
	overDialog = false,
}: {
	open?: boolean;
	presentation?: "docked" | "expanded";
	returnToDockedOnExpandedClose?: boolean;
	showPresentationToggle?: boolean;
	/**
	 * The host lays the panel out beside its content in a flex row (the chat
	 * page's stage): the expanded panel then leaves the column it docked in
	 * standing empty, so the content beside it keeps its width while the panel
	 * floats over it, and goes back to it when the panel docks again (FB-3, F26).
	 */
	reserveDock?: boolean;
	/** The width the docked panel asks for, whenever it changes (the reader drags its edge, a stored width is read): the host decides from it whether the chat beside it still has its room. */
	onDockPreferredChange?: ((width: number) => void) | undefined;
	documents?: DocumentWorkspaceItem[];
	availableDocuments?: DocumentWorkspaceItem[];
	activeDocumentId?: string | null;
	/** The conversation this panel is showing, so artifact bodies can resolve an incognito conversation's own artifacts. Null outside a conversation. */
	conversationId?: string | null;
	/**
	 * The chat this panel shows is incognito. An incognito chat promises no
	 * writes and leaves no trace (ruling 33), so the first-open tours make no
	 * request at all there: no GET, no seen write, no replay row.
	 */
	incognito?: boolean;
	/** T8 live: the chat page's own view of the latest Alfy tool-call activity, forwarded to whichever body is open. Only the Document body reads it. */
	alfyActivity?: DocumentAlfyActivity | null;
	list?: WorkspaceList;
	/** T9.7: the panel list's own tick — fires with the artifact id, the block id, and the NEW checked state. Absent list items simply show no checkbox row that can be ticked (there is nothing to write through). */
	onToggleDocumentTask?:
		| ((artifactId: string, blockId: string, checked: boolean) => void)
		| undefined;
	onSelectDocument: (documentId: string) => void;
	onOpenDocument?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onJumpToSource?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onCloseDocument: (documentId: string) => void;
	onCloseWorkspace: () => void;
	onPresentationChange?:
		| ((presentation: "docked" | "expanded") => void)
		| undefined;
	onListOpenChange?: ((open: boolean) => void) | undefined;
	/**
	 * Wave 2.5 review (F1): bubbles the open Document body's own live
	 * `onPendingReviewCountChange` report (see `ArtifactBodyProps`'s doc
	 * comment) up to the page, keyed by artifact id — so the page can patch
	 * its own persisted `artifacts` list the same way `onToggleDocumentTask`'s
	 * caller already does, and every reader of that list (the chat card, this
	 * panel's own list row, the count-button dot) updates together. `undefined`
	 * for a caller that has not wired durable review state yet.
	 */
	onPendingReviewCountChange?:
		| ((artifactId: string, count: number) => void)
		| undefined;
	/**
	 * Polish G2-A: deletes an item for good — the page's own call (it owns the
	 * conversation and what a deletion changes), which rejects when the item is
	 * still there. Its presence is what turns Delete on: the header's trash
	 * button for whatever is open, and an overflow on each list row. A host that
	 * passes nothing (the Knowledge page, which has its own Delete) shows none.
	 */
	onDeleteArtifact?:
		| ((item: DocumentWorkspaceItem) => Promise<void>)
		| undefined;
	/**
	 * Hands the page the open body's way of saving what it has not saved yet
	 * (`ArtifactPanelBodyActions.flush`), or null while the open item has none
	 * (nothing open, the list, a body that keeps nothing back). The page awaits it
	 * before a chat turn starts, so a turn that makes Alfy change the open board
	 * finds the reader's last step already saved.
	 */
	onFlushReady?: ((flush: (() => Promise<void>) | null) => void) | undefined;
	/**
	 * Which loaded chat message made which version of which item (artifact id →
	 * version id → message id), for History's "From the chat" (ruling 76). Only a
	 * version a message of THIS chat made has a link; absent for a host with no chat
	 * (the Knowledge page).
	 */
	artifactVersionMessages?:
		| ReadonlyMap<string, ReadonlyMap<string, string>>
		| undefined;
	/** Scrolls the chat to a message and flashes it ("From the chat"); the page closes this panel first where it covers the chat (a phone). */
	onShowChatMessage?: ((messageId: string) => void) | undefined;
	/** rd/review-2-5.md:272-275: forwarded straight through to whichever body is open — see `ArtifactBodyProps.currentUser`'s own doc comment. */
	currentUser?: {
		id: string;
		displayName: string;
		profilePicture: string | null;
	} | null;
	/**
	 * The panel is shown above a dialog (a project's Files dialog opens a made
	 * item in it), so while it is open it is a layer of the one dialog stack,
	 * above that dialog: Tab stays inside the panel, and one Escape closes the
	 * panel and not the dialog under it, which is the topmost layer again once
	 * the panel is gone. It is also the one modal layer to assistive technology
	 * (`role="dialog"`, `aria-modal`, named as the landmark was): the panel stays
	 * where its page put it, so it is not later in the document than the dialog,
	 * and the host passes `covered` to that dialog so it gives the claim up. A host
	 * with nothing beneath leaves it off, and the panel answers Escape from the
	 * window handler below as it always did.
	 */
	overDialog?: boolean;
} = $props();

// Fade animation state
let isVisible = $state(false);
let shouldRender = $state(false);
let closeAnimationTimer: ReturnType<typeof setTimeout> | null = null;
// list.open can show the shell with zero open tabs: the count button opens
// straight onto "what this chat made" even before anything has been opened
// in this session.
let shouldShowWorkspaceShell = $derived(
	open && (documents.length > 0 || Boolean(list?.open)),
);

let liveActiveDocument: WorkspaceDocument | null = $derived.by(() => {
	if (documents.length === 0 && availableDocuments.length === 0) return null;
	return (
		documents.find((document) => document.id === activeDocumentId) ??
		availableDocuments.find((document) => document.id === activeDocumentId) ??
		documents[0] ??
		null
	);
});
/**
 * The column is taken out of the page when it has finished shrinking, not when
 * the page stops asking for it (closing the last item empties `documents` at
 * once): the item it showed is held until then, so what leaves is seen leaving
 * and not cut away from under its own exit (FB-3, F4).
 */
let lastShownDocument: WorkspaceDocument | null = null;
$effect.pre(() => {
	if (liveActiveDocument) lastShownDocument = liveActiveDocument;
});
let activeDocument: WorkspaceDocument | null = $derived(
	liveActiveDocument ??
		(shouldRender && !shouldShowWorkspaceShell ? lastShownDocument : null),
);
/** What the panel showed when it was last asked for: the list, or an item. A column on its way out keeps showing it. */
let lastShownList = false;
$effect.pre(() => {
	if (shouldShowWorkspaceShell) lastShownList = Boolean(list?.open);
});
let renderListShell = $derived(
	shouldRender &&
		(shouldShowWorkspaceShell ? Boolean(list?.open) : lastShownList),
);
/** The shape the panel had when it was last asked for: a closing close X (the page docks it in the same breath) is not seen turning into a column first. */
let lastShownPresentation: "docked" | "expanded" = untrack(() => presentation);
$effect.pre(() => {
	if (shouldShowWorkspaceShell) lastShownPresentation = presentation;
});
let shellPresentation = $derived(
	shouldShowWorkspaceShell ? presentation : lastShownPresentation,
);
/** The column an expanded panel leaves standing (`reserveDock`), which the chat beside it keeps its width by. */
let dockSpacerElement: HTMLElement | null = $state(null);

/**
 * Wave 2.5 review (F1): "double count from the card path". Opened straight
 * from the chat card AFTER an edit already settled while the panel was
 * closed, the body's own mount-time restore (`runLoad` → `restorePendingReview`,
 * keyed by block id) already reflects the just-landed change from the
 * PERSISTED state — handing it `alfyActivity` too (keyed by op id) made it
 * replay `landAlfyActivity` a second time for the same block, double-
 * counting it. Only a key this panel was ACTUALLY open on the matching
 * artifact for (at any point — including while it was still "running") is
 * safe to replay: the body was mounted throughout that activity's own
 * lifecycle, so `runLoad`'s restore ran BEFORE the change existed on the
 * server, and the live landing is the only thing that ever adds it. A key
 * never seen open stays suppressed for the body — even once the panel opens
 * later — so the persisted restore is left to own it alone, exactly as the
 * review's own fix note suggests ("let the server restore... own it").
 * `alfyActivity` itself (unsuppressed) still feeds the row-level ephemeral
 * pending pill below and the chat card, neither of which replay anything.
 *
 * Final polish D2: this set is a panel-level notion and outlives every body —
 * a body built later (the list and back, the panel closed and opened from the
 * card, another item and back) is handed the same settled activity. The
 * once-only rule therefore also lives in `DocumentBody.svelte`
 * (`settledActivityKeyAtMount`): a body applies live only what was still
 * running, or had not begun, when it mounted.
 *
 * rd/review-2-5.md fix agent C, round F2: an `open`-only check is not
 * enough, because `open` and `activeDocumentId` can both become true in the
 * SAME render that first hands this effect an already-settled activity
 * (opening straight from the card sets both at once) — `open` alone cannot
 * tell "the panel was open while this activity was still happening" from
 * "the panel just opened, and happens to match a past activity that
 * finished while it was closed." Gating on `alfyActivity.status === "running"`
 * is not enough EITHER: a fake-provider (or simply fast) turn can settle
 * between one render and the next, so this effect's FIRST look at a brand
 * new key can just as easily already be "applied" for a document that WAS
 * genuinely open and watching the whole time — the two cases are
 * indistinguishable from the CURRENT render alone.
 *
 * The real distinguishing fact is history: was this specific key already
 * stale (or nonexistent) at the moment this document MOST RECENTLY started
 * being watched (the panel opening, or the active document switching to it
 * while already open)? `staleKeyWhenWatchStarted` captures exactly that,
 * once, right when watching starts — never re-armed while still watching,
 * so a key that only shows up LATER, while still watching, is always new
 * (and therefore safe) relative to it.
 */
let alfyActivitySeenOpenKeys = $state<Set<string>>(new Set());
let previousWatch: { open: boolean; artifactId: string | null } = {
	open: false,
	artifactId: null,
};
const staleKeyWhenWatchStarted = new Map<string, string | null>();
$effect(() => {
	const artifactId = activeDocument?.artifactId ?? activeDocument?.id ?? null;
	const watchStarted =
		open &&
		artifactId !== null &&
		(!previousWatch.open || previousWatch.artifactId !== artifactId);
	if (watchStarted && artifactId !== null) {
		staleKeyWhenWatchStarted.set(
			artifactId,
			alfyActivity?.artifactId === artifactId ? alfyActivity.key : null,
		);
	}
	previousWatch = { open, artifactId };

	if (!open || !alfyActivity) return;
	if (artifactId !== alfyActivity.artifactId) return;
	if (alfyActivitySeenOpenKeys.has(alfyActivity.key)) return;
	if (staleKeyWhenWatchStarted.get(artifactId) === alfyActivity.key) return;
	alfyActivitySeenOpenKeys = new Set(alfyActivitySeenOpenKeys).add(
		alfyActivity.key,
	);
});
let bodyAlfyActivity = $derived(
	alfyActivity && alfyActivitySeenOpenKeys.has(alfyActivity.key)
		? alfyActivity
		: null,
);

/**
 * Wave 2.5 review (F1): the one call this panel makes into the page's own
 * persisted-artifact-list plumbing, keyed by the SAME `artifactId` shape the
 * body invocations already resolve (`activeDocument.artifactId ??
 * activeDocument.id`) — see `onPendingReviewCountChange`'s own doc comment.
 */
function handleBodyPendingReviewCountChange(count: number): void {
	const artifactId = activeDocument?.artifactId ?? activeDocument?.id;
	if (!artifactId) return;
	onPendingReviewCountChange?.(artifactId, count);
}

// The type-aware content area (Slice 0 Task S5): a kind with a registered
// loader renders that body; a missing entry IS the File body, so every kind
// this slice ships (the registry is empty) falls straight through to the
// preview stack below, unchanged.
let activeArtifactKind: ArtifactKind = $derived(activeDocument?.kind ?? "file");
/**
 * The panel landmark's accessible name while an item is open: what it shows
 * ("Vienna trip plan, Document"), not one generic "Document workspace" for
 * every item (rd/review-2-5.md:276-279). The list state is named for its own
 * heading instead (see the two list landmarks below).
 */
let panelLandmarkLabel = $derived(
	activeDocument
		? $t("artifacts.panel.landmark", {
				title: getDocumentTitle(activeDocument),
				kind: $t(`artifacts.type.${activeArtifactKind}` as I18nKey),
			})
		: $t("documentWorkspace.documentWorkspace"),
);
// Ruling 76, amendment A1: the header says the item's latest moment ("Changed by
// Alfy · 12 min ago"), read through the same one source as the list rows and the
// chat card (`artifact-versions.ts`), never a number. The clock moves the words
// on while the panel stays open: "just now" must not stay true for an hour.
let momentClock = $state(Date.now());
$effect(() => {
	if (!browser || !activeDocument?.kind) return;
	const timer = setInterval(() => {
		momentClock = Date.now();
	}, 30_000);
	return () => clearInterval(timer);
});
let activeMomentPhrase = $derived.by(() => {
	momentClock;
	const item = activeDocument;
	if (!item?.kind || item.kind === "file") return null;
	const at = item.updatedAt && item.updatedAt > 0 ? item.updatedAt : null;
	const author = item.lastAuthor ?? null;
	const kind = item.lastKind ?? null;
	if (at === null && author === null && kind === null) return null;
	return latestMomentPhrase(activeArtifactKind, { author, kind, at }, $t);
});
// ---- History, a MODE of the panel (ruling 76, versioning.md §5.2) -------------
//
// Pressing the header's history button turns the open item's body into a
// read-only preview of one of its versions with a rail of moments beside it.
// The body stays mounted underneath (inert and out of sight, so the scroll and
// the selection the editor had are there when History is left); the mode is a
// slot over it. Entering History first has the body save what the reader typed
// that the autosave has not written yet (`ArtifactPanelBodyActions.flush`), so
// History starts from what is stored; leaving after a restore has the body load
// the stored item again (`reload`), so the next save is not refused as stale.
// The mode lives in one lazy chunk (`history/history-parts.ts`), loaded the
// first time it opens.
type HistoryPartsModule =
	typeof import("$lib/components/artifacts/history/history-parts");
let HistoryModeComponent = $state<HistoryPartsModule["HistoryMode"] | null>(
	null,
);
let historyOpen = $state(false);
let historyOpening = false;
/** A restore (or an Undo of one) changed what is stored while History was open. */
let historyChangedBody = false;
const historySlotFade = reducedMotionAware(fade);
/** How long the panel waits for the body's save before showing History anyway (it never waits for a connection to come back). */
const HISTORY_FLUSH_BUDGET_MS = 4000;

async function ensureHistoryMode(): Promise<void> {
	if (HistoryModeComponent) return;
	const module = await import(
		"$lib/components/artifacts/history/history-parts"
	);
	HistoryModeComponent = module.HistoryMode;
}

async function openHistory(): Promise<void> {
	if (historyOpening || historyOpen) return;
	if (!activeDocument || !kindHasHistory(activeArtifactKind)) return;
	historyOpening = true;
	try {
		const loading = ensureHistoryMode();
		const flush = bodyPanelActions?.flush;
		if (flush) {
			await Promise.race([
				flush().catch(() => undefined),
				new Promise<void>((resolve) =>
					setTimeout(resolve, HISTORY_FLUSH_BUDGET_MS),
				),
			]);
		}
		await loading;
		historyOpen = true;
	} finally {
		historyOpening = false;
	}
}

function focusHistoryButton(): void {
	const shell = shouldRenderMobilePreview
		? mobileShellElement
		: desktopShellElement;
	shell
		?.querySelector<HTMLElement>('[data-testid="artifact-history-button"]')
		?.focus();
}

function closeHistory(options: { restoreFocus?: boolean } = {}): void {
	if (!historyOpen) return;
	historyOpen = false;
	if (historyChangedBody) {
		historyChangedBody = false;
		bodyPanelActions?.reload?.();
	}
	if (options.restoreFocus !== false) void tick().then(focusHistoryButton);
}

function toggleHistory(): void {
	if (historyOpen) closeHistory();
	else void openHistory();
}

/** A restore (or the Undo of one) wrote a version: the open body loads what is stored when History is left. */
function handleHistoryRestored(): void {
	historyChangedBody = true;
}

/**
 * "From the chat" on an Alfy moment: scroll the chat to the message that made it
 * and flash it. Where this panel covers the chat (the phone/mobile shell) History
 * and the panel step aside first.
 */
function handleHistoryFromChat(messageId: string): void {
	if (!shouldRenderDesktopPreview) closeHistory({ restoreFocus: false });
	onShowChatMessage?.(messageId);
}

/** A waiting moment's "Review": leave History and step the review to that change. */
function handleHistoryReview(): void {
	closeHistory({ restoreFocus: false });
	void tick().then(() => bodyPanelActions?.reviewPending?.());
}

// Another item (or none) is a different panel: History belongs to the one it opened for.
$effect(() => {
	activeBodyKey;
	untrack(() => {
		historyOpen = false;
		historyChangedBody = false;
	});
});

let activeArtifactBodyLoader: ArtifactBodyLoader | undefined = $derived(
	ARTIFACT_BODIES[activeArtifactKind],
);

// Wave 2.5 Step 3 / final polish D1: what the open body hands the panel header.
// Its Versions/Download/Comments triggers (`ArtifactBodyProps.registerPanelActions`;
// App registers only Download, File no body at all — the header falls back to
// plain text / the panel's own generic download link), the Comments button's
// badge (`onCommentCountChange`, Document only) and whether the comments are
// showing (`onCommentsShownChange`, the button's pressed state).
//
// One record, stamped with the item its body was mounted for, and nothing ever
// clears it: it counts only while it names the item that is open now. A swap
// to another item — a second Document, an App, a file, the list and back —
// therefore reads as "nothing yet" until that item's own body reports, and the
// stale closures of a body that is gone can never be called. This replaces a
// reset-on-swap effect: the body registers ONCE, when it mounts, and that
// effect could run after the new body's registration in the very same flush
// and wipe it, leaving the header without its controls until a reload.
type BodyPanelReport = {
	key: string;
	actions: ArtifactPanelBodyActions | null;
	commentCount: number;
	commentsShown: boolean;
};
let bodyPanelReport = $state.raw<BodyPanelReport | null>(null);
// The ITEM, never the object: `activeDocument` is a new object whenever its
// version number (or any other field) moves, and a version change must neither
// remount the body (its undo history, caret and pending changes outlive a Keep)
// nor drop what it registered. `artifactId ?? id` is the id the body itself
// loads by, and the key each body mount below carries.
let activeBodyKey = $derived(
	activeDocument ? (activeDocument.artifactId ?? activeDocument.id) : null,
);
let openBodyPanel = $derived(
	bodyPanelReport !== null && bodyPanelReport.key === activeBodyKey
		? bodyPanelReport
		: null,
);
let bodyPanelActions = $derived(openBodyPanel?.actions ?? null);
$effect(() => {
	const flush = bodyPanelActions?.flush ?? null;
	untrack(() => onFlushReady?.(flush));
	return () => untrack(() => onFlushReady?.(null));
});
/** Wave 2.5 Step 8: the Comments button's own badge (Document only — every other kind never calls `onCommentCountChange`, so this just stays 0 and the button never renders for them). */
let documentOpenCommentCount = $derived(openBodyPanel?.commentCount ?? 0);
/** Whether the Document's comments are showing (the column beside the text, or the drawer/sheet) — the Comments button's pressed state. */
let documentCommentsShown = $derived(openBodyPanel?.commentsShown ?? false);

/**
 * What a mounted body reports to the header, filed under the item that is open.
 * A body only reports while it is the mounted one (each mount is keyed on its
 * item), so the open item is the item it reports for. Untracked as a whole: it
 * runs inside the body's own effects, which must not come to depend on the
 * record they write.
 */
function reportFromBody(patch: Partial<Omit<BodyPanelReport, "key">>): void {
	untrack(() => {
		const key = activeBodyKey;
		if (key === null) return;
		const current: BodyPanelReport =
			bodyPanelReport?.key === key
				? bodyPanelReport
				: { key, actions: null, commentCount: 0, commentsShown: false };
		bodyPanelReport = { ...current, ...patch };
	});
}
/**
 * A body asks the panel to open an item in its own viewer (a Canvas's File block
 * names a file): through the host's one open, the same the chat's cards use — never
 * a second viewer. A host that has no open (the Knowledge page) gives the body
 * nothing to call, so the block is a plain row there.
 */
function handleBodyOpenItem(item: DocumentWorkspaceItem): void {
	onOpenDocument?.(item);
}
// Only the open item's id: `activeDocument` itself is a new object whenever its
// version number (or any other field) moves — a confirm asked about one item
// must close for a DIFFERENT item, never for the same item's number changing.
let activeDocumentIdentity = $derived(activeDocument?.id);
$effect(() => {
	activeDocumentIdentity;
	deleteConfirmOpen = false;
});

// Polish G2-A (Delete): whether the header's confirm is open, and which list
// row's overflow is (one at a time — a row id, null when none).
let deleteConfirmOpen = $state(false);
let rowMenuOpenId = $state<string | null>(null);

/**
 * Whether an item can be deleted from here: the page can delete, it is one of
 * the family's own items (a produced file too — the family's delete takes it
 * through its own store), and this conversation made it. An item that says it
 * was made in another conversation (a fork's card naming its parent's
 * Document) has no Delete: the server would refuse it, and the panel does not
 * offer what will not work. An item that does not say where it was made has
 * nothing to contradict.
 */
function canDeleteItem(item: DocumentWorkspaceItem): boolean {
	if (!onDeleteArtifact || !item.artifactId || !item.kind) return false;
	return !(
		item.conversationId &&
		conversationId &&
		item.conversationId !== conversationId
	);
}

/**
 * Whether the chat can make this item again, read off the live list (the
 * server's word, kept fresh) rather than the open tab's snapshot: what the
 * Delete confirm may promise. An item the list does not know says nothing.
 */
function canRegenerateItem(item: DocumentWorkspaceItem): boolean {
	return (
		list?.items.some(
			(row) => row.artifactId === item.artifactId && row.canRegenerate === true,
		) ?? false
	);
}

/** After a delete the control that had focus is gone: land on the list's heading, which names where the user is. */
async function focusPanelListTitle(): Promise<void> {
	await tick();
	const shell = desktopShellElement ?? mobileShellElement;
	shell
		?.querySelector<HTMLElement>('[data-testid="artifact-panel-list-title"]')
		?.focus();
}

/** Header Delete, confirmed: the page deletes; then back to the list — or out of the panel when nothing is left to list. */
async function deleteOpenItem(item: DocumentWorkspaceItem): Promise<void> {
	await onDeleteArtifact?.(item);
	if ((list?.items.length ?? 0) > 0) {
		// The page has already turned to the list in the step that forgot the item
		// (F19); a host that has not is asked to.
		if (!list?.open) handleBackToList();
		void focusPanelListTitle();
		return;
	}
	onCloseWorkspace();
}

/** A list row's Delete, confirmed: back to the list's heading — or out of the panel when that was the last row, since an empty list is nothing to show. */
async function deleteFromList(item: DocumentWorkspaceItem): Promise<void> {
	await onDeleteArtifact?.(item);
	if ((list?.items.length ?? 0) === 0) {
		onCloseWorkspace();
		return;
	}
	await focusPanelListTitle();
}

// One cached module promise per kind, mirroring
// ensureDocumentPreviewRendererModule below: a loader runs at most once no
// matter how many times its body is shown.
const artifactBodyModulePromises = new Map<
	ArtifactKind,
	ReturnType<ArtifactBodyLoader>
>();

function ensureArtifactBodyModule(
	kind: ArtifactKind,
	loader: ArtifactBodyLoader,
): ReturnType<ArtifactBodyLoader> {
	let cached = artifactBodyModulePromises.get(kind);
	if (!cached) {
		cached = loader();
		artifactBodyModulePromises.set(kind, cached);
	}
	return cached;
}

/**
 * The body component each kind resolved to, once its module has loaded. The
 * body used to render inside `{#await ensureArtifactBodyModule(...)}`, and
 * Svelte's `{#await}` shows its pending state whenever its expression is
 * re-read and a `flushSync` (`tick()`) lands before the (already resolved)
 * promise answers — which tore the whole body down and built it again (editor,
 * caret, undo history, pending pills) after every Keep and any other flow that
 * awaited `tick()`. A resolved module in state renders through a plain `{#if}`:
 * nothing re-reads a promise, so the body outlives every re-render of the item.
 */
let loadedArtifactBodies = $state.raw<
	Partial<Record<ArtifactKind, Component<ArtifactBodyProps>>>
>({});
$effect(() => {
	const kind = activeArtifactKind;
	const loader = activeArtifactBodyLoader;
	if (!loader || loadedArtifactBodies[kind]) return;
	let cancelled = false;
	void ensureArtifactBodyModule(kind, loader).then((module) => {
		if (!cancelled) {
			loadedArtifactBodies = {
				...loadedArtifactBodies,
				[kind]: module.default,
			};
		}
	});
	return () => {
		cancelled = true;
	};
});
let compareMode = $state(false);
let mobileDocumentsSheetOpen = $state(false);
let compareDocumentId: string | null = $state(null);
let compareCurrentTextHtml: string | null = $state(null);
let compareOtherTextHtml: string | null = $state(null);
let compareSummary: ReturnType<typeof summarizeTextComparison> | null =
	$state(null);
let compareLoading = $state(false);
let compareError: string | null = $state(null);
let syncScrollEnabled = $state(false);
let expandedDownloadMenuOpen = $state(false);
let leftPanelBody: HTMLDivElement | null = $state(null);
let rightPanelBody: HTMLDivElement | null = $state(null);
let isSyncingScroll = false;
let documentPreviewRendererModulePromise: Promise<DocumentPreviewRendererModule> | null =
	null;
let desktopShellElement: HTMLElement | null = $state(null);
let mobileShellElement: HTMLElement | null = $state(null);
/**
 * The desktop shell's own content (everything below its header-or-list-head
 * — the two mutually exclusive `{#if list?.open}`/`{:else if …}` branches
 * each wrap their body in this same class/ref), so the panel's OPEN/CLOSE
 * and list↔item PUSH motion (redesign §7.2 #1–#4) can animate content
 * separately from the shell's own width (a plain CSS transition — see
 * `.workspace-shell-desktop`). Rebinds to a NEW element every time the
 * branch swaps (list → item or back), which is exactly the hook
 * `desktopContentEntranceEffect` below needs: Svelte destroys the outgoing
 * branch and mounts the incoming one in one synchronous update, so there is
 * no element to play an "exit" animation on by the time this ref changes —
 * only an entrance on whatever just arrived.
 */
let desktopContentElement: HTMLElement | null = $state(null);
/** What the NEXT `desktopContentElement` mount should play — set just before the state change that will cause it (`handleBackToList`), or by the list-closing effect below, per §7.2 rows #1/#3/#4. Panel-open default: content arrives from the right on the column's own curve and duration, so it is never an empty column while the chat has already made room (FB-3: it used to start 60 ms after the panel). */
let pendingEntrance: { direction: "left" | "right"; delay: number } = {
	direction: "right",
	delay: 0,
};

// Page navigation state
let currentPage = $state(1);
let currentTotalPages = $state(1);
let lastDocumentId: string | null = $state(null);

// Resize state
let isResizing = $state(false);
let resizeStartX = $state(0);
let resizeStartWidth = $state(950);
const DEFAULT_WORKSPACE_WIDTH = 950;
const MIN_WIDTH = 620;
const MAX_WIDTH_RATIO = 0.68;
const LEGACY_NARROW_WIDTH_THRESHOLD = 700;
const WORKSPACE_WIDTH_STORAGE_KEY = "document-workspace-width";
// NOTE(ADR 0043 slice 0): intentionally kept separate from the shared
// $lib/utils/viewport.svelte helper. This query selects the *document preview
// renderer surface* (desktop vs mobile rendering of an embedded document), not
// the app-wide viewport tier, and its 768px threshold is a renderer-specific
// concern. Do not consolidate without a separate affordance review.
const DESKTOP_PREVIEW_MEDIA_QUERY = "(min-width: 768px)";

let workspaceWidth = $state(getInitialWorkspaceWidth());
let previewRendererSurface: "desktop" | "mobile" = $state(
	getInitialPreviewRendererSurface(),
);
let shouldRenderMobilePreview = $derived(previewRendererSurface === "mobile");
let shouldRenderDesktopPreview = $derived(previewRendererSurface === "desktop");

// ---- First-open tours (Feature 2 · Slice 6; rulings 4, 32, 33, 69) ----
//
// The first time a user opens a Document, App or Canvas the panel shows a
// three-slide card about that kind, above the item, in the panel's flow: it
// makes room for itself and covers nothing (ruling 77, FX-2). Which kinds have a
// tour is the shared list (`isShippedArtifactTourType`: File and Slides never
// ask), and an incognito chat asks for none: no request at all, the seen state
// being a write. The card and its illustrations are one lazy chunk
// (`tour/tour-card.ts`), imported only once a tour is about to show, so the chat
// shell never carries them.
//
// WHEN the card arrives is what keeps it from moving the item. The answer and the
// card are asked for as soon as the chat has an item of a kind (`warmTours`), so
// they are in hand before the reader reaches for the item, and the card is decided
// in the flush that opens it (`$effect.pre`, before the body mounts): it is in the
// page in the item's first frame and nothing moves. An answer that is late (the
// first ask is still on the wire, a replay, a copy that changed under the reader)
// arrives with the card's own short height transition instead.
//
// What the reader did is written when they finish ("Got it") or Skip, never when
// the card renders: closing the panel mid-tour writes nothing and the card is
// met again. A replay (the list row menu, a body's empty-state link) shows the
// same card and records nothing.

type TourView = {
	/** The open item the card is about (`activeBodyKey`): a card never outlives its item. */
	itemKey: string;
	kind: ShippedArtifactTourType;
	tour: ResolvedArtifactTour;
	replay: boolean;
	Card: ArtifactTourCard;
	/** `none`: the answer and the card were in hand when the item opened, so the card is there from its first frame. `reveal`: a late answer, which grows in as a height. */
	entrance: "none" | "reveal";
};

/** The tour a kind of item has, or null: not a kind that ships one, or an incognito chat. */
function tourKindOf(
	kind: ArtifactKind | undefined,
): ShippedArtifactTourType | null {
	return !incognito && isShippedArtifactTourType(kind) ? kind : null;
}

/** The open item's tour kind, only while the panel is showing that item (not its list, not closed). */
let tourItemKind = $derived(
	shouldShowWorkspaceShell && !list?.open && activeDocument
		? tourKindOf(activeDocument.kind)
		: null,
);
let tourItemKey = $derived(tourItemKind ? activeBodyKey : null);
let tourView = $state.raw<TourView | null>(null);
/**
 * The open item's tour summary, from the same answer that decides the card. It
 * is kept whether or not the card shows (a reader who has seen the tour still
 * meets an empty body, which says it) and handed to the body as
 * `tourSummary`; never read for another item than the one it names.
 */
let tourSummary = $state.raw<{
	itemKey: string;
	summary: LocalizedText;
} | null>(null);
let bodyTourSummary = $derived(
	tourSummary && tourSummary.itemKey === activeBodyKey
		? tourSummary.summary
		: null,
);
/** The item whose tour the list's menu asked to replay: read once, when that item becomes the open one. */
let pendingTourReplayKey: string | null = null;

/**
 * Decides the open item's card. When this page load already has the kind's answer
 * and the card is in hand, it is decided right here, synchronously, and the card
 * is in the page with the item; otherwise it waits for the answer (a promise
 * returned) and the card grows in when it comes.
 */
function presentTour(
	kind: ShippedArtifactTourType,
	itemKey: string,
	replay: boolean,
	isStale: () => boolean,
): Promise<void> | undefined {
	// The page can change hands without being reloaded (login and logout are
	// client-side navigations): the answers it holds are this reader's.
	keepArtifactToursFor(currentUser?.id);
	// A replay asks again (it shows the copy as it is now).
	const known = replay ? undefined : peekArtifactTour(kind);
	if (known) {
		// A tour with no slides is nothing to show.
		const owed = known.tour.slides.length > 0 && !known.seen;
		const Card = owed ? loadedTourCard() : null;
		if (!owed || Card) {
			tourSummary = { itemKey, summary: known.tour.summary };
			if (owed && Card) {
				tourView = {
					itemKey,
					kind,
					tour: known.tour,
					replay: false,
					Card,
					entrance: "none",
				};
			}
			return undefined;
		}
	}
	return presentTourWhenAnswered(kind, itemKey, replay, isStale);
}

async function presentTourWhenAnswered(
	kind: ShippedArtifactTourType,
	itemKey: string,
	replay: boolean,
	isStale: () => boolean,
): Promise<void> {
	try {
		// An open takes the answer this page load already has (or is waiting for),
		// which is why a second item of a kind costs no request.
		const answer = await (replay
			? refreshArtifactTour(kind)
			: getArtifactTour(kind));
		if (isStale()) return;
		tourSummary = { itemKey, summary: answer.tour.summary };
		// A tour with no slides is nothing to show.
		if (answer.tour.slides.length === 0) return;
		if (answer.seen && !replay) return;
		const Card = await loadTourCard();
		if (isStale()) return;
		tourView = {
			itemKey,
			kind,
			tour: answer.tour,
			replay,
			Card,
			entrance: "reveal",
		};
	} catch (error) {
		// The tour is decoration: its absence must not read as breakage.
		console.warn("[ARTIFACT_TOUR] The introduction could not be shown.", error);
	}
}

// Before the DOM is updated, so that the item's body mounts under a card that is
// already in the page: a body that measured its pane first and was narrowed by a
// card a moment later is the move this exists to prevent.
$effect.pre(() => {
	const kind = tourItemKind;
	const key = tourItemKey;
	if (kind === null || key === null) return;
	const replay = pendingTourReplayKey === key;
	pendingTourReplayKey = null;
	let stale = false;
	untrack(() => void presentTour(kind, key, replay, () => stale));
	return () => {
		stale = true;
		tourView = null;
		tourSummary = null;
	};
});

/** The kinds of the chat's items that have a tour, as one stable string: the effect below runs when the set changes, not whenever the list's object is rebuilt. */
let tourKindsInChat = $derived.by(() => {
	if (incognito) return "";
	const kinds = new Set<ShippedArtifactTourType>();
	for (const item of list?.items ?? []) {
		const kind = tourKindOf(item.kind);
		if (kind) kinds.add(kind);
	}
	return [...kinds].sort().join(",");
});

/**
 * Asks for the tour of every kind the chat has an item of, and brings the card in
 * if the reader owes one, so both are in hand when an item opens (see the header).
 * The cache shares the ask with the open that follows, so nothing is asked twice;
 * a failure is left to the open's own ask.
 */
async function warmTours(kinds: ShippedArtifactTourType[]): Promise<void> {
	keepArtifactToursFor(currentUser?.id);
	await Promise.all(
		kinds.map(async (kind) => {
			try {
				const answer = await getArtifactTour(kind);
				if (answer.tour.slides.length > 0 && !answer.seen) await loadTourCard();
			} catch {
				// Asked again, and reported, when an item of the kind opens.
			}
		}),
	);
}

$effect(() => {
	const kinds = tourKindsInChat;
	if (kinds === "") return;
	untrack(() => void warmTours(kinds.split(",") as ShippedArtifactTourType[]));
});

/** Writes what the reader did, and reads a 409 (the copy was replaced while they read) as "show the new one from its first slide". */
async function recordTour(
	view: TourView,
	status: "completed" | "dismissed",
	lastSlide: number,
): Promise<void> {
	try {
		await markArtifactTourSeen(view.kind, {
			contentKey: view.tour.contentKey,
			status,
			lastSlide,
		});
	} catch (error) {
		if (error instanceof ApiError && error.status === 409) {
			const key = view.itemKey;
			if (tourItemKey === key) {
				await presentTour(view.kind, key, false, () => tourItemKey !== key);
			}
			return;
		}
		console.warn(
			"[ARTIFACT_TOUR] The introduction could not be recorded.",
			error,
		);
	}
}

function handleTourSeen(lastSlide: number): void {
	const view = tourView;
	tourView = null;
	if (view && !view.replay) void recordTour(view, "completed", lastSlide);
}

function handleTourDismiss(slide: number): void {
	const view = tourView;
	tourView = null;
	if (view && !view.replay) void recordTour(view, "dismissed", slide);
}

/** A replay's only way out: nothing was recorded, so nothing is. */
function handleTourClose(): void {
	tourView = null;
}

/** What a body is handed as `onReplayTour`: the way to see the tour again, except while a card is up (an empty state's link to it would offer what is on screen). */
let bodyReplayTour = $derived(
	tourItemKind && !(tourView && tourView.itemKey === activeBodyKey)
		? replayOpenItemTour
		: undefined,
);

/** Shows the open item's tour again, whether or not it was seen. Handed to bodies as `onReplayTour` (their empty states link to it). */
function replayOpenItemTour(): void {
	const kind = tourItemKind;
	const key = tourItemKey;
	if (kind === null || key === null) return;
	void presentTour(kind, key, true, () => tourItemKey !== key);
}

/** The list row menu's "How this kind works": open the item, and show its tour once it is the open one. */
function replayTourFromList(item: DocumentWorkspaceItem): void {
	rowMenuOpenId = null;
	pendingTourReplayKey = item.artifactId ?? item.id;
	selectFromList(item);
}

// Persist workspace width when it changes
$effect(() => {
	if (!browser) return;
	localStorage.setItem(WORKSPACE_WIDTH_STORAGE_KEY, String(workspaceWidth));
});

$effect(() => {
	onDockPreferredChange?.(workspaceWidth);
});

$effect(() => {
	if (activeDocument && activeDocument.id !== lastDocumentId) {
		lastDocumentId = activeDocument.id;
		currentPage = activeDocument.currentPage ?? 1;
		currentTotalPages = activeDocument.totalPages ?? 1;
		void focusPanelTitleOnOpen();
	}
});

/**
 * Redesign §5.4 (Wave 2.5 review F2): opening the panel on a specific item —
 * the first open, a list row click, or switching items via the count
 * button/card — did not move focus, so a screen-reader user got no
 * announcement of what just appeared. `tick()` waits for the branch swap
 * (list → item, or the initial closed → open mount) to actually land in the
 * DOM before querying for the title `ArtifactPanelHeader.svelte` renders
 * (`data-testid="artifact-panel-title"`, `tabindex="-1"` so it is a valid
 * programmatic focus target without joining the normal tab order). Queries
 * whichever shell (mobile or desktop) is currently mounted rather than
 * assuming one, since both bind their own ref and only one renders content
 * for the active viewport at a time.
 */
async function focusPanelTitleOnOpen(): Promise<void> {
	await tick();
	const shell = desktopShellElement ?? mobileShellElement;
	const title = shell?.querySelector<HTMLElement>(
		'[data-testid="artifact-panel-title"]',
	);
	title?.focus();
}

// ---- The dock: one column whose width the chat column follows (FB-3, F4) ----
//
// The docked panel is a flex item of the chat page's stage beside the chat
// column, which takes whatever it leaves. So the panel's WIDTH is the one thing
// that moves: it grows from 0 to its width on `--ease-emphasis` when it opens
// and shrinks on `--ease-in` when it closes (redesign §7.2 #1/#2), and the chat
// re-wraps in step with it, in the same frames. The width is CSS (see
// `dockedWidthCss`), so it follows the stage in the frame the stage changes.
//
// What the column holds is laid out at the width the column is growing to and
// shown through it from the right edge (`dockContentWidth`), so the editor, the
// board and the App are not re-flowed through every width on the way.

/** The row the docked panel shares with the chat column, measured for `dockContentWidth`. */
let dockStageWidth = $state(0);
let dockContentWidth = $derived(
	dockStageWidth > 0 ? dockedPanelWidth(workspaceWidth, dockStageWidth) : null,
);
$effect(() => {
	const stage = desktopShellElement?.parentElement;
	if (!browser || !stage || typeof ResizeObserver === "undefined") return;
	dockStageWidth = stage.clientWidth;
	const observer = new ResizeObserver((entries) => {
		const entry = entries.at(-1);
		if (entry) dockStageWidth = entry.contentRect.width;
	});
	observer.observe(stage);
	return () => observer.disconnect();
});

$effect(() => {
	if (shouldShowWorkspaceShell) {
		if (closeAnimationTimer) {
			clearTimeout(closeAnimationTimer);
			closeAnimationTimer = null;
		}

		shouldRender = true;
		isVisible = false;
		let cancelled = false;
		// The column has to be seen closed before it can grow: render it, commit
		// that layout, and only then open it, so the width has somewhere to start.
		void tick().then(() => {
			if (cancelled) return;
			void desktopShellElement?.offsetWidth;
			isVisible = true;
		});

		return () => {
			cancelled = true;
		};
	}

	isVisible = false;
	if (shouldRender && !closeAnimationTimer) {
		// §7.2 #2: "content fades out" — the content wrapper's own fade, not
		// the shell's; reducedMotionAnimate jumps straight to hidden under
		// reduced motion, so `finished` still resolves promptly.
		const fadeOut = desktopContentElement
			? reducedMotionAnimate(
					desktopContentElement,
					[{ opacity: 1 }, { opacity: 0 }],
					{ duration: MOTION_DURATION.standard, easing: MOTION_EASING.in },
				)
			: null;
		// The column shrinks over the same `standard` the content fades in; it is
		// taken out of the page when it has.
		closeAnimationTimer = setTimeout(
			() => {
				shouldRender = false;
				closeAnimationTimer = null;
			},
			shellPresentation === "expanded" ? 220 : MOTION_DURATION.standard,
		);
		return () => {
			fadeOut?.cancel();
		};
	}
});

let shellWasShowing = false;
let listWasOpen = false;
/**
 * The list → item push (§7.2 #3) follows the swap itself, so it plays the same
 * whoever closed the list: a list row (`selectFromList`), or the parent on its
 * own — a chat card's Open never touches this component. Only while the shell
 * stays up: the panel's first open and its close keep §7.2 #1/#2. Runs right
 * before the DOM update that mounts the incoming content, which is what the
 * entrance effect below reads.
 */
$effect.pre(() => {
	const showing = shouldShowWorkspaceShell;
	const listOpen = Boolean(list?.open);
	if (showing && shellWasShowing && listWasOpen && !listOpen) {
		pendingEntrance = { direction: "right", delay: 0 };
	}
	// The mirror (§7.2 #4), whoever opened the list: the breadcrumb, or the page
	// itself when the open item was deleted and the list is what is left.
	if (showing && shellWasShowing && !listWasOpen && listOpen) {
		pendingEntrance = { direction: "left", delay: 0 };
	}
	shellWasShowing = showing;
	listWasOpen = listOpen;
});

/**
 * Plays the entrance for whatever just mounted into `desktopContentElement`
 * — the panel's very first open (the default `pendingEntrance`, content from
 * the right, with the panel itself: §7.2 #1 said 60 ms after it, which left the column empty while the chat had already given up its width) and every list↔item
 * push within an already-open panel (§7.2 #3/#4, immediate: the effect above
 * and the header's back-to-list path set `pendingEntrance` to the direction
 * the NEW content is arriving from just before the branch swaps). There is
 * no separate exit animation: Svelte destroys the outgoing branch
 * synchronously when the state changes, so the outgoing content is simply
 * gone by the time this effect could see it — the entrance below is what
 * carries the motion.
 */
$effect(() => {
	const element = desktopContentElement;
	if (!element) return;
	const { direction, delay } = pendingEntrance;
	// Spent: the next arrival is a panel opening again unless a push says otherwise.
	pendingEntrance = { direction: "right", delay: 0 };
	const fromX = direction === "right" ? 32 : -32;
	const animation = reducedMotionAnimate(
		element,
		[
			{ opacity: 0, transform: `translateX(${fromX}px)` },
			{ opacity: 1, transform: "translateX(0)" },
		],
		{
			duration: MOTION_DURATION.emphasis,
			easing: MOTION_EASING.emphasis,
			delay,
		},
	);
	return () => {
		animation.cancel();
	};
});

/** The expanded panel's own entrance: a small rise and settle, with its opacity (the docked one is its width, above). */
let desktopShellTransform = $derived(
	isVisible ? "translateY(0) scale(1)" : "translateY(0.45rem) scale(0.985)",
);

function startResize(event: MouseEvent) {
	isResizing = true;
	resizeStartX = event.clientX ?? 0;
	const desktopShell = document.querySelector(
		".workspace-shell-desktop",
	) as HTMLElement;
	if (desktopShell) {
		resizeStartWidth = desktopShell.offsetWidth;
	}
}

function handleResizeMove(event: MouseEvent) {
	if (!isResizing) return;

	const clientX = event.clientX ?? 0;
	const deltaX = resizeStartX - clientX;
	workspaceWidth = clampWorkspaceWidth(resizeStartWidth + deltaX);
}

function stopResize() {
	isResizing = false;
}

function resetWorkspaceWidth() {
	workspaceWidth = clampWorkspaceWidth(DEFAULT_WORKSPACE_WIDTH);
}

function clampWorkspaceWidth(nextWidth: number): number {
	const viewportMax = browser
		? window.innerWidth * MAX_WIDTH_RATIO
		: DEFAULT_WORKSPACE_WIDTH;
	return Math.max(
		Math.min(MIN_WIDTH, viewportMax),
		Math.min(nextWidth, viewportMax),
	);
}

function getInitialWorkspaceWidth(): number {
	if (!browser) return DEFAULT_WORKSPACE_WIDTH;
	const storedValue = localStorage.getItem(WORKSPACE_WIDTH_STORAGE_KEY);
	const parsedStoredValue = storedValue ? Number.parseFloat(storedValue) : NaN;
	const shouldUseStoredWidth =
		Number.isFinite(parsedStoredValue) &&
		parsedStoredValue > LEGACY_NARROW_WIDTH_THRESHOLD;
	return clampWorkspaceWidth(
		shouldUseStoredWidth ? parsedStoredValue : DEFAULT_WORKSPACE_WIDTH,
	);
}

function getInitialPreviewRendererSurface(): "desktop" | "mobile" {
	if (!browser || typeof window.matchMedia !== "function") return "desktop";
	return window.matchMedia(DESKTOP_PREVIEW_MEDIA_QUERY).matches
		? "desktop"
		: "mobile";
}

$effect(() => {
	if (!browser || typeof window.matchMedia !== "function") {
		previewRendererSurface = "desktop";
		return;
	}

	const desktopPreviewQuery = window.matchMedia(DESKTOP_PREVIEW_MEDIA_QUERY);
	function syncPreviewRendererSurface() {
		previewRendererSurface = desktopPreviewQuery.matches ? "desktop" : "mobile";
	}

	syncPreviewRendererSurface();
	desktopPreviewQuery.addEventListener("change", syncPreviewRendererSurface);

	return () => {
		desktopPreviewQuery.removeEventListener(
			"change",
			syncPreviewRendererSurface,
		);
	};
});

function handleResizeKeyDown(event: KeyboardEvent) {
	if (!browser) return;
	const step = event.shiftKey ? 40 : 20;
	if (event.key === "ArrowLeft") {
		event.preventDefault();
		workspaceWidth = clampWorkspaceWidth(workspaceWidth + step);
		return;
	}
	if (event.key === "ArrowRight") {
		event.preventDefault();
		workspaceWidth = clampWorkspaceWidth(workspaceWidth - step);
		return;
	}
	if (event.key === "Home") {
		event.preventDefault();
		workspaceWidth = MIN_WIDTH;
		return;
	}
	if (event.key === "End") {
		event.preventDefault();
		workspaceWidth = clampWorkspaceWidth(Number.POSITIVE_INFINITY);
	}
}

$effect(() => {
	if (!browser || !isResizing) return;

	function onMouseMove(event: MouseEvent) {
		handleResizeMove(event);
	}

	function onMouseUp() {
		stopResize();
	}

	document.addEventListener("mousemove", onMouseMove);
	document.addEventListener("mouseup", onMouseUp);

	return () => {
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
	};
});

function formatRoleLabel(role: string | null | undefined): string | null {
	if (!role) return null;
	const normalized = role.trim();
	if (!normalized) return null;
	return normalized
		.split(/[_-\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function getDocumentTitle(document: DocumentWorkspaceItem): string {
	return document.documentLabel ?? document.title ?? document.filename;
}

/** The names more than one row of the list has (FB-5, F9): those rows say when they were made. */
let namesSharedByRows = $derived(
	sharedNames((list?.items ?? []).map(getDocumentTitle)),
);

/**
 * What a row says beyond its title and kind so that rows of one name can be told
 * apart (F9): a produced file's extension and size, and, when another row has the
 * same name, the time it was made. A version number is not it (ruling 76).
 */
function rowFactsFor(item: DocumentWorkspaceItem): string | null {
	const facts: string[] = [];
	if ((item.kind ?? "file") === "file") {
		const file = fileFacts({
			filename: item.filename,
			sizeBytes: item.sizeBytes,
		});
		if (file) facts.push(file);
	}
	if (
		item.updatedAt != null &&
		isShared(namesSharedByRows, getDocumentTitle(item))
	) {
		facts.push(
			rowMadeAtLabel(item.updatedAt, $uiLanguage === "hu" ? "hu" : "en"),
		);
	}
	return facts.length > 0 ? facts.join(" · ") : null;
}

/**
 * The panel list row's own card view (T9 steps 4/7): a Document item with a
 * server preview gets the subtitle/tickable checklist through
 * `documentArtifactCardViewFromPreview` — the SAME builder the chat card
 * uses, from the SAME bounded data, never a full-body fetch just to render a
 * list row. Every other item (including a Document with no preview, e.g. an
 * older cached list) falls back to the plain card this list has always
 * shown.
 */
function artifactCardViewFor(item: DocumentWorkspaceItem): ArtifactCardView {
	const madeBy =
		item.updatedAt != null
			? $t("artifacts.card.madeBy", {
					when: formatRelativeTime(item.updatedAt, { t: $t }),
				})
			: null;
	// chrome="row" (redesign §5.2) wants the BARE time, never the "made by
	// Alfy …" sentence `madeBy` above builds — see
	// `ArtifactCardView.updatedAtLabel`'s own doc comment.
	const updatedAtLabel =
		item.updatedAt != null
			? formatRelativeTime(item.updatedAt, { t: $t })
			: null;
	// The row's pending-review pill (Wave 2.5 review, F1): `item.pendingReviewCount`
	// is the PERSISTED count — `read-model.ts`'s `computeDocumentPendingReviewCounts`
	// on load/refresh, kept live by this panel's own `handleBodyPendingReviewCountChange`
	// while the body is open — and wins whenever it is set (0 included: that
	// means "reviewed", still a real answer, never a reason to fall through).
	// Only a row this page has NEVER heard a persisted count for (`undefined` —
	// a brand-new item from mid-turn, before any conversation-detail load)
	// falls back to the ephemeral, session-only `alfyActivity` guess, exactly
	// like before. Wave 2.5 Step 11: only APPLIED changes count in that
	// fallback — a fully refused call has nothing to review
	// (`ToolActivityRow.svelte`'s own `artifactCardView` mirrors this exactly,
	// including the same removed `Math.max(..., 1)` stopgap).
	const ephemeralPendingReviewCount =
		alfyActivity &&
		alfyActivity.artifactId === (item.artifactId ?? item.id) &&
		(alfyActivity.status === "applied" || alfyActivity.status === "refused") &&
		alfyActivity.appliedCount > 0
			? alfyActivity.appliedCount
			: null;
	const pendingReviewCount =
		item.pendingReviewCount ?? ephemeralPendingReviewCount;
	const rowExtras = {
		updatedAtLabel,
		pendingReviewCount,
		current: item.id === activeDocumentId,
		rowFacts: rowFactsFor(item),
	};
	if (item.kind === "document" && item.documentPreview) {
		return {
			...documentArtifactCardViewFromPreview({
				artifactId: item.id,
				title: getDocumentTitle(item),
				madeBy,
				subtitle: $t("artifacts.document.cardSubtitle", {
					count: item.documentPreview.tabCount,
				}),
				preview: item.documentPreview,
				onToggleTask: (blockId, checked) =>
					onToggleDocumentTask?.(item.id, blockId, checked),
			}),
			...rowExtras,
		};
	}
	return {
		id: item.id,
		kind: item.kind ?? "file",
		title: getDocumentTitle(item),
		openTargetId: item.id,
		madeBy,
		...rowExtras,
	};
}

function getDocumentVersionLabel(
	document: DocumentWorkspaceItem,
): string | null {
	const versionNumber =
		document.versionNumber && document.versionNumber > 0
			? document.versionNumber
			: document.source === "chat_generated_file"
				? 1
				: null;
	return versionNumber ? `v${versionNumber}` : null;
}

function getDocumentSubtitle(document: DocumentWorkspaceItem): string | null {
	const roleLabel = formatRoleLabel(document.documentRole);
	return roleLabel || null;
}

function getDocumentLifecycleLabel(
	document: DocumentWorkspaceItem,
): string | null {
	return document.documentFamilyStatus === "historical"
		? $t("documentWorkspace.historical")
		: null;
}

function isAiGeneratedDocument(document: DocumentWorkspaceItem): boolean {
	return document.source === "chat_generated_file";
}

function getDocumentSourceLabel(document: DocumentWorkspaceItem): string {
	return isAiGeneratedDocument(document)
		? $t("documentWorkspace.aiSource")
		: $t("documentWorkspace.fromKnowledgeBase");
}

let familyDocuments: DocumentWorkspaceItem[] = $state([]);

$effect(() => {
	const activeDoc = activeDocument;
	if (!activeDoc?.documentFamilyId) {
		familyDocuments = [];
		return;
	}

	const currentAvailable = availableDocuments;
	const currentDocuments = documents;

	const mergedById = new Map<string, DocumentWorkspaceItem>();
	for (const document of [...currentAvailable, ...currentDocuments]) {
		if (document.documentFamilyId !== activeDoc.documentFamilyId) continue;
		const existing = mergedById.get(document.id);
		mergedById.set(
			document.id,
			existing ? { ...existing, ...document } : document,
		);
	}

	familyDocuments = Array.from(mergedById.values()).sort((left, right) => {
		const leftVersion = left.versionNumber ?? 0;
		const rightVersion = right.versionNumber ?? 0;
		if (rightVersion !== leftVersion) return rightVersion - leftVersion;
		if (left.id === activeDoc.id) return -1;
		if (right.id === activeDoc.id) return 1;
		return getDocumentTitle(left).localeCompare(getDocumentTitle(right));
	});
});

function isCurrentFamilyDocument(document: DocumentWorkspaceItem): boolean {
	return document.id === activeDocument?.id;
}

function isLatestFamilyDocument(document: DocumentWorkspaceItem): boolean {
	return familyDocuments[0]?.id === document.id;
}

function handleFamilyDocumentOpen(document: DocumentWorkspaceItem) {
	onSelectDocument(document.id);
}

function canJumpToSource(document: DocumentWorkspaceItem): boolean {
	return Boolean(
		document.originConversationId && document.originAssistantMessageId,
	);
}

function isTextDocument(document: DocumentWorkspaceItem): boolean {
	return (
		determinePreviewFileType(document.mimeType, document.filename) === "text"
	);
}

function getDefaultCompareDocumentId(
	documentsInFamily: DocumentWorkspaceItem[],
): string | null {
	if (!(activeDocument && documentsInFamily.length > 1)) return null;
	const currentIndex = documentsInFamily.findIndex(
		(document) => document.id === activeDocument.id,
	);
	if (currentIndex === -1) return documentsInFamily[0]?.id ?? null;
	if (currentIndex === 0) return documentsInFamily[1]?.id ?? null;
	return documentsInFamily[currentIndex - 1]?.id ?? null;
}

let canCompareActiveDocument = $derived(
	Boolean(
		activeDocument &&
			isTextDocument(activeDocument) &&
			familyDocuments.length > 1,
	),
);
let comparedDocument = $derived(
	compareDocumentId
		? (familyDocuments.find((document) => document.id === compareDocumentId) ??
				null)
		: null,
);

$effect(() => {
	if (!canCompareActiveDocument) {
		compareMode = false;
		compareDocumentId = null;
		return;
	}

	const nextCompareId = getDefaultCompareDocumentId(familyDocuments);
	if (
		!compareDocumentId ||
		!familyDocuments.some((document) => document.id === compareDocumentId)
	) {
		compareDocumentId = nextCompareId;
	}
});

function getDocumentPreviewUrl(document: DocumentWorkspaceItem): string | null {
	if (document.previewUrl) return document.previewUrl;
	if (document.artifactId)
		return `/api/knowledge/${document.artifactId}/preview`;
	return null;
}

function getDocumentDownloadUrl(
	document: DocumentWorkspaceItem,
): string | null {
	if (document.downloadUrl) return document.downloadUrl;
	if (document.source === "knowledge_artifact" && document.artifactId) {
		return `/api/knowledge/${document.artifactId}/download`;
	}
	return null;
}

type AtlasOutputDocument = DocumentWorkspaceItem & {
	atlasHtmlChatGeneratedFileId?: string | null;
	atlasPdfChatGeneratedFileId?: string | null;
	atlasMarkdownChatGeneratedFileId?: string | null;
};

type AtlasDownloadOption = {
	key: "html" | "pdf" | "markdown";
	label: string;
	url: string;
};

function isAtlasOutputDocument(
	document: DocumentWorkspaceItem,
): document is AtlasOutputDocument {
	return (
		document.source === "chat_generated_file" &&
		"atlasHtmlChatGeneratedFileId" in document &&
		Boolean(document.atlasHtmlChatGeneratedFileId)
	);
}

function getAtlasDownloadOptions(
	document: AtlasOutputDocument,
): AtlasDownloadOption[] {
	const options: AtlasDownloadOption[] = [];
	const htmlId = document.atlasHtmlChatGeneratedFileId;
	const pdfId = document.atlasPdfChatGeneratedFileId;
	const markdownId = document.atlasMarkdownChatGeneratedFileId;
	if (htmlId) {
		options.push({
			key: "html",
			label: $t("atlas.action.downloadHtml"),
			url: `/api/chat/files/${htmlId}/download`,
		});
	}
	if (pdfId) {
		options.push({
			key: "pdf",
			label: $t("atlas.action.downloadPdf"),
			url: `/api/chat/files/${pdfId}/download`,
		});
	}
	if (markdownId) {
		options.push({
			key: "markdown",
			label: $t("atlas.action.downloadMarkdown"),
			url: `/api/chat/files/${markdownId}/download`,
		});
	}
	return options;
}

function toggleExpandedDownloadMenu() {
	expandedDownloadMenuOpen = !expandedDownloadMenuOpen;
}

/** The inset keyframe for a fixed shell standing on `rect`. */
function insetsOf(rect: DOMRect): Keyframe {
	return {
		top: `${rect.top}px`,
		left: `${rect.left}px`,
		right: `${window.innerWidth - rect.right}px`,
		bottom: `${window.innerHeight - rect.bottom}px`,
	};
}

/**
 * Expand grows the panel from where its column stands to the whole window, in
 * the same motion every layout change here has (FB-3, F26): the old rect is the
 * first keyframe, and the overlay's own insets are the last.
 */
async function requestExpandedPresentation(): Promise<void> {
	const shell = desktopShellElement;
	const from = shell?.getBoundingClientRect();
	onPresentationChange?.("expanded");
	if (!shell || !from || prefersReducedMotion()) return;
	await tick();
	if (desktopShellElement !== shell) return;
	shell.animate([{ offset: 0, ...insetsOf(from), borderRadius: "0px" }], {
		duration: MOTION_DURATION.emphasis,
		easing: MOTION_EASING.emphasis,
	});
}

/**
 * Docking is the mirror: the overlay shrinks onto the column that was held for
 * it, and only then is it a column again, so it never changes shape in a frame.
 */
async function requestDockedPresentation(): Promise<void> {
	const shell = desktopShellElement;
	const slot = dockSpacerElement;
	if (!shell || !slot || prefersReducedMotion()) {
		onPresentationChange?.("docked");
		return;
	}
	const animation = shell.animate(
		[
			{
				offset: 1,
				...insetsOf(slot.getBoundingClientRect()),
				borderRadius: "0px",
			},
		],
		{
			duration: MOTION_DURATION.emphasis,
			easing: MOTION_EASING.emphasis,
			fill: "forwards",
		},
	);
	await animation.finished.catch(() => undefined);
	onPresentationChange?.("docked");
	await tick();
	animation.cancel();
}

/** The X: the panel closes, in whatever shape it is in. */
function handleCloseWorkspace() {
	onCloseWorkspace();
}

/**
 * Escape, a press outside the expanded panel, the phone's backdrop: step out of
 * the expanded view to the dock, or close where there is no dock to return to.
 * (The X is not this: it closes.)
 */
function stepOutOfExpanded() {
	if (presentation === "expanded" && returnToDockedOnExpandedClose) {
		void requestDockedPresentation();
		return;
	}
	onCloseWorkspace();
}

function handleMobileBackdropClick(event: MouseEvent) {
	if (event.target === event.currentTarget) {
		stepOutOfExpanded();
	}
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (
		event.key !== "Escape" ||
		event.defaultPrevented ||
		!shouldShowWorkspaceShell
	) {
		return;
	}

	// This listener mounts with the shell itself, before any popover/sheet/
	// composer that opens later — so it runs FIRST on a shared Escape press,
	// before that layer's own `preventDefault()` has a chance to fire.
	// Deferring to `hasOpenDialog()` (order-independent) instead of relying
	// on `event.defaultPrevented` above is what keeps one Escape closing
	// only the innermost layer (redesign §5.4) instead of the popover AND
	// the expanded panel at once. A panel over a dialog is itself on that
	// stack, so this always defers there: its trap below answers Escape.
	if (hasOpenDialog()) return;

	closeFromEscape();
}

/**
 * What Escape does to the panel itself: the list closes first, in any
 * presentation; only then does it fall through to the panel's own
 * (expanded-only) close behaviour.
 */
function closeFromEscape() {
	if (historyOpen) {
		closeHistory();
		return;
	}
	if (list?.open) {
		onListOpenChange?.(false);
		return;
	}

	if (presentation !== "expanded") return;

	stepOutOfExpanded();
}

// A panel over a dialog (`overDialog`) is a layer of the one dialog stack for as
// long as it is open, registered after the dialog it sits on so it is the
// topmost: the dialog's own trap then lets Tab and Escape pass until the panel
// is gone. The pattern is the one every dialog that is not a DialogShell but
// nests with them uses (ImageLightbox, ModelForm, the artifact popovers):
// register, then a `focusTrap` gated on `isTopmostDialog`.
const stackId = Symbol("document-workspace");

$effect(() => {
	if (!overDialog || !shouldShowWorkspaceShell) return;
	registerDialog(stackId);
	return () => deregisterDialog(stackId);
});

/**
 * ProseMirror takes Escape (and Enter) for itself on every key press, so that
 * the browser's own default never runs (`captureKeyDown` in prosemirror-view):
 * a `defaultPrevented` Escape from inside the Document's editor says nothing
 * about the layers above the text.
 */
function isEditorsOwnEscape(event: KeyboardEvent): boolean {
	return (
		event.target instanceof Element &&
		event.target.closest(".ProseMirror") !== null
	);
}

/**
 * The trap for one of the two shells. Both are mounted and the viewport shows
 * one of them (`previewRendererSurface`, which is also the one that holds the
 * body), so each trap answers only while its own shell is the one on screen:
 * the other has nothing to land on and would otherwise swallow the key. Escape
 * is the window handler's own rule (`closeFromEscape`), and a key a layer inside
 * the panel already used for itself (the board's note being edited, a menu, a
 * composer cancelling) stays that layer's: the window handler skips a
 * `defaultPrevented` key the same way. Focus goes back to what had it when the
 * shell mounted, the row that opened the item.
 */
function trapFor(surface: "desktop" | "mobile") {
	return focusTrap({
		isTopmost: () =>
			overDialog &&
			previewRendererSurface === surface &&
			isTopmostDialog(stackId),
		onEscape: (event) => {
			if (event.defaultPrevented && !isEditorsOwnEscape(event)) return;
			event.preventDefault();
			// As the topmost layer of the stack always does (DialogShell's own
			// handler too): no later window listener reacts to this press. The
			// dialog under the panel is topmost the moment the panel has left the
			// stack, which can be before its listener has run.
			event.stopImmediatePropagation();
			closeFromEscape();
		},
		restoreFocusOnCleanup: true,
		preventScroll: true,
	});
}
const desktopTrap = trapFor("desktop");
const mobileTrap = trapFor("mobile");

function closeArtifactList(): void {
	onListOpenChange?.(false);
}

/** A row's Open action: the same selection path every caller already uses. */
// Reuses the panel's existing document-selection path (onSelectDocument,
// keyed by the item's own `id`) instead of forking it. Deliberately `id`,
// not `artifactId`: the caller's `documents`/`availableDocuments` arrays are
// themselves keyed by `id` (a produced file's real item uses the
// chat_generated_file's own id, with `artifactId` carried only as a
// separate field), so looking the selection up by anything else would miss
// every item the caller already builds today.
//
// §7.2 #3: "list slides 28px left and fades (exit); item slides in from 28px
// right (enter)" — played by the list-closing effect above, which sees this
// swap the same as any other that closes the list onto an item.
function selectFromList(item: DocumentWorkspaceItem): void {
	onSelectDocument(item.id);
	onListOpenChange?.(false);
}

/** `ArtifactPanelHeader`'s breadcrumb (§7.2 #4, the mirror of #3: the list enters from the left). */
function handleBackToList(): void {
	pendingEntrance = { direction: "left", delay: 0 };
	onListOpenChange?.(true);
}

function handleDocumentPointerdown(event: PointerEvent) {
	if (
		!shouldShowWorkspaceShell ||
		presentation !== "expanded" ||
		!desktopShellElement
	) {
		return;
	}
	// The press belongs to the layer that is on top, as Escape does: a popover opened
	// from the panel (Download, Versions) or a dialog it asked for is painted outside
	// its markup, and a press on it or beside it is that layer's own. Over a dialog the
	// panel is itself on the stack and asks whether it is the topmost; on a page (the
	// Knowledge library, the chat) it is on none, and asks whether anything is open.
	// The dialog under the panel is not asked either: its scrim ignores the click that
	// ends a press which began while a layer was over it.
	if (overDialog ? !isTopmostDialog(stackId) : hasOpenDialog()) return;

	const target = event.target;
	if (target instanceof Node && desktopShellElement.contains(target)) {
		return;
	}
	if (target instanceof Node && mobileShellElement?.contains(target)) {
		return;
	}

	stepOutOfExpanded();
}

async function loadComparePreview(
	document: DocumentWorkspaceItem,
): Promise<string> {
	const previewUrl = getDocumentPreviewUrl(document);
	if (!previewUrl) {
		throw new Error("Preview not available for comparison");
	}

	return fetchDocumentPreviewText(previewUrl);
}

async function ensureDocumentPreviewRendererModule() {
	if (!documentPreviewRendererModulePromise) {
		documentPreviewRendererModulePromise = import(
			"$lib/components/document-workspace/DocumentPreviewRenderer.svelte"
		);
	}

	return documentPreviewRendererModulePromise;
}

$effect(() => {
	if (!browser) return;
	if (shouldShowWorkspaceShell) {
		void ensureDocumentPreviewRendererModule().catch(() => {
			documentPreviewRendererModulePromise = null;
		});
	}
});

function renderHighlightedCompareText(
	currentText: string,
	comparedText: string,
	side: "current" | "compared",
) {
	return renderTextComparisonHtml(currentText, comparedText, side);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderTextComparisonHtml(
	currentText: string,
	comparedText: string,
	side: "current" | "compared",
): string {
	const diff = computeSideBySideDiff(currentText, comparedText);
	const lines = side === "current" ? diff.leftLines : diff.rightLines;
	const renderedLines: string[] = [];

	for (const line of lines) {
		const cssState =
			line.type === "add"
				? "added"
				: line.type === "remove"
					? "removed"
					: "unchanged";
		const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
		renderedLines.push(
			`<span class="workspace-diff-line workspace-diff-line-${cssState}"><span class="workspace-diff-gutter">${sign}</span><span class="workspace-diff-content">${escapeHtml(line.text) || "&nbsp;"}</span></span>`,
		);
	}

	return `<pre class="workspace-diff"><code>${renderedLines.join("\n")}</code></pre>`;
}

$effect(() => {
	if (
		!(
			browser &&
			compareMode &&
			activeDocument &&
			comparedDocument &&
			canCompareActiveDocument
		)
	) {
		compareCurrentTextHtml = null;
		compareOtherTextHtml = null;
		compareSummary = null;
		compareLoading = false;
		compareError = null;
		return;
	}

	let cancelled = false;
	compareLoading = true;
	compareError = null;
	compareCurrentTextHtml = null;
	compareOtherTextHtml = null;
	compareSummary = null;

	void (async () => {
		try {
			const [currentText, otherText] = await Promise.all([
				loadComparePreview(activeDocument),
				loadComparePreview(comparedDocument),
			]);
			const currentHtml = renderHighlightedCompareText(
				currentText,
				otherText,
				"current",
			);
			const otherHtml = renderHighlightedCompareText(
				currentText,
				otherText,
				"compared",
			);

			if (cancelled) return;
			compareCurrentTextHtml = currentHtml;
			compareOtherTextHtml = otherHtml;
			compareSummary = summarizeTextComparison(currentText, otherText);
		} catch (error) {
			if (cancelled) return;
			compareError =
				error instanceof Error
					? error.message
					: "Failed to load comparison preview";
		} finally {
			if (!cancelled) {
				compareLoading = false;
			}
		}
	})();

	return () => {
		cancelled = true;
	};
});

function syncScroll(
	source: HTMLDivElement | null | undefined,
	target: HTMLDivElement | null | undefined,
) {
	if (!syncScrollEnabled || isSyncingScroll || !target) return;
	isSyncingScroll = true;
	target.scrollTop = source?.scrollTop ?? 0;
	requestAnimationFrame(() => {
		isSyncingScroll = false;
	});
}

function toggleSyncScroll() {
	syncScrollEnabled = !syncScrollEnabled;
}

function clickOutside(node: HTMLElement, handler: () => void) {
	function handleMouseDown(event: MouseEvent) {
		if (node && !node.contains(event.target as Node)) {
			handler();
		}
	}

	document.addEventListener("mousedown", handleMouseDown);
	return {
		destroy() {
			document.removeEventListener("mousedown", handleMouseDown);
		},
	};
}
</script>

<svelte:window onkeydown={handleWindowKeydown} />
<svelte:document onpointerdown={handleDocumentPointerdown} />

{#if list && renderListShell}
	{#snippet artifactListBody(testid: string | undefined)}
		<div class="workspace-body artifact-panel-list-body" data-testid={testid}>
			{#if list.items.length === 0 && !list.pending?.length}
				<p class="artifact-panel-empty">{$t('artifacts.panel.empty')}</p>
			{:else}
				<ul class="artifact-panel-list-rows">
					{#each list.pending ?? [] as making (making.id)}
						<li data-testid="artifact-row-pending">
							<ArtifactCard
								view={{
									id: making.id,
									kind: making.kind,
									title: making.title,
									openTargetId: null,
									rowFacts: $t('artifacts.deleted.regenerating'),
									working: true,
								}}
								chrome="row"
							/>
						</li>
					{/each}
					{#each list.items as item (item.id)}
						<li>
							{#if canDeleteItem(item)}
								<ArtifactCard
									view={artifactCardViewFor(item)}
									chrome="row"
									onOpen={() => selectFromList(item)}
								>
									{#snippet rowMenu()}
										{@const menuLabel = $t('artifacts.delete.rowMenu', { title: getDocumentTitle(item) })}
										<button
											type="button"
											class="btn-icon-bare artifact-row-menu-button"
											data-testid={`artifact-row-menu-${item.id}`}
											aria-haspopup="menu"
											aria-label={menuLabel}
											title={menuLabel}
											onclick={() => (rowMenuOpenId = item.id)}
										>
											<MoreHorizontal size={18} strokeWidth={2} aria-hidden="true" />
										</button>
									{/snippet}
								</ArtifactCard>
							{:else}
								<ArtifactCard
									view={artifactCardViewFor(item)}
									chrome="row"
									onOpen={() => selectFromList(item)}
								/>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/snippet}

	<!-- Mobile overlay: the list state, same chrome as the document state. -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="workspace-mobile-backdrop md:hidden"
		role="presentation"
		onclick={handleMobileBackdropClick}
	>
		<section
			bind:this={mobileShellElement}
			{@attach overDialog ? mobileTrap : undefined}
			role={overDialog ? "dialog" : undefined}
			aria-modal={overDialog ? "true" : undefined}
			class="workspace-shell workspace-shell-mobile"
			aria-label={list.title ?? $t('artifacts.panel.title')}
		>
			<div class="workspace-header">
				<div class="workspace-heading">
					<div class="workspace-title-row">
						<div class="workspace-title" data-testid="artifact-panel-list-title" tabindex="-1">
							<span>{list.title ?? $t('artifacts.panel.title')}</span>
						</div>
						<div class="workspace-header-actions">
							<button
								type="button"
								class="btn-icon-bare workspace-close-button"
								onclick={closeArtifactList}
								aria-label={$t('documentWorkspace.closeWorkspace')}
							>
								<X size={18} strokeWidth={2.1} aria-hidden="true" />
							</button>
						</div>
					</div>
					<div class="workspace-subtitle">
						{$t('artifacts.panel.count', { count: list.items.length })}
					</div>
				</div>
			</div>

			{@render artifactListBody('artifact-panel-list-mobile')}
		</section>
	</div>

	<!-- Desktop / tablet side pane -->
	<aside
		bind:this={desktopShellElement}
		{@attach overDialog ? desktopTrap : undefined}
		role={overDialog ? "dialog" : undefined}
		aria-modal={overDialog ? "true" : undefined}
		class="workspace-shell workspace-shell-desktop workspace-shell-docked"
		class:workspace-fade-in={isVisible}
		class:workspace-resizing={isResizing}
		style:--workspace-dock-width={dockedWidthCss(workspaceWidth)}
		aria-label={list.title ?? $t('artifacts.panel.title')}
	>
		<div
			class="workspace-content"
			bind:this={desktopContentElement}
			style:width={dockContentWidth === null ? undefined : `${dockContentWidth}px`}
		>
			<div class="workspace-header">
				<div class="workspace-heading">
					<div class="workspace-title-row">
						<div class="workspace-title" data-testid="artifact-panel-list-title" tabindex="-1">
							<span>{list.title ?? $t('artifacts.panel.title')}</span>
						</div>
						<div class="workspace-header-actions">
							<button
								type="button"
								class="btn-icon-bare workspace-close-button"
								onclick={closeArtifactList}
								aria-label={$t('documentWorkspace.closeWorkspace')}
							>
								<X size={18} strokeWidth={2.1} aria-hidden="true" />
							</button>
						</div>
					</div>
					<div class="workspace-subtitle">
						{$t('artifacts.panel.count', { count: list.items.length })}
					</div>
				</div>
			</div>

			<div class="workspace-main" data-testid="workspace-main" data-presentation={presentation}>
				<div class="workspace-document-column">
					{@render artifactListBody('artifact-panel-list')}
				</div>
			</div>
		</div>
	</aside>
	{#if rowMenuOpenId}
		{@const menuItem = list.items.find((candidate) => candidate.id === rowMenuOpenId)}
		{#if menuItem && canDeleteItem(menuItem)}
			<ArtifactDeletePopover
				kind={menuItem.kind ?? 'file'}
				title={getDocumentTitle(menuItem)}
				anchorTestId={`artifact-row-menu-${menuItem.id}`}
				regenerable={canRegenerateItem(menuItem)}
				onReplayTour={tourKindOf(menuItem.kind)
					? () => replayTourFromList(menuItem)
					: undefined}
				initialStage="menu"
				onConfirm={() => deleteFromList(menuItem)}
				onClose={() => (rowMenuOpenId = null)}
			/>
		{/if}
	{/if}
{:else if shouldRender && activeDocument}
	{#snippet atlasDownloadControl(document: DocumentWorkspaceItem)}
		{#if isAtlasOutputDocument(document)}
			{@const options = getAtlasDownloadOptions(document)}
			{#if options.length > 0}
				<div
					class="workspace-download-dropdown"
					use:clickOutside={() => {
						expandedDownloadMenuOpen = false;
					}}
				>
					<button
						type="button"
						class="btn-icon-bare workspace-download-button"
						onclick={toggleExpandedDownloadMenu}
						aria-label={$t('atlas.action.download')}
						title={$t('atlas.action.download')}
						aria-haspopup="menu"
						aria-expanded={expandedDownloadMenuOpen}
					>
						<Download size={18} strokeWidth={2} aria-hidden="true" />
					</button>
					{#if expandedDownloadMenuOpen}
						<div
							class="workspace-download-menu"
							role="menu"
							aria-label={$t('atlas.action.download')}
						>
							{#each options as option}
								<a
									class="workspace-download-option"
									href={option.url}
									role="menuitem"
									download
									onclick={(event) => {
										expandedDownloadMenuOpen = false;
										handleDownloadAnchorClick(event, option.url);
									}}
								>
									{#if option.key === 'markdown'}
										<FileText size={14} strokeWidth={2} aria-hidden="true" />
									{:else}
										<Download size={14} strokeWidth={2} aria-hidden="true" />
									{/if}
									<span>{option.label}</span>
								</a>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{:else if getDocumentDownloadUrl(document)}
			<a
				class="btn-icon-bare workspace-download-button"
				href={getDocumentDownloadUrl(document)}
				download={document.filename}
				onclick={(event) =>
					handleDownloadAnchorClick(
						event,
						getDocumentDownloadUrl(document) ?? '',
						document.filename,
					)}
				aria-label={$t('filePreview.download', { filename: document.filename })}
				title={$t('filePreview.download', { filename: document.filename })}
			>
				<Download size={18} strokeWidth={2} aria-hidden="true" />
			</a>
		{/if}
	{/snippet}

	{#snippet artifactPanelActions()}
		{#if list}
			<button
				type="button"
				class="btn-icon-bare workspace-list-toggle-button"
				onclick={() => onListOpenChange?.(true)}
				aria-label={$t('artifacts.panel.list')}
				title={$t('artifacts.panel.list')}
			>
				<LayoutGrid size={18} strokeWidth={2} aria-hidden="true" />
			</button>
			<button
				type="button"
				class="btn-icon-bare workspace-history-toggle-button"
				disabled
				aria-disabled="true"
				title={$t('artifacts.history.comingWithDocument')}
				aria-label={$t('artifacts.panel.history')}
			>
				<History size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		{/if}
	{/snippet}

	<!-- The first-open tour: a card in the panel's flow, above the item, so the item starts under it
	     and nothing of the item is covered (ruling 77, FX-2; FB-3 had laid it over the item, which
	     moved nothing and hid the Document's toolbar and first lines, the App's status row and the
	     board's top). Its room is made before the body paints whenever the answer is in hand,
	     which `warmTours` and `presentTour` see to; a late answer grows in as a height. -->
	{#snippet tourCard()}
		{#if tourView && tourView.itemKey === activeBodyKey}
			<div class="workspace-tour-slot" class:workspace-body-covered={historyOpen} inert={historyOpen}>
				<!-- One card per presentation. A card is on its way out for a quarter of a second after it is
				     left, and an {#if} that turns true again in that time brings the SAME card back, with its
				     finished state and its slide. A presentation wanted while one is leaving (the copy changed
				     under the reader, a replay at once) is a new card, at its first slide. -->
				{#key tourView}
					{@const Card = tourView.Card}
					<Card
						tour={tourView.tour}
						replay={tourView.replay}
						animate
						entrance={tourView.entrance}
						onSeen={handleTourSeen}
						onDismiss={handleTourDismiss}
						onClose={handleTourClose}
					/>
				{/key}
			</div>
		{/if}
	{/snippet}

	<!--
		Wave 2.5 Step 3/8: `ArtifactPanelHeader`'s actions for an artifact-kind
		item (Document/App/File) — Comments (Document only, matching the mockup's
		own `.ph-actions` order), Download, a divider, Expand, Close. Never the
		old grid/History buttons `artifactPanelActions()` above draws for a
		legacy, non-artifact item: the breadcrumb replaces "back to the list",
		and the version button above replaces History outright.
	-->
	<!--
		History, a mode of the panel (ruling 76): a slot laid over the open body in
		the area the body occupies. The surface that is showing (the phone/mobile
		shell or the desktop pane) draws it; on a phone its mode is a sheet of its
		own (`DialogShell`), so the slot holds nothing visible there.
	-->
	{#snippet historySlot()}
		{#if historyOpen && HistoryModeComponent && activeDocument}
			{@const HistoryView = HistoryModeComponent}
			{@const historyArtifactId = activeDocument.artifactId ?? activeDocument.id}
			{@const chatVersions = artifactVersionMessages?.get(historyArtifactId)}
			<div class="workspace-history-slot" transition:historySlotFade={{ duration: MOTION_DURATION.standard }}>
				<HistoryView
					artifactId={historyArtifactId}
					kind={activeArtifactKind}
					title={getDocumentTitle(activeDocument)}
					{conversationId}
					{currentUser}
					onDone={() => closeHistory()}
					onReview={handleHistoryReview}
					onRestored={handleHistoryRestored}
					chatVersionIds={chatVersions && onShowChatMessage ? new Set(chatVersions.keys()) : null}
					onFromChat={chatVersions && onShowChatMessage
						? (entry) => {
								const messageId = chatVersions.get(entry.versionId);
								if (messageId) handleHistoryFromChat(messageId);
							}
						: undefined}
				/>
			</div>
		{/if}
	{/snippet}

	{#snippet artifactHeaderActionsSnippet()}
		{#if historyOpen}
			<button
				type="button"
				class="btn-secondary btn-sm workspace-history-done"
				data-testid="artifact-history-done"
				onclick={() => closeHistory()}
			>
				{$t('artifacts.history.done')}
			</button>
		{/if}
		{#if historyOpen}
			<!-- Comments and Download step aside while History is open (versioning.md §5.1). -->
		{:else if bodyPanelActions?.toggleComments}
			<!-- One toggle for whichever comments surface applies (the column
			     beside the text, the drawer on a narrow panel, the sheet on a
			     phone): pressed while it is showing, never a second way in
			     beside one that is already open. The name stays "Comments";
			     the tooltip says what a press does. -->
			<button
				type="button"
				class="btn-icon-bare workspace-comments-button"
				data-testid="artifact-comments-button"
				onclick={() => bodyPanelActions?.toggleComments?.()}
				aria-pressed={documentCommentsShown}
				aria-label={documentOpenCommentCount > 0
					? $t('artifacts.document.margin.buttonA11y', { count: documentOpenCommentCount })
					: $t('artifacts.document.margin.title')}
				title={documentCommentsShown
					? $t('artifacts.document.margin.hide')
					: $t('artifacts.document.margin.show')}
			>
				<MessageSquareText size={18} strokeWidth={2} aria-hidden="true" />
				{#if documentOpenCommentCount > 0}
					<span class="workspace-comments-count" aria-hidden="true">{documentOpenCommentCount}</span>
				{/if}
			</button>
		{/if}
		{#if historyOpen}
			<!-- no Download while History is open -->
		{:else if bodyPanelActions?.openDownload}
			{@const downloadLabel = $t(
				activeArtifactKind === 'app'
					? 'artifacts.app.action.download'
					: 'artifacts.document.toolbar.download',
			)}
			<button
				type="button"
				class="btn-icon-bare workspace-download-button"
				data-testid="artifact-download-button"
				onclick={() => bodyPanelActions?.openDownload?.()}
				aria-label={downloadLabel}
				title={downloadLabel}
			>
				<Download size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		{:else}
			{@render atlasDownloadControl(activeDocument)}
		{/if}
		{#if canDeleteItem(activeDocument)}
			{@const deleteLabel = $t(`artifacts.delete.button.${activeArtifactKind}` as I18nKey)}
			<button
				type="button"
				class="btn-icon-bare workspace-delete-button"
				data-testid="artifact-delete-button"
				onclick={() => (deleteConfirmOpen = true)}
				aria-haspopup="dialog"
				aria-label={deleteLabel}
				title={deleteLabel}
			>
				<Trash2 size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		{/if}
		{#if showPresentationToggle && presentation !== "expanded"}
			<span class="artifact-panel-header-actions-div" aria-hidden="true"></span>
			<button
				type="button"
				class="btn-icon-bare workspace-expand-button"
				onclick={requestExpandedPresentation}
				aria-label={$t('documentWorkspace.expandWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
				title={$t('documentWorkspace.expandWorkspace')}
			>
				<Maximize2 size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		{/if}
		{#if showPresentationToggle && presentation === "expanded" && returnToDockedOnExpandedClose}
			<span class="artifact-panel-header-actions-div" aria-hidden="true"></span>
			<button
				type="button"
				class="btn-icon-bare workspace-dock-button"
				onclick={() => void requestDockedPresentation()}
				aria-label={$t('documentWorkspace.collapseWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
				title={$t('documentWorkspace.collapseWorkspace')}
			>
				<Minimize2 size={18} strokeWidth={2} aria-hidden="true" />
			</button>
		{/if}
		<button
			type="button"
			class="btn-icon-bare workspace-close-button"
			onclick={handleCloseWorkspace}
			aria-label={$t('documentWorkspace.closeWorkspace')}
		>
			<X size={18} strokeWidth={2.1} aria-hidden="true" />
		</button>
	{/snippet}

	<!-- Mobile overlay -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="workspace-mobile-backdrop md:hidden"
		role="presentation"
		onclick={handleMobileBackdropClick}
	>
		<section
			bind:this={mobileShellElement}
			{@attach overDialog ? mobileTrap : undefined}
			role={overDialog ? "dialog" : undefined}
			aria-modal={overDialog ? "true" : undefined}
			class="workspace-shell workspace-shell-mobile"
			aria-label={panelLandmarkLabel}
			data-testid="document-workspace-mobile-shell"
		>
			{#if activeDocument.kind}
				<ArtifactPanelHeader
					kind={activeArtifactKind}
					title={getDocumentTitle(activeDocument)}
					phrase={activeMomentPhrase}
					onHistory={kindHasHistory(activeArtifactKind) ? toggleHistory : undefined}
					{historyOpen}
					onBack={list ? handleBackToList : undefined}
					actions={artifactHeaderActionsSnippet}
				/>
			{:else}
				<div class="workspace-header">
					<div class="workspace-heading">
						<div class="workspace-eyebrow">
							{$t('documentWorkspace.workingDocument')}
						</div>
						<div class="workspace-title-row">
							{#if canJumpToSource(activeDocument)}
								<button
									type="button"
									class="workspace-title workspace-title-link"
									onclick={() => onJumpToSource?.(activeDocument)}
									title={$t('documentWorkspace.viewSourceMessage')}
								>
								<span>{getDocumentTitle(activeDocument)}</span>
								<span class="workspace-title-source-icon">
									<ArrowUpRight size={14} strokeWidth={2.1} aria-hidden="true" />
								</span>
								</button>
							{:else}
								<div class="workspace-title">
									<span>{getDocumentTitle(activeDocument)}</span>
								</div>
							{/if}
							<div class="workspace-header-actions">
								{#if documents.length > 1}
									<button
										type="button"
										class="btn-icon-bare workspace-mobile-documents-button"
										onclick={() => {
											mobileDocumentsSheetOpen = !mobileDocumentsSheetOpen;
										}}
										aria-label={$t('documentWorkspace.openDocuments')}
										aria-expanded={mobileDocumentsSheetOpen}
										title={$t('documentWorkspace.openDocuments')}
										data-testid="mobile-documents-button"
									>
									<List size={18} strokeWidth={2.1} aria-hidden="true" />
										<span aria-hidden="true">{documents.length}</span>
									</button>
								{/if}
								{@render artifactPanelActions()}
								{@render atlasDownloadControl(activeDocument)}
								{#if showPresentationToggle}
									<button
										type="button"
										class="btn-icon-bare workspace-expand-button"
										onclick={requestExpandedPresentation}
										aria-label={$t('documentWorkspace.expandWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
										title={$t('documentWorkspace.expandWorkspace')}
									>
										<Maximize2 size={18} strokeWidth={2} aria-hidden="true" />
									</button>
								{/if}
								<button
									type="button"
									class="btn-icon-bare workspace-close-button"
									onclick={handleCloseWorkspace}
									aria-label={$t('documentWorkspace.closeWorkspace')}
								>
									<X size={18} strokeWidth={2.1} aria-hidden="true" />
								</button>
							</div>
						</div>
						{#if getDocumentSubtitle(activeDocument)}
							<div class="workspace-subtitle">{getDocumentSubtitle(activeDocument)}</div>
						{/if}
						<div class="workspace-meta-row" data-testid="document-provenance">
							<span class="workspace-source-pill" class:workspace-source-pill-ai={isAiGeneratedDocument(activeDocument)}>
							{#if isAiGeneratedDocument(activeDocument)}
								<span class="workspace-source-sparkle">
									<Sparkles size={13} strokeWidth={2.1} aria-hidden="true" />
								</span>
							{/if}
								<span>{getDocumentSourceLabel(activeDocument)}</span>
							</span>
							{#if canCompareActiveDocument}
								<button
									type="button"
									class="workspace-compare-toggle"
									class:workspace-compare-toggle-active={compareMode}
									onclick={() => {
										compareMode = !compareMode;
									}}
									aria-label={compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
									title={compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
									aria-pressed={compareMode}
								>
									<ArrowLeftRight size={13} strokeWidth={2.1} aria-hidden="true" />
								</button>
							{/if}
							{#if getDocumentLifecycleLabel(activeDocument)}
								<span class="workspace-status-badge">
									{getDocumentLifecycleLabel(activeDocument)}
								</span>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			<MobileDocumentsSheet
				{documents}
				activeDocumentId={activeDocument.id}
				open={mobileDocumentsSheetOpen}
				onOpenChange={(open) => {
					mobileDocumentsSheetOpen = open;
				}}
				{onSelectDocument}
				{onCloseDocument}
			/>

			{#if familyDocuments.length > 1}
				 <div class="workspace-history" data-testid="document-version-control" aria-label={$t('documentWorkspace.versionHistory')}>
					<div class="workspace-history-label">{$t('documentWorkspace.versionHistory')}</div>
					<div class="workspace-history-list">
						{#each familyDocuments as document (document.id)}
							<button
								type="button"
								class="workspace-history-chip workspace-version-badge"
								class:workspace-history-chip-current={isCurrentFamilyDocument(document)}
								data-testid="document-version-badge"
								onclick={() => handleFamilyDocumentOpen(document)}
							>
								<div class="workspace-history-topline">
									<span
										class="workspace-history-version"
										class:workspace-history-version-current={isCurrentFamilyDocument(document)}
									>
										{getDocumentVersionLabel(document) ?? $t('documentWorkspace.version')}
									</span>
									{#if isLatestFamilyDocument(document)}
										<span class="workspace-history-badge">{$t('documentWorkspace.latest')}</span>
									{/if}
								</div>
								<div class="workspace-history-title">{getDocumentTitle(document)}</div>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<div class="workspace-stage">
			{#if shouldRenderMobilePreview}
				{@render tourCard()}
			{/if}
			<div class="workspace-body" class:workspace-body-covered={historyOpen} inert={historyOpen} data-testid="page-scroll-container-mobile">
				{#if activeArtifactBodyLoader && shouldRenderMobilePreview}
					{@const ArtifactBody = loadedArtifactBodies[activeArtifactKind]}
					{#if ArtifactBody}
						<!-- One body per open ITEM (final polish D1): keyed, so a swap to another
						     item mounts a body that registers its own header controls. A version
						     change keeps the key, so a Keep never rebuilds the editor. -->
						{#key activeBodyKey}
							<ArtifactBody
								artifactId={activeDocument.artifactId ?? activeDocument.id}
								kind={activeArtifactKind}
								title={getDocumentTitle(activeDocument)}
								body={null}
								{conversationId}
								alfyActivity={bodyAlfyActivity}
								registerPanelActions={(actions) => reportFromBody({ actions })}
								onCommentCountChange={(count) => reportFromBody({ commentCount: count })}
								onCommentsShownChange={(shown) => reportFromBody({ commentsShown: shown })}
								onOpenItem={onOpenDocument ? handleBodyOpenItem : undefined}
								onOpenHistory={() => void openHistory()}
								onPendingReviewCountChange={handleBodyPendingReviewCountChange}
								onReplayTour={bodyReplayTour}
								tourSummary={bodyTourSummary}
								{currentUser}
							/>
						{/key}
					{/if}
				{:else if compareMode && comparedDocument}
					<div class="workspace-compare">
					<div class="workspace-compare-header">
						<div class="workspace-compare-header-left">
							<div>
								<div class="workspace-compare-title">{$t('documentWorkspace.compareVersionsTitle')}</div>
								{#if compareSummary}
									<div class="workspace-compare-summary">
										{$t('documentWorkspace.compareSummary', { changed: compareSummary.changedLines, added: compareSummary.addedLines, removed: compareSummary.removedLines })}
									</div>
								{/if}
							</div>
							<button
								type="button"
								class="btn-icon-bare workspace-sync-scroll-button"
								class:workspace-sync-scroll-active={syncScrollEnabled}
								onclick={toggleSyncScroll}
								aria-label={syncScrollEnabled ? $t('documentWorkspace.disableSyncScroll') : $t('documentWorkspace.enableSyncScroll')}
								title={syncScrollEnabled ? $t('documentWorkspace.disableSyncScroll') : $t('documentWorkspace.enableSyncScroll')}
								aria-pressed={syncScrollEnabled}
							>
							<Link size={16} strokeWidth={2} aria-hidden="true" />
							</button>
						</div>
						<label class="workspace-compare-select-wrap">
							<span class="workspace-compare-select-label">{$t('documentWorkspace.against')}</span>
							<select
								class="workspace-compare-select"
								bind:value={compareDocumentId}
							>
								{#each familyDocuments.filter((document) => document.id !== activeDocument.id) as document (document.id)}
									<option value={document.id}>
										{getDocumentVersionLabel(document) ?? getDocumentTitle(document)}
									</option>
								{/each}
							</select>
						</label>
					</div>

						{#if compareLoading}
							<div class="workspace-compare-state">{$t('documentWorkspace.loadingComparison')}</div>
						{:else if compareError}
							<div class="workspace-compare-state workspace-compare-state-error">{compareError}</div>
						{:else if compareCurrentTextHtml && compareOtherTextHtml}
							<div class="workspace-compare-grid">
								<section class="workspace-compare-panel">
									<div class="workspace-compare-panel-head">
										<span class="workspace-compare-panel-label">{$t('documentWorkspace.current')}</span>
										<span class="workspace-compare-panel-meta">{getDocumentTitle(activeDocument)} {getDocumentVersionLabel(activeDocument) ?? ''}</span>
									</div>
									<div class="workspace-compare-panel-body" bind:this={leftPanelBody} onscroll={() => syncScroll(leftPanelBody, rightPanelBody)}>
										{@html compareCurrentTextHtml}
									</div>
								</section>
								<section class="workspace-compare-panel">
									<div class="workspace-compare-panel-head">
										<span class="workspace-compare-panel-label">{$t('documentWorkspace.compared')}</span>
										<span class="workspace-compare-panel-meta">{getDocumentTitle(comparedDocument)} {getDocumentVersionLabel(comparedDocument) ?? ''}</span>
									</div>
									<div class="workspace-compare-panel-body" bind:this={rightPanelBody} onscroll={() => syncScroll(rightPanelBody, leftPanelBody)}>
										{@html compareOtherTextHtml}
									</div>
								</section>
							</div>
						{/if}
					</div>
				{:else}
					{#if shouldRenderMobilePreview}
						{#await ensureDocumentPreviewRendererModule() then { default: DocumentPreviewRendererComponent }}
							<DocumentPreviewRendererComponent
								open={true}
								artifactId={activeDocument.artifactId ?? null}
								previewUrl={activeDocument.previewUrl ?? null}
								filename={activeDocument.filename}
								mimeType={activeDocument.mimeType}
								onClose={handleCloseWorkspace}
								bind:currentPage={currentPage}
								bind:totalPages={currentTotalPages}
							/>
						{:catch}
							<div class="workspace-compare-state workspace-compare-state-error">
								Failed to load document preview.
							</div>
						{/await}
					{/if}
				{/if}
			</div>
			{#if shouldRenderMobilePreview}
				{@render historySlot()}
			{/if}
			</div>
		</section>
	</div>

	<!-- An expanded panel floats over the page and leaves its column standing, so what sits beside it keeps its width. -->
	{#if reserveDock && shellPresentation === "expanded"}
		<div
			class="workspace-dock-spacer"
			class:workspace-fade-in={isVisible}
			bind:this={dockSpacerElement}
			style:--workspace-dock-width={dockedWidthCss(workspaceWidth)}
			aria-hidden="true"
		></div>
	{/if}

	<!-- Desktop / tablet side pane -->
	<aside 
		bind:this={desktopShellElement}
		{@attach overDialog ? desktopTrap : undefined}
		role={overDialog ? "dialog" : undefined}
		aria-modal={overDialog ? "true" : undefined}
		class="workspace-shell workspace-shell-desktop"
		class:workspace-fade-in={isVisible}
		class:workspace-resizing={isResizing}
		class:workspace-shell-expanded={shellPresentation === "expanded"}
		class:workspace-shell-docked={shellPresentation === "docked"}
		style:--workspace-dock-width={dockedWidthCss(workspaceWidth)}
		style:transition={shellPresentation === 'expanded'
			? 'opacity 180ms ease-out, transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)'
			: undefined}
		style:opacity={shellPresentation === 'expanded' ? (isVisible ? '1' : '0') : undefined}
		style:transform={shellPresentation === 'expanded' ? desktopShellTransform : undefined}
		aria-label={panelLandmarkLabel}
	>
		<div 
			class="workspace-resize-handle" 
			data-testid="resize-handle"
			onmousedown={startResize}
			ondblclick={resetWorkspaceWidth}
			onkeydown={handleResizeKeyDown}
			role="slider"
			aria-label={$t('documentWorkspace.resizePanel')}
			aria-valuemin={MIN_WIDTH}
			aria-valuemax={typeof window !== 'undefined' ? Math.floor(window.innerWidth * MAX_WIDTH_RATIO) : 800}
			aria-valuenow={workspaceWidth}
			tabindex="0"
		></div>
		<div
			class="workspace-content"
			bind:this={desktopContentElement}
			style:width={shellPresentation === 'docked' && dockContentWidth !== null ? `${dockContentWidth}px` : undefined}
		>
		{#if activeDocument.kind}
			<ArtifactPanelHeader
				kind={activeArtifactKind}
				title={getDocumentTitle(activeDocument)}
				phrase={activeMomentPhrase}
				onHistory={kindHasHistory(activeArtifactKind) ? toggleHistory : undefined}
				{historyOpen}
				onBack={list ? handleBackToList : undefined}
				actions={artifactHeaderActionsSnippet}
			/>
		{:else}
			<div class="workspace-header">
				<div class="workspace-heading">
					<div class="workspace-eyebrow">
						{$t('documentWorkspace.workingDocument')}
					</div>
					<div class="workspace-title-row">
						{#if canJumpToSource(activeDocument)}
							<button
								type="button"
								class="workspace-title workspace-title-link"
								onclick={() => onJumpToSource?.(activeDocument)}
								title={$t('documentWorkspace.viewSourceMessage')}
							>
								<span>{getDocumentTitle(activeDocument)}</span>
								<span class="workspace-title-source-icon">
									<ArrowUpRight size={14} strokeWidth={2.1} aria-hidden="true" />
								</span>
							</button>
						{:else}
							<div class="workspace-title">
								<span>{getDocumentTitle(activeDocument)}</span>
							</div>
						{/if}
						<div class="workspace-header-actions">
							{@render artifactPanelActions()}
							{@render atlasDownloadControl(activeDocument)}
							{#if showPresentationToggle && presentation !== "expanded"}
								<button
									type="button"
									class="btn-icon-bare workspace-expand-button"
									onclick={requestExpandedPresentation}
									aria-label={$t('documentWorkspace.expandWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
									title={$t('documentWorkspace.expandWorkspace')}
								>
									<Maximize2 size={18} strokeWidth={2} aria-hidden="true" />
								</button>
							{:else if showPresentationToggle && returnToDockedOnExpandedClose}
								<button
									type="button"
									class="btn-icon-bare workspace-dock-button"
									onclick={() => void requestDockedPresentation()}
									aria-label={$t('documentWorkspace.collapseWorkspaceLabel', { title: getDocumentTitle(activeDocument) })}
									title={$t('documentWorkspace.collapseWorkspace')}
								>
									<Minimize2 size={18} strokeWidth={2} aria-hidden="true" />
								</button>
							{/if}
							<button
								type="button"
								class="btn-icon-bare workspace-close-button"
								onclick={handleCloseWorkspace}
								aria-label={$t('documentWorkspace.closeWorkspace')}
							>
								<X size={18} strokeWidth={2.1} aria-hidden="true" />
							</button>
						</div>
					</div>
					{#if getDocumentSubtitle(activeDocument)}
						<div class="workspace-subtitle">{getDocumentSubtitle(activeDocument)}</div>
					{/if}
					<div class="workspace-meta-row" data-testid="document-provenance">
						<span class="workspace-source-pill" class:workspace-source-pill-ai={isAiGeneratedDocument(activeDocument)}>
							{#if isAiGeneratedDocument(activeDocument)}
								<span class="workspace-source-sparkle">
									<Sparkles size={13} strokeWidth={2.1} aria-hidden="true" />
								</span>
							{/if}
							<span>{getDocumentSourceLabel(activeDocument)}</span>
						</span>
						{#if canCompareActiveDocument}
							<button
								type="button"
								class="workspace-compare-toggle"
								class:workspace-compare-toggle-active={compareMode}
								onclick={() => {
									compareMode = !compareMode;
								}}
								aria-label={compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
								title={compareMode ? $t('documentWorkspace.closeCompare') : $t('documentWorkspace.compareVersions')}
								aria-pressed={compareMode}
							>
								<ArrowLeftRight size={13} strokeWidth={2.1} aria-hidden="true" />
							</button>
						{/if}
						{#if getDocumentLifecycleLabel(activeDocument)}
							<span class="workspace-status-badge">
								{getDocumentLifecycleLabel(activeDocument)}
							</span>
						{/if}
					</div>
				</div>
			</div>
		{/if}

	<div
		class="workspace-main"
		class:workspace-main-expanded={presentation === "expanded"}
		data-testid="workspace-main"
		data-presentation={presentation}
		data-layout={documents.length > 1 ? "rail-and-preview" : "preview-only"}
	>
		{#if !activeDocument.kind}
			<!--
				Wave 2.5 Step 13: completes §9.2's original "hides OpenDocumentsRail
				for every artifact kind" — App now hides it too (agent 2 had only
				hidden it for Document; App's own panel work was still pending).
				The panel's own breadcrumb back to "This chat" (list rows,
				chrome="row") replaces the rail's "switch between multiple open
				items" role for every artifact kind now: the security test that
				used to switch Apps through the rail (its own persisted iframe
				WindowProxy proved the cross-app storage-isolation guarantee) now
				switches through the list instead — the SAME `{#key src}` remount
				in AppFrame.svelte fires either way, so it is still exercising the
				real mechanism, not a weaker substitute (see
				tests/e2e/artifact-app.spec.ts). Canvas/Slides have no body yet, so
				this is currently only observable for App/File; the rail still
				serves legacy, non-artifact items (uploaded library documents,
				old produced-file opens) that carry no `.kind` at all.
			-->
			<OpenDocumentsRail
				{documents}
				activeDocumentId={activeDocument.id}
				{onSelectDocument}
				{onJumpToSource}
				{onCloseDocument}
			/>
		{/if}

		<div class="workspace-document-column" data-testid="workspace-document-column">
			{#if familyDocuments.length > 1}
				 <div class="workspace-history" data-testid="document-version-control" aria-label={$t('documentWorkspace.versionHistory')}>
					<div class="workspace-history-label">{$t('documentWorkspace.versionHistory')}</div>
					<div class="workspace-history-list">
						{#each familyDocuments as document (document.id)}
							<button
						type="button"
						class="workspace-history-chip workspace-version-badge"
						class:workspace-history-chip-current={isCurrentFamilyDocument(document)}
						data-testid="document-version-badge"
						onclick={() => handleFamilyDocumentOpen(document)}
					>
								<div class="workspace-history-topline">
									<span
										class="workspace-history-version"
										class:workspace-history-version-current={isCurrentFamilyDocument(document)}
									>
										{getDocumentVersionLabel(document) ?? $t('documentWorkspace.version')}
									</span>
									{#if isLatestFamilyDocument(document)}
										<span class="workspace-history-badge">{$t('documentWorkspace.latest')}</span>
									{/if}
								</div>
								<div class="workspace-history-title">{getDocumentTitle(document)}</div>
							</button>
						{/each}
					</div>
				</div>
			{/if}

	<div class="workspace-stage">
	{#if shouldRenderDesktopPreview}
		{@render tourCard()}
	{/if}
	<div class="workspace-body" class:workspace-body-covered={historyOpen} inert={historyOpen} data-testid="page-scroll-container">
		{#if activeArtifactBodyLoader && shouldRenderDesktopPreview}
			{@const ArtifactBody = loadedArtifactBodies[activeArtifactKind]}
			{#if ArtifactBody}
				<!-- One body per open ITEM (final polish D1): keyed, so a swap to another
				     item mounts a body that registers its own header controls. A version
				     change keeps the key, so a Keep never rebuilds the editor. -->
				{#key activeBodyKey}
					<ArtifactBody
						artifactId={activeDocument.artifactId ?? activeDocument.id}
						kind={activeArtifactKind}
						title={getDocumentTitle(activeDocument)}
						body={null}
						{conversationId}
						alfyActivity={bodyAlfyActivity}
						registerPanelActions={(actions) => reportFromBody({ actions })}
						onCommentCountChange={(count) => reportFromBody({ commentCount: count })}
						onCommentsShownChange={(shown) => reportFromBody({ commentsShown: shown })}
						onOpenItem={onOpenDocument ? handleBodyOpenItem : undefined}
						onOpenHistory={() => void openHistory()}
						onPendingReviewCountChange={handleBodyPendingReviewCountChange}
						onReplayTour={bodyReplayTour}
						tourSummary={bodyTourSummary}
						{currentUser}
					/>
				{/key}
			{/if}
		{:else if compareMode && comparedDocument}
			<div class="workspace-compare">
				<div class="workspace-compare-header">
					<div class="workspace-compare-header-left">
						<div>
							<div class="workspace-compare-title">{$t('documentWorkspace.compareVersionsTitle')}</div>
							{#if compareSummary}
								<div class="workspace-compare-summary">
									{$t('documentWorkspace.compareSummary', { changed: compareSummary.changedLines, added: compareSummary.addedLines, removed: compareSummary.removedLines })}
								</div>
							{/if}
						</div>
						<button
							type="button"
							class="btn-icon-bare workspace-sync-scroll-button"
							class:workspace-sync-scroll-active={syncScrollEnabled}
							onclick={toggleSyncScroll}
							aria-label={syncScrollEnabled ? $t('documentWorkspace.disableSyncScroll') : $t('documentWorkspace.enableSyncScroll')}
							title={syncScrollEnabled ? $t('documentWorkspace.disableSyncScroll') : $t('documentWorkspace.enableSyncScroll')}
							aria-pressed={syncScrollEnabled}
						>
							<Link size={16} strokeWidth={2} aria-hidden="true" />
						</button>
					</div>
					<label class="workspace-compare-select-wrap">
						<span class="workspace-compare-select-label">{$t('documentWorkspace.against')}</span>
						<select class="workspace-compare-select" bind:value={compareDocumentId}>
							{#each familyDocuments.filter((document) => document.id !== activeDocument.id) as document (document.id)}
								<option value={document.id}>
									{getDocumentVersionLabel(document) ?? getDocumentTitle(document)}
								</option>
							{/each}
						</select>
					</label>
				</div>

				{#if compareLoading}
					<div class="workspace-compare-state">{$t('documentWorkspace.loadingComparison')}</div>
				{:else if compareError}
					<div class="workspace-compare-state workspace-compare-state-error">{compareError}</div>
				{:else if compareCurrentTextHtml && compareOtherTextHtml}
					<div class="workspace-compare-grid">
						<section class="workspace-compare-panel">
							<div class="workspace-compare-panel-head">
								<span class="workspace-compare-panel-label">{$t('documentWorkspace.current')}</span>
								<span class="workspace-compare-panel-meta">{getDocumentTitle(activeDocument)} {getDocumentVersionLabel(activeDocument) ?? ''}</span>
							</div>
							<div class="workspace-compare-panel-body" bind:this={leftPanelBody} onscroll={() => syncScroll(leftPanelBody, rightPanelBody)}>
								{@html compareCurrentTextHtml}
							</div>
						</section>
						<section class="workspace-compare-panel">
							<div class="workspace-compare-panel-head">
								<span class="workspace-compare-panel-label">{$t('documentWorkspace.compared')}</span>
								<span class="workspace-compare-panel-meta">{getDocumentTitle(comparedDocument)} {getDocumentVersionLabel(comparedDocument) ?? ''}</span>
							</div>
							<div class="workspace-compare-panel-body" bind:this={rightPanelBody} onscroll={() => syncScroll(rightPanelBody, leftPanelBody)}>
								{@html compareOtherTextHtml}
							</div>
						</section>
					</div>
				{/if}
			</div>
			{:else}
				{#if shouldRenderDesktopPreview}
					{#await ensureDocumentPreviewRendererModule() then { default: DocumentPreviewRendererComponent }}
						<DocumentPreviewRendererComponent
							open={true}
							artifactId={activeDocument.artifactId ?? null}
							previewUrl={activeDocument.previewUrl ?? null}
							filename={activeDocument.filename}
							mimeType={activeDocument.mimeType}
							onClose={handleCloseWorkspace}
							bind:currentPage={currentPage}
							bind:totalPages={currentTotalPages}
						/>
					{:catch}
						<div class="workspace-compare-state workspace-compare-state-error">
							{$t('documentWorkspace.previewLoadFailed')}
						</div>
					{/await}
				{/if}
			{/if}
	</div>
	{#if shouldRenderDesktopPreview}
		{@render historySlot()}
	{/if}
	</div>
		</div>
	</div>
	</div>
</aside>
{#if deleteConfirmOpen && canDeleteItem(activeDocument)}
	{@const deletingItem = activeDocument}
	<ArtifactDeletePopover
		kind={activeArtifactKind}
		title={getDocumentTitle(deletingItem)}
		anchorTestId="artifact-delete-button"
		regenerable={canRegenerateItem(deletingItem)}
		onConfirm={() => deleteOpenItem(deletingItem)}
		onClose={() => (deleteConfirmOpen = false)}
	/>
{/if}
{/if}

<style>
	.workspace-mobile-backdrop {
		position: fixed;
		inset: 0;
		z-index: 95;
		display: flex;
		align-items: stretch;
		justify-content: stretch;
		background: color-mix(in srgb, var(--surface-overlay) 70%, transparent 30%);
		backdrop-filter: blur(10px);
	}

	.workspace-shell {
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--surface-page);
	}

	.workspace-shell-mobile {
		position: relative;
		z-index: 1;
		height: 100%;
		width: 100%;
	}

	.workspace-shell-desktop,
	.workspace-dock-spacer {
		display: none;
	}

	.workspace-header {
		display: block;
		padding: 0.95rem 1rem;
		border-left: 1px solid var(--border-default);
		border-bottom: 1px solid var(--border-default);
		background:
			linear-gradient(180deg, color-mix(in srgb, var(--surface-elevated) 92%, transparent 8%), var(--surface-page));
	}

	.workspace-shell-mobile .workspace-header {
		border-left: none;
		padding: 0.72rem 0.82rem 0.68rem;
	}

	.workspace-shell-mobile .workspace-eyebrow {
		font-size: 0.64rem;
		letter-spacing: 0.1em;
	}

	.workspace-shell-mobile .workspace-title-row {
		align-items: flex-start;
		gap: 0.55rem;
	}

	.workspace-shell-mobile .workspace-title {
		white-space: normal;
		font-size: 0.94rem;
		line-height: 1.25;
	}

	.workspace-shell-mobile .workspace-title span {
		display: -webkit-box;
		line-clamp: 2;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.workspace-shell-mobile .workspace-subtitle {
		margin-top: 0.24rem;
		font-size: 0.72rem;
	}

	.workspace-shell-mobile .workspace-meta-row {
		gap: 0.28rem;
		margin-top: 0.28rem;
	}

	.workspace-shell-mobile .workspace-source-pill,
	.workspace-shell-mobile .workspace-status-badge,
	.workspace-shell-mobile .workspace-compare-toggle {
		padding: 0.14rem 0.38rem;
		font-size: 0.62rem;
	}

	.workspace-heading {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.workspace-eyebrow {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.workspace-title {
		display: inline-flex;
		align-items: center;
		gap: 0.38rem;
		min-width: 0;
		max-width: 100%;
		margin-top: 0;
		border: none;
		background: transparent;
		padding: 0;
		font-family: 'Libre Baskerville', serif;
		font-size: 1rem;
		line-height: 1.35;
		color: var(--text-primary);
		text-align: left;
		white-space: nowrap;
	}

	.workspace-title span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.workspace-title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.8rem;
		min-width: 0;
		margin-top: 0.22rem;
	}

	.workspace-title-link {
		cursor: pointer;
	}

	.workspace-title-link:hover,
	.workspace-title-link:focus-visible {
		color: var(--text-primary);
	}

	.workspace-title-link:focus-visible {
		border-radius: 0.25rem;
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 70%, transparent 30%);
		outline-offset: 0.18rem;
	}

	.workspace-title-source-icon {
		flex: 0 0 auto;
		color: var(--icon-muted);
		opacity: 0.58;
		transition:
			color 180ms ease,
			opacity 180ms ease,
			transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.workspace-title-link:hover .workspace-title-source-icon,
	.workspace-title-link:focus-visible .workspace-title-source-icon {
		color: var(--text-primary);
		opacity: 1;
		transform: translate(2px, -2px);
	}

	.workspace-subtitle {
		margin-top: 0.3rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.78rem;
		font-weight: 500;
		letter-spacing: 0.02em;
		color: var(--text-secondary);
	}

	.workspace-meta-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem;
		margin-top: 0.38rem;
		min-width: 0;
	}

	.workspace-source-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-elevated) 66%, var(--surface-page) 34%);
		padding: 0.18rem 0.46rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 650;
		line-height: 1.25;
		color: var(--text-muted);
	}

	.workspace-source-pill-ai {
		border-color: color-mix(in srgb, var(--border-default) 72%, var(--text-primary) 28%);
		background: color-mix(in srgb, var(--surface-page) 76%, var(--surface-elevated) 24%);
		color: var(--text-secondary);
	}

	.workspace-source-sparkle {
		flex: 0 0 auto;
		color: var(--text-primary);
	}

	.workspace-compare-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.68rem;
		height: 1.68rem;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface-elevated) 66%, var(--surface-page) 34%);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			border-color var(--duration-fast) ease,
			background-color var(--duration-fast) ease,
			color var(--duration-fast) ease,
			transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
			box-shadow var(--duration-fast) ease;
	}

	.workspace-compare-toggle:hover,
	.workspace-compare-toggle:focus-visible,
	.workspace-compare-toggle-active {
		border-color: color-mix(in srgb, var(--accent) 52%, var(--border-default) 48%);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-elevated) 88%);
		color: var(--text-primary);
	}

	.workspace-compare-toggle:hover {
		transform: translateY(-1px);
		box-shadow: 0 7px 16px color-mix(in srgb, var(--shadow-color, #000) 9%, transparent 91%);
	}

	.workspace-compare-toggle:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 70%, transparent 30%);
		outline-offset: 0.16rem;
	}

	/* Touch devices: grow the hit area to the ≥44px accessible minimum
	 * without changing the icon's visual size. The query mirrors
	 * isTouchDevice() (hover: none + pointer: coarse), matching the pattern
	 * in CodeBlock.svelte. Applies in both the mobile and desktop shell
	 * branches since it targets the shared .workspace-compare-toggle class. */
	@media (hover: none) and (pointer: coarse) {
		.workspace-compare-toggle {
			width: 44px;
			height: 44px;
		}
	}

	.workspace-status-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.18rem 0.46rem;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--border-default) 76%, var(--accent) 24%);
		background: color-mix(in srgb, var(--surface-elevated) 70%, var(--accent) 30%);
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.workspace-close-button {
		flex-shrink: 0;
	}

	.workspace-header-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		flex-shrink: 0;
	}

	.workspace-mobile-documents-button {
		gap: 0.16rem;
		min-width: 2.45rem;
		color: var(--icon-muted);
		transition:
			background-color 160ms ease,
			color 160ms ease,
			transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}

	.workspace-mobile-documents-button:hover,
	.workspace-mobile-documents-button[aria-expanded="true"] {
		background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface-page) 22%);
		color: var(--text-primary);
	}

	.workspace-mobile-documents-button:hover {
		transform: translateY(-1px);
	}

	.workspace-mobile-documents-button span {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 700;
		line-height: 1;
	}

	.workspace-expand-button {
		color: var(--icon-muted);
	}

	.workspace-expand-button:hover {
		color: var(--text-primary);
	}

	/* Wave 2.5 Step 8: the header's Comments button — a plain icon button with
	   an overlaid open-thread badge, the same shape the mockup's own
	   `.btn-icon .count` uses. */
	.workspace-comments-button {
		position: relative;
	}

	/* Pressed = the comments are showing. The mockup's own `.btn-icon.is-on`:
	   a quiet tint and the primary icon colour, no border. */
	.workspace-comments-button[aria-pressed='true'] {
		background-color: var(--surface-elevated);
		color: var(--icon-primary);
	}

	.workspace-comments-count {
		position: absolute;
		top: 2px;
		right: 1px;
		min-width: 15px;
		height: 15px;
		padding: 0 4px;
		border-radius: var(--radius-full);
		background: var(--accent-fill);
		color: var(--on-accent);
		font-size: 9.5px;
		font-weight: 700;
		line-height: 15px;
		letter-spacing: 0;
		text-align: center;
	}

	.workspace-body {
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	/* History is a slot laid over the open body (ruling 76). The stage is the
	   area the body occupies; the body stays in it, laid out, so its scroll and its
	   selection are there when History is left. */
	.workspace-stage {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.workspace-body-covered {
		visibility: hidden;
	}

	/* The first-open tour card is a row of the stage's own column, ahead of the body:
	   the item starts under it, so the card covers nothing, and it is there from the
	   item's first frame whenever its answer was in hand (FX-2, ruling 77). */
	.workspace-tour-slot {
		flex: 0 0 auto;
		min-width: 0;
	}

	.workspace-history-slot {
		position: absolute;
		inset: 0;
		z-index: 3;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--surface-page);
	}

	/* The desktop shell's animatable content (redesign §7.2 #1–#4): a plain
	   pass-through flex column so wrapping the header + workspace-main for
	   `desktopContentElement` changes no existing layout. */
	.workspace-content {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
	}

	.workspace-main {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		border-left: 1px solid var(--border-default);
	}

	.workspace-main-expanded {
		background: color-mix(in srgb, var(--surface-page) 94%, var(--surface-elevated) 6%);
	}

	.workspace-document-column {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		flex-direction: column;
	}

	.workspace-main-expanded .workspace-document-column {
		flex: 1 1 min(76rem, 100%);
	}

	.workspace-compare {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		flex-direction: column;
		background: var(--surface-page);
	}

	.workspace-compare-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.9rem;
		padding: 0.95rem 1rem 0.8rem;
		border-bottom: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-elevated) 72%, var(--surface-page) 28%);
	}

	.workspace-compare-header-left {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.workspace-compare-title {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--text-primary);
	}

	.workspace-compare-summary {
		margin-top: 0.2rem;
		font-size: 0.76rem;
		color: var(--text-secondary);
	}

	.workspace-compare-select-wrap {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
	}

	.workspace-compare-select-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.workspace-compare-select {
		min-width: 9rem;
		padding: 0.45rem 0.72rem;
		border: 1px solid var(--border-default);
		border-radius: 0.75rem;
		background: var(--surface-page);
		font-size: 0.8rem;
		color: var(--text-primary);
	}

	.workspace-compare-state {
		padding: 1rem;
		font-size: 0.86rem;
		color: var(--text-secondary);
	}

	.workspace-compare-state-error {
		color: var(--danger);
	}

	.workspace-sync-scroll-button {
		color: var(--text-muted);
		transition: color 150ms var(--ease-out);
	}

	.workspace-sync-scroll-button:hover {
		color: var(--text-secondary);
	}

	.workspace-sync-scroll-button.workspace-sync-scroll-active {
		color: var(--accent);
	}

	.workspace-compare-grid {
		display: grid;
		flex: 1 1 auto;
		min-height: 0;
		grid-template-columns: 1fr;
	}

	.workspace-compare-panel {
		display: flex;
		min-height: 0;
		flex-direction: column;
		border-bottom: 1px solid var(--border-default);
	}

	.workspace-compare-panel:last-child {
		border-bottom: none;
	}

	.workspace-compare-panel-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.8rem 1rem;
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--surface-page) 90%, transparent 10%);
	}

	.workspace-compare-panel-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.workspace-compare-panel-meta {
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.workspace-compare-panel-body {
		min-height: 0;
		flex: 1 1 auto;
		overflow: auto;
		padding: 1rem;
	}

	.workspace-compare-panel-body :global(pre) {
		margin: 0;
	}

	.workspace-compare-panel-body :global(.workspace-diff) {
		width: max-content;
		min-width: 100%;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
		font-size: 0.78rem;
		line-height: 1.55;
	}

	.workspace-compare-panel-body :global(.workspace-diff code) {
		display: block;
		width: max-content;
		min-width: 100%;
	}

	.workspace-compare-panel-body :global(.workspace-diff-line) {
		display: grid;
		grid-template-columns: 2.15rem minmax(max-content, 1fr);
		width: max-content;
		min-width: 100%;
		border-left: 3px solid transparent;
	}

	.workspace-compare-panel-body :global(.workspace-diff-line-added) {
		border-left-color: color-mix(in srgb, var(--success, #248a3d) 70%, var(--border-default) 30%);
		background: color-mix(in srgb, var(--success, #248a3d) 14%, transparent 86%);
	}

	.workspace-compare-panel-body :global(.workspace-diff-line-removed) {
		border-left-color: color-mix(in srgb, var(--danger) 70%, var(--border-default) 30%);
		background: color-mix(in srgb, var(--danger) 12%, transparent 88%);
	}

	.workspace-compare-panel-body :global(.workspace-diff-gutter) {
		position: sticky;
		left: 0;
		z-index: 1;
		display: inline-flex;
		align-items: flex-start;
		justify-content: center;
		background: inherit;
		color: var(--text-muted);
		font-weight: 700;
		user-select: none;
	}

	.workspace-compare-panel-body :global(.workspace-diff-content) {
		display: inline-block;
		min-width: 0;
		padding-right: 1rem;
		white-space: pre;
	}

	.workspace-history {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.42rem;
		padding: 0.58rem 0.75rem 0.64rem;
		border-bottom: 1px solid var(--border-default);
		background: color-mix(in srgb, var(--surface-page) 94%, transparent 6%);
	}

	.workspace-history-label {
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.workspace-history-list {
		display: flex;
		min-width: 0;
		gap: 0.35rem;
		overflow-x: auto;
		padding: 0.18rem 0.1rem 0.42rem;
	}

	.workspace-history-chip {
		display: inline-flex;
		flex-direction: column;
		align-items: stretch;
		min-width: 8.5rem;
		max-width: 13.5rem;
		gap: 0.28rem;
		padding: 0.36rem 0.48rem;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: var(--surface-elevated);
		text-align: left;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			border-color var(--duration-fast) ease,
			background-color var(--duration-fast) ease,
			color var(--duration-fast) ease,
			transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
			box-shadow var(--duration-fast) ease;
	}

	.workspace-history-chip:hover {
		border-color: var(--border-strong);
		background: color-mix(in srgb, var(--surface-elevated) 86%, var(--surface-page) 14%);
		color: var(--text-primary);
		transform: translateY(-1px);
		box-shadow: 0 8px 18px color-mix(in srgb, var(--shadow-color, #000) 10%, transparent 90%);
	}

	.workspace-version-badge {
		flex: 0 0 auto;
	}

	.workspace-history-chip-current {
		border-color: color-mix(in srgb, var(--text-primary) 18%, var(--border-default) 82%);
		background: color-mix(in srgb, var(--surface-elevated) 78%, var(--surface-page) 22%);
		color: var(--text-primary);
	}

	.workspace-history-topline {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}

	.workspace-history-version,
	.workspace-history-badge {
		display: inline-flex;
		align-items: center;
		border-radius: 0.35rem;
		padding: 0.1rem 0.34rem;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.62rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.workspace-history-version {
		border: 1px solid var(--border-default);
		color: var(--text-secondary);
		background: var(--surface-page);
	}

	.workspace-history-version-current {
		border-color: color-mix(in srgb, var(--accent) 68%, var(--border-default) 32%);
		background: color-mix(in srgb, var(--accent) 16%, var(--surface-page) 84%);
		color: var(--text-primary);
	}

	.workspace-history-badge {
		color: var(--text-muted);
		background: color-mix(in srgb, var(--surface-page) 85%, transparent 15%);
	}

	.workspace-history-title {
		min-width: 0;
		font-family: 'Nimbus Sans L', sans-serif;
		font-size: 0.76rem;
		line-height: 1.2;
		color: inherit;
		white-space: nowrap;
		text-overflow: ellipsis;
		overflow: hidden;
	}

	@media (min-width: 768px) {
		/* The docked panel is a column beside the chat, and its WIDTH is what
		   moves (FB-3, F4; redesign §7.2 #1/#2): 0 when it is closed, the width
		   the dock arithmetic gives it (--workspace-dock-width, resolved against
		   the stage by the browser) when it is open. The chat column takes
		   what it leaves, so the two change together, frame for frame. It opens
		   on --ease-emphasis over the emphasis duration and closes on --ease-in
		   over the standard one; the content has its own entrance (WAAPI) and
		   sits at the width it is growing to (below), so it is never re-flowed
		   through the widths on the way. */
		.workspace-shell-desktop {
			display: flex;
			position: relative;
			flex: 0 0 auto;
			width: 0;
			min-width: 0;
			max-width: none;
			overflow: hidden;
			border-left: 1px solid var(--border-subtle);
			background: var(--surface-page);
			transition: width var(--duration-standard) var(--ease-in);
		}

		.workspace-shell-desktop.workspace-fade-in {
			width: var(--workspace-dock-width);
			transition: width var(--duration-emphasis) var(--ease-emphasis);
		}

		/* The column an expanded panel leaves standing: it opens and closes
		   exactly as the docked panel does, so the chat beside it moves with
		   the panel's coming and going and not with its shape. */
		.workspace-dock-spacer {
			display: block;
			flex: 0 0 auto;
			width: 0;
			transition: width var(--duration-standard) var(--ease-in);
		}

		.workspace-dock-spacer.workspace-fade-in {
			width: var(--workspace-dock-width);
			transition: width var(--duration-emphasis) var(--ease-emphasis);
		}

		/* The content of a docked column stays at the width the column is
		   growing to and is shown through it from the right edge. */
		.workspace-shell-docked > .workspace-content {
			position: absolute;
			top: 0;
			right: 0;
			bottom: 0;
		}

		.workspace-shell-expanded {
			position: fixed;
			top: 1.25rem;
			right: max(1.25rem, calc((100vw - 1600px) / 2));
			bottom: 1.25rem;
			left: max(1.25rem, calc((100vw - 1600px) / 2));
			z-index: 115;
			width: auto;
			max-width: none;
			min-width: 0;
			border: 1px solid var(--border-default);
			border-radius: 0.8rem;
			box-shadow: var(--shadow-lg);
		}

		.workspace-shell-expanded .workspace-resize-handle {
			display: none;
		}

		.workspace-shell-expanded.workspace-fade-in {
			/* Expanded mode owns its own width (auto, fixed-position) and its
			   own opacity/transform crossfade timing (inline). */
			width: auto;
			transition: opacity 180ms ease-out, transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
		}

		.workspace-shell-desktop.workspace-resizing {
			transition: none;
		}

		.workspace-resize-handle {
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 4px;
			cursor: col-resize;
			background: transparent;
			z-index: 10;
		}

		.workspace-resize-handle:hover {
			background: var(--accent);
		}

		.workspace-compare-grid {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}

		.workspace-compare-panel {
			border-bottom: none;
		}

		.workspace-compare-panel + .workspace-compare-panel {
			border-left: 1px solid var(--border-default);
		}

		.workspace-mobile-backdrop {
			display: none;
		}
	}

	.workspace-shell-mobile .workspace-expand-button {
		display: none;
	}

	.workspace-download-dropdown {
		position: relative;
		display: inline-flex;
	}

	.workspace-download-menu {
		position: absolute;
		top: calc(100% + 0.35rem);
		right: 0;
		z-index: 5;
		display: grid;
		min-width: 11rem;
		gap: 0.15rem;
		border: 1px solid color-mix(in srgb, var(--border-default) 84%, transparent);
		border-radius: var(--radius-sm);
		background: var(--surface-elevated);
		padding: 0.3rem;
		box-shadow: var(--shadow-md, 0 0.8rem 2rem rgb(0 0 0 / 16%));
	}

	.workspace-download-option {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		border-radius: calc(var(--radius-sm) - 2px);
		padding: 0.48rem 0.55rem;
		color: var(--text-primary);
		font-size: var(--text-sm);
		text-decoration: none;
		transition:
			transform 140ms ease,
			background-color 140ms ease;
	}

	.workspace-download-option:hover {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		transform: translateX(1px);
	}

	.workspace-download-option:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus-ring) 36%, transparent);
	}

	.workspace-history-toggle-button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	/* ArtifactPanelHeader's actions (Wave 2.5 Step 3): the divider between
	   Download and Expand, mirroring the mockup's `.ph-actions .div`. */
	.artifact-panel-header-actions-div {
		width: 1px;
		height: 1.125rem;
		margin: 0 0.25rem;
		background: var(--border-default);
	}

	/* Polish G2-A: the row's overflow and the header's trash button. */
	.artifact-row-menu-button {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-md);
		color: var(--icon-muted);
	}

	.artifact-row-menu-button:hover,
	.artifact-row-menu-button:global([aria-expanded='true']) {
		background: var(--surface-elevated);
		color: var(--text-primary);
	}

	.workspace-delete-button:hover {
		color: var(--danger);
	}

	@media (hover: none) and (pointer: coarse) {
		.artifact-row-menu-button {
			width: 44px;
			height: 44px;
		}
	}

	.artifact-panel-list-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-md, 1rem);
	}

	.artifact-panel-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		padding: var(--space-lg, 1.5rem);
		color: var(--text-muted);
		font-size: var(--text-sm);
		text-align: center;
	}

	.artifact-panel-list-rows {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs, 0.375rem);
		margin: 0;
		padding: 0;
		list-style: none;
	}
</style>
