import { describe, expect, it, vi } from "vitest";
import {
	apiKeyHeader,
	basicAuthHeader,
	bearerAuthHeader,
	ConnectionHttpError,
	providerFetch,
} from "./provider-http";

describe("provider-http: ConnectionHttpError", () => {
	it("carries a message + code and is an Error", () => {
		const err = new ConnectionHttpError("boom", "request_failed");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(ConnectionHttpError);
		expect(err.message).toBe("boom");
		expect(err.code).toBe("request_failed");
		expect(err.name).toBe("ConnectionHttpError");
	});
});

describe("provider-http: auth header helpers", () => {
	it("bearerAuthHeader builds an Authorization: Bearer header", () => {
		expect(bearerAuthHeader("tok123")).toEqual({
			Authorization: "Bearer tok123",
		});
	});

	it("apiKeyHeader builds an x-api-key header", () => {
		expect(apiKeyHeader("secret-key")).toEqual({ "x-api-key": "secret-key" });
	});

	it("basicAuthHeader base64-encodes user:password", () => {
		const expected = `Basic ${Buffer.from("alice:hunter2").toString("base64")}`;
		expect(basicAuthHeader("alice", "hunter2")).toBe(expected);
	});
});

describe("provider-http: providerFetch", () => {
	it("passes the url + init through to the injected fetch and returns its response", async () => {
		const response = new Response("ok", { status: 200 });
		const fakeFetch = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => response,
		);
		const result = await providerFetch("https://example.com/x", {
			method: "POST",
			body: "hi",
			fetch: fakeFetch as unknown as typeof fetch,
		});
		expect(result).toBe(response);
		expect(fakeFetch).toHaveBeenCalledTimes(1);
		const [url, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://example.com/x");
		expect(init.method).toBe("POST");
		expect(init.body).toBe("hi");
		// A fresh AbortSignal is always wired through.
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.signal?.aborted).toBe(false);
	});

	it("throws a request_failed ConnectionHttpError when the request times out", async () => {
		vi.useFakeTimers();
		try {
			const hangingFetch = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							const abortErr = new Error("The operation was aborted");
							abortErr.name = "AbortError";
							reject(abortErr);
						});
					}),
			);
			const promise = providerFetch("https://example.com/hang", {
				fetch: hangingFetch as unknown as typeof fetch,
			});
			const assertion = expect(promise).rejects.toMatchObject({
				code: "request_failed",
			});
			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;
			await promise.catch((err) => {
				expect(err).toBeInstanceOf(ConnectionHttpError);
				expect((err as Error).message).toContain("timed out");
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("honors an overridden timeoutMs", async () => {
		vi.useFakeTimers();
		try {
			const hangingFetch = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							const abortErr = new Error("aborted");
							abortErr.name = "AbortError";
							reject(abortErr);
						});
					}),
			);
			const promise = providerFetch("https://example.com/hang", {
				fetch: hangingFetch as unknown as typeof fetch,
				timeoutMs: 500,
			});
			const assertion = expect(promise).rejects.toMatchObject({
				code: "request_failed",
			});
			// Not yet fired at 499ms; fires at 500ms.
			await vi.advanceTimersByTimeAsync(499);
			await vi.advanceTimersByTimeAsync(1);
			await assertion;
			await promise.catch((err) => {
				expect((err as Error).message).toContain("500ms");
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses a provided timeoutError factory to build the abort error", async () => {
		vi.useFakeTimers();
		try {
			class MyErr extends Error {
				constructor(
					message: string,
					public readonly code: string,
				) {
					super(message);
					this.name = "MyErr";
				}
			}
			const hangingFetch = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => {
							const abortErr = new Error("aborted");
							abortErr.name = "AbortError";
							reject(abortErr);
						});
					}),
			);
			const promise = providerFetch("https://example.com/hang", {
				fetch: hangingFetch as unknown as typeof fetch,
				timeoutError: (ms) => new MyErr(`custom timed out ${ms}`, "boom"),
			});
			const assertion = expect(promise).rejects.toBeInstanceOf(MyErr);
			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;
			await promise.catch((err) => {
				expect((err as Error).message).toBe("custom timed out 15000");
				expect((err as MyErr).code).toBe("boom");
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-throws a non-abort fetch rejection unchanged", async () => {
		const networkErr = new Error("ECONNREFUSED");
		const failingFetch = vi.fn(async () => {
			throw networkErr;
		});
		await expect(
			providerFetch("https://example.com/x", {
				fetch: failingFetch as unknown as typeof fetch,
			}),
		).rejects.toBe(networkErr);
	});

	it("clears the timeout on success so the signal never aborts afterward", async () => {
		vi.useFakeTimers();
		try {
			let capturedSignal: AbortSignal | undefined;
			const okFetch = vi.fn(
				async (_input: RequestInfo | URL, init?: RequestInit) => {
					capturedSignal = init?.signal ?? undefined;
					return new Response("ok", { status: 200 });
				},
			);
			await providerFetch("https://example.com/x", {
				fetch: okFetch as unknown as typeof fetch,
			});
			// Advancing well past the timeout must not abort a settled request.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(capturedSignal?.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
