import { describe, expect, it, vi } from "vitest";
import type { PlexServerResource } from "./plex-cloud";
import { locateLinkedPlexServer } from "./plex-linked";

const device = { clientId: "client", kid: "kid", privateKey: "never-send" };
const row = (
	uri: string,
	token: string | null,
	owned: boolean,
): PlexServerResource => ({
	id: "machine",
	name: "Library",
	owned,
	accessToken: token,
	connections: [{ uri, local: false, relay: false }],
});
function respond(identity: string, auth = "scoped") {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input)),
			token = new Headers(init?.headers).get("x-plex-token");
		expect(init?.redirect).toBe("error");
		if (url.pathname === "/identity") {
			expect(token).toBeNull();
			return Response.json({ MediaContainer: { machineIdentifier: identity } });
		}
		expect(url.pathname).toBe("/library/sections");
		return token === auth
			? Response.json({ MediaContainer: { Directory: [] } })
			: new Response(null, { status: 401 });
	});
}
describe("Plex selected-server validation", () => {
	it("requires a credential-free machine match before sending the server token", async () => {
		const fetch = respond("wrong");
		await expect(
			locateLinkedPlexServer(
				row("https://server.example", "scoped", true),
				device,
				"account",
				{ fetch },
			),
		).rejects.toMatchObject({ code: "server_unavailable" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("rejects public identity with a denied library read", async () => {
		const fetch = respond("machine", "unrelated");
		await expect(
			locateLinkedPlexServer(
				row("https://server.example", "scoped", true),
				device,
				"account",
				{ fetch },
			),
		).rejects.toMatchObject({ code: "server_unavailable" });
	});
	it("uses the account credential only on an owned Plex-issued origin after checking identity", async () => {
		const fetch = respond("machine", "account");
		for (const [host, owned] of [
			["server.example", true],
			["server.plex.direct", false],
			["plex.direct.bad.example", true],
		] as const) {
			await expect(
				locateLinkedPlexServer(
					row(`https://${host}`, null, owned),
					device,
					"account",
					{ fetch },
				),
			).rejects.toMatchObject({ code: "no_server_grant" });
		}
		expect(fetch).not.toHaveBeenCalled();
		await expect(
			locateLinkedPlexServer(
				row("https://server.plex.direct", null, true),
				device,
				"account",
				{ fetch },
			),
		).resolves.toEqual({
			origin: "https://server.plex.direct",
			token: "account",
		});
	});
});
