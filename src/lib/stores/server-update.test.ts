import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import {
	pendingDraftSaves,
	reportServerUpdateSign,
	serverUpdateSign,
	setPendingDraftSaves,
	setTurnWaitingForUpdate,
	turnWaitingForUpdate,
} from "./server-update";

describe("server update store", () => {
	it("counts the signs of an update, which is what makes the shell watch", () => {
		const before = get(serverUpdateSign);

		reportServerUpdateSign();
		reportServerUpdateSign();

		expect(get(serverUpdateSign)).toBe(before + 2);
	});

	it("says whether a message waits for the update, so the shell can hold its notice", () => {
		setTurnWaitingForUpdate(true);
		expect(get(turnWaitingForUpdate)).toBe(true);

		setTurnWaitingForUpdate(false);
		expect(get(turnWaitingForUpdate)).toBe(false);
	});

	it("counts the chats whose words have not reached the server, so the shell can hold its notice for them too", () => {
		setPendingDraftSaves(2);
		expect(get(pendingDraftSaves)).toBe(2);

		setPendingDraftSaves(0);
		expect(get(pendingDraftSaves)).toBe(0);
	});
});
