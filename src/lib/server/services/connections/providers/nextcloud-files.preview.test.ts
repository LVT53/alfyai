import { describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "../store";
import { NextcloudFilesError, nextcloudPreview } from "./nextcloud-files";

// nextcloudPreview takes the connection and its decrypted secret directly and
// touches no database, so this harness stays a plain ConnectionPublic plus a
// per-case fetch stub — no sqlite/migration fixture like the write tests need.
function makeConn(config: Record<string, unknown>): ConnectionPublic {
	return {
		id: "conn-1",
		userId: "user-1",
		provider: "nextcloud",
		label: "Nextcloud",
		accountIdentifier: "alice",
		status: "connected",
		statusDetail: null,
		defaultOn: false,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["files"],
		config,
		oauthScopes: [],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

const CONN = makeConn({
	serverUrl: "https://cloud.example.com",
	loginName: "alice",
});

const SECRET = "app-password-xyz";
const PREVIEW_URL = "https://cloud.example.com/index.php/core/preview";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function jpegResponse(): Response {
	return new Response(JPEG_BYTES, {
		status: 200,
		headers: {
			"Content-Type": "image/jpeg",
			"Content-Length": String(JPEG_BYTES.byteLength),
		},
	});
}

describe("nextcloudPreview", () => {
	it("returns the bytes of a real image preview", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("Authorization")).toBe(
					`Basic ${Buffer.from(`alice:${SECRET}`).toString("base64")}`,
				);
				expect(headers.get("User-Agent")).toBe("AlfyAI");
				return jpegResponse();
			},
		);

		const result = await nextcloudPreview(
			CONN,
			SECRET,
			{ fileId: 42, size: 192 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toEqual({
			bytes: expect.anything(),
			contentType: "image/jpeg",
		});
		expect(new Uint8Array(result?.bytes ?? new ArrayBuffer(0))).toEqual(
			JPEG_BYTES,
		);
	});

	it("treats a missing preview as nothing", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ fileId: 42, size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).resolves.toBeNull();
	});

	it("never follows the mime-icon redirect", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				// A followed 303 would hand back Nextcloud's file-type icon, which
				// the card would then draw as if it were the picture.
				expect(init?.redirect).toBe("manual");
				return new Response(null, {
					status: 303,
					headers: { Location: "/core/img/filetypes/image.svg" },
				});
			},
		);

		const result = await nextcloudPreview(
			CONN,
			SECRET,
			{ fileId: 42, size: 192 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(result).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("refuses a non-image body", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("<html>not a picture</html>", {
					status: 200,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				}),
		);

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ fileId: 42, size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).resolves.toBeNull();
	});

	it("refuses an SVG body", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("<svg></svg>", {
					status: 200,
					headers: { "Content-Type": "image/svg+xml" },
				}),
		);

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ fileId: 42, size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).resolves.toBeNull();
	});

	it("treats a forbidden preview as nothing", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ fileId: 42, size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).resolves.toBeNull();
	});

	it("refuses an over-cap preview from its declared length", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JPEG_BYTES, {
					status: 200,
					headers: {
						"Content-Type": "image/jpeg",
						"Content-Length": String(6 * 1024 * 1024 + 1),
					},
				}),
		);

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ fileId: 42, size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).resolves.toBeNull();
	});

	// The viewer asks for 1600px, where a detailed photo can pass the 2 MB a
	// card thumbnail needed; the cap now bounds that picture too.
	it("serves a viewer picture larger than the old 2 MB thumbnail cap", async () => {
		const viewerBytes = new Uint8Array(3 * 1024 * 1024);
		const fetchMock = vi.fn(
			async () =>
				new Response(viewerBytes, {
					status: 200,
					headers: { "Content-Type": "image/jpeg" },
				}),
		);

		const preview = await nextcloudPreview(
			CONN,
			SECRET,
			{ fileId: 42, size: 1600 },
			{ fetch: fetchMock as unknown as typeof fetch },
		);

		expect(preview?.bytes.byteLength).toBe(viewerBytes.byteLength);
	});

	it("throws needs_reauth on a 401, like the other reads", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ fileId: 42, size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toMatchObject({ code: "needs_reauth" });
	});

	it("throws on a server error so the route can answer 502", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ fileId: 42, size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toBeInstanceOf(NextcloudFilesError);
	});

	it("propagates a network error", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network down");
		});

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ fileId: 42, size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toThrow("network down");
	});

	it("asks by id, and by path only when there is no id", async () => {
		const idFetch = vi.fn(async (input: RequestInfo | URL) => {
			// Both forms supplied: the id wins, so the path never reaches the URL.
			expect(String(input)).toBe(
				`${PREVIEW_URL}?fileId=42&x=192&y=192&a=1&mode=fill&forceIcon=0`,
			);
			return jpegResponse();
		});

		await nextcloudPreview(
			CONN,
			SECRET,
			{ fileId: 42, path: "Photos/lake.jpg", size: 192 },
			{ fetch: idFetch as unknown as typeof fetch },
		);

		const pathFetch = vi.fn(async (input: RequestInfo | URL) => {
			// The leading slash is stripped by normalizeNextcloudPath and the
			// remaining path is URL-encoded by the query string.
			expect(String(input)).toBe(
				`${PREVIEW_URL}.png?file=Photos%2Flake.jpg&x=192&y=192&a=1&mode=fill&forceIcon=0`,
			);
			return jpegResponse();
		});

		await nextcloudPreview(
			CONN,
			SECRET,
			{ path: "/Photos/lake.jpg", size: 192 },
			{ fetch: pathFetch as unknown as typeof fetch },
		);

		expect(idFetch).toHaveBeenCalledTimes(1);
		expect(pathFetch).toHaveBeenCalledTimes(1);
	});

	it("rejects a traversal path before any fetch is made", async () => {
		const fetchMock = vi.fn();

		await expect(
			nextcloudPreview(
				CONN,
				SECRET,
				{ path: "../secret", size: 192 },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toBeInstanceOf(NextcloudFilesError);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
