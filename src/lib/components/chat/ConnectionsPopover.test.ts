import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { ActiveCapabilitiesConnection } from "$lib/client/api/connections";
import ConnectionsPopover from "./ConnectionsPopover.svelte";

function conn(
	overrides: Partial<ActiveCapabilitiesConnection> = {},
): ActiveCapabilitiesConnection {
	return {
		id: "nc",
		label: "Nextcloud",
		provider: "nextcloud",
		accountIdentifier: "cloud.example.com",
		status: "connected",
		defaultOn: true,
		capabilities: ["files", "contacts"],
		...overrides,
	};
}

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		connections: [conn()],
		flippedIds: new Set<string>(),
		masterOn: true,
		onToggleMaster: vi.fn(),
		onToggleAccount: vi.fn(),
		onManage: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
}

describe("ConnectionsPopover", () => {
	it("says how many accounts are ready, out of how many there are", () => {
		render(
			ConnectionsPopover,
			baseProps({
				connections: [
					conn({ id: "nc" }),
					conn({ id: "mail", provider: "imap", capabilities: ["email"] }),
					conn({
						id: "gh",
						provider: "github",
						status: "needs_reauth",
						capabilities: [],
					}),
				],
			}),
		);
		expect(screen.getByText("2 of 3 accounts are ready")).toBeInTheDocument();
	});

	// The whole point: one account can be left out of one conversation without
	// disconnecting it.
	it("offers a switch per ready account and reports which one was flipped", async () => {
		const onToggleAccount = vi.fn();
		render(
			ConnectionsPopover,
			baseProps({
				onToggleAccount,
				connections: [
					conn({ id: "nc" }),
					conn({
						id: "mail",
						provider: "imap",
						label: "Email",
						capabilities: ["email"],
					}),
				],
			}),
		);
		const row = screen.getByTestId("connections-popover-account-mail");
		expect(within(row).getByText("Email")).toBeInTheDocument();
		await fireEvent.click(within(row).getByRole("switch"));
		expect(onToggleAccount).toHaveBeenCalledWith("mail");
	});

	it("shows an account switched off for this conversation as off", () => {
		render(
			ConnectionsPopover,
			baseProps({ flippedIds: new Set(["nc"]), masterOn: false }),
		);
		const row = screen.getByTestId("connections-popover-account-nc");
		expect(within(row).getByRole("switch")).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	// The settings dialog promises that an account with "Use it without
	// asking" off is only used "when you turn connections on for that
	// message" — so it must open here already off, not on.
	it("shows an ask-first account as off before anything is touched", () => {
		render(
			ConnectionsPopover,
			baseProps({
				connections: [conn({ id: "mail", provider: "imap", defaultOn: false })],
			}),
		);
		const row = screen.getByTestId("connections-popover-account-mail");
		expect(within(row).getByRole("switch")).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	it("lists what each account brings", () => {
		render(ConnectionsPopover, baseProps());
		const row = screen.getByTestId("connections-popover-account-nc");
		expect(within(row).getByText(/Files, Contacts/)).toBeInTheDocument();
	});

	// A broken account is named rather than silently missing, with the way to
	// fix it.
	it("names an account that needs attention and offers a way to it", async () => {
		const onManage = vi.fn();
		render(
			ConnectionsPopover,
			baseProps({
				onManage,
				connections: [
					conn({ id: "nc" }),
					conn({
						id: "gh",
						provider: "github",
						label: "GitHub",
						status: "needs_reauth",
						capabilities: [],
					}),
				],
			}),
		);
		expect(screen.getByText("GitHub needs attention")).toBeInTheDocument();
		await fireEvent.click(screen.getByText("Manage"));
		expect(onManage).toHaveBeenCalled();
	});

	it("does not list a broken account among the switchable ones", () => {
		render(
			ConnectionsPopover,
			baseProps({
				connections: [
					conn({
						id: "gh",
						provider: "github",
						status: "error",
						capabilities: [],
					}),
				],
			}),
		);
		expect(
			screen.queryByTestId("connections-popover-account-gh"),
		).not.toBeInTheDocument();
	});

	it("flips everything at once from the master switch", async () => {
		const onToggleMaster = vi.fn();
		render(ConnectionsPopover, baseProps({ onToggleMaster }));
		await fireEvent.click(
			screen.getByRole("switch", { name: "Use my connections" }),
		);
		expect(onToggleMaster).toHaveBeenCalled();
	});

	// An empty list means the server didn't send one — the master switch is
	// then the all-or-nothing control it has always been, and locking it would
	// take away the user's only choice.
	it("keeps the master switch usable when there is no per-account list", () => {
		render(ConnectionsPopover, baseProps({ connections: [] }));
		expect(
			screen.getByRole("switch", { name: "Use my connections" }),
		).not.toBeDisabled();
	});

	it("locks the master switch when there are accounts but none can serve anything", () => {
		render(
			ConnectionsPopover,
			baseProps({
				masterOn: false,
				connections: [
					conn({
						id: "gh",
						provider: "github",
						status: "error",
						capabilities: [],
					}),
				],
			}),
		);
		expect(
			screen.getByRole("switch", { name: "Use my connections" }),
		).toBeDisabled();
	});

	it("closes on Escape", async () => {
		const onClose = vi.fn();
		render(ConnectionsPopover, baseProps({ onClose }));
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalled();
	});
});
