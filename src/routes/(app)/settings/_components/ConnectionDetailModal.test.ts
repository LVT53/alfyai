import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "$lib/client/api/connections";
import ConnectionDetailModal from "./ConnectionDetailModal.svelte";

// Redesign R9 — the modal fetches Nextcloud folder suggestions itself (same
// pattern as ConnectWizardModal calling fetchOwnTracksDevices directly), so
// every test in this file runs against a mocked client wrapper rather than a
// real network call. Individual tests override the resolved/rejected value.
const mockFetchNextcloudFolders = vi.fn();
vi.mock("$lib/client/api/connections", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/client/api/connections")>();
	return {
		...actual,
		fetchNextcloudFolders: (...args: unknown[]) =>
			mockFetchNextcloudFolders(...args),
	};
});

function makeConnection(
	overrides: Partial<ConnectionPublic> = {},
): ConnectionPublic {
	return {
		id: "conn-1",
		provider: "google",
		label: "Google",
		accountIdentifier: "person@example.com",
		status: "connected",
		statusDetail: null,
		defaultOn: true,
		allowWrites: false,
		writeAllowlist: [],
		capabilities: ["calendar"],
		grantedCapabilities: ["calendar", "contacts"],
		config: {},
		oauthScopes: ["calendar"],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		lastUsedAt: null,
		statusChangedAt: null,
		createdAt: 1_756_000_000,
		updatedAt: 1_756_000_000,
		...overrides,
	};
}

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		connection: makeConnection(),
		onClose: vi.fn(),
		onToggleCapability: vi.fn(),
		onToggleAllowWrites: vi.fn(),
		onToggleDefaultOn: vi.fn(),
		onUpdateWriteAllowlist: vi.fn(),
		onUpdateOwnTracksHome: vi.fn(),
		onDisconnect: vi.fn(),
		onReconnect: vi.fn(),
		onAskAgain: vi.fn(),
		...overrides,
	};
}

describe("ConnectionDetailModal", () => {
	beforeEach(() => {
		mockFetchNextcloudFolders.mockReset();
		mockFetchNextcloudFolders.mockResolvedValue([]);
		// See the note in SettingsConnectionsTab.test.ts: jsdom has no Web
		// Animations API, so reporting reduced motion is what lets an outro
		// finish.
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: true,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
	});

	it("renders nothing when connection is null", () => {
		render(ConnectionDetailModal, baseProps({ connection: null }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("renders a header with the provider, the account and the same status word as the list", () => {
		render(
			ConnectionDetailModal,
			baseProps({ connection: makeConnection({ status: "connected" }) }),
		);
		const detail = screen.getByTestId("connection-detail-conn-1");
		expect(within(detail).getByText("person@example.com")).toBeInTheDocument();
		expect(within(detail).getByText("Connected")).toBeInTheDocument();
	});

	// The change the whole redesign turns on: a capability the provider refused
	// gets no switch, because turning it on never meant anything.
	describe("switches only for what was granted", () => {
		it("renders a switch per granted capability", () => {
			render(ConnectionDetailModal, baseProps());
			expect(
				screen.getByRole("switch", { name: "Calendar" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("switch", { name: "Contacts" }),
			).toBeInTheDocument();
		});

		it("renders a denied capability as a greyed line with 'Ask again', and no switch", async () => {
			const onAskAgain = vi.fn();
			render(
				ConnectionDetailModal,
				baseProps({
					onAskAgain,
					connection: makeConnection({
						capabilities: ["calendar"],
						grantedCapabilities: ["calendar"],
					}),
				}),
			);
			const row = screen.getByTestId("capability-contacts");
			expect(row.className).toContain("denied");
			expect(
				within(row).queryByRole("switch", { name: "Contacts" }),
			).not.toBeInTheDocument();
			expect(
				within(row).getByText(
					"You didn't allow this, so there is nothing to switch on.",
				),
			).toBeInTheDocument();

			await fireEvent.click(
				screen.getByTestId("capability-contacts-ask-again"),
			);
			expect(onAskAgain).toHaveBeenCalledWith("conn-1", "contacts");
		});

		// A CalDAV server without address books didn't "refuse" anything — it
		// simply doesn't have them, and there is no consent screen to revisit.
		it("says a discovered capability is missing from the server, with no ask-again", () => {
			render(
				ConnectionDetailModal,
				baseProps({
					connection: makeConnection({
						provider: "caldav",
						capabilities: ["tasks"],
						grantedCapabilities: ["tasks"],
					}),
				}),
			);
			const row = screen.getByTestId("capability-contacts");
			expect(
				within(row).getByText(
					"Your server doesn't offer this, so there is nothing to switch on.",
				),
			).toBeInTheDocument();
			expect(
				screen.queryByTestId("capability-contacts-ask-again"),
			).not.toBeInTheDocument();
		});

		it("toggling a capability calls onToggleCapability with (id, capability, next)", async () => {
			const onToggleCapability = vi.fn();
			render(ConnectionDetailModal, baseProps({ onToggleCapability }));
			await fireEvent.click(screen.getByRole("switch", { name: "Calendar" }));
			expect(onToggleCapability).toHaveBeenCalledWith(
				"conn-1",
				"calendar",
				false,
			);
		});

		// Rapid toggling used to race two PATCHes against each other.
		it("disables a switch while its own write is in flight", async () => {
			let resolve: (() => void) | undefined;
			const onToggleCapability = vi.fn(
				() =>
					new Promise<void>((r) => {
						resolve = r;
					}),
			);
			render(ConnectionDetailModal, baseProps({ onToggleCapability }));
			const toggle = screen.getByRole("switch", { name: "Calendar" });
			await fireEvent.click(toggle);
			await waitFor(() => expect(toggle).toBeDisabled());
			// Another switch stays live — only the one being written is locked.
			expect(
				screen.getByRole("switch", { name: "Contacts" }),
			).not.toBeDisabled();
			resolve?.();
			await waitFor(() => expect(toggle).not.toBeDisabled());
		});
	});

	describe("how it behaves", () => {
		it("labels the default-on switch in words, with its own sentence", async () => {
			const onToggleDefaultOn = vi.fn();
			render(ConnectionDetailModal, baseProps({ onToggleDefaultOn }));
			const row = screen.getByTestId("behaviour-default-on");
			expect(
				within(row).getByText("Use it without asking"),
			).toBeInTheDocument();
			expect(
				within(row).getByText(/reaches for Google on its own/),
			).toBeInTheDocument();
			// The old bare label is gone.
			expect(screen.queryByText("Default on")).not.toBeInTheDocument();

			await fireEvent.click(
				within(row).getByRole("switch", { name: "Use it without asking" }),
			);
			expect(onToggleDefaultOn).toHaveBeenCalledWith("conn-1", false);
		});

		it("labels the writes switch in words and keeps the long warning in a tooltip", async () => {
			const onToggleAllowWrites = vi.fn();
			render(
				ConnectionDetailModal,
				baseProps({
					onToggleAllowWrites,
					connection: makeConnection({ provider: "nextcloud" }),
				}),
			);
			const row = screen.getByTestId("behaviour-allow-writes");
			expect(within(row).getByText("Let Alfy write")).toBeInTheDocument();
			expect(
				within(row).getByRole("button", { name: /Writing is off by default/ }),
			).toBeInTheDocument();
			expect(screen.queryByText("Allow writes")).not.toBeInTheDocument();

			await fireEvent.click(
				within(row).getByRole("switch", { name: "Let Alfy write" }),
			);
			expect(onToggleAllowWrites).toHaveBeenCalledWith("conn-1", true);
		});

		it("hides the writes switch entirely for a read-only provider, and says why", () => {
			render(
				ConnectionDetailModal,
				baseProps({
					connection: makeConnection({
						provider: "plex",
						capabilities: ["media"],
						grantedCapabilities: ["media"],
					}),
				}),
			);
			expect(
				screen.queryByTestId("behaviour-allow-writes"),
			).not.toBeInTheDocument();
			expect(
				screen.getByText("Plex is read-only — Alfy can never change it."),
			).toBeInTheDocument();
		});

		// Plex's library is films and shows, not "media".
		it("calls Plex's capability films and shows", () => {
			render(
				ConnectionDetailModal,
				baseProps({
					connection: makeConnection({
						provider: "plex",
						capabilities: ["media"],
						grantedCapabilities: ["media"],
					}),
				}),
			);
			expect(
				screen.getByRole("switch", { name: "Films and shows" }),
			).toBeInTheDocument();
		});
	});

	describe("write folders", () => {
		function nextcloudProps(overrides: Partial<ConnectionPublic> = {}) {
			return baseProps({
				connection: makeConnection({
					provider: "nextcloud",
					capabilities: ["files", "contacts"],
					grantedCapabilities: ["files", "contacts"],
					allowWrites: true,
					...overrides,
				}),
			});
		}

		it("shows the folder editor only for a path-scoped writable connection", () => {
			render(ConnectionDetailModal, nextcloudProps());
			expect(screen.getByText("Folders Alfy may write to")).toBeInTheDocument();
		});

		it("shows a confirm note instead for a writable provider without folder scoping", () => {
			render(
				ConnectionDetailModal,
				baseProps({
					connection: makeConnection({
						provider: "imap",
						capabilities: ["email"],
						grantedCapabilities: ["email"],
						allowWrites: true,
					}),
				}),
			);
			expect(
				screen.queryByText("Folders Alfy may write to"),
			).not.toBeInTheDocument();
			expect(
				screen.getByText(
					"Every change is confirmed individually before it happens.",
				),
			).toBeInTheDocument();
		});

		it("adding a folder calls onUpdateWriteAllowlist with the appended path", async () => {
			const props = nextcloudProps({ writeAllowlist: ["/AlfyAI"] });
			render(ConnectionDetailModal, props);
			const input = screen.getByRole("combobox");
			await fireEvent.input(input, { target: { value: "/Reports" } });
			await fireEvent.click(screen.getByText("Add folder"));
			expect(props.onUpdateWriteAllowlist).toHaveBeenCalledWith("conn-1", [
				"/AlfyAI",
				"/Reports",
			]);
		});

		// R3-fix #9 in reverse: the add action is a labelled button now.
		it("labels the add-folder action instead of showing a bare plus glyph", () => {
			render(ConnectionDetailModal, nextcloudProps());
			expect(
				screen.getByRole("button", { name: /Add folder/ }),
			).toBeInTheDocument();
		});

		it("removing a folder calls onUpdateWriteAllowlist without that path", async () => {
			const props = nextcloudProps({ writeAllowlist: ["/AlfyAI", "/Reports"] });
			render(ConnectionDetailModal, props);
			await fireEvent.click(screen.getByLabelText("Remove /AlfyAI"));
			expect(props.onUpdateWriteAllowlist).toHaveBeenCalledWith("conn-1", [
				"/Reports",
			]);
		});

		it("offers folder suggestions on focus", async () => {
			mockFetchNextcloudFolders.mockResolvedValue([
				{ path: "/Documents", name: "Documents" },
				{ path: "/Photos", name: "Photos" },
			]);
			render(ConnectionDetailModal, nextcloudProps());
			await waitFor(() => {
				expect(mockFetchNextcloudFolders).toHaveBeenCalledWith("conn-1");
			});
			await fireEvent.focus(screen.getByRole("combobox"));
			expect(
				await screen.findByRole("option", { name: "/Documents" }),
			).toBeInTheDocument();
		});

		it("falls back to manual entry when the folder fetch fails", async () => {
			mockFetchNextcloudFolders.mockRejectedValue(new Error("offline"));
			const props = nextcloudProps();
			render(ConnectionDetailModal, props);
			await waitFor(() => {
				expect(mockFetchNextcloudFolders).toHaveBeenCalled();
			});
			const input = screen.getByRole("combobox");
			await fireEvent.focus(input);
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
			await fireEvent.input(input, { target: { value: "/Manual" } });
			await fireEvent.click(screen.getByText("Add folder"));
			expect(props.onUpdateWriteAllowlist).toHaveBeenCalledWith("conn-1", [
				"/Manual",
			]);
		});

		it("does not fetch suggestions for a non-nextcloud provider, or with writes off", () => {
			render(
				ConnectionDetailModal,
				baseProps({
					connection: makeConnection({ provider: "imap", allowWrites: true }),
				}),
			);
			expect(mockFetchNextcloudFolders).not.toHaveBeenCalled();

			render(ConnectionDetailModal, nextcloudProps({ allowWrites: false }));
			expect(mockFetchNextcloudFolders).not.toHaveBeenCalled();
		});
	});

	// Disconnect used to be an unlabelled plug glyph in the header, and its
	// confirmation said nothing about what would be lost.
	describe("disconnect", () => {
		it("is a labelled danger button naming the provider", () => {
			render(ConnectionDetailModal, baseProps());
			expect(
				screen.getByRole("button", { name: "Disconnect Google" }),
			).toBeInTheDocument();
		});

		it("confirms first, saying what is lost and what is not, then calls onDisconnect", async () => {
			const onDisconnect = vi.fn();
			render(ConnectionDetailModal, baseProps({ onDisconnect }));
			await fireEvent.click(screen.getByTestId("connection-disconnect"));

			expect(await screen.findByText("Disconnect Google?")).toBeInTheDocument();
			expect(
				screen.getByText(/Nothing is deleted from Google/),
			).toBeInTheDocument();
			expect(
				screen.getByText(/loses access to Calendar, Contacts/),
			).toBeInTheDocument();

			await fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
			expect(onDisconnect).toHaveBeenCalledWith("conn-1");
		});

		it("warns that the write folders are forgotten too", async () => {
			render(
				ConnectionDetailModal,
				baseProps({
					connection: makeConnection({
						provider: "nextcloud",
						capabilities: ["files"],
						grantedCapabilities: ["files", "contacts"],
						allowWrites: true,
						writeAllowlist: ["/AlfyAI", "/Reports"],
					}),
				}),
			);
			await fireEvent.click(screen.getByTestId("connection-disconnect"));
			expect(
				await screen.findByText(
					/The 2 write folders you set are forgotten too/,
				),
			).toBeInTheDocument();
		});
	});

	// A broken connection used to open with a bare chip and the provider's raw
	// error string as a paragraph, with no way to act.
	describe("a broken connection", () => {
		it("leads with what happened and the sign-in that fixes it", async () => {
			const onReconnect = vi.fn();
			render(
				ConnectionDetailModal,
				baseProps({
					onReconnect,
					connection: makeConnection({
						status: "needs_reauth",
						statusChangedAt: 1_757_300_000,
					}),
				}),
			);
			const banner = screen.getByTestId("connection-detail-banner");
			expect(
				within(banner).getByText(/stopped accepting the saved permission/),
			).toBeInTheDocument();
			await fireEvent.click(screen.getByTestId("connection-detail-recover"));
			expect(onReconnect).toHaveBeenCalledWith("conn-1");
		});

		it("keeps the provider's own words behind a disclosure rather than in the sentence", async () => {
			render(
				ConnectionDetailModal,
				baseProps({
					connection: makeConnection({
						status: "error",
						statusDetail: "ECONNREFUSED 10.0.0.4:443",
					}),
				}),
			);
			expect(
				screen.queryByText("ECONNREFUSED 10.0.0.4:443"),
			).not.toBeInTheDocument();
			await fireEvent.click(screen.getByTestId("connection-detail-technical"));
			expect(
				await screen.findByText("ECONNREFUSED 10.0.0.4:443"),
			).toBeInTheDocument();
		});
	});

	// Reconnect used to appear only on broken rows, so a working connection
	// whose permissions needed widening had no way to re-run the flow.
	it("offers reconnect on a healthy connection too", async () => {
		const onReconnect = vi.fn();
		render(ConnectionDetailModal, baseProps({ onReconnect }));
		await fireEvent.click(screen.getByTestId("connection-reconnect"));
		expect(onReconnect).toHaveBeenCalledWith("conn-1");
	});

	it("renders as a centered, content-sized dialog", () => {
		render(ConnectionDetailModal, baseProps());
		const dialog = screen.getByRole("dialog");
		expect(dialog.className).toContain("max-w-[30rem]");
		expect(dialog.className).not.toContain("max-w-full");
	});

	it("closes on Escape and from Done", async () => {
		const onClose = vi.fn();
		render(ConnectionDetailModal, baseProps({ onClose }));
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();

		onClose.mockClear();
		await fireEvent.click(screen.getByText("Done"));
		expect(onClose).toHaveBeenCalled();
	});

	describe("OwnTracks home location editor", () => {
		function ownTracksProps(overrides: Record<string, unknown> = {}) {
			return baseProps({
				connection: makeConnection({
					provider: "owntracks",
					capabilities: ["location"],
					grantedCapabilities: ["location"],
					...((overrides.connectionOverrides as object) ?? {}),
				}),
				...overrides,
			});
		}

		it("does not render for a non-owntracks provider", () => {
			render(ConnectionDetailModal, baseProps());
			expect(screen.queryByText("Latitude")).not.toBeInTheDocument();
		});

		it("renders for an owntracks connection", () => {
			render(ConnectionDetailModal, ownTracksProps());
			expect(screen.getByText("Latitude")).toBeInTheDocument();
			expect(screen.getByText("Longitude")).toBeInTheDocument();
		});

		it("pre-fills the inputs from the stored coordinates", () => {
			render(
				ConnectionDetailModal,
				baseProps({
					connection: makeConnection({
						provider: "owntracks",
						capabilities: ["location"],
						grantedCapabilities: ["location"],
						config: { homeLat: 47.4979, homeLon: 19.0402 },
					}),
				}),
			);
			const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
			expect(inputs[0].value).toBe("47.4979");
			expect(inputs[1].value).toBe("19.0402");
		});

		it("saving valid coordinates calls onUpdateOwnTracksHome with numbers", async () => {
			const props = ownTracksProps();
			render(ConnectionDetailModal, props);
			const inputs = screen.getAllByRole("spinbutton");
			await fireEvent.input(inputs[0], { target: { value: "47.4979" } });
			await fireEvent.input(inputs[1], { target: { value: "19.0402" } });
			await fireEvent.click(screen.getByText("Save home"));
			expect(props.onUpdateOwnTracksHome).toHaveBeenCalledWith("conn-1", {
				homeLat: 47.4979,
				homeLon: 19.0402,
			});
		});

		it("rejects an out-of-range longitude without saving", async () => {
			const props = ownTracksProps();
			render(ConnectionDetailModal, props);
			const inputs = screen.getAllByRole("spinbutton");
			await fireEvent.input(inputs[0], { target: { value: "47.4979" } });
			await fireEvent.input(inputs[1], { target: { value: "219.0402" } });
			await fireEvent.click(screen.getByText("Save home"));
			expect(
				await screen.findByText("Longitude must be between -180 and 180."),
			).toBeInTheDocument();
			expect(props.onUpdateOwnTracksHome).not.toHaveBeenCalled();
		});

		it("rejects an out-of-range latitude without saving", async () => {
			const props = ownTracksProps();
			render(ConnectionDetailModal, props);
			const inputs = screen.getAllByRole("spinbutton");
			await fireEvent.input(inputs[0], { target: { value: "91" } });
			await fireEvent.input(inputs[1], { target: { value: "19" } });
			await fireEvent.click(screen.getByText("Save home"));
			expect(
				await screen.findByText("Latitude must be between -90 and 90."),
			).toBeInTheDocument();
			expect(props.onUpdateOwnTracksHome).not.toHaveBeenCalled();
		});

		it("saving with both inputs empty unsets the home location", async () => {
			const props = ownTracksProps();
			render(ConnectionDetailModal, props);
			await fireEvent.click(screen.getByText("Save home"));
			expect(props.onUpdateOwnTracksHome).toHaveBeenCalledWith("conn-1", {
				homeLat: null,
				homeLon: null,
			});
		});

		it("Clear empties both inputs and unsets the home location", async () => {
			const props = baseProps({
				connection: makeConnection({
					provider: "owntracks",
					capabilities: ["location"],
					grantedCapabilities: ["location"],
					config: { homeLat: 47.4979, homeLon: 19.0402 },
				}),
			});
			render(ConnectionDetailModal, props);
			await fireEvent.click(screen.getByText("Clear"));
			const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
			expect(inputs[0].value).toBe("");
			expect(props.onUpdateOwnTracksHome).toHaveBeenCalledWith("conn-1", {
				homeLat: null,
				homeLon: null,
			});
		});
	});
});
