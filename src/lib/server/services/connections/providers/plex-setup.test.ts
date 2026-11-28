import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionHttpError } from "../provider-http";
import { connectLinkedPlex } from "./plex";
import {
	discoverPlexServers,
	pollPlexPin,
	renewPlexToken,
	startPlexPin,
} from "./plex-cloud";
import { pollPlexSetup, selectPlexServer, startPlexSetup } from "./plex-setup";

vi.mock("./plex", () => ({ connectLinkedPlex: vi.fn() }));
vi.mock("./plex-cloud", () => ({
	discoverPlexServers: vi.fn(),
	pollPlexPin: vi.fn(),
	startPlexPin: vi.fn(),
	renewPlexToken: vi.fn(),
}));
vi.mock("../store", () => ({
	getConnection: vi.fn(),
	getConnectionWithCredential: vi.fn(),
}));
const server = {
	id: "selected-machine",
	name: "Personal library",
	owned: true,
	accessToken: "machine-only",
	connections: [],
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(startPlexPin).mockResolvedValue({
		device: { clientId: "client", kid: "kid", privateKey: "private" },
		code: "secret-code",
		expiresAt: Date.now() + 100000,
		authUrl: "https://app.plex.tv/auth",
		pinId: 42,
	});
	vi.mocked(pollPlexPin).mockResolvedValue("account-token");
	vi.mocked(discoverPlexServers).mockResolvedValue([server]);
});
describe("account-bound Plex setup", () => {
	it("keeps authorization when the server is unreachable, and exposes only public picker fields", async () => {
		const user = randomUUID(),
			session = "own-session";
		const { attemptId } = await startPlexSetup(user, session);
		expect(await pollPlexSetup(user, "other-session", attemptId)).toEqual({
			status: "expired",
		});
		expect(await pollPlexSetup("other-user", session, attemptId)).toEqual({
			status: "expired",
		});
		expect(await pollPlexSetup(user, session, attemptId)).toEqual({
			status: "ready",
			servers: [{ id: server.id, name: server.name }],
		});
		await expect(
			selectPlexServer(user, session, attemptId, "fabricated"),
		).rejects.toMatchObject({ code: "server_unavailable" });
		vi.mocked(connectLinkedPlex).mockRejectedValueOnce(
			new ConnectionHttpError("unavailable", "server_unavailable"),
		);
		await expect(
			selectPlexServer(user, session, attemptId, server.id),
		).rejects.toMatchObject({ code: "server_unavailable" });
		expect(await startPlexSetup(user, session)).toMatchObject({
			attemptId,
			status: "ready",
		});
		expect(startPlexPin).toHaveBeenCalledTimes(1);
	});
	it("creates a fresh attempt when Plex has revoked device registration", async () => {
		const user = randomUUID(),
			session = "self";
		const { attemptId } = await startPlexSetup(user, session);
		vi.mocked(discoverPlexServers).mockRejectedValueOnce(
			new ConnectionHttpError("rejected", "needs_reauth"),
		);
		vi.mocked(renewPlexToken).mockRejectedValueOnce(
			new ConnectionHttpError("revoked", "needs_reauth"),
		);
		await expect(pollPlexSetup(user, session, attemptId)).rejects.toMatchObject(
			{ code: "needs_reauth" },
		);
		expect((await startPlexSetup(user, session)).attemptId).not.toBe(attemptId);
	});
});
