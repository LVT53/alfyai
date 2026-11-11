import { expect, type Page } from "@playwright/test";

/** Hold the real browser stream before tool/card delivery, after live status exists.
 * No roles or payloads are changed. The test releases only after recording its
 * pre-arrival geometry, so a fast machine cannot skip the baseline phase.
 */
export async function holdThinkingCardDelivery(page: Page) {
	await page.evaluate(() => {
		const original = window.fetch.bind(window);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const state = { reached: false, release };
		Object.assign(window, { __thinkingCardDelivery: state });
		window.fetch = async (...args) => {
			const response = await original(...args);
			const url = String(args[0] instanceof Request ? args[0].url : args[0]);
			if (!url.endsWith("/api/chat/stream") || !response.body || !response.ok)
				return response;
			const decoder = new TextDecoder();
			const encoder = new TextEncoder();
			let pending = "";
			const body = response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					async transform(chunk, controller) {
						pending += decoder.decode(chunk, { stream: true });
						let end = pending.indexOf("\n\n");
						while (end !== -1) {
							const frame = pending.slice(0, end + 2);
							pending = pending.slice(end + 2);
							if (frame.includes('"data-tool-call"') && !state.reached) {
								state.reached = true;
								await gate;
							}
							controller.enqueue(encoder.encode(frame));
							end = pending.indexOf("\n\n");
						}
					},
					flush(controller) {
						pending += decoder.decode();
						if (pending) controller.enqueue(encoder.encode(pending));
					},
				}),
			);
			return new Response(body, {
				status: response.status,
				headers: response.headers,
			});
		};
	});
	return {
		async wait() {
			await expect
				.poll(() =>
					page.evaluate(
						() =>
							(
								window as unknown as {
									__thinkingCardDelivery: { reached: boolean };
								}
							).__thinkingCardDelivery.reached,
					),
				)
				.toBe(true);
			await expect(
				page
					.locator('[data-testid="assistant-message"] .thinking-header')
					.last(),
			).toBeVisible();
			// Observe actual painted frames, not a wall-clock delay.
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					),
			);
		},
		async release() {
			await page.evaluate(() =>
				(
					window as unknown as {
						__thinkingCardDelivery: { release: () => void };
					}
				).__thinkingCardDelivery.release(),
			);
		},
	};
}
