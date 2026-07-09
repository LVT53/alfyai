import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uiLanguage } from "$lib/stores/settings";
import ComposerToolsMenu from "./ComposerToolsMenu.svelte";

describe("ComposerToolsMenu capability toggles (Issue 7.2)", () => {
	beforeEach(() => {
		uiLanguage.set("en");
	});

	it("renders no capabilities section when none are available", () => {
		render(ComposerToolsMenu, {
			props: {
				availableCapabilities: [],
				activeCapabilities: new Set<string>(),
				capabilityAccounts: {},
			},
		});

		expect(
			screen.queryByRole("menuitemcheckbox", { name: "Calendar" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("menuitemcheckbox", { name: "Files" }),
		).not.toBeInTheDocument();
	});

	it("renders a toggle per available capability, checked state reflecting the initial (defaultOn) active set", () => {
		render(ComposerToolsMenu, {
			props: {
				availableCapabilities: ["calendar", "files"],
				activeCapabilities: new Set(["files"]),
				capabilityAccounts: {},
			},
		});

		const calendarToggle = screen.getByRole("menuitemcheckbox", {
			name: "Calendar",
		});
		const filesToggle = screen.getByRole("menuitemcheckbox", {
			name: "Files",
		});

		expect(calendarToggle).toHaveAttribute("aria-checked", "false");
		expect(filesToggle).toHaveAttribute("aria-checked", "true");
	});

	it("calls onToggleCapability with the capability id and the next state when clicked", async () => {
		const onToggleCapability = vi.fn();
		render(ComposerToolsMenu, {
			props: {
				availableCapabilities: ["calendar"],
				activeCapabilities: new Set<string>(),
				capabilityAccounts: {},
				onToggleCapability,
			},
		});

		await fireEvent.click(
			screen.getByRole("menuitemcheckbox", { name: "Calendar" }),
		);

		expect(onToggleCapability).toHaveBeenCalledWith("calendar", true);
	});

	it("calls onToggleCapability to turn an active capability off", async () => {
		const onToggleCapability = vi.fn();
		render(ComposerToolsMenu, {
			props: {
				availableCapabilities: ["calendar"],
				activeCapabilities: new Set(["calendar"]),
				capabilityAccounts: {},
				onToggleCapability,
			},
		});

		await fireEvent.click(
			screen.getByRole("menuitemcheckbox", { name: "Calendar" }),
		);

		expect(onToggleCapability).toHaveBeenCalledWith("calendar", false);
	});

	it("shows a multi-account sub-label when more than one connection serves a capability", () => {
		render(ComposerToolsMenu, {
			props: {
				availableCapabilities: ["calendar"],
				activeCapabilities: new Set<string>(),
				capabilityAccounts: {
					calendar: [
						{ id: "conn-work", label: "work@gmail.com", provider: "google" },
						{
							id: "conn-personal",
							label: "personal@gmail.com",
							provider: "google",
						},
					],
				},
			},
		});

		expect(
			screen.getByText("2 accounts: work@gmail.com, personal@gmail.com"),
		).toBeInTheDocument();
	});

	it("does not show a sub-label when only one connection serves a capability", () => {
		render(ComposerToolsMenu, {
			props: {
				availableCapabilities: ["calendar"],
				activeCapabilities: new Set<string>(),
				capabilityAccounts: {
					calendar: [
						{ id: "conn-work", label: "work@gmail.com", provider: "google" },
					],
				},
			},
		});

		expect(screen.queryByText(/accounts:/)).not.toBeInTheDocument();
	});
});
