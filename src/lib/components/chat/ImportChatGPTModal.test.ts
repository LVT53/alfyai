import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	importChatGPTData,
	packChatGPTUpload,
} from "$lib/client/api/chatgpt-import";
import { ApiError } from "$lib/client/api/http";
import { uiLanguage } from "$lib/stores/settings";
import ImportChatGPTModal from "./ImportChatGPTModal.svelte";

// A real export names each conversation twice, `conversation_id` and `id`. The
// first has both; the second only `id`, which the server falls back to.
const mockConversations: Record<string, unknown>[] = [
	{
		title: "Chat One",
		conversation_id: "conv-1",
		id: "internal-1",
		create_time: 1700000000,
		update_time: 1700000100,
		mapping: {
			"msg-1": { message: { id: "msg-1" }, parent: null, children: ["msg-2"] },
			"msg-2": { message: { id: "msg-2" }, parent: "msg-1", children: [] },
		},
	},
	{
		title: "Chat Two",
		id: "conv-2",
		create_time: 1700001000,
		update_time: 1700001100,
		mapping: {
			"msg-3": { message: { id: "msg-3" }, parent: null, children: [] },
		},
	},
];

// What the mocked ZIP holds; a test that needs another export assigns it.
let exportedConversations: Record<string, unknown>[] = mockConversations;
// Other files of the mocked ZIP, by path (a newer export's manifest and shards).
let otherZipFiles: Record<string, unknown> = {};

vi.mock("jszip", () => {
	return {
		default: {
			loadAsync: vi.fn().mockResolvedValue({
				file: (name: string) => {
					const value =
						name in otherZipFiles
							? otherZipFiles[name]
							: name === "conversations.json"
								? exportedConversations
								: undefined;
					return value === undefined
						? null
						: { async: () => Promise.resolve(JSON.stringify(value)) };
				},
			}),
		},
	};
});

// What the dialog uploads: the packed ticked conversations, not the dropped file.
const { PACKED_UPLOAD } = vi.hoisted(() => ({
	PACKED_UPLOAD: new File(["packed"], "chatgpt-export.zip", {
		type: "application/zip",
	}),
}));

vi.mock("$lib/client/api/chatgpt-import", () => ({
	importChatGPTData: vi.fn().mockResolvedValue({
		jobId: "job-123",
		conversationIds: ["conv-1", "conv-2"],
		errors: [],
	}),
	packChatGPTUpload: vi.fn().mockResolvedValue(PACKED_UPLOAD),
}));

function createZipFile(name = "export.zip"): File {
	return new File(["fake-zip-content"], name, { type: "application/zip" });
}

describe("ImportChatGPTModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		exportedConversations = mockConversations;
		otherZipFiles = {};
		uiLanguage.set("en");
	});

	it("renders upload state when show is true", () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		expect(
			screen.getByText("Import ChatGPT Conversations"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Upload a ChatGPT export ZIP to import your conversations.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Select ZIP file" }),
		).toBeInTheDocument();
	});

	it("does not render when show is false", () => {
		const { container } = render(ImportChatGPTModal, {
			props: { show: false, onClose: vi.fn(), projects: [] },
		});

		expect(container.querySelector("[role='dialog']")).not.toBeInTheDocument();
	});

	it("calls onClose when cancel is clicked", async () => {
		const onClose = vi.fn();
		render(ImportChatGPTModal, {
			props: { show: true, onClose, projects: [] },
		});

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("transitions to preview after selecting a valid ZIP file", async () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });

		const file = createZipFile();
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [file] },
		});

		await waitFor(() => {
			expect(
				screen.getByText("Select Conversations to Import"),
			).toBeInTheDocument();
		});

		expect(screen.getByText("Chat One")).toBeInTheDocument();
		expect(screen.getByText("Chat Two")).toBeInTheDocument();
	});

	it("lists the conversations of every file a newer export's manifest names", async () => {
		const [first, second] = mockConversations;
		exportedConversations = [];
		otherZipFiles = {
			"export_manifest.json": {
				version: 1,
				logical_files: {
					"conversations.json": {
						files: ["conversations-0001.json", "conversations-0002.json"],
						sharded: true,
						shard_count: 2,
					},
				},
			},
			"conversations-0001.json": [first],
			"conversations-0002.json": [second],
		};
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});
		await fireEvent.drop(
			screen.getByRole("button", { name: "Drop ZIP file here" }),
			{ dataTransfer: { files: [createZipFile()] } },
		);
		await waitFor(() => {
			expect(
				screen.getByText("Select Conversations to Import"),
			).toBeInTheDocument();
		});
		for (const chat of [first, second])
			expect(screen.getByText(String(chat.title))).toBeInTheDocument();
	});

	it("says it cannot read an export whose manifest names a missing file", async () => {
		otherZipFiles = {
			"export_manifest.json": {
				logical_files: {
					"conversations.json": { files: ["conversations-0002.json"] },
				},
			},
		};
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});
		await fireEvent.drop(
			screen.getByRole("button", { name: "Drop ZIP file here" }),
			{ dataTransfer: { files: [createZipFile()] } },
		);
		await waitFor(() => {
			expect(
				screen.queryByText("Select Conversations to Import"),
			).not.toBeInTheDocument();
			expect(
				screen.getByText("Could not read conversations from the ZIP file."),
			).toBeInTheDocument();
		});
	});

	it("filters conversations by search query", async () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [createZipFile()] },
		});

		await waitFor(() => {
			expect(screen.getByText("Chat One")).toBeInTheDocument();
		});

		const searchInput = screen.getByPlaceholderText("Search conversations...");
		await fireEvent.input(searchInput, { target: { value: "Two" } });

		expect(screen.queryByText("Chat One")).not.toBeInTheDocument();
		expect(screen.getByText("Chat Two")).toBeInTheDocument();
	});

	it("toggles select all / deselect all", async () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [createZipFile()] },
		});

		await waitFor(() => {
			expect(screen.getByText("Chat One")).toBeInTheDocument();
		});

		const selectAllBtn = screen.getByRole("button", { name: "Deselect all" });
		await fireEvent.click(selectAllBtn);

		const checkboxes = screen.getAllByRole("checkbox");
		expect(checkboxes.every((cb) => !(cb as HTMLInputElement).checked)).toBe(
			true,
		);

		await fireEvent.click(screen.getByRole("button", { name: "Select all" }));
		expect(checkboxes.every((cb) => (cb as HTMLInputElement).checked)).toBe(
			true,
		);
	});

	it("transitions to config state on next click", async () => {
		render(ImportChatGPTModal, {
			props: {
				show: true,
				onClose: vi.fn(),
				projects: [
					{
						id: "proj-1",
						name: "My Project",
						sortOrder: 0,
						hasInstructions: false,
						createdAt: 1,
						updatedAt: 2,
					},
				],
			},
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [createZipFile()] },
		});

		await waitFor(() => {
			expect(
				screen.getByText("Select Conversations to Import"),
			).toBeInTheDocument();
		});

		await fireEvent.click(screen.getByRole("button", { name: "Next" }));

		await waitFor(() => {
			expect(screen.getByText("Import Settings")).toBeInTheDocument();
		});

		expect(screen.getByLabelText("Project folder")).toBeInTheDocument();
		expect(screen.getByText("My Project")).toBeInTheDocument();
	});

	it("says in the reader's words that an import is already running", async () => {
		vi.mocked(importChatGPTData).mockRejectedValueOnce(
			new ApiError(
				"A ChatGPT import is already running for this account. Wait for it to finish, then try again.",
				{ status: 409, errorKey: "chatgptImport.alreadyRunning" },
			),
		);
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		await fireEvent.drop(
			screen.getByRole("button", { name: "Drop ZIP file here" }),
			{ dataTransfer: { files: [createZipFile()] } },
		);
		await fireEvent.click(await screen.findByRole("button", { name: "Next" }));
		await fireEvent.click(
			await screen.findByRole("button", { name: "Import 2 selected" }),
		);

		expect(
			await screen.findByText(
				"An import is already running. Wait for it to finish, then try again.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/already running for this account/),
		).not.toBeInTheDocument();
	});

	it("shows error for non-zip files", async () => {
		render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		const txtFile = new File(["text"], "notes.txt", { type: "text/plain" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [txtFile] },
		});

		await waitFor(() => {
			expect(
				screen.getByText("Please select a valid ZIP file."),
			).toBeInTheDocument();
		});
	});

	it("resets state when modal is closed and reopened", async () => {
		const { rerender } = render(ImportChatGPTModal, {
			props: { show: true, onClose: vi.fn(), projects: [] },
		});

		const dropZone = screen.getByRole("button", { name: "Drop ZIP file here" });
		await fireEvent.drop(dropZone, {
			dataTransfer: { files: [createZipFile()] },
		});

		await waitFor(() => {
			expect(
				screen.getByText("Select Conversations to Import"),
			).toBeInTheDocument();
		});

		rerender({ show: false, onClose: vi.fn(), projects: [] });
		rerender({ show: true, onClose: vi.fn(), projects: [] });

		await waitFor(() => {
			expect(
				screen.getByText("Import ChatGPT Conversations"),
			).toBeInTheDocument();
		});
	});
	describe("which conversations it imports", () => {
		async function openPreview(
			props: { projects?: unknown[]; dropLabel?: string } = {},
		) {
			render(ImportChatGPTModal, {
				props: {
					show: true,
					onClose: vi.fn(),
					projects: (props.projects ?? []) as never[],
				},
			});
			await fireEvent.drop(
				screen.getByRole("button", {
					name: props.dropLabel ?? "Drop ZIP file here",
				}),
				{ dataTransfer: { files: [createZipFile()] } },
			);
			await screen.findByText("Chat One");
		}

		const aProject = {
			id: "proj-1",
			name: "My Project",
			sortOrder: 0,
			hasInstructions: false,
			createdAt: 1,
			updatedAt: 2,
		};

		it("sends the conversations that are ticked, named as the export names them", async () => {
			await openPreview();

			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 2 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			// conversation_id where the export has one, else its id.
			expect(importChatGPTData).toHaveBeenCalledWith(
				expect.any(File),
				["conv-1", "conv-2"],
				null,
			);
		});

		it("leaves out the conversation that was unticked", async () => {
			await openPreview();

			await fireEvent.click(screen.getByLabelText(/Chat Two/));
			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 1 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			expect(importChatGPTData).toHaveBeenCalledWith(
				expect.any(File),
				["conv-1"],
				null,
			);
		});

		it("keeps an unticked conversation out even when a search hides it", async () => {
			await openPreview();

			await fireEvent.click(screen.getByLabelText(/Chat One/));
			await fireEvent.input(
				screen.getByPlaceholderText("Search conversations..."),
				{
					target: { value: "Two" },
				},
			);
			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 1 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			expect(importChatGPTData).toHaveBeenCalledWith(
				expect.any(File),
				["conv-2"],
				null,
			);
		});

		it("sends the project it was given along with the selection", async () => {
			await openPreview({ projects: [aProject] });

			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.change(await screen.findByLabelText("Project folder"), {
				target: { value: "proj-1" },
			});
			await fireEvent.click(
				screen.getByRole("button", { name: "Import 2 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			expect(importChatGPTData).toHaveBeenCalledWith(
				expect.any(File),
				["conv-1", "conv-2"],
				"proj-1",
			);
		});

		it("cannot go on, or import, while nothing is ticked", async () => {
			await openPreview();

			await fireEvent.click(
				screen.getByRole("button", { name: "Deselect all" }),
			);

			expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
			expect(importChatGPTData).not.toHaveBeenCalled();
		});

		it("uploads the ticked conversations alone, never the export as it was dropped", async () => {
			await openPreview();

			await fireEvent.click(screen.getByLabelText(/Chat Two/));
			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 1 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			expect(packChatGPTUpload).toHaveBeenCalledWith(mockConversations, [
				"conv-1",
			]);
			expect(importChatGPTData).toHaveBeenCalledWith(
				PACKED_UPLOAD,
				["conv-1"],
				null,
			);
		});

		it("leaves a conversation out of the list when the export gives it no id", async () => {
			exportedConversations = [
				...mockConversations,
				{
					title: "Nameless",
					create_time: 1700002000,
					update_time: 1700002100,
					mapping: {
						"msg-9": { message: { id: "msg-9" }, parent: null, children: [] },
					},
				},
			];

			await openPreview();

			expect(screen.queryByText("Nameless")).not.toBeInTheDocument();
			expect(screen.getByText(/conversations found/)).toHaveTextContent(
				"2 conversations found",
			);
		});
	});

	describe("ChatGPT projects", () => {
		// A late-2026 export records a chat's project only as the project's id.
		const PROJECT_A = "g-p-0123456789abcdef0123456789abcdef";
		const PROJECT_B = "g-p-fedcba9876543210fedcba9876543210";

		function chat(id: string, title: string, projectId: string | null) {
			return {
				id,
				conversation_id: id,
				conversation_template_id: projectId,
				title,
				create_time: 1700000000,
				update_time: 1700000100,
				mapping: {
					m: { message: { id: "m" }, parent: null, children: [] },
				},
			};
		}

		const projectExport = [
			chat("conv-a1", "Alpha one", PROJECT_A),
			chat("conv-loose", "Loose chat", null),
			chat("conv-b1", "Beta one", PROJECT_B),
			chat("conv-a2", "Alpha two", PROJECT_A),
			// A custom GPT's chat: its template is a GPT, not a folder.
			chat("conv-gpt", "GPT chat", "g-abc123"),
		];

		async function openProjectPreview(dropLabel = "Drop ZIP file here") {
			exportedConversations = projectExport;
			render(ImportChatGPTModal, {
				props: { show: true, onClose: vi.fn(), projects: [] },
			});
			await fireEvent.drop(screen.getByRole("button", { name: dropLabel }), {
				dataTransfer: { files: [createZipFile()] },
			});
			await screen.findByText("Alpha one");
		}

		function projectBox(name: RegExp): HTMLInputElement {
			return screen.getByRole("checkbox", { name }) as HTMLInputElement;
		}

		it("puts each project's chats under a numbered heading, and says why it is numbered", async () => {
			await openProjectPreview();

			const headings = screen
				.getAllByTestId("chatgpt-import-group")
				.map((group) => group.textContent?.replace(/\s+/g, " ").trim());
			expect(headings).toEqual([
				"ChatGPT project 1 2 conversations",
				"ChatGPT project 2 1 conversation",
				"Not in a project 2 conversations",
			]);
			expect(
				screen.getByText(
					"ChatGPT's export doesn't include project names, so they're numbered here. Untick a project to leave all of its conversations out.",
				),
			).toBeInTheDocument();
		});

		it("leaves out every chat of a project whose box is unticked", async () => {
			await openProjectPreview();

			await fireEvent.click(projectBox(/ChatGPT project 1/));
			expect(
				(screen.getByLabelText(/Alpha one/) as HTMLInputElement).checked,
			).toBe(false);
			expect(
				(screen.getByLabelText(/Alpha two/) as HTMLInputElement).checked,
			).toBe(false);
			await fireEvent.click(screen.getByRole("button", { name: "Next" }));
			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 3 selected" }),
			);

			await waitFor(() => expect(importChatGPTData).toHaveBeenCalledTimes(1));
			expect(importChatGPTData).toHaveBeenCalledWith(
				PACKED_UPLOAD,
				["conv-loose", "conv-b1", "conv-gpt"],
				null,
			);
			expect(packChatGPTUpload).toHaveBeenCalledWith(projectExport, [
				"conv-loose",
				"conv-b1",
				"conv-gpt",
			]);
		});

		it("shows a project as partly ticked when only some of its chats are, and ticks them all when pressed", async () => {
			await openProjectPreview();

			await fireEvent.click(screen.getByLabelText(/Alpha two/));
			const box = projectBox(/ChatGPT project 1/);
			expect(box.checked).toBe(false);
			expect(box.indeterminate).toBe(true);

			await fireEvent.click(box);
			expect(box.checked).toBe(true);
			expect(box.indeterminate).toBe(false);
			expect(
				(screen.getByLabelText(/Alpha two/) as HTMLInputElement).checked,
			).toBe(true);
		});

		it("acts on the whole project while a search hides some of its chats", async () => {
			await openProjectPreview();

			await fireEvent.input(
				screen.getByPlaceholderText("Search conversations..."),
				{ target: { value: "Alpha one" } },
			);
			expect(screen.queryByText("Alpha two")).not.toBeInTheDocument();
			expect(screen.queryByText("ChatGPT project 2")).not.toBeInTheDocument();
			await fireEvent.click(projectBox(/ChatGPT project 1/));
			await fireEvent.input(
				screen.getByPlaceholderText("Search conversations..."),
				{ target: { value: "" } },
			);

			expect(
				(screen.getByLabelText(/Alpha two/) as HTMLInputElement).checked,
			).toBe(false);
			expect(screen.getByText(/conversations found/)).toHaveTextContent(
				"5 conversations found · 3 selected",
			);
		});

		it("draws the list without headings when no chat is in a project", async () => {
			render(ImportChatGPTModal, {
				props: { show: true, onClose: vi.fn(), projects: [] },
			});
			await fireEvent.drop(
				screen.getByRole("button", { name: "Drop ZIP file here" }),
				{ dataTransfer: { files: [createZipFile()] } },
			);
			await screen.findByText("Chat One");

			expect(screen.queryByTestId("chatgpt-import-group")).toBeNull();
			expect(screen.queryByText(/project names/)).toBeNull();
		});

		it("says it in Hungarian for a Hungarian reader", async () => {
			uiLanguage.set("hu");
			await openProjectPreview("Ejtse ide a ZIP fájlt");

			const headings = screen
				.getAllByTestId("chatgpt-import-group")
				.map((group) => group.textContent?.replace(/\s+/g, " ").trim());
			expect(headings).toEqual([
				"1. ChatGPT-projekt 2 beszélgetés",
				"2. ChatGPT-projekt 1 beszélgetés",
				"Projekten kívül 2 beszélgetés",
			]);
			expect(
				screen.getByText(
					"A ChatGPT exportja nem tartalmazza a projektek nevét, ezért itt sorszámot kapnak. Ha egy projekt kijelölését megszünteti, egyik beszélgetése sem kerül át.",
				),
			).toBeInTheDocument();
		});
	});

	describe("what it says", () => {
		async function reachTheConfigStep(labels: { drop: string; next: string }) {
			render(ImportChatGPTModal, {
				props: { show: true, onClose: vi.fn(), projects: [] },
			});
			await fireEvent.drop(screen.getByRole("button", { name: labels.drop }), {
				dataTransfer: { files: [createZipFile()] },
			});
			await screen.findByText("Chat One");
			await fireEvent.click(screen.getByRole("button", { name: labels.next }));
		}

		const english = { drop: "Drop ZIP file here", next: "Next" };
		const hungarian = { drop: "Ejtse ide a ZIP fájlt", next: "Tovább" };

		it("counts what was found and what is ticked in the preview", async () => {
			render(ImportChatGPTModal, {
				props: { show: true, onClose: vi.fn(), projects: [] },
			});
			await fireEvent.drop(screen.getByRole("button", { name: english.drop }), {
				dataTransfer: { files: [createZipFile()] },
			});
			await screen.findByText("Chat One");

			const line = screen.getByText(/conversations found/);
			expect(line).toHaveTextContent("2 conversations found · 2 selected");

			await fireEvent.click(screen.getByLabelText(/Chat Two/));
			expect(line).toHaveTextContent("2 conversations found · 1 selected");
		});

		it("says how many conversations will be imported on the configuration step", async () => {
			await reachTheConfigStep(english);

			expect(
				await screen.findByText("2 conversations will be imported"),
			).toBeInTheDocument();
			expect(
				screen.queryByText(/messages conversations/),
			).not.toBeInTheDocument();
		});

		it("says 'conversation' for one", async () => {
			exportedConversations = [mockConversations[0]];
			vi.mocked(importChatGPTData).mockResolvedValueOnce({
				jobId: "job-1",
				conversationIds: ["conv-1"],
				errors: [],
			});
			await reachTheConfigStep(english);

			expect(
				await screen.findByText("1 conversation will be imported"),
			).toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: "Import 1 selected" }),
			);

			expect(
				await screen.findByText("1 conversation imported successfully."),
			).toBeInTheDocument();
		});

		it("says how many conversations were imported, and how many errors there were", async () => {
			vi.mocked(importChatGPTData).mockResolvedValueOnce({
				jobId: "job-1",
				conversationIds: ["conv-1", "conv-2"],
				errors: [{ reason: "a" }, { reason: "b" }],
			});
			await reachTheConfigStep(english);

			await fireEvent.click(
				await screen.findByRole("button", { name: "Import 2 selected" }),
			);

			expect(
				await screen.findByText("2 conversations imported successfully."),
			).toBeInTheDocument();
			expect(screen.getByText("2 errors occurred.")).toBeInTheDocument();
		});

		it("says all of it in Hungarian for a Hungarian reader", async () => {
			uiLanguage.set("hu");
			vi.mocked(importChatGPTData).mockResolvedValueOnce({
				jobId: "job-1",
				conversationIds: ["conv-1", "conv-2"],
				errors: [{ reason: "a" }],
			});
			render(ImportChatGPTModal, {
				props: { show: true, onClose: vi.fn(), projects: [] },
			});
			await fireEvent.drop(
				screen.getByRole("button", { name: hungarian.drop }),
				{ dataTransfer: { files: [createZipFile()] } },
			);
			await screen.findByText("Chat One");

			expect(screen.getByText(/beszélgetés található/)).toHaveTextContent(
				"2 beszélgetés található · 2 kijelölve",
			);

			await fireEvent.click(
				screen.getByRole("button", { name: hungarian.next }),
			);
			expect(
				await screen.findByText("2 beszélgetés lesz importálva"),
			).toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: "2 kijelölt importálása" }),
			);
			expect(
				await screen.findByText("2 beszélgetés sikeresen importálva."),
			).toBeInTheDocument();
			expect(screen.getByText("1 hiba történt.")).toBeInTheDocument();
		});
	});
});
