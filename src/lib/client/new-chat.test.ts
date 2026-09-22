import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentConversationId, landingResetRequested } from "$lib/stores/ui";
import { consumePreviousConversationId } from "./conversation-session";
import { startNewChat } from "./new-chat";

describe("startNewChat", () => {
	beforeEach(() => {
		currentConversationId.set(null);
		landingResetRequested.set(false);
		consumePreviousConversationId();
	});

	it("stashes the outgoing conversation so the landing can find its way back", async () => {
		currentConversationId.set("conv-1");

		await startNewChat(async () => {});

		expect(consumePreviousConversationId()).toBe("conv-1");
		expect(get(currentConversationId)).toBeNull();
	});

	// The 2026-09-22 bug. Every New chat button ends in `goto("/")`, and from
	// the landing page that navigates to the page it is already on: nothing
	// remounts, so the landing's own reset never runs and an armed-but-unsent
	// incognito landing stayed armed for good. Navigation alone is not the
	// job; the signal is what the landing drains in either case.
	it("raises the landing reset signal, not only the navigation", async () => {
		const navigate = vi.fn(async () => {});

		await startNewChat(navigate);

		expect(get(landingResetRequested)).toBe(true);
		expect(navigate).toHaveBeenCalledWith("/");
	});

	it("raises the signal before navigating, so a landing already on screen sees it", async () => {
		const seenDuringNavigation: boolean[] = [];
		await startNewChat(async () => {
			seenDuringNavigation.push(get(landingResetRequested));
		});

		expect(seenDuringNavigation).toEqual([true]);
	});
});
