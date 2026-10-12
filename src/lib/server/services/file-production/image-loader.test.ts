import { describe, expect, it, vi } from "vitest";
import { createOutboundFetch, OutboundFetchError } from "$lib/server/outbound";
import {
	fakeTransport,
	resolverTo,
} from "$lib/server/outbound/testing/fake-transport";
import { loadGeneratedDocumentImage } from "./image-loader";

const ONE_BY_ONE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const ONE_BY_ONE_PNG = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");

describe("generated document image loader", () => {
	it("accepts size-limited PNG data image sources", async () => {
		const result = await loadGeneratedDocumentImage(
			{
				kind: "data",
				mimeType: "image/png",
				data: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
			},
			{ maxImageBytes: 1024 },
		);

		expect(result).toMatchObject({
			ok: true,
			image: {
				mimeType: "image/png",
				bytes: ONE_BY_ONE_PNG,
			},
		});
	});

	it("rejects unsafe URL schemes and private hosts before fetching", async () => {
		const fetchImpl = vi.fn();

		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "http://example.com/image.png" },
				{ fetchImpl },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });
		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://127.0.0.1/image.png" },
				{ fetchImpl },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("revalidates redirect targets and rejects non-image responses", async () => {
		const redirectFetch = vi.fn(async () => {
			return new Response(null, {
				status: 302,
				headers: { location: "https://localhost/private.png" },
			});
		});
		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://cdn.example.com/image.png" },
				{ fetchImpl: redirectFetch },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });

		const htmlFetch = vi.fn(async () => {
			return new Response("<html></html>", {
				headers: { "content-type": "text/html" },
			});
		});
		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://cdn.example.com/image.png" },
				{ fetchImpl: htmlFetch },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });
	});

	it("rejects oversized images before returning bytes", async () => {
		await expect(
			loadGeneratedDocumentImage(
				{ kind: "data", mimeType: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
				{ maxImageBytes: 8 },
			),
		).resolves.toMatchObject({
			ok: false,
			code: "image_limit_exceeded",
		});
	});

	it.each([
		// What the audit measured passing the old text-based checks:
		["https://[::ffff:7f00:1]/image.png", "an IPv4-mapped loopback"],
		["https://[::]/image.png", "the unspecified address"],
		["https://100.64.0.1/image.png", "carrier-grade NAT"],
		["https://metadata.internal/image.png", "a .internal name"],
		["https://anything.internal/image.png", "a .internal name"],
		// Spellings a URL parser turns into a private address:
		["https://0x7f.1/image.png", "hex loopback"],
		["https://2130706433/image.png", "decimal loopback"],
		["https://127.1/image.png", "short loopback"],
		["https://[64:ff9b::7f00:1]/image.png", "NAT64 loopback"],
		["https://[2002:7f00:1::]/image.png", "6to4 loopback"],
		["https://169.254.169.254/latest/meta-data/", "cloud metadata"],
		["https://localhost/image.png", "localhost"],
		["https://printer.local/image.png", "an mDNS name"],
		["https://user:secret@cdn.example.com/image.png", "credentials"],
		["not a url", "not a URL"],
	])("never fetches %s (%s)", async (url) => {
		const fetchImpl = vi.fn();

		await expect(
			loadGeneratedDocumentImage({ kind: "https", url }, { fetchImpl }),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });

		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		["https://[::ffff:a00:1]/private.png"],
		["https://100.64.0.1/private.png"],
		["https://printer.internal/private.png"],
		["https://10.0.0.5/private.png"],
		["https://[fd00::1]/private.png"],
	])("rejects a redirect into %s and goes no further", async (target) => {
		const fetchImpl = vi.fn(async () => {
			return new Response(null, { status: 301, headers: { location: target } });
		});

		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://cdn.example.com/image.png" },
				{ fetchImpl },
			),
		).resolves.toMatchObject({
			ok: false,
			message: "Image redirect target is not allowed.",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("follows a redirect to another public address, and gives up after three", async () => {
		const fetchImpl = vi.fn(async (url: string | URL) => {
			const next = Number(String(url).match(/hop(\d+)/)?.[1] ?? 0) + 1;
			return new Response(null, {
				status: 302,
				headers: { location: `/hop${next}.png` },
			});
		});

		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://cdn.example.com/hop0.png" },
				{ fetchImpl },
			),
		).resolves.toMatchObject({
			ok: false,
			message: "Image redirected too many times.",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it("reports a redirect with a malformed target as a failure, not an exception", async () => {
		const fetchImpl = vi.fn(async () => {
			return new Response(null, {
				status: 302,
				headers: { location: "https://[bad" },
			});
		});

		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://cdn.example.com/image.png" },
				{ fetchImpl },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });
	});

	it("turns a fetch that throws into a failed image, so a block can fall back to its placeholder", async () => {
		for (const error of [
			new OutboundFetchError("blocked_address"),
			new OutboundFetchError("timeout"),
			new TypeError("fetch failed"),
		]) {
			const fetchImpl = vi.fn(async () => {
				throw error;
			});
			await expect(
				loadGeneratedDocumentImage(
					{ kind: "https", url: "https://cdn.example.com/image.png" },
					{ fetchImpl },
				),
			).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });
		}
	});

	it("does not say where it went wrong in the failure message", async () => {
		const outbound = createOutboundFetch({
			resolve: resolverTo("10.9.8.7"),
			request: fakeTransport().transport,
		});
		const result = await loadGeneratedDocumentImage(
			{ kind: "https", url: "https://secret-host.example.com/image.png" },
			{ fetchImpl: outbound },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).not.toContain("secret-host");
			expect(result.message).not.toContain("10.9.8.7");
		}
	});
});

describe("generated document image loader behind the outbound guard", () => {
	const PUBLIC = "93.184.216.34";

	it("refuses a public name that resolves to 127.0.0.1 and connects to nothing", async () => {
		const { transport, connectedTo } = fakeTransport({
			headers: { "content-type": "image/png" },
			chunks: [ONE_BY_ONE_PNG],
		});

		const result = await loadGeneratedDocumentImage(
			{ kind: "https", url: "https://cdn.example.com/image.png" },
			{
				fetchImpl: createOutboundFetch({
					resolve: resolverTo("127.0.0.1"),
					request: transport,
				}),
			},
		);

		expect(result).toMatchObject({
			ok: false,
			message: "Image URL is not an allowed HTTPS URL.",
		});
		expect(connectedTo).toEqual([]);
	});

	it("loads a picture from a public address", async () => {
		const { transport, connectedTo } = fakeTransport({
			headers: { "content-type": "image/png" },
			chunks: [ONE_BY_ONE_PNG],
		});

		const result = await loadGeneratedDocumentImage(
			{ kind: "https", url: "https://cdn.example.com/image.png" },
			{
				fetchImpl: createOutboundFetch({
					resolve: resolverTo(PUBLIC),
					request: transport,
				}),
			},
		);

		expect(result).toMatchObject({
			ok: true,
			image: { mimeType: "image/png", bytes: ONE_BY_ONE_PNG },
		});
		expect(connectedTo).toEqual([PUBLIC]);
	});

	it("refuses a redirect to a name that resolves into the private network", async () => {
		const resolve = vi.fn(async (hostname: string) => [
			{
				address:
					hostname === "intranet-alias.example.net" ? "192.168.0.10" : PUBLIC,
				family: 4 as const,
			},
		]);
		const { transport, connectedTo } = fakeTransport({
			status: 302,
			headers: { location: "https://intranet-alias.example.net/image.png" },
		});

		const result = await loadGeneratedDocumentImage(
			{ kind: "https", url: "https://cdn.example.com/image.png" },
			{ fetchImpl: createOutboundFetch({ resolve, request: transport }) },
		);

		expect(result).toMatchObject({ ok: false });
		// The first hop was connected to, the second never was.
		expect(connectedTo).toEqual([PUBLIC]);
	});

	it("stops a body that outgrows the image limit while it streams in", async () => {
		const { transport } = fakeTransport({
			headers: { "content-type": "image/png" },
			// No Content-Length, and more than the limit.
			chunks: [Buffer.alloc(30), Buffer.alloc(30)],
		});

		const result = await loadGeneratedDocumentImage(
			{ kind: "https", url: "https://cdn.example.com/image.png" },
			{
				maxImageBytes: 40,
				fetchImpl: createOutboundFetch(
					{ resolve: resolverTo(PUBLIC), request: transport },
					{ maxBytes: 40 },
				),
			},
		);

		expect(result).toMatchObject({
			ok: false,
			message: "Image bytes exceed the configured limit.",
		});
	});
});
