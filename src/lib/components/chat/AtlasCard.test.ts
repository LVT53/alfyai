import {
	act,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { AtlasJobProgressDetails } from "$lib/server/services/atlas/types";
import type { AtlasAction, AtlasJobCard } from "$lib/types";
import AtlasCard from "./AtlasCard.svelte";

type AtlasJobProgressDetailsWithTitle = AtlasJobProgressDetails & {
	generatedTitle: string;
};

function atlasJobFixture(overrides: Partial<AtlasJobCard> = {}): AtlasJobCard {
	return {
		id: "atlas-job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		action: "create",
		parentAtlasJobId: null,
		profile: "in-depth",
		title: "Atlas research",
		status: "running",
		stage: "curate",
		progress: { percent: 42, stage: "curate", details: { queries: [] } },
		sourceCounts: { local: 2, web: 8, accepted: 6, rejected: 4 },
		usage: {
			inputTokens: 1200,
			outputTokens: 800,
			totalTokens: 2000,
			costUsdMicros: 250000,
		},
		outputs: {
			fileProductionJobId: "file-job-1",
			htmlChatGeneratedFileId: "html-file-1",
			pdfChatGeneratedFileId: "pdf-file-1",
			markdownChatGeneratedFileId: "md-file-1",
		},
		error: null,
		createdAt: 1,
		updatedAt: 2,
		completedAt: null,
		...overrides,
	};
}

describe("AtlasCard", () => {
	it("prefers a generated title from progress details over the default job title", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				title: "User query fallback",
				progress: {
					percent: 35,
					stage: "search",
					details: {
						queries: [],
						generatedTitle: "Generated Research Title",
					} as AtlasJobProgressDetailsWithTitle,
				},
			}),
		});

		expect(
			screen.getByRole("heading", { name: "Generated Research Title" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "User query fallback" }),
		).not.toBeInTheDocument();
	});

	it("renders running Atlas progress and emits cancel", async () => {
		const onCancel = vi.fn();
		render(AtlasCard, {
			job: atlasJobFixture(),
			onCancel,
		});

		expect(screen.getByTestId("atlas-card")).toHaveTextContent("ATLAS");
		expect(screen.getByText("42%")).toBeInTheDocument();
		expect(screen.getByText("Weighing source quality")).toBeInTheDocument();
		expect(screen.queryByText("Curating sources")).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole("button", { name: "Cancel Atlas" }));
		expect(onCancel).toHaveBeenCalledWith("atlas-job-1");
	});

	it("renders a determinate progress ring driven by completion percent only", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				progress: {
					percent: 64,
					stage: "synthesize",
					details: { queries: [] },
				},
			}),
		});

		const ring = screen
			.getByTestId("atlas-card")
			.querySelector(".atlas-card__ring");
		expect(ring).toHaveAttribute(
			"style",
			expect.stringContaining("--atlas-progress: 64%;"),
		);
		expect(ring?.getAttribute("style") ?? "").not.toContain(
			"--atlas-stage-progress",
		);
	});

	it("renders an animated progress-cycle icon for running Atlas jobs", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				progress: {
					percent: 64,
					stage: "synthesize",
					details: { queries: [] },
				},
			}),
		});

		const progressIcon = screen.getByTestId("atlas-progress-cycle-icon");
		expect(progressIcon).toHaveAttribute("viewBox", "0 0 56 56");
		expect(progressIcon).toHaveClass("progress-ring-spinner");
		expect(progressIcon).toHaveAttribute("width", "56");
		expect(progressIcon).toHaveAttribute("height", "56");
		expect(progressIcon.querySelector(".progress-ring-bg")).toBeTruthy();
		expect(progressIcon.querySelector(".progress-ring-fill")).toHaveAttribute(
			"style",
			expect.stringContaining("stroke-dashoffset: 54.288"),
		);
		expect(progressIcon.querySelector(".progress-ring-bg")).toHaveAttribute(
			"r",
			"24",
		);
		expect(progressIcon.querySelector(".progress-ring-fill")).toHaveAttribute(
			"stroke-dasharray",
			"150.8",
		);
		expect(
			progressIcon.querySelector(".atlas-card__progress-cycle-sweep"),
		).toBeNull();
		expect(
			screen.queryByTestId("atlas-exploration-svg"),
		).not.toBeInTheDocument();
	});

	it("rotates active progress messages without showing profile metadata", async () => {
		vi.useFakeTimers();
		try {
			render(AtlasCard, {
				job: atlasJobFixture(),
			});

			expect(screen.getByText("Weighing source quality")).toBeInTheDocument();
			expect(screen.queryByText("Curating sources")).not.toBeInTheDocument();
			expect(screen.queryByText("In-Depth")).not.toBeInTheDocument();

			await act(() => {
				vi.advanceTimersByTime(4200);
			});

			expect(screen.getByText("Sorting signal from noise")).toBeInTheDocument();

			await act(() => {
				vi.advanceTimersByTime(4200);
			});

			expect(
				screen.getByText("Choosing the strongest sources"),
			).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders the prototype exploration SVG for queued Atlas jobs", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				status: "queued",
				stage: "queued",
				progress: { percent: 0, stage: "queued", details: { queries: [] } },
			}),
		});

		const svg = screen.getByTestId("atlas-exploration-svg");
		expect(svg).toHaveAttribute("viewBox", "0 0 56 56");
		expect(svg).toHaveClass("exploration-svg");
		expect(svg).toHaveAttribute("width", "56");
		expect(svg).toHaveAttribute("height", "56");
		expect(svg.querySelector(".orbit-group")).toBeTruthy();
		expect(
			screen.getByText(
				"You can close this page - I'll notify you when it's ready.",
			),
		).toBeInTheDocument();
	});

	it("shows decomposed research questions in the active progress card", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				stage: "search",
				progress: {
					percent: 25,
					stage: "search",
					details: {
						queries: [
							"enterprise search retrieval architecture",
							"hybrid search evaluation methods",
						],
					},
				},
			}),
		});

		const queryRegion = screen.getByLabelText("Atlas research questions");
		expect(queryRegion).toHaveTextContent("Researching");
		expect(queryRegion).toHaveTextContent(
			"enterprise search retrieval architecture",
		);
		expect(queryRegion).toHaveTextContent("hybrid search evaluation methods");
	});

	it("renders the output rendering stage instead of falling back to generic running copy", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				stage: "render",
				progress: { percent: 97, stage: "render", details: { queries: [] } },
			}),
		});

		expect(screen.getByText("Preparing report files")).toBeInTheDocument();
		expect(screen.queryByText("Rendering outputs")).not.toBeInTheDocument();
		expect(screen.queryByText("Running research")).not.toBeInTheDocument();
	});

	it("renders coverage-review progress without leaking internal stage naming", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				stage: "coverage-review",
				progress: {
					percent: 50,
					stage: "coverage-review",
					details: { queries: [] },
				},
			}),
		});

		expect(screen.getByText("Checking evidence coverage")).toBeInTheDocument();
		expect(screen.queryByText("coverage-review")).not.toBeInTheDocument();
		expect(screen.queryByText(/research loop/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/deep research/i)).not.toBeInTheDocument();
	});

	it("renders bounded gap-fill progress with safe follow-up focus", () => {
		render(AtlasCard, {
			job: atlasJobFixture({
				stage: "search",
				progress: {
					percent: 58,
					stage: "search",
					details: {
						queries: ["2026 enterprise RAG cost benchmark official report"],
						roundKind: "gap-fill",
						focus: ["current cost evidence for enterprise RAG"],
					} as unknown as AtlasJobCard["progress"]["details"],
				},
			}),
		});

		expect(
			screen.getByText("Following up on evidence gaps"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Following promising leads"),
		).not.toBeInTheDocument();
		const focusRegion = screen.getByLabelText("Atlas evidence follow-up focus");
		expect(focusRegion).toHaveTextContent("Evidence follow-up");
		expect(focusRegion).toHaveTextContent(
			"current cost evidence for enterprise RAG",
		);
	});

	it("renders completed actions with Open as the only text button and grouped download options", async () => {
		const onOpenDocument = vi.fn();
		render(AtlasCard, {
			job: atlasJobFixture({
				status: "succeeded",
				title: "Generated Enterprise RAG Strategy",
				completedAt: 121,
			}),
			onOpenDocument,
		});

		expect(
			screen.getByRole("heading", {
				name: "Generated Enterprise RAG Strategy",
			}),
		).toBeInTheDocument();
		expect(screen.getByText("In-Depth")).toBeInTheDocument();
		expect(screen.getByText("6 sources")).toBeInTheDocument();
		expect(screen.getByText("$0.2500")).toBeInTheDocument();
		expect(screen.getByText("1s")).toBeInTheDocument();
		const actions = screen.getByTestId("atlas-completion-actions");
		expect(
			within(actions).getByRole("button", { name: "Open" }),
		).toHaveTextContent("Open");
		expect(
			within(actions)
				.getAllByRole("button")
				.filter((button) => button.textContent?.trim()),
		).toHaveLength(1);

		await fireEvent.click(screen.getByRole("button", { name: "Open" }));

		expect(onOpenDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "html-file-1",
				source: "chat_generated_file",
				title: "Generated Enterprise RAG Strategy",
				downloadUrl: "/api/chat/files/html-file-1/download",
				previewUrl: "/api/chat/files/html-file-1/preview",
				mimeType: "text/html",
			}),
			{ presentation: "expanded" },
		);

		expect(
			screen.queryByRole("link", { name: "Download PDF" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Download Markdown" }),
		).not.toBeInTheDocument();
		await fireEvent.click(
			screen.getByRole("button", { name: "Download Atlas" }),
		);
		const downloadMenu = screen.getByRole("menu", {
			name: "Download Atlas",
		});
		expect(
			within(downloadMenu).getByRole("menuitem", { name: "Download HTML" }),
		).toHaveAttribute("href", "/api/chat/files/html-file-1/download");
		expect(
			within(downloadMenu).getByRole("menuitem", { name: "Download PDF" }),
		).toHaveAttribute("href", "/api/chat/files/pdf-file-1/download");
		expect(
			within(downloadMenu).getByRole("menuitem", {
				name: "Download Markdown",
			}),
		).toHaveAttribute("href", "/api/chat/files/md-file-1/download");
		expect(
			screen.getByRole("button", { name: "Continue Atlas" }),
		).toHaveTextContent("");
		expect(
			screen.getByRole("button", { name: "Fork Atlas" }),
		).toHaveTextContent("");
		expect(
			screen.getByRole("button", { name: "Revise Atlas" }),
		).toHaveTextContent("");
	});

	it("exposes completion-card animation hooks for completed Atlas jobs", () => {
		render(AtlasCard, {
			job: atlasJobFixture({ status: "succeeded", completedAt: 121 }),
		});

		const card = screen.getByTestId("atlas-card");
		expect(card).toHaveClass("atlas-card--complete");
		expect(card).toHaveClass("atlas-card--completion-enter");
		expect(screen.getByTestId("atlas-completion-icon")).toBeInTheDocument();
		expect(
			screen.queryByTestId("atlas-progress-cycle-icon"),
		).not.toBeInTheDocument();
	});

	it.each([
		["continue", "Continue Atlas"] as const,
		["fork", "Fork Atlas"] as const,
		["revise", "Revise Atlas"] as const,
	])("opens an inline %s panel and emits the lifecycle action", async (action: AtlasAction, label: string) => {
		const onLifecycleAction = vi.fn();
		render(AtlasCard, {
			job: atlasJobFixture({ status: "succeeded", completedAt: 121 }),
			onLifecycleAction,
		});

		await fireEvent.click(screen.getByRole("button", { name: label }));
		const panel = screen.getByRole("region", { name: label });
		await fireEvent.input(within(panel).getByRole("textbox"), {
			target: { value: "Add source-quality detail" },
		});
		await fireEvent.click(within(panel).getByRole("button", { name: label }));

		expect(onLifecycleAction).toHaveBeenCalledWith({
			jobId: "atlas-job-1",
			action,
			message: "Add source-quality detail",
			profile: "in-depth",
		});
	});
});
