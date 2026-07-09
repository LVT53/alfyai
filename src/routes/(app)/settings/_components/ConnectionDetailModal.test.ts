import { fireEvent, render, screen, within } from "@testing-library/svelte";
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
	beforeEach(() => {
		mockFetchNextcloudFolders.mockReset();
		mockFetchNextcloudFolders.mockResolvedValue([]);
	});

	it("renders nothing when connection is null", () => {
		render(ConnectionDetailModal, baseProps({ connection: null }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("renders a header with the provider, account, and status", () => {
		render(ConnectionDetailModal, baseProps());

		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Google")).toBeInTheDocument();
		expect(within(dialog).getByText("person@example.com")).toBeInTheDocument();
		// R3-fix #4 — "Connected" is a quiet accessible icon, not a text pill.
		expect(
			within(dialog).getByRole("img", { name: "Connected" }),
		).toBeInTheDocument();
		expect(dialog.querySelector(".status-chip")).toBeNull();
	});

	it.each([
		"needs_reauth",
		"error",
		"disconnected",
	] as const)("still renders a visible status pill for %s", (status) => {
		render(
			ConnectionDetailModal,
			baseProps({ connection: makeConnection({ status }) }),
		);

		const dialog = screen.getByRole("dialog");
		expect(dialog.querySelector(".status-chip")).not.toBeNull();
		expect(
			within(dialog).queryByRole("img", { name: "Connected" }),
		).not.toBeInTheDocument();
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
		await fireEvent.click(screen.getByRole("button", { name: "Add folder" }));

		expect(onUpdateWriteAllowlist).toHaveBeenCalledWith("conn-nc", [
			"/AlfyAI",
			"/Documents",
		]);
	});

	// R3-fix #7 — the add-folder control is an icon-only Plus button (no
	// visible "Add" text), with an accessible label instead.
	it("renders the add-folder control as an icon-only Plus button", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					id: "conn-nc",
					provider: "nextcloud",
					capabilities: ["files"],
					allowWrites: true,
					writeAllowlist: [],
				}),
			}),
		);

		const addBtn = screen.getByRole("button", { name: "Add folder" });
		expect(addBtn).not.toHaveTextContent("Add");
		expect(addBtn.querySelector("svg")).not.toBeNull();
	});

	// Redesign R9 — folder suggestions.
	it("fetches folder suggestions for a nextcloud connection with writes on, and offers them on focus", async () => {
		mockFetchNextcloudFolders.mockResolvedValue([
			{ path: "/Documents", name: "Documents" },
			{ path: "/Photos", name: "Photos" },
		]);
		const onUpdateWriteAllowlist = vi.fn();
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					id: "conn-nc",
					provider: "nextcloud",
					capabilities: ["files"],
					allowWrites: true,
					writeAllowlist: [],
				}),
				onUpdateWriteAllowlist,
			}),
		);

		expect(mockFetchNextcloudFolders).toHaveBeenCalledWith("conn-nc");

		const input = screen.getByPlaceholderText("/folder/path");
		await fireEvent.focus(input);

		const option = await screen.findByRole("option", { name: "/Documents" });
		expect(screen.getByRole("option", { name: "/Photos" })).toBeInTheDocument();

		await fireEvent.click(option);

		expect(onUpdateWriteAllowlist).toHaveBeenCalledWith("conn-nc", [
			"/Documents",
		]);
	});

	it("falls back to plain manual entry when the folder fetch fails (never blocks adding a path)", async () => {
		mockFetchNextcloudFolders.mockRejectedValue(new Error("offline"));
		const onUpdateWriteAllowlist = vi.fn();
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					id: "conn-nc",
					provider: "nextcloud",
					capabilities: ["files"],
					allowWrites: true,
					writeAllowlist: [],
				}),
				onUpdateWriteAllowlist,
			}),
		);

		const input = screen.getByPlaceholderText("/folder/path");
		await fireEvent.focus(input);

		// Give the rejected fetch a turn to settle before asserting nothing
		// crashed and no dropdown ever appeared.
		await Promise.resolve();
		await Promise.resolve();

		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

		await fireEvent.input(input, { target: { value: "/Manual" } });
		await fireEvent.click(screen.getByRole("button", { name: "Add folder" }));

		expect(onUpdateWriteAllowlist).toHaveBeenCalledWith("conn-nc", ["/Manual"]);
	});

	it("does not fetch folder suggestions for a non-nextcloud provider", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({ provider: "google", allowWrites: true }),
			}),
		);

		expect(mockFetchNextcloudFolders).not.toHaveBeenCalled();
	});

	it("does not fetch folder suggestions while allow-writes is off", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					provider: "nextcloud",
					capabilities: ["files"],
					allowWrites: false,
				}),
			}),
		);

		expect(mockFetchNextcloudFolders).not.toHaveBeenCalled();
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

	// R3-fix #5 — disconnect is an icon-only button in the header row (logo ·
	// account · status · disconnect), not a bottom text button with visible
	// "Disconnect" text and a `.connection-detail-footer` wrapper.
	it("renders disconnect as an icon-only button inside the header row, not a bottom text button", () => {
		render(ConnectionDetailModal, baseProps());

		const dialog = screen.getByRole("dialog");
		const header = dialog.querySelector(
			".connection-detail-header",
		) as HTMLElement;
		const disconnectBtn = within(header).getByRole("button", {
			name: "Disconnect Google",
		});

		expect(disconnectBtn).not.toHaveTextContent("Disconnect");
		expect(disconnectBtn.querySelector("svg")).not.toBeNull();
		expect(dialog.querySelector(".connection-detail-footer")).toBeNull();
	});

	// R3-fix #8 — the detail modal is the standard centered, content-sized
	// DialogShell (no `fullScreen`), matching every other settings dialog.
	it("renders as a centered, content-sized dialog (not fullScreen)", () => {
		render(ConnectionDetailModal, baseProps());

		const dialog = screen.getByRole("dialog");
		expect(dialog.className).not.toContain("h-full");
		expect(dialog.className).not.toContain("max-w-full");
		expect(dialog.className).toContain("max-w-[480px]");
		expect(dialog.getAttribute("style")).toContain("max-height: 85dvh");
	});

	// R3-fix #6 — the InfoTooltip trigger sits next to the default-on /
	// allow-writes labels in a flex row (`.connection-toggle-text`, which is
	// `align-items: center`), and the label itself drops the global
	// `.settings-label` bottom margin (meant for labels stacked ABOVE an
	// input, which otherwise shifts the label off-center relative to the
	// icon) via the `.connection-toggle-label` modifier class.
	it("vertically centers the InfoTooltip icon with its label", () => {
		render(
			ConnectionDetailModal,
			baseProps({
				connection: makeConnection({
					provider: "nextcloud",
					capabilities: ["files"],
				}),
			}),
		);

		const dialog = screen.getByRole("dialog");
		const rows = dialog.querySelectorAll(".connection-toggle-text");
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(
				row.querySelector("[aria-describedby], .info-tooltip-trigger"),
			).not.toBeNull();
			const label = row.querySelector(".settings-label") as HTMLElement;
			expect(label).not.toBeNull();
			expect(label.className).toContain("connection-toggle-label");
		}
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		render(ConnectionDetailModal, baseProps({ onClose }));

		await fireEvent.keyDown(window, { key: "Escape" });

		expect(onClose).toHaveBeenCalled();
	});
});
