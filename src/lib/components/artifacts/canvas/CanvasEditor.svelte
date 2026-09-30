<script lang="ts">
/**
 * The Canvas's panel body (Feature 2 · Artifacts, Slice 3): what the artifact
 * panel mounts for a board. It loads the stored board, draws it with
 * `CanvasBoard`, and saves what the reader does; the shell around it (eyebrow,
 * title, version pill, actions) is the panel's own.
 *
 * Persistence is the Document's, deliberately: one debounced autosave loop
 * (`createDocumentAutosave`, which saves any string), one write route
 * (`saveArtifactBody`, with the version and body hash it last saw, so a second
 * writer is refused with a 409 rather than overwritten), one Versions sheet. The
 * board hands over whole steps only; a bare pan never reaches it, so looking
 * around a board never mints a version.
 *
 * Every version the server reports is announced by the client API module, and the
 * header reads it from there. Nothing here prints a version or an "edited" time.
 */
import { SvelteFlowProvider, ViewportPortal } from "@xyflow/svelte";
import { onDestroy, untrack } from "svelte";
import {
	type ArtifactDetailResponse,
	fetchArtifact,
	fetchCanvasChatBlocks,
	fetchCanvasReviewState,
	refreshCanvasBlock,
	saveArtifactBody,
	searchCanvasWeb,
} from "$lib/client/api/artifacts";
import { ApiError } from "$lib/client/api/http";
import type { ArtifactPanelBodyActions } from "$lib/components/artifacts/artifact-bodies";
import type { DocumentAlfyActivity } from "$lib/components/artifacts/document/alfy-activity";
import {
	createDocumentAutosave,
	type DocumentAutosaveResult,
} from "$lib/components/artifacts/document/document-autosave";
import { t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import type { CanvasBlockData } from "$lib/shared/artifacts/canvas-blocks";
import {
	boardJson,
	emptyCanvasBody,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import { needsPoster } from "./_lib/block-meta";
import type { BoardLayerApi } from "./_lib/board-layers";
import {
	type BlockRefreshResult,
	provideChatContext,
} from "./_lib/chat-context";
import type {
	CanvasPicturesController,
	PicturesBoard,
} from "./_lib/pictures-controller.svelte";
import type {
	CanvasCommentsController,
	catcherProps,
	pinsProps,
	selectionPillProps,
	toggleComments,
} from "./_lib/comments-controller.svelte";
import type {
	CanvasReviewController,
	changeLayerProps,
	ReviewHost,
	reviewActivity,
	reviewEnd,
	reviewKey,
	reviewReply,
	reviewRestore,
	reviewSummary,
} from "./_lib/review-controller.svelte";
import { judgeServerBoard } from "./_lib/server-board";
import type AlfyChangeLayer from "./AlfyChangeLayer.svelte";
import CanvasBoard from "./CanvasBoard.svelte";
import type CanvasComments from "./CanvasComments.svelte";
import type CanvasDownload from "./CanvasDownload.svelte";
import type CanvasSelectionPill from "./CanvasSelectionPill.svelte";
import type CanvasReviewBar from "./CanvasReviewBar.svelte";
import type CanvasReviewNotices from "./CanvasReviewNotices.svelte";
import type CommentCatcher from "./CommentCatcher.svelte";
import type CommentPins from "./CommentPins.svelte";

/** The comment components and what wires them to the controller, once they have loaded. */
type CommentViews = {
	CanvasComments: typeof CanvasComments;
	CanvasSelectionPill: typeof CanvasSelectionPill;
	CommentCatcher: typeof CommentCatcher;
	CommentPins: typeof CommentPins;
	catcherProps: typeof catcherProps;
	pinsProps: typeof pinsProps;
	selectionPillProps: typeof selectionPillProps;
	toggleComments: typeof toggleComments;
};

/** Alfy's change and what wires it to the controller, once the parts have loaded. */
type ReviewViews = {
	AlfyChangeLayer: typeof AlfyChangeLayer;
	CanvasReviewBar: typeof CanvasReviewBar;
	CanvasReviewNotices: typeof CanvasReviewNotices;
	changeLayerProps: typeof changeLayerProps;
	reviewActivity: typeof reviewActivity;
	reviewEnd: typeof reviewEnd;
	reviewKey: typeof reviewKey;
	reviewReply: typeof reviewReply;
	reviewRestore: typeof reviewRestore;
	reviewSummary: typeof reviewSummary;
};

interface Props {
	artifactId: string;
	kind?: string;
	title?: string;
	body?: string | null;
	/** The conversation the PANEL is showing (ruling 51): passed to every artifact route this body calls, so an incognito conversation's own board resolves. */
	conversationId?: string | null;
	/** Hands the panel header its Versions trigger. Download joins it with the PNG export. */
	registerPanelActions?: (actions: ArtifactPanelBodyActions) => void;
	onDirtyChange?: (dirty: boolean) => void;
	onBodyChange?: (body: string) => void;
	/** The open threads, for the header's Comments button: reported from load and after every change. */
	onCommentCountChange?: (openCount: number) => void;
	/** Whether the comments are showing (the column, the drawer or the sheet): the button is a pressed toggle. */
	onCommentsShownChange?: (shown: boolean) => void;
	/** Opens an item in the panel's own viewer (the file a File block names). Absent where the host cannot: the block is then a plain row. */
	onOpenItem?: (item: DocumentWorkspaceItem) => void;
	/**
	 * The latest artifact tool call the chat page knows about. A call of Alfy's on THIS
	 * board runs its arranging frame and lands its change (T6); the panel hands it over
	 * only if it was open while the call ran (`bodyAlfyActivity`), and a body built
	 * after the call settled restores the server's review state instead (below).
	 */
	alfyActivity?: DocumentAlfyActivity | null;
	/** The number behind the chat card, the list row and the count button: what waits for the reader. */
	onPendingReviewCountChange?: (count: number) => void;
	currentUser?: {
		id: string;
		displayName: string;
		profilePicture: string | null;
	} | null;
}

let {
	artifactId,
	title = "",
	conversationId = null,
	registerPanelActions,
	onDirtyChange,
	onBodyChange,
	onCommentCountChange,
	onCommentsShownChange,
	onOpenItem,
	alfyActivity = null,
	onPendingReviewCountChange,
	currentUser = null,
}: Props = $props();

// What the blocks made from the chat need from the panel: the conversation it is
// showing (an App block's frame and storage calls carry it, ruling 51), a way to
// open a file in the panel's viewer, and the read behind "From this chat".
provideChatContext({
	get conversationId() {
		return conversationId;
	},
	get openItem() {
		return onOpenItem;
	},
	load: () => fetchCanvasChatBlocks(artifactId, conversationId),
	refreshBlock: (nodeId, signal) => refreshBlock(nodeId, signal),
	searchWeb: (query, signal) =>
		searchCanvasWeb(artifactId, query, conversationId, undefined, signal),
});

type Phase = "loading" | "ready" | "load_error" | "no_access";
type SaveState =
	| "idle"
	| "saving"
	| "saved"
	| "offline"
	| "failed"
	| "conflict"
	| "deleted"
	| "tooLarge";

/** How long "Saved" stays up after a save lands. */
const SAVED_MS = 2500;

let phase = $state<Phase>("loading");
let saveState = $state<SaveState>("idle");
let boardBody = $state.raw<CanvasBody>(emptyCanvasBody());
/** Bumped to draw a different board (a load, a reload, a restore): the board is mounted afresh, never re-seeded. */
let boardKey = $state(0);
let droppedCount = $state(0);
let noticeDismissed = $state(false);
let versionsOpen = $state(false);
// The Versions sheet is the Document's own, and loads the first time it is opened.
let VersionsSheet = $state.raw<
	| typeof import("$lib/components/artifacts/document/VersionsSheet.svelte").default
	| null
>(null);
$effect(() => {
	if (!versionsOpen || VersionsSheet) return;
	let current = true;
	void import("$lib/components/artifacts/document/VersionsSheet.svelte").then(
		(module) => {
			if (current) VersionsSheet = module.default;
		},
	);
	return () => {
		current = false;
	};
});

let versionNumber: number | null = null;
let knownBodyHash: string | null = null;
let latestJson = "";
/** The board JSON the server last acknowledged: `latestJson` differs from it while a step of the reader's is unsaved. */
let savedJson = "";
let boardNodes: CanvasNode[] = [];
let loadToken = 0;
let savedTimer: ReturnType<typeof setTimeout> | null = null;
let boardApi = $state<{
	flush: () => CanvasBody;
	land: (body: CanvasBody) => void;
	current: () => CanvasBody;
	place: (positions: ReadonlyMap<string, { x: number; y: number }>) => void;
	hold: (on: boolean) => void;
	setBlockData: (id: string, data: CanvasBlockData) => boolean;
	setBlockPoster: PicturesBoard["setBlockPoster"];
	showPictures: PicturesBoard["showPictures"];
	markPosterFailed: PicturesBoard["markPosterFailed"];
	pictureSource: PicturesBoard["pictureSource"];
	nodeContentElement: PicturesBoard["nodeContentElement"];
	getCamera: PicturesBoard["getCamera"];
	setCamera: PicturesBoard["setCamera"];
} | null>(null);
let lastDropped = 0;
let editorWidth = $state(0);
let editorEl = $state<HTMLElement | null>(null);

// Comments load on demand (`comment-parts.ts`): when the board has threads to
// pin, or the reader presses Comment or picks the tool. Until then the header's
// count is read off what was loaded.
let loadedThreads = $state.raw<ArtifactComment[]>([]);
let commentViews = $state.raw<CommentViews | null>(null);
let comments = $state.raw<CanvasCommentsController | null>(null);
let commentsLoading: Promise<void> | null = null;

const autosave = createDocumentAutosave({
	save: async (json) => {
		const result = await saveArtifactBody(
			artifactId,
			json,
			versionNumber ?? undefined,
			conversationId,
			undefined,
			{ baseHash: knownBodyHash ?? undefined },
		);
		lastDropped = result.ok
			? (result.dropped?.nodes ?? 0) +
				(result.dropped?.edges ?? 0) +
				(result.dropped?.annotations ?? 0)
			: 0;
		return result;
	},
	onResult: handleSaveResult,
});

function clearSavedTimer(): void {
	if (savedTimer) clearTimeout(savedTimer);
	savedTimer = null;
}

function handleSaveResult(result: DocumentAutosaveResult, json: string): void {
	if (result.ok) {
		if (typeof result.version === "number") versionNumber = result.version;
		if (typeof result.bodyHash === "string") knownBodyHash = result.bodyHash;
		savedJson = json;
		const dirty = json !== latestJson;
		onDirtyChange?.(dirty);
		onBodyChange?.(json);
		if (lastDropped > 0) {
			droppedCount = lastDropped;
			noticeDismissed = false;
		}
		if (dirty) {
			saveState = "saving";
			return;
		}
		saveState = "saved";
		clearSavedTimer();
		savedTimer = setTimeout(() => {
			if (saveState === "saved") saveState = "idle";
		}, SAVED_MS);
		return;
	}
	clearSavedTimer();
	switch (result.reason) {
		case "not_found":
			saveState = "deleted";
			autosave.stop();
			break;
		case "too_large":
			saveState = "tooLarge";
			break;
		case "version_conflict":
		case "stale":
			// The reader's own steps stay on screen until they choose to reload.
			saveState = "conflict";
			autosave.stop();
			break;
		case "offline":
			saveState = "offline";
			break;
		default:
			saveState = "failed";
	}
}

function handleBoardChange(next: CanvasBody): void {
	if (autosave.stopped) return;
	setBoardNodes(next.nodes);
	latestJson = boardJson(next);
	saveState = "saving";
	onDirtyChange?.(true);
	autosave.schedule(latestJson);
}

/** Puts a save that could not reach the server (or was refused as broken) back in the queue. */
function retrySave(): void {
	if (autosave.stopped || latestJson === "") return;
	if (saveState !== "offline" && saveState !== "failed") return;
	saveState = "saving";
	autosave.schedule(latestJson);
}

async function load(id: string): Promise<void> {
	const token = ++loadToken;
	clearSavedTimer();
	phase = "loading";
	try {
		const detail = await fetchArtifact(id, conversationId);
		if (token !== loadToken) return;
		const stored = detail.artifact.body;
		const parsed: unknown = stored?.trim() ? JSON.parse(stored) : {};
		const read = normalizeCanvasBody(parsed);
		boardBody = read.body;
		droppedCount =
			read.dropped.nodes.length +
			read.dropped.edges.length +
			read.dropped.annotations.length;
		noticeDismissed = false;
		versionNumber = detail.artifact.versionNumber;
		knownBodyHash = detail.artifact.bodyHash;
		latestJson = boardJson(read.body);
		savedJson = latestJson;
		setBoardNodes(read.body.nodes, { commentsToo: false });
		loadedThreads = detail.comments;
		if (comments) {
			comments.threads = detail.comments;
			comments.setNodes(boardNodes);
		} else if (detail.comments.length > 0) {
			void ensureComments();
		}
		saveState = "idle";
		autosave.resume();
		onDirtyChange?.(false);
		boardKey += 1;
		phase = "ready";
		void restoreReview(id, token);
	} catch (error) {
		if (token !== loadToken) return;
		phase =
			error instanceof ApiError && error.status === 404
				? "no_access"
				: "load_error";
	}
}

/** What Alfy reads is what is SAVED, so the reader's last step is saved (and the save acknowledged) before a comment asks it anything. */
async function saveBoardNow(): Promise<void> {
	boardApi?.flush();
	await autosave.flush();
}

/**
 * A live-web block's Refresh. What is searched is the query STORED on the block,
 * which the server reads from the SAVED board, so the reader's last step is saved
 * first (and a block inserted a moment ago is there to be found). The server
 * writes nothing: the new snapshot comes back and is put on the board as a step
 * of the reader's own, which the board's autosave keeps as their version — one
 * writer, so no save of theirs can be refused because a refresh landed in between.
 */
async function refreshBlock(
	nodeId: string,
	signal?: AbortSignal,
): Promise<BlockRefreshResult> {
	await saveBoardNow();
	if (signal?.aborted) return { ok: false, reason: "refresh_failed" };
	const result = await refreshCanvasBlock(
		artifactId,
		nodeId,
		conversationId,
		undefined,
		signal,
	);
	if (!result.ok) return result;
	// The block can be gone (deleted while the search ran), or the board unable to
	// change (a conflict arrived): the snapshot is not put anywhere then.
	return boardApi?.setBlockData(result.nodeId, result.data)
		? { ok: true }
		: { ok: false, reason: "not_found" };
}

/**
 * Every read of the artifact, from the comments or from a chat turn's edit. When
 * the version moved it is usually because Alfy changed the board:
 * `judgeServerBoard` says whether to draw it, whether it is only the reader's own
 * save seen early, and whether it cannot be drawn at all (the reader has steps the
 * server has not seen: their save would be refused as stale, so this says so
 * instead of losing them silently). Answers the board to draw, or null when there
 * is nothing to draw. The version, hash and bookkeeping are taken here, at once;
 * the drawing (a landing) follows, and a second one waits for the first.
 */
function adoptBoard(detail: ArtifactDetailResponse): CanvasBody | null {
	try {
		const stored = detail.artifact.body;
		const read = normalizeCanvasBody(stored?.trim() ? JSON.parse(stored) : {});
		const serverJson = boardJson(read.body);
		const verdict = judgeServerBoard({
			serverVersion: detail.artifact.versionNumber,
			knownVersion: versionNumber,
			serverJson,
			latestJson,
			savedJson,
		});
		if (verdict === "unchanged") return null;
		if (verdict === "conflict") {
			saveState = "conflict";
			autosave.stop();
			return null;
		}
		versionNumber = detail.artifact.versionNumber;
		knownBodyHash = detail.artifact.bodyHash;
		savedJson = serverJson;
		if (verdict === "ours") return null;
		latestJson = serverJson;
		setBoardNodes(read.body.nodes);
		onBodyChange?.(latestJson);
		return read.body;
	} catch {
		// A body that will not read is left to the next load.
		return null;
	}
}

/** What the comments controller calls after each read of the artifact: a board Alfy changed is drawn as a landing (at once when the parts cannot load). */
function adoptServerBoard(detail: ArtifactDetailResponse): void {
	const next = adoptBoard(detail);
	if (!next) return;
	void ensureReview().then((controller) =>
		controller ? controller.landChange(next) : boardApi?.land(next),
	);
}

/** The blocks the board has as of a step, a load or a landing: what the comments resolve against, and what still images are taken of. */
function setBoardNodes(
	nodes: CanvasNode[],
	options: { commentsToo?: boolean } = {},
): void {
	boardNodes = nodes;
	if (options.commentsToo !== false) comments?.setNodes(nodes);
	if (pictures) pictures.setNodes(nodes);
	else if (nodes.some((node) => needsPoster(node.type))) void ensurePictures();
}

// ---- A picture of the board (T7) ----------------------------------------------------
// Loaded on demand (`export-parts.ts`): when the board has an App, a map, photos or
// live web whose still image is due, or the reader presses Download. Until then none
// of it, nor the renderer it brings, is in the first paint. The controller keeps the
// state (drawing, kept, which blocks were drawn as a card); this is only the glue.

let pictures = $state.raw<CanvasPicturesController | null>(null);
let pictureViews = $state.raw<{ CanvasDownload: typeof CanvasDownload } | null>(
	null,
);
let picturesLoading: Promise<CanvasPicturesController | null> | null = null;
let downloadOpen = $state(false);

function ensurePictures(): Promise<CanvasPicturesController | null> {
	picturesLoading ??= import("./export-parts")
		.then(({ CanvasPicturesController: Controller, CanvasDownload }) => {
			const controller = new Controller({
				artifactId,
				conversationId,
				board: () => boardApi,
			});
			controller.setNodes(boardNodes);
			pictureViews = { CanvasDownload };
			pictures = controller;
			return controller;
		})
		// Offline, or a deploy in between: the next press tries again instead of waiting on a rejected import.
		.catch(() => {
			picturesLoading = null;
			return null;
		});
	return picturesLoading;
}

function toggleDownload(): void {
	if (downloadOpen) {
		downloadOpen = false;
		return;
	}
	void ensurePictures().then((controller) => {
		if (!controller) return;
		controller.reset();
		downloadOpen = true;
	});
}

function ensureComments(): Promise<void> {
	commentsLoading ??= import("./comment-parts")
		.then(
			({
				CanvasCommentsController: Controller,
				CanvasComments,
				CanvasSelectionPill,
				CommentCatcher,
				CommentPins,
				catcherProps,
				pinsProps,
				selectionPillProps,
				toggleComments,
			}) => {
				const controller = new Controller({
					artifactId,
					conversationId,
					threads: loadedThreads,
					beforeAsk: saveBoardNow,
					onserver: adoptServerBoard,
					// The reply that made a change wears the change's state as a chip.
					onreply: (result) => {
						if (result.outcome !== "applied") return;
						void ensureReview().then(
							(controller) =>
								controller &&
								reviewViews?.reviewReply(controller, result.reply.id),
						);
					},
				});
				controller.setNodes(boardNodes);
				commentViews = {
					CanvasComments,
					CanvasSelectionPill,
					CommentCatcher,
					CommentPins,
					catcherProps,
					pinsProps,
					selectionPillProps,
					toggleComments,
				};
				comments = controller;
			},
		)
		// Offline, or a deploy in between: the next press tries again instead of waiting on a rejected import.
		.catch(() => {
			commentsLoading = null;
		});
	return commentsLoading;
}

// ---- Alfy's change (T6, ruling 63) ---------------------------------------------
// Loaded on demand (`review-parts.ts`): when a call of Alfy's on this board runs or
// settles, a comment's answer changed the board, or the board is found with a change
// waiting. Until then nothing of it is in the first paint, and this is only the glue:
// what a call does to the board, Undo and Redo, and the chord are the controller's.
// What is true about a change (which blocks wait, whether Undo is still possible)
// is the server's.

let reviewViews = $state.raw<ReviewViews | null>(null);
let review = $state.raw<CanvasReviewController | null>(null);
let reviewLoading: Promise<CanvasReviewController | null> | null = null;

const reviewHost: ReviewHost = {
	get artifactId() {
		return artifactId;
	},
	get conversationId() {
		return conversationId;
	},
	board: () => boardApi,
	saveNow: saveBoardNow,
	guard: () => ({ version: versionNumber, bodyHash: knownBodyHash }),
	// A board of the reader's own (Undo, Redo) was saved: its version and hash are the
	// ones the next autosave is checked against.
	saved: ({ board, json, version, bodyHash }) => {
		versionNumber = version;
		knownBodyHash = bodyHash;
		savedJson = json;
		latestJson = json;
		setBoardNodes(board.nodes);
		onBodyChange?.(json);
		onDirtyChange?.(false);
	},
	adopt: adoptBoard,
	openVersions: () => (versionsOpen = true),
	reportCount: (count) => onPendingReviewCountChange?.(count),
};

function ensureReview(): Promise<CanvasReviewController | null> {
	reviewLoading ??= import("./review-parts")
		.then(
			({
				CanvasReviewController: Controller,
				AlfyChangeLayer,
				CanvasReviewBar,
				CanvasReviewNotices,
				changeLayerProps,
				reviewActivity,
				reviewEnd,
				reviewKey,
				reviewReply,
				reviewRestore,
				reviewSummary,
			}) => {
				const controller = new Controller(reviewHost);
				reviewViews = {
					AlfyChangeLayer,
					CanvasReviewBar,
					CanvasReviewNotices,
					changeLayerProps,
					reviewActivity,
					reviewEnd,
					reviewKey,
					reviewReply,
					reviewRestore,
					reviewSummary,
				};
				review = controller;
				return controller;
			},
		)
		// Offline, or a deploy in between: the next change tries again instead of waiting on a rejected import.
		.catch(() => {
			reviewLoading = null;
			return null;
		});
	return reviewLoading;
}

/** A board found with a change waiting (a reload, the panel opened later) shows it as it is: no landing, no strong ring. */
async function restoreReview(id: string, token: number): Promise<void> {
	let state: Awaited<ReturnType<typeof fetchCanvasReviewState>>;
	try {
		state = await fetchCanvasReviewState(id, conversationId);
	} catch {
		return;
	}
	if (token !== loadToken) return;
	// Nothing waits and nothing was ever loaded: stay as light as an unedited board.
	if (state.count === 0 && !review) return;
	const controller = await ensureReview();
	if (controller && token === loadToken) {
		reviewViews?.reviewRestore(controller, state);
	}
}

/**
 * The once-only rule (the Document's, `settledActivityKeyAtMount`): a call is
 * drawn live by the body that was mounted while it was still running (or before it
 * began), and by no body built after it settled. That one restores the server's
 * review state (`restoreReview`), which already holds the change: drawing it live on
 * top would ring it a second time. Captured once, at mount.
 */
const settledActivityKeyAtMount = untrack(() =>
	alfyActivity && alfyActivity.status !== "running" ? alfyActivity.key : null,
);

$effect(() => {
	const activity = alfyActivity;
	if (!activity || activity.artifactId !== artifactId) return;
	if (
		activity.status !== "running" &&
		activity.key === settledActivityKeyAtMount
	) {
		return;
	}
	// The board must be up before a change can be drawn on it: this runs again when it is.
	const ready = phase === "ready" && boardApi !== null;
	untrack(
		() =>
			void ensureReview().then(
				(controller) =>
					controller &&
					reviewViews?.reviewActivity(controller, activity, {
						settledAtMount: settledActivityKeyAtMount,
						ready,
					}),
			),
	);
});

/** The toolbar's Ask waits while Alfy is at work on this board, from the moment its call starts. */
let alfyBusy = $derived(
	(reviewViews?.reviewSummary(review).working ?? false) ||
		(alfyActivity?.status === "running" &&
			alfyActivity.artifactId === artifactId),
);

/** Ask Alfy from the toolbar: the selected blocks, or the board as the reader is looking at it, become a request in the comments list. */
function askAlfy(request: {
	ids: string[];
	centre: { x: number; y: number };
}): void {
	void ensureComments().then(() => {
		if (request.ids.length > 0) {
			comments?.placeOnBlocks(request.ids, { ask: true });
		} else {
			comments?.placeOnBoard(request.centre);
		}
	});
}

function handleWindowKeydown(event: KeyboardEvent): void {
	if (
		event.defaultPrevented ||
		!review ||
		!editorEl?.contains(document.activeElement)
	) {
		return;
	}
	const target = event.target as HTMLElement | null;
	if (target?.closest("input, textarea, select, [contenteditable='true']"))
		return;
	reviewViews?.reviewKey(review, event);
}

$effect(() => {
	const id = artifactId;
	untrack(() => void load(id));
});

// The header's Versions and Comments buttons: the Versions sheet lives in this
// body, and Comments is one toggle for whichever surface applies.
$effect(() => {
	registerPanelActions?.({
		openVersions: () => (versionsOpen = true),
		openDownload: toggleDownload,
		toggleComments: () =>
			void ensureComments().then(() => {
				if (commentViews && comments) commentViews.toggleComments(comments);
			}),
	});
});

let openCommentCount = $derived(
	comments
		? comments.openCount
		: loadedThreads.filter((thread) => thread.status !== "resolved").length,
);
$effect(() => {
	onCommentCountChange?.(openCommentCount);
});
$effect(() => {
	onCommentsShownChange?.(comments?.open ?? false);
});

$effect(() => {
	const listener = () => retrySave();
	window.addEventListener("online", listener);
	return () => window.removeEventListener("online", listener);
});

onDestroy(() => {
	loadToken += 1;
	reviewViews?.reviewEnd(review);
	pictures?.destroy();
	clearSavedTimer();
	// The board's last step may still be inside its settle delay.
	boardApi?.flush();
	void autosave.flush();
	autosave.stop();
});

let boardReadonly = $derived(
	saveState === "conflict" || saveState === "deleted",
);
let showDroppedNotice = $derived(droppedCount > 0 && !noticeDismissed);
let banner = $derived<"offline" | "failed" | "conflict" | "tooLarge" | null>(
	saveState === "offline"
		? "offline"
		: saveState === "failed"
			? "failed"
			: saveState === "conflict"
				? "conflict"
				: saveState === "tooLarge"
					? "tooLarge"
					: null,
);

// The words for what goes wrong with a board load on demand (`state-parts.ts`): the first
// time a board cannot be shown or a saving notice is due.
let stateViews = $state.raw<typeof import("./state-parts") | null>(null);
$effect(() => {
	if (stateViews) return;
	if (
		phase === "load_error" ||
		phase === "no_access" ||
		saveState === "deleted" ||
		banner !== null ||
		showDroppedNotice
	) {
		void import("./state-parts").then((module) => {
			stateViews = module;
		});
	}
});
</script>

{#snippet boardLayers(api: BoardLayerApi)}
	{#if reviewViews && review}
		<!-- Alfy's change: the arranging frame, the rings and the pill, in board space. -->
		<ViewportPortal target="front">
			<reviewViews.AlfyChangeLayer {...reviewViews.changeLayerProps(review, api)} />
		</ViewportPortal>
	{/if}
	{#if commentViews && comments}
		<!-- The pins ride the flow's front layer (in board space); the catcher for the Comment tool is over the pane. -->
		<ViewportPortal target="front">
			<commentViews.CommentPins {...commentViews.pinsProps(comments, api)} />
		</ViewportPortal>
		<commentViews.CommentCatcher {...commentViews.catcherProps(comments, api)} />
		<!-- The pill a selection raises: Ask Alfy, Comment. -->
		<ViewportPortal target="front">
			<commentViews.CanvasSelectionPill
				{...commentViews.selectionPillProps(comments, api, alfyBusy)}
			/>
		</ViewportPortal>
	{/if}
{/snippet}

<svelte:window onkeydown={handleWindowKeydown} />

<div
	class="canvas-editor"
	data-testid="canvas-editor"
	bind:clientWidth={editorWidth}
	bind:this={editorEl}
>
	{#if phase === "loading"}
		<div class="canvas-editor__skeleton" role="status" aria-busy="true" data-testid="canvas-loading">
			<span class="sr-only">{$t("artifacts.canvas.loading")}</span>
			<span class="skeleton-card skeleton-card--a" aria-hidden="true"></span>
			<span class="skeleton-card skeleton-card--b" aria-hidden="true"></span>
			<span class="skeleton-card skeleton-card--c" aria-hidden="true"></span>
		</div>
	{:else if phase === "load_error" || phase === "no_access" || saveState === "deleted"}
		{#if stateViews}
			<stateViews.CanvasStates
				state={phase === "load_error" ? "load_error" : phase === "no_access" ? "no_access" : "deleted"}
				onretry={() => load(artifactId)}
			/>
		{/if}
	{:else}
		<div class="canvas-editor__row">
			<div class="canvas-editor__board">
				{#key boardKey}
					<SvelteFlowProvider>
						<CanvasBoard
							bind:this={boardApi}
							body={boardBody}
							readonly={boardReadonly}
							onchange={handleBoardChange}
							layers={boardLayers}
							ontool={(tool) => tool === "comment" && void ensureComments()}
							onselect={(selected) => selected && void ensureComments()}
							onask={askAlfy}
							askBusy={alfyBusy}
						/>
					</SvelteFlowProvider>
				{/key}
				{#if pictures?.status === "working"}
					<!-- The board's camera goes to where the whole board fits and comes back; nobody watches it do that. -->
					<div class="canvas-editor__veil" role="status" data-testid="canvas-export-veil">
						<span>{$t("artifacts.canvas.export.preparing")}</span>
					</div>
				{/if}
				<div class="canvas-editor__notices">
					{#if reviewViews && review}
						<reviewViews.CanvasReviewNotices controller={review} />
					{/if}
					{#if pictures?.noticeOpen && pictures.missing.length > 0 && !downloadOpen}
						<div class="notice notice--warning" role="status" data-testid="canvas-export-missing">
							<span>
								{$t("artifacts.canvas.exportMissingPosters", {
									count: pictures.missing.length,
									names: pictures.missing.map((block) => block.title).join(", "),
								})}
							</span>
							<button type="button" class="notice__button" onclick={() => pictures?.dismissNotice()}>
								{$t("artifacts.canvas.dismiss")}
							</button>
						</div>
					{/if}
					{#if stateViews && (showDroppedNotice || banner)}
						<stateViews.CanvasBanners
							{banner}
							droppedCount={showDroppedNotice ? droppedCount : 0}
							onretry={retrySave}
							onreload={() => load(artifactId)}
							ondismiss={() => (noticeDismissed = true)}
						/>
					{/if}
				</div>

				<p class="canvas-editor__status" role="status" aria-live="polite" data-testid="canvas-save-status">
					{#if saveState === "saving"}
						{$t("artifacts.canvas.saving")}
					{:else if saveState === "saved"}
						{$t("artifacts.canvas.saved")}
					{/if}
				</p>
				{#if reviewViews && review}
					<reviewViews.CanvasReviewBar controller={review} />
				{/if}
			</div>
			{#if commentViews && comments}
				<commentViews.CanvasComments
					controller={comments}
					panelWidth={editorWidth}
					{currentUser}
					changeStateByCommentId={reviewViews?.reviewSummary(review).changeStates}
					onSeeChange={() => review?.seeChange()}
				/>
			{/if}
		</div>
	{/if}

	{#if downloadOpen && pictures && pictureViews}
		<pictureViews.CanvasDownload
			controller={pictures}
			{title}
			onClose={() => (downloadOpen = false)}
		/>
	{/if}

	{#if versionsOpen && VersionsSheet}
		<VersionsSheet
			{artifactId}
			{conversationId}
			onClose={() => (versionsOpen = false)}
			onRestored={() => {
				versionsOpen = false;
				void load(artifactId);
			}}
			currentUserId={currentUser?.id ?? null}
			currentUserName={currentUser?.displayName ?? null}
			currentUserProfilePicture={currentUser?.profilePicture ?? null}
		/>
	{/if}
</div>

<style>
	.canvas-editor {
		position: relative;
		isolation: isolate;
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}

	/* The board, and beside it the comment column when there is room for one (the
	   drawer is positioned against this row, so it starts where the board does). */
	.canvas-editor__row {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		flex-direction: row;
		min-height: 0;
		min-width: 0;
	}

	/* The notices and the save line are the board's: they sit over it, not over the column. */
	.canvas-editor__board {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}

	/* Over the board while a picture of it is drawn: the camera's short trip to where
	   the whole board fits is not something to watch. Opaque, and over the toolbar. */
	.canvas-editor__veil {
		position: absolute;
		inset: 0;
		z-index: calc(var(--artifact-overlay-z, 2100) + 1);
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--surface-page);
		color: var(--text-muted);
		font-size: var(--text-sm);
	}

	/* Three cards on the board's dot grid, no spinner. */
	.canvas-editor__skeleton {
		position: relative;
		flex: 1 1 auto;
		min-height: 320px;
		background-color: var(--surface-page);
		background-image: radial-gradient(
			color-mix(in srgb, var(--text-primary) 15%, transparent) 1px,
			transparent 1px
		);
		background-size: 18px 18px;
	}

	.skeleton-card {
		position: absolute;
		border: 1px solid var(--border-default);
		border-radius: var(--radius-lg);
		background: var(--surface-elevated);
		animation: canvas-skeleton-pulse 1.4s ease-in-out infinite;
	}

	.skeleton-card--a {
		top: 12%;
		left: 8%;
		width: 34%;
		height: 22%;
	}

	.skeleton-card--b {
		top: 18%;
		left: 52%;
		width: 30%;
		height: 30%;
		animation-delay: 0.2s;
	}

	.skeleton-card--c {
		top: 56%;
		left: 20%;
		width: 40%;
		height: 20%;
		animation-delay: 0.4s;
	}

	@keyframes canvas-skeleton-pulse {
		0%,
		100% {
			opacity: 0.55;
		}
		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton-card {
			animation: none;
		}
	}

	.canvas-editor__notices {
		position: absolute;
		top: 10px;
		left: 50%;
		z-index: var(--artifact-overlay-z);
		display: flex;
		flex-direction: column;
		gap: 6px;
		align-items: center;
		width: max-content;
		max-width: calc(100% - 24px);
		transform: translateX(-50%);
		pointer-events: none;
	}

	.notice {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 6px 10px;
		border: 1px solid var(--border-default);
		border-radius: 8px;
		background: var(--surface-page);
		box-shadow: var(--shadow-md);
		color: var(--text-primary);
		font-size: var(--text-sm);
		pointer-events: auto;
	}

	.notice--warning {
		border-color: color-mix(in srgb, var(--warning) 45%, transparent);
		background: color-mix(in srgb, var(--warning-tint) 100%, var(--surface-page));
		color: var(--warning-text);
	}

	.notice__button {
		flex: none;
		padding: 2px 8px;
		border: 1px solid currentColor;
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.notice__button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	/* Top-left: the toolbar, the overview, the zoom and the library's own
	   attribution have the bottom edge. */
	.canvas-editor__status {
		position: absolute;
		top: 10px;
		left: 12px;
		z-index: var(--artifact-overlay-z);
		margin: 0;
		color: var(--text-muted);
		font-size: var(--text-xs);
		pointer-events: none;
	}
</style>
