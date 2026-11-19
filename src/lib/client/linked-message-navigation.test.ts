import { describe, expect, it, vi } from "vitest";
import { loadLinkedMessage } from "./linked-message-navigation";

describe("authorized linked message windows", () => {
	it("loads every older window until the exact source is available", async () => {
		let ids = ["new"];
		const load = vi.fn(async () => {
			ids =
				load.mock.calls.length === 1 ? ["middle", ...ids] : ["target", ...ids];
		});
		expect(
			await loadLinkedMessage({
				targetId: "target",
				isCurrent: () => true,
				messageIds: () => ids,
				hasMore: () => true,
				loadOlder: load,
			}),
		).toBe("found");
		expect(load).toHaveBeenCalledTimes(2);
	});
	it("never scrolls or continues loading for a departed chat", async () => {
		let current = true;
		const load = vi.fn(async () => {
			current = false;
		});
		expect(
			await loadLinkedMessage({
				targetId: "target",
				isCurrent: () => current,
				messageIds: () => ["new"],
				hasMore: () => true,
				loadOlder: load,
			}),
		).toBe("cancelled");
		expect(load).toHaveBeenCalledTimes(1);
	});
	it("reports a non-advancing unexhausted window as retryable", async () => {
		expect(
			await loadLinkedMessage({
				targetId: "gone",
				isCurrent: () => true,
				messageIds: () => ["new"],
				hasMore: () => true,
				loadOlder: async () => {},
			}),
		).toBe("retryable");
	});
});

it("retries a transport failure without interpreting it as deleted source", async () => {
	let ids = ["new"];
	const read = vi
		.fn()
		.mockRejectedValueOnce(new Error("offline"))
		.mockImplementationOnce(async () => {
			ids = ["target", ...ids];
		});
	const options = {
		targetId: "target",
		isCurrent: () => true,
		messageIds: () => ids,
		hasMore: () => true,
		loadOlder: read,
	};
	expect(await loadLinkedMessage(options)).toBe("retryable");
	expect(await loadLinkedMessage(options)).toBe("found");
});
