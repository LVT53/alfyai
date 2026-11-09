import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	pendingSpotlight,
	requestSpotlight,
	SPOTLIGHT_REQUEST_TTL_MS,
	spotlightRequest,
	takeSpotlight,
} from "./spotlight";

describe("the spotlight request", () => {
	beforeEach(() => {
		spotlightRequest.set(null);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("takes a live request once", () => {
		requestSpotlight("settings.data", 1000);
		expect(takeSpotlight("settings.data", 1500)).toBe(true);
		expect(takeSpotlight("settings.data", 1600)).toBe(false);
	});

	it("lets a request lapse after six seconds", () => {
		requestSpotlight("composer.atlas", 0);
		expect(takeSpotlight("composer.atlas", 6001)).toBe(false);
	});

	it("is live up to, and not at, the moment it runs out", () => {
		expect(SPOTLIGHT_REQUEST_TTL_MS).toBe(6000);

		requestSpotlight("composer.atlas", 0);
		expect(takeSpotlight("composer.atlas", SPOTLIGHT_REQUEST_TTL_MS - 1)).toBe(
			true,
		);

		requestSpotlight("composer.atlas", 0);
		expect(takeSpotlight("composer.atlas", SPOTLIGHT_REQUEST_TTL_MS)).toBe(
			false,
		);
	});

	it("does not hand one control's request to another", () => {
		requestSpotlight("sidebar.search", 0);
		expect(takeSpotlight("sidebar.projects", 10)).toBe(false);
		expect(takeSpotlight("sidebar.search", 10)).toBe(true);
	});

	it("lets a newer request replace the older one, and start its own six seconds", () => {
		requestSpotlight("sidebar.search", 0);
		requestSpotlight("sidebar.projects", 5000);

		expect(takeSpotlight("sidebar.search", 5001)).toBe(false);
		// Six seconds from the newer request, not from the first.
		expect(takeSpotlight("sidebar.projects", 10_999)).toBe(true);
	});

	it("is not taken by a control that asks after the request has lapsed", () => {
		requestSpotlight("knowledge.memory", 0);
		expect(takeSpotlight("knowledge.memory", 60_000)).toBe(false);
	});

	it("stamps a request from the clock when it is given no time", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(10_000);

		requestSpotlight("settings.skills");

		expect(get(spotlightRequest)).toEqual({
			spotlight: "settings.skills",
			expiresAt: 10_000 + SPOTLIGHT_REQUEST_TTL_MS,
		});
		vi.setSystemTime(10_000 + SPOTLIGHT_REQUEST_TTL_MS - 1);
		expect(takeSpotlight("settings.skills")).toBe(true);
	});

	describe("pendingSpotlight", () => {
		it("names the control a live request is for, and takes nothing", () => {
			requestSpotlight("home.incognito", 0);

			expect(pendingSpotlight(get(spotlightRequest), 100)).toBe(
				"home.incognito",
			);
			expect(pendingSpotlight(get(spotlightRequest), 100)).toBe(
				"home.incognito",
			);
			expect(takeSpotlight("home.incognito", 100)).toBe(true);
		});

		it("names nothing without a request, or once it has lapsed", () => {
			expect(pendingSpotlight(null, 0)).toBeNull();

			requestSpotlight("home.incognito", 0);
			expect(
				pendingSpotlight(get(spotlightRequest), SPOTLIGHT_REQUEST_TTL_MS),
			).toBeNull();
		});

		it("reads the clock when it is given no time", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(50_000);
			const request = {
				spotlight: "settings.style",
				expiresAt: 50_001,
			} as const;

			expect(pendingSpotlight(request)).toBe("settings.style");
			vi.setSystemTime(50_001);
			expect(pendingSpotlight(request)).toBeNull();
		});
	});
});
