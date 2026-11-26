// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import { uiLanguage } from "$lib/stores/settings";
import FileProductionCard from "./FileProductionCard.svelte";

const { prewarmDocumentPreviewMock } = vi.hoisted(() => ({
	prewarmDocumentPreviewMock: vi.fn(),
}));

vi.mock("$lib/client/document-preview-prewarm", () => ({
	prewarmDocumentPreview: prewarmDocumentPreviewMock,
}));

function makeJob(overrides: Partial<FileProductionJob>): FileProductionJob {
	return {
		id: "job-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		title: "Quarterly report",
		status: "queued",
		stage: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		sourceMode: null,
		...overrides,
	};
}

describe("FileProductionCard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
	});

	it("renders an active running job as a status line, progress sweep and a Stop action", async () => {
		// Unified tool activity rows — this component is now only the BODY of a
		// file-production activity row: the job title and its "Creating …" verb
		// live on the row above it, so they are deliberately absent here.
		const onCancel = vi.fn();
		const created = 1_700_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(created + 75_000);
		try {
			const { container, getByRole, getByText, queryByText } = render(
				FileProductionCard,
				{
					job: makeJob({ status: "running", createdAt: created }),
					onCancel,
				},
			);

			expect(queryByText("Quarterly report")).toBeNull();
			expect(
				getByText("Generating files in the background."),
			).toBeInTheDocument();
			// Elapsed timer formatted as m:ss (75s -> 1:15) with tabular-nums.
			expect(getByText("1:15")).toBeInTheDocument();
			// Animated sweep progress track present.
			expect(container.querySelector(".track")).toBeInTheDocument();
			// Body is still marked busy.
			expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
			// No resolved-only copy leaks through.
			expect(queryByText("No files yet")).toBeNull();
			expect(queryByText("Waiting for the file worker.")).toBeNull();

			// Cancel is a compact "Stop" mini-button.
			await fireEvent.click(
				getByRole("button", { name: "Stop file production" }),
			);
			expect(onCancel).toHaveBeenCalledWith("job-1");
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders the stale honesty state (amber heading) for a running job older than 90s", () => {
		const created = 1_700_000_000_000;
		vi.useFakeTimers();
		vi.setSystemTime(created + 91_000);
		try {
			const { getByText, queryByText } = render(FileProductionCard, {
				job: makeJob({ status: "running", createdAt: created }),
			});

			expect(getByText("Still working… or stalled.")).toBeInTheDocument();
			expect(getByText("We’ll know in a moment.")).toBeInTheDocument();
			// Producing label is replaced by the stale honesty copy.
			expect(queryByText("Producing")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders a retryable failed job with its safe error and retry action", async () => {
		const onRetry = vi.fn();
		const { getByRole, getByText } = render(FileProductionCard, {
			job: makeJob({
				status: "failed",
				error: {
					code: "renderer_timeout",
					message: "Renderer timed out.",
					retryable: true,
				},
			}),
			onRetry,
		});

		// The "Couldn’t produce this file" eyebrow is gone: the failure now
		// reads on the activity row itself (red cross + "Failed"), and the body
		// carries only the reason.
		expect(getByText("Making the file took too long.")).toBeInTheDocument();

		await fireEvent.click(getByRole("button", { name: "Retry" }));

		expect(onRetry).toHaveBeenCalledWith("job-1");
	});

	// A job the ledger reclaimed after a restart, a lost worker, or a queue
	// timeout used to fall through ERROR_MESSAGE_KEYS and show the raw server
	// string. All three write `retryable: true`, so the card must still offer
	// Retry, exactly like any other retryable failure.
	it.each([
		[
			"worker_heartbeat_timeout",
			"File production worker stopped before finishing.",
			"The file could not be finished because the server restarted while it was working.",
		],
		[
			"worker_state_lost",
			"File production worker state was lost before finishing.",
			"The file could not be finished because the server lost track of the job.",
		],
		[
			"worker_queue_timeout",
			"File production worker did not start before the queue timeout.",
			"The file waited too long in the queue and could not be finished.",
		],
	])(
		"localizes the %s worker-reclaim error and still offers Retry",
		async (code, rawServerMessage, localizedMessage) => {
			const onRetry = vi.fn();
			const { getByRole, getByText, queryByText } = render(FileProductionCard, {
				job: makeJob({
					status: "failed",
					error: { code, message: rawServerMessage, retryable: true },
				}),
				onRetry,
			});

			expect(getByText(localizedMessage)).toBeInTheDocument();
			expect(queryByText(rawServerMessage)).toBeNull();

			await fireEvent.click(getByRole("button", { name: "Retry" }));
			expect(onRetry).toHaveBeenCalledWith("job-1");
		},
	);

	it("renders a non-retryable failed job with the cause and a Dismiss action", async () => {
		const onDismiss = vi.fn();
		const { getByRole, getByText } = render(FileProductionCard, {
			job: makeJob({
				status: "failed",
				error: {
					code: "sandbox_timeout",
					message: "Program execution timed out.",
					retryable: false,
				},
			}),
			onDismiss,
		});

		expect(getByText("Making the file took too long.")).toBeInTheDocument();

		await fireEvent.click(
			getByRole("button", { name: "Dismiss file production" }),
		);

		expect(onDismiss).toHaveBeenCalledWith("job-1");
	});

	it("uses localized safe text for known limit errors instead of raw diagnostics", () => {
		const { getByText, queryByText } = render(FileProductionCard, {
			job: makeJob({
				status: "failed",
				error: {
					code: "too_many_outputs",
					message: "limit=5 actual=6",
					retryable: false,
				},
			}),
		});

		expect(
			getByText("That's more files than one request can make."),
		).toBeInTheDocument();
		expect(queryByText("limit=5 actual=6")).toBeNull();
	});

	// Intake refuses a program-mode request that names no output type, or one it
	// cannot produce, and writes a failed job — so both codes reach this card
	// and must not surface the raw, English, model-facing server message.
	it.each([
		[
			"missing_program_output_type",
			"outputType is required for program mode, e.g. xlsx, docx, pptx, pdf, csv, zip",
			"The file request did not say which file type to produce.",
			"A fájlkérés nem adta meg, milyen típusú fájl készüljön.",
		],
		[
			"unsupported_program_output_type",
			"Output type bogus is not supported. Use one of: xlsx, docx, pptx, pdf, csv, zip",
			"That kind of file can't be made here.",
			"Ilyen fájl itt nem készíthető.",
		],
	])(
		"localizes the %s intake refusal instead of showing the model-facing text",
		(code, serverMessage, english, hungarian) => {
			const job = makeJob({
				status: "failed",
				error: { code, message: serverMessage, retryable: false },
			});

			const en = render(FileProductionCard, { job });
			expect(en.getByText(english)).toBeInTheDocument();
			expect(en.queryByText(serverMessage)).toBeNull();
			en.unmount();

			uiLanguage.set("hu");
			const hu = render(FileProductionCard, { job });
			expect(hu.getByText(hungarian)).toBeInTheDocument();
			expect(hu.queryByText(serverMessage)).toBeNull();
		},
	);

	// The server writes a raw English message on a failed job, for the model and
	// the log. The card says the code's sentence and nothing else, in both
	// languages: every code the file maker writes has one, grouped where the cause
	// reads the same to a person.
	const RAW_MESSAGE =
		'Traceback (most recent call last): File "/srv/alfyai/run.py", line 9, in <module>';

	function failedWith(code: string, message = RAW_MESSAGE): FileProductionJob {
		return makeJob({
			status: "failed",
			error: { code, message, retryable: false },
		});
	}

	function expectOnlySentence(
		job: FileProductionJob,
		english: string,
		hungarian: string,
		label: string,
	) {
		uiLanguage.set("en");
		const en = render(FileProductionCard, { job });
		expect(en.getByText(english), `${label} in English`).toBeInTheDocument();
		expect(en.container.textContent).not.toContain("Traceback");
		en.unmount();
		uiLanguage.set("hu");
		const hu = render(FileProductionCard, { job });
		expect(
			hu.getByText(hungarian),
			`${label} in Hungarian`,
		).toBeInTheDocument();
		expect(hu.container.textContent).not.toContain("Traceback");
		hu.unmount();
	}

	it.each([
		[
			"a request the file maker cannot read",
			[
				"invalid_tool_input",
				"missing_file_production_request",
				"invalid_file_production_request",
				"unsupported_file_production_request",
				"invalid_inline_text_request",
				"missing_inline_text_content",
				"invalid_json_body",
				"missing_conversation_id",
				"missing_idempotency_key",
				"missing_request_title",
				"unsupported_source_mode",
				"invalid_program_language",
				"missing_program_source",
				"missing_program_requested_outputs",
				"mixed_output_groups",
			],
			"The file request couldn't be read.",
			"A fájlkérés nem olvasható.",
		],
		[
			"a problem in the file maker or its storage",
			[
				"program_execution_threw",
				"program_execution_failed",
				"program_output_storage_failed",
				"generated_document_source_persistence_failed",
				"inline_text_write_failed",
				"tool_execution_failed",
			],
			"The file maker ran into a problem.",
			"A fájlkészítő hibába ütközött.",
		],
		[
			"a program that made no file",
			["program_no_outputs", "file_production_no_output_files"],
			"The program made no file.",
			"A program nem készített fájlt.",
		],
		[
			"a program that made another file than the one asked for",
			[
				"program_output_type_mismatch",
				"program_output_filename_mismatch",
				"program_output_mime_mismatch",
				"program_output_signature_mismatch",
				"unexpected_program_output_files",
				"invalid_xlsx_output",
				"invalid_text_output",
				"xlsx_output_too_complex",
			],
			"The program didn't make the file that was asked for.",
			"A program nem a kért fájlt készítette el.",
		],
		[
			"a change that cannot be applied to the file",
			[
				"no_previous_version_for_patches",
				"patch_failed",
				"patch_not_applicable",
			],
			"The change couldn't be applied to the file.",
			"A fájlt nem sikerült a kért módon módosítani.",
		],
		[
			"as many files as one reply allows",
			["produce_file_turn_limit", "produce_file_turn_retry_limit"],
			"Alfy has made as many files as one reply allows.",
			"Alfy ebben a válaszban már annyi fájlt készített, amennyit lehet.",
		],
		[
			"a render the person stopped",
			["render_cancelled"],
			"You stopped this before it finished.",
			"Ezt leállítottad, mielőtt befejeződött.",
		],
		[
			"an inline text type that is not supported",
			["unsupported_inline_text_output_type"],
			"That kind of file can't be made here.",
			"Ilyen fájl itt nem készíthető.",
		],
		[
			"a spreadsheet that is too large to check",
			["xlsx_output_too_large"],
			"The file would be too large.",
			"A fájl túl nagy lenne.",
		],
	])(
		"says %s in its own words, in both languages",
		(_cause, codes, english, hungarian) => {
			for (const code of codes) {
				expectOnlySentence(failedWith(code), english, hungarian, code);
			}
		},
	);

	// Every limit, every kind of thing the file maker will not make and every
	// breakage reads as a plain sentence a person understands, in both languages:
	// no "projection", "renderer", "Unicode font" or "configured limit" (the words
	// of the developer who wrote the check), and the sentences the spec gives for
	// the limits and the timeouts word for word.
	it.each([
		[
			"too_many_outputs",
			"That's more files than one request can make.",
			"Ez több fájl, mint amennyi egy kérésre elkészülhet.",
		],
		[
			"source_too_large",
			"The source is too large to turn into a file.",
			"A forrás túl nagy ahhoz, hogy fájl készüljön belőle.",
		],
		[
			"renderer_timeout",
			"Making the file took too long.",
			"A fájl túl sokáig készült.",
		],
		[
			"sandbox_timeout",
			"Making the file took too long.",
			"A fájl túl sokáig készült.",
		],
		[
			"projection_too_large",
			"The document's text is too long.",
			"A dokumentum szövege túl hosszú.",
		],
		[
			"page_limit_exceeded",
			"The document would run to too many pages.",
			"A dokumentumnak túl sok oldala lenne.",
		],
		[
			"table_limit_exceeded",
			"A table is too big to put in a file.",
			"Egy táblázat túl nagy ahhoz, hogy fájlba kerüljön.",
		],
		[
			"chart_limit_exceeded",
			"A chart is too big to put in a file.",
			"Egy diagram túl nagy ahhoz, hogy fájlba kerüljön.",
		],
		[
			"image_limit_exceeded",
			"The file would have too many or too large pictures.",
			"A fájlban túl sok vagy túl nagy kép lenne.",
		],
		[
			"output_file_too_large",
			"The file would be too large.",
			"A fájl túl nagy lenne.",
		],
		[
			"job_outputs_too_large",
			"The files together would be too large.",
			"A fájlok együtt túl nagyok lennének.",
		],
		[
			"invalid_document_source",
			"The document couldn't be read.",
			"A dokumentumot nem sikerült beolvasni.",
		],
		[
			"unsupported_document_block",
			"Part of the document can't be put in a file here.",
			"A dokumentum egy része itt nem kerülhet fájlba.",
		],
		[
			"unsupported_table_structure",
			"That kind of table can't be made here.",
			"Ilyen táblázat itt nem készíthető.",
		],
		[
			"unsupported_chart_type",
			"That kind of chart can't be made here.",
			"Ilyen diagram itt nem készíthető.",
		],
		[
			"unsupported_chart_data",
			"A chart in the document can't be made from that data.",
			"A dokumentum egyik diagramja nem készíthető el ezekből az adatokból.",
		],
		[
			"unsupported_pdf_block",
			"Part of the document can't be put in a PDF yet.",
			"A dokumentum egy része még nem kerülhet PDF-be.",
		],
		[
			"unsupported_output_type",
			"That kind of file can't be made here.",
			"Ilyen fájl itt nem készíthető.",
		],
		[
			"pdf_font_missing",
			"The file needs a font that isn't installed.",
			"A fájlhoz hiányzik egy betűtípus.",
		],
		[
			"document_render_failed",
			"The document couldn't be turned into a file.",
			"A dokumentumból nem sikerült fájlt készíteni.",
		],
		[
			"tool_failed",
			"The file request failed before it could start.",
			"A fájlkérés nem sikerült, mielőtt elindulhatott volna.",
		],
	])(
		"says %s in plain words, in both languages",
		(code, english, hungarian) => {
			expectOnlySentence(failedWith(code), english, hungarian, code);
		},
	);

	it("never shows the message of a code it has no words for", () => {
		// A code from a newer server, a missing one, and the names an object lookup
		// would answer for (a plain map read would hand back a function).
		for (const code of [
			"a_code_from_a_newer_server",
			"",
			"constructor",
			"toString",
			"__proto__",
		]) {
			expectOnlySentence(
				failedWith(code),
				"The file couldn't be made.",
				"A fájlt nem sikerült elkészíteni.",
				`"${code}"`,
			);
		}
	});

	it("words the code even when the server sent no message with it", () => {
		const { getByText } = render(FileProductionCard, {
			job: failedWith("too_many_outputs", ""),
		});
		expect(
			getByText("That's more files than one request can make."),
		).toBeInTheDocument();
	});

	it("says the fallback for a failed job that carries no error at all", () => {
		const { getByText } = render(FileProductionCard, {
			job: makeJob({ status: "failed", error: null }),
		});
		expect(getByText("The file couldn't be made.")).toBeInTheDocument();
	});

	it("says a cancelled job was cancelled", () => {
		const { getByText } = render(FileProductionCard, {
			job: makeJob({ status: "cancelled", error: null }),
		});
		expect(getByText("This request was cancelled.")).toBeInTheDocument();
	});

	it("opens produced files with version and source fallbacks while background metadata sync catches up", async () => {
		const onOpenDocument = vi.fn();
		const { getByRole } = render(FileProductionCard, {
			job: makeJob({
				status: "succeeded",
				files: [
					{
						id: "file-1",
						filename: "report.pdf",
						mimeType: "application/pdf",
						sizeBytes: 2048,
						downloadUrl: "/api/chat/files/file-1/download",
						previewUrl: "/api/chat/files/file-1/preview",
						versionNumber: null,
					},
				],
			}),
			onOpenDocument,
		});

		await fireEvent.click(getByRole("button", { name: "Preview report.pdf" }));

		expect(onOpenDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "file-1",
				source: "chat_generated_file",
				versionNumber: 1,
				originConversationId: "conv-1",
				originAssistantMessageId: "assistant-1",
				sourceChatFileId: "file-1",
			}),
		);
	});

	// A `<a download>` is a NAVIGATION, so an expired session gets the 303 to
	// /login and the browser saves the login PAGE under the file's own name —
	// a `report.pdf` full of `<!DOCTYPE html>`, with nothing on screen to say
	// so. The anchor keeps its href (status bar, middle-click, keyboard) and
	// the plain left click goes through the shared helper first.
	describe("downloading with an expired session", () => {
		const succeeded = () =>
			makeJob({
				status: "succeeded",
				files: [
					{
						id: "file-1",
						filename: "report.pdf",
						mimeType: "application/pdf",
						sizeBytes: 2048,
						downloadUrl: "/api/chat/files/file-1/download",
						previewUrl: "/api/chat/files/file-1/preview",
						versionNumber: null,
					},
				],
			});

		it("writes no file when the session probe answers 401", async () => {
			const clicks: string[] = [];
			const realClick = HTMLAnchorElement.prototype.click;
			HTMLAnchorElement.prototype.click = function patched(
				this: HTMLAnchorElement,
			) {
				clicks.push(this.getAttribute("href") ?? "");
			};
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				}),
			);
			try {
				const { getByRole } = render(FileProductionCard, { job: succeeded() });
				const anchor = getByRole("link", { name: "Download report.pdf" });
				await fireEvent.click(anchor);
				await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
				// The anchor still advertises the real URL…
				expect(anchor.getAttribute("href")).toBe(
					"/api/chat/files/file-1/download",
				);
				// …and nothing was downloaded.
				expect(clicks).toEqual([]);
			} finally {
				HTMLAnchorElement.prototype.click = realClick;
				fetchSpy.mockRestore();
			}
		});

		it("downloads normally when the session is still good", async () => {
			const clicks: string[] = [];
			const realClick = HTMLAnchorElement.prototype.click;
			HTMLAnchorElement.prototype.click = function patched(
				this: HTMLAnchorElement,
			) {
				clicks.push(this.getAttribute("href") ?? "");
			};
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ error: "conversationId is required" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
			);
			try {
				const { getByRole } = render(FileProductionCard, { job: succeeded() });
				await fireEvent.click(
					getByRole("link", { name: "Download report.pdf" }),
				);
				await vi.waitFor(() =>
					expect(clicks).toEqual(["/api/chat/files/file-1/download"]),
				);
			} finally {
				HTMLAnchorElement.prototype.click = realClick;
				fetchSpy.mockRestore();
			}
		});
	});

	it("prewarms produced file previews on intent without opening until click", async () => {
		const onOpenDocument = vi.fn();
		const file = {
			id: "file-1",
			filename: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2048,
			downloadUrl: "/api/chat/files/file-1/download",
			previewUrl: "/api/chat/files/file-1/preview",
			versionNumber: null,
		};
		const { getByRole } = render(FileProductionCard, {
			job: makeJob({
				status: "succeeded",
				files: [file],
			}),
			onOpenDocument,
		});

		const previewButton = getByRole("button", { name: "Preview report.pdf" });

		await fireEvent.pointerEnter(previewButton);
		await fireEvent.focus(previewButton);
		await fireEvent.touchStart(previewButton);

		expect(prewarmDocumentPreviewMock).toHaveBeenCalledTimes(2);
		expect(prewarmDocumentPreviewMock).toHaveBeenCalledWith(file);
		expect(onOpenDocument).not.toHaveBeenCalled();

		await fireEvent.click(previewButton);
		expect(onOpenDocument).toHaveBeenCalledTimes(1);
	});

	it("uses Hungarian safe text for document render failures when the UI language is Hungarian", () => {
		uiLanguage.set("hu");
		const { getByText, queryByText, unmount } = render(FileProductionCard, {
			job: makeJob({
				status: "failed",
				error: {
					code: "unsupported_pdf_block",
					message: "table details leaked",
					retryable: false,
				},
			}),
		});

		expect(
			getByText("A dokumentum egy része még nem kerülhet PDF-be."),
		).toBeInTheDocument();
		expect(queryByText("table details leaked")).toBeNull();

		unmount();
		uiLanguage.set("en");
	});
});

// Polish G2-A: a produced file that was deleted says so, in the file's own row,
// with no Open or Download — and offers Regenerate where the job kept the
// request it was made from, or says why not.
describe("FileProductionCard — a deleted file", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiLanguage.set("en");
	});

	function deletedJob(canRegenerate = true) {
		return makeJob({
			status: "succeeded",
			title: "Trip summary",
			files: [],
			filesDeleted: { canRegenerate },
		});
	}

	it("names the file, says it was deleted, and offers no Open or Download", () => {
		const { getByTestId, getByText, queryByRole } = render(FileProductionCard, {
			job: deletedJob(),
		});

		const row = getByTestId("file-row-deleted");
		expect(row).toHaveTextContent("Trip summary");
		expect(getByText("The file has been deleted")).toBeInTheDocument();
		expect(queryByRole("button", { name: /Open/ })).toBeNull();
		expect(queryByRole("link")).toBeNull();
	});

	it("asks for the file to be made again by job id", async () => {
		const onRetry = vi.fn();
		const { getByRole } = render(FileProductionCard, {
			job: deletedJob(),
			onRetry,
		});

		await fireEvent.click(
			getByRole("button", { name: "Regenerate Trip summary" }),
		);

		expect(onRetry).toHaveBeenCalledWith("job-1");
	});

	it("says why it cannot be made again when the job kept no request", () => {
		const { getByText, queryByRole } = render(FileProductionCard, {
			job: deletedJob(false),
			onRetry: vi.fn(),
		});

		expect(
			getByText("It can't be regenerated: the original request wasn't kept."),
		).toBeInTheDocument();
		expect(queryByRole("button", { name: /Regenerate/ })).toBeNull();
	});

	it("speaks Hungarian", () => {
		uiLanguage.set("hu");
		const { getByText, getByRole } = render(FileProductionCard, {
			job: deletedJob(),
			onRetry: vi.fn(),
		});

		expect(getByText("A fájl törölve lett")).toBeInTheDocument();
		expect(
			getByRole("button", { name: "Trip summary újragenerálása" }),
		).toBeInTheDocument();
	});

	it("leaves a job that still has its files exactly as it was", () => {
		const { queryByTestId, getByTestId } = render(FileProductionCard, {
			job: makeJob({
				status: "succeeded",
				files: [
					{
						id: "file-1",
						filename: "Trip.pdf",
						mimeType: "application/pdf",
						sizeBytes: 2048,
						downloadUrl: "/api/chat/files/file-1/download",
						previewUrl: "/api/chat/files/file-1/preview",
						artifactId: null,
					},
				],
			}),
		});

		expect(queryByTestId("file-row-deleted")).toBeNull();
		expect(getByTestId("file-production-files")).toHaveTextContent("Trip.pdf");
	});
});
