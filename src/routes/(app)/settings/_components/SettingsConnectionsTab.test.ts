import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "$lib/client/api/connections";
import {
	CONNECTABLE_PROVIDER_LIST,
	getProviderCatalogEntry,
} from "$lib/client/connections/provider-catalog";
import SettingsConnectionsTab from "./SettingsConnectionsTab.svelte";

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
		connections: [] as ConnectionPublic[],
		loading: false,
		loadFailed: false,
		onRetryLoad: vi.fn(),
		onToggleCapability: vi.fn(),
		onToggleAllowWrites: vi.fn(),
		onToggleDefaultOn: vi.fn(),
		onUpdateWriteAllowlist: vi.fn(),
		onUpdateOwnTracksHome: vi.fn(),
		onDisconnect: vi.fn(),
		onStartConnect: vi.fn(),
		onReconnect: vi.fn(),
		onAskAgain: vi.fn(),
		localDistill: false,
		localityLoading: false,
		onToggleLocalDistill: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	sessionStorage.clear();
	// jsdom has no Web Animations API, so a Svelte outro never finishes and a
	// dismissed card would sit in the DOM for the rest of the test. Reporting
	// reduced motion collapses every transition to zero duration — which is
	// also exactly the path a reduced-motion user gets, so this exercises real
	// behaviour rather than disabling it.
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: true,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
});

describe("SettingsConnectionsTab", () => {
	it("renders one row per connection with its name, account and capability chips", () => {
		render(
			SettingsConnectionsTab,
			baseProps({ connections: [makeConnection({ id: "conn-1" })] }),
		);

		const row = screen.getByTestId("connection-row-conn-1");
		expect(within(row).getByText("Google")).toBeInTheDocument();
		expect(within(row).getByText("person@example.com")).toBeInTheDocument();
		expect(within(row).getByText("Calendar")).toBeInTheDocument();
	});

	// The redesign's central claim: one grammar for every state. A healthy
	// connection used to render NOTHING in this column.
	describe("one grammar for every state", () => {
		it("says a healthy connection is connected, and when it was last used", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({
							status: "connected",
							lastUsedAt: Math.floor(Date.now() / 1000) - 720,
						}),
					],
				}),
			);
			const row = screen.getByTestId("connection-row-conn-1");
			expect(within(row).getByText("Connected")).toBeInTheDocument();
			expect(within(row).getByText(/Last used/)).toBeInTheDocument();
		});

		it("says a connection needs signing in again, in plain words", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({
							status: "needs_reauth",
							statusChangedAt: 1_757_300_000,
						}),
					],
				}),
			);
			const row = screen.getByTestId("connection-row-conn-1");
			expect(within(row).getByText("Needs sign-in again")).toBeInTheDocument();
			expect(
				within(row).getByText(/stopped accepting the saved permission/),
			).toBeInTheDocument();
			// The old jargon is gone from the row.
			expect(
				within(row).queryByText("Needs reauthorization"),
			).not.toBeInTheDocument();
		});

		it("says a connection can't be reached, without printing the provider's raw error", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({
							provider: "github",
							status: "error",
							statusDetail: "401 Bad credentials",
							statusChangedAt: 1_757_400_000,
						}),
					],
				}),
			);
			const row = screen.getByTestId("connection-row-conn-1");
			expect(within(row).getByText("Can't reach it")).toBeInTheDocument();
			expect(
				within(row).queryByText(/401 Bad credentials/),
			).not.toBeInTheDocument();
		});

		it("says a turned-off connection is turned off, and when", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({
							status: "disconnected",
							statusChangedAt: 1_756_800_000,
						}),
					],
				}),
			);
			const row = screen.getByTestId("connection-row-conn-1");
			expect(within(row).getByText("Turned off")).toBeInTheDocument();
			expect(within(row).getByText(/You turned this off/)).toBeInTheDocument();
		});

		// The one change the owner asked for on top of the boards: the status
		// column must not move when the number of buttons beside it changes.
		it("gives the status column a fixed width so it never shifts with the buttons", () => {
			const { container } = render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({ id: "conn-1", status: "connected" }),
						makeConnection({ id: "conn-2", status: "needs_reauth" }),
					],
				}),
			);
			const cells = container.querySelectorAll(".status-cell");
			expect(cells).toHaveLength(2);
			for (const cell of cells) {
				expect(cell.className).not.toContain("compact");
			}
		});
	});

	describe("capability chips", () => {
		it("marks a capability the provider refused as not allowed", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({
							capabilities: ["calendar"],
							grantedCapabilities: ["calendar"],
						}),
					],
				}),
			);
			const row = screen.getByTestId("connection-row-conn-1");
			expect(
				within(row).getByText("Contacts — not allowed"),
			).toBeInTheDocument();
		});

		it("says when a connection may write, and to how many folders", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({
							provider: "nextcloud",
							capabilities: ["files", "contacts"],
							grantedCapabilities: ["files", "contacts"],
							allowWrites: true,
							writeAllowlist: ["/AlfyAI", "/Documents"],
						}),
					],
				}),
			);
			const row = screen.getByTestId("connection-row-conn-1");
			expect(within(row).getByText("Writes to 2 folders")).toBeInTheDocument();
		});
	});

	describe("recovery actions", () => {
		it("offers 'Sign in again' on a connection that needs it", async () => {
			const onReconnect = vi.fn();
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [makeConnection({ status: "needs_reauth" })],
					onReconnect,
				}),
			);
			await fireEvent.click(screen.getByText("Sign in again"));
			expect(onReconnect).toHaveBeenCalledWith("conn-1");
		});

		it("offers 'Fix this' on an unreachable connection", () => {
			render(
				SettingsConnectionsTab,
				baseProps({ connections: [makeConnection({ status: "error" })] }),
			);
			expect(screen.getByText("Fix this")).toBeInTheDocument();
		});

		// New: a disconnected connection had no way back from the list at all.
		it("offers 'Connect again' on a turned-off connection", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [makeConnection({ status: "disconnected" })],
				}),
			);
			expect(screen.getByText("Connect again")).toBeInTheDocument();
		});

		it("offers no recovery action on a healthy connection", () => {
			render(
				SettingsConnectionsTab,
				baseProps({ connections: [makeConnection({ status: "connected" })] }),
			);
			expect(
				screen.queryByTestId("connection-recover-conn-1"),
			).not.toBeInTheDocument();
			expect(
				screen.getByTestId("connection-details-conn-1"),
			).toBeInTheDocument();
		});
	});

	it("opens the detail dialog from the row and from its Details button", async () => {
		const { unmount } = render(
			SettingsConnectionsTab,
			baseProps({ connections: [makeConnection()] }),
		);
		await fireEvent.click(screen.getByTestId("connection-details-conn-1"));
		expect(
			await screen.findByTestId("connection-detail-conn-1"),
		).toBeInTheDocument();
		unmount();

		render(
			SettingsConnectionsTab,
			baseProps({ connections: [makeConnection()] }),
		);
		const row = screen.getByTestId("connection-row-conn-1");
		await fireEvent.click(within(row).getAllByRole("button")[0]);
		expect(
			await screen.findByTestId("connection-detail-conn-1"),
		).toBeInTheDocument();
	});

	describe("empty, loading and failed states", () => {
		it("renders the empty state when the account genuinely has no connections", () => {
			render(SettingsConnectionsTab, baseProps());
			expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		});

		it("shows a loading indicator instead of the list while loading", () => {
			render(SettingsConnectionsTab, baseProps({ loading: true }));
			expect(screen.queryByTestId("connections-list")).not.toBeInTheDocument();
			expect(screen.queryByTestId("connections-empty")).not.toBeInTheDocument();
		});

		// A failed load used to render the SAME card as an empty account, with
		// a code comment saying the user could retry by revisiting the page.
		it("tells the user a failed load is not an empty account, and offers a retry", async () => {
			const onRetryLoad = vi.fn();
			render(
				SettingsConnectionsTab,
				baseProps({ loadFailed: true, onRetryLoad }),
			);
			const card = screen.getByTestId("connections-load-failed");
			expect(
				within(card).getByText("We couldn't load your connections"),
			).toBeInTheDocument();
			expect(
				within(card).getByText(/your accounts are still connected/i),
			).toBeInTheDocument();
			expect(screen.queryByTestId("connections-empty")).not.toBeInTheDocument();
			await fireEvent.click(within(card).getByText("Try again"));
			expect(onRetryLoad).toHaveBeenCalled();
		});
	});

	// A failed toggle used to snap back in silence, leaving the user unable to
	// tell whether the change had taken.
	describe("a change that did not save", () => {
		it("names the exact change that failed and offers to try it again", async () => {
			const onToggleLocalDistill = vi
				.fn()
				.mockRejectedValueOnce(new Error("nope"))
				.mockResolvedValueOnce(undefined);
			render(SettingsConnectionsTab, baseProps({ onToggleLocalDistill }));

			await fireEvent.click(
				screen.getByRole("switch", {
					name: "Keep connected data on this device",
				}),
			);

			const card = await screen.findByTestId("connections-change-failed");
			expect(
				within(card).getByText("That change didn't save"),
			).toBeInTheDocument();
			expect(
				within(card).getByText(/Turning on on-device processing/),
			).toBeInTheDocument();

			await fireEvent.click(within(card).getByText("Try again"));
			await waitFor(() => {
				expect(onToggleLocalDistill).toHaveBeenCalledTimes(2);
			});
			// The card animates out, so give the outro room to finish.
			await waitFor(
				() => {
					expect(
						screen.queryByTestId("connections-change-failed"),
					).not.toBeInTheDocument();
				},
				{ timeout: 4000 },
			);
		});

		it("can be dismissed", async () => {
			const onToggleLocalDistill = vi.fn().mockRejectedValue(new Error("nope"));
			render(SettingsConnectionsTab, baseProps({ onToggleLocalDistill }));
			await fireEvent.click(
				screen.getByRole("switch", {
					name: "Keep connected data on this device",
				}),
			);
			const card = await screen.findByTestId("connections-change-failed");
			await fireEvent.click(within(card).getByText("Dismiss"));
			await waitFor(
				() => {
					expect(
						screen.queryByTestId("connections-change-failed"),
					).not.toBeInTheDocument();
				},
				{ timeout: 4000 },
			);
		});
	});

	// A partial OAuth grant produced fewer capabilities than the boxes that
	// were ticked, and said nothing at all.
	describe("a partial OAuth grant", () => {
		it("says which capability was refused and offers to ask again", async () => {
			sessionStorage.setItem(
				"alfyai:connections:requested:google",
				JSON.stringify(["calendar", "contacts"]),
			);
			const onAskAgain = vi.fn();
			render(
				SettingsConnectionsTab,
				baseProps({
					onAskAgain,
					connections: [
						makeConnection({
							capabilities: ["calendar"],
							grantedCapabilities: ["calendar"],
						}),
					],
				}),
			);

			const card = await screen.findByTestId("connections-partial-grant");
			expect(
				within(card).getByText("You allowed Calendar, but not Contacts"),
			).toBeInTheDocument();

			await fireEvent.click(within(card).getByText("Ask for Contacts"));
			expect(onAskAgain).toHaveBeenCalledWith("conn-1", "contacts");
		});

		it("says nothing when the grant was complete", () => {
			sessionStorage.setItem(
				"alfyai:connections:requested:google",
				JSON.stringify(["calendar"]),
			);
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({
							capabilities: ["calendar"],
							grantedCapabilities: ["calendar", "contacts"],
						}),
					],
				}),
			);
			expect(
				screen.queryByTestId("connections-partial-grant"),
			).not.toBeInTheDocument();
		});

		it("says nothing when no connect just happened", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [
						makeConnection({
							capabilities: ["calendar"],
							grantedCapabilities: ["calendar"],
						}),
					],
				}),
			);
			expect(
				screen.queryByTestId("connections-partial-grant"),
			).not.toBeInTheDocument();
		});
	});

	describe("Add a connection", () => {
		it("offers every connectable provider, with a line saying what it brings", () => {
			render(SettingsConnectionsTab, baseProps());
			const card = screen.getByTestId("connections-add");
			for (const provider of CONNECTABLE_PROVIDER_LIST) {
				const entry = getProviderCatalogEntry(provider);
				expect(
					within(card).getByRole("button", {
						name: `Connect ${entry.displayName}`,
					}),
					provider,
				).toBeInTheDocument();
			}
			expect(
				within(card).getByText("Your files and contacts"),
			).toBeInTheDocument();
			// Resolver-only providers stay out of the list.
			expect(
				within(card).queryByRole("button", {
					name: /Contacts \(CardDAV\)/,
				}),
			).not.toBeInTheDocument();
		});

		it("separates the products from the ones you point at your own server", () => {
			render(SettingsConnectionsTab, baseProps());
			expect(screen.getByTestId("connections-add-divider")).toBeInTheDocument();
			expect(screen.getByText("Set one up yourself")).toBeInTheDocument();
			const custom = screen.getByTestId("connections-add-custom");
			expect(
				within(custom).getByRole("button", { name: "Connect CalDAV" }),
			).toBeInTheDocument();
		});

		it("calls onStartConnect with the provider that was clicked", async () => {
			const onStartConnect = vi.fn();
			render(SettingsConnectionsTab, baseProps({ onStartConnect }));
			await fireEvent.click(screen.getByTestId("connections-add-nextcloud"));
			expect(onStartConnect).toHaveBeenCalledWith("nextcloud");
		});

		it("marks an already-connected provider with a labelled check, not a text pill", () => {
			render(
				SettingsConnectionsTab,
				baseProps({ connections: [makeConnection({ provider: "google" })] }),
			);
			const card = screen.getByTestId("connections-add");
			expect(
				within(card).getByRole("img", { name: "Already connected" }),
			).toBeInTheDocument();
		});
	});

	// The privacy control is the main decision on this screen, and used to be
	// the last card on the page.
	describe("on-device processing", () => {
		it("is the first card on the page", () => {
			const { container } = render(
				SettingsConnectionsTab,
				baseProps({ connections: [makeConnection()] }),
			);
			const cards = container.querySelectorAll("[data-testid]");
			const order = [...cards].map((el) => el.getAttribute("data-testid"));
			expect(order.indexOf("connections-locality")).toBeLessThan(
				order.indexOf("connections-list"),
			);
			expect(order.indexOf("connections-locality")).toBeLessThan(
				order.indexOf("connections-add"),
			);
		});

		it("reflects the fetched value and reads its state out as a badge", () => {
			render(SettingsConnectionsTab, baseProps({ localDistill: true }));
			expect(
				screen.getByRole("switch", {
					name: "Keep connected data on this device",
				}),
			).toHaveAttribute("aria-checked", "true");
			expect(
				screen.getByTestId("connections-locality-state"),
			).toHaveTextContent("On");
		});

		it("defaults to off when the preference has not loaded", () => {
			render(SettingsConnectionsTab, baseProps());
			expect(
				screen.getByRole("switch", {
					name: "Keep connected data on this device",
				}),
			).toHaveAttribute("aria-checked", "false");
		});

		it("calls onToggleLocalDistill with the new value", async () => {
			const onToggleLocalDistill = vi.fn();
			render(SettingsConnectionsTab, baseProps({ onToggleLocalDistill }));
			await fireEvent.click(
				screen.getByRole("switch", {
					name: "Keep connected data on this device",
				}),
			);
			expect(onToggleLocalDistill).toHaveBeenCalledWith(true);
		});

		it("disables the switch while the preference is loading", () => {
			render(SettingsConnectionsTab, baseProps({ localityLoading: true }));
			expect(
				screen.getByRole("switch", {
					name: "Keep connected data on this device",
				}),
			).toBeDisabled();
		});

		it("reads as one sentence, with the rest in the tooltip", () => {
			render(SettingsConnectionsTab, baseProps());
			const section = screen.getByTestId("connections-locality");
			expect(
				within(section).getByText(/summarises what your accounts return/),
			).toBeInTheDocument();
			expect(
				within(section).getByRole("button", {
					name: /Summaries aim to keep the details/,
				}),
			).toBeInTheDocument();
		});
	});
});
