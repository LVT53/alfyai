import { describe, expect, it, vi } from "vitest";

vi.mock("./pending-writes", () => ({
	// Kept in step with pending-writes.ts's own predicate: the real module pulls
	// in the database.
	isPendingWriteExpired: (expiresAt: number | null, now = Date.now()) =>
		expiresAt !== null && expiresAt * 1000 <= now,
}));

import type { PendingWriteRecord } from "./pending-writes";
import { buildWriteCard, toPendingWriteDto } from "./write-card";
import {
	buildWritePreview,
	WRITE_WARNING,
	type WriteOperation,
} from "./write-guard";

function operation(overrides: Partial<WriteOperation>): WriteOperation {
	return {
		provider: "nextcloud",
		connectionId: "conn-1",
		action: "files.put",
		summary: "Save a file",
		reversible: true,
		destructive: false,
		...overrides,
	};
}

function cardFor(op: WriteOperation, content = "", warnings: string[] = []) {
	const preview = buildWritePreview(op);
	preview.warnings.push(...warnings);
	return buildWriteCard({ op, content, preview });
}

const AT_REPORT = {
	path: "/AlfyAI/Reports/report.pdf",
	withinAllowlist: true,
};

describe("buildWriteCard: email", () => {
	it("names the subject and says who gets it, with the text that goes out", () => {
		const card = cardFor(
			operation({ action: "email.send", reversible: false }),
			JSON.stringify({
				to: "anna@example.com",
				cc: "bela@example.com",
				subject: "Q3 numbers",
				body: "Hi Anna",
				inReplyTo: "<id@example.com>",
			}),
		);

		expect(card).toEqual({
			kind: "email.send",
			subject: "Q3 numbers",
			facts: [
				{ key: "to", value: "anna@example.com" },
				{ key: "cc", value: "bela@example.com" },
			],
			message: "Hi Anna",
			risks: [],
			danger: false,
		});
	});

	it("names the email going to the trash", () => {
		const card = cardFor(
			operation({
				action: "email.trash",
				destructive: true,
				target: { id: "12", label: "Old newsletter" },
			}),
			JSON.stringify({ uid: 12 }),
		);

		expect(card?.kind).toBe("email.trash");
		expect(card?.subject).toBe("Old newsletter");
		expect(card?.danger).toBe(true);
	});

	it.each([
		["seen", true, "email.mark_read"],
		["seen", false, "email.mark_unread"],
		["flagged", true, "email.flag"],
		["flagged", false, "email.unflag"],
	])("reads flag %s=%s as %s", (flag, value, kind) => {
		const card = cardFor(
			operation({ action: "email.flag", target: { id: "12" } }),
			JSON.stringify({ uid: 12, flag, value }),
		);

		expect(card?.kind).toBe(kind);
		expect(card?.subject).toBe("");
	});
});

describe("buildWriteCard: calendar", () => {
	const event = {
		summary: "Dentist",
		start: "2026-11-03T09:00:00+01:00",
		end: "2026-11-03T09:30:00+01:00",
		location: "Kossuth tér 1",
		description: "Bring the referral",
	};

	it("takes what will be created from the payload the executor runs", () => {
		const card = cardFor(
			operation({
				action: "calendar.create_event",
				target: { label: "Dentist" },
			}),
			JSON.stringify({ calendarId: "primary", event }),
		);

		expect(card).toEqual({
			kind: "calendar.create_event",
			subject: "Dentist",
			facts: [
				{
					key: "when",
					value: event.start,
					end: event.end,
				},
				{ key: "where", value: "Kossuth tér 1" },
			],
			message: "Bring the referral",
			risks: [],
			danger: false,
		});
	});

	it("shows only what an update changes", () => {
		const card = cardFor(
			operation({
				action: "calendar.update_event",
				destructive: true,
				target: { id: "ev-1", label: "Dentist" },
			}),
			JSON.stringify({
				calendarId: "primary",
				eventId: "ev-1",
				event: { location: "Váci út 1" },
			}),
		);

		expect(card?.facts).toEqual([{ key: "where", value: "Váci út 1" }]);
	});

	it("keeps an edit a platform can undo out of the red", () => {
		const reversible = cardFor(
			operation({
				action: "calendar.update_event",
				reversible: true,
				destructive: true,
				target: { label: "Dentist" },
			}),
			JSON.stringify({ eventId: "ev-1", event: {} }),
		);
		const irreversible = cardFor(
			operation({
				action: "calendar.update_event",
				reversible: false,
				destructive: true,
				target: { label: "Dentist" },
			}),
			JSON.stringify({ uid: "ev-1", event: {} }),
		);

		expect(reversible?.danger).toBe(false);
		expect(reversible?.risks).toEqual([]);
		expect(irreversible?.danger).toBe(true);
		expect(irreversible?.risks).toEqual(["cannot_undo"]);
	});

	it("says when a change reaches the whole series, on either platform", () => {
		const google = cardFor(
			operation({
				action: "calendar.delete_event",
				destructive: true,
				target: { label: "Standup" },
			}),
			JSON.stringify({ eventId: "ev-1", recurringScope: "series" }),
		);
		const apple = cardFor(
			operation({
				action: "calendar.delete_event",
				reversible: false,
				destructive: true,
				target: { label: "Standup" },
			}),
			JSON.stringify({ uid: "ev-1", recurring: true }),
			[WRITE_WARNING.wholeSeries],
		);
		const update = cardFor(
			operation({
				action: "calendar.update_event",
				destructive: true,
				target: { label: "Standup" },
			}),
			JSON.stringify({ eventId: "ev-1", recurringScope: "series", event: {} }),
		);

		expect(google?.risks).toEqual(["deletes_whole_series"]);
		expect(apple?.risks).toEqual(["deletes_whole_series", "cannot_undo"]);
		expect(update?.risks).toEqual(["changes_whole_series"]);
	});

	it("does not warn about a new event an account has no undo for: deleting it undoes it", () => {
		const card = cardFor(
			operation({
				action: "calendar.create_event",
				reversible: false,
				target: { label: "Dentist" },
			}),
			JSON.stringify({ calendarUrl: "https://example.com/cal/", event }),
		);

		expect(card?.risks).toEqual([]);
		expect(card?.danger).toBe(false);
	});
});

describe("buildWriteCard: files", () => {
	it("names the file and gives its folder, never the whole path", () => {
		const card = cardFor(
			operation({ action: "files.put", target: AT_REPORT }),
			"Atlas report",
		);

		expect(card?.kind).toBe("files.save");
		expect(card?.subject).toBe("report.pdf");
		expect(card?.facts).toEqual([{ key: "folder", value: "/AlfyAI/Reports" }]);
		expect(JSON.stringify(card)).not.toContain("/AlfyAI/Reports/report.pdf");
		expect(card?.message).toBe("Atlas report");
	});

	it("gives a file at the top of the drive the root as its folder", () => {
		const card = cardFor(
			operation({
				action: "files.put",
				target: { path: "/note.txt", withinAllowlist: true },
			}),
		);

		expect(card?.facts).toEqual([{ key: "folder", value: "/" }]);
	});

	it("reads an overwrite as a replace, and explains what is lost", () => {
		const card = cardFor(
			operation({
				action: "files.put",
				destructive: true,
				reversible: false,
				target: AT_REPORT,
			}),
			"new text",
			[WRITE_WARNING.noVersionHistory],
		);

		expect(card?.kind).toBe("files.replace");
		expect(card?.danger).toBe(true);
		expect(card?.risks).toEqual(["replaces_file_for_good"]);
	});

	it("says so when it could not check whether the old file survives", () => {
		const card = cardFor(
			operation({
				action: "files.put",
				destructive: true,
				reversible: false,
				target: AT_REPORT,
			}),
			"new text",
			[WRITE_WARNING.versionHistoryUnknown],
		);

		expect(card?.risks).toEqual(["replaces_file_unchecked"]);
	});

	it("cuts a very long file for the card, and says it was cut", () => {
		const card = cardFor(
			operation({ action: "files.put", target: AT_REPORT }),
			"x".repeat(20_000),
		);

		expect(card?.message?.length).toBeLessThan(8_100);
		expect(card?.message?.endsWith("…")).toBe(true);
	});

	it("reads a move between folders as a move", () => {
		const card = cardFor(
			operation({
				action: "files.move",
				target: { path: "/AlfyAI/Done/report.pdf", withinAllowlist: true },
			}),
			JSON.stringify({
				fromPath: "/AlfyAI/Inbox/report.pdf",
				toPath: "/AlfyAI/Done/report.pdf",
			}),
		);

		expect(card?.kind).toBe("files.move");
		expect(card?.subject).toBe("report.pdf");
		expect(card?.facts).toEqual([
			{ key: "folder", value: "/AlfyAI/Inbox → /AlfyAI/Done" },
		]);
	});

	it("reads a move inside one folder as a rename", () => {
		const card = cardFor(
			operation({
				action: "files.move",
				target: { path: "/AlfyAI/final.pdf", withinAllowlist: true },
			}),
			JSON.stringify({
				fromPath: "/AlfyAI/draft.pdf",
				toPath: "/AlfyAI/final.pdf",
			}),
		);

		expect(card?.kind).toBe("files.rename");
		expect(card?.subject).toBe("draft.pdf");
		expect(card?.facts).toEqual([
			{ key: "new_name", value: "final.pdf" },
			{ key: "folder", value: "/AlfyAI" },
		]);
	});

	it("keeps the new name on a move that also renames", () => {
		const card = cardFor(
			operation({
				action: "files.move",
				target: { path: "/AlfyAI/Done/final.pdf", withinAllowlist: true },
			}),
			JSON.stringify({
				fromPath: "/AlfyAI/Inbox/draft.pdf",
				toPath: "/AlfyAI/Done/final.pdf",
			}),
		);

		expect(card?.kind).toBe("files.move");
		expect(card?.facts).toEqual([
			{ key: "new_name", value: "final.pdf" },
			{ key: "folder", value: "/AlfyAI/Inbox → /AlfyAI/Done" },
		]);
	});

	it("says a public link is public", () => {
		const card = cardFor(
			operation({ action: "files.share_link", target: AT_REPORT }),
			"",
			[WRITE_WARNING.publicLink],
		);

		expect(card?.kind).toBe("files.share_link");
		expect(card?.risks).toEqual(["public_link"]);
	});

	it("says when a write lands outside the folders the person allowed", () => {
		const card = cardFor(
			operation({
				action: "files.put",
				target: { path: "/Private/x.txt", withinAllowlist: false },
			}),
			"text",
		);

		expect(card?.risks).toEqual(["outside_allowed_folders"]);
	});

	it("says when it could not check the folder", () => {
		const card = cardFor(
			operation({ action: "files.delete", target: { path: "/x.txt" } }),
		);

		expect(card?.risks).toEqual(["unchecked_folder"]);
	});

	it.each([
		["files.delete", "files.delete"],
		["files.create_folder", "files.create_folder"],
	])("reads %s", (action, kind) => {
		const card = cardFor(operation({ action, target: AT_REPORT }));

		expect(card?.kind).toBe(kind);
		expect(card?.subject).toBe("report.pdf");
	});
});

describe("buildWriteCard: photos", () => {
	it("names the album and counts the photos", () => {
		const card = cardFor(
			operation({ action: "immich.add_to_album" }),
			JSON.stringify({ assetIds: ["a", "b", "c"], albumName: "Holiday" }),
		);

		expect(card).toMatchObject({
			kind: "photos.add_to_album",
			subject: "Holiday",
			facts: [{ key: "photos", value: "3" }],
		});
	});
});

describe("buildWriteCard: what it cannot read", () => {
	it.each([
		["an action it does not know", operation({ action: "tasks.create" }), ""],
		[
			"an email missing its recipient",
			operation({ action: "email.send" }),
			JSON.stringify({ subject: "Q3" }),
		],
		[
			"a payload that is not JSON",
			operation({ action: "email.send" }),
			"not json",
		],
		["a file write with no path", operation({ action: "files.put" }), "text"],
		[
			"a move with no source",
			operation({ action: "files.move", target: AT_REPORT }),
			"{}",
		],
		[
			"an album with no photos",
			operation({ action: "immich.add_to_album" }),
			JSON.stringify({ albumName: "Holiday" }),
		],
	])("gives up on %s rather than guessing", (_label, op, content) => {
		expect(cardFor(op, content)).toBeNull();
	});

	it("gives up on a row stored with no operation", () => {
		expect(
			buildWriteCard({
				op: undefined as never,
				content: "",
				preview: {
					title: "x",
					detail: "x",
					reversible: true,
					destructive: false,
					withinAllowlist: null,
					warnings: [],
				},
			}),
		).toBeNull();
	});
});

describe("toPendingWriteDto", () => {
	const record: PendingWriteRecord = {
		id: "pw-1",
		userId: "user-1",
		connectionId: "conn-1",
		provider: "imap",
		op: operation({ action: "email.send" }),
		content: JSON.stringify({
			to: "anna@example.com",
			subject: "Q3",
			body: "Hi",
		}),
		idempotencyKey: "key",
		status: "pending",
		preview: buildWritePreview(operation({ action: "email.send" })),
		etag: null,
		conversationId: "conv-1",
		assistantMessageId: null,
		createdAt: 1_700_000_000,
		expiresAt: null,
	};

	it("hands the page the card and never the row's raw payload", () => {
		const dto = toPendingWriteDto(record, new Map());

		expect(dto.card?.kind).toBe("email.send");
		expect(dto).not.toHaveProperty("op");
		expect(dto).not.toHaveProperty("content");
		expect(dto).not.toHaveProperty("userId");
		expect(dto).not.toHaveProperty("idempotencyKey");
	});

	it("names the account, and survives a connection that is gone", () => {
		expect(
			toPendingWriteDto(record, new Map([["conn-1", "me@example.com"]]))
				.account,
		).toBe("me@example.com");
		expect(toPendingWriteDto(record, new Map()).account).toBeNull();
	});

	it("reports a write past its time as expired, as the confirm would", () => {
		expect(
			toPendingWriteDto({ ...record, expiresAt: 1 }, new Map()).status,
		).toBe("expired");
	});

	it("converts its time to the milliseconds the page compares with", () => {
		expect(toPendingWriteDto(record, new Map()).createdAt).toBe(
			1_700_000_000_000,
		);
	});
});
