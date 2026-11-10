import type { MessageUsageState } from "$lib/server/services/analytics";
import { fetchMessageUsage } from "./api/conversations";
import { ApiError } from "./api/http";

type ReadyUsage = Extract<MessageUsageState, { status: "ready" }>;
type UsageRun = {
	conversationId: string;
	controller: AbortController;
	pending: Map<string, number>;
};

/** Serial accounting reads keep conversation totals in order across queued turns. */
export function createMessageUsageRefresher(
	apply: (conversationId: string, messageId: string, usage: ReadyUsage) => void,
) {
	let active: UsageRun | null = null;
	const clear = () => {
		active?.controller.abort();
		active = null;
	};
	const run = async (state: UsageRun) => {
		const { signal } = state.controller;
		try {
			while (!signal.aborted && state.pending.size > 0) {
				for (const [messageId, attempts] of [...state.pending]) {
					if (signal.aborted) return;
					try {
						const usage = await fetchMessageUsage(
							state.conversationId,
							messageId,
							AbortSignal.any([signal, AbortSignal.timeout(5000)]),
						);
						if (signal.aborted) return;
						if (usage.status !== "pending") {
							state.pending.delete(messageId);
							if (usage.status === "ready") {
								apply(state.conversationId, messageId, usage);
							}
							continue;
						}
					} catch (error) {
						if (signal.aborted) return;
						if (
							error instanceof ApiError &&
							[401, 403, 404].includes(error.status)
						) {
							state.pending.delete(messageId);
							continue;
						}
					}
					// A failed accounting write must not cause unlimited background reads.
					if (attempts + 1 >= 40) state.pending.delete(messageId);
					else state.pending.set(messageId, attempts + 1);
				}
				if (state.pending.size > 0 && !signal.aborted) {
					await new Promise<void>((resolve) => {
						const done = () => {
							clearTimeout(timer);
							signal.removeEventListener("abort", done);
							resolve();
						};
						const timer = setTimeout(done, 500);
						signal.addEventListener("abort", done, { once: true });
					});
				}
			}
		} finally {
			if (active === state) active = null;
		}
	};
	return {
		clear,
		refresh(conversationId: string, messageId: string) {
			if (active?.conversationId === conversationId) {
				if (!active.pending.has(messageId)) active.pending.set(messageId, 0);
				return;
			}
			clear();
			const state: UsageRun = {
				conversationId,
				controller: new AbortController(),
				pending: new Map([[messageId, 0]]),
			};
			active = state;
			void run(state);
		},
	};
}
