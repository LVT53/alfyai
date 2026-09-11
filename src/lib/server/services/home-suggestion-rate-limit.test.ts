import { beforeEach, describe, expect, it } from "vitest";
import {
	_resetHomeSuggestionEventRateLimitForTests,
	checkHomeSuggestionEventRateLimit,
} from "./home-suggestion-rate-limit";

describe("checkHomeSuggestionEventRateLimit", () => {
	beforeEach(() => {
		_resetHomeSuggestionEventRateLimitForTests();
	});

	it("lets a real user's clicking through untouched", () => {
		// Acting on every chip of three deals is nine events; the cap must be
		// nowhere near that.
		for (let index = 0; index < 9; index += 1) {
			expect(checkHomeSuggestionEventRateLimit("user-1", 1_000 + index)).toBe(
				true,
			);
		}
	});

	it("closes the window on a client that will not stop", () => {
		let refused = 0;
		for (let index = 0; index < 200; index += 1) {
			if (!checkHomeSuggestionEventRateLimit("user-1", 1_000)) refused += 1;
		}
		expect(refused).toBeGreaterThan(0);
	});

	it("counts each user separately", () => {
		for (let index = 0; index < 200; index += 1) {
			checkHomeSuggestionEventRateLimit("noisy", 1_000);
		}
		expect(checkHomeSuggestionEventRateLimit("quiet", 1_000)).toBe(true);
	});

	it("opens again once the minute has passed", () => {
		let blockedAt = 0;
		for (let index = 0; index < 200; index += 1) {
			if (!checkHomeSuggestionEventRateLimit("user-1", 1_000)) {
				blockedAt = index;
				break;
			}
		}
		expect(blockedAt).toBeGreaterThan(0);
		expect(checkHomeSuggestionEventRateLimit("user-1", 1_000 + 61_000)).toBe(
			true,
		);
	});
});
