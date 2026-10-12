import { afterEach, describe, expect, it, vi } from "vitest";

// The Sentry SDK needs SvelteKit's `$app` modules, which a unit test does not have;
// nothing here is about Sentry (no DSN is set, so nothing is initialised).
vi.mock("@sentry/sveltekit", () => ({
	init: vi.fn(),
	handleErrorWithSentry: () => () => undefined,
	browserTracingIntegration: vi.fn(),
	replayIntegration: vi.fn(),
}));

// FB-8 (FG's finding 2): on the production build the map route card's page logged a
// report-only Content-Security-Policy violation, "Evaluating a string as JavaScript
// violates ... 'unsafe-eval'". It was not MapLibre: zod 4 builds a fast parser for
// every object schema with `new Function`, and probes for that permission with
// `Function("")` the first time one is made. The browser's policy has no
// 'unsafe-eval' (and must not get one), so the probe is a violation every page
// that builds a schema reports. The client entry turns the fast path off.

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetModules();
});

// zod is a dependency, loaded once for the whole file: the state test comes first,
// while nothing has switched the fast path off yet.
describe("the browser's zod", () => {
	it("is set up by the client entry before any route module builds a schema", async () => {
		vi.resetModules();
		const { config } = await import("zod/v4/core");
		expect(config().jitless).toBeFalsy();
		await import("./hooks.client");
		expect(config().jitless).toBe(true);
	});

	it("never asks the browser to evaluate a string when a schema is built and used", async () => {
		vi.resetModules();
		await import("./hooks.client");
		const evaluated = vi.spyOn(globalThis, "Function");

		const { z } = await import("zod");
		const schema = z.object({ id: z.string(), size: z.number().optional() });
		expect(schema.parse({ id: "a" })).toEqual({ id: "a" });
		expect(schema.safeParse({ id: 1 }).success).toBe(false);

		expect(evaluated).not.toHaveBeenCalled();
	});
});
