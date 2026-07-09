import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchActiveCapabilities,
	fetchNextcloudFolders,
	fetchOwnTracksDevices,
	pollNextcloudConnect,
	startAppleConnect,
	startEmailConnect,
	startGoogleConnect,
	startImmichConnect,
	startNextcloudConnect,
	startOwnTracksConnect,
	startPlexConnect,
} from "./connections";

afterEach(() => {
	vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("fetchActiveCapabilities", () => {
	it("requests the active-capabilities endpoint and returns served/defaultOn/accounts", async () => {
		const payload = {
			served: ["calendar", "files"],
			defaultOn: ["files"],
			accounts: [
				{
					capability: "calendar",
					connections: [
						{ id: "conn-work", label: "Work Google", provider: "google" },
						{
							id: "conn-personal",
							label: "Personal Google",
							provider: "google",
						},
					],
				},
				{
					capability: "files",
					connections: [
						{ id: "conn-nextcloud", label: "Nextcloud", provider: "nextcloud" },
					],
				},
			],
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchActiveCapabilities();

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/active-capabilities",
		);
		expect(result).toEqual(payload);
	});

	it("throws on a failed request", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "nope" }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchActiveCapabilities()).rejects.toThrow();
	});
});

describe("startGoogleConnect", () => {
	it("posts capabilities and returns the authUrl", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ authUrl: "https://accounts.google.com/x" }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await startGoogleConnect(["calendar", "contacts"]);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/google/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ capabilities: ["calendar", "contacts"] }),
			}),
		);
		expect(result).toEqual({ authUrl: "https://accounts.google.com/x" });
	});

	it("throws with the not-configured status on a 501", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "Google OAuth is not configured" }, 501),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(startGoogleConnect(["calendar"])).rejects.toMatchObject({
			status: 501,
		});
	});
});

describe("startNextcloudConnect / pollNextcloudConnect", () => {
	it("posts the serverUrl and returns the login/poll contract", async () => {
		const payload = {
			loginUrl: "https://cloud.example.com/login/v2/flow/abc",
			pollToken: "tok-1",
			pollEndpoint: "https://cloud.example.com/login/v2/poll",
			serverUrl: "https://cloud.example.com",
		};
		const fetchMock = vi.fn(async () => jsonResponse(payload));
		vi.stubGlobal("fetch", fetchMock);

		const result = await startNextcloudConnect("https://cloud.example.com");

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/nextcloud/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ serverUrl: "https://cloud.example.com" }),
			}),
		);
		expect(result).toEqual(payload);
	});

	it("polls with serverUrl + pollToken and returns pending/connected", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ status: "pending" }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await pollNextcloudConnect({
			serverUrl: "https://cloud.example.com",
			pollToken: "tok-1",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/nextcloud/poll",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					serverUrl: "https://cloud.example.com",
					pollToken: "tok-1",
				}),
			}),
		);
		expect(result).toEqual({ status: "pending" });
	});
});

describe("startImmichConnect", () => {
	it("posts serverUrl/email/password and returns the connection", async () => {
		const connection = { id: "conn-1", provider: "immich" };
		const fetchMock = vi.fn(async () => jsonResponse({ connection }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await startImmichConnect({
			serverUrl: "https://photos.example.com",
			email: "me@example.com",
			password: "hunter2",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/immich/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					serverUrl: "https://photos.example.com",
					email: "me@example.com",
					password: "hunter2",
				}),
			}),
		);
		expect(result).toEqual({ connection });
	});
});

describe("startPlexConnect", () => {
	it("posts serverUrl/token and returns the connection", async () => {
		const connection = { id: "conn-2", provider: "plex" };
		const fetchMock = vi.fn(async () => jsonResponse({ connection }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await startPlexConnect({
			serverUrl: "https://plex.example.com",
			token: "plex-token",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/plex/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					serverUrl: "https://plex.example.com",
					token: "plex-token",
				}),
			}),
		);
		expect(result).toEqual({ connection });
	});
});

describe("startAppleConnect", () => {
	it("posts appleId/appPassword and returns the connection", async () => {
		const connection = { id: "conn-3", provider: "apple" };
		const fetchMock = vi.fn(async () => jsonResponse({ connection }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await startAppleConnect({
			appleId: "me@icloud.com",
			appPassword: "abcd-efgh-ijkl-mnop",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/apple/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					appleId: "me@icloud.com",
					appPassword: "abcd-efgh-ijkl-mnop",
				}),
			}),
		);
		expect(result).toEqual({ connection });
	});
});

describe("startEmailConnect", () => {
	it("posts the IMAP fields and returns the connection", async () => {
		const connection = { id: "conn-4", provider: "imap" };
		const fetchMock = vi.fn(async () => jsonResponse({ connection }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await startEmailConnect({
			email: "me@example.com",
			imapHost: "imap.example.com",
			imapPort: 993,
			imapSecure: true,
			password: "app-password",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/email/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					email: "me@example.com",
					imapHost: "imap.example.com",
					imapPort: 993,
					imapSecure: true,
					password: "app-password",
				}),
			}),
		);
		expect(result).toEqual({ connection });
	});
});

describe("fetchNextcloudFolders", () => {
	it("requests the connection's nextcloud-folders endpoint and returns folders", async () => {
		const folders = [
			{ path: "/Documents", name: "Documents" },
			{ path: "/Photos", name: "Photos" },
		];
		const fetchMock = vi.fn(async () => jsonResponse({ folders }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchNextcloudFolders("conn-nc");

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/conn-nc/nextcloud-folders",
		);
		expect(result).toEqual(folders);
	});

	it("appends an encoded ?path query param when given a subpath", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ folders: [] }));
		vi.stubGlobal("fetch", fetchMock);

		await fetchNextcloudFolders("conn-nc", "/Documents/Notes & Ideas");

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/conn-nc/nextcloud-folders?path=%2FDocuments%2FNotes%20%26%20Ideas",
		);
	});

	it("throws on failure so the caller can fall back to manual entry", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse(
				{ error: "Nextcloud connection needs re-authorization" },
				409,
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchNextcloudFolders("conn-nc")).rejects.toMatchObject({
			status: 409,
		});
	});
});

describe("fetchOwnTracksDevices / startOwnTracksConnect", () => {
	it("lists (otUser, otDevice) pairs", async () => {
		const devices = [{ otUser: "alice", otDevice: "phone" }];
		const fetchMock = vi.fn(async () => jsonResponse({ devices }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await fetchOwnTracksDevices();

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/owntracks/devices",
		);
		expect(result).toEqual(devices);
	});

	it("throws with a 409 status when the recorder isn't configured", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "OwnTracks is not configured" }, 409),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetchOwnTracksDevices()).rejects.toMatchObject({
			status: 409,
		});
	});

	it("posts the picked otUser/otDevice pair and returns the connection", async () => {
		const connection = { id: "conn-5", provider: "owntracks" };
		const fetchMock = vi.fn(async () => jsonResponse({ connection }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await startOwnTracksConnect({
			otUser: "alice",
			otDevice: "phone",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/owntracks/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ otUser: "alice", otDevice: "phone" }),
			}),
		);
		expect(result).toEqual({ connection });
	});
});
