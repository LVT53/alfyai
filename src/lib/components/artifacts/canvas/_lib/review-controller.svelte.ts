/**
 * Alfy's change to a board, from the moment the call starts to the moment the
 * reader has decided (Feature 2 · Artifacts, Slice 3, T6's client half and ruling
 * 63). One object, made by the editor when a change first arrives or is found
 * waiting, so a board nobody changes never loads any of it.
 *
 * It holds what the reader sees of the change and the actions on it:
 *
 *   arranging   the dashed frame and "Alfy is arranging…", from the call starting
 *               until the change has landed (never less than 600 ms);
 *   landing     the board the server holds, drawn in the spec's order
 *               (`alfy-landing.ts`), one landing at a time;
 *   the change  what waits for the reader: the touched blocks, ringed strongly for
 *               3.2 s and then resting, the pill at their corner, the bar below the
 *               board with the stepper, Keep and Undo for the whole change;
 *   the notices what Alfy skipped (the shared `RefusalNotice`), and Undo refused.
 *
 * What is true about a change (which blocks wait, whether Undo is still possible)
 * is the server's (`fetchCanvasReviewState`); this only holds the last answer and
 * the parts of the moment that are not saved anywhere (the strong ring, the
 * refusal notice, which comment reply made the change). It does not draw and it
 * does not save: the editor gives it the board's own surface and the one way to
 * write a board as the reader's own (Undo and Redo).
 */
import { get } from "svelte/store";
import {
	type ArtifactDetailResponse,
	acknowledgeCanvasReview,
	fetchArtifact,
	fetchArtifactVersionBody,
	fetchCanvasReviewState,
	saveArtifactBody,
} from "$lib/client/api/artifacts";
import { alfyChangeShortcutFor } from "$lib/components/artifacts/document/keyboard-shortcuts";
import { type I18nKey, t } from "$lib/i18n";
import {
	BOARD_REFUSAL_REASONS,
	type BoardRefusalReason,
	refusalLabelKey,
} from "$lib/shared/artifacts/board-ops";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import {
	boardJson,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import type { CanvasReviewState } from "$lib/shared/artifacts/canvas-review";
import type { SaveSummaryKind } from "$lib/shared/artifacts/version-summaries";
import { prefersReducedMotion } from "$lib/utils/motion";
import type {
	AlfyRawBoardOp,
	DocumentAlfyActivity,
} from "../../document/alfy-activity";
import {
	acceptedCanvasOps,
	canvasOpTargets,
	highlightedByOps,
} from "../canvas-alfy-activity";
import {
	ARRANGING_MIN_MS,
	HIGHLIGHT_MS,
	type LandingPort,
	planLanding,
	runLanding,
} from "./alfy-landing";
import type { BoardLayerApi } from "./board-layers";
import { nodeWords } from "./comments";

/** "Kept" stays on the pill this long, and "Undone · Redo" this long (redesign §7.2 #13, #14). */
const KEPT_MS = 1400;
const UNDONE_MS = 5000;

/** The board component's own surface: what a landing draws on, and what it compares against. */
export type LandingBoard = LandingPort & { current: () => CanvasBody };

type WriteResult =
	| { ok: true; board: CanvasBody }
	| { ok: false; reason: "conflict" | "failed" | "too_large" };

/** What a write of the reader's own is checked against: the version and body hash the editor last saw. */
export type WriteGuard = { version: number | null; bodyHash: string | null };

export interface ReviewHost {
	artifactId: string;
	conversationId: string | null;
	/** The board that is mounted now, or null while none is (a load is under way). */
	board: () => LandingBoard | null;
	/** Saves the reader's last step and waits for the answer. */
	saveNow: () => Promise<void>;
	/** The version and hash the editor last saw. */
	guard: () => WriteGuard;
	/** A board of the reader's own (Undo, Redo) was saved: the editor takes it, and the version and hash that came with it, as its own. */
	saved: (saved: {
		board: CanvasBody;
		json: string;
		version: number;
		bodyHash: string | null;
	}) => void;
	/**
	 * A read of the artifact: the editor compares versions, takes the version and
	 * hash as its own, and answers the board to draw, or null when there is
	 * nothing to draw (the reader's own save seen early, or a conflict it has said so about).
	 */
	adopt: (detail: ArtifactDetailResponse) => CanvasBody | null;
	openVersions: () => void;
	/** The number the chat's card, the list row and the count button show. */
	reportCount: (count: number) => void;
}

/** What waits for the reader: the display model of the last state the server gave. */
interface ChangeView {
	touched: string[];
	removedCount: number;
	/** The newest change's own summary ("Planned Sunday"), as Alfy wrote it. */
	summary: string;
	/** The newest version of Alfy's it covers: what Keep moves the marker to. */
	through: number;
}

interface RefusalView {
	message: string;
	items: { label: string; reason: string }[];
}

export type ChangeStatus = "pending" | "kept" | "undone";

function viewOf(state: CanvasReviewState): ChangeView | null {
	if (state.count === 0) return null;
	const newest = state.changes[state.changes.length - 1];
	return {
		touched: state.touchedIds,
		removedCount: state.removedCount,
		summary: newest?.summary ?? "",
		through: state.latestAlfyVersion,
	};
}

function say(key: I18nKey, params?: Record<string, string | number>): string {
	return get(t)(key, params);
}

export class CanvasReviewController {
	arranging = $state.raw<{ label: string; ids: string[] } | null>(null);
	change = $state.raw<ChangeView | null>(null);
	/** Blocks ringed strongly for a moment: a change just landed, or a `highlight` pointed at them. */
	pulseIds = $state.raw<string[]>([]);
	status = $state<ChangeStatus>("pending");
	index = $state(0);
	/** One-shot "show this block": the layer centres the camera on it. */
	goto = $state.raw<{ id: string; token: number } | null>(null);
	refusal = $state.raw<RefusalView | null>(null);
	/** Undo was not done: the reader changed the board since (`user_edited`, so History is the way back) or it could not be (`failed`). */
	undoRefused = $state<"user_edited" | "failed" | null>(null);
	busy = $state(false);
	/** What a screen reader is told happened. */
	announcement = $state("");
	/** The comment replies of Alfy's that made a change, each with the state its change is in: what their cards wear as a chip. */
	replyChips = $state.raw<Record<string, ChangeStatus>>({});
	/** A landing is running or queued. */
	landing = $state(0);

	#host: ReviewHost;
	#chain: Promise<void> = Promise.resolve();
	#token = 0;
	#arrangedAt = 0;
	#pulseTimer: ReturnType<typeof setTimeout> | null = null;
	#keptTimer: ReturnType<typeof setTimeout> | null = null;
	#undoneTimer: ReturnType<typeof setTimeout> | null = null;
	#arrangeTimer: ReturnType<typeof setTimeout> | null = null;
	/** Alfy's board as it was when Undo was pressed: what Redo writes back. */
	#undone: { alfyBody: string } | null = null;
	/** The replies that made the change that waits now; once it is decided their chips keep its outcome. */
	#activeReplies: string[] = [];
	/** The version and hash right after Undo wrote: what Redo is checked against, so a step of the reader's in between refuses it. */
	#afterUndo: WriteGuard | null = null;
	/** The call being shown, and the last one drawn: each is handled once. */
	#arrangingKey = "";
	#handled = "";

	constructor(host: ReviewHost) {
		this.#host = host;
	}

	// ---- What the parts read -------------------------------------------------

	/** Alfy is at work on the board (arranging, or a landing is still drawing): the toolbar's Ask waits. */
	get working(): boolean {
		return this.arranging !== null || this.landing > 0;
	}

	/** The number the bar's stepper and the card count: the blocks waiting, or 1 for a change that only took blocks away. */
	get count(): number {
		const change = this.change;
		if (!change) return 0;
		return change.touched.length > 0
			? change.touched.length
			: change.removedCount > 0
				? 1
				: 0;
	}

	/** The block the stepper is on: ringed harder. Null until the reader has stepped. */
	get activeId(): string | null {
		const touched = this.change?.touched ?? [];
		return this.goto ? (touched[this.index] ?? null) : null;
	}

	/** The sentence on the review bar: what Alfy changed and what it took away. */
	get summaryText(): string {
		const change = this.change;
		if (!change) return "";
		const changed = change.touched.length;
		if (changed > 0 && change.removedCount > 0) {
			return say("artifacts.canvas.review.summaryBoth", {
				changed,
				removed: change.removedCount,
			});
		}
		return changed > 0
			? say("artifacts.canvas.review.summary", { count: changed })
			: say("artifacts.canvas.review.summaryRemoved", {
					count: change.removedCount,
				});
	}

	/** Each comment reply that made a change wears its change's state as a chip. */
	get changeStates(): Record<string, ChangeStatus> {
		return this.replyChips;
	}

	/** There is a block to show ("See what Alfy did"). */
	get canSeeChange(): boolean {
		return (this.change?.touched.length ?? 0) > 0;
	}

	// ---- Arranging -----------------------------------------------------------

	beginArranging(activity: {
		label: string | null;
		ops?: readonly AlfyRawBoardOp[];
	}): void {
		if (this.#arrangeTimer) clearTimeout(this.#arrangeTimer);
		this.#arrangeTimer = null;
		this.#arrangedAt = Date.now();
		this.arranging = {
			label: activity.label ?? "",
			ids: canvasOpTargets(activity.ops ?? []),
		};
	}

	/** Alfy is done: the state is seen for at least `ARRANGING_MIN_MS`, even when the call was faster. */
	endArranging(): Promise<void> {
		if (this.arranging === null) return Promise.resolve();
		const remaining = ARRANGING_MIN_MS - (Date.now() - this.#arrangedAt);
		if (remaining <= 0) {
			this.arranging = null;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.#arrangeTimer = setTimeout(() => {
				this.#arrangeTimer = null;
				this.arranging = null;
				resolve();
			}, remaining);
		});
	}

	// ---- Landing -------------------------------------------------------------

	/** Runs one drawing job after the ones already running: a second landing waits and never interleaves with the first. */
	#enqueue(run: () => Promise<void>): Promise<void> {
		this.landing += 1;
		const job = this.#chain.then(run, run);
		this.#chain = job.finally(() => {
			this.landing -= 1;
		});
		return job;
	}

	/** Draws the board the server holds and shows what is waiting. */
	landChange(
		next: CanvasBody,
		options: { highlight?: readonly string[] } = {},
	): Promise<void> {
		return this.#enqueue(() => this.#landChange(next, options.highlight ?? []));
	}

	async #landChange(
		next: CanvasBody,
		highlight: readonly string[],
	): Promise<void> {
		const board = this.#host.board();
		if (!board) return;
		const plan = planLanding(board.current(), next, highlight);
		await runLanding(board, plan, {
			reducedMotion: prefersReducedMotion(),
			aborted: () => this.#host.board() !== board,
		});
		if (this.#host.board() !== board) return;
		this.#ring(plan.touched);
		await this.refresh({ announce: true });
	}

	/**
	 * A call of the chat turn has settled. `next` is the board the server holds
	 * after it, or null when the call changed nothing on the board (a highlight
	 * only, or every op refused): then only the rings are drawn.
	 */
	async settleActivity(
		activity: DocumentAlfyActivity,
		next: CanvasBody | null,
	): Promise<void> {
		const highlight = highlightedByOps(acceptedCanvasOps(activity));
		this.#showRefusal(activity, this.#host.board()?.current() ?? null);
		if (next) await this.landChange(next, { highlight });
		else if (highlight.length > 0) this.#ring(highlight);
		await this.endArranging();
	}

	/** What Alfy skipped, by its block's own words (as the board was before the change) and the reason in the reader's language. */
	#showRefusal(
		activity: DocumentAlfyActivity,
		before: CanvasBody | null,
	): void {
		if (activity.refusedBlocks.length === 0) {
			this.refusal = null;
			return;
		}
		const items = activity.refusedBlocks.map((item) => {
			const node = before?.nodes.find(
				(candidate) => candidate.id === item.blockId,
			);
			const reason = (BOARD_REFUSAL_REASONS as readonly string[]).includes(
				item.reason,
			)
				? say(refusalLabelKey(item.reason as BoardRefusalReason) as I18nKey)
				: item.reason;
			return {
				label: (node && nodeWords(node)) || item.blockId || "?",
				reason,
			};
		});
		this.refusal = {
			message: say("artifacts.canvas.review.refused", { count: items.length }),
			items,
		};
	}

	/** Rings these blocks strongly for 3.2 s, then lets the ring rest (or go, when nothing waits on them). */
	#ring(ids: readonly string[]): void {
		if (this.#pulseTimer) clearTimeout(this.#pulseTimer);
		this.pulseIds = [...ids];
		this.#pulseTimer = setTimeout(() => {
			this.pulseIds = [];
			this.#pulseTimer = null;
		}, HIGHLIGHT_MS);
	}

	// ---- What waits ----------------------------------------------------------

	/** Reads what waits from the server and shows it. A failed read keeps what is shown. */
	async refresh(options: { announce?: boolean } = {}): Promise<void> {
		let state: CanvasReviewState;
		try {
			state = await fetchCanvasReviewState(
				this.#host.artifactId,
				this.#host.conversationId,
			);
		} catch {
			return;
		}
		this.#show(state, options.announce === true);
		this.#host.reportCount(state.count);
	}

	/**
	 * A board found with a change waiting (a reload, the panel opened later): shown
	 * as it is, with no landing and no strong ring. A board found with nothing
	 * waiting clears what an earlier state showed, and says nothing to the count: an
	 * unedited board's count is not this panel's to decide.
	 */
	restore(state: CanvasReviewState): void {
		if (state.count === 0) {
			this.change = null;
			this.goto = null;
			return;
		}
		this.#show(state, false);
		this.#host.reportCount(state.count);
	}

	#show(state: CanvasReviewState, announce: boolean): void {
		const view = viewOf(state);
		this.change = view;
		if (!view) return;
		this.status = "pending";
		this.index = 0;
		this.goto = null;
		if (announce) {
			const summary = this.summaryText;
			const left = this.refusal?.items.length ?? 0;
			this.announcement =
				left > 0
					? say("artifacts.canvas.review.landedLeft", { summary, left })
					: say("artifacts.canvas.review.landed", { summary });
		}
	}

	// ---- Keep, Undo, Redo ----------------------------------------------------

	async keep(): Promise<void> {
		const change = this.change;
		if (!change || this.status !== "pending" || this.busy) return;
		this.status = "kept";
		this.#chips("kept");
		this.announcement = say("artifacts.document.change.keptNotice");
		this.#host.reportCount(0);
		this.#startTimer("kept", KEPT_MS);
		try {
			await acknowledgeCanvasReview(
				this.#host.artifactId,
				change.through,
				this.#host.conversationId,
			);
		} catch {
			// Best-effort, like the Document's: a failed call only means the change
			// waits again after the next reload, a visible and safe failure.
		}
	}

	/**
	 * Undo: the board before Alfy's change is saved back as the reader's own
	 * version ("Undid Alfy's change"), and drawn. Only when the reader has not
	 * changed the board since (the server says); otherwise it is refused and
	 * points to the versions. The reader's last step is saved first, so a step
	 * still in the air counts as a change and is not lost to the restore.
	 */
	async undo(): Promise<void> {
		if (!this.change || this.status !== "pending" || this.busy) return;
		this.busy = true;
		this.undoRefused = null;
		try {
			await this.#host.saveNow();
			let state: CanvasReviewState;
			try {
				state = await fetchCanvasReviewState(
					this.#host.artifactId,
					this.#host.conversationId,
				);
			} catch {
				this.#refuseUndo("failed");
				return;
			}
			this.#show(state, false);
			if (!state.undo.available) {
				this.#refuseUndo(
					state.undo.reason === "user_edited" ? "user_edited" : "failed",
				);
				return;
			}
			const board = this.#host.board();
			const alfyBody = board ? boardJson(board.current()) : null;
			let parentBody: string;
			try {
				parentBody = await fetchArtifactVersionBody(
					this.#host.artifactId,
					state.undo.toVersionId,
					this.#host.conversationId,
				);
			} catch {
				this.#refuseUndo("failed");
				return;
			}
			const written = await this.#write(parentBody, "undid_alfy_change");
			if (!written.ok) {
				this.#refuseUndo(
					written.reason === "conflict" ? "user_edited" : "failed",
				);
				return;
			}
			this.#afterUndo = this.#host.guard();
			try {
				await acknowledgeCanvasReview(
					this.#host.artifactId,
					state.latestAlfyVersion,
					this.#host.conversationId,
				);
			} catch {
				// The board is already back; the marker catches up on the next Keep or reload.
			}
			this.#undone = alfyBody === null ? null : { alfyBody };
			this.status = "undone";
			this.#chips("undone");
			this.pulseIds = [];
			this.announcement = say("artifacts.document.change.undoneNotice");
			this.#host.reportCount(0);
			this.#startTimer("undone", UNDONE_MS);
			// The decision is made and saved: the board gliding back is only drawing, and
			// the pill already offers Redo, which must not be ignored until it is done (it
			// waits its turn behind the drawing instead).
			this.busy = false;
			await this.#drawWritten(written.board);
		} finally {
			this.busy = false;
		}
	}

	/** Redo, inside its window: Alfy's board is written back as the reader's own edit, and the change waits again for this session. */
	async redo(): Promise<void> {
		if (this.status !== "undone" || !this.#undone || this.busy) return;
		this.busy = true;
		try {
			this.#clearTimer("undone");
			const written = await this.#write(
				this.#undone.alfyBody,
				undefined,
				this.#afterUndo ?? undefined,
			);
			if (!written.ok) {
				this.#refuseUndo("failed");
				return;
			}
			this.#undone = null;
			this.status = "pending";
			this.#chips("pending");
			this.#host.reportCount(this.count);
			this.busy = false;
			await this.#drawWritten(written.board);
		} finally {
			this.busy = false;
		}
	}

	/** Draws a board the reader's own write produced (Undo, Redo): the same glide, with no ring. */
	#drawWritten(next: CanvasBody): Promise<void> {
		return this.#enqueue(async () => {
			const board = this.#host.board();
			if (!board) return;
			await runLanding(board, planLanding(board.current(), next), {
				reducedMotion: prefersReducedMotion(),
				aborted: () => this.#host.board() !== board,
			});
		});
	}

	#refuseUndo(reason: "user_edited" | "failed"): void {
		this.undoRefused = reason;
		this.announcement = say(
			reason === "user_edited"
				? "artifacts.canvas.review.undoRefused"
				: "artifacts.canvas.review.undoFailed",
		);
	}

	dismissUndoRefused(): void {
		this.undoRefused = null;
	}

	dismissRefusal(): void {
		this.refusal = null;
	}

	openHistory(): void {
		this.#host.openVersions();
	}

	// ---- The stepper ---------------------------------------------------------

	step(delta: 1 | -1): void {
		const touched = this.change?.touched ?? [];
		if (touched.length === 0) return;
		this.index = (this.index + delta + touched.length) % touched.length;
		this.#goTo(touched[this.index]);
	}

	/** "See what Alfy did": the first block it touched. */
	seeChange(): void {
		const touched = this.change?.touched ?? [];
		if (touched.length === 0) return;
		this.index = 0;
		this.#goTo(touched[0]);
	}

	#goTo(id: string): void {
		this.#token += 1;
		this.goto = { id, token: this.#token };
	}

	// ---- Writing the reader's own board (Undo, Redo) -------------------------

	/**
	 * Writes a whole board as the reader's own version: a version of its own (never
	 * merged into the one before), against the version and hash the editor last saw
	 * (or `expect`), so a save that landed in between refuses it rather than being
	 * written over. The reader's last step is saved first. Answers the board that was
	 * saved, for the caller to draw, or why it was not.
	 */
	async #write(
		body: string,
		summaryKind?: SaveSummaryKind,
		expect?: WriteGuard,
	): Promise<WriteResult> {
		let parsed: CanvasBody;
		try {
			parsed = normalizeCanvasBody(JSON.parse(body)).body;
		} catch {
			return { ok: false, reason: "failed" };
		}
		await this.#host.saveNow();
		const guard = expect ?? this.#host.guard();
		const json = boardJson(parsed);
		const result = await saveArtifactBody(
			this.#host.artifactId,
			json,
			guard.version ?? undefined,
			this.#host.conversationId,
			undefined,
			{
				baseHash: guard.bodyHash ?? undefined,
				coalesce: false,
				summaryKind,
			},
		).catch(() => null);
		if (!result) return { ok: false, reason: "failed" };
		if (!result.ok) {
			return {
				ok: false,
				reason:
					result.reason === "too_large"
						? "too_large"
						: result.reason === "not_found" || result.reason === "invalid_patch"
							? "failed"
							: "conflict",
			};
		}
		this.#host.saved({
			board: parsed,
			json,
			version: result.version,
			bodyHash: result.bodyHash ?? null,
		});
		return { ok: true, board: parsed };
	}

	// ---- A call of Alfy's on this board --------------------------------------

	/**
	 * The chat page's latest artifact tool call, when it is on this board. A running
	 * call frames what it addresses; a settled one is read back and drawn, once (the
	 * editor hands over `settledAtMount`, the call that had already settled when it
	 * was built: the server's review state holds that one, `restore`). `ready` is
	 * whether the board is on screen: a call that settles before it is waits and is
	 * handed over again when it is.
	 */
	onActivity(
		activity: DocumentAlfyActivity,
		options: { settledAtMount: string | null; ready: boolean },
	): void {
		if (activity.status === "running") {
			if (activity.key === this.#arrangingKey) return;
			this.#arrangingKey = activity.key;
			this.beginArranging(activity);
			return;
		}
		if (activity.key === options.settledAtMount) return;
		const key = `${activity.key}:${activity.status}`;
		if (key === this.#handled || !options.ready) return;
		this.#handled = key;
		void this.#landActivity(activity);
	}

	/**
	 * A call has settled: the board is read again and drawn (only when the call
	 * changed it: a highlight writes no version, and a call that changed nothing has
	 * nothing to draw), what Alfy skipped is named, and the arranging frame goes.
	 */
	async #landActivity(activity: DocumentAlfyActivity): Promise<void> {
		// A call fast enough that its running state never reached a render (a tool
		// that answers in a few milliseconds) still shows "Alfy is arranging…" while
		// it lands: the state is seen for a moment even when the call was faster.
		if (this.#arrangingKey !== activity.key && activity.status !== "failed") {
			this.#arrangingKey = activity.key;
			this.beginArranging(activity);
		}
		if (activity.status === "failed") {
			await this.endArranging();
			return;
		}
		let next: CanvasBody | null = null;
		if (activity.appliedCount > 0) {
			try {
				next = this.#host.adopt(
					await fetchArtifact(this.#host.artifactId, this.#host.conversationId),
				);
			} catch {
				// Not read: it is drawn by the next read of the artifact.
			}
		}
		await this.settleActivity(activity, next);
	}

	/** Ctrl/Cmd+Alt+Z takes Alfy's change back, and +Shift puts it back: the Document's chord, and never the reader's own undo. */
	handleKey(event: KeyboardEvent): void {
		const chord = alfyChangeShortcutFor(event);
		if (chord === "undo" && this.status === "pending" && this.change) {
			event.preventDefault();
			void this.undo();
		} else if (chord === "redo" && this.status === "undone") {
			event.preventDefault();
			void this.redo();
		}
	}

	// ---- Comment replies -----------------------------------------------------

	/** The reply of Alfy's that made the change that waits: its card wears the change's state. */
	linkReply(commentId: string): void {
		if (!this.#activeReplies.includes(commentId)) {
			this.#activeReplies = [...this.#activeReplies, commentId];
		}
		this.replyChips = { ...this.replyChips, [commentId]: "pending" };
	}

	#chips(status: ChangeStatus): void {
		if (this.#activeReplies.length === 0) return;
		this.replyChips = {
			...this.replyChips,
			...Object.fromEntries(this.#activeReplies.map((id) => [id, status])),
		};
	}

	// ---- The end of a change -------------------------------------------------

	#startTimer(which: "kept" | "undone", ms: number): void {
		this.#clearTimer(which);
		const timer = setTimeout(() => this.#end(), ms);
		if (which === "kept") this.#keptTimer = timer;
		else this.#undoneTimer = timer;
	}

	#clearTimer(which: "kept" | "undone"): void {
		if (which === "kept" && this.#keptTimer) clearTimeout(this.#keptTimer);
		if (which === "undone" && this.#undoneTimer)
			clearTimeout(this.#undoneTimer);
		if (which === "kept") this.#keptTimer = null;
		else this.#undoneTimer = null;
	}

	/** The change has been decided and its moment is over: nothing of it stays on the board. */
	#end(): void {
		this.#clearTimer("kept");
		this.#clearTimer("undone");
		this.change = null;
		this.pulseIds = [];
		this.status = "pending";
		this.goto = null;
		this.index = 0;
		this.#undone = null;
		// The replies keep the outcome on their chips; the next change starts its own.
		this.#activeReplies = [];
	}

	/** The panel closed or another board opened: no timer may outlive it. */
	destroy(): void {
		for (const timer of [
			this.#pulseTimer,
			this.#keptTimer,
			this.#undoneTimer,
			this.#arrangeTimer,
		]) {
			if (timer) clearTimeout(timer);
		}
		this.#pulseTimer = null;
		this.#keptTimer = null;
		this.#undoneTimer = null;
		this.#arrangeTimer = null;
	}
}

/** What `AlfyChangeLayer` draws and reports, from the controller's state and the board's own (`BoardLayerApi`). */
export function changeLayerProps(
	controller: CanvasReviewController,
	api: BoardLayerApi,
) {
	const change = controller.change;
	return {
		nodes: api.nodes,
		viewport: api.viewport,
		arrangingIds: controller.arranging?.ids ?? null,
		touched: change?.touched ?? [],
		pulseIds: controller.pulseIds,
		activeId: controller.activeId,
		pill:
			change && controller.count > 0
				? {
						status: controller.status,
						label: change.summary || controller.summaryText,
					}
				: null,
		goto: controller.goto,
		oncenter: api.centerOn,
		onkeep: () => void controller.keep(),
		onundo: () => void controller.undo(),
		onredo: () => void controller.redo(),
	};
}

// ---- What the editor asks of it --------------------------------------------
//
// The editor holds the controller in a state variable it may not have yet, and
// reaches it through these, the way the comments' `toggleComments` and
// `pinsProps` reach theirs: one function for each thing the editor does, named
// for it, so the class's own surface stays what the parts read.

/** What the toolbar's Ask and the reply chips need to know: Alfy is at work, and each reply's change state. */
export function reviewSummary(controller: CanvasReviewController | null): {
	working: boolean;
	changeStates: Record<string, ChangeStatus>;
} {
	return {
		working: controller?.working ?? false,
		changeStates: controller?.changeStates ?? {},
	};
}

/** The chat page's latest artifact call, when it is on this board. */
export function reviewActivity(
	controller: CanvasReviewController,
	activity: DocumentAlfyActivity,
	options: { settledAtMount: string | null; ready: boolean },
): void {
	controller.onActivity(activity, options);
}

/** A board found with a change waiting: shown as it is. */
export function reviewRestore(
	controller: CanvasReviewController,
	state: CanvasReviewState,
): void {
	controller.restore(state);
}

/** The reply of Alfy's that made a change. */
export function reviewReply(
	controller: CanvasReviewController,
	commentId: string,
): void {
	controller.linkReply(commentId);
}

/** A key pressed on the board: Alfy's change chords are the controller's. */
export function reviewKey(
	controller: CanvasReviewController,
	event: KeyboardEvent,
): void {
	controller.handleKey(event);
}

/** The panel closed or another board opened: no timer may outlive it. */
export function reviewEnd(controller: CanvasReviewController | null): void {
	controller?.destroy();
}
