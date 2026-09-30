/**
 * The type→body registry the panel's content area dispatches on (Slice 0
 * Task S5). A missing entry IS the File body: the panel already renders
 * produced files through its existing lazy preview stack, so "no loader"
 * means "keep doing that" — this is why the registry ships empty here and
 * every later slice adds exactly one line.
 *
 * Loader functions, never eager imports: a static import of a heavy editor
 * (Tiptap, Svelte Flow, …) would put it in every chat page's chunk, whether
 * or not that chat ever opens the type. `DocumentWorkspace.svelte` caches
 * each loader's promise the same way it already caches
 * `DocumentPreviewRenderer.svelte`'s, so a kind is imported at most once no
 * matter how many times its body is shown.
 */
import type { Component } from "svelte";
import type { DocumentAlfyActivity } from "$lib/components/artifacts/document/alfy-activity";
import type { DocumentWorkspaceItem } from "$lib/server/services/knowledge/types";
import type { ArtifactKind } from "$lib/shared/artifacts/kinds";

export interface ArtifactBodyProps {
	artifactId: string;
	kind: ArtifactKind;
	title: string;
	body: string | null;
	/** The conversation the panel is showing; bodies pass it to `fetchArtifact` and any other artifact route so an incognito conversation's artifacts resolve, and it is null outside a conversation. */
	conversationId?: string | null;
	/**
	 * The latest Alfy tool-call activity (`create_artifact`/`edit_artifact`)
	 * the chat page knows about, derived from the stream's own tool-call
	 * parts — regardless of which artifact it targets. The Document body
	 * interprets it (T8 live: the "Alfy is writing" shimmer, change marks and
	 * refusal notice) and so does the Canvas body (Slice 3 T6: the arranging
	 * frame, the landing, the refusal notice; a board's edit carries its `ops`);
	 * every other kind ignores it. `null`/absent when nothing is happening.
	 */
	alfyActivity?: DocumentAlfyActivity | null;
	/**
	 * Opens an item in the panel's own viewer — the file a Canvas's File block
	 * names, opened the way the chat's own file cards open theirs. Absent when the
	 * host cannot open one (the Knowledge page, the project Files dialog); a body
	 * that offers such a link then shows it as plain text. Only the Canvas body
	 * reads it today.
	 */
	onOpenItem?: (item: DocumentWorkspaceItem) => void;
	/** Fires when the body's own dirty state changes, so the panel can guard closing. */
	onDirtyChange?: (dirty: boolean) => void;
	/** The body hands its serialised form back for versions/refusal. Slice 1 first. */
	onBodyChange?: (body: string) => void;
	/**
	 * Wave 2.5 Step 3: `ArtifactPanelHeader.svelte`'s version button and
	 * Download action open sheets that live INSIDE the body (Document's own
	 * `VersionsSheet`/`DownloadSheet`, opened today through the toolbar's
	 * "history"/"download" actions, now removed from the toolbar — redesign
	 * §5.2: "there is one History entry … and it sits where the version is").
	 * A body that owns such a sheet calls this once its trigger functions are
	 * ready, when it mounts. The panel mounts ONE body per open item (it keys
	 * the mount on the item, so a version change never rebuilds it, and a swap
	 * to another item always builds a body of its own) and files what a body
	 * reports under that item: a registration counts only while its item is the
	 * one open, so the header can never call a closure over a body that is gone
	 * and every item's body gets its own controls; a kind with no such sheet
	 * (App has only Download, File no body at all) registers only what it has,
	 * and the header falls back to its plain-text version / the panel's own
	 * generic download link.
	 */
	registerPanelActions?: (actions: ArtifactPanelBodyActions) => void;
	/**
	 * Wave 2.5 Step 8: the live count behind the header's Comments button
	 * badge (Document only, today) — a plain reactive report, not a
	 * `registerPanelActions` field, because it changes continuously as
	 * comments load/resolve rather than being a one-time trigger a body hands
	 * up once. Fires from an `$effect` whenever the count changes; a kind
	 * with no comments (App, File) simply never calls it, and the header
	 * never shows the button at all.
	 */
	onCommentCountChange?: (openCount: number) => void;
	/**
	 * Whether the body's comments are showing right now — the inline column
	 * beside the text, or the drawer/sheet on a narrow panel or a phone —
	 * so the header's Comments button can be a pressed toggle rather than a
	 * second way in. Same reactive-report shape as `onCommentCountChange`.
	 */
	onCommentsShownChange?: (shown: boolean) => void;
	/**
	 * Wave 2.5 review (F1): the live count behind the persisted
	 * `pendingReviewCount` — same shape/trigger contract as
	 * `onCommentCountChange` above (a plain reactive report from an
	 * `$effect`, not a one-time `registerPanelActions` trigger), so the
	 * chat card, the list row and the count-button dot all update the
	 * instant Keep/Undo/Keep-all changes the count, without waiting for a
	 * full conversation-detail reload. Document only, today; a kind with no
	 * review workflow (App, File) simply never calls it.
	 */
	onPendingReviewCountChange?: (count: number) => void;
	/**
	 * rd/review-2-5.md:272-275: the signed-in user's own id/name/profile
	 * picture, for a "you" row (a comment, a version) to show the real avatar
	 * instead of a placeholder "U" — the layout already resolves this
	 * (`(app)/+layout.server.ts`'s `SessionUser`); bodies with such a row
	 * (Document, today) thread it down to the leaf that renders `AvatarCircle`.
	 * `null`/absent falls back to the old placeholder.
	 */
	currentUser?: {
		id: string;
		displayName: string;
		profilePicture: string | null;
	} | null;
}

/** See `ArtifactBodyProps.registerPanelActions`. Every field is optional: a body opts in to only the actions it actually owns a sheet for. */
export interface ArtifactPanelBodyActions {
	openVersions?: () => void;
	openDownload?: () => void;
	/**
	 * Shows or hides the body's comments — whichever surface applies at the
	 * moment (the inline column, the narrow-panel drawer, the phone sheet).
	 * One toggle, never a second way in; `onCommentsShownChange` above reports
	 * the resulting state.
	 */
	toggleComments?: () => void;
	/**
	 * Saves what the body has not saved yet, and answers once the save has been
	 * answered (it never rejects, and it does not wait for a connection to come
	 * back). The chat page awaits it before a turn starts: a turn can make Alfy
	 * change what is open, and a step of the reader's that is still inside the
	 * body's own save delay would then be written over, or refused as stale (RV-3
	 * I2). A body with nothing of the reader's to hold back registers none; the
	 * Canvas is the one that does today.
	 */
	flush?: () => Promise<void>;
}

export type ArtifactBodyLoader = () => Promise<{
	default: Component<ArtifactBodyProps>;
}>;

export const ARTIFACT_BODIES: Partial<
	Record<ArtifactKind, ArtifactBodyLoader>
> = {
	document: () => import("./document/DocumentBody.svelte"),
	app: () => import("./app/AppBody.svelte"),
	canvas: () => import("./canvas/CanvasEditor.svelte"),
};
