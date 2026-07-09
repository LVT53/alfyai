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
	it("renders a connection's status chip and account identifier", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-1" })],
			}),
		);

		// Scoped to the connection card: the provider's display name and
		// "Connected" also appear in the persistent Add-a-connection section
		// below (as the Connect button label / already-connected hint).
		const card = screen.getByTestId("connection-card-conn-1");
		expect(within(card).getByText("Google")).toBeInTheDocument();
		expect(within(card).getByText("person@example.com")).toBeInTheDocument();
		expect(within(card).getByText("Connected")).toBeInTheDocument();
	});

	it("shows a Reconnect button and status detail for needs_reauth connections", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [
					makeConnection({
						status: "needs_reauth",
						statusDetail: "Token expired",
					}),
				],
			}),
		);

		expect(screen.getByText("Needs reauthorization")).toBeInTheDocument();
		expect(screen.getByText("Token expired")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Reconnect Google" }),
		).toBeInTheDocument();
	});

	it("calling the Reconnect button invokes onReconnect with the connection id", async () => {
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
	});

	it("toggling a capability calls onToggleCapability with (id, capability, next)", async () => {
		const onToggleCapability = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [
					makeConnection({ id: "conn-1", capabilities: ["calendar"] }),
				],
				onToggleCapability,
			}),
		);

		const calendarToggle = screen.getByRole("switch", {
			name: "Calendar — Google",
		});
		await fireEvent.click(calendarToggle);

		expect(onToggleCapability).toHaveBeenCalledWith(
			"conn-1",
			"calendar",
			false,
		);
	});

	it("shows the allow-writes warning copy when allowWrites is on", () => {
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

		expect(screen.getByText(/Writing is off by default/)).toBeInTheDocument();
	});

	it("hides the allow-writes toggle entirely for a read-only provider (plex)", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [
					makeConnection({
						id: "conn-plex",
						provider: "plex",
						capabilities: ["media"],
					}),
				],
			}),
		);

		expect(
			screen.queryByRole("switch", { name: /Allow writes/ }),
		).not.toBeInTheDocument();
	});

	it("shows the write-allowlist editor only for nextcloud (path-based writes) with allowWrites on", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [
					makeConnection({
						id: "conn-nc",
						provider: "nextcloud",
						capabilities: ["files"],
						allowWrites: true,
						writeAllowlist: ["/AlfyAI"],
					}),
				],
			}),
		);

		expect(screen.getByText("Allowed folders")).toBeInTheDocument();
		expect(screen.getByText("/AlfyAI")).toBeInTheDocument();
	});

	it("does not show the write-allowlist editor for a non-path writable provider (google), showing a confirm note instead", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [
					makeConnection({
						id: "conn-google",
						provider: "google",
						allowWrites: true,
					}),
				],
			}),
		);

		expect(screen.queryByText("Allowed folders")).not.toBeInTheDocument();
		expect(
			screen.getByText(/confirmed individually before they happen/),
		).toBeInTheDocument();
	});

	it("adding a write-allowlist entry calls onUpdateWriteAllowlist with the appended path", async () => {
		const onUpdateWriteAllowlist = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [
					makeConnection({
						id: "conn-nc",
						provider: "nextcloud",
						capabilities: ["files"],
						allowWrites: true,
						writeAllowlist: ["/AlfyAI"],
					}),
				],
				onUpdateWriteAllowlist,
			}),
		);

		const input = screen.getByPlaceholderText("/folder/path");
		await fireEvent.input(input, { target: { value: "/Documents" } });
		await fireEvent.click(screen.getByRole("button", { name: "Add" }));

		expect(onUpdateWriteAllowlist).toHaveBeenCalledWith("conn-nc", [
			"/AlfyAI",
			"/Documents",
		]);
	});

	it("removing a write-allowlist chip calls onUpdateWriteAllowlist without that path", async () => {
		const onUpdateWriteAllowlist = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [
					makeConnection({
						id: "conn-nc",
						provider: "nextcloud",
						capabilities: ["files"],
						allowWrites: true,
						writeAllowlist: ["/AlfyAI", "/Documents"],
					}),
				],
				onUpdateWriteAllowlist,
			}),
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "Remove /Documents" }),
		);

		expect(onUpdateWriteAllowlist).toHaveBeenCalledWith("conn-nc", ["/AlfyAI"]);
	});

	it("disconnect opens a confirm dialog, then calls onDisconnect on confirm", async () => {
		const onDisconnect = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-1" })],
				onDisconnect,
			}),
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "Disconnect Google" }),
		);

		expect(
			screen.getByRole("heading", { name: "Disconnect Google?" }),
		).toBeInTheDocument();
		expect(onDisconnect).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByTestId("confirm-delete"));

		expect(onDisconnect).toHaveBeenCalledWith("conn-1");
	});

	it("renders the empty state message plus an Add-a-connection section listing every connectable provider", () => {
		const onStartConnect = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [],
				onStartConnect,
			}),
		);

		expect(screen.getByTestId("connections-empty")).toBeInTheDocument();
		expect(screen.getByText("No connections yet.")).toBeInTheDocument();

		const addSection = screen.getByTestId("connections-add");
		expect(addSection).toBeInTheDocument();
		expect(
			within(addSection).getByText("Add a connection"),
		).toBeInTheDocument();
		for (const provider of CONNECTABLE_PROVIDER_LIST) {
			const displayName = getProviderCatalogEntry(provider).displayName;
			expect(
				within(addSection).getByRole("button", {
					name: `Connect ${displayName}`,
				}),
			).toBeInTheDocument();
		}
	});

	it("excludes resolver-only providers (contacts) from the Add-a-connection list", () => {
		render(SettingsConnectionsTab, baseProps({ connections: [] }));

		const addSection = screen.getByTestId("connections-add");
		expect(
			within(addSection).queryByRole("button", {
				name: "Connect Contacts (CardDAV)",
			}),
		).not.toBeInTheDocument();
	});

	it("clicking a provider's Connect button in the Add-a-connection section calls onStartConnect(provider)", async () => {
		const onStartConnect = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [],
				onStartConnect,
			}),
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "Connect Nextcloud" }),
		);

		expect(onStartConnect).toHaveBeenCalledWith("nextcloud");
	});

	it("keeps the Add-a-connection section visible when connections already exist, and hints at already-connected providers", async () => {
		const onStartConnect = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection({ id: "conn-1", provider: "google" })],
				onStartConnect,
			}),
		);

		expect(screen.queryByTestId("connections-empty")).not.toBeInTheDocument();
		const addSection = screen.getByTestId("connections-add");
		expect(addSection).toBeInTheDocument();

		// Adding another account of an already-connected provider stays allowed —
		// the button remains present and clickable, just with a hint.
		const googleConnectBtn = within(addSection).getByRole("button", {
			name: "Connect Google",
		});
		expect(googleConnectBtn).toBeInTheDocument();
		expect(within(googleConnectBtn).getByText("Connected")).toBeInTheDocument();

		await fireEvent.click(googleConnectBtn);
		expect(onStartConnect).toHaveBeenCalledWith("google");

		// A provider with no existing connection shows no hint.
		const nextcloudConnectBtn = within(addSection).getByRole("button", {
			name: "Connect Nextcloud",
		});
		expect(
			within(nextcloudConnectBtn).queryByText("Connected"),
		).not.toBeInTheDocument();
	});

	it("shows a loading indicator instead of the empty state / Add section while loading", () => {
		render(
			SettingsConnectionsTab,
			baseProps({ connections: [], loading: true }),
		);

		expect(screen.queryByTestId("connections-empty")).not.toBeInTheDocument();
		expect(screen.queryByTestId("connections-add")).not.toBeInTheDocument();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
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
