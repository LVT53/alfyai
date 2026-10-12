import {
	createServer as createHttpServer,
	request as httpRequest,
	type RequestOptions,
} from "node:http";
import type { request as httpsRequest } from "node:https";
import { createServer as createTcpServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assessOutboundUrl,
	createOutboundFetch,
	type HostResolver,
	OutboundFetchError,
} from "./fetch";
import {
	fakeTransport,
	type LookupCallback,
	resolverTo,
	runLookup,
} from "./testing/fake-transport";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the fetch to reject");
}

describe("assessOutboundUrl", () => {
	it.each([
		["https://example.com/favicon.ico"],
		["https://www.example.co.uk:8443/a/b?c=d#e"],
		["https://[2606:4700:4700::1111]/"],
		["https://8.8.8.8/"],
	])("lets %s through", (url) => {
		expect(assessOutboundUrl(url).ok).toBe(true);
	});

	it.each([
		["http://example.com/", "blocked_scheme"],
		["ftp://example.com/", "blocked_scheme"],
		["file:///etc/passwd", "blocked_scheme"],
		["javascript:alert(1)", "blocked_scheme"],
		["not a url", "bad_url"],
		["/relative/path", "bad_url"],
		["https://user:secret@example.com/", "bad_url"],
		["https://user@example.com/", "bad_url"],
		// What the audit found passing the text-based checks:
		["https://[::ffff:7f00:1]/", "blocked_address"],
		["https://[::ffff:127.0.0.1]/", "blocked_address"],
		["https://[::]/", "blocked_address"],
		["https://[::1]/", "blocked_address"],
		["https://100.64.0.1/", "blocked_address"],
		["https://100.127.255.255/x.png", "blocked_address"],
		["https://metadata.internal/", "blocked_host"],
		["https://anything.internal/x", "blocked_host"],
		// Spellings the URL parser turns into a loopback or private address:
		["https://127.0.0.1/", "blocked_address"],
		["https://0x7f.1/", "blocked_address"],
		["https://0177.0.0.1/", "blocked_address"],
		["https://2130706433/", "blocked_address"],
		["https://127.1/", "blocked_address"],
		["https://\uff11\uff12\uff17.\uff10.\uff10.\uff11/", "blocked_address"], // full-width digits
		["https://127\u30020\u30020\u30021/", "blocked_address"], // ideographic full stops
		["https://169.254.169.254/latest/meta-data/", "blocked_address"],
		["https://[fd00::1]/", "blocked_address"],
		["https://[64:ff9b::7f00:1]/", "blocked_address"],
		["https://[2002:7f00:1::]/", "blocked_address"],
		["https://localhost/", "blocked_host"],
		["https://LOCALHOST./", "blocked_host"],
		["https://printer.local/", "blocked_host"],
		["https://intranet/", "blocked_host"],
	])("refuses %s: %s", (url, code) => {
		const verdict = assessOutboundUrl(url);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.code).toBe(code);
	});
});

describe("createOutboundFetch: what it refuses before connecting", () => {
	it("never resolves or connects for a URL that fails the up-front check", async () => {
		const resolve = resolverTo("8.8.8.8");
		const { transport, calls } = fakeTransport();
		const outbound = createOutboundFetch({ resolve, request: transport });

		for (const url of [
			"https://[::ffff:7f00:1]/",
			"https://100.64.0.1/",
			"https://foo.internal/",
			"http://example.com/",
		]) {
			const error = await rejection(outbound(url));
			expect(error).toBeInstanceOf(OutboundFetchError);
		}
		expect(resolve).not.toHaveBeenCalled();
		expect(calls).toHaveLength(0);
	});

	it("refuses a public name that resolves to 127.0.0.1, and connects to nothing", async () => {
		const { transport, connectedTo } = fakeTransport();
		const outbound = createOutboundFetch({
			resolve: resolverTo("127.0.0.1"),
			request: transport,
		});

		const error = await rejection(outbound("https://cdn.example.com/a.png"));
		expect(error).toMatchObject({
			name: "OutboundFetchError",
			code: "blocked_address",
		});
		expect(connectedTo).toEqual([]);
	});

	it.each([
		[["::ffff:7f00:1"], "a mapped loopback"],
		[["::"], "the unspecified address"],
		[["100.64.0.9"], "CGNAT"],
		[["169.254.169.254"], "cloud metadata"],
		[["10.1.2.3"], "a private address"],
		[["fd00::5"], "a unique-local address"],
		[["64:ff9b::a00:1"], "a NAT64 address wrapping a private one"],
		[["93.184.216.34", "127.0.0.1"], "one public and one loopback answer"],
		[["2606:4700:4700::1111", "10.0.0.1"], "IPv6 public, IPv4 private"],
	])("refuses a name whose answers are %j (%s)", async (answers) => {
		const { transport, connectedTo } = fakeTransport();
		const outbound = createOutboundFetch({
			resolve: resolverTo(...answers),
			request: transport,
		});

		const error = await rejection(outbound("https://cdn.example.com/a.png"));
		expect(error).toMatchObject({ code: "blocked_address" });
		// All or nothing: a mixed answer is refused even though the first address
		// would have passed.
		expect(connectedTo).toEqual([]);
	});

	it("reports a name that does not resolve, and one that resolves to nothing", async () => {
		const failing = createOutboundFetch({
			resolve: vi.fn(async () => {
				throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
					code: "ENOTFOUND",
				});
			}),
			request: fakeTransport().transport,
		});
		expect(await rejection(failing("https://nope.example.com/"))).toMatchObject(
			{ code: "dns_failed" },
		);

		const empty = createOutboundFetch({
			resolve: resolverTo(),
			request: fakeTransport().transport,
		});
		expect(await rejection(empty("https://nope.example.com/"))).toMatchObject({
			code: "dns_failed",
		});
	});

	it("does not leak the host or the address into an error message", async () => {
		const outbound = createOutboundFetch({
			resolve: resolverTo("10.9.8.7"),
			request: fakeTransport().transport,
		});
		const error = (await rejection(
			outbound("https://secret-host.example.com/"),
		)) as Error;
		expect(error.message).not.toContain("secret-host");
		expect(error.message).not.toContain("10.9.8.7");
	});
});

describe("createOutboundFetch: it connects to the address it checked", () => {
	it("hands the transport exactly the checked answers, from one resolution", async () => {
		const resolve = resolverTo("93.184.216.34", "2606:2800:21f:cb07::1");
		const { transport, calls, connectedTo } = fakeTransport({
			chunks: [Buffer.from("ok")],
		});
		const outbound = createOutboundFetch({ resolve, request: transport });

		const response = await outbound("https://example.com/favicon.ico");

		expect(response.status).toBe(200);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(connectedTo).toEqual(["93.184.216.34"]);
		// The hook, not the host name, decides where the socket goes: asked for
		// one address it answers with the first checked one, asked for the list
		// (what `net` does when it races address families) with the whole list.
		const options = calls[0];
		const single = await runLookup(options, { all: false });
		expect(single).toMatchObject({
			error: null,
			address: "93.184.216.34",
			family: 4,
		});
		const all = await runLookup(options, { all: true });
		expect(all.address).toEqual([
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:2800:21f:cb07::1", family: 6 },
		]);
		const v6 = await runLookup(options, { all: false, family: 6 });
		expect(v6).toMatchObject({ address: "2606:2800:21f:cb07::1", family: 6 });
	});

	it("is not fooled by an answer that changes between two resolutions", async () => {
		// A rebinding name: public the first time it is asked, loopback after.
		// One request asks once, and connects to what that one answer said.
		const answers = [["93.184.216.34"], ["127.0.0.1"]];
		const resolve = vi.fn(async () =>
			(answers.shift() ?? ["127.0.0.1"]).map((address) => ({
				address,
				family: 4 as const,
			})),
		);
		const { transport, connectedTo } = fakeTransport({
			chunks: [Buffer.from("x")],
		});
		const outbound = createOutboundFetch({ resolve, request: transport });

		await outbound("https://rebind.example.com/");
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(connectedTo).toEqual(["93.184.216.34"]);

		// The next request asks again, and now gets refused.
		const error = await rejection(outbound("https://rebind.example.com/"));
		expect(error).toMatchObject({ code: "blocked_address" });
		expect(connectedTo).toEqual(["93.184.216.34"]);
	});

	it("sends one GET with a connection of its own and only the headers it allows", async () => {
		const { transport, calls } = fakeTransport();
		const outbound = createOutboundFetch({
			resolve: resolverTo("93.184.216.34"),
			request: transport,
		});

		await outbound("https://example.com:8443/a/b.ico?size=16", {
			headers: {
				Accept: "image/*",
				"Accept-Language": "hu",
				Cookie: "sid=secret",
				Authorization: "Bearer secret",
				"X-Anything": "no",
				"Accept-Encoding": "gzip, br",
			},
		});

		const options = calls[0];
		expect(options).toMatchObject({
			protocol: "https:",
			hostname: "example.com",
			port: 8443,
			path: "/a/b.ico?size=16",
			method: "GET",
			agent: false,
		});
		expect(options.headers).toEqual({
			accept: "image/*",
			"accept-language": "hu",
			"accept-encoding": "identity",
			"user-agent": "AlfyAI/2.0",
		});
	});

	it("uses port 443 when the URL names none, and strips brackets from an IPv6 literal", async () => {
		const { transport, calls } = fakeTransport();
		const outbound = createOutboundFetch({
			resolve: resolverTo("93.184.216.34"),
			request: transport,
		});
		await outbound("https://example.com/");
		await outbound("https://[2606:4700:4700::1111]/x");
		expect(calls[0]).toMatchObject({ hostname: "example.com", port: 443 });
		expect(calls[1]).toMatchObject({
			hostname: "2606:4700:4700::1111",
			port: 443,
			path: "/x",
		});
	});
});

describe("createOutboundFetch: redirects", () => {
	it("returns a 3xx as it is and never follows it", async () => {
		const { transport, calls } = fakeTransport({
			status: 302,
			statusMessage: "Found",
			headers: { location: "https://127.0.0.1/admin" },
		});
		const outbound = createOutboundFetch({
			resolve: resolverTo("93.184.216.34"),
			request: transport,
		});

		const response = await outbound("https://example.com/a.png", {
			redirect: "manual",
		});

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://127.0.0.1/admin");
		expect(calls).toHaveLength(1);
	});

	it("refuses the next hop when the caller follows a redirect into a private range", async () => {
		const { transport, calls } = fakeTransport({
			status: 301,
			headers: { location: "https://10.0.0.5/internal.png" },
		});
		const outbound = createOutboundFetch({
			resolve: resolverTo("93.184.216.34"),
			request: transport,
		});

		const first = await outbound("https://cdn.example.com/a.png");
		const next = new URL(
			first.headers.get("location") ?? "",
			"https://cdn.example.com/a.png",
		);
		expect(await rejection(outbound(next))).toMatchObject({
			code: "blocked_address",
		});
		expect(calls).toHaveLength(1);
	});

	it("refuses a redirect to a name that resolves to a private address", async () => {
		const resolve: HostResolver = vi.fn(async (hostname) => [
			hostname === "evil.example.net"
				? { address: "192.168.0.10", family: 4 as const }
				: { address: "93.184.216.34", family: 4 as const },
		]);
		const { transport } = fakeTransport({
			status: 302,
			headers: { location: "https://evil.example.net/x.png" },
		});
		const outbound = createOutboundFetch({ resolve, request: transport });

		const first = await outbound("https://cdn.example.com/a.png");
		const next = first.headers.get("location") ?? "";
		expect(await rejection(outbound(next))).toMatchObject({
			code: "blocked_address",
		});
	});
});

describe("createOutboundFetch: limits", () => {
	it("refuses a body that outgrows the cap while it arrives, whatever Content-Length said", async () => {
		const { transport } = fakeTransport({
			// No Content-Length at all: the usual way to stream past a cap.
			chunks: [Buffer.alloc(600), Buffer.alloc(600)],
		});
		const outbound = createOutboundFetch(
			{ resolve: resolverTo("93.184.216.34"), request: transport },
			{ maxBytes: 1000 },
		);
		expect(await rejection(outbound("https://example.com/big"))).toMatchObject({
			code: "too_large",
		});
	});

	it("refuses a declared length over the cap before reading anything", async () => {
		const { transport } = fakeTransport({
			headers: { "content-length": "5000" },
			chunks: [Buffer.alloc(10)],
		});
		const outbound = createOutboundFetch(
			{ resolve: resolverTo("93.184.216.34"), request: transport },
			{ maxBytes: 1000 },
		);
		expect(await rejection(outbound("https://example.com/big"))).toMatchObject({
			code: "too_large",
		});
	});

	it("accepts a body exactly at the cap", async () => {
		const { transport } = fakeTransport({ chunks: [Buffer.alloc(1000, 7)] });
		const outbound = createOutboundFetch(
			{ resolve: resolverTo("93.184.216.34"), request: transport },
			{ maxBytes: 1000 },
		);
		const response = await outbound("https://example.com/just-fits");
		expect((await response.arrayBuffer()).byteLength).toBe(1000);
	});

	it("gives up on a server that never answers", async () => {
		const { transport } = fakeTransport({ hang: true });
		const outbound = createOutboundFetch(
			{ resolve: resolverTo("93.184.216.34"), request: transport },
			{ timeoutMs: 30 },
		);
		expect(await rejection(outbound("https://example.com/slow"))).toMatchObject(
			{ code: "timeout" },
		);
	});

	it("honours the caller's own abort signal", async () => {
		const { transport } = fakeTransport({ hang: true });
		const outbound = createOutboundFetch(
			{ resolve: resolverTo("93.184.216.34"), request: transport },
			{ timeoutMs: 5_000 },
		);
		const controller = new AbortController();
		const pending = rejection(
			outbound("https://example.com/slow", { signal: controller.signal }),
		);
		setTimeout(() => controller.abort(), 10);
		expect(await pending).toMatchObject({ code: "aborted" });
	});
});

describe("createOutboundFetch: responses", () => {
	it("returns a real Response: status, headers (repeated ones kept) and bytes", async () => {
		const { transport } = fakeTransport({
			status: 200,
			statusMessage: "OK",
			headers: {
				"content-type": "image/png",
				"set-cookie": ["a=1", "b=2"],
			},
			chunks: [Buffer.from([1, 2]), Buffer.from([3])],
		});
		const outbound = createOutboundFetch({
			resolve: resolverTo("93.184.216.34"),
			request: transport,
		});

		const response = await outbound("https://example.com/i.png");

		expect(response.ok).toBe(true);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
			1, 2, 3,
		]);
	});

	it("answers 204 and 304 without a body, and reports an impossible status as a network failure", async () => {
		for (const status of [204, 304]) {
			const { transport } = fakeTransport({ status });
			const outbound = createOutboundFetch({
				resolve: resolverTo("93.184.216.34"),
				request: transport,
			});
			const response = await outbound("https://example.com/");
			expect(response.status).toBe(status);
			expect(response.body).toBeNull();
		}
		const { transport } = fakeTransport({ status: 99 });
		const outbound = createOutboundFetch({
			resolve: resolverTo("93.184.216.34"),
			request: transport,
		});
		expect(await rejection(outbound("https://example.com/"))).toMatchObject({
			code: "network",
		});
	});
});

describe("createOutboundFetch: through real sockets", () => {
	const servers: Server[] = [];
	afterEach(async () => {
		await Promise.all(
			servers
				.splice(0)
				.map(
					(server) => new Promise<void>((done) => server.close(() => done())),
				),
		);
	});

	async function listen(server: Server): Promise<number> {
		servers.push(server);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		return typeof address === "object" && address ? address.port : 0;
	}

	it("never opens a connection to a loopback server a public name points at", async () => {
		let connections = 0;
		const port = await listen(
			createTcpServer((socket) => {
				connections += 1;
				socket.destroy();
			}),
		);
		// The real transport and Node's real lookup plumbing; only DNS is replaced.
		const outbound = createOutboundFetch({
			resolve: resolverTo("127.0.0.1"),
		});

		const error = await rejection(
			outbound(`https://public-looking.example.com:${port}/favicon.ico`),
		);

		expect(error).toMatchObject({
			name: "OutboundFetchError",
			code: "blocked_address",
		});
		expect(connections).toBe(0);
	});

	it("gives Node's own lookup machinery the shape it asks for, and reads a real response", async () => {
		const http = createHttpServer((_request, response) => {
			response.writeHead(200, { "content-type": "image/png" });
			response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		});
		const port = await listen(http);

		// Public-looking answers go through the real guard. Only the last step is
		// the test's: the guard's verdict is kept, and the socket is pointed at
		// the loopback fixture, since no test may reach a public address.
		const resolve = resolverTo("93.184.216.34");
		const outbound = createOutboundFetch(
			{
				resolve,
				request: ((options: RequestOptions, callback: never) => {
					const guarded = options.lookup as unknown as (
						hostname: string,
						options: { all?: boolean; family?: number },
						callback: LookupCallback,
					) => void;
					return httpRequest(
						{
							...options,
							protocol: "http:",
							port,
							lookup: ((
								hostname: string,
								lookupOptions: { all?: boolean; family?: number },
								done: LookupCallback,
							) => {
								guarded(hostname, lookupOptions, (error, answers, family) => {
									if (error) return done(error, answers, family);
									// The guard said "public": prove its answer has the shape
									// Node asked for, then connect to the fixture instead.
									if (lookupOptions.all) {
										expect(Array.isArray(answers)).toBe(true);
										done(null, [{ address: "127.0.0.1", family: 4 }]);
									} else {
										expect(answers).toBe("93.184.216.34");
										done(null, "127.0.0.1", 4);
									}
								});
							}) as never,
						},
						callback,
					);
				}) as unknown as typeof httpsRequest,
			},
			{ timeoutMs: 5_000 },
		);

		const response = await outbound("https://images.example.com/i.png");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
			0x89, 0x50, 0x4e, 0x47,
		]);
		expect(resolve).toHaveBeenCalledTimes(1);
	});
});
