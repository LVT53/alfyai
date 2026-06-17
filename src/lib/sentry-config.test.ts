import { describe, expect, it } from "vitest";
import { type FilterableSentryEvent, filterSentryEvent } from "./sentry-config";

describe("sentry-config", () => {
	it("drops SvelteKit redirects captured through generic unhandled rejection handling", () => {
		const event = {
			type: undefined,
			exception: {
				values: [
					{
						type: "Error",
						value:
							"'Redirect' captured as exception with keys: location, status",
					},
				],
			},
		} satisfies FilterableSentryEvent;

		expect(
			filterSentryEvent(event, {
				originalException: { status: 303, location: "/login" },
			}),
		).toBeNull();
	});

	it("drops legacy Raven/Sentry UI noise reported as updateFrom errors", () => {
		const event = {
			type: undefined,
			request: {
				url: "http://example.com/foo",
			},
			exception: {
				values: [
					{
						type: "TypeError",
						value: "Object [object Object] has no method 'updateFrom'",
						stacktrace: {
							frames: [
								{ filename: "raven.js", function: "apply" },
								{
									filename: "../../sentry/scripts/views.js",
									function: "poll",
									in_app: true,
								},
								{
									filename: "../../sentry/scripts/views.js",
									function: "merge",
									in_app: true,
								},
								{
									filename: "../../sentry/scripts/views.js",
									function: "renderMemberInContainer",
									in_app: true,
								},
							],
						},
					},
				],
			},
		} satisfies FilterableSentryEvent;

		expect(filterSentryEvent(event)).toBeNull();
	});

	it("keeps application errors that do not match the legacy Sentry UI signature", () => {
		const event = {
			type: undefined,
			request: {
				url: "https://alfyai.example/chat/conversation-1",
			},
			exception: {
				values: [
					{
						type: "TypeError",
						value: "Cannot read properties of undefined",
						stacktrace: {
							frames: [
								{
									filename: "/src/lib/components/chat/MessageInput.svelte",
									function: "submitMessage",
									in_app: true,
								},
							],
						},
					},
				],
			},
		} satisfies FilterableSentryEvent;

		expect(filterSentryEvent(event)).toBe(event);
	});
});
