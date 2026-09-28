import { writable } from "svelte/store";

export type ToastType = "success" | "error";

export interface ToastEntry {
	id: string;
	type: ToastType;
	message: string;
	/** An optional inline action beside the message (redesign §9.3: "Toast.svelte for undo toasts") — e.g. "Undo". Requires `onAction` too, or it is not rendered. */
	actionLabel?: string;
	/** Runs the action, then dismisses the toast (Toast.svelte's own click handler) — a caller never has to call `dismissToast` itself. */
	onAction?: () => void;
}

const DEFAULT_TOAST_DURATION_MS = 4000;

/** Ordered queue of active toasts. The Toast.svelte mount point renders this. */
export const toasts = writable<ToastEntry[]>([]);

let idCounter = 0;
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(id: string) {
	const timer = dismissTimers.get(id);
	if (timer !== undefined) {
		clearTimeout(timer);
		dismissTimers.delete(id);
	}
}

/**
 * Push a toast onto the shared queue. Auto-dismisses after `duration` ms
 * (default 4s); pass `duration: 0` to keep it visible until the user (or
 * another `dismissToast`/`clearToasts` call) removes it.
 *
 * Returns the entry's id so a caller can dismiss it early if needed.
 */
export function showToast({
	type,
	message,
	duration = DEFAULT_TOAST_DURATION_MS,
	actionLabel,
	onAction,
}: {
	type: ToastType;
	message: string;
	duration?: number;
	actionLabel?: string;
	onAction?: () => void;
}): string {
	const id = `toast-${++idCounter}`;
	toasts.update((entries) => [
		...entries,
		{ id, type, message, actionLabel, onAction },
	]);

	if (duration > 0) {
		dismissTimers.set(
			id,
			setTimeout(() => dismissToast(id), duration),
		);
	}

	return id;
}

/** Manually dismiss a single toast (the Toast component's close button). */
export function dismissToast(id: string): void {
	clearTimer(id);
	toasts.update((entries) => entries.filter((entry) => entry.id !== id));
}

/** Clear every active toast and cancel any pending auto-dismiss timers. */
export function clearToasts(): void {
	for (const id of [...dismissTimers.keys()]) clearTimer(id);
	toasts.set([]);
}
