import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SESSION_EXPIRED_HEADER,
	SESSION_EXPIRED_MESSAGE,
} from "$lib/session-expiry";
import {
	captureSessionRequest,
	clearSessionExpiry,
	isSessionExpired,
	markSessionExpired,
	observeSessionFromResponse,
	sessionExpiry,
} from "./session";

function expiredResponse(): Response {
	return new Response(
		JSON.stringify({ error: SESSION_EXPIRED_MESSAGE, code: "session_expired" }),
		{
			status: 401,
			headers: {
				"Content-Type": "application/json",
				[SESSION_EXPIRED_HEADER]: "1",
			},
		},
	);
}

describe("session expiry store", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearSessionExpiry();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts with a live session", () => {
		expect(isSessionExpired()).toBe(false);
		expect(get(sessionExpiry).expired).toBe(false);
	});

	it("raises the row and one announcement when the gate refuses a request", () => {
		const before = get(sessionExpiry).alertCount;

		observeSessionFromResponse(expiredResponse());

		expect(isSessionExpired()).toBe(true);
		expect(get(sessionExpiry).expired).toBe(true);
		expect(get(sessionExpiry).alertCount).toBe(before + 1);
	});

	it("announces once for a burst of refused calls", () => {
		observeSessionFromResponse(expiredResponse());
		const afterFirst = get(sessionExpiry).alertCount;

		vi.advanceTimersByTime(5_000);
		observeSessionFromResponse(expiredResponse());
		observeSessionFromResponse(expiredResponse());

		expect(get(sessionExpiry).alertCount).toBe(afterFirst);
		expect(get(sessionExpiry).expired).toBe(true);
	});

	it("announces again for an action taken well after the first refusal", () => {
		observeSessionFromResponse(expiredResponse());
		const afterFirst = get(sessionExpiry).alertCount;

		vi.advanceTimersByTime(30_000);
		observeSessionFromResponse(expiredResponse());

		expect(get(sessionExpiry).alertCount).toBe(afterFirst + 1);
	});

	it("keeps the announcement counter moving forward across a clear", () => {
		observeSessionFromResponse(expiredResponse());
		const afterFirst = get(sessionExpiry).alertCount;

		clearSessionExpiry();
		observeSessionFromResponse(expiredResponse());

		expect(get(sessionExpiry).alertCount).toBe(afterFirst + 1);
	});

	it("clears itself once a request succeeds again", () => {
		markSessionExpired();

		observeSessionFromResponse(new Response("{}", { status: 200 }));

		expect(isSessionExpired()).toBe(false);
		expect(get(sessionExpiry).expired).toBe(false);
	});

	it("leaves the row alone for the other 401s in this app", () => {
		// A wrong password on the login form, or a wrong current password in
		// Settings: the credentials just typed were refused, the session was not.
		observeSessionFromResponse(
			new Response(JSON.stringify({ error: "Invalid email or password" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(isSessionExpired()).toBe(false);
	});

	it("leaves the row alone for an ordinary failure", () => {
		markSessionExpired();

		observeSessionFromResponse(new Response("nope", { status: 500 }));

		expect(isSessionExpired()).toBe(true);
	});

	it("tolerates the Response-like fakes the client tests inject", () => {
		expect(() =>
			observeSessionFromResponse({
				ok: true,
				status: 200,
			} as unknown as Response),
		).not.toThrow();
		expect(() => observeSessionFromResponse(undefined)).not.toThrow();
	});
});

describe("session request generations", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		markSessionExpired();
		clearSessionExpiry();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps healthy sibling responses authoritative until an auth transition", () => {
		const generation = captureSessionRequest();
		observeSessionFromResponse(new Response("{}"), generation);
		observeSessionFromResponse(expiredResponse(), generation);
		expect(isSessionExpired()).toBe(true);
	});

	it("heals from a fresh success, reannounces a new refusal, and preserves the throttle", () => {
		markSessionExpired();
		const first = get(sessionExpiry).alertCount;
		observeSessionFromResponse(new Response("{}"), captureSessionRequest());
		expect(isSessionExpired()).toBe(false);
		observeSessionFromResponse(expiredResponse(), captureSessionRequest());
		expect(get(sessionExpiry).alertCount).toBe(first + 1);
		vi.advanceTimersByTime(29_999);
		observeSessionFromResponse(expiredResponse(), captureSessionRequest());
		expect(get(sessionExpiry).alertCount).toBe(first + 1);
		vi.advanceTimersByTime(1);
		observeSessionFromResponse(expiredResponse(), captureSessionRequest());
		expect(get(sessionExpiry).alertCount).toBe(first + 2);
	});
});
