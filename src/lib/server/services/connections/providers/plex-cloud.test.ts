import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	discoverPlexServers,
	pollPlexPin,
	renewPlexToken,
	startPlexPin,
} from "./plex-cloud";

const callback = "https://app.example/settings?section=connections";
const expiresAt = new Date(Date.now() + 200000).toISOString();
const pin = { id: 978, code: "a-valid-strong-pin", expiresAt, authToken: null };
const linked = async () =>
	startPlexPin(callback, async () => Response.json(pin));

describe("Plex cloud sign-in", () => {
	it("starts a strong PIN with a public signing key and checks that same PIN with a signed proof", async () => {
		const start = vi.fn<typeof fetch>(async () => Response.json(pin));
		const flow = await startPlexPin(callback, start);
		const [endpoint, req] = start.mock.calls[0];
		expect(endpoint).toBe("https://clients.plex.tv/api/v2/pins");
		expect(req?.redirect).toBe("error");
		const { strong, jwk } = JSON.parse(String(req?.body));
		expect(strong).toBe(true);
		expect(jwk).toMatchObject({
			kty: "OKP",
			crv: "Ed25519",
			kid: flow.device.kid,
			alg: "EdDSA",
		});
		expect(jwk).not.toHaveProperty("d");
		const url = new URL(flow.authUrl);
		expect(url.origin + url.pathname).toBe("https://app.plex.tv/auth");
		const params = new URLSearchParams(url.hash.slice(2));
		expect(params.get("forwardUrl")).toBe(callback);
		expect(params.get("code")).toBe(pin.code);
		expect(params.get("clientID")).toBe(flow.device.clientId);
		const poll = vi.fn<typeof fetch>(async () =>
			Response.json({ ...pin, authToken: "account-secret" }),
		);
		expect(await pollPlexPin(flow.device, flow.pinId, flow.code, poll)).toBe(
			"account-secret",
		);
		const probe = new URL(String(poll.mock.calls[0][0]));
		expect(probe.origin + probe.pathname).toBe(
			"https://clients.plex.tv/api/v2/pins/978",
		);
		const [h, p, s] = String(probe.searchParams.get("deviceJWT")).split(".");
		expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({
			aud: "plex.tv",
			iss: flow.device.clientId,
		});
		expect(
			verify(
				null,
				Buffer.from(`${h}.${p}`),
				createPublicKey({ key: jwk, format: "jwk" }),
				Buffer.from(s, "base64url"),
			),
		).toBe(true);
	});
	it("recognizes an unclaimed pin vs an expired pin, and rejects a mismatched PIN", async () => {
		const { device, pinId, code } = await linked();
		expect(
			await pollPlexPin(device, pinId, code, async () => Response.json(pin)),
		).toBeNull();
		await expect(
			pollPlexPin(
				device,
				pinId,
				code,
				async () => new Response(null, { status: 404 }),
			),
		).rejects.toMatchObject({ code: "expired" });
		await expect(
			pollPlexPin(device, pinId, code, async () =>
				Response.json({ ...pin, id: 23, authToken: "should-not-accept" }),
			),
		).rejects.toThrow();
	});
	it("renews the device with a one-use nonce, never its private key", async () => {
		const { device } = await linked();
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ nonce: "fresh-nonce" }))
			.mockResolvedValueOnce(Response.json({ auth_token: "new-token" }));
		expect(await renewPlexToken(device, fetcher)).toBe("new-token");
		expect(fetcher.mock.calls.map(([u]) => u)).toEqual([
			"https://clients.plex.tv/api/v2/auth/nonce",
			"https://clients.plex.tv/api/v2/auth/token",
		]);
		const wire = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
		expect(
			JSON.parse(Buffer.from(wire.jwt.split(".")[1], "base64url").toString()),
		).toMatchObject({
			nonce: "fresh-nonce",
			aud: "plex.tv",
			iss: device.clientId,
		});
		expect(JSON.stringify(fetcher.mock.calls)).not.toContain(device.privateKey);
	});
	it("withholds a distinct resource JWT that explicitly works at plex.tv", async () => {
		const { device } = await linked();
		const jwt = (aud: string | string[]) =>
			[
				"header",
				Buffer.from(JSON.stringify({ aud })).toString("base64url"),
				"signature",
			].join(".");
		const rows = ["plex.tv", ["pms", "plex.tv"], "pms"].map((aud, index) => ({
			clientIdentifier: `server-${index}`,
			name: "Home",
			owned: true,
			provides: "server",
			connections: [],
			accessToken: jwt(aud),
		}));
		const resources = await discoverPlexServers(
			device,
			"account-secret",
			async () => Response.json(rows),
		);
		expect(resources.map((row) => row.accessToken)).toEqual([
			null,
			null,
			rows[2].accessToken,
		]);
	});
	it("lists actual servers and retains only secure origins and resource credentials", async () => {
		const { device } = await linked();
		const resource = {
			name: "Home",
			clientIdentifier: "machine-1",
			owned: true,
			provides: "server",
			accessToken: "server-secret",
			connections: [
				{ uri: "https://home.example:32400", local: false, relay: false },
				{ uri: "https://home.example:32400/?key=bad" },
				{ uri: "http://home.example" },
				{ uri: "https://u:p@home.example" },
				{ uri: "file:///etc/hosts" },
			],
		};
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json([
				resource,
				{ ...resource, clientIdentifier: "player", provides: "player" },
				{
					...resource,
					clientIdentifier: "machine-2",
					accessToken: "account-secret",
					connections: [],
				},
			]),
		);
		const servers = await discoverPlexServers(
			device,
			"account-secret",
			fetcher,
		);
		expect(servers).toEqual([
			{
				id: "machine-1",
				name: "Home",
				owned: true,
				accessToken: "server-secret",
				connections: [
					{ uri: "https://home.example:32400", local: false, relay: false },
				],
			},
			{
				id: "machine-2",
				name: "Home",
				owned: true,
				accessToken: null,
				connections: [],
			},
		]);
		expect(
			new Headers(fetcher.mock.calls[0][1]?.headers).get("X-Plex-Token"),
		).toBe("account-secret");
	});
});
