import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TwoStepStatus } from "$lib/client/api/settings";

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
