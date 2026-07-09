import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "$lib/client/api/connections";
import {
	getProviderCatalogEntry,
	PROVIDER_LIST,
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
		...overrides,
	};
}

describe("SettingsConnectionsTab", () => {
	it("renders a connection's status chip and account identifier", () => {
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [makeConnection()],
			}),
		);

		expect(screen.getByText("Google")).toBeInTheDocument();
		expect(screen.getByText("person@example.com")).toBeInTheDocument();
		expect(screen.getByText("Connected")).toBeInTheDocument();
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

	it("renders the empty state listing every connectable provider with a Connect button", () => {
		const onStartConnect = vi.fn();
		render(
			SettingsConnectionsTab,
			baseProps({
				connections: [],
				onStartConnect,
			}),
		);

		const emptySection = screen.getByTestId("connections-empty");
		expect(emptySection).toBeInTheDocument();
		for (const provider of PROVIDER_LIST) {
			const displayName = getProviderCatalogEntry(provider).displayName;
			expect(
				within(emptySection).getByRole("button", {
					name: `Connect ${displayName}`,
				}),
			).toBeInTheDocument();
		}
	});

	it("clicking a provider's Connect button in the empty state calls onStartConnect(provider)", async () => {
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

	it("shows a loading indicator instead of the empty state while loading", () => {
		render(
			SettingsConnectionsTab,
			baseProps({ connections: [], loading: true }),
		);

		expect(screen.queryByTestId("connections-empty")).not.toBeInTheDocument();
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});
});
