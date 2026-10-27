// The readiness authority, against a real migrated database.
//
// The batch read is what the extraction poll route uses to turn a terminal
// `succeeded` job into a content verdict: "the job finished" and "the text is
// usable" are different facts, and a late success whose normalized document is
// thin must not look like a silent success. These tests pin the mapping and the
// ownership/order behavior the route inherits from it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "$lib/server/services/extraction/testing/ledger-fixtures";
import type { ExtractionErrorCode } from "$lib/shared/extraction-status";

type ReadinessModule = typeof import("./readiness");
type AttachmentsModule = typeof import("./store/attachments");

let fixture: LedgerFixture;
let readiness: ReadinessModule;
let attachments: AttachmentsModule;

const OWNER = "user-owner";
const STRANGER = "user-stranger";

/** Passes `hasMeaningfulAttachmentText` (>= 24 chars, >= 12 alphanumeric). */
const READY_TEXT =
	"Quarterly revenue grew by twelve percent across every region this year.";
/** Fails it: too short to be usable prompt text. */
const THIN_TEXT = "Tiny.";

beforeEach(async () => {
	fixture = createLedgerFixture("knowledge-readiness");
	fixture.seedUser(OWNER);
	fixture.seedUser(STRANGER);

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	readiness = await import("./readiness");
	attachments = await import("./store/attachments");
});

afterEach(() => {
	fixture.cleanup();
	vi.restoreAllMocks();
});

function seedSource(userId = OWNER): string {
	return fixture.seedArtifact({
		userId,
		name: "report.pdf",
		type: "source_document",
	});
}

function seedNormalized(sourceArtifactId: string, contentText: string | null) {
	const normalizedId = fixture.seedArtifact({
		userId: OWNER,
		name: "report.md",
		type: "normalized_document",
		contentText,
	});
	fixture.seedNormalizedLink({
		userId: OWNER,
		normalizedArtifactId: normalizedId,
		sourceArtifactId,
	});
	return normalizedId;
}

describe("evaluatePromptArtifactReadiness", () => {
	it("calls a missing prompt artifact not_prepared", () => {
		expect(readiness.evaluatePromptArtifactReadiness(null)).toEqual({
			promptReady: false,
			promptArtifactId: null,
			readinessError: readiness.NOT_PREPARED_READINESS_ERROR,
			readinessErrorCode: "not_prepared",
		});
	});

	it("calls thin text no_usable_text", () => {
		expect(
			readiness.evaluatePromptArtifactReadiness({
				id: "normalized-1",
				contentText: THIN_TEXT,
			}),
		).toEqual({
			promptReady: false,
			promptArtifactId: null,
			readinessError: readiness.NO_USABLE_TEXT_READINESS_ERROR,
			readinessErrorCode: "no_usable_text",
		});
	});

	it("calls meaningful text ready, with the prompt artifact id and no error", () => {
		expect(
			readiness.evaluatePromptArtifactReadiness({
				id: "normalized-1",
				contentText: READY_TEXT,
			}),
		).toEqual({
			promptReady: true,
			promptArtifactId: "normalized-1",
			readinessError: null,
			readinessErrorCode: null,
		});
	});
});

describe("readAttachmentReadinessSnapshots", () => {
	it("snapshots a source document with meaningful normalized text as ready", async () => {
		const sourceId = seedSource();
		const normalizedId = seedNormalized(sourceId, READY_TEXT);

		await expect(
			readiness.readAttachmentReadinessSnapshots(OWNER, [sourceId]),
		).resolves.toEqual([
			{
				artifactId: sourceId,
				promptReady: true,
				promptArtifactId: normalizedId,
				readinessError: null,
				readinessErrorCode: null,
			},
		]);
	});

	it("picks the oldest normalized link, matching the send gate", async () => {
		const sourceId = seedSource();
		const olderNormalizedId = seedNormalized(sourceId, READY_TEXT);
		const newerNormalizedId = seedNormalized(sourceId, THIN_TEXT);

		// `seedNormalizedLink` stamps both links at the fixture epoch, so the raw
		// ordering is set explicitly. The older link carries the usable text; the
		// newer one is thin, so picking the newest would report no_usable_text.
		const olderSeconds = 1_700_000_000;
		fixture.sqlite
			.prepare("UPDATE artifact_links SET created_at = ? WHERE artifact_id = ?")
			.run(olderSeconds, olderNormalizedId);
		fixture.sqlite
			.prepare("UPDATE artifact_links SET created_at = ? WHERE artifact_id = ?")
			.run(olderSeconds + 60, newerNormalizedId);

		const [snapshot] = await readiness.readAttachmentReadinessSnapshots(OWNER, [
			sourceId,
		]);

		expect(snapshot).toMatchObject({
			promptReady: true,
			promptArtifactId: olderNormalizedId,
		});
	});

	it("reports no_usable_text for a thin normalized document", async () => {
		const sourceId = seedSource();
		const normalizedId = seedNormalized(sourceId, THIN_TEXT);

		const [snapshot] = await readiness.readAttachmentReadinessSnapshots(OWNER, [
			sourceId,
		]);

		expect(snapshot).toEqual({
			artifactId: sourceId,
			promptReady: false,
			// A thin document exists, but it is not a prompt artifact.
			promptArtifactId: null,
			readinessError: readiness.NO_USABLE_TEXT_READINESS_ERROR,
			readinessErrorCode: "no_usable_text",
		});
		expect(normalizedId).toBeTruthy();
	});

	it("reports not_prepared when the source has no normalized document", async () => {
		const sourceId = seedSource();

		const [snapshot] = await readiness.readAttachmentReadinessSnapshots(OWNER, [
			sourceId,
		]);

		expect(snapshot).toEqual({
			artifactId: sourceId,
			promptReady: false,
			promptArtifactId: null,
			readinessError: readiness.NOT_PREPARED_READINESS_ERROR,
			readinessErrorCode: "not_prepared",
		});
	});

	it("evaluates a non-source display artifact as its own prompt artifact", async () => {
		// The send gate lets a non-source attachment be its own prompt artifact,
		// so the status route must agree: meaningful text is ready, and the
		// prompt artifact id is the display artifact itself.
		const normalizedId = fixture.seedArtifact({
			userId: OWNER,
			name: "reply.md",
			type: "normalized_document",
			contentText: READY_TEXT,
		});

		const [snapshot] = await readiness.readAttachmentReadinessSnapshots(OWNER, [
			normalizedId,
		]);

		expect(snapshot).toEqual({
			artifactId: normalizedId,
			promptReady: true,
			promptArtifactId: normalizedId,
			readinessError: null,
			readinessErrorCode: null,
		});
	});

	it("reports not_text_readable for a thin non-source display artifact", async () => {
		const normalizedId = fixture.seedArtifact({
			userId: OWNER,
			name: "reply.md",
			type: "normalized_document",
			contentText: THIN_TEXT,
		});

		const [snapshot] = await readiness.readAttachmentReadinessSnapshots(OWNER, [
			normalizedId,
		]);

		expect(snapshot).toEqual({
			artifactId: normalizedId,
			promptReady: false,
			promptArtifactId: null,
			readinessError: readiness.NOT_TEXT_READABLE_READINESS_ERROR,
			readinessErrorCode: "not_text_readable",
		});
	});

	it("omits unknown and other-user ids instead of answering for them", async () => {
		const mine = seedSource();
		seedNormalized(mine, READY_TEXT);
		const theirs = seedSource(STRANGER);
		seedNormalized(theirs, READY_TEXT);

		const snapshots = await readiness.readAttachmentReadinessSnapshots(OWNER, [
			mine,
			theirs,
			"does-not-exist",
		]);

		expect(snapshots.map((snapshot) => snapshot.artifactId)).toEqual([mine]);
	});

	it("preserves the caller's input order", async () => {
		const first = seedSource();
		const second = seedSource();
		const third = seedSource();

		const snapshots = await readiness.readAttachmentReadinessSnapshots(OWNER, [
			third,
			first,
			second,
		]);

		expect(snapshots.map((snapshot) => snapshot.artifactId)).toEqual([
			third,
			first,
			second,
		]);
	});

	it("answers an empty input without querying the database", async () => {
		const { db } = await import("$lib/server/db");
		const select = vi.spyOn(db, "select");

		await expect(
			readiness.readAttachmentReadinessSnapshots(OWNER, []),
		).resolves.toEqual([]);
		expect(select).not.toHaveBeenCalled();
	});
});

describe("send gate — a non-source attachment is its own prompt artifact", () => {
	it("keeps a non-source artifact with meaningful text prompt-ready", async () => {
		// Pre-refactor send-gate behavior, restored: the display artifact is its
		// own prompt artifact, so meaningful text is ready even though it is not
		// a source document.
		const normalizedId = fixture.seedArtifact({
			userId: OWNER,
			name: "already-normalized.md",
			type: "normalized_document",
			contentText: READY_TEXT,
		});

		const resolved = await attachments.resolvePromptAttachmentArtifacts(OWNER, [
			normalizedId,
		]);

		expect(resolved.items).toHaveLength(1);
		expect(resolved.items[0]).toMatchObject({
			promptReady: true,
			readinessError: null,
			readinessErrorCode: null,
		});
		expect(resolved.promptArtifacts.map((artifact) => artifact.id)).toEqual([
			normalizedId,
		]);
		expect(resolved.unresolvedItems).toEqual([]);
	});

	it("reports a thin non-source artifact as not_text_readable", async () => {
		const normalizedId = fixture.seedArtifact({
			userId: OWNER,
			name: "already-normalized.md",
			type: "normalized_document",
			contentText: THIN_TEXT,
		});

		const resolved = await attachments.resolvePromptAttachmentArtifacts(OWNER, [
			normalizedId,
		]);

		expect(resolved.items).toHaveLength(1);
		expect(resolved.items[0]).toMatchObject({
			promptReady: false,
			readinessError: readiness.NOT_TEXT_READABLE_READINESS_ERROR,
			readinessErrorCode: "not_text_readable",
		});
		expect(resolved.promptArtifacts).toEqual([]);
		expect(resolved.unresolvedItems).toHaveLength(1);
	});
});

// A model that can see needs no extracted text to be shown a picture, so for
// such a turn an image the model can be shown never stops the send: not when
// the reader found no text in it, not when the text is thin, not while the
// reader is still at it. Everything else is judged as it always was, and so is
// every attachment under a model that cannot see.
describe("send gate — a picture the model can be shown", () => {
	type Ledger = typeof import("../extraction/extraction-job");
	let ledger: Ledger;
	let info: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		ledger = await import("../extraction/extraction-job");
		info = vi.spyOn(console, "info").mockImplementation(() => undefined);
	});

	afterEach(() => {
		info.mockRestore();
	});

	type Reading =
		| { kind: "queued" }
		| { kind: "failed"; code: ExtractionErrorCode; retryable?: boolean }
		| { kind: "text"; text: string }
		| { kind: "none" };

	/** An uploaded source file in the library, in whatever state its reading is in. */
	async function seedUpload(
		name: string,
		mimeType: string,
		reading: Reading,
	): Promise<string> {
		const sourceId = fixture.seedArtifact({
			userId: OWNER,
			name,
			mimeType,
			type: "source_document",
		});
		if (reading.kind === "queued" || reading.kind === "failed") {
			await ledger.enqueueExtractionJob({
				userId: OWNER,
				conversationId: null,
				origin: "upload",
				intakeRoute: "mineru",
				fileName: name,
				mimeType,
				sizeBytes: 1024,
				sourceArtifactId: sourceId,
				failure:
					reading.kind === "failed"
						? {
								errorCode: reading.code,
								errorMessage: "the reader said so",
								retryable: reading.retryable ?? false,
							}
						: null,
			});
		}
		if (reading.kind === "text") seedNormalized(sourceId, reading.text);
		return sourceId;
	}

	async function gate(ids: string[], exemptImages?: boolean) {
		return attachments.assertPromptReadyAttachments({
			userId: OWNER,
			conversationId: "conv-1",
			attachmentIds: ids,
			...(exemptImages === undefined ? {} : { exemptImages }),
		});
	}

	async function refusal(ids: string[], exemptImages?: boolean) {
		const error = await gate(ids, exemptImages).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(attachments.AttachmentReadinessError);
		return error as InstanceType<typeof attachments.AttachmentReadinessError>;
	}

	const NO_TEXT: Reading = { kind: "failed", code: "empty_result" };
	const THIN_TEXT_READ: Reading = { kind: "text", text: THIN_TEXT };
	const STILL_QUEUED: Reading = { kind: "queued" };

	it.each([
		["a reader that found no text in it (empty_result)", NO_TEXT],
		["text too thin to use (no_usable_text)", THIN_TEXT_READ],
		["a reader that has not left the queue", STILL_QUEUED],
		[
			"a reader that failed for a reason of its own",
			{ kind: "failed", code: "too_large" } as Reading,
		],
		[
			"a reader that gave up after several tries",
			{ kind: "failed", code: "max_attempts", retryable: true } as Reading,
		],
		["no reading at all", { kind: "none" } as Reading],
	])("lets a picture through for a model that can see: %s", async (_label, reading) => {
		const photo = await seedUpload("photo.jpg", "image/jpeg", reading);

		const resolved = await gate([photo], true);

		expect(resolved.displayArtifacts.map((artifact) => artifact.id)).toEqual([
			photo,
		]);
		// No text was prepared, and none is claimed.
		expect(resolved.promptArtifacts).toEqual([]);
	});

	it.each([
		["found no text", NO_TEXT, "attachment_extraction_failed"],
		["has thin text", THIN_TEXT_READ, "attachment_not_ready"],
		["is still queued", STILL_QUEUED, "attachment_extraction_pending"],
	])("refuses the same picture exactly as before for a model that cannot see: it %s", async (_label, reading, code) => {
		const photo = await seedUpload("photo.jpg", "image/jpeg", reading);

		for (const exempt of [undefined, false]) {
			const error = await refusal([photo], exempt);
			expect(error.code).toBe(code);
			expect(error.attachmentIds).toEqual([photo]);
		}
	});

	it("keeps naming no_usable_text as the reason for a thin picture when the model cannot see", async () => {
		const photo = await seedUpload("photo.jpg", "image/jpeg", THIN_TEXT_READ);

		const error = await refusal([photo]);

		expect(error.readiness).toEqual([
			{ artifactId: photo, name: "photo.jpg", reason: "no_usable_text" },
		]);
	});

	it.each([
		["a PDF", "report.pdf", "application/pdf"],
		["a text file", "notes.txt", "text/plain"],
		[
			"a spreadsheet",
			"table.xlsx",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		],
	])("never changes how %s is judged, whatever the model", async (_label, name, mimeType) => {
		const readings: Array<[Reading, string]> = [
			[NO_TEXT, "attachment_extraction_failed"],
			[THIN_TEXT_READ, "attachment_not_ready"],
			[STILL_QUEUED, "attachment_extraction_pending"],
		];
		for (const [reading, code] of readings) {
			const file = await seedUpload(name, mimeType, reading);
			for (const exempt of [undefined, false, true]) {
				const error = await refusal([file], exempt);
				expect(error.code, `${name} ${reading.kind} ${exempt}`).toBe(code);
				expect(error.attachmentIds).toEqual([file]);
			}
		}
	});

	// A BMP and a type the image library does not read are images the model can
	// never be shown, so for them the text is all there is: no exemption.
	it.each([
		["a BMP", "scan.bmp", "image/bmp"],
		["an icon file", "favicon.ico", "image/x-icon"],
		["a Photoshop file", "layers.psd", "image/vnd.adobe.photoshop"],
		["a camera raw file", "IMG_0001.CR2", "image/x-canon-cr2"],
	])("still refuses %s that has no text, for a model that can see", async (_label, name, mimeType) => {
		const file = await seedUpload(name, mimeType, NO_TEXT);

		const error = await refusal([file], true);

		expect(error.code).toBe("attachment_extraction_failed");
		expect(error.attachmentIds).toEqual([file]);
	});

	it("lets a BMP through when it has text, as it always did", async () => {
		const file = await seedUpload("scan.bmp", "image/bmp", {
			kind: "text",
			text: READY_TEXT,
		});

		const resolved = await gate([file], true);

		expect(resolved.promptArtifacts).toHaveLength(1);
	});

	it("still refuses an attachment that is no longer available", async () => {
		const error = await refusal(["gone-for-good"], true);

		expect(error.code).toBe("attachment_not_ready");
		expect(error.attachmentIds).toEqual(["gone-for-good"]);
	});

	it("lets through a picture that is its own prompt artifact with thin text", async () => {
		const own = fixture.seedArtifact({
			userId: OWNER,
			name: "photo.jpg",
			mimeType: "image/jpeg",
			type: "normalized_document",
			contentText: THIN_TEXT,
		});

		await expect(gate([own], true)).resolves.toMatchObject({
			promptArtifacts: [],
		});
		const error = await refusal([own]);
		expect(error.readiness).toEqual([
			{ artifactId: own, name: "photo.jpg", reason: "not_text_readable" },
		]);
	});

	it("names only the files that block the send, so the gate waits for those alone", async () => {
		const photo = await seedUpload("photo.jpg", "image/jpeg", STILL_QUEUED);
		const report = await seedUpload("report.pdf", "application/pdf", {
			kind: "failed",
			code: "job_failed",
			retryable: true,
		});
		const pdf = await seedUpload("slow.pdf", "application/pdf", STILL_QUEUED);

		const error = await refusal([photo, report, pdf], true);

		expect(error.attachmentIds).toEqual([report, pdf]);
		expect(error.items.map((item) => item.artifactId)).toEqual([report, pdf]);
		expect(error.readiness.map((item) => item.artifactId)).toEqual([
			report,
			pdf,
		]);
		// The picture still blocks nothing when it is the only thing pending.
		await expect(gate([photo], true)).resolves.toBeDefined();
	});

	it("passes a picture with usable text exactly as before, text and all", async () => {
		const photo = await seedUpload("receipt.jpg", "image/jpeg", {
			kind: "text",
			text: READY_TEXT,
		});

		for (const exempt of [undefined, false, true]) {
			const resolved = await gate([photo], exempt);
			expect(resolved.promptArtifacts).toHaveLength(1);
		}
	});
});
