import { lookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPrivateHostname } from "../connections/host-locality";
import { NativeMemoryError } from "./contracts";

class PrivateMemoryEndpointError extends Error {
	constructor() {
		super("Memory destination is outside the deployment's private endpoints");
	}
}

function isPrivateServiceAddress(host: string): boolean {
	const family = isIP(host);
	if (family === 4)
		return isPrivateHostname(host) && !/^(?:0\.|169\.254\.)/.test(host);
	return family === 6 && (host === "::1" || /^f[cd][a-f0-9]{2}:/i.test(host));
}

function hostOf(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "");
}

export function privateMemoryUrl(value: string | URL): URL {
	const url = URL.parse(value);
	if (
		!url ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.hash ||
		(!isPrivateServiceAddress(hostOf(url)) &&
			!(
				url.protocol === "http:" &&
				["localhost", "host.docker.internal"].includes(url.hostname)
			))
	)
		throw new PrivateMemoryEndpointError();
	return url;
}

export function approvedMemoryBase(
	value: string,
	allowed: readonly string[],
): string {
	const url = privateMemoryUrl(value);
	const base = url.href.replace(/\/+$/, "");
	if (
		url.search ||
		!allowed.some(
			(candidate) => URL.parse(candidate)?.href.replace(/\/+$/, "") === base,
		)
	)
		throw new PrivateMemoryEndpointError();
	return base;
}

type BeforeDispatch = () => void | Promise<void>;

// An explicit agent uses direct sockets even when Node's global agents and
// Fetch dispatcher inherit --use-env-proxy. Both Memory credentials and
// curation bodies belong only on the checked private connection.
const httpAgent = new HttpAgent();
const httpsAgent = new HttpsAgent();

async function directMemoryRequest(
	input: RequestInfo | URL,
	init: RequestInit,
	beforeDispatch?: BeforeDispatch,
	maxResponseBytes?: number,
): Promise<Response> {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const body = request.body
		? Buffer.from(await request.arrayBuffer())
		: undefined;
	const headers = new Headers(request.headers);
	if (body) headers.set("content-length", String(body.byteLength));
	headers.set("accept-encoding", "identity");

	const preparation = beforeDispatch?.();
	if (preparation) await preparation;
	request.signal.throwIfAborted();

	const tls = url.protocol === "https:";
	const send = tls ? httpsRequest : httpRequest;
	return new Promise<Response>((resolve, reject) => {
		const outgoing = send(
			url,
			{
				agent: tls ? httpsAgent : httpAgent,
				method: request.method,
				headers: Object.fromEntries(headers),
				signal: request.signal,
			},
			(incoming) => {
				const status = incoming.statusCode ?? 500;
				if ([301, 302, 303, 307, 308].includes(status)) {
					incoming.destroy();
					reject(new Error("unexpected redirect"));
					return;
				}
				const chunks: Buffer[] = [];
				let responseBytes = 0;
				incoming.on("data", (chunk: Buffer) => {
					responseBytes += chunk.byteLength;
					if (
						maxResponseBytes !== undefined &&
						responseBytes > maxResponseBytes
					) {
						incoming.destroy();
						reject(new NativeMemoryError("native_format_unsupported", false));
						return;
					}
					chunks.push(chunk);
				});
				incoming.once("error", reject);
				incoming.once("end", () => {
					const responseHeaders = new Headers();
					for (let i = 0; i < incoming.rawHeaders.length; i += 2)
						responseHeaders.append(
							incoming.rawHeaders[i],
							incoming.rawHeaders[i + 1],
						);
					resolve(
						new Response(
							[204, 205, 304].includes(status) || request.method === "HEAD"
								? null
								: new Uint8Array(Buffer.concat(chunks)),
							{
								status,
								headers: responseHeaders,
								statusText: incoming.statusMessage,
							},
						),
					);
				});
			},
		);
		outgoing.once("error", reject);
		outgoing.end(body);
	});
}

/** Resolve special local names once per call and connect to the checked address. */
export async function fetchPrivateMemory(
	input: RequestInfo | URL,
	init?: RequestInit,
	fetcher?: typeof fetch,
	beforeDispatch?: BeforeDispatch,
	maxResponseBytes?: number,
): Promise<Response> {
	const url = privateMemoryUrl(input instanceof Request ? input.url : input);
	const host = hostOf(url);
	let request = input;
	const options = { ...init, redirect: "error" } satisfies RequestInit;
	if (!isPrivateServiceAddress(host)) {
		const signal =
			init?.signal ?? (input instanceof Request ? input.signal : null);
		signal?.throwIfAborted();
		const addresses = await lookup(host, { all: true });
		signal?.throwIfAborted();
		if (
			addresses.length === 0 ||
			addresses.some(({ address }) => !isPrivateServiceAddress(address))
		)
			throw new PrivateMemoryEndpointError();
		const selected =
			addresses.find((address) => address.family === 4) ?? addresses[0];
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		headers.set("Host", url.host);
		url.hostname =
			selected.family === 6 ? `[${selected.address}]` : selected.address;
		request = input instanceof Request ? new Request(url, input) : url.href;
		options.headers = headers;
	}
	if (!fetcher)
		return directMemoryRequest(
			request,
			options,
			beforeDispatch,
			maxResponseBytes,
		);
	const preparation = beforeDispatch?.();
	if (preparation) await preparation;
	return fetcher(request, options);
}
