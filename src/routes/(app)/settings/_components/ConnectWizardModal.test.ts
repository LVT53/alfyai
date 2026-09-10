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
		sessionStorage.clear();
		// See SettingsConnectionsTab.test.ts — jsdom has no Web Animations API,
		// so reporting reduced motion is what lets a disclosure's outro finish.
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: true,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
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

		// Each capability says what it lets Alfy do, so the consent decision is
		// made here rather than on a page that only lists scope names.
		it("says what each capability is for", () => {
			render(ConnectWizardModal, baseProps({ provider: "google" }));
			expect(
				screen.getByText(
					"Read your events so Alfy can answer questions about your week.",
				),
			).toBeInTheDocument();
		});

		// Nothing else in the system knows what was ASKED for once the browser
		// leaves for the consent screen.
		it("writes down what it asked for before redirecting", async () => {
			mockStartGoogleConnect.mockResolvedValue({ authUrl: "https://x" });
			render(
				ConnectWizardModal,
				baseProps({ provider: "google", redirectTo: vi.fn() }),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Continue to Google" }),
			);
			await waitFor(() => {
				expect(
					sessionStorage.getItem("alfyai:connections:requested:google"),
				).toBe(JSON.stringify(["calendar", "contacts"]));
			});
		});

		// "Ask again" on a denied capability re-opens this screen asking for the
		// union of what already works and what was refused.
		it("pre-ticks exactly the capabilities it was asked to request", () => {
			render(
				ConnectWizardModal,
				baseProps({
					provider: "google",
					reconnectConnectionId: "conn-1",
					requestedCapabilities: ["contacts"],
				}),
			);
			expect(screen.getByLabelText("Contacts")).toBeChecked();
			expect(screen.getByLabelText("Calendar")).not.toBeChecked();
		});

		it("unchecking every capability disables Continue", async () => {
			render(ConnectWizardModal, baseProps({ provider: "google" }));

			await fireEvent.click(screen.getByLabelText("Calendar"));
			await fireEvent.click(screen.getByLabelText("Contacts"));

			expect(
				screen.getByRole("button", { name: "Continue to Google" }),
			).toBeDisabled();
		});

		// The old dead end: "ask your administrator to set it up" — on a
		// one-person server, that is the same person, and it never said where.
		it("names the exact Administration page when the app isn't set up, and offers to open it", async () => {
			mockStartGoogleConnect.mockRejectedValue(
				new ApiError("Google OAuth is not configured", { status: 501 }),
			);
			const redirectTo = vi.fn();
			const onOpenAdminIntegrations = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({
					provider: "google",
					redirectTo,
					isAdmin: true,
					onOpenAdminIntegrations,
				}),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Continue to Google" }),
			);

			const notice = await screen.findByTestId("wizard-not-set-up");
			expect(notice).toHaveTextContent(/needs an app id and secret/);
			expect(notice).toHaveTextContent(/You are the administrator/);
			expect(
				screen.getByText("Administration → System → Advanced → Integrations"),
			).toBeInTheDocument();

			await fireEvent.click(screen.getByRole("link", { name: "Open" }));
			expect(onOpenAdminIntegrations).toHaveBeenCalled();
			expect(redirectTo).not.toHaveBeenCalled();
		});

		// A member can't fix it, so they get the honest sentence and no button
		// that would 403.
		it("tells a non-admin who to ask, and offers no shortcut", async () => {
			mockStartGoogleConnect.mockRejectedValue(
				new ApiError("Google OAuth is not configured", { status: 501 }),
			);
			render(
				ConnectWizardModal,
				baseProps({ provider: "google", isAdmin: false, redirectTo: vi.fn() }),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Continue to Google" }),
			);
			const notice = await screen.findByTestId("wizard-not-set-up");
			expect(notice).toHaveTextContent(/Ask whoever runs this server/);
			expect(
				screen.queryByTestId("wizard-not-set-up-trail"),
			).not.toBeInTheDocument();
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

	describe("oauth (OneDrive)", () => {
		it("starts OneDrive connect with the checked capabilities and redirects", async () => {
			mockStartOneDriveConnect.mockResolvedValue({
				authUrl:
					"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x",
			});
			const redirectTo = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "onedrive", redirectTo }),
			);

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
		});

		it("unchecking the only capability disables Continue", async () => {
			render(ConnectWizardModal, baseProps({ provider: "onedrive" }));
			await fireEvent.click(screen.getByLabelText("Files"));
			expect(
				screen.getByRole("button", { name: "Continue to OneDrive" }),
			).toBeDisabled();
		});

		it("names OneDrive in the not-set-up state", async () => {
			mockStartOneDriveConnect.mockRejectedValue(
				new ApiError("OneDrive is not configured", { status: 501 }),
			);
			render(
				ConnectWizardModal,
				baseProps({ provider: "onedrive", isAdmin: true, redirectTo: vi.fn() }),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Continue to OneDrive" }),
			);
			const notice = await screen.findByTestId("wizard-not-set-up");
			expect(notice).toHaveTextContent(/OneDrive needs an app id and secret/);
		});
	});

	describe("login-flow-v2 (Nextcloud)", () => {
		const startResponse = {
			loginUrl: "https://cloud.example.com/login/v2/flow/abc",
			pollToken: "tok-1",
			pollEndpoint: "https://cloud.example.com/login/v2/poll",
			serverUrl: "https://cloud.example.com",
		};

		it("starts the login flow, opens the login tab, and waits for approval via manual re-poll", async () => {
			mockStartNextcloudConnect.mockResolvedValue(startResponse);
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
			const waiting = screen.getByTestId("wizard-nextcloud-waiting");
			expect(waiting).toHaveTextContent("Waiting for you to approve");
			expect(waiting).toHaveTextContent(/Approve there, then come back/);
			// The link's lifetime is visible, so waiting doesn't feel open-ended.
			expect(waiting).toHaveTextContent(/The link expires in/);

			await fireEvent.click(
				screen.getByRole("button", { name: "I've approved it" }),
			);
			await waitFor(() =>
				expect(mockPollNextcloudConnect).toHaveBeenCalledTimes(1),
			);
			expect(onConnected).not.toHaveBeenCalled();

			await fireEvent.click(
				screen.getByRole("button", { name: "I've approved it" }),
			);
			await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
			expect(onClose).toHaveBeenCalledOnce();
			expect(mockPollNextcloudConnect).toHaveBeenCalledWith({
				serverUrl: "https://cloud.example.com",
				pollToken: "tok-1",
			});
		});

		// A blocked pop-up used to leave the flow silently stuck waiting for an
		// approval in a tab that never opened.
		it("says the tab was blocked and offers the link, instead of waiting forever", async () => {
			mockStartNextcloudConnect.mockResolvedValue(startResponse);
			// null is the browser refusing; undefined means "caller doesn't say".
			const openWindow = vi.fn().mockReturnValue(null);

			render(
				ConnectWizardModal,
				baseProps({ provider: "nextcloud", openWindow }),
			);
			await fireEvent.input(screen.getByLabelText("Server URL"), {
				target: { value: "https://cloud.example.com" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			const blocked = await screen.findByTestId("wizard-popup-blocked");
			expect(blocked).toHaveTextContent(/Allow pop-ups for this site/);
			expect(
				screen.queryByTestId("wizard-nextcloud-waiting"),
			).not.toBeInTheDocument();

			const open = screen.getByTestId("wizard-popup-blocked-open");
			expect(open).toHaveAttribute(
				"href",
				"https://cloud.example.com/login/v2/flow/abc",
			);
			// Retrying from here resumes the wait rather than restarting the flow:
			// the login link is already minted and still valid.
			openWindow.mockReturnValue({} as Window);
			const opensBeforeRetry = openWindow.mock.calls.length;
			await fireEvent.click(open);
			expect(
				await screen.findByTestId("wizard-nextcloud-waiting"),
			).toBeInTheDocument();
			expect(mockStartNextcloudConnect).toHaveBeenCalledTimes(1);
			// And it opens the tab ONCE — via the anchor's own navigation, which
			// is the user gesture the browser allows. Calling openWindow here as
			// well gave the user two Nextcloud tabs, and they could easily sign
			// in on the one nobody was polling for.
			expect(openWindow.mock.calls.length).toBe(opensBeforeRetry);
		});

		// A three-minute wait used to be undone by a single dropped poll: the
		// catch threw the user back to the form and lost the login link they
		// were in the middle of approving in the other tab.
		it("rides out a transient poll failure instead of losing the pending login", async () => {
			vi.useFakeTimers();
			try {
				mockStartNextcloudConnect.mockResolvedValue(startResponse);
				mockPollNextcloudConnect
					.mockRejectedValueOnce(new Error("network hiccup"))
					.mockResolvedValue({ status: "pending" });

				render(
					ConnectWizardModal,
					baseProps({
						provider: "nextcloud",
						openWindow: vi.fn(),
						pollIntervalMs: 1000,
						pollTimeoutMs: 600_000,
					}),
				);
				await fireEvent.input(screen.getByLabelText("Server URL"), {
					target: { value: "https://cloud.example.com" },
				});
				await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
				await vi.advanceTimersByTimeAsync(0);

				await vi.advanceTimersByTimeAsync(3000);

				// Still waiting, and still polling — not thrown back to the form.
				expect(
					screen.getByTestId("wizard-nextcloud-waiting"),
				).toBeInTheDocument();
				expect(mockPollNextcloudConnect.mock.calls.length).toBeGreaterThan(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("gives up and says so once the failures stop looking transient", async () => {
			vi.useFakeTimers();
			try {
				mockStartNextcloudConnect.mockResolvedValue(startResponse);
				mockPollNextcloudConnect.mockRejectedValue(new Error("server is down"));

				render(
					ConnectWizardModal,
					baseProps({
						provider: "nextcloud",
						openWindow: vi.fn(),
						pollIntervalMs: 1000,
						pollTimeoutMs: 600_000,
					}),
				);
				await fireEvent.input(screen.getByLabelText("Server URL"), {
					target: { value: "https://cloud.example.com" },
				});
				await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
				await vi.advanceTimersByTimeAsync(0);

				await vi.advanceTimersByTimeAsync(5000);

				// Back on the form, with the error shown, rather than waiting on a
				// server that is not answering.
				expect(screen.getByLabelText("Server URL")).toBeInTheDocument();
				expect(
					screen.queryByTestId("wizard-nextcloud-waiting"),
				).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it("treats a caller that reports nothing as 'opened', not blocked", async () => {
			mockStartNextcloudConnect.mockResolvedValue(startResponse);
			mockPollNextcloudConnect.mockResolvedValue({ status: "pending" });
			render(
				ConnectWizardModal,
				baseProps({
					provider: "nextcloud",
					openWindow: vi.fn(),
					pollIntervalMs: 60_000,
					pollTimeoutMs: 600_000,
				}),
			);
			await fireEvent.input(screen.getByLabelText("Server URL"), {
				target: { value: "https://cloud.example.com" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));
			expect(
				await screen.findByTestId("wizard-nextcloud-waiting"),
			).toBeInTheDocument();
		});

		it("stops polling and shows a timeout message once pollTimeoutMs elapses (fake timers)", async () => {
			vi.useFakeTimers();
			try {
				mockStartNextcloudConnect.mockResolvedValue(startResponse);
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
				await vi.advanceTimersByTimeAsync(0);

				expect(
					screen.getByTestId("wizard-nextcloud-waiting"),
				).toBeInTheDocument();

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
				await vi.advanceTimersByTimeAsync(10_000);
				expect(mockPollNextcloudConnect.mock.calls.length).toBe(callsAtTimeout);

				await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
				expect(screen.getByLabelText("Server URL")).toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it("Cancel during the waiting phase closes the modal", async () => {
			mockStartNextcloudConnect.mockResolvedValue(startResponse);
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
					screen.getByTestId("wizard-nextcloud-waiting"),
				).toBeInTheDocument(),
			);

			await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
			expect(onClose).toHaveBeenCalledOnce();
		});
	});

	describe("password-key (Immich)", () => {
		async function fillImmich() {
			await fireEvent.input(screen.getByLabelText("Server URL"), {
				target: { value: "https://photos.example.com" },
			});
			await fireEvent.input(screen.getByLabelText("Email"), {
				target: { value: "me@example.com" },
			});
			await fireEvent.input(screen.getByLabelText("Password"), {
				target: { value: "hunter2" },
			});
		}

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
			await fillImmich();
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartImmichConnect).toHaveBeenCalledWith(
					{
						serverUrl: "https://photos.example.com",
						email: "me@example.com",
						password: "hunter2",
					},
					expect.any(AbortSignal),
				);
			});
			expect(onConnected).toHaveBeenCalledOnce();
			expect(onClose).toHaveBeenCalledOnce();
		});

		// A submit in flight was a greyed button; now it says what is happening
		// and Cancel actually aborts rather than hiding a live request.
		it("shows a connecting panel while submitting, and Cancel aborts it", async () => {
			let abortedSignal: AbortSignal | undefined;
			mockStartImmichConnect.mockImplementation(
				(_params: unknown, signal: AbortSignal) => {
					abortedSignal = signal;
					return new Promise(() => {});
				},
			);
			const onClose = vi.fn();
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "immich", onClose, onConnected }),
			);
			await fillImmich();
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			const panel = await screen.findByTestId("wizard-connecting");
			expect(panel).toHaveTextContent("Connecting Immich");

			await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
			expect(abortedSignal?.aborted).toBe(true);
			expect(onClose).toHaveBeenCalledOnce();
			expect(onConnected).not.toHaveBeenCalled();
		});

		// The provider's own phrasing is kept, but it is no longer the whole
		// message: the sentence comes first.
		it("leads with a sentence and keeps the server's words one click away", async () => {
			mockStartImmichConnect.mockRejectedValue(
				new ApiError("Invalid email or password", { status: 401 }),
			);

			render(ConnectWizardModal, baseProps({ provider: "immich" }));
			await fillImmich();
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			const error = await screen.findByTestId("wizard-error");
			expect(error).toHaveTextContent(
				"Something went wrong. Please try again.",
			);
			// A 4xx is usually the actionable half, so its detail opens by default.
			expect(error).toHaveTextContent("Invalid email or password");
			expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
		});

		it("keeps a server-side failure's detail collapsed until asked for", async () => {
			mockStartImmichConnect.mockRejectedValue(
				new ApiError("upstream timeout", { status: 502 }),
			);
			render(ConnectWizardModal, baseProps({ provider: "immich" }));
			await fillImmich();
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await screen.findByTestId("wizard-error");
			expect(screen.queryByText("upstream timeout")).not.toBeInTheDocument();
			await fireEvent.click(screen.getByTestId("wizard-error-detail"));
			expect(await screen.findByText("upstream timeout")).toBeInTheDocument();
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
				expect(mockStartPlexConnect).toHaveBeenCalledWith(
					{ serverUrl: "https://plex.example.com", token: "plex-token" },
					expect.any(AbortSignal),
				);
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});
	});

	describe("app-password (GitHub)", () => {
		// "Personal access token" became "Access token", with a sentence saying
		// what a token actually is.
		it("asks for the token in words a person can act on", () => {
			render(ConnectWizardModal, baseProps({ provider: "github" }));
			expect(screen.getByLabelText("Access token")).toBeInTheDocument();
			expect(
				screen.getByText(/a long password you create on GitHub/),
			).toBeInTheDocument();
			expect(
				screen.queryByLabelText("Personal access token"),
			).not.toBeInTheDocument();
		});

		it("submits the token (no base URL) and calls onConnected on success", async () => {
			mockStartGitHubConnect.mockResolvedValue({
				connection: { id: "conn-github", provider: "github" },
			});
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "github", onConnected }),
			);

			await fireEvent.input(screen.getByLabelText("Access token"), {
				target: { value: "ghp_abc123" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartGitHubConnect).toHaveBeenCalledWith(
					{ token: "ghp_abc123" },
					expect.any(AbortSignal),
				);
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});

		it("keeps the custom-server field collapsed until asked for, then sends it", async () => {
			mockStartGitHubConnect.mockResolvedValue({
				connection: { id: "conn-github", provider: "github" },
			});

			render(ConnectWizardModal, baseProps({ provider: "github" }));

			expect(
				screen.queryByLabelText("API base URL (optional)"),
			).not.toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", {
					name: "Use a different server (Gitea, GitHub Enterprise)",
				}),
			);

			await fireEvent.input(screen.getByLabelText("Access token"), {
				target: { value: "ghp_abc123" },
			});
			await fireEvent.input(screen.getByLabelText("API base URL (optional)"), {
				target: { value: "git.example.com/api/v1" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartGitHubConnect).toHaveBeenCalledWith(
					{ token: "ghp_abc123", baseUrl: "git.example.com/api/v1" },
					expect.any(AbortSignal),
				);
			});
		});

		it("disables Connect until a token is entered", async () => {
			render(ConnectWizardModal, baseProps({ provider: "github" }));
			expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
			await fireEvent.input(screen.getByLabelText("Access token"), {
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
				expect(mockStartAppleConnect).toHaveBeenCalledWith(
					{ appleId: "me@icloud.com", appPassword: "abcd-efgh-ijkl-mnop" },
					expect.any(AbortSignal),
				);
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
				{ target: { value: "cloud.example.com/remote.php/dav" } },
			);
			await fireEvent.input(screen.getByLabelText("Username"), {
				target: { value: "alice" },
			});
			await fireEvent.input(screen.getByLabelText("App password"), {
				target: { value: "app-pw-123" },
			});
			await fireEvent.click(screen.getByRole("button", { name: "Connect" }));

			await waitFor(() => {
				expect(mockStartCalDavConnect).toHaveBeenCalledWith(
					{
						serverUrl: "cloud.example.com/remote.php/dav",
						username: "alice",
						appPassword: "app-pw-123",
					},
					expect.any(AbortSignal),
				);
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});

		it("disables Connect until server URL, username, and app password are all filled", async () => {
			render(ConnectWizardModal, baseProps({ provider: "caldav" }));

			expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

			await fireEvent.input(
				screen.getByLabelText("CalDAV/CardDAV server URL"),
				{ target: { value: "cloud.example.com/remote.php/dav" } },
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

	describe("mail (three paths)", () => {
		// "IMAP" is gone from the first screen and only appears once someone
		// chooses "Somewhere else".
		it("asks where the mailbox lives, without jargon, and can go back", async () => {
			render(ConnectWizardModal, baseProps({ provider: "imap" }));

			expect(screen.getByText("Where is your mailbox?")).toBeInTheDocument();
			expect(screen.getByText("Alfy Email")).toBeInTheDocument();
			expect(screen.getByText("Gmail")).toBeInTheDocument();
			expect(screen.getByText("Somewhere else")).toBeInTheDocument();
			expect(screen.queryByText(/IMAP/)).not.toBeInTheDocument();

			await fireEvent.click(screen.getByText("Alfy Email"));
			expect(screen.getByLabelText("Email address")).toBeInTheDocument();

			await fireEvent.click(screen.getByRole("button", { name: "Back" }));
			expect(screen.getByText("Where is your mailbox?")).toBeInTheDocument();
			expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
		});

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
				expect(mockStartEmailConnect).toHaveBeenCalledWith(
					{
						email: "levente@alfydesign.com",
						imapHost: "mail.alfydesign.com",
						imapPort: 993,
						imapSecure: true,
						password: "hunter2",
						smtpHost: "mail.alfydesign.com",
						smtpPort: 587,
					},
					expect.any(AbortSignal),
				);
			});
			expect(onConnected).toHaveBeenCalledOnce();
			expect(onClose).toHaveBeenCalledOnce();
		});

		it("points a failed Alfy Email guess at the manual path, and never renders the password", async () => {
			mockStartEmailConnect.mockRejectedValue(
				new ApiError("Could not reach mail.alfydesign.com", { status: 502 }),
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

			await screen.findByTestId("wizard-error");
			expect(screen.getByText(/Other \(IMAP\)/)).toBeInTheDocument();
			await fireEvent.click(screen.getByTestId("wizard-error-detail"));
			expect(
				await screen.findByText("Could not reach mail.alfydesign.com"),
			).toBeInTheDocument();
			expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
		});

		it("shows the Gmail help and derives imap.gmail.com/smtp.gmail.com", async () => {
			mockStartEmailConnect.mockResolvedValue({
				connection: { id: "conn-gmail", provider: "imap" },
			});
			const onConnected = vi.fn();

			render(ConnectWizardModal, baseProps({ provider: "imap", onConnected }));

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
				expect(mockStartEmailConnect).toHaveBeenCalledWith(
					{
						email: "me@gmail.com",
						imapHost: "imap.gmail.com",
						imapPort: 993,
						imapSecure: true,
						password: "abcd efgh ijkl mnop",
						smtpHost: "smtp.gmail.com",
						smtpPort: 587,
					},
					expect.any(AbortSignal),
				);
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});

		it("submits the manually-entered IMAP fields with sane defaults", async () => {
			mockStartEmailConnect.mockResolvedValue({
				connection: { id: "conn-imap", provider: "imap" },
			});
			const onConnected = vi.fn();

			render(ConnectWizardModal, baseProps({ provider: "imap", onConnected }));

			await fireEvent.click(screen.getByText("Somewhere else"));

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
				expect(mockStartEmailConnect).toHaveBeenCalledWith(
					{
						email: "me@example.com",
						imapHost: "imap.example.com",
						imapPort: 993,
						imapSecure: true,
						password: "app-pw",
					},
					expect.any(AbortSignal),
				);
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});

		it("skips the question on reconnect and prefills the saved config", () => {
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

	describe("OwnTracks device picker", () => {
		it("names each device and says when it was last seen", async () => {
			const now = Math.floor(Date.now() / 1000);
			mockFetchOwnTracksDevices.mockResolvedValue([
				{ otUser: "alice", otDevice: "phone", lastSeen: now - 240 },
				{ otUser: "alice", otDevice: "tablet" },
			]);
			render(ConnectWizardModal, baseProps({ provider: "owntracks" }));

			await waitFor(() => {
				expect(screen.getByLabelText("phone")).toBeInTheDocument();
			});
			expect(screen.getByText(/Last seen/)).toBeInTheDocument();
			// No timestamp is never invented — the recorder identity fills in.
			expect(screen.getByText("On the recorder as alice")).toBeInTheDocument();
		});

		it("starts with the picked device", async () => {
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
				expect(screen.getByLabelText("phone")).toBeInTheDocument();
			});
			await fireEvent.click(screen.getByLabelText("tablet"));
			await fireEvent.click(
				screen.getByRole("button", { name: "Use this device" }),
			);

			await waitFor(() => {
				expect(mockStartOwnTracksConnect).toHaveBeenCalledWith(
					{ otUser: "alice", otDevice: "tablet" },
					expect.any(AbortSignal),
				);
			});
			expect(onConnected).toHaveBeenCalledOnce();
		});

		// A decision with one answer shouldn't leave the primary action disabled.
		it("pre-selects a lone device", async () => {
			mockFetchOwnTracksDevices.mockResolvedValue([
				{ otUser: "alice", otDevice: "phone" },
			]);
			render(ConnectWizardModal, baseProps({ provider: "owntracks" }));
			await waitFor(() => {
				expect(screen.getByLabelText("phone")).toBeChecked();
			});
			expect(
				screen.getByRole("button", { name: "Use this device" }),
			).not.toBeDisabled();
		});

		// Was a dead end: "ask your administrator to set the OwnTracks Recorder
		// URL", with no way to get there.
		it("names the Administration page when the recorder isn't set up", async () => {
			mockFetchOwnTracksDevices.mockRejectedValue(
				new ApiError("OwnTracks is not configured", { status: 409 }),
			);

			render(
				ConnectWizardModal,
				baseProps({ provider: "owntracks", isAdmin: true }),
			);

			const notice = await screen.findByTestId("wizard-not-set-up");
			expect(notice).toHaveTextContent(/needs the address of your recorder/);
			expect(
				screen.getByText("Administration → System → Advanced → Integrations"),
			).toBeInTheDocument();
		});

		it("shows the same not-set-up state when start returns 409, not a generic error", async () => {
			mockFetchOwnTracksDevices.mockResolvedValue([
				{ otUser: "alice", otDevice: "phone" },
			]);
			mockStartOwnTracksConnect.mockRejectedValue(
				new ApiError("OwnTracks is not configured", { status: 409 }),
			);
			const onConnected = vi.fn();

			render(
				ConnectWizardModal,
				baseProps({ provider: "owntracks", onConnected, isAdmin: true }),
			);

			await waitFor(() => {
				expect(screen.getByLabelText("phone")).toBeInTheDocument();
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Use this device" }),
			);

			expect(
				await screen.findByTestId("wizard-not-set-up"),
			).toBeInTheDocument();
			expect(onConnected).not.toHaveBeenCalled();
		});

		it("offers a retry when the listing fails for any other reason", async () => {
			mockFetchOwnTracksDevices.mockRejectedValueOnce(
				new ApiError("recorder unreachable", { status: 502 }),
			);
			render(ConnectWizardModal, baseProps({ provider: "owntracks" }));
			const retry = await screen.findByRole("button", { name: "Try again" });

			mockFetchOwnTracksDevices.mockResolvedValueOnce([
				{ otUser: "alice", otDevice: "phone" },
			]);
			await fireEvent.click(retry);
			await waitFor(() => {
				expect(screen.getByLabelText("phone")).toBeInTheDocument();
			});
		});
	});

	describe("contacts (no backend route yet)", () => {
		it("shows a not-available notice instead of a form", () => {
			render(ConnectWizardModal, baseProps({ provider: "contacts" }));

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
