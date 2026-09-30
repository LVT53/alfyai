/**
 * The board's comment state and what it does over the network: which threads
 * there are, whether the list is showing, what the pins and the list have
 * selected, the comment that has been placed but not written yet, and Alfy
 * working on one. The pins (`CommentPins`) and the list (`CanvasComments`) are
 * two places in the DOM that show one state, so it lives here, in one object
 * the editor makes when comments are first needed — a board with none and a
 * reader who never opens them never loads any of this.
 *
 * It does not draw and it does not touch the board. The editor gives it three
 * things: the artifact it belongs to, a way to save the reader's board before
 * Alfy reads it (a comment is answered against what is SAVED), and a listener
 * for every read of the artifact, which is how a board Alfy changed gets drawn
 * (`onserver`: the editor compares versions and decides).
 */
import { get } from "svelte/store";
import {
	type ArtifactDetailResponse,
	askAlfyInComment,
	createArtifactComment,
	fetchArtifact,
	resolveArtifactComment,
} from "$lib/client/api/artifacts";
import { type I18nKey, t } from "$lib/i18n";
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { mentionsAlfy } from "$lib/shared/artifacts/comments";
import type { BoardLayerApi } from "./board-layers";

export type CommentsDeps = {
	artifactId: string;
	conversationId: string | null;
	/** The threads as the editor loaded them. */
	threads: ArtifactComment[];
	/** Saves what the reader has done to the board and waits for it: Alfy answers against the saved one. */
	beforeAsk: () => Promise<void>;
	/** Every read of the artifact, threads and board together. */
	onserver: (detail: ArtifactDetailResponse) => void;
};

/** A one-shot request to a view: the same thread asked for twice is two requests. */
type Request = { commentId: string; token: number };

export class CanvasCommentsController {
	threads = $state.raw<ArtifactComment[]>([]);
	/** The blocks as last saved: what the list resolves a thread's block against. */
	nodes = $state.raw<CanvasNode[]>([]);
	/** The list is showing: the column beside the board, the drawer, or the phone sheet. */
	open = $state(false);
	/** A comment that has been placed on the board and not written yet. */
	draft = $state.raw<Anchor | null>(null);
	selectedId = $state<string | null>(null);
	hoverId = $state<string | null>(null);
	/** The list scrolls to this thread's card and focuses it. */
	focus = $state.raw<Request | null>(null);
	/** The board centres on this thread's pin and rings it. */
	goto = $state.raw<Request | null>(null);
	/** Open threads by default (ruling 61); the quiet toggle shows All. */
	filter = $state<"open" | "all">("open");
	/** The fold of the threads whose block was removed. */
	orphanedOpen = $state(false);
	/** The thread Alfy is answering in, while it does. */
	asking = $state<string | null>(null);
	/** What a screen reader is told happened. */
	status = $state("");
	/** Something that went wrong and the reader should know, without losing what they wrote. */
	notice = $state<string | null>(null);

	#deps: CommentsDeps;
	#token = 0;

	constructor(deps: CommentsDeps) {
		this.#deps = deps;
		this.threads = deps.threads;
	}

	get openCount(): number {
		return this.threads.filter((thread) => thread.status !== "resolved").length;
	}

	/** What the pins draw as on: the thread under the pointer, else the one that was picked. */
	get activeId(): string | null {
		return this.hoverId ?? this.selectedId;
	}

	#say(key: I18nKey): void {
		this.status = get(t)(key);
	}

	#next(commentId: string): Request {
		this.#token += 1;
		return { commentId, token: this.#token };
	}

	show(): void {
		this.open = true;
	}

	hide(): void {
		this.open = false;
		this.draft = null;
		this.selectedId = null;
	}

	setNodes(nodes: CanvasNode[]): void {
		this.nodes = nodes;
	}

	hover(commentId: string | null): void {
		this.hoverId = commentId;
	}

	/** A pin, or a card, was picked: the list opens on it. */
	select(commentId: string): void {
		this.selectedId = commentId;
		this.open = true;
		this.focus = this.#next(commentId);
	}

	goToThread(commentId: string): void {
		this.goto = this.#next(commentId);
	}

	/** The Comment tool placed one: the list opens with a composer for it. */
	place(anchor: Anchor): void {
		this.draft = anchor;
		this.selectedId = null;
		this.open = true;
	}

	cancelDraft(): void {
		this.draft = null;
	}

	/** Reads the artifact again: the threads, and (through `onserver`) the board. A failed read keeps what is shown. */
	async refresh(): Promise<void> {
		try {
			const detail = await fetchArtifact(
				this.#deps.artifactId,
				this.#deps.conversationId,
			);
			this.threads = detail.comments;
			this.#deps.onserver(detail);
		} catch {
			// The list shows slightly stale threads until the next read.
		}
	}

	/** Posts a new thread on `anchor`. A failure throws and leaves the comment placed, so what was typed is not lost. */
	async post(anchor: Anchor, body: string): Promise<void> {
		const created = await createArtifactComment(
			this.#deps.artifactId,
			anchor,
			body,
			undefined,
			this.#deps.conversationId,
		);
		this.draft = null;
		this.notice = null;
		this.#say("artifacts.document.announce.commentAdded");
		await this.refresh();
		this.select(created.id);
		if (mentionsAlfy(body)) await this.#askAlfy(created.id, created.id);
	}

	async reply(parentId: string, body: string): Promise<void> {
		const created = await createArtifactComment(
			this.#deps.artifactId,
			null,
			body,
			parentId,
			this.#deps.conversationId,
		);
		this.notice = null;
		this.#say("artifacts.document.announce.commentAdded");
		await this.refresh();
		if (mentionsAlfy(body)) await this.#askAlfy(created.id, parentId);
	}

	async resolve(commentId: string, resolved: boolean): Promise<void> {
		try {
			await resolveArtifactComment(
				this.#deps.artifactId,
				commentId,
				resolved,
				this.#deps.conversationId,
			);
			this.notice = null;
			this.#say(
				resolved
					? "artifacts.document.announce.commentResolved"
					: "artifacts.document.announce.commentReopened",
			);
		} catch {
			this.notice = get(t)("artifacts.canvas.comment.updateFailed");
		}
		await this.refresh();
	}

	/**
	 * Alfy answers `commentId`, which sits in `threadId`. The reader's board is
	 * saved first (Alfy reads what is stored, and a save that lands after Alfy's
	 * change would be refused as stale), and the artifact is read again after, so
	 * a change to the board is drawn. The comment is already posted whatever
	 * happens here: a failure says so and leaves it.
	 */
	async #askAlfy(commentId: string, threadId: string): Promise<void> {
		this.asking = threadId;
		try {
			await this.#deps.beforeAsk();
			const result = await askAlfyInComment(
				this.#deps.artifactId,
				commentId,
				this.#deps.conversationId,
			);
			this.#say(
				result.outcome === "applied"
					? "artifacts.canvas.comment.landed"
					: "artifacts.document.announce.alfyReplied",
			);
		} catch {
			this.notice = get(t)("artifacts.canvas.comment.alfyFailed");
		} finally {
			await this.refresh();
			this.asking = null;
		}
	}
}

/** The header's Comments button. Closing throws away a comment that was started: no pin may outlive its composer. */
export function toggleComments(controller: CanvasCommentsController): void {
	if (controller.open) controller.hide();
	else controller.show();
}

/** What `CommentPins` draws and reports, from the controller's state and the board's own (`BoardLayerApi`). */
export function pinsProps(
	controller: CanvasCommentsController,
	api: BoardLayerApi,
) {
	return {
		threads: controller.threads,
		nodes: api.nodes,
		viewport: api.viewport,
		activeId: controller.activeId,
		draft: controller.draft,
		showResolved: controller.filter === "all",
		goto: controller.goto,
		oncenter: api.centerOn,
		onselect: (commentId: string) => controller.select(commentId),
	};
}

/** What `CommentCatcher` needs to place a comment where the reader clicks. */
export function catcherProps(
	controller: CanvasCommentsController,
	api: BoardLayerApi,
) {
	return {
		nodes: api.nodes,
		tool: api.tool,
		toBoard: api.toBoard,
		ondraft: (anchor: Anchor) => controller.place(anchor),
		ontoolchange: api.setTool,
		onannounce: api.announce,
	};
}
