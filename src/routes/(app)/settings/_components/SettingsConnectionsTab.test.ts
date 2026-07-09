import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
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
		config: {},
		oauthScopes: ["calendar"],
		tokenExpiresAt: null,
		hasSecret: true,
		hasWriteSecret: false,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		connections: [] as ConnectionPublic[],
		loading: false,
		onToggleCapability: vi.fn(),
		onToggleAllowWrites: vi.fn(),
		onToggleDefaultOn: vi.fn(),
		onUpdateWriteAllowlist: vi.fn(),
		onDisconnect: vi.fn(),
		onStartConnect: vi.fn(),
		onReconnect: vi.fn(),
		localDistill: false,
		localityLoading: false,
		onToggleLocalDistill: vi.fn(),
		...overrides,
	};
}

describe("SettingsConnectionsTab", () => {
	it("renders one compact row per connection with account, capability mini-icons, and a text status chip", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-1" })],
			}),
		);

		const row = screen.getByTestId("connection-row-conn-1");
		expect(within(row).getByText("Google")).toBeInTheDocument();
		expect(within(row).getByText("person@example.com")).toBeInTheDocument();
		expect(within(row).getByText("Connected")).toBeInTheDocument();
		// Capability mini-icon group has an accessible label listing the
		// connection's active capabilities (not color/icon-only).
		expect(
			within(row).getByRole("img", { name: /Calendar/ }),
		).toBeInTheDocument();
	});

	it("does not use the oversized section-title heading for the row name (name/account gap fix)", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-1" })],
			}),
		);

		const row = screen.getByTestId("connection-row-conn-1");
		// The old card reused `.settings-section-title` (a section-heading
		// class with a large margin-bottom) directly above the account line,
		// which produced a visible empty-line gap. The compact row must not
		// use that class for the name.
		expect(row.querySelector(".settings-section-title")).toBeNull();
		expect(row.querySelector("h2")).toBeNull();
	});

	it("the row itself is calm: no toggles or warning prose inline", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [
					makeConnection({
						id: "conn-nc",
						provider: "nextcloud",
						capabilities: ["files"],
						allowWrites: true,
					}),
				],
			}),
		);

		const row = screen.getByTestId("connection-row-conn-nc");
		expect(within(row).queryAllByRole("switch")).toHaveLength(0);
		expect(
			within(row).queryByText(/Writing is off by default/),
		).not.toBeInTheDocument();
	});

	it("clicking a row opens the Connection Detail modal", async () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-1" })],
			}),
		);

		expect(
			screen.queryByTestId("connection-detail-conn-1"),
		).not.toBeInTheDocument();

		const row = screen.getByTestId("connection-row-conn-1");
		const mainRowButton = row.querySelector(
			".connection-row-main",
		) as HTMLElement;
		await fireEvent.click(mainRowButton);

		expect(screen.getByTestId("connection-detail-conn-1")).toBeInTheDocument();
	});

	it("clicking the detail icon action also opens the modal", async () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-1", status: "error" })],
			}),
		);

		const row = screen.getByTestId("connection-row-conn-1");
		// With status "error" both Reconnect and the detail icon are present;
		// scope to the actions container to grab the detail one specifically.
		const detailBtn = within(row).getAllByRole("button", {
			name: "View details Google",
		})[1];
		await fireEvent.click(detailBtn);

		expect(screen.getByTestId("connection-detail-conn-1")).toBeInTheDocument();
	});

	it("shows a Reconnect icon button only for needs_reauth/error connections", async () => {
		const { rerender } = render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-1", status: "connected" })],
			}),
		);
		expect(
			screen.queryByRole("button", { name: /Reconnect/ }),
		).not.toBeInTheDocument();

		await rerender(
			baseProps({
				connections: [
					makeConnection({
						id: "conn-1",
						status: "needs_reauth",
						statusDetail: "Token expired",
					}),
				],
			}),
		);
		expect(
			screen.getByRole("button", { name: "Reconnect Google" }),
		).toBeInTheDocument();
	});

	it("calling the Reconnect button invokes onReconnect with the connection id, without opening the modal", async () => {
		const onReconnect = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-9", status: "error" })],
				onReconnect,
			}),
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "Reconnect Google" }),
		);

		expect(onReconnect).toHaveBeenCalledWith("conn-9");
		expect(
			screen.queryByTestId("connection-detail-conn-9"),
		).not.toBeInTheDocument();
	});

	it("renders the empty state message when there are no connections", () => {
		render(SettingsConnectionsTab, baseProps({ connections: [] }));

		expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		expect(screen.getByText("No connections yet.")).toBeInTheDocument();
	});

	it("shows a loading indicator instead of the list/empty state while loading", () => {
		render(
			SettingsConnectionsTab,
			baseProps({ connections: [], loading: true }),
		);

		expect(screen.queryByTestId("connections-empty")).not.toBeInTheDocument();
		expect(screen.queryByTestId("connections-add")).not.toBeInTheDocument();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});

	describe("Add-a-connection strip", () => {
		it("lists every connectable provider as a brand icon button, excluding contacts", () => {
			render(SettingsConnectionsTab, baseProps({ connections: [] }));

			const addSection = screen.getByTestId("connections-add");
			for (const provider of CONNECTABLE_PROVIDER_LIST) {
				if (provider === "google") continue;
				const displayName = getProviderCatalogEntry(provider).displayName;
				expect(
					within(addSection).getByRole("button", {
						name: `Connect ${displayName}`,
					}),
				).toBeInTheDocument();
			}
			expect(
				within(addSection).queryByRole("button", {
					name: "Connect Contacts (CardDAV)",
				}),
			).not.toBeInTheDocument();
		});

		it("uses the branded GoogleSignInButton for the Google entry", () => {
			render(SettingsConnectionsTab, baseProps({ connections: [] }));

			const addSection = screen.getByTestId("connections-add");
			expect(
				within(addSection).getByRole("button", {
					name: "Continue with Google",
				}),
			).toBeInTheDocument();
		});

		it("clicking a provider tile calls onStartConnect(provider)", async () => {
			const onStartConnect = vi.fn();
			render(
				SettingsConnectionsTab,
				baseProps({ connections: [], onStartConnect }),
			);

			await fireEvent.click(
				screen.getByRole("button", { name: "Connect Nextcloud" }),
			);
			expect(onStartConnect).toHaveBeenCalledWith("nextcloud");

			await fireEvent.click(
				screen.getByRole("button", { name: "Continue with Google" }),
			);
			expect(onStartConnect).toHaveBeenCalledWith("google");
		});

		it("hints at already-connected providers, including Google", () => {
			render(
				SettingsConnectionsTab,
				baseProps({
					connections: [makeConnection({ id: "conn-1", provider: "google" })],
				}),
			);

			const addSection = screen.getByTestId("connections-add");
			const googleTile = within(addSection)
				.getByRole("button", { name: "Continue with Google" })
				.closest(".connections-provider-tile") as HTMLElement;
			expect(within(googleTile).getByText("Connected")).toBeInTheDocument();

			const nextcloudBtn = within(addSection).getByRole("button", {
				name: "Connect Nextcloud",
			});
			expect(
				within(nextcloudBtn).queryByText("Connected"),
			).not.toBeInTheDocument();
		});
	});

	describe("Privacy & locality (Option A)", () => {
		it("renders the local-distill toggle reflecting the fetched value", () => {
			render(SettingsConnectionsTab, baseProps({ localDistill: true }));

			const section = screen.getByTestId("connections-locality");
			const toggle = within(section).getByRole("switch", {
				name: "Keep connector data on this device",
			});
			expect(toggle).toHaveAttribute("aria-checked", "true");
		});

		it("defaults to off when localDistill is not yet loaded", () => {
			render(SettingsConnectionsTab, baseProps({ localDistill: false }));

			const section = screen.getByTestId("connections-locality");
			const toggle = within(section).getByRole("switch", {
				name: "Keep connector data on this device",
			});
			expect(toggle).toHaveAttribute("aria-checked", "false");
		});

		it("calls onToggleLocalDistill with the new value when toggled", async () => {
			const onToggleLocalDistill = vi.fn();
			render(
				SettingsConnectionsTab,
				baseProps({ localDistill: false, onToggleLocalDistill }),
			);

			const section = screen.getByTestId("connections-locality");
			const toggle = within(section).getByRole("switch", {
				name: "Keep connector data on this device",
			});
			await fireEvent.click(toggle);

			expect(onToggleLocalDistill).toHaveBeenCalledWith(true);
		});

		it("disables the toggle while the locality preference is loading", () => {
			render(SettingsConnectionsTab, baseProps({ localityLoading: true }));

			const section = screen.getByTestId("connections-locality");
			const toggle = within(section).getByRole("switch", {
				name: "Keep connector data on this device",
			});
			expect(toggle).toBeDisabled();
		});

		it("shows help text and the fidelity note", () => {
			render(SettingsConnectionsTab, baseProps());

			const section = screen.getByTestId("connections-locality");
			expect(
				within(section).getByText(
					"Local summarization aims to preserve the details relevant to your question, though some nuance can be lost compared to sending the raw data.",
				),
			).toBeInTheDocument();
		});
	});
});
