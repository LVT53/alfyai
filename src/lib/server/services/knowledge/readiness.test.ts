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
