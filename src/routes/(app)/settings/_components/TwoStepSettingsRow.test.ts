import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayoutForSpotlight } from "$lib/actions/spotlight.test-helpers";
import type { TwoStepStatus } from "$lib/client/api/settings";
import {
	pendingSpotlight,
	requestSpotlight,
	spotlightRequest,
} from "$lib/stores/spotlight";

const mockDisable = vi.hoisted(() => vi.fn());
const mockRegenerate = vi.hoisted(() => vi.fn());

vi.mock("$lib/client/api/settings", () => ({
	disableTwoStep: mockDisable,
	regenerateBackupCodes: mockRegenerate,
	setupTwoStep: vi.fn(),
	confirmTwoStepSetup: vi.fn(),
}));

import TwoStepSettingsRow from "./TwoStepSettingsRow.svelte";

const CODES = Array.from({ length: 10 }, (_, index) => `AAAA${index}-BBBBB`);

const OFF: TwoStepStatus = { enabled: false, since: null, backupCodesLeft: 0 };

function renderRow(status = OFF, overrides: Record<string, unknown> = {}) {
	return render(TwoStepSettingsRow, {
		props: {
			status,
			onChanged: vi.fn(),
			...overrides,
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDisable.mockResolvedValue({ wasOn: true });
	mockRegenerate.mockResolvedValue({ backupCodes: CODES });
});

describe("the Account card's two-step row", () => {
	it("shows Off and Turn on", () => {
		renderRow();

		expect(screen.getByText("Two-step sign-in")).toBeInTheDocument();
		expect(
			screen.getByText("Off. Ask for a code from your phone when you sign in."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Turn on" })).toBeInTheDocument();
	});

	it("shows On, the date and the codes left, with the two actions", () => {
		const since = Date.UTC(2026, 9, 15);
		renderRow({ enabled: true, since, backupCodesLeft: 8 });

		expect(screen.getByText("On")).toBeInTheDocument();
		expect(
			screen.getByText(/Since .*2026.*8 of 10 backup codes left\./),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "New backup codes" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Turn off" }),
		).toBeInTheDocument();
	});

	it("with two or fewer codes left the row suggests new ones", () => {
		renderRow({ enabled: true, since: Date.now(), backupCodesLeft: 2 });

		expect(
			screen.getByText("Only 2 backup codes left. Make new ones."),
		).toBeInTheDocument();
	});

	it("Turn off and New backup codes ask for a code", async () => {
		const onChanged = vi.fn();
		renderRow(
			{ enabled: true, since: Date.now(), backupCodesLeft: 8 },
			{
				onChanged,
			},
		);

		await fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
		expect(screen.getByText("Turn off two-step sign-in?")).toBeInTheDocument();

		await fireEvent.input(screen.getByLabelText("Code or backup code"), {
			target: { value: "123456" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() =>
			expect(mockDisable).toHaveBeenCalledWith({ code: "123456" }),
		);
		await waitFor(() =>
			expect(onChanged).toHaveBeenCalledWith({
				enabled: false,
				since: null,
				backupCodesLeft: 0,
			}),
		);
	});

	it("New backup codes asks for a code, then shows and acknowledges new ones", async () => {
		const onChanged = vi.fn();
		renderRow(
			{ enabled: true, since: Date.now(), backupCodesLeft: 8 },
			{
				onChanged,
			},
		);

		await fireEvent.click(
			screen.getByRole("button", { name: "New backup codes" }),
		);
		expect(screen.getByText("Make new backup codes?")).toBeInTheDocument();
		await fireEvent.input(screen.getByLabelText("Code or backup code"), {
			target: { value: "123456" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

		expect(
			await screen.findByText("Save your backup codes"),
		).toBeInTheDocument();
		expect(screen.getByText(CODES[0])).toBeInTheDocument();
		const done = screen.getByRole("button", { name: "Done" });
		expect(done).toBeDisabled();
		await fireEvent.click(
			screen.getByLabelText("I've saved them somewhere safe"),
		);
		await fireEvent.click(done);

		expect(onChanged).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: true, backupCodesLeft: 10 }),
		);
	});
});

// The Feature Guide's Show me for Two-step sign-in. The row is there whether
// two-step is on or off, so both states carry the marker.
describe("the two-step row — the guide's Show me", () => {
	let restoreLayout: () => void = () => undefined;

	const ON: TwoStepStatus = {
		enabled: true,
		since: Date.UTC(2026, 9, 15),
		backupCodesLeft: 8,
	};

	beforeEach(() => {
		// The ring waits one animation frame; the test steps it by hand.
		vi.useFakeTimers({
			toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
		});
		restoreLayout = stubLayoutForSpotlight();
		spotlightRequest.set(null);
	});

	afterEach(() => {
		restoreLayout();
		vi.useRealTimers();
		spotlightRequest.set(null);
	});

	it("rings the two-step row on request", () => {
		// The row is there whether two-step is off or on, so both carry it.
		for (const [state, status] of [
			["off", OFF],
			["on", ON],
		] as const) {
			requestSpotlight("settings.twoStep");

			const { unmount } = renderRow(status);

			expect(get(spotlightRequest), state).toBeNull();
			vi.advanceTimersToNextFrame();
			const row = screen.getByTestId("two-step-row");
			expect(row, state).toHaveClass("spotlight-ring");
			expect(vi.mocked(row.scrollIntoView).mock.contexts.at(-1), state).toBe(
				row,
			);
			unmount();
		}
	});

	it("keeps its ring when the row changes from off to on meanwhile", async () => {
		const { rerender } = renderRow(OFF);
		requestSpotlight("settings.twoStep");
		vi.advanceTimersToNextFrame();
		const row = screen.getByTestId("two-step-row");
		expect(row).toHaveClass("spotlight-ring");

		await rerender({ status: ON });

		expect(screen.getByTestId("two-step-row")).toBe(row);
		expect(row).toHaveClass("spotlight-ring");
	});

	it("leaves a request for another control waiting", () => {
		requestSpotlight("settings.data");

		renderRow();
		vi.advanceTimersToNextFrame();

		expect(screen.getByTestId("two-step-row")).not.toHaveClass(
			"spotlight-ring",
		);
		expect(pendingSpotlight(get(spotlightRequest))).toBe("settings.data");
	});

	// A ring that touches the words looks cramped, so the row's box is half a
	// rem wider than its words on each side, and the negative margin takes the
	// width back: the row lays out as it did before.
	it("keeps its layout while it gives the ring room", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"TwoStepSettingsRow.svelte",
			),
			"utf-8",
		);
		const rule = source.match(/\.two-step-row\s*\{([^}]*)\}/)?.[1];

		expect(rule).toMatch(/padding:\s*var\(--space-md\) 0\.5rem/);
		expect(rule).toMatch(/margin:\s*0 -0\.5rem/);
		expect(rule).toMatch(/border-radius:\s*var\(--radius-md\)/);
	});
});
