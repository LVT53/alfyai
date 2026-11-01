import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "$lib/i18n";
import type {
	PendingWrite,
	WriteCard,
	WriteCardFact,
	WriteCardKind,
	WriteCardRisk,
} from "$lib/server/services/connections/pending-write-dto";
import { uiLanguage } from "$lib/stores/settings";
import type { Translate } from "$lib/utils/tool-evidence-presentation";
import {
	buildSettledWriteItem,
	buildWriteCardView,
	formatEventWhen,
	settledWriteNote,
} from "./write-card-view";

function translatorFor(language: "en" | "hu"): Translate {
	uiLanguage.set(language);
	return get(t);
}

const hu = translatorFor("hu");
const en = translatorFor("en");

const CARD: WriteCard = {
	kind: "calendar.create_event",
	subject: "Dentist",
	facts: [],
	message: null,
	risks: [],
	danger: false,
};

function write(overrides: Partial<PendingWrite> = {}): PendingWrite {
	return {
		id: "pw-1",
		conversationId: "conv-1",
		assistantMessageId: "assistant-1",
		status: "pending",
		provider: "google",
		createdAt: 1_700_000_000,
		preview: {
			title: 'Create "Dentist" on your Google Calendar',
			detail: "calendar.create_event — Dentist",
			reversible: true,
			destructive: false,
			withinAllowlist: null,
			warnings: [],
		},
		card: CARD,
		...overrides,
	};
}

describe("buildWriteCardView", () => {
	it("names the account a write lands in, when it is one a person knows by name", () => {
		expect(
			buildWriteCardView(write({ account: "me@example.com" }), en, "en")
				.qualifier,
		).toBe("Google · me@example.com");
		expect(buildWriteCardView(write(), en, "en").qualifier).toBe("Google");
		expect(
			buildWriteCardView(
				write({ provider: "nextcloud", account: "cloud.alfy.hu" }),
				en,
				"en",
			).qualifier,
		).toBe("Nextcloud");
	});

	it("keeps the gravest risk and drops the rest", () => {
		const view = (risks: WriteCardRisk[]) =>
			buildWriteCardView(write({ card: { ...CARD, risks } }), en, "en").risk;

		expect(view([])).toBeNull();
		expect(view(["public_link"])).toEqual({
			tone: "caution",
			text: "Anyone with the link can open this.",
		});
		expect(view(["outside_allowed_folders", "cannot_undo"])).toEqual({
			tone: "danger",
			text: "This can't be undone.",
		});
	});

	it("uses no word a person would have to look up", () => {
		const risks: WriteCardRisk[] = [
			"replaces_file_for_good",
			"replaces_file_unchecked",
			"deletes_whole_series",
			"changes_whole_series",
			"cannot_undo",
			"public_link",
			"outside_allowed_folders",
		];
		for (const risk of risks) {
			const text =
				buildWriteCardView(
					write({ card: { ...CARD, risks: [risk] } }),
					en,
					"en",
				).risk?.text ?? "";
			expect(text).not.toMatch(
				/allowlist|version|recurring|verif|server|Nextcloud|write\b/i,
			);
			expect(text.length).toBeLessThan(60);
		}
	});

	it("speaks the reader's language, not the sentence the write was proposed with", () => {
		const view = buildWriteCardView(write(), hu, "hu");

		expect(view.question).toBe("Felvegyem ezt az eseményt?");
		expect(view.approveLabel).toBe("Felvétel");
		expect(view.doneLabel).toBe("Felvéve");
		expect(JSON.stringify(view)).not.toContain("Google Calendar");
	});

	it("gives a line its word only where the value does not speak for itself", () => {
		const facts: WriteCardFact[] = [
			{ key: "to", value: "anna@example.com" },
			{ key: "folder", value: "/AlfyAI" },
		];
		const view = buildWriteCardView(
			write({ card: { ...CARD, facts } }),
			en,
			"en",
		);

		expect(view.facts).toEqual([
			{
				key: "to",
				label: "To",
				value: "anna@example.com",
				quiet: false,
			},
			{ key: "folder", label: null, value: "/AlfyAI", quiet: true },
		]);
	});

	it("has every kind and risk in both languages", () => {
		const kinds: WriteCardKind[] = [
			"email.send",
			"email.trash",
			"email.mark_read",
			"email.mark_unread",
			"email.flag",
			"email.unflag",
			"calendar.create_event",
			"calendar.update_event",
			"calendar.delete_event",
			"files.save",
			"files.replace",
			"files.move",
			"files.rename",
			"files.delete",
			"files.create_folder",
			"files.share_link",
			"photos.add_to_album",
		];
		const risks: WriteCardRisk[] = [
			"replaces_file_for_good",
			"replaces_file_unchecked",
			"deletes_whole_series",
			"changes_whole_series",
			"cannot_undo",
			"public_link",
			"outside_allowed_folders",
		];
		for (const translate of [en, hu]) {
			for (const kind of kinds) {
				const view = buildWriteCardView(
					write({ card: { ...CARD, kind } }),
					translate,
					"en",
				);
				for (const word of [view.question, view.approveLabel, view.doneLabel]) {
					expect(word).not.toContain("connections.writeConfirm");
				}
			}
			for (const risk of risks) {
				const view = buildWriteCardView(
					write({ card: { ...CARD, risks: [risk] } }),
					translate,
					"en",
				);
				expect(view.risk?.text).not.toContain("connections.writeConfirm");
			}
		}
	});

	it("calls a write with no name by what it does, so a row and a screen reader have words", () => {
		const view = buildWriteCardView(
			write({
				provider: "imap",
				card: {
					...CARD,
					kind: "email.mark_read",
					subject: "",
				},
			}),
			en,
			"en",
		);

		expect(view.name).toBeNull();
		expect(view.subject).toBe("Mark as read");
	});

	it("falls back to the proposed sentence, whole, for a write it cannot read", () => {
		const view = buildWriteCardView(write({ card: null }), en, "en");

		expect(view.question).toBe('Create "Dentist" on your Google Calendar');
		expect(view.name).toBeNull();
		expect(view.facts).toEqual([]);
		expect(view.approveLabel).toBe("Confirm");
	});
});

describe("formatEventWhen", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-01T12:00:00"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("collapses an event inside one day to the day and a time range", () => {
		const shown = formatEventWhen(
			"2026-11-03T09:00:00",
			"2026-11-03T09:30:00",
			"en",
		);

		expect(shown).toContain("Tuesday 3 November");
		expect(shown).toMatch(/09:00\s*–\s*09:30/);
	});

	it("reads in Hungarian", () => {
		const shown = formatEventWhen(
			"2026-11-03T09:00:00",
			"2026-11-03T09:30:00",
			"hu",
		);

		expect(shown).toContain("november 3.");
		expect(shown).toContain("kedd");
	});

	it("shows a single day for an all-day event, whose end is the morning after", () => {
		const shown = formatEventWhen("2026-11-03", "2026-11-04", "en");

		expect(shown).toContain("3 November");
		expect(shown).not.toContain("4 November");
		expect(shown).not.toMatch(/\d:\d\d/);
	});

	it("runs an all-day event to the last day it covers", () => {
		const shown = formatEventWhen("2026-11-03", "2026-11-06", "en");

		expect(shown).toContain("5 November");
		expect(shown).not.toContain("6 November");
	});

	it("says the year only when it is not this one", () => {
		expect(
			formatEventWhen("2026-11-03T09:00:00", undefined, "en"),
		).not.toContain("2026");
		expect(formatEventWhen("2027-01-05T09:00:00", undefined, "en")).toContain(
			"2027",
		);
	});

	it("leaves a change with no end at its start", () => {
		expect(formatEventWhen("2026-11-03T09:00:00", undefined, "en")).toContain(
			"3 November",
		);
	});

	it("shows a string that is no date as it is, rather than throwing", () => {
		expect(formatEventWhen("tomorrow morning", undefined, "en")).toBe(
			"tomorrow morning",
		);
		expect(formatEventWhen("soon", "later", "en")).toBe("soon – later");
	});

	it("does not throw on an end before the start", () => {
		expect(
			formatEventWhen("2026-11-03T09:00:00", "2026-11-02T09:00:00", "en"),
		).toContain("3 November");
	});
});

describe("buildSettledWriteItem", () => {
	it.each([
		["executed", "done", "Added"],
		["failed", "failed", "Failed"],
		["cancelled", "skipped", "Cancelled"],
		["expired", "skipped", "Expired"],
	] as const)("draws a write that %s as a %s row", (status, rowStatus, verb) => {
		const settled = write({ status });
		const item = buildSettledWriteItem(
			settled,
			buildWriteCardView(settled, en, "en"),
			en,
		);

		expect(item.status).toBe(rowStatus);
		expect(item.verb).toBe(verb);
		expect(item.object).toBe("Dentist");
		expect(item.iconType).toBe("calendar");
	});

	it("gives a chevron only to a row with something to show", () => {
		const bare = write({ status: "executed" });
		expect(
			buildSettledWriteItem(bare, buildWriteCardView(bare, en, "en"), en).body,
		).toBeNull();

		const detailed = write({
			status: "executed",
			card: {
				...CARD,
				facts: [{ key: "folder", value: "/AlfyAI" }],
			},
		});
		expect(
			buildSettledWriteItem(
				detailed,
				buildWriteCardView(detailed, en, "en"),
				en,
			).body,
		).toEqual({ kind: "write" });
	});

	it("does not paint the provider's name red on a failed row", () => {
		const failed = write({ status: "failed" });

		expect(
			buildSettledWriteItem(failed, buildWriteCardView(failed, en, "en"), en)
				.meta,
		).toBe("");
	});
});

describe("settledWriteNote", () => {
	it("speaks only when something went wrong or went stale", () => {
		expect(settledWriteNote(write({ status: "executed" }), en)).toBeNull();
		expect(settledWriteNote(write({ status: "cancelled" }), en)).toBeNull();
		expect(settledWriteNote(write({ status: "failed" }), en)).toContain(
			"nothing was changed",
		);
		expect(settledWriteNote(write({ status: "expired" }), en)).toContain(
			"Ask again",
		);
	});
});
