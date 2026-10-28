import { describe, expect, it } from "vitest";
import chatDict from "$lib/i18n/chat";
import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import {
	DOCUMENT_EXTRACTION_STATUSES,
	EXTRACTION_ERROR_CODES,
} from "$lib/shared/extraction-status";
import {
	attachmentChipFailure,
	attachmentChipKind,
	attachmentChipMeta,
	attachmentThumbnailUrl,
	buildOutlineQuote,
	extractionChipDashed,
	extractionChipState,
	extractionReasonKey,
	formatTokenCount,
	isExtractionPending,
	isPictureForModel,
	quoteChipLabel,
	splitUserMessageQuotes,
} from "./composer-chip-presentation";

describe("attachmentChipKind", () => {
	it("gives an image its own kind so the pill can wear a crop of itself", () => {
		expect(
			attachmentChipKind({
				name: "floor-plan-level-2.png",
				mimeType: "image/png",
			}),
		).toBe("image");
	});

	it("gives everything else the file mark", () => {
		expect(
			attachmentChipKind({
				name: "Lease agreement 2026.pdf",
				mimeType: "application/pdf",
			}),
		).toBe("file");
	});

	// The shelf mark is what separates a document you LINKED from the Library
	// from a file you just uploaded.
	it("gives a linked Library document the shelf mark", () => {
		expect(
			attachmentChipKind(
				{ name: "Employee handbook.docx", mimeType: null },
				{ linked: true },
			),
		).toBe("library");
	});
});

describe("attachmentChipMeta", () => {
	it("says pages and cost together when it knows both", () => {
		expect(
			attachmentChipMeta({
				name: "lease.pdf",
				pageCount: 24,
				pageCountKind: "physical",
				tokenEstimate: 18_400,
			}),
		).toEqual({ key: "composerChips.fileMeta", pages: "24", tokens: "18k" });
	});

	it("says whichever half it knows", () => {
		expect(
			attachmentChipMeta({
				name: "a.pdf",
				pageCount: 24,
				pageCountKind: "physical",
			}),
		).toEqual({ key: "composerChips.filePages", pages: "24" });
		expect(attachmentChipMeta({ name: "a.pdf", tokenEstimate: 900 })).toEqual({
			key: "composerChips.fileTokens",
			tokens: "900",
		});
	});

	// Task 17 (rehearsal): a sent photo's chip said "living-room.jpg · 5 tok".
	// A picture is seen, not read as text: its chip is its number and its name.
	it("says nothing about a picture's tokens or pages", () => {
		expect(
			attachmentChipMeta({
				name: "living-room.jpg",
				mimeType: "image/jpeg",
				tokenEstimate: 5,
			}),
		).toBeNull();
		expect(
			attachmentChipMeta({
				name: "scan.png",
				tokenEstimate: 1_200,
				pageCount: 1,
				pageCountKind: "physical",
			}),
		).toBeNull();
	});

	it("says nothing rather than zero", () => {
		expect(attachmentChipMeta({ name: "a.pdf" })).toBeNull();
		expect(
			attachmentChipMeta({ name: "a.pdf", pageCount: 0, tokenEstimate: 0 }),
		).toBeNull();
	});

	it("counts a deck in slides and a workbook in sheets", () => {
		// The chip said "12 pp" for a PowerPoint and "3 pp" for an Excel file,
		// because the only thing it was ever given was the number.
		expect(
			attachmentChipMeta({
				name: "kickoff.pptx",
				pageCount: 12,
				pageCountKind: "slide",
			}),
		).toEqual({ key: "composerChips.fileSlides", pages: "12" });
		expect(
			attachmentChipMeta({
				name: "budget.xlsx",
				pageCount: 3,
				pageCountKind: "sheet",
				tokenEstimate: 2_400,
			}),
		).toEqual({
			key: "composerChips.fileSheetsMeta",
			pages: "3",
			tokens: "2k",
		});
	});

	it("calls an EPUB's spine pages", () => {
		expect(
			attachmentChipMeta({
				name: "novel.epub",
				pageCount: 41,
				pageCountKind: "spine",
			}),
		).toEqual({ key: "composerChips.filePages", pages: "41" });
	});

	it("shows no count for a kind that counts nothing a reader can turn to", () => {
		// `declared` is what DOCX reports and it is routinely 1 for a document
		// with four headings; `logical` is CSV's and HTML's. Neither is a page.
		for (const kind of ["declared", "logical", "unknown"]) {
			expect(
				attachmentChipMeta({
					name: "a.docx",
					pageCount: 9,
					pageCountKind: kind,
				}),
			).toBeNull();
		}
		// And a token clause still survives on its own.
		expect(
			attachmentChipMeta({
				name: "a.docx",
				pageCount: 9,
				pageCountKind: "declared",
				tokenEstimate: 900,
			}),
		).toEqual({ key: "composerChips.fileTokens", tokens: "900" });
	});

	it("shows no count when the kind is unknown, rather than guessing pages", () => {
		// Every document parsed before the structured extractor. The absence IS
		// the signal; defaulting it to "physical" would relabel the whole
		// library on the day this shipped.
		expect(attachmentChipMeta({ name: "old.pdf", pageCount: 12 })).toBeNull();
		expect(
			attachmentChipMeta({
				name: "old.pdf",
				pageCount: 12,
				pageCountKind: null,
			}),
		).toBeNull();
	});

	it("shows a single physical page but not a single slide or sheet", () => {
		expect(
			attachmentChipMeta({
				name: "receipt.pdf",
				pageCount: 1,
				pageCountKind: "physical",
			}),
		).toEqual({ key: "composerChips.filePages", pages: "1" });
		for (const kind of ["slide", "sheet", "spine"]) {
			expect(
				attachmentChipMeta({ name: "x", pageCount: 1, pageCountKind: kind }),
			).toBeNull();
		}
	});
});

describe("formatTokenCount", () => {
	it("compacts the way the old two-line cost card did", () => {
		expect(formatTokenCount(940)).toBe("940");
		expect(formatTokenCount(18_400)).toBe("18k");
		expect(formatTokenCount(2_400_000)).toBe("2M");
	});
});

describe("attachmentThumbnailUrl", () => {
	it("points an image chip at the existing preview endpoint", () => {
		expect(
			attachmentThumbnailUrl({
				id: "artifact-1",
				name: "photo.png",
				mimeType: "image/png",
			}),
		).toBe("/api/knowledge/artifact-1/preview");
	});

	it("escapes an id rather than splicing it into a path raw", () => {
		expect(
			attachmentThumbnailUrl({
				id: "a/b",
				name: "photo.png",
				mimeType: "image/png",
			}),
		).toBe("/api/knowledge/a%2Fb/preview");
	});

	it("is null for a non-image and for an artifact with no id yet", () => {
		expect(
			attachmentThumbnailUrl({
				id: "artifact-1",
				name: "lease.pdf",
				mimeType: "application/pdf",
			}),
		).toBeNull();
		expect(
			attachmentThumbnailUrl({ name: "photo.png", mimeType: "image/png" }),
		).toBeNull();
	});
});

describe("quoteChipLabel", () => {
	it("keeps the section heading and leaves the document's prose out", () => {
		expect(
			quoteChipLabel(
				"2.3 Break clause: Either party may terminate on six months' notice…",
			),
		).toBe("2.3 Break clause");
	});

	it("falls back to the whole quote when there is no heading clause", () => {
		expect(quoteChipLabel("  A heading with no colon  ")).toBe(
			"A heading with no colon",
		);
	});
});

describe("splitUserMessageQuotes", () => {
	const OUTLINE = [
		{ title: "2.3 Break clause", preview: "Either party may terminate" },
		{ title: "4.1 Service charge", preview: "The tenant pays" },
		{ title: "Summary", preview: "" },
	];

	it("builds the quote the outline row produces, and nothing else", () => {
		expect(
			buildOutlineQuote({
				title: "2.3 Break clause",
				preview: "Either party may terminate",
			}),
		).toBe("2.3 Break clause: Either party may terminate…");
		expect(buildOutlineQuote({ title: "Summary", preview: "  " })).toBe(
			"Summary",
		);
	});

	it("peels a sent quote back off the front of the message", () => {
		expect(
			splitUserMessageQuotes(
				"2.3 Break clause: Either party may terminate…\n\nCan we get out of this early?",
				OUTLINE,
			),
		).toEqual({
			quoteLabels: ["2.3 Break clause"],
			body: "Can we get out of this early?",
		});
	});

	it("peels several, in the order they were picked", () => {
		expect(
			splitUserMessageQuotes(
				"4.1 Service charge: The tenant pays…\n\n2.3 Break clause: Either party may terminate…\n\nWhat do we owe?",
				OUTLINE,
			),
		).toEqual({
			quoteLabels: ["4.1 Service charge", "2.3 Break clause"],
			body: "What do we owe?",
		});
	});

	it("handles a turn that was nothing but a quote", () => {
		expect(
			splitUserMessageQuotes(
				"2.3 Break clause: Either party may terminate…",
				OUTLINE,
			),
		).toEqual({ quoteLabels: ["2.3 Break clause"], body: "" });
	});

	it("recognises a bare-title quote from an entry with no preview", () => {
		expect(
			splitUserMessageQuotes("Summary\n\nShorter please.", OUTLINE),
		).toEqual({ quoteLabels: ["Summary"], body: "Shorter please." });
	});

	// The safe direction to fail: a quote shown as prose is a cosmetic miss;
	// prose eaten as a quote would lose the user's own words.
	it("leaves prose alone when nothing matches a persisted outline quote", () => {
		const content = "Break clause: what does it say?\n\nAnd the rest.";
		expect(splitUserMessageQuotes(content, OUTLINE)).toEqual({
			quoteLabels: [],
			body: content,
		});
	});

	// The heading alone is not enough: the user's own "2.3 Break clause: is
	// this enforceable?" shares a heading with the outline entry but is not
	// the quote the outline built, so it stays their sentence.
	it("does not eat a sentence that merely starts with a heading and a colon", () => {
		const content =
			"2.3 Break clause: is this enforceable?\n\nI need to know by Friday.";
		expect(splitUserMessageQuotes(content, OUTLINE)).toEqual({
			quoteLabels: [],
			body: content,
		});
	});

	it("does not eat a paragraph the quote merely prefixes", () => {
		const content =
			"2.3 Break clause: Either party may terminate… and then some words of mine\n\nRight?";
		expect(splitUserMessageQuotes(content, OUTLINE)).toEqual({
			quoteLabels: [],
			body: content,
		});
	});

	it("leaves the message untouched when the attachment has no outline", () => {
		const content =
			"2.3 Break clause: Either party may terminate…\n\nAnything?";
		expect(splitUserMessageQuotes(content, [])).toEqual({
			quoteLabels: [],
			body: content,
		});
	});

	it("stops at the first block that is not a quote", () => {
		expect(
			splitUserMessageQuotes(
				"2.3 Break clause: Either party may terminate…\n\nSome prose\n\n4.1 Service charge: The tenant pays…",
				OUTLINE,
			),
		).toEqual({
			quoteLabels: ["2.3 Break clause"],
			body: "Some prose\n\n4.1 Service charge: The tenant pays…",
		});
	});
});

function job(
	overrides: Partial<DocumentExtractionJobDTO> = {},
): DocumentExtractionJobDTO {
	return {
		id: "job-1",
		sourceArtifactId: "artifact-1",
		normalizedArtifactId: null,
		status: "queued",
		intakeRoute: "mineru",
		fileName: "lease.pdf",
		attemptCount: 0,
		maxAttempts: 3,
		retryable: false,
		cancelable: true,
		error: null,
		createdAt: 0,
		updatedAt: 0,
		startedAt: null,
		legacy: false,
		...overrides,
	};
}

describe("extractionChipState", () => {
	it("says nothing at all without a DTO, exactly as the chip did before", () => {
		expect(extractionChipState(null)).toEqual({
			progressKey: null,
			errorKey: null,
			dashed: false,
			canRetry: false,
			canCancel: false,
		});
		expect(extractionChipState(undefined).dashed).toBe(false);
	});

	it("puts progress in the muted meta and leaves the danger clause empty", () => {
		for (const status of [
			"queued",
			"uploading",
			"parsing",
			"downloading",
			"indexing",
		] as const) {
			const state = extractionChipState(job({ status }));
			expect(state.progressKey, status).not.toBeNull();
			expect(state.errorKey, status).toBeNull();
			expect(state.dashed, status).toBe(true);
			expect(state.canCancel, status).toBe(true);
			expect(state.canRetry, status).toBe(false);
		}
	});

	// Ruling 1. A job queued behind an outage backoff is still going to be
	// read — the worker re-drains at `nextAttemptAt` with no user action — so
	// this stays a progress clause rather than a red failure. What it must not
	// do is say "Waiting to be read" for half an hour while a backend is down:
	// that reads as a stuck app and sends the user looking for a button.
	it("says the document service is unreachable while it waits for it", () => {
		const waiting = job({
			status: "queued",
			error: { code: "unavailable", message: "unreachable" },
			nextAttemptAt: 60_000,
		});

		const state = extractionChipState(waiting);
		expect(state.progressKey).toBe("chat.extraction.waitingForBackend");
		expect(state.errorKey).toBeNull();
		expect(state.canRetry).toBe(false);
		expect(state.dashed).toBe(true);

		// The send gate's per-attachment row says the same thing, from the same
		// table, so one file is never described two different ways.
		expect(
			extractionReasonKey({
				status: "queued",
				errorCode: "unavailable",
				retryable: false,
			}),
		).toBe("chat.extraction.waitingForBackend");
	});

	it("keeps the ordinary queued clause for a job nobody has reached yet", () => {
		expect(extractionChipState(job({ status: "queued" })).progressKey).toBe(
			"chat.extraction.queued",
		);
		// A retryable DOCUMENT failure waiting out its backoff is not an outage.
		expect(
			extractionChipState(
				job({
					status: "queued",
					error: { code: "job_failed", message: "engine failed" },
				}),
			).progressKey,
		).toBe("chat.extraction.queued");
	});

	it("collapses the three in-flight phases into one honest clause", () => {
		// "uploading", "parsing" and "downloading" are the extractor's own
		// bookkeeping; to the person waiting they are one thing.
		const keys = (["uploading", "parsing", "downloading"] as const).map(
			(status) => extractionChipState(job({ status })).progressKey,
		);
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toBe("chat.extraction.parsing");
		expect(extractionChipState(job({ status: "indexing" })).progressKey).toBe(
			"chat.extraction.indexing",
		);
	});

	it("offers no controls and no clause once the document is attached", () => {
		expect(extractionChipState(job({ status: "succeeded" }))).toEqual({
			progressKey: null,
			errorKey: null,
			dashed: false,
			canRetry: false,
			canCancel: false,
		});
	});

	it("leads a retryable failure with the offer rather than the cause", () => {
		const state = extractionChipState(
			job({
				status: "failed",
				retryable: true,
				cancelable: false,
				error: { code: "max_attempts", message: "gave up" },
			}),
		);
		expect(state.errorKey).toBe("chat.extraction.failedRetry");
		expect(state.canRetry).toBe(true);
		expect(state.canCancel).toBe(false);
		expect(state.dashed).toBe(false);
	});

	it("names the cause when a retry cannot help", () => {
		const state = extractionChipState(
			job({
				status: "failed",
				retryable: false,
				cancelable: false,
				error: { code: "too_large", message: "8 MiB cap" },
			}),
		);
		expect(state.errorKey).toBe("chat.extraction.error.too_large");
		expect(state.canRetry).toBe(false);
	});

	it("falls back to a generic clause for a failure with no code", () => {
		expect(
			extractionChipState(
				job({ status: "failed", retryable: false, cancelable: false }),
			).errorKey,
		).toBe("chat.extraction.failed");
	});

	it("reports a stopped job without offering to stop it again", () => {
		const state = extractionChipState(
			job({ status: "canceled", cancelable: false, retryable: false }),
		);
		expect(state.errorKey).toBe("chat.extraction.canceled");
		expect(state.canCancel).toBe(false);
		expect(state.dashed).toBe(false);
	});

	it("offers Retry on a stopped job, because stopping is undoable", () => {
		const state = extractionChipState(
			job({ status: "canceled", cancelable: false, retryable: true }),
		);
		expect(state.canRetry).toBe(true);
		expect(state.errorKey).toBe("chat.extraction.canceledRetry");
		expect(state.canCancel).toBe(false);
	});

	it("never offers Cancel for a job that already asked to be canceled", () => {
		expect(
			extractionChipState(job({ status: "parsing", cancelable: false }))
				.canCancel,
		).toBe(false);
	});

	// Both halves of the mapping resolve in both languages: a key the chip can
	// emit but the dictionary does not carry prints itself in the composer.
	it("only ever emits keys both dictionaries carry", () => {
		const emitted = new Set<string>();
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			for (const retryable of [true, false]) {
				for (const code of [...EXTRACTION_ERROR_CODES, null]) {
					const state = extractionChipState(
						job({
							status,
							retryable: status === "failed" && retryable,
							error: code ? { code, message: "" } : null,
						}),
					);
					if (state.progressKey) emitted.add(state.progressKey);
					if (state.errorKey) emitted.add(state.errorKey);
				}
			}
		}

		expect(emitted.size).toBeGreaterThan(0);
		for (const key of emitted) {
			for (const lang of ["en", "hu"] as const) {
				expect(
					typeof chatDict[lang][key as keyof (typeof chatDict)[typeof lang]],
					`${lang}.${key}`,
				).toBe("string");
			}
		}
	});
});

// A model that can see needs no extracted text to be shown a picture. For such
// a model, a photo the reader found no text in is not a failure: the chip says
// so as a plain fact and Send stays open. The rule is the send gate's own
// (`isSeeableImage`: a picture the server can decode), so the chip never opens
// Send for a picture the server would then refuse. Everything else is judged
// as it always was, and so is every attachment under a model that cannot see.
describe("a picture the selected model will be shown", () => {
	const SEES = { selectedModelSupportsImages: true };
	const BLIND = { selectedModelSupportsImages: false };

	const photo = { name: "photo.jpg", mimeType: "image/jpeg" };
	const pdf = { name: "scan.pdf", mimeType: "application/pdf" };

	function attached(
		artifact: { name: string; mimeType: string | null },
		overrides: {
			promptReady?: boolean;
			readinessError?: string | null;
			readinessErrorCode?: string | null;
		} = {},
	) {
		return { artifact, promptReady: false, ...overrides };
	}

	const noText = job({
		status: "failed",
		retryable: false,
		cancelable: false,
		error: { code: "empty_result", message: "nothing readable" },
	});

	describe("isPictureForModel", () => {
		it("is true for a picture the server can decode, when the model can see", () => {
			for (const artifact of [
				photo,
				{ name: "IMG_0001.HEIC", mimeType: "image/heic" },
				{ name: "shot.png", mimeType: "image/png" },
				{ name: "photo", mimeType: "image/webp" },
			]) {
				expect(isPictureForModel(artifact, SEES), artifact.name).toBe(true);
			}
		});

		it("is false when the model cannot see", () => {
			expect(isPictureForModel(photo, BLIND)).toBe(false);
		});

		it("is false for everything that is not a picture the server can decode", () => {
			for (const artifact of [
				pdf,
				{ name: "notes.txt", mimeType: "text/plain" },
				{ name: "scan.bmp", mimeType: "image/bmp" },
				{ name: "favicon.ico", mimeType: "image/x-icon" },
				{ name: "layers.psd", mimeType: "image/vnd.adobe.photoshop" },
			]) {
				expect(isPictureForModel(artifact, SEES), artifact.name).toBe(false);
			}
		});

		it("reads a missing type as unknown", () => {
			expect(isPictureForModel({ name: "photo.png" }, SEES)).toBe(true);
			expect(isPictureForModel({ name: "photo" }, SEES)).toBe(false);
		});
	});

	describe("the chip's clause", () => {
		it("says there is no text in the image, quietly, when the reader found none", () => {
			expect(extractionChipState(noText, { picture: true })).toEqual({
				progressKey: "chat.extraction.imageNoText",
				errorKey: null,
				dashed: false,
				canRetry: false,
				canCancel: false,
			});
		});

		it("is the failure it always was for a model that cannot see", () => {
			const state = extractionChipState(noText, { picture: false });

			expect(state.errorKey).toBe("chat.extraction.error.empty_result");
			expect(state.progressKey).toBeNull();
			expect(extractionChipState(noText)).toEqual(state);
		});

		it("keeps the other reasons a read can fail, but quietly: they no longer stop the send", () => {
			const retryable = extractionChipState(
				job({
					status: "failed",
					retryable: true,
					cancelable: false,
					error: { code: "max_attempts", message: "gave up" },
				}),
				{ picture: true },
			);
			expect(retryable.progressKey).toBe("chat.extraction.failedRetry");
			expect(retryable.errorKey).toBeNull();
			expect(retryable.canRetry).toBe(true);

			const tooLarge = extractionChipState(
				job({
					status: "failed",
					retryable: false,
					cancelable: false,
					error: { code: "too_large", message: "8 MiB cap" },
				}),
				{ picture: true },
			);
			expect(tooLarge.progressKey).toBe("chat.extraction.error.too_large");
			expect(tooLarge.errorKey).toBeNull();

			const stopped = extractionChipState(
				job({ status: "canceled", cancelable: false, retryable: true }),
				{ picture: true },
			);
			expect(stopped.progressKey).toBe("chat.extraction.canceledRetry");
			expect(stopped.errorKey).toBeNull();
			expect(stopped.canRetry).toBe(true);
		});

		it("is unchanged while the job is running, whatever the model", () => {
			for (const status of ["queued", "parsing", "indexing"] as const) {
				expect(extractionChipState(job({ status }), { picture: true })).toEqual(
					extractionChipState(job({ status })),
				);
			}
		});

		it("is unchanged for a job that succeeded, and for no job at all", () => {
			expect(
				extractionChipState(job({ status: "succeeded" }), { picture: true }),
			).toEqual(extractionChipState(job({ status: "succeeded" })));
			expect(extractionChipState(null, { picture: true })).toEqual(
				extractionChipState(null),
			);
		});

		it("only ever emits keys both dictionaries carry, picture or not", () => {
			const emitted = new Set<string>();
			for (const picture of [true, false]) {
				for (const status of DOCUMENT_EXTRACTION_STATUSES) {
					for (const retryable of [true, false]) {
						for (const code of [...EXTRACTION_ERROR_CODES, null]) {
							const state = extractionChipState(
								job({
									status,
									retryable: status === "failed" && retryable,
									error: code ? { code, message: "" } : null,
								}),
								{ picture },
							);
							if (state.progressKey) emitted.add(state.progressKey);
							if (state.errorKey) emitted.add(state.errorKey);
						}
					}
				}
			}

			expect(emitted).toContain("chat.extraction.imageNoText");
			for (const key of emitted) {
				for (const lang of ["en", "hu"] as const) {
					expect(
						typeof chatDict[lang][key as keyof (typeof chatDict)[typeof lang]],
						`${lang}.${key}`,
					).toBe("string");
				}
			}
		});
	});

	describe("attachmentChipFailure", () => {
		it("has no failure for a photo whose text the reader could not find", () => {
			expect(attachmentChipFailure(noText, attached(photo), SEES)).toEqual({
				kind: "none",
			});
		});

		it("is the failure it always was for the same photo when the model cannot see", () => {
			expect(attachmentChipFailure(noText, attached(photo), BLIND)).toEqual({
				kind: "job",
				errorKey: "chat.extraction.error.empty_result",
				retryable: false,
				canceled: false,
				errorCode: "empty_result",
			});
		});

		it("leaves a PDF with no readable text a failure, whatever the model", () => {
			const failure = {
				kind: "job",
				errorKey: "chat.extraction.error.empty_result",
				retryable: false,
				canceled: false,
				errorCode: "empty_result",
			};
			expect(attachmentChipFailure(noText, attached(pdf), SEES)).toEqual(
				failure,
			);
			expect(attachmentChipFailure(noText, attached(pdf), BLIND)).toEqual(
				failure,
			);
		});

		it("does not open Send for an image the server would refuse: a BMP, an icon", () => {
			for (const artifact of [
				{ name: "scan.bmp", mimeType: "image/bmp" },
				{ name: "favicon.ico", mimeType: "image/x-icon" },
			]) {
				expect(
					attachmentChipFailure(noText, attached(artifact), SEES),
					artifact.name,
				).toMatchObject({ kind: "job", errorCode: "empty_result" });
			}
		});

		it("does not hold Send for a picture the reader has not finished with", () => {
			const reading = job({ status: "parsing" });

			expect(attachmentChipFailure(reading, attached(photo), SEES)).toEqual({
				kind: "none",
			});
			expect(attachmentChipFailure(reading, attached(photo), BLIND)).toEqual({
				kind: "busy",
			});
			// A document is still waited for, whatever the model.
			expect(attachmentChipFailure(reading, attached(pdf), SEES)).toEqual({
				kind: "busy",
			});
		});

		it("does not hold Send for a picture whose upload response says it is still preparing", () => {
			const fresh = attached(photo, {
				readinessError: "This file is still being prepared for chat.",
				readinessErrorCode: "still_preparing",
			});

			expect(attachmentChipFailure(undefined, fresh, SEES)).toEqual({
				kind: "none",
			});
			expect(attachmentChipFailure(undefined, fresh, BLIND)).toEqual({
				kind: "busy",
			});
		});

		it("has no failure for a picture whose text turned out too thin to use", () => {
			const succeeded = job({ status: "succeeded", cancelable: false });
			const thin = attached(photo, {
				readinessError: "no usable text",
				readinessErrorCode: "no_usable_text",
			});

			expect(attachmentChipFailure(succeeded, thin, SEES)).toEqual({
				kind: "none",
			});
			expect(attachmentChipFailure(succeeded, thin, BLIND)).toEqual({
				kind: "readiness",
				reason: "no_usable_text",
			});
		});

		it("has no failure for a picture whose reading failed for a reason of its own", () => {
			const failed = job({
				status: "failed",
				retryable: true,
				cancelable: false,
				error: { code: "max_attempts", message: "gave up" },
			});

			expect(attachmentChipFailure(failed, attached(photo), SEES)).toEqual({
				kind: "none",
			});
			expect(
				attachmentChipFailure(failed, attached(photo), BLIND),
			).toMatchObject({ kind: "job", retryable: true });
		});

		it("still fails a picture that is gone from the library", () => {
			expect(
				attachmentChipFailure(
					undefined,
					attached(photo, {
						readinessError: "Attached file is no longer available.",
						readinessErrorCode: "not_available",
					}),
					SEES,
				),
			).toEqual({ kind: "readiness", reason: "not_available" });
		});

		it("is unchanged for a document that is ready, whatever the model", () => {
			for (const options of [SEES, BLIND]) {
				expect(
					attachmentChipFailure(
						job({ status: "succeeded", cancelable: false }),
						attached(pdf, { promptReady: true }),
						options,
					),
				).toEqual({ kind: "none" });
			}
		});
	});

	describe("extractionReasonKey", () => {
		const emptyResult = {
			status: "failed" as const,
			errorCode: "empty_result" as const,
			retryable: false,
		};

		it("says there is no text in the image, for a picture the model will be shown", () => {
			expect(extractionReasonKey(emptyResult, { picture: true })).toBe(
				"chat.extraction.imageNoText",
			);
		});

		it("is unchanged for everything else", () => {
			expect(extractionReasonKey(emptyResult)).toBe(
				"chat.extraction.error.empty_result",
			);
			expect(extractionReasonKey(emptyResult, { picture: false })).toBe(
				"chat.extraction.error.empty_result",
			);
			expect(
				extractionReasonKey(
					{ status: "failed", errorCode: "too_large", retryable: false },
					{ picture: true },
				),
			).toBe("chat.extraction.error.too_large");
		});
	});
});

describe("extractionChipDashed", () => {
	it("dashes only while the job is unfinished", () => {
		expect(extractionChipDashed(job({ status: "parsing" }))).toBe(true);
		expect(extractionChipDashed(job({ status: "succeeded" }))).toBe(false);
		expect(extractionChipDashed(null)).toBe(false);
	});
});

describe("isExtractionPending", () => {
	it("treats a missing DTO as settled so Send is never held hostage", () => {
		expect(isExtractionPending(undefined)).toBe(false);
		expect(isExtractionPending(null)).toBe(false);
	});

	it("is true for exactly the non-terminal statuses", () => {
		for (const status of DOCUMENT_EXTRACTION_STATUSES) {
			const terminal =
				status === "succeeded" || status === "failed" || status === "canceled";
			expect(isExtractionPending(job({ status })), status).toBe(!terminal);
		}
	});
});
