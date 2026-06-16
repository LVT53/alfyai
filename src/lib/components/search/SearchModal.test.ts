import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import { conversations } from "$lib/stores/conversations";
import { projects } from "$lib/stores/projects";
import { currentConversationId, sidebarOpen } from "$lib/stores/ui";
import SearchModal from "./SearchModal.svelte";

const { fetchWorkspaceSearch } = vi.hoisted(() => ({
	fetchWorkspaceSearch: vi.fn(),
}));

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

vi.mock("$lib/client/api/workspace-search", () => ({
	fetchWorkspaceSearch,
}));

describe("SearchModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fetchWorkspaceSearch.mockResolvedValue({
			mode: "default",
			query: "",
			conversations: [
				{
					id: "conv-1",
					title: "Release notes",
					projectId: "project-1",
					projectName: "Launch",
					status: "active",
					sealedAt: null,
					updatedAt: Date.now(),
					href: "/chat/conv-1",
					match: {
						type: "title",
						snippet: null,
						messageId: null,
						messageRole: null,
					},
				},
			],
			documents: [
				{
					id: "artifact-1",
					displayArtifactId: "artifact-1",
					promptArtifactId: null,
					familyArtifactIds: ["artifact-1"],
					name: "brand-playbook.pdf",
					mimeType: "application/pdf",
					sizeBytes: null,
					conversationId: null,
					summary: null,
					documentOrigin: "uploaded",
					documentFamilyStatus: null,
					documentLabel: "Brand playbook",
					updatedAt: Date.now(),
					href: "/knowledge?server_open=artifact-1",
					sourceHref: "/chat/conv-source?focus_message=msg-source",
					match: {
						type: "recent",
						snippet: null,
					},
				},
			],
			documentOverflow: true,
			knowledgeHref: "/knowledge",
		});
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
				sidebarPinned: false,
				sidebarSortOrder: null,
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

	it("shows recent conversations and documents from workspace search", async () => {
		render(SearchModal, {
			props: {
				isOpen: true,
			},
		});

		await waitFor(() => {
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith({ query: "" });
			expect(screen.getByText("Release notes")).toBeInTheDocument();
		});

		expect(screen.getByText("Search workspace")).toBeInTheDocument();
		expect(screen.getByText("Recent conversations")).toBeInTheDocument();
		expect(screen.getByText("Recent documents")).toBeInTheDocument();
		expect(screen.getByText("Brand playbook")).toBeInTheDocument();
		expect(
			screen.getByText("View all documents in Knowledge"),
		).toBeInTheDocument();
	});

	it("opens documents directly and can jump to their source chat", async () => {
		const onClose = vi.fn();

		const firstRender = render(SearchModal, {
			props: {
				isOpen: true,
				onClose,
			},
		});

		await screen.findByText("Brand playbook");

		await fireEvent.click(screen.getByLabelText("Open source chat"));
		expect(goto).toHaveBeenCalledWith(
			"/chat/conv-source?focus_message=msg-source",
		);
		expect(onClose).toHaveBeenCalledTimes(1);
		firstRender.unmount();

		vi.mocked(goto).mockClear();
		onClose.mockClear();

		render(SearchModal, {
			props: {
				isOpen: true,
				onClose,
			},
		});

		await fireEvent.click(await screen.findByText("Brand playbook"));
		expect(goto).toHaveBeenCalledWith("/knowledge?server_open=artifact-1");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("debounces query searches, highlights matched text, and opens body matches at the matched message", async () => {
		render(SearchModal, {
			props: {
				isOpen: true,
			},
		});

		await waitFor(() => {
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith({ query: "" });
		});

		fetchWorkspaceSearch.mockClear();
		fetchWorkspaceSearch.mockResolvedValueOnce({
			mode: "query",
			query: "brand",
			conversations: [
				{
					id: "conv-query",
					title: "Brand launch copy",
					projectId: null,
					projectName: null,
					status: "active",
					sealedAt: null,
					updatedAt: Date.now(),
					href: "/chat/conv-query?focus_message=msg-query",
					match: {
						type: "body",
						messageId: "msg-query",
						messageRole: "assistant",
						snippet: "The brand voice belongs in the launch copy.",
					},
				},
			],
			documents: [
				{
					id: "artifact-query",
					displayArtifactId: "artifact-query",
					promptArtifactId: null,
					familyArtifactIds: ["artifact-query"],
					name: "Brand kit",
					mimeType: null,
					sizeBytes: null,
					conversationId: "conv-query",
					summary: null,
					documentOrigin: "generated",
					documentFamilyStatus: "historical",
					documentLabel: null,
					updatedAt: Date.now(),
					href: "/knowledge?open_artifact=artifact-query&open_filename=Brand+kit",
					sourceHref: null,
					match: {
						type: "summary",
						snippet: "Brand colors and generated variants.",
					},
				},
			],
			documentOverflow: false,
			knowledgeHref: "/knowledge",
		});

		const input = screen.getByLabelText("Search conversations and documents");
		await fireEvent.input(input, { target: { value: "b" } });
		expect(fetchWorkspaceSearch).not.toHaveBeenCalled();

		await fireEvent.input(input, { target: { value: "brand" } });

		await waitFor(
			() => {
				expect(fetchWorkspaceSearch).toHaveBeenCalledWith({ query: "brand" });
				expect(screen.getByText("Documents")).toBeInTheDocument();
			},
			{ timeout: 750 },
		);

		expect(screen.getByText("Message match")).toBeInTheDocument();
		expect(screen.getByText("Generated")).toBeInTheDocument();
		expect(screen.getByText("Historical")).toBeInTheDocument();
		const highlightedTerms = Array.from(
			document.querySelectorAll(".search-highlight"),
		).map((element) => element.textContent);
		expect(highlightedTerms).toContain("Brand");
		expect(highlightedTerms).toContain("brand");
		expect(screen.getByText("Generated").closest(".search-highlight")).toBeNull();

		await fireEvent.click(screen.getByText("launch copy"));
		expect(goto).toHaveBeenCalledWith(
			"/chat/conv-query?focus_message=msg-query",
		);
	});

	it("moves the active result with arrow keys and activates it with Enter", async () => {
		render(SearchModal, {
			props: {
				isOpen: true,
			},
		});

		await screen.findByText("Brand playbook");

		await fireEvent.keyDown(window, { key: "ArrowDown" });
		await fireEvent.keyDown(window, { key: "Enter" });

		expect(goto).toHaveBeenCalledWith("/knowledge?server_open=artifact-1");
	});

	it("shows an unavailable-search error instead of client-side fallback results", async () => {
		fetchWorkspaceSearch.mockRejectedValue(new Error("offline"));

		render(SearchModal, {
			props: {
				isOpen: true,
			},
		});

		expect(
			await screen.findByText("Search is unavailable right now."),
		).toBeInTheDocument();
		expect(screen.queryByText("Release notes")).not.toBeInTheDocument();
	});
});
