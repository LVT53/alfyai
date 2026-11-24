import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goto } from "$app/navigation";
import type {
	WorkspaceSearchConversationResult,
	WorkspaceSearchDocumentResult,
	WorkspaceSearchMemoryResult,
	WorkspaceSearchResponse,
} from "$lib/server/services/workspace-search/types";
import { conversations } from "$lib/stores/conversations";
import { projects } from "$lib/stores/projects";
import { uiLanguage } from "$lib/stores/settings";
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

const SEARCH_BOX = "Search chats, memory, documents and more";
const DAY = 86_400_000;

function chat(
	id: string,
	title: string,
	overrides: Partial<WorkspaceSearchConversationResult> = {},
): WorkspaceSearchConversationResult {
	return {
		id,
		title,
		projectId: null,
		projectName: null,
		status: "open",
		sealedAt: null,
		updatedAt: Date.now(),
		href: `/chat/${id}`,
		match: {
			type: "title",
			snippet: null,
			messageId: null,
			messageRole: null,
		},
		...overrides,
	};
}

function document(
	id: string,
	name: string,
	overrides: Partial<WorkspaceSearchDocumentResult> = {},
): WorkspaceSearchDocumentResult {
	return {
		id,
		displayArtifactId: id,
		promptArtifactId: null,
		familyArtifactIds: [id],
		name,
		mimeType: null,
		sizeBytes: null,
		conversationId: null,
		summary: null,
		documentOrigin: undefined,
		documentFamilyStatus: null,
		documentLabel: null,
		updatedAt: Date.now(),
		href: `/knowledge?open_artifact=${id}`,
		sourceHref: null,
		searchKind: "documents",
		badge: "document",
		originConversationTitle: null,
		preview: null,
		durationMs: null,
		match: { type: "name", snippet: null },
		...overrides,
	};
}

function memory(
	id: string,
	text: string,
	overrides: Partial<WorkspaceSearchMemoryResult> = {},
): WorkspaceSearchMemoryResult {
	return {
		id,
		scope: { kind: "personal" },
		projectName: null,
		text,
		lastSaidAt: new Date(Date.now() - 3 * DAY).toISOString(),
		href: `/knowledge?tab=memory&memoryScope=personal&memoryEntry=${id}&memoryQuery=x`,
		...overrides,
	};
}

function answer(
	overrides: Partial<WorkspaceSearchResponse> = {},
): WorkspaceSearchResponse {
	return {
		query: "thesis",
		mode: "query",
		scope: "all",
		conversations: [],
		memories: [],
		documents: [],
		totals: { chats: 0, memory: 0, documents: 0, media: 0, apps: 0 },
		memorySearchable: false,
		nextCursor: null,
		...overrides,
	};
}

describe("SearchModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
		fetchWorkspaceSearch.mockResolvedValue(
			answer({
				mode: "default",
				query: "",
				conversations: [
					chat("conv-1", "Release notes", {
						projectId: "project-1",
						projectName: "Launch",
						status: "open",
					}),
				],
				documents: [
					document("artifact-1", "brand-playbook.pdf", {
						mimeType: "application/pdf",
						documentOrigin: "uploaded",
						documentLabel: "Brand playbook",
						href: "/knowledge?server_open=artifact-1",
						sourceHref: "/chat/conv-source?focus_message=msg-source",
						badge: "uploaded",
						match: { type: "recent", snippet: null },
					}),
				],
				totals: { chats: 1, memory: 0, documents: 1, media: 0, apps: 0 },
			}),
		);
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
				hasInstructions: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		]);
		currentConversationId.set("conv-1");
		sidebarOpen.set(true);
	});

	/** Types a query and waits for a section of the answer to be on screen. */
	async function search(query: string, sectionTestId: string) {
		const input = screen.getByLabelText(SEARCH_BOX);
		await fireEvent.input(input, { target: { value: query } });
		await waitFor(
			() => {
				expect(fetchWorkspaceSearch).toHaveBeenCalledWith(
					expect.objectContaining({ query }),
				);
				expect(screen.getByTestId(sectionTestId)).toBeInTheDocument();
			},
			{ timeout: 750 },
		);
		return input;
	}

	it("shows recent conversations and documents from workspace search", async () => {
		render(SearchModal, {
			props: {
				isOpen: true,
			},
		});

		await waitFor(() => {
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith({
				query: "",
				signal: expect.any(AbortSignal),
			});
			expect(screen.getByText("Release notes")).toBeInTheDocument();
		});

		expect(screen.getByText("Search workspace")).toBeInTheDocument();
		expect(screen.getByText("Recent conversations")).toBeInTheDocument();
		expect(screen.getByText("Recent documents")).toBeInTheDocument();
		expect(screen.getByText("Brand playbook")).toBeInTheDocument();
		// The row that linked to Knowledge is gone: "Show all" and the chips replace it.
		expect(
			screen.queryByText("View all documents in Knowledge"),
		).not.toBeInTheDocument();
	});

	it("lights no letters in the view before a query", async () => {
		// "a!" is two characters but one letter of words: the server answers with
		// the empty-query view, whose recents must not light every "a".
		fetchWorkspaceSearch.mockResolvedValue(
			answer({
				mode: "default",
				query: "a!",
				conversations: [chat("conv-a", "A banana plan")],
				totals: { chats: 1, memory: 0, documents: 0, media: 0, apps: 0 },
			}),
		);
		render(SearchModal, { props: { isOpen: true } });
		const input = screen.getByLabelText(SEARCH_BOX);
		await fireEvent.input(input, { target: { value: "a!" } });
		await waitFor(
			() => {
				expect(fetchWorkspaceSearch).toHaveBeenCalledWith(
					expect.objectContaining({ query: "a!" }),
				);
				// `document` here is this file's row helper, so the page is window.document.
				expect(window.document.body.textContent).toContain("A banana plan");
			},
			{ timeout: 750 },
		);
		expect(window.document.querySelectorAll(".search-highlight")).toHaveLength(
			0,
		);
	});

	it("shows a keep-typing hint instead of recents for a 1-char query", async () => {
		render(SearchModal, {
			props: {
				isOpen: true,
			},
		});

		// Landing state: recents are fetched and shown for an empty query.
		await waitFor(() => {
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith({
				query: "",
				signal: expect.any(AbortSignal),
			});
			expect(screen.getByText("Release notes")).toBeInTheDocument();
		});

		fetchWorkspaceSearch.mockClear();

		const input = screen.getByLabelText(SEARCH_BOX);
		await fireEvent.input(input, { target: { value: "a" } });

		// A 1-char query is too short to search: show the hint, hide recents,
		// and do not fire a search fetch.
		await waitFor(() => {
			expect(screen.getByTestId("search-keep-typing")).toHaveTextContent(
				"Keep typing to search…",
			);
		});
		expect(screen.queryByText("Release notes")).not.toBeInTheDocument();
		expect(screen.queryByText("Recent conversations")).not.toBeInTheDocument();
		expect(fetchWorkspaceSearch).not.toHaveBeenCalled();
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
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith({
				query: "",
				signal: expect.any(AbortSignal),
			});
		});

		fetchWorkspaceSearch.mockClear();
		fetchWorkspaceSearch.mockResolvedValueOnce(
			answer({
				query: "brand",
				conversations: [
					chat("conv-query", "Brand launch copy", {
						href: "/chat/conv-query?focus_message=msg-query",
						match: {
							type: "body",
							messageId: "msg-query",
							messageRole: "assistant",
							snippet: "The brand voice belongs in the launch copy.",
						},
					}),
				],
				documents: [
					document("artifact-query", "Brand kit", {
						documentOrigin: "generated",
						documentFamilyStatus: "historical",
						badge: "generated",
						match: {
							type: "summary",
							snippet: "Brand colors and generated variants.",
						},
					}),
				],
				totals: { chats: 1, memory: 0, documents: 1, media: 0, apps: 0 },
			}),
		);

		const input = screen.getByLabelText(SEARCH_BOX);
		await fireEvent.input(input, { target: { value: "b" } });
		expect(fetchWorkspaceSearch).not.toHaveBeenCalled();

		await fireEvent.input(input, { target: { value: "brand" } });

		await waitFor(
			() => {
				expect(fetchWorkspaceSearch).toHaveBeenCalledWith({
					query: "brand",
					signal: expect.any(AbortSignal),
				});
				expect(screen.getByTestId("search-section-documents")).toBeVisible();
			},
			{ timeout: 750 },
		);

		expect(screen.getByText("Message match")).toBeInTheDocument();
		expect(screen.getByText("Generated")).toBeInTheDocument();
		expect(screen.getByText("Historical")).toBeInTheDocument();
		const highlightedTerms = Array.from(
			globalThis.document.querySelectorAll(".search-highlight"),
		).map((element) => element.textContent);
		expect(highlightedTerms).toContain("Brand");
		expect(highlightedTerms).toContain("brand");
		expect(
			screen.getByText("Generated").closest(".search-highlight"),
		).toBeNull();

		await fireEvent.click(screen.getByText("launch copy"));
		expect(goto).toHaveBeenCalledWith(
			"/chat/conv-query?focus_message=msg-query",
		);
	});

	it("shows the newest query's answer when an older one arrives after it", async () => {
		let answerKitchen: (value: WorkspaceSearchResponse) => void = () => {};
		const defaultAnswer = fetchWorkspaceSearch.getMockImplementation();
		fetchWorkspaceSearch.mockImplementation((request: { query: string }) => {
			if (request.query === "kitchen") {
				return new Promise((resolve) => {
					answerKitchen = resolve;
				});
			}
			if (request.query === "garden") {
				return Promise.resolve(
					answer({
						query: "garden",
						conversations: [chat("c-garden", "Plot notes")],
						totals: { chats: 1, memory: 0, documents: 0, media: 0, apps: 0 },
					}),
				);
			}
			return defaultAnswer?.(request);
		});
		render(SearchModal, { props: { isOpen: true } });
		const input = screen.getByLabelText(SEARCH_BOX);
		await fireEvent.input(input, { target: { value: "kitchen" } });
		await waitFor(() =>
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith(
				expect.objectContaining({ query: "kitchen" }),
			),
		);
		await search("garden", "search-section-chats");
		expect(await screen.findByText("Plot notes")).toBeInTheDocument();

		answerKitchen(
			answer({
				query: "kitchen",
				conversations: [chat("c-kitchen", "Cooking notes")],
				totals: { chats: 1, memory: 0, documents: 0, media: 0, apps: 0 },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.queryByText("Cooking notes")).toBeNull();
		expect(screen.getByText("Plot notes")).toBeInTheDocument();
	});

	it("cancels the request of a query typed over", async () => {
		const signals: Record<string, AbortSignal | undefined> = {};
		const defaultAnswer = fetchWorkspaceSearch.getMockImplementation();
		fetchWorkspaceSearch.mockImplementation(
			(request: { query: string; signal?: AbortSignal }) => {
				signals[request.query] = request.signal;
				if (request.query === "kitchen") return new Promise(() => {});
				if (request.query === "garden") {
					return Promise.resolve(
						answer({
							query: "garden",
							conversations: [chat("c-garden", "Plot notes")],
							totals: { chats: 1, memory: 0, documents: 0, media: 0, apps: 0 },
						}),
					);
				}
				return defaultAnswer?.(request);
			},
		);
		render(SearchModal, { props: { isOpen: true } });
		const input = screen.getByLabelText(SEARCH_BOX);
		await fireEvent.input(input, { target: { value: "kitchen" } });
		await waitFor(() => expect(signals.kitchen).toBeDefined());
		await search("garden", "search-section-chats");

		expect(signals.kitchen?.aborted).toBe(true);
		expect(signals.garden?.aborted).toBe(false);
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

	it("announces the active result through the search input as arrow keys move", async () => {
		render(SearchModal, {
			props: {
				isOpen: true,
			},
		});

		const input = screen.getByLabelText(SEARCH_BOX);
		await screen.findByText("Brand playbook");

		const firstActiveId = input.getAttribute("aria-activedescendant");
		expect(firstActiveId).toBeTruthy();
		expect(
			globalThis.document.getElementById(firstActiveId ?? ""),
		).toHaveTextContent("Release notes");

		await fireEvent.keyDown(window, { key: "ArrowDown" });

		const secondActiveId = input.getAttribute("aria-activedescendant");
		expect(secondActiveId).toBeTruthy();
		expect(secondActiveId).not.toBe(firstActiveId);
		expect(
			globalThis.document.getElementById(secondActiveId ?? ""),
		).toHaveTextContent("Brand playbook");
	});

	it("keeps focus inside the dialog when mobile pointer mode skips input autofocus", async () => {
		vi.mocked(window.matchMedia).mockImplementation(() => ({
			matches: true,
			media: "(hover: none) and (pointer: coarse)",
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
		const outsideButton = globalThis.document.createElement("button");
		outsideButton.textContent = "Outside";
		globalThis.document.body.appendChild(outsideButton);
		outsideButton.focus();

		try {
			render(SearchModal, {
				props: {
					isOpen: true,
				},
			});

			const dialog = screen.getByRole("dialog", { name: "Search workspace" });
			await waitFor(() => expect(dialog).toHaveFocus());
		} finally {
			outsideButton.remove();
		}
	});

	it("pulls focus back inside the dialog when Tab starts outside the modal", async () => {
		const outsideButton = globalThis.document.createElement("button");
		outsideButton.textContent = "Outside";
		globalThis.document.body.appendChild(outsideButton);

		try {
			render(SearchModal, {
				props: {
					isOpen: true,
				},
			});

			const dialog = screen.getByRole("dialog", { name: "Search workspace" });
			await waitFor(() =>
				expect(screen.getByLabelText(SEARCH_BOX)).toHaveFocus(),
			);

			outsideButton.focus();
			await fireEvent.keyDown(window, { key: "Tab" });

			expect(dialog.contains(globalThis.document.activeElement)).toBe(true);
		} finally {
			outsideButton.remove();
		}
	});

	it("clears stale results when the modal closes before reopening", async () => {
		const onClose = vi.fn();
		const rendered = render(SearchModal, {
			props: {
				isOpen: true,
				onClose,
			},
		});

		await screen.findByText("Release notes");

		await fireEvent.click(screen.getByLabelText("Close search"));
		expect(onClose).toHaveBeenCalledTimes(1);
		await rendered.rerender({ isOpen: false, onClose });

		fetchWorkspaceSearch.mockClear();
		fetchWorkspaceSearch.mockReturnValue(new Promise(() => {}));
		await rendered.rerender({ isOpen: true, onClose });

		expect(screen.queryByText("Release notes")).not.toBeInTheDocument();
		expect(screen.queryByText("Brand playbook")).not.toBeInTheDocument();
		await waitFor(() => {
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith({
				query: "",
				signal: expect.any(AbortSignal),
			});
		});
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

	describe("the chips", () => {
		function respondWithEveryKind(memorySearchable = true) {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Thesis structure")],
					memories: memorySearchable
						? [memory("m1", "Writing a thesis on timber housing")]
						: [],
					documents: [
						document("d1", "Thesis outline"),
						document("p1", "Timber house section", {
							searchKind: "media",
							badge: "image",
						}),
						document("a1", "Thesis deadline countdown", {
							searchKind: "apps",
							badge: "app",
						}),
					],
					totals: {
						chats: 2,
						memory: memorySearchable ? 3 : 0,
						documents: 5,
						media: 2,
						apps: 1,
					},
					memorySearchable,
				}),
			);
		}

		it("are All, Chats, Memory, Documents, Pictures & videos and Apps, with the server's counts", async () => {
			respondWithEveryKind();
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			const count = (id: string) =>
				screen
					.getByTestId(`search-scope-${id}`)
					.textContent?.replace(/\s+/g, " ");
			expect(count("all")).toBe("All 13");
			expect(count("chats")).toBe("Chats 2");
			expect(count("memory")).toBe("Memory 3");
			expect(count("documents")).toBe("Documents 5");
			expect(count("media")).toBe("Pictures & videos 2");
			expect(count("apps")).toBe("Apps 1");
		});

		it("draws no Connections chip, and no Reports chip", async () => {
			respondWithEveryKind();
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			expect(screen.queryByTestId("search-scope-connections")).toBeNull();
			expect(screen.queryByTestId("search-scope-reports")).toBeNull();
			expect(screen.queryByText("Connections")).toBeNull();
			expect(screen.queryByText("Coming soon")).toBeNull();
		});

		it("hides the Memory chip when memory is not searchable", async () => {
			respondWithEveryKind(false);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			expect(screen.queryByTestId("search-scope-memory")).toBeNull();
			expect(screen.getByTestId("search-scope-chats")).toBeInTheDocument();
			expect(screen.queryByTestId("search-section-memory")).toBeNull();
		});

		it("mark a kind with no matches as unavailable", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Thesis structure")],
					totals: { chats: 2, memory: 0, documents: 0, media: 1, apps: 0 },
					memorySearchable: true,
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await screen.findByTestId("search-result-count");
			for (const id of ["memory", "documents", "apps"]) {
				expect(screen.getByTestId(`search-scope-${id}`)).toHaveAttribute(
					"aria-disabled",
					"true",
				);
			}
			for (const id of ["all", "chats", "media"]) {
				expect(screen.getByTestId(`search-scope-${id}`)).not.toHaveAttribute(
					"aria-disabled",
				);
			}
		});

		it("carry no counts before anything is typed", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					mode: "default",
					query: "",
					conversations: [chat("c1", "Release notes")],
					totals: { chats: 1, memory: 0, documents: 0, media: 0, apps: 0 },
					memorySearchable: true,
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await screen.findByText("Release notes");
			// The recents are a few of each kind, not a count of anything; a
			// person with memories must not read "Memory 0".
			const memoryChip = screen.getByTestId("search-scope-memory");
			expect(memoryChip.textContent?.trim()).toBe("Memory");
			expect(memoryChip.getAttribute("aria-label")).toBe("Memory");
			expect(screen.getByTestId("search-scope-chats").textContent?.trim()).toBe(
				"Chats",
			);
		});

		it("show 99+ at the cap", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Thesis structure")],
					totals: { chats: 100, memory: 0, documents: 7, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			expect(
				screen.getByTestId("search-scope-chats").textContent?.trim(),
			).toContain("99+");
			expect(
				screen.getByTestId("search-scope-all").textContent?.trim(),
			).toContain("99+");
			expect(
				screen.getByTestId("search-scope-documents").textContent?.trim(),
			).toContain("7");
		});

		it("speak Hungarian in a Hungarian interface", async () => {
			uiLanguage.set("hu");
			respondWithEveryKind();
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			const text = (id: string) =>
				screen.getByTestId(`search-scope-${id}`).textContent ?? "";
			expect(text("chats")).toContain("Beszélgetések");
			expect(text("memory")).toContain("Memória");
			expect(text("media")).toContain("Képek és videók");
			expect(text("apps")).toContain("Alkalmazások");
			expect(
				screen.getByLabelText(
					"Keresés a beszélgetésekben, az emlékekben, a dokumentumokban és máshol",
				),
			).toBeInTheDocument();
		});

		// The field's own hint has to fit a phone (about 250 px of field at 360),
		// so it is a few words; what the field searches is its name, for a screen
		// reader, and the chips under it show the kinds. The phone's width is
		// measured in `tests/e2e/phone-polish.spec.ts`.
		it("hints at the field in a few words and names it in full", async () => {
			const words = {
				en: {
					hint: "Search everything",
					name: "Search chats, memory, documents and more",
				},
				hu: {
					hint: "Keresés mindenben",
					name: "Keresés a beszélgetésekben, az emlékekben, a dokumentumokban és máshol",
				},
			} as const;
			for (const language of ["en", "hu"] as const) {
				uiLanguage.set(language);
				const { unmount } = render(SearchModal, { props: { isOpen: true } });
				expect(screen.getByLabelText(words[language].name)).toHaveAttribute(
					"placeholder",
					words[language].hint,
				);
				unmount();
			}
		});

		it("scroll the chosen chip into view in the sideways-scrolling row", async () => {
			respondWithEveryKind();
			const scrollIntoView = vi.fn();
			const original = HTMLElement.prototype.scrollIntoView;
			HTMLElement.prototype.scrollIntoView = scrollIntoView;
			try {
				render(SearchModal, { props: { isOpen: true } });
				await screen.findByTestId("search-result-count");
				scrollIntoView.mockClear();
				await fireEvent.click(screen.getByTestId("search-scope-apps"));
				await waitFor(() =>
					expect(scrollIntoView).toHaveBeenCalledWith(
						expect.objectContaining({ inline: "nearest" }),
					),
				);
			} finally {
				HTMLElement.prototype.scrollIntoView = original;
			}
		});
	});

	describe("the sections", () => {
		it("show three per kind in order, each with a Show all link when there are more", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [
						chat("c1", "Thesis one"),
						chat("c2", "Thesis two"),
						chat("c3", "Thesis three"),
					],
					memories: [memory("m1", "Writing a thesis")],
					documents: [document("d1", "Thesis outline")],
					totals: { chats: 12, memory: 1, documents: 1, media: 0, apps: 0 },
					memorySearchable: true,
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			const sections = Array.from(
				globalThis.document.querySelectorAll(
					"[data-testid^='search-section-']",
				),
			).map((element) => element.getAttribute("data-testid"));
			expect(sections).toEqual([
				"search-section-chats",
				"search-section-memory",
				"search-section-documents",
			]);
			expect(
				screen.getByRole("button", { name: "Show all 12 chats" }),
			).toBeInTheDocument();
			// A kind whose few are all of it has no link.
			expect(screen.getAllByRole("button", { name: /^Show all/ })).toHaveLength(
				1,
			);
		});

		it("Show all names its kind, in both languages", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					documents: [
						document("d1", "Thesis outline"),
						document("p1", "Thesis cover", {
							searchKind: "media",
							badge: "image",
						}),
					],
					totals: { chats: 0, memory: 0, documents: 5, media: 4, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await screen.findByTestId("search-result-count");
			expect(
				screen.getByRole("button", { name: "Show all 5 documents" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Show all 4 pictures and videos" }),
			).toBeInTheDocument();
			uiLanguage.set("hu");
			expect(
				await screen.findByRole("button", { name: "Mind a(z) 5 dokumentum" }),
			).toBeInTheDocument();
		});

		it("names every kind in the hint when nothing matches", async () => {
			fetchWorkspaceSearch.mockResolvedValue(answer());
			render(SearchModal, { props: { isOpen: true } });
			const input = screen.getByLabelText(SEARCH_BOX);
			await fireEvent.input(input, { target: { value: "zzz-nothing" } });
			expect(
				await screen.findByText(
					"Try another word from a chat, memory, document, picture, video or app",
					{},
					{ timeout: 1000 },
				),
			).toBeInTheDocument();
		});

		it("Show all selects the kind's chip and fetches it, for the typed query", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Alpha one")],
					totals: { chats: 12, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await search("thesis", "search-section-chats");

			fetchWorkspaceSearch.mockClear();
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					scope: "chats",
					conversations: Array.from({ length: 12 }, (_, index) =>
						chat(`c${index}`, `Alpha ${index}`),
					),
					totals: { chats: 12, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			await fireEvent.click(
				screen.getByRole("button", { name: "Show all 12 chats" }),
			);

			await waitFor(() =>
				expect(fetchWorkspaceSearch).toHaveBeenCalledWith({
					query: "thesis",
					scope: "chats",
					signal: expect.any(AbortSignal),
				}),
			);
			expect(screen.getByTestId("search-scope-chats")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			await screen.findByText("Alpha 11");
			expect(
				screen.queryByRole("button", { name: /^Show all/ }),
			).not.toBeInTheDocument();
		});

		it("keeps the focus in the dialog when Show all goes away", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Alpha one")],
					totals: { chats: 12, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			const input = await search("thesis", "search-section-chats");
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					scope: "chats",
					conversations: [chat("c2", "Alpha two")],
					totals: { chats: 12, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			const showAll = screen.getByRole("button", { name: /^Show all/ });
			showAll.focus();
			await fireEvent.click(showAll);
			await screen.findByText("Alpha two");
			await waitFor(() => expect(window.document.activeElement).toBe(input));
		});

		it("keeps the focus in the dialog when the last Load more goes away", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					scope: "chats",
					conversations: [chat("c1", "Alpha one")],
					totals: { chats: 2, memory: 0, documents: 0, media: 0, apps: 0 },
					nextCursor: "o:20",
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			const input = await search("thesis", "search-section-chats");
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					scope: "chats",
					conversations: [chat("c1", "Alpha one")],
					totals: { chats: 2, memory: 0, documents: 0, media: 0, apps: 0 },
					nextCursor: "o:20",
				}),
			);
			await fireEvent.click(screen.getByTestId("search-scope-chats"));
			const loadMore = await screen.findByRole("button", { name: "Load more" });
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					scope: "chats",
					conversations: [chat("c2", "Alpha two")],
					totals: { chats: 2, memory: 0, documents: 0, media: 0, apps: 0 },
					nextCursor: null,
				}),
			);
			loadMore.focus();
			await fireEvent.click(loadMore);
			await screen.findByText("Alpha two");
			await waitFor(() => expect(window.document.activeElement).toBe(input));
		});

		it("Load more appends the next page until there is none", async () => {
			const page = (from: number, count: number, next: string | null) =>
				answer({
					scope: "chats",
					conversations: Array.from({ length: count }, (_, index) =>
						chat(`c${from + index}`, `Alpha ${from + index}`),
					),
					totals: { chats: 45, memory: 0, documents: 0, media: 0, apps: 0 },
					nextCursor: next,
				});
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c0", "Alpha 0")],
					totals: { chats: 45, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await search("thesis", "search-section-chats");

			fetchWorkspaceSearch.mockResolvedValue(page(0, 20, "o:20"));
			await fireEvent.click(screen.getByTestId("search-scope-chats"));
			await screen.findByText("Alpha 19");
			expect(screen.queryByText("Alpha 20")).toBeNull();

			fetchWorkspaceSearch.mockClear();
			fetchWorkspaceSearch.mockResolvedValue(page(20, 20, "o:40"));
			await fireEvent.click(screen.getByRole("button", { name: "Load more" }));
			await screen.findByText("Alpha 39");
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith({
				query: "thesis",
				scope: "chats",
				cursor: "o:20",
			});
			// The first page is still there, with the second after it.
			expect(screen.getByText("Alpha 0")).toBeInTheDocument();

			fetchWorkspaceSearch.mockResolvedValue(page(40, 5, null));
			await fireEvent.click(screen.getByRole("button", { name: "Load more" }));
			await screen.findByText("Alpha 44");
			expect(
				screen.queryByRole("button", { name: "Load more" }),
			).not.toBeInTheDocument();
		});

		it("Load more asks with the shown answer's query and shows a repeated chat once", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c0", "Alpha 0")],
					totals: { chats: 45, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			const input = await search("thesis", "search-section-chats");
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					scope: "chats",
					conversations: [chat("c1", "Alpha 1"), chat("c2", "Alpha 2")],
					totals: { chats: 45, memory: 0, documents: 0, media: 0, apps: 0 },
					nextCursor: "o:20",
				}),
			);
			await fireEvent.click(screen.getByTestId("search-scope-chats"));
			await screen.findByText("Alpha 2");

			// Typed on, inside the debounce: the box no longer holds the shown query.
			await fireEvent.input(input, { target: { value: "thesis structure" } });
			fetchWorkspaceSearch.mockClear();
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					scope: "chats",
					// Alpha 2 moved between the pages (its chat was updated meanwhile).
					conversations: [chat("c2", "Alpha 2"), chat("c3", "Alpha 3")],
					totals: { chats: 45, memory: 0, documents: 0, media: 0, apps: 0 },
					nextCursor: null,
				}),
			);
			await fireEvent.click(screen.getByRole("button", { name: "Load more" }));
			await screen.findByText("Alpha 3");
			expect(fetchWorkspaceSearch).toHaveBeenCalledWith({
				query: "thesis",
				scope: "chats",
				cursor: "o:20",
			});
			expect(screen.getAllByText("Alpha 2")).toHaveLength(1);
		});

		it("falls back to All when the chosen kind has nothing for a new query", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Mortise")],
					documents: [document("d1", "Outline")],
					totals: { chats: 5, memory: 0, documents: 4, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await search("thesis", "search-section-chats");
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					scope: "documents",
					documents: [document("d1", "Outline")],
					totals: { chats: 5, memory: 0, documents: 4, media: 0, apps: 0 },
				}),
			);
			await fireEvent.click(screen.getByTestId("search-scope-documents"));
			await screen.findByTestId("search-section-documents");

			// A new query that finds no documents: the chip would be empty.
			fetchWorkspaceSearch.mockImplementation(
				async (request: { scope?: string }) =>
					request.scope === "documents"
						? answer({
								query: "dovetail",
								scope: "documents",
								totals: {
									chats: 2,
									memory: 0,
									documents: 0,
									media: 0,
									apps: 0,
								},
							})
						: answer({
								query: "dovetail",
								conversations: [chat("c9", "Tenon")],
								totals: {
									chats: 2,
									memory: 0,
									documents: 0,
									media: 0,
									apps: 0,
								},
							}),
			);
			const input = screen.getByLabelText(SEARCH_BOX);
			await fireEvent.input(input, { target: { value: "dovetail" } });

			await screen.findByText("Tenon", undefined, { timeout: 1500 });
			expect(screen.getByTestId("search-scope-all")).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		});
	});

	describe("the rows", () => {
		it("draw a memory row with its scope and when it was last said", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					memories: [
						memory("m1", "Writing a thesis on timber housing, due June 2027."),
						memory("m2", "The thesis model is built at 1:50 scale.", {
							scope: { kind: "project", projectId: "p1" },
							projectName: "Thesis project",
							lastSaidAt: new Date(Date.now() - 21 * DAY).toISOString(),
						}),
						memory("m3", "Her thesis supervisor is Prof. Costa.", {
							lastSaidAt: null,
						}),
					],
					totals: { chats: 0, memory: 3, documents: 0, media: 0, apps: 0 },
					memorySearchable: true,
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			const section = screen.getByTestId("search-section-memory");
			const [first, second, third] = Array.from(
				section.querySelectorAll(".search-result-item"),
			);
			expect(first.textContent).toContain("Writing a thesis on timber housing");
			expect(first.textContent).toContain("Personal");
			expect(first.textContent).toContain("said 3 days ago");
			expect(second.textContent).toContain("Thesis project");
			expect(second.textContent).toContain("said 3 weeks ago");
			// An entry with no date says nothing about when.
			expect(third.textContent).toContain("Personal");
			expect(third.textContent).not.toContain("said");
			expect(
				first
					.closest(".search-result-shell")
					?.querySelector("svg")
					?.getAttribute("class"),
			).toContain("lucide-brain");
		});

		it("say the age in Hungarian, in the app's own words", async () => {
			uiLanguage.set("hu");
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					memories: [memory("m1", "Szakdolgozat a faházakról")],
					totals: { chats: 0, memory: 1, documents: 0, media: 0, apps: 0 },
					memorySearchable: true,
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			const row = screen.getByTestId("search-section-memory");
			expect(row.textContent).toContain("Személyes");
			expect(row.textContent).toContain("3 napja");
			expect(row.textContent).not.toContain("said");
		});

		it("opens a memory row at its place in Memory", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					memories: [memory("m1", "Writing a thesis")],
					totals: { chats: 0, memory: 1, documents: 0, media: 0, apps: 0 },
					memorySearchable: true,
				}),
			);
			const onClose = vi.fn();
			render(SearchModal, { props: { isOpen: true, onClose } });

			await fireEvent.click(await screen.findByText("Writing a"));

			expect(goto).toHaveBeenCalledWith(
				"/knowledge?tab=memory&memoryScope=personal&memoryEntry=m1&memoryQuery=x",
			);
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it("draw a picture row with its thumbnail and a video row with its duration", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					documents: [
						document("p1", "Timber house section", {
							searchKind: "media",
							badge: "image",
							originConversationTitle: "Cover ideas",
							preview: {
								src: "/api/images/files/f1?variant=thumb&conversationId=c1",
								width: 1248,
								height: 832,
							},
							match: {
								type: "content",
								snippet:
									"a cut-through section of a timber house for my thesis",
							},
						}),
						document("v1", "Model turntable", {
							searchKind: "media",
							badge: "video",
							originConversationTitle: "Cover ideas",
							durationMs: 6000,
							preview: {
								src: "/api/images/files/f2?variant=poster&conversationId=c1",
								width: 1280,
								height: 704,
							},
						}),
						document("p2", "Uploaded photo", {
							searchKind: "media",
							badge: "image",
						}),
					],
					totals: { chats: 0, memory: 0, documents: 0, media: 3, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			const section = screen.getByTestId("search-section-media");
			const rows = Array.from(
				section.querySelectorAll(".search-result-document"),
			);
			const thumb = (row: Element) => row.querySelector("img");
			expect(thumb(rows[0])?.getAttribute("src")).toBe(
				"/api/images/files/f1?variant=thumb&conversationId=c1",
			);
			expect(rows[0].textContent).toContain("Image");
			expect(rows[0].textContent).toContain("Made in “Cover ideas”");
			expect(rows[0].textContent).toContain(
				"a cut-through section of a timber house",
			);
			expect(thumb(rows[1])?.getAttribute("src")).toBe(
				"/api/images/files/f2?variant=poster&conversationId=c1",
			);
			expect(rows[1].textContent).toContain("Video");
			expect(rows[1].textContent).toContain("0:06");
			// A picture with no thumbnail keeps an icon tile.
			expect(thumb(rows[2])).toBeNull();
			expect(rows[2].querySelector(".search-result-icon svg")).not.toBeNull();
			expect(rows[1].querySelector(".search-result-icon svg")).not.toBeNull();
		});

		it("keeps the kind's icon tile when a thumbnail fails to load", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					documents: [
						document("v1", "Model turntable", {
							searchKind: "media",
							badge: "video",
							durationMs: 6000,
							preview: {
								src: "/api/images/files/f2?variant=thumb&conversationId=c1",
								width: 1280,
								height: 704,
							},
						}),
					],
					totals: { chats: 0, memory: 0, documents: 0, media: 1, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			const row = screen
				.getByTestId("search-section-media")
				.querySelector(".search-result-document");
			const image = row?.querySelector("img");
			expect(image).not.toBeNull();
			if (image) await fireEvent.error(image);
			await waitFor(() => expect(row?.querySelector("img")).toBeNull());
			expect(row?.querySelector(".search-result-icon svg")).not.toBeNull();
		});

		it("tries a failed thumbnail again the next time the modal opens", async () => {
			const thumbAnswer = answer({
				documents: [
					document("v1", "Model turntable", {
						searchKind: "media",
						badge: "video",
						preview: {
							src: "/api/images/files/f2?variant=thumb&conversationId=c1",
							width: 1280,
							height: 704,
						},
					}),
				],
				totals: { chats: 0, memory: 0, documents: 0, media: 1, apps: 0 },
			});
			fetchWorkspaceSearch.mockResolvedValue(thumbAnswer);
			const onClose = vi.fn();
			const rendered = render(SearchModal, { props: { isOpen: true, onClose } });
			await screen.findByTestId("search-result-count");
			const firstImage = screen
				.getByTestId("search-section-media")
				.querySelector("img");
			if (firstImage) await fireEvent.error(firstImage);
			await waitFor(() =>
				expect(
					screen.getByTestId("search-section-media").querySelector("img"),
				).toBeNull(),
			);

			// A blip on the network is not the picture's fault: a later open asks again.
			await fireEvent.click(screen.getByLabelText("Close search"));
			await rendered.rerender({ isOpen: false, onClose });
			await rendered.rerender({ isOpen: true, onClose });
			await screen.findByTestId("search-result-count");
			expect(
				screen.getByTestId("search-section-media").querySelector("img"),
			).not.toBeNull();
		});

		it("highlight words typed in another order", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					query: "kitchen plan",
					conversations: [chat("c1", "Plan for the kitchen")],
					totals: { chats: 1, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await search("kitchen plan", "search-section-chats");

			const highlighted = Array.from(
				globalThis.document.querySelectorAll(".search-highlight"),
			).map((element) => element.textContent);
			expect(highlighted).toEqual(["Plan", "kitchen"]);
		});

		it("highlight a word without accents in an accented text", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					query: "arviz",
					conversations: [chat("c1", "Árvíztűrő tükörfúrógép")],
					totals: { chats: 1, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await search("arviz", "search-section-chats");

			const highlighted = Array.from(
				globalThis.document.querySelectorAll(".search-highlight"),
			).map((element) => element.textContent);
			expect(highlighted).toEqual(["Árvíz"]);
		});

		it("name each kind with its badge and its icon", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					documents: [
						document("doc", "Saturday plan", { badge: "document" }),
						document("sl", "Trip recap", { badge: "slides" }),
						document("cv", "Vienna trip board", { badge: "canvas" }),
						document("up", "contract.pdf", { badge: "uploaded" }),
						document("gen", "figures.xlsx", { badge: "generated" }),
						document("rep", "Timber housing", { badge: "report" }),
						document("sn", "House style", { badge: "skill_note" }),
						document("im", "Harbour at dusk", {
							badge: "image",
							searchKind: "media",
						}),
						document("vi", "Turntable", {
							badge: "video",
							searchKind: "media",
						}),
						document("ap", "Trip cost splitter", {
							badge: "app",
							searchKind: "apps",
						}),
					],
					totals: { chats: 0, memory: 0, documents: 7, media: 2, apps: 1 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });
			await screen.findByTestId("search-result-count");

			const row = (title: string) =>
				screen.getByText(title).closest(".search-result-document");
			const expected: Array<[string, string, string]> = [
				["Saturday plan", "Document", "lucide-square-pen"],
				["Trip recap", "Slides", "lucide-presentation"],
				["Vienna trip board", "Canvas", "lucide-layout-dashboard"],
				["contract.pdf", "Uploaded", "lucide-file-up"],
				["figures.xlsx", "Generated", "lucide-file-text"],
				["Timber housing", "Report", "lucide-book-open"],
				["House style", "Skill note", "lucide-notebook-pen"],
				["Harbour at dusk", "Image", "lucide-image"],
				["Turntable", "Video", "lucide-film"],
				["Trip cost splitter", "App", "lucide-app-window"],
			];
			for (const [title, badge, icon] of expected) {
				const element = row(title);
				expect(
					element?.querySelector(".search-badge")?.textContent,
					title,
				).toBe(badge);
				expect(
					element
						?.querySelector(".search-result-icon svg")
						?.getAttribute("class"),
					title,
				).toContain(icon);
			}
		});

		it("choosing a picture hands it to the knowledge page's panel", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					documents: [
						document("art-img", "Harbour at dusk", {
							badge: "image",
							searchKind: "media",
						}),
					],
					totals: { chats: 0, memory: 0, documents: 0, media: 1, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			await fireEvent.click(await screen.findByText("Harbour at dusk"));

			expect(goto).toHaveBeenCalledWith("/knowledge?open_artifact=art-img");
		});
	});

	describe("the keyboard", () => {
		function respondWithEveryKind() {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Thesis structure")],
					memories: [memory("m1", "Writing a thesis on timber housing")],
					documents: [
						document("d1", "Thesis outline"),
						document("p1", "Timber house section", {
							searchKind: "media",
							badge: "image",
						}),
						document("a1", "Thesis deadline countdown", {
							searchKind: "apps",
							badge: "app",
						}),
					],
					totals: { chats: 1, memory: 1, documents: 1, media: 1, apps: 1 },
					memorySearchable: true,
				}),
			);
		}

		it("moves through every kind with the arrow keys", async () => {
			respondWithEveryKind();
			render(SearchModal, { props: { isOpen: true } });
			await screen.findByTestId("search-result-count");

			const input = screen.getByLabelText(SEARCH_BOX);
			const activeText = () =>
				globalThis.document.getElementById(
					input.getAttribute("aria-activedescendant") ?? "",
				)?.textContent ?? "";
			const seen: string[] = [activeText()];
			for (let index = 0; index < 4; index++) {
				await fireEvent.keyDown(window, { key: "ArrowDown" });
				seen.push(activeText());
			}
			expect(seen[0]).toContain("Thesis structure");
			expect(seen[1]).toContain("Writing a thesis on timber housing");
			expect(seen[2]).toContain("Thesis outline");
			expect(seen[3]).toContain("Timber house section");
			expect(seen[4]).toContain("Thesis deadline countdown");

			// Round the end and back.
			await fireEvent.keyDown(window, { key: "ArrowDown" });
			expect(activeText()).toContain("Thesis structure");
			await fireEvent.keyDown(window, { key: "ArrowUp" });
			expect(activeText()).toContain("Thesis deadline countdown");
		});

		it("opens the active row, whatever its kind, with Enter", async () => {
			respondWithEveryKind();
			render(SearchModal, { props: { isOpen: true } });
			await screen.findByTestId("search-result-count");

			await fireEvent.keyDown(window, { key: "ArrowDown" });
			await fireEvent.keyDown(window, { key: "Enter" });

			expect(goto).toHaveBeenCalledWith(
				"/knowledge?tab=memory&memoryScope=personal&memoryEntry=m1&memoryQuery=x",
			);
		});

		it("states the keys that already work", async () => {
			respondWithEveryKind();
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByTestId("search-result-count");
			expect(screen.getByText("move")).toBeInTheDocument();
			expect(screen.getByText("open")).toBeInTheDocument();
			expect(screen.getByText("close")).toBeInTheDocument();
		});

		it("offers the new-tab key only while the count is not claiming the line", async () => {
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByText("Release notes");
			// Before you type the footer has room for all four keys.
			expect(screen.getByText("open in a new tab")).toBeInTheDocument();
		});

		it("opens the active result in a new tab on Cmd/Ctrl+Enter, and stays open", async () => {
			const open = vi
				.spyOn(window, "open")
				.mockReturnValue(null as unknown as Window);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByText("Brand playbook");
			await fireEvent.keyDown(window, { key: "ArrowDown" });
			await fireEvent.keyDown(window, { key: "Enter", metaKey: true });

			expect(open).toHaveBeenCalledWith(
				"/knowledge?server_open=artifact-1",
				"_blank",
				"noopener,noreferrer",
			);
			// The palette is still there — opening several results in turn is the
			// only reason to want a new tab.
			expect(goto).not.toHaveBeenCalled();
			expect(screen.getByRole("dialog")).toBeInTheDocument();
			open.mockRestore();
		});

		// A focused button owns a plain Enter, but not ⌘↵: letting it through
		// fires the row's own click and navigates in THIS tab, which is the
		// opposite of what was asked for.
		it("still opens a new tab when the ⌘↵ lands on a focused result row", async () => {
			const open = vi
				.spyOn(window, "open")
				.mockReturnValue(null as unknown as Window);
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByText("Brand playbook");
			await fireEvent.keyDown(window, { key: "ArrowDown" });

			// Fired on the row itself, so it reaches the window handler with the
			// button as its target — exactly what a keystroke on a focused row
			// looks like.
			const row = screen.getByText("Brand playbook").closest("button");
			expect(row).not.toBeNull();
			await fireEvent.keyDown(row as HTMLButtonElement, {
				key: "Enter",
				metaKey: true,
			});

			expect(open).toHaveBeenCalledWith(
				"/knowledge?server_open=artifact-1",
				"_blank",
				"noopener,noreferrer",
			);
			expect(goto).not.toHaveBeenCalled();
			open.mockRestore();
		});

		it("counts the results once something is typed, from the server's totals", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Thesis structure")],
					totals: { chats: 2, memory: 3, documents: 5, media: 2, apps: 1 },
					memorySearchable: true,
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			const count = await screen.findByTestId("search-result-count");
			expect(count.textContent).toContain("13 results across 5 kinds");
		});

		it("says 99+ when a kind's count stopped at the cap", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Thesis structure")],
					totals: { chats: 100, memory: 0, documents: 3, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			const count = await screen.findByTestId("search-result-count");
			expect(count.textContent?.trim()).toBe("99+ results across 2 kinds");
		});

		it("says kind in the singular for one kind", async () => {
			fetchWorkspaceSearch.mockResolvedValue(
				answer({
					conversations: [chat("c1", "Thesis structure")],
					totals: { chats: 4, memory: 0, documents: 0, media: 0, apps: 0 },
				}),
			);
			render(SearchModal, { props: { isOpen: true } });

			const count = await screen.findByTestId("search-result-count");
			expect(count.textContent?.trim()).toBe("4 results across 1 kind");
		});

		it("carries no result count before anything is typed", async () => {
			render(SearchModal, { props: { isOpen: true } });

			await screen.findByText("Release notes");
			// The footer carries the keys and nothing else: a line saying
			// "nothing typed" only describes the box you are looking at.
			expect(
				screen.queryByTestId("search-result-count"),
			).not.toBeInTheDocument();
		});
	});
});
