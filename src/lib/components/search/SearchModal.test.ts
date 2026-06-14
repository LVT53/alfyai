import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { conversations } from "$lib/stores/conversations";
import { projects } from "$lib/stores/projects";
import { currentConversationId, sidebarOpen } from "$lib/stores/ui";
import SearchModal from "./SearchModal.svelte";

vi.mock("svelte/transition", () => ({
	fade: () => ({
		delay: 0,
		duration: 0,
		css: () => "",
	}),
}));

vi.mock("$app/environment", () => ({
	browser: true,
}));

vi.mock("$app/navigation", () => ({
	goto: vi.fn(),
}));

describe("SearchModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: vi.fn().mockImplementation(() => ({
				matches: false,
				media: "",
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			})),
		});

		conversations.set([
			{
				id: "conv-1",
				title: "Release notes",
				projectId: "project-1",
				updatedAt: Date.now(),
			},
		]);
		projects.set([
			{
				id: "project-1",
				name: "Launch",
				sortOrder: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);
		currentConversationId.set("conv-1");
		sidebarOpen.set(true);
	});

	it("shows conversation search results and routes on selection", async () => {
		const onClose = vi.fn();

		render(SearchModal, {
			props: {
				isOpen: true,
				onClose,
			},
		});

		await waitFor(() => {
			expect(screen.getByText("Release notes")).toBeInTheDocument();
		});

		const conversationResult = screen
			.getByText("Release notes")
			.closest("button");
		expect(conversationResult).not.toBeNull();
		if (!conversationResult)
			throw new Error("Expected conversation result button");

		await fireEvent.click(conversationResult);

		expect(goto).toHaveBeenCalledWith("/chat/conv-1");
		expect(onClose).toHaveBeenCalled();
	});
});
