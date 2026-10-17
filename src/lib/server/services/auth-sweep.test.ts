import { afterEach, describe, expect, it, vi } from "vitest";

const { mockSweepExpiredSessions, mockSweepTwoStep } = vi.hoisted(() => ({
	mockSweepExpiredSessions: vi.fn(async () => 0),
	mockSweepTwoStep: vi.fn(async () => ({ challenges: 0, unconfirmed: 0 })),
}));

vi.mock("./auth", () => ({
	sweepExpiredSessions: mockSweepExpiredSessions,
}));

vi.mock("./two-step", () => ({
	sweepTwoStep: mockSweepTwoStep,
}));

import { runAuthSweep } from "./auth-sweep";

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe("the auth sweep", () => {
	it("runs both sweeps once, as of the given moment", async () => {
		const now = new Date("2026-10-16T10:00:00.000Z");

		await runAuthSweep(now);

		expect(mockSweepExpiredSessions).toHaveBeenCalledOnce();
		expect(mockSweepExpiredSessions).toHaveBeenCalledWith(now);
		expect(mockSweepTwoStep).toHaveBeenCalledOnce();
		expect(mockSweepTwoStep).toHaveBeenCalledWith(now);
	});

	it("catches a failure and logs a content-free [AUTH] line, never throwing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		mockSweepExpiredSessions.mockRejectedValueOnce(
			new Error("database is locked"),
		);
		mockSweepTwoStep.mockRejectedValueOnce(new Error("database is locked"));

		await expect(runAuthSweep(new Date())).resolves.toBeUndefined();

		expect(error).toHaveBeenCalled();
		const logged = JSON.stringify(error.mock.calls);
		expect(logged).toContain("[AUTH]");
		// Content-free: no user id, email, code or secret in the line.
		expect(logged).not.toMatch(/@|secret|code/i);
	});
});
