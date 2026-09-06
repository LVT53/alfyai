import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import {
	clearComposerQuoteRequest,
	composerQuoteRequest,
	requestComposerQuote,
} from "./composer-quote";

describe("composer-quote store", () => {
	it("starts empty and publishes a request with a distinct nonce", () => {
		clearComposerQuoteRequest();
		expect(get(composerQuoteRequest)).toBeNull();

		requestComposerQuote("Section 1: preview…");

		const request = get(composerQuoteRequest);
		expect(request?.text).toBe("Section 1: preview…");
		expect(typeof request?.nonce).toBe("number");
	});

	it("gives repeated requests for the same text distinct nonces", () => {
		requestComposerQuote("Same quote");
		const first = get(composerQuoteRequest);

		requestComposerQuote("Same quote");
		const second = get(composerQuoteRequest);

		expect(first?.nonce).not.toBe(second?.nonce);
	});

	it("clears back to null", () => {
		requestComposerQuote("Something");
		clearComposerQuoteRequest();
		expect(get(composerQuoteRequest)).toBeNull();
	});
});
