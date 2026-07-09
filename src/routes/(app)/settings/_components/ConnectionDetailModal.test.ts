import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionPublic } from "$lib/client/api/connections";
import ConnectionDetailModal from "./ConnectionDetailModal.svelte";

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
		connection: makeConnection(),
		onClose: vi.fn(),
		onToggleCapability: vi.fn(),
		onToggleAllowWrites: vi.fn(),
		onToggleDefaultOn: vi.fn(),
		onUpdateWriteAllowlist: vi.fn(),
		onDisconnect: vi.fn(),
		...overrides,
	};
}

describe("ConnectionDetailModal", () => {
	it("renders nothing when connection is null", () => {
		render(ConnectionDetailModal, baseProps({ connection: null }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("renders a header with the provider, account, and status", () => {
		render(ConnectionDetailModal, baseProps());

		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Google")).toBeInTheDocument();
		expect(within(dialog).getByText("person@example.com")).toBeInTheDocument();
		expect(within(dialog).getByText("Connected")).toBeInTheDocument();
	});

	it("renders a Toggle per capability the provider supports", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({ capabilities: ["calendar"] }),
			}),
		);

		// Google's catalog entry supports calendar + contacts.
		expect(
			screen.getByRole("switch", { name: "Calendar — Google" }),
		).toHaveAttribute("aria-checked", "true");
		expect(
			screen.getByRole("switch", { name: "Contacts — Google" }),
		).toHaveAttribute("aria-checked", "false");
	});

	it("toggling a capability calls onToggleCapability with (id, capability, next)", async () => {
		const onToggleCapability = vi.fn();
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({ capabilities: ["calendar"] }),
				onToggleCapability,
			}),
		);

		await fireEvent.click(
			screen.getByRole("switch", { name: "Calendar — Google" }),
		);

		expect(onToggleCapability).toHaveBeenCalledWith(
			"conn-1",
			"calendar",
			false,
		);
	});

	it("toggling default-on calls onToggleDefaultOn with the new value", async () => {
		const onToggleDefaultOn = vi.fn();
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({ defaultOn: true }),
				onToggleDefaultOn,
			}),
		);

		await fireEvent.click(
			screen.getByRole("switch", { name: "Default on — Google" }),
		);

		expect(onToggleDefaultOn).toHaveBeenCalledWith("conn-1", false);
	});

	it("puts the allow-writes warning behind the shared InfoTooltip, not as always-visible prose", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					provider: "nextcloud",
					capabilities: ["files"],
				}),
			}),
		);

		// The warning text exists (as the tooltip trigger's accessible name /
		// content), but is not rendered as a plain always-visible paragraph.
		expect(
			screen.queryByText(/Writing is off by default/),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Writing is off by default/ }),
		).toBeInTheDocument();
	});

	it("hides the allow-writes toggle (and its tooltip) entirely for a read-only provider", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					id: "conn-plex",
					provider: "plex",
					capabilities: ["media"],
				}),
			}),
		);

		expect(
			screen.queryByRole("switch", { name: /Allow writes/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Writing is off by default/ }),
		).not.toBeInTheDocument();
	});

	it("toggling allow-writes calls onToggleAllowWrites with the new value", async () => {
		const onToggleAllowWrites = vi.fn();
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					provider: "nextcloud",
					capabilities: ["files"],
				}),
				onToggleAllowWrites,
			}),
		);

		await fireEvent.click(
			screen.getByRole("switch", { name: "Allow writes — Nextcloud" }),
		);

		expect(onToggleAllowWrites).toHaveBeenCalledWith("conn-1", true);
	});

	it("shows the write-allowlist editor only for nextcloud (path-based writes) with allowWrites on", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					id: "conn-nc",
					provider: "nextcloud",
					capabilities: ["files"],
					allowWrites: true,
					writeAllowlist: ["/AlfyAI"],
				}),
			}),
		);

		expect(screen.getByText("Allowed folders")).toBeInTheDocument();
		expect(screen.getByText("/AlfyAI")).toBeInTheDocument();
	});

	it("does not show the write-allowlist editor for a non-path writable provider, showing a confirm note instead", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({ provider: "google", allowWrites: true }),
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
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					id: "conn-nc",
					provider: "nextcloud",
					capabilities: ["files"],
					allowWrites: true,
					writeAllowlist: ["/AlfyAI"],
				}),
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
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					id: "conn-nc",
					provider: "nextcloud",
					capabilities: ["files"],
					allowWrites: true,
					writeAllowlist: ["/AlfyAI", "/Documents"],
				}),
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
		render(ConnectionDetailModal, baseProps({ onDisconnect }));

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

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		render(ConnectionDetailModal, baseProps({ onClose }));

		await fireEvent.keyDown(window, { key: "Escape" });

		expect(onClose).toHaveBeenCalled();
	});
});
