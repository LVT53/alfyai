// Test doubles for the outbound fetch: a transport that behaves the way `net`
// does around the `lookup` option, and a resolver that answers from a list.
// They exist so that no test of anything that fetches ever reaches a network.
import { EventEmitter } from "node:events";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { request as httpsRequest } from "node:https";
import { vi } from "vitest";
import type { HostResolver } from "../fetch";

export type LookupCallback = (
	error: Error | null,
	address: string | { address: string; family: number }[],
	family?: number,
) => void;

/** What `net` hands the lookup hook: called with the options it is given, never with an IP literal. */
export function runLookup(
	options: RequestOptions,
	wanted: { all?: boolean; family?: number },
): Promise<{
	error: Error | null;
	address: string | { address: string; family: number }[];
	family?: number;
}> {
	return new Promise((resolve) => {
		(
			options.lookup as unknown as (
				hostname: string,
				options: { all?: boolean; family?: number },
				callback: LookupCallback,
			) => void
		)(
			String(options.hostname),
			{ family: 0, ...wanted },
			(error, address, family) => resolve({ error, address, family }),
		);
	});
}

export interface FakeReply {
	status?: number;
	statusMessage?: string;
	headers?: Record<string, string | string[]>;
	chunks?: Buffer[];
	/** Never answer: for the timeout and the abort. */
	hang?: boolean;
}

/**
 * A stand-in for `https.request` that behaves the way `net` does around the
 * `lookup` option: it asks the hook to resolve the host, gives up if the hook
 * refuses, and otherwise "connects" to the first address it was handed.
 */
export function fakeTransport(reply: FakeReply = {}) {
	const calls: RequestOptions[] = [];
	const connectedTo: string[] = [];
	const transport = ((
		options: RequestOptions,
		onResponse: (message: IncomingMessage) => void,
	) => {
		calls.push(options);
		const outgoing = Object.assign(new EventEmitter(), {
			destroyed: false,
			destroy() {
				outgoing.destroyed = true;
			},
			end() {
				void (async () => {
					const looked = await runLookup(options, { all: true });
					if (looked.error) {
						outgoing.emit("error", looked.error);
						return;
					}
					const first = (
						looked.address as { address: string; family: number }[]
					)[0];
					connectedTo.push(first.address);
					if (reply.hang) {
						options.signal?.addEventListener("abort", () => {
							outgoing.emit(
								"error",
								Object.assign(new Error("aborted"), { name: "AbortError" }),
							);
						});
						return;
					}
					const message = Object.assign(new EventEmitter(), {
						statusCode: reply.status ?? 200,
						statusMessage: reply.statusMessage ?? "OK",
						headers: reply.headers ?? {},
						complete: false,
						destroy: vi.fn(),
					});
					onResponse(message as unknown as IncomingMessage);
					for (const chunk of reply.chunks ?? []) message.emit("data", chunk);
					message.complete = true;
					message.emit("end");
					message.emit("close");
				})();
			},
		});
		return outgoing;
	}) as unknown as typeof httpsRequest;
	return { transport, calls, connectedTo };
}

export function resolverTo(...addresses: string[]): HostResolver & {
	mock: { calls: unknown[][] };
} {
	return vi.fn(async () =>
		addresses.map((address) => ({
			address,
			family: address.includes(":") ? (6 as const) : (4 as const),
		})),
	) as unknown as HostResolver & { mock: { calls: unknown[][] } };
}
