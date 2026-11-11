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
		/** Called with final synthesis held by the fixture, after tool delivery.
		 * Collect real layout samples before the test may release that hold.
		 */
		async sampleLiveCard(cardSelector: string) {
			const samples = await page.evaluate(
				(selector) =>
					new Promise<Array<{ offset: number; cardTop: number }>>(
						(resolve, reject) => {
							const samples: Array<{ offset: number; cardTop: number }> = [];
							const sample = () => {
								const card = document.querySelector(selector);
								const header = document.querySelector(
									'[data-testid="assistant-message"] .thinking-header',
								);
								const user = document.querySelector(
									'[data-testid="user-message"]',
								);
								const answer = document.querySelector(
									'[data-testid="assistant-message"] .prose-container p',
								);
								if (
									!card ||
									!header ||
									!user ||
									answer ||
									!document.querySelector('[data-testid="stop-button"]')
								) {
									reject(
										new Error(
											"Missing live card/status phase before synthesis release",
										),
									);
									return;
								}
								samples.push({
									offset:
										header.getBoundingClientRect().top -
										user.getBoundingClientRect().top,
									cardTop: card.getBoundingClientRect().top,
								});
								if (samples.length === 2) resolve(samples);
								else requestAnimationFrame(sample);
							};
							requestAnimationFrame(sample);
						},
					),
				cardSelector,
			);
			expect(
				samples,
				"painted live card/status samples while synthesis is held",
			).toHaveLength(2);
			return samples;
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
