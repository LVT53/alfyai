// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	enableImmichWrites,
	fetchActiveCapabilities,
	fetchHostedBoschSetup,
	fetchNextcloudFolders,
	fetchOwnTracksDevices,
	pollNextcloudConnect,
	startAppleConnect,
	startEmailConnect,
	startGitHubConnect,
	startGoogleConnect,
	startHostedBoschSetup,
	startImmichConnect,
	startNextcloudConnect,
	startOneDriveConnect,
	startOwnTracksConnect,
	startPlexLink,
	updateHostedBoschGrants,
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

	it("binds the incremental calendar edit request to its connection", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ authUrl: "https://accounts.google.com/x" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await startGoogleConnect(["calendar"], "chosen-google-account");
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/google/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capabilities: ["calendar"],
					calendarWriteConnectionId: "chosen-google-account",
				}),
			}),
		);
	});
	it("sends the Gmail management choice only to the targeted Google account", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ authUrl: "/google" }));
		vi.stubGlobal("fetch", fetchMock);
		await startGoogleConnect(["email"], undefined, undefined, {
			googleConnectionId: "account-2",
			requestGmailEditing: true,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/google/start",
			expect.objectContaining({
				body: JSON.stringify({
					capabilities: ["email"],
					googleConnectionId: "account-2",
					requestGmailEditing: true,
				}),
			}),
		);
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

describe("startOneDriveConnect", () => {
	it("posts capabilities and returns the authUrl", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				authUrl:
					"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await startOneDriveConnect(["files"]);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/onedrive/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ capabilities: ["files"] }),
			}),
		);
		expect(result).toEqual({
			authUrl:
				"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x",
		});
	});

	it("throws with the not-configured status on a 501", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "OneDrive is not configured" }, 501),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(startOneDriveConnect(["files"])).rejects.toMatchObject({
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

describe("enableImmichWrites", () => {
	it("posts the connection and the password, and returns the connection with its write key", async () => {
		const connection = {
			id: "conn-1",
			provider: "immich",
			hasWriteSecret: true,
		};
		const fetchMock = vi.fn(async () => jsonResponse({ connection }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await enableImmichWrites("conn-1", "hunter2");

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/immich/enable-writes",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ connectionId: "conn-1", password: "hunter2" }),
			}),
		);
		expect(result).toEqual(connection);
	});

	it("rejects with the server's refusal, for a password Immich turns away", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({ error: "Invalid Immich credentials" }, 401),
			),
		);

		await expect(enableImmichWrites("conn-1", "wrong")).rejects.toMatchObject({
			status: 401,
			message: "Invalid Immich credentials",
		});
	});
});

describe("startPlexLink", () => {
	it("starts Plex-hosted sign-in without requesting server credentials", async () => {
		const approval = {
			attemptId: "attempt",
			authUrl: "https://app.plex.tv/auth#?sample",
			expiresAt: 123,
		};
		const fetchMock = vi.fn(async () => jsonResponse(approval));
		vi.stubGlobal("fetch", fetchMock);
		const signal = new AbortController().signal;
		expect(await startPlexLink(null, signal)).toEqual(approval);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/plex/link/start",
			expect.objectContaining({ method: "POST", body: "{}", signal }),
		);
	});
});

describe("startGitHubConnect", () => {
	it("posts token/baseUrl and returns the connection", async () => {
		const connection = { id: "conn-3", provider: "github" };
		const fetchMock = vi.fn(async () => jsonResponse({ connection }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await startGitHubConnect({
			token: "ghp_abc123",
			baseUrl: "git.example.com/api/v1",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/github/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					token: "ghp_abc123",
					baseUrl: "git.example.com/api/v1",
				}),
			}),
		);
		expect(result).toEqual({ connection });
	});

	it("omits baseUrl when not provided", async () => {
		const connection = { id: "conn-4", provider: "github" };
		const fetchMock = vi.fn(async () => jsonResponse({ connection }));
		vi.stubGlobal("fetch", fetchMock);

		await startGitHubConnect({ token: "ghp_abc123" });

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/connections/github/start",
			expect.objectContaining({
				body: JSON.stringify({ token: "ghp_abc123" }),
			}),
		);
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

describe("hosted Bosch setup", () => {
	it("loads the callback, submits personal client details in a JSON body, and saves permissions", async () => {
		const path = "/api/connections/bosch/hosted";
		const setup = {
			mode: "none",
			grants: [],
			callbackUrl: "https://app.example/api/connections/bosch/hosted/callback",
		};
		const signedIn = { authUrl: "https://bosch.example/login" };
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(setup))
			.mockResolvedValueOnce(jsonResponse(signedIn))
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetcher);
		const controller = new AbortController();
		const start = {
			clientId: "rider",
			clientSecret: "test-secret",
			grants: ["fitness" as const],
		};
		expect(await fetchHostedBoschSetup(controller.signal)).toEqual(setup);
		expect(await startHostedBoschSetup(start, controller.signal)).toEqual(
			signedIn,
		);
		await updateHostedBoschGrants([], controller.signal);
		expect(fetcher).toHaveBeenNthCalledWith(
			1,
			path,
			expect.objectContaining({ signal: controller.signal }),
		);
		expect(fetcher).toHaveBeenNthCalledWith(
			2,
			path,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(start),
				signal: controller.signal,
			}),
		);
		expect(fetcher).toHaveBeenNthCalledWith(
			3,
			path,
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ grants: [] }),
				signal: controller.signal,
			}),
		);
	});
});
