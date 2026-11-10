import { beforeEach, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({
	admitTurn: vi.fn(),
	recordTurnAttempt: vi.fn(),
	settleTurn: vi.fn(),
	observeAbandonedTurn: vi.fn(),
}));
vi.mock("./turn-ledger", () => ledger);

import { beginCompletionLifetime } from "./completion-lifetime";

const input = { userId: "u", conversationId: "c", requestId: "request" };
beforeEach(() => {
	vi.clearAllMocks();
	ledger.admitTurn.mockReturnValue({ status: "admitted" });
	ledger.recordTurnAttempt.mockResolvedValue(undefined);
});
it("does not grant work to an existing or failed admission", () => {
	ledger.admitTurn.mockReturnValue({
		status: "existing",
		turn: { outcome: "answered" },
	});
	expect(() => beginCompletionLifetime(input)).toThrow(/existing/i);
	ledger.admitTurn.mockImplementation(() => {
		throw new Error("storage down");
	});
	expect(() => beginCompletionLifetime(input)).toThrow("storage down");
});
it("awaits durable registration before the attempt adapter grants dispatch", async () => {
	const lifetime = beginCompletionLifetime(input);
	let release!: () => void;
	ledger.recordTurnAttempt.mockReturnValue(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	let granted = false;
	const pending = lifetime
		.register({
			attemptId: "a",
			phase: "working",
			providerId: "p",
			modelId: "m",
			providerModelName: "configured",
		})
		.then(() => {
			granted = true;
		});
	await Promise.resolve();
	expect(granted).toBe(false);
	release();
	await pending;
	expect(granted).toBe(true);
	await lifetime.finish();
});
it("seals all registered calls even when usage never arrives", async () => {
	const lifetime = beginCompletionLifetime(input);
	await lifetime.register({
		attemptId: "a",
		phase: "closing",
		providerId: "p",
		modelId: "m",
		providerModelName: "configured",
	});
	await lifetime.finish();
	expect(ledger.settleTurn).toHaveBeenCalledWith(
		lifetime.scope,
		expect.objectContaining({
			attemptIds: ["a"],
			outcome: "incomplete",
			stopCause: "uncertain_execution",
		}),
	);
});
it("incognito never writes attempts or terminal accounting", async () => {
	ledger.admitTurn.mockReturnValue({ status: "untracked" });
	const lifetime = beginCompletionLifetime(input);
	await lifetime.register({
		attemptId: "a",
		phase: "working",
		providerId: "p",
		modelId: "m",
		providerModelName: "configured",
	});
	await lifetime.finish();
	expect(ledger.recordTurnAttempt).not.toHaveBeenCalled();
	expect(ledger.settleTurn).not.toHaveBeenCalled();
});
it("cancels dispatch after an attempt storage failure and never seals fake success", async () => {
	const lifetime = beginCompletionLifetime(input);
	const error = new Error("Synthetic attempt storage failure");
	ledger.recordTurnAttempt.mockRejectedValueOnce(error);
	await expect(
		lifetime.register({
			attemptId: "a",
			phase: "working",
			providerId: "p",
			modelId: "m",
			providerModelName: "configured",
		}),
	).rejects.toBe(error);
	expect(lifetime.signal?.aborted).toBe(true);
	await expect(lifetime.finish()).rejects.toBe(error);
	expect(ledger.settleTurn).not.toHaveBeenCalled();
});
