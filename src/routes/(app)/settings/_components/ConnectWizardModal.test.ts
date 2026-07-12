import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "$lib/client/api/http";
import ConnectWizardModal from "./ConnectWizardModal.svelte";

vi.mock("$lib/client/api/connections", () => ({
	fetchOwnTracksDevices: vi.fn(),
	pollNextcloudConnect: vi.fn(),
	startAppleConnect: vi.fn(),
	startCalDavConnect: vi.fn(),
	startEmailConnect: vi.fn(),
	startGitHubConnect: vi.fn(),
	startGoogleConnect: vi.fn(),
	startImmichConnect: vi.fn(),
	startNextcloudConnect: vi.fn(),
	startOneDriveConnect: vi.fn(),
	startOwnTracksConnect: vi.fn(),
	startPlexConnect: vi.fn(),
}));

import {
	fetchOwnTracksDevices,
	pollNextcloudConnect,
	startAppleConnect,
	startCalDavConnect,
	startEmailConnect,
	startGitHubConnect,
	startGoogleConnect,
	startImmichConnect,
	startNextcloudConnect,
	startOneDriveConnect,
	startOwnTracksConnect,
	startPlexConnect,
} from "$lib/client/api/connections";

const mockFetchOwnTracksDevices = fetchOwnTracksDevices as ReturnType<
	typeof vi.fn
>;
const mockPollNextcloudConnect = pollNextcloudConnect as ReturnType<
	typeof vi.fn
>;
const mockStartAppleConnect = startAppleConnect as ReturnType<typeof vi.fn>;
const mockStartEmailConnect = startEmailConnect as ReturnType<typeof vi.fn>;
const mockStartGoogleConnect = startGoogleConnect as ReturnType<typeof vi.fn>;
const mockStartImmichConnect = startImmichConnect as ReturnType<typeof vi.fn>;
const mockStartNextcloudConnect = startNextcloudConnect as ReturnType<
	typeof vi.fn
>;
const mockStartOneDriveConnect = startOneDriveConnect as ReturnType<
	typeof vi.fn
>;
const mockStartOwnTracksConnect = startOwnTracksConnect as ReturnType<
	typeof vi.fn
>;
const mockStartPlexConnect = startPlexConnect as ReturnType<typeof vi.fn>;
const mockStartGitHubConnect = startGitHubConnect as ReturnType<typeof vi.fn>;
const mockStartCalDavConnect = startCalDavConnect as ReturnType<typeof vi.fn>;

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		provider: null,
		onClose: vi.fn(),
		onConnected: vi.fn(),
		...overrides,
	};
}

describe("ConnectWizardModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("renders nothing when provider is null", () => {
		render(ConnectWizardModal, baseProps());
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	describe("oauth (Google)", () => {
		it("starts Google connect with the checked capabilities and redirects", async () => {
			mockStartGoogleConnect.mockResolvedValue({
				authUrl: "https://accounts.google.com/o/oauth2/x",
			});
			const redirectTo = vi.fn();
			const onClose = vi.fn();
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "google", onClose, onConnected, redirectTo }),
			);

			expect(
				screen.getByRole("heading", { name: "Connect Google" }),
			).toBeInTheDocument();
			expect(screen.getByLabelText("Calendar")).toBeChecked();
			expect(screen.getByLabelText("Contacts")).toBeChecked();

			await fireEvent.click(
				screen.getByRole("button", { name: "Continue to Google" }),
			);

			await waitFor(() => {
				expect(mockStartGoogleConnect).toHaveBeenCalledWith([
					"calendar",
					"contacts",
				]);
			});
			expect(redirectTo).toHaveBeenCalledWith(
				"https://accounts.google.com/o/oauth2/x",
			);
			expect(onClose).not.toHaveBeenCalled();
			expect(onConnected).not.toHaveBeenCalled();
		});

		it("unchecking every capability disables Continue", async () => {
			render(ConnectWizardModal, baseProps({ provider: "google" }));

			await fireEvent.click(screen.getByLabelText("Calendar"));
			await fireEvent.click(screen.getByLabelText("Contacts"));

			expect(
				screen.getByRole("button", { name: "Continue to Google" }),
			).toBeDisabled();
		});

		it("shows a not-configured message on a 501 without exposing details", async () => {
			mockStartGoogleConnect.mockRejectedValue(
				new ApiError("Google OAuth is not configured", { status: 501 }),
			);
			const redirectTo = vi.fn();

			render(ConnectWizardModal, baseProps({ provider: "google", redirectTo }));
			await fireEvent.click(
				screen.getByRole("button", { name: "Continue to Google" }),
			);

			await waitFor(() => {
				expect(
					screen.getByText(
						"Google connect isn't configured on this server yet. Ask your administrator to set it up.",
					),
				).toBeInTheDocument();
			});
			expect(redirectTo).not.toHaveBeenCalled();
		});

		it("shows a Reconnect title when reconnecting", () => {
			render(
				ConnectWizardModal,
				baseProps({ provider: "google", reconnectConnectionId: "conn-1" }),
			);
			expect(
				screen.getByRole("heading", { name: "Reconnect Google" }),
			).toBeInTheDocument();
		});
	});

	// Task 8 — OneDrive is a second oauth-connectMethod provider; the branch
	// under test (kind === 'oauth') is shared with Google, so this mirrors
	// the Google describe block above but asserts the OneDrive-specific
	// wiring: startOneDriveConnect is called (not startGoogleConnect), and
	// every provider-interpolated string says "OneDrive".
	describe("oauth (OneDrive)", () => {
		it("starts OneDrive connect with the checked capabilities and redirects", async () => {
			mockStartOneDriveConnect.mockResolvedValue({
				authUrl:
					"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x",
			});
			const redirectTo = vi.fn();
			const onClose = vi.fn();
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "onedrive", onClose, onConnected, redirectTo }),
			);

			expect(
				screen.getByRole("heading", { name: "Connect OneDrive" }),
			).toBeInTheDocument();
			expect(screen.getByLabelText("Files")).toBeChecked();

			await fireEvent.click(
				screen.getByRole("button", { name: "Continue to OneDrive" }),
			);

			await waitFor(() => {
				expect(mockStartOneDriveConnect).toHaveBeenCalledWith(["files"]);
			});
			expect(mockStartGoogleConnect).not.toHaveBeenCalled();
			expect(redirectTo).toHaveBeenCalledWith(
				"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x",
			);
			expect(onClose).not.toHaveBeenCalled();
			expect(onConnected).not.toHaveBeenCalled();
		});

		it("unchecking the only capability disables Continue", async () => {
			render(ConnectWizardModal, baseProps({ provider: "onedrive" }));

			await fireEvent.click(screen.getByLabelText("Files"));

			expect(
				screen.getByRole("button", { name: "Continue to OneDrive" }),
			).toBeDisabled();
		});

		it("shows a not-configured message on a 501 without exposing details", async () => {
			mockStartOneDriveConnect.mockRejectedValue(
				new ApiError("OneDrive is not configured", { status: 501 }),
			);
			const redirectTo = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "onedrive", redirectTo }),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Continue to OneDrive" }),
			);

			await waitFor(() => {
				expect(
					screen.getByText(
						"OneDrive connect isn't configured on this server yet. Ask your administrator to set it up.",
					),
				).toBeInTheDocument();
			});
			expect(redirectTo).not.toHaveBeenCalled();
		});

		it("shows a Reconnect title when reconnecting", () => {
			render(
				ConnectWizardModal,
				baseProps({ provider: "onedrive", reconnectConnectionId: "conn-1" }),
			);
			expect(
				screen.getByRole("heading", { name: "Reconnect OneDrive" }),
			).toBeInTheDocument();
		});
	});

	describe("login-flow-v2 (Nextcloud)", () => {
		it("starts the login flow, opens the login tab, and waits for approval via manual re-poll", async () => {
			mockStartNextcloudConnect.mockResolvedValue({
				loginUrl: "https://cloud.example.com/login/v2/flow/abc",
				pollToken: "tok-1",
				pollEndpoint: "https://cloud.example.com/login/v2/poll",
				serverUrl: "https://cloud.example.com",
			});
			mockPollNextcloudConnect
				.mockResolvedValueOnce({ status: "pending" })
				.mockResolvedValueOnce({
					status: "connected",
					connection: { id: "conn-nc", provider: "nextcloud" },
				});
			const openWindow = vi.fn();
			const onClose = vi.fn();
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({
					provider: "nextcloud",
					onClose,
					onConnected,
					openWindow,
					// A real background setTimeout is still scheduled after each poll
					// (see scheduleNextPoll) — pollIntervalMs just needs to comfortably
					// outlast the test, and pollTimeoutMs needs enough headroom above it
					// that the manual re-polls below don't trip the timeout themselves
					// (each pollOnce() bumps elapsed by pollIntervalMs regardless of
					// real time elapsed).
					pollIntervalMs: 60_000,
					pollTimeoutMs: 600_000,
				}),
			);

			await fireEvent.input(screen.getByLabelText("Server URL"), {
				target: { value: "https://cloud.example.com" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartNextcloudConnect).toHaveBeenCalledWith(
					"https://cloud.example.com",
				);
			});
			expect(openWindow).toHaveBeenCalledWith(
				"https://cloud.example.com/login/v2/flow/abc",
			);
			expect(
				screen.getByText("Waiting for you to approve in Nextcloud…"),
			).toBeInTheDocument();

			// First manual re-poll: still pending.
			await fireEvent.click(
				screen.getByRole("button", { name: "I've approved" }),
			);
			await waitFor(() =>
				expect(mockPollNextcloudConnect).toHaveBeenCalledTimes(1),
			);
			expect(onConnected).not.toHaveBeenCalled();

			// Second manual re-poll: connected.
			await fireEvent.click(
				screen.getByRole("button", { name: "I've approved" }),
			);
			await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
			expect(onClose).toHaveBeenCalledOnce();
			expect(mockPollNextcloudConnect).toHaveBeenCalledWith({
				serverUrl: "https://cloud.example.com",
				pollToken: "tok-1",
			});
		});

		it("stops polling and shows a timeout message once pollTimeoutMs elapses (fake timers)", async () => {
			vi.useFakeTimers();
			try {
				mockStartNextcloudConnect.mockResolvedValue({
					loginUrl: "https://cloud.example.com/login/v2/flow/abc",
					pollToken: "tok-1",
					pollEndpoint: "https://cloud.example.com/login/v2/poll",
					serverUrl: "https://cloud.example.com",
				});
				// Every automatic poll reports "pending" — the wizard should give up
				// on its own once pollTimeoutMs of elapsed poll intervals is reached,
				// without the user ever clicking "I've approved".
				mockPollNextcloudConnect.mockResolvedValue({ status: "pending" });
				const onConnected = vi.fn();
				const onClose = vi.fn();

				render(
					ConnectWizardModal,
					baseProps({
						provider: "nextcloud",
						onClose,
						onConnected,
						openWindow: vi.fn(),
						pollIntervalMs: 1000,
						pollTimeoutMs: 3000,
					}),
				);

				await fireEvent.input(screen.getByLabelText("Server URL"), {
					target: { value: "https://cloud.example.com" },
				});
				await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
				// Flush the startNextcloudConnect() resolution so ncPhase flips to
				// "waiting" and the first poll gets scheduled.
				await vi.advanceTimersByTimeAsync(0);

				expect(
					screen.getByText("Waiting for you to approve in Nextcloud…"),
				).toBeInTheDocument();

				// 3 poll intervals (3000ms / 1000ms) of "pending" responses exhaust
				// pollTimeoutMs and the wizard should flip to the timeout state on
				// its own.
				await vi.advanceTimersByTimeAsync(3000);

				expect(
					screen.getByText(
						"This took too long — the login link may have expired. Please try again.",
					),
				).toBeInTheDocument();
				expect(onConnected).not.toHaveBeenCalled();
				expect(onClose).not.toHaveBeenCalled();

				const callsAtTimeout = mockPollNextcloudConnect.mock.calls.length;
				expect(callsAtTimeout).toBeGreaterThan(0);

				// Advancing well past another poll interval must not schedule any
				// further polls — pollOnce() bails out once ncPhase is no longer
				// "waiting" (see the early-return guard in the component).
				await vi.advanceTimersByTimeAsync(10_000);
				expect(mockPollNextcloudConnect.mock.calls.length).toBe(callsAtTimeout);

				// Retry takes the user back to the form instead of leaving them
				// stuck on the timeout screen.
				await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
				expect(screen.getByLabelText("Server URL")).toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it("Cancel during the waiting phase closes the modal", async () => {
			mockStartNextcloudConnect.mockResolvedValue({
				loginUrl: "https://cloud.example.com/login/v2/flow/abc",
				pollToken: "tok-1",
				pollEndpoint: "https://cloud.example.com/login/v2/poll",
				serverUrl: "https://cloud.example.com",
			});
			const onClose = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({
					provider: "nextcloud",
					onClose,
					openWindow: vi.fn(),
					pollIntervalMs: 60_000,
					pollTimeoutMs: 600_000,
				}),
			);
			await fireEvent.input(screen.getByLabelText("Server URL"), {
				target: { value: "https://cloud.example.com" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
			await waitFor(() =>
				expect(
					screen.getByText("Waiting for you to approve in Nextcloud…"),
				).toBeInTheDocument(),
			);

			await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
			expect(onClose).toHaveBeenCalledOnce();
		});
	});

	describe("password-key (Immich)", () => {
		it("submits serverUrl/email/password and calls onConnected on success", async () => {
			mockStartImmichConnect.mockResolvedValue({
				connection: { id: "conn-immich", provider: "immich" },
			});
			const onClose = vi.fn();
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "immich", onClose, onConnected }),
			);

			await fireEvent.input(screen.getByLabelText("Server URL"), {
				target: { value: "https://photos.example.com" },
			});
			await fireEvent.input(screen.getByLabelText("Email"), {
				target: { value: "me@example.com" },
			});
			await fireEvent.input(screen.getByLabelText("Password"), {
				target: { value: "hunter2" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartImmichConnect).toHaveBeenCalledWith({
					serverUrl: "https://photos.example.com",
					email: "me@example.com",
					password: "hunter2",
				});
			});
			expect(onConnected).toHaveBeenCalledOnce();
			expect(onClose).toHaveBeenCalledOnce();
		});

		it("shows the server's error inline and never renders the password", async () => {
			mockStartImmichConnect.mockRejectedValue(
				new ApiError("Invalid email or password", { status: 401 }),
			);

			render(ConnectWizardModal, baseProps({ provider: "immich" }));

			await fireEvent.input(screen.getByLabelText("Server URL"), {
				target: { value: "https://photos.example.com" },
			});
			await fireEvent.input(screen.getByLabelText("Email"), {
				target: { value: "me@example.com" },
			});
			await fireEvent.input(screen.getByLabelText("Password"), {
				target: { value: "hunter2" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(
					screen.getByText("Invalid email or password"),
				).toBeInTheDocument();
			});
			expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
		});
	});

	describe("password-key (Plex)", () => {
		it("submits serverUrl/token and calls onConnected on success", async () => {
			mockStartPlexConnect.mockResolvedValue({
				connection: { id: "conn-plex", provider: "plex" },
			});
			const onConnected = vi.fn();

			render(ConnectWizardModal, baseProps({ provider: "plex", onConnected }));

			await fireEvent.input(screen.getByLabelText("Server URL"), {
				target: { value: "https://plex.example.com" },
			});
			await fireEvent.input(screen.getByLabelText("Plex token"), {
				target: { value: "plex-token" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartPlexConnect).toHaveBeenCalledWith({
					serverUrl: "https://plex.example.com",
					token: "plex-token",
				});
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});
	});

	describe("app-password (GitHub)", () => {
		it("submits the token (no base URL) and calls onConnected on success", async () => {
			mockStartGitHubConnect.mockResolvedValue({
				connection: { id: "conn-github", provider: "github" },
			});
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "github", onConnected }),
			);

			await fireEvent.input(screen.getByLabelText("Personal access token"), {
				target: { value: "ghp_abc123" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartGitHubConnect).toHaveBeenCalledWith({
					token: "ghp_abc123",
				});
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});

		it("the advanced base URL field starts collapsed and includes baseUrl when expanded and filled", async () => {
			mockStartGitHubConnect.mockResolvedValue({
				connection: { id: "conn-github", provider: "github" },
			});

			render(ConnectWizardModal, baseProps({ provider: "github" }));

			expect(
				screen.queryByLabelText("API base URL (optional)"),
			).not.toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", {
					name: "Advanced: custom server (Gitea/GHE)",
				}),
			);

			await fireEvent.input(screen.getByLabelText("Personal access token"), {
				target: { value: "ghp_abc123" },
			});
			await fireEvent.input(screen.getByLabelText("API base URL (optional)"), {
				target: { value: "git.example.com/api/v1" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartGitHubConnect).toHaveBeenCalledWith({
					token: "ghp_abc123",
					baseUrl: "git.example.com/api/v1",
				});
			});
		});

		it("disables Connect until a token is entered", async () => {
			render(ConnectWizardModal, baseProps({ provider: "github" }));

			expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

			await fireEvent.input(screen.getByLabelText("Personal access token"), {
				target: { value: "ghp_abc123" },
			});

			expect(
				screen.getByRole("button", { name: "Connect" }),
			).not.toBeDisabled();
		});
	});

	describe("app-password (Apple)", () => {
		it("submits appleId/appPassword and calls onConnected on success", async () => {
			mockStartAppleConnect.mockResolvedValue({
				connection: { id: "conn-apple", provider: "apple" },
			});
			const onConnected = vi.fn();

			render(ConnectWizardModal, baseProps({ provider: "apple", onConnected }));

			await fireEvent.input(screen.getByLabelText("Apple ID"), {
				target: { value: "me@icloud.com" },
			});
			await fireEvent.input(screen.getByLabelText("App-specific password"), {
				target: { value: "abcd-efgh-ijkl-mnop" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartAppleConnect).toHaveBeenCalledWith({
					appleId: "me@icloud.com",
					appPassword: "abcd-efgh-ijkl-mnop",
				});
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});
	});

	describe("app-password (CalDAV)", () => {
		it("submits serverUrl/username/appPassword and calls onConnected on success", async () => {
			mockStartCalDavConnect.mockResolvedValue({
				connection: { id: "conn-caldav", provider: "caldav" },
			});
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "caldav", onConnected }),
			);

			await fireEvent.input(
				screen.getByLabelText("CalDAV/CardDAV server URL"),
				{
					target: { value: "cloud.example.com/remote.php/dav" },
				},
			);
			await fireEvent.input(screen.getByLabelText("Username"), {
				target: { value: "alice" },
			});
			await fireEvent.input(screen.getByLabelText("App password"), {
				target: { value: "app-pw-123" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartCalDavConnect).toHaveBeenCalledWith({
					serverUrl: "cloud.example.com/remote.php/dav",
					username: "alice",
					appPassword: "app-pw-123",
				});
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});

		it("disables Connect until server URL, username, and app password are all filled", async () => {
			render(ConnectWizardModal, baseProps({ provider: "caldav" }));

			expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

			await fireEvent.input(
				screen.getByLabelText("CalDAV/CardDAV server URL"),
				{
					target: { value: "cloud.example.com/remote.php/dav" },
				},
			);
			await fireEvent.input(screen.getByLabelText("Username"), {
				target: { value: "alice" },
			});
			expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

			await fireEvent.input(screen.getByLabelText("App password"), {
				target: { value: "app-pw-123" },
			});
			expect(
				screen.getByRole("button", { name: "Connect" }),
			).not.toBeDisabled();
		});
	});

	describe("email (multi-step wizard: Alfy Email / Gmail / Other IMAP — ADR 0044 Decision 4)", () => {
		it("step 1 shows the three paths; picking one advances, and back returns to step 1", async () => {
			render(ConnectWizardModal, baseProps({ provider: "imap" }));

			expect(screen.getByText("Alfy Email")).toBeInTheDocument();
			expect(screen.getByText("Gmail")).toBeInTheDocument();
			expect(screen.getByText("Other (IMAP)")).toBeInTheDocument();

			await fireEvent.click(screen.getByText("Alfy Email"));
			expect(screen.getByLabelText("Email address")).toBeInTheDocument();
			expect(screen.getByLabelText("Password")).toBeInTheDocument();

			await fireEvent.click(screen.getByRole("button", { name: "Back" }));
			expect(screen.getByText("Alfy Email")).toBeInTheDocument();
			expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
		});

		describe("Alfy Email path", () => {
			it("derives mail.<domain> IMAP/SMTP config from the email and submits it", async () => {
				mockStartEmailConnect.mockResolvedValue({
					connection: { id: "conn-alfy", provider: "imap" },
				});
				const onConnected = vi.fn();
				const onClose = vi.fn();

				render(
					ConnectWizardModal,
					baseProps({ provider: "imap", onConnected, onClose }),
				);

				await fireEvent.click(screen.getByText("Alfy Email"));
				await fireEvent.input(screen.getByLabelText("Email address"), {
					target: { value: "levente@alfydesign.com" },
				});
				await fireEvent.input(screen.getByLabelText("Password"), {
					target: { value: "hunter2" },
				});
				await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

				await waitFor(() => {
					expect(mockStartEmailConnect).toHaveBeenCalledWith({
						email: "levente@alfydesign.com",
						imapHost: "mail.alfydesign.com",
						imapPort: 993,
						imapSecure: true,
						password: "hunter2",
						smtpHost: "mail.alfydesign.com",
						smtpPort: 587,
					});
				});
				expect(onConnected).toHaveBeenCalledOnce();
				expect(onClose).toHaveBeenCalledOnce();
			});

			it("shows the server's error inline with an Other-IMAP hint, and never renders the password", async () => {
				mockStartEmailConnect.mockRejectedValue(
					new ApiError("Could not reach mail.alfydesign.com", {
						status: 502,
					}),
				);

				render(ConnectWizardModal, baseProps({ provider: "imap" }));

				await fireEvent.click(screen.getByText("Alfy Email"));
				await fireEvent.input(screen.getByLabelText("Email address"), {
					target: { value: "levente@alfydesign.com" },
				});
				await fireEvent.input(screen.getByLabelText("Password"), {
					target: { value: "hunter2" },
				});
				await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

				await waitFor(() => {
					expect(
						screen.getByText("Could not reach mail.alfydesign.com"),
					).toBeInTheDocument();
				});
				expect(screen.getByText(/Other \(IMAP\)/)).toBeInTheDocument();
				expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
			});
		});

		describe("Gmail path", () => {
			it("shows the app-password help and derives imap.gmail.com/smtp.gmail.com", async () => {
				mockStartEmailConnect.mockResolvedValue({
					connection: { id: "conn-gmail", provider: "imap" },
				});
				const onConnected = vi.fn();

				render(
					ConnectWizardModal,
					baseProps({ provider: "imap", onConnected }),
				);

				await fireEvent.click(screen.getByText("Gmail"));
				expect(
					screen.getByText(/Settings → Forwarding and POP\/IMAP/),
				).toBeInTheDocument();
				expect(screen.getByText(/myaccount\.google\.com/)).toBeInTheDocument();

				await fireEvent.input(screen.getByLabelText("Gmail address"), {
					target: { value: "me@gmail.com" },
				});
				await fireEvent.input(screen.getByLabelText("App password"), {
					target: { value: "abcd efgh ijkl mnop" },
				});
				await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

				await waitFor(() => {
					expect(mockStartEmailConnect).toHaveBeenCalledWith({
						email: "me@gmail.com",
						imapHost: "imap.gmail.com",
						imapPort: 993,
						imapSecure: true,
						password: "abcd efgh ijkl mnop",
						smtpHost: "smtp.gmail.com",
						smtpPort: 587,
					});
				});
				expect(onConnected).toHaveBeenCalledOnce();
			});
		});

		describe("Other (IMAP) path", () => {
			it("submits the manually-entered IMAP fields (with sane defaults) and calls onConnected on success", async () => {
				mockStartEmailConnect.mockResolvedValue({
					connection: { id: "conn-imap", provider: "imap" },
				});
				const onConnected = vi.fn();

				render(
					ConnectWizardModal,
					baseProps({ provider: "imap", onConnected }),
				);

				await fireEvent.click(screen.getByText("Other (IMAP)"));

				expect(screen.getByLabelText("Port")).toHaveValue(993);
				expect(screen.getByLabelText("Use SSL/TLS")).toBeChecked();

				await fireEvent.input(screen.getByLabelText("Email address"), {
					target: { value: "me@example.com" },
				});
				await fireEvent.input(screen.getByLabelText("IMAP server"), {
					target: { value: "imap.example.com" },
				});
				await fireEvent.input(screen.getByLabelText("App password"), {
					target: { value: "app-pw" },
				});
				await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

				await waitFor(() => {
					expect(mockStartEmailConnect).toHaveBeenCalledWith({
						email: "me@example.com",
						imapHost: "imap.example.com",
						imapPort: 993,
						imapSecure: true,
						password: "app-pw",
					});
				});
				expect(onConnected).toHaveBeenCalledOnce();
			});
		});

		describe("reconnect", () => {
			it("skips step 1 and goes straight to the Other-IMAP form with saved config prefilled", () => {
				render(
					ConnectWizardModal,
					baseProps({
						provider: "imap",
						reconnectConnectionId: "conn-1",
						reconnectConnection: {
							id: "conn-1",
							provider: "imap",
							label: "Email",
							accountIdentifier: "me@example.com",
							status: "connected",
							statusDetail: null,
							defaultOn: true,
							allowWrites: false,
							writeAllowlist: [],
							capabilities: ["email"],
							config: {
								imapHost: "mail.example.com",
								imapPort: 993,
								imapSecure: true,
							},
							oauthScopes: [],
							tokenExpiresAt: null,
							hasSecret: true,
							hasWriteSecret: false,
							createdAt: 0,
							updatedAt: 0,
						},
					}),
				);

				expect(screen.queryByText("Alfy Email")).not.toBeInTheDocument();
				expect(screen.getByLabelText("Email address")).toHaveValue(
					"me@example.com",
				);
				expect(screen.getByLabelText("IMAP server")).toHaveValue(
					"mail.example.com",
				);
			});
		});
	});

	describe("OwnTracks device picker", () => {
		it("lists devices then starts with the picked pair", async () => {
			mockFetchOwnTracksDevices.mockResolvedValue([
				{ otUser: "alice", otDevice: "phone" },
				{ otUser: "alice", otDevice: "tablet" },
			]);
			mockStartOwnTracksConnect.mockResolvedValue({
				connection: { id: "conn-ot", provider: "owntracks" },
			});
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "owntracks", onConnected }),
			);

			await waitFor(() => {
				expect(screen.getByLabelText("alice / phone")).toBeInTheDocument();
			});
			await fireEvent.click(screen.getByLabelText("alice / tablet"));
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartOwnTracksConnect).toHaveBeenCalledWith({
					otUser: "alice",
					otDevice: "tablet",
				});
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});

		it("shows a not-configured message when the recorder isn't set up", async () => {
			mockFetchOwnTracksDevices.mockRejectedValue(
				new ApiError("OwnTracks is not configured", { status: 409 }),
			);

			render(ConnectWizardModal, baseProps({ provider: "owntracks" }));

			await waitFor(() => {
				expect(
					screen.getByText(
						"OwnTracks isn't configured on this server. Ask your administrator to set the OwnTracks Recorder URL.",
					),
				).toBeInTheDocument();
			});
		});

		// E1 — the recorder can become unconfigured between listing devices and
		// binding one (or the start route's config gate can 409 independently);
		// the start submission must surface the same clear admin message, not a
		// generic failure.
		it("shows the not-configured message when start returns 409, not a generic error", async () => {
			mockFetchOwnTracksDevices.mockResolvedValue([
				{ otUser: "alice", otDevice: "phone" },
			]);
			mockStartOwnTracksConnect.mockRejectedValue(
				new ApiError("OwnTracks is not configured", { status: 409 }),
			);
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "owntracks", onConnected }),
			);

			await waitFor(() => {
				expect(screen.getByLabelText("alice / phone")).toBeInTheDocument();
			});
			await fireEvent.click(screen.getByLabelText("alice / phone"));
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(
					screen.getByText(
						"OwnTracks isn't configured on this server. Ask your administrator to set the OwnTracks Recorder URL.",
					),
				).toBeInTheDocument();
			});
			expect(onConnected).not.toHaveBeenCalled();
		});
	});

	describe("contacts (no backend route yet)", () => {
		it("shows a not-available notice instead of a form", () => {
			const onClose = vi.fn();
			render(ConnectWizardModal, baseProps({ provider: "contacts", onClose }));

			expect(
				screen.getByText(
					"Connecting Contacts directly isn't available yet — connect Google, Apple, or Nextcloud instead to bring in contacts.",
				),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Connect" }),
			).not.toBeInTheDocument();
		});
	});
});
