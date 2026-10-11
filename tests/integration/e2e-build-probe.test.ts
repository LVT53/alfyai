import { describe, expect, it } from "vitest";
import {
	hydrationFailure,
	type ProbePage,
	probeHydration,
} from "../e2e/build-probe";

// The e2e run asks the built app whether it starts before any test runs. These hold the
// probe to the three ways a build can fail that. The page object is a stand-in with the
// three methods the probe uses; what a real broken build does in a real browser was seen
// once by hand (the release gate's first run: a build made while `svelte-kit sync` ran
// threw "Cannot read properties of undefined (reading 'data')" and never mounted).

type Script = {
	/** Errors the page throws while it loads. */
	errors?: string[];
	/** Whether SvelteKit's root component ever mounts (`#svelte-announcer` appears). */
	mounts: boolean;
};

function fakePage(script: Script) {
	const calls: string[] = [];
	let onError: (error: Error) => void = () => {};
	const page = {
		on(event: string, handler: (error: Error) => void) {
			calls.push(`on ${event}`);
			if (event === "pageerror") onError = handler;
			return page;
		},
		async goto(url: string) {
			calls.push(`goto ${url}`);
			for (const message of script.errors ?? []) onError(new Error(message));
			return null;
		},
		async waitForSelector(selector: string, options?: { state?: string }) {
			calls.push(`waitForSelector ${selector} ${options?.state}`);
			if (!script.mounts) throw new Error("Timeout 15000ms exceeded");
			return null;
		},
	};
	return { page: page as unknown as ProbePage, calls };
}

describe("the probe that asks the built app whether it starts", () => {
	it("passes when the app mounts and the page threw nothing", async () => {
		const { page, calls } = fakePage({ mounts: true });
		await expect(
			probeHydration(page, "http://127.0.0.1:5450"),
		).resolves.toBeUndefined();
		expect(calls).toContain("goto http://127.0.0.1:5450/login");
		expect(calls).toContain("waitForSelector #svelte-announcer attached");
	});

	it("fails with the page's own error when the app never mounts", async () => {
		const { page } = fakePage({
			errors: ["Cannot read properties of undefined (reading 'data')"],
			mounts: false,
		});
		const failure = probeHydration(page, "http://127.0.0.1:5450");
		await expect(failure).rejects.toThrow(
			/Cannot read properties of undefined \(reading 'data'\)/,
		);
		await expect(
			probeHydration(
				fakePage({ errors: ["boom"], mounts: false }).page,
				"http://127.0.0.1:5450",
			),
		).rejects.toThrow(/npm run build/);
	});

	it("fails when the app mounts but the page threw on the way: a half-working page is not a pass", async () => {
		const { page } = fakePage({ errors: ["a module failed"], mounts: true });
		await expect(probeHydration(page, "http://127.0.0.1:5450")).rejects.toThrow(
			/a module failed/,
		);
	});

	it("says so when nothing mounted and nothing was thrown either", async () => {
		const { page } = fakePage({ mounts: false });
		await expect(probeHydration(page, "http://127.0.0.1:5450")).rejects.toThrow(
			/no page error was seen either/,
		);
	});

	it("names the address and the way out in its message", () => {
		const message = hydrationFailure("http://127.0.0.1:5451", ["x"]);
		expect(message).toContain("http://127.0.0.1:5451/login");
		expect(message).toContain("svelte-kit sync");
		expect(message).toContain("npm run build");
	});
});
