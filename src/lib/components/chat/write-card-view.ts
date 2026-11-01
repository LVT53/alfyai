// What the permission card says, worked out from a pending write. Pure, like
// tool-activity.ts, with the translator passed in: the server names what is
// happening (`write.card`), and this turns it into words in the reader's
// language. Text the server wrote in English (`write.preview`) is shown only for
// a write it could not read, which is the fallback and not the card.
import { getProviderCatalogEntry } from "$lib/client/connections/provider-catalog";
import type { I18nKey } from "$lib/i18n";
import type {
	PendingWrite,
	WriteCardFact,
	WriteCardFactKey,
	WriteCardKind,
	WriteCardRisk,
} from "$lib/server/services/connections/pending-write-dto";
import { intlLocale } from "$lib/utils/locale";
import type {
	ToolActivityItem,
	ToolActivityStatus,
} from "$lib/utils/tool-activity";
import type { ToolCallIconType } from "$lib/utils/tool-calls";
import type { Translate } from "$lib/utils/tool-evidence-presentation";

type KindCopy = {
	question: I18nKey;
	approve: I18nKey;
	done: I18nKey;
	icon: ToolCallIconType;
};

const KIND_COPY: Record<WriteCardKind, KindCopy> = {
	"email.send": {
		question: "connections.writeConfirm.question.emailSend",
		approve: "connections.writeConfirm.approve.emailSend",
		done: "connections.writeConfirm.done.emailSend",
		icon: "email",
	},
	"email.trash": {
		question: "connections.writeConfirm.question.emailTrash",
		approve: "connections.writeConfirm.approve.emailTrash",
		done: "connections.writeConfirm.done.emailTrash",
		icon: "email",
	},
	"email.mark_read": {
		question: "connections.writeConfirm.question.emailMarkRead",
		approve: "connections.writeConfirm.approve.emailMarkRead",
		done: "connections.writeConfirm.done.emailMarkRead",
		icon: "email",
	},
	"email.mark_unread": {
		question: "connections.writeConfirm.question.emailMarkUnread",
		approve: "connections.writeConfirm.approve.emailMarkUnread",
		done: "connections.writeConfirm.done.emailMarkUnread",
		icon: "email",
	},
	"email.flag": {
		question: "connections.writeConfirm.question.emailFlag",
		approve: "connections.writeConfirm.approve.emailFlag",
		done: "connections.writeConfirm.done.emailFlag",
		icon: "email",
	},
	"email.unflag": {
		question: "connections.writeConfirm.question.emailUnflag",
		approve: "connections.writeConfirm.approve.emailUnflag",
		done: "connections.writeConfirm.done.emailUnflag",
		icon: "email",
	},
	"calendar.create_event": {
		question: "connections.writeConfirm.question.calendarCreate",
		approve: "connections.writeConfirm.approve.calendarCreate",
		done: "connections.writeConfirm.done.calendarCreate",
		icon: "calendar",
	},
	"calendar.update_event": {
		question: "connections.writeConfirm.question.calendarUpdate",
		approve: "connections.writeConfirm.approve.calendarUpdate",
		done: "connections.writeConfirm.done.calendarUpdate",
		icon: "calendar",
	},
	"calendar.delete_event": {
		question: "connections.writeConfirm.question.calendarDelete",
		approve: "connections.writeConfirm.approve.calendarDelete",
		done: "connections.writeConfirm.done.calendarDelete",
		icon: "calendar",
	},
	"files.save": {
		question: "connections.writeConfirm.question.filesSave",
		approve: "connections.writeConfirm.approve.filesSave",
		done: "connections.writeConfirm.done.filesSave",
		icon: "files",
	},
	"files.replace": {
		question: "connections.writeConfirm.question.filesReplace",
		approve: "connections.writeConfirm.approve.filesReplace",
		done: "connections.writeConfirm.done.filesReplace",
		icon: "files",
	},
	"files.move": {
		question: "connections.writeConfirm.question.filesMove",
		approve: "connections.writeConfirm.approve.filesMove",
		done: "connections.writeConfirm.done.filesMove",
		icon: "files",
	},
	"files.rename": {
		question: "connections.writeConfirm.question.filesRename",
		approve: "connections.writeConfirm.approve.filesRename",
		done: "connections.writeConfirm.done.filesRename",
		icon: "files",
	},
	"files.delete": {
		question: "connections.writeConfirm.question.filesDelete",
		approve: "connections.writeConfirm.approve.filesDelete",
		done: "connections.writeConfirm.done.filesDelete",
		icon: "files",
	},
	"files.create_folder": {
		question: "connections.writeConfirm.question.filesCreateFolder",
		approve: "connections.writeConfirm.approve.filesCreateFolder",
		done: "connections.writeConfirm.done.filesCreateFolder",
		icon: "files",
	},
	"files.share_link": {
		question: "connections.writeConfirm.question.filesShareLink",
		approve: "connections.writeConfirm.approve.filesShareLink",
		done: "connections.writeConfirm.done.filesShareLink",
		icon: "files",
	},
	"photos.add_to_album": {
		question: "connections.writeConfirm.question.photosAddToAlbum",
		approve: "connections.writeConfirm.approve.photosAddToAlbum",
		done: "connections.writeConfirm.done.photosAddToAlbum",
		icon: "photos",
	},
};

// A line either speaks for itself (a time, a place, a folder) or needs its word
// ("To anna@example.com"). The ones a person checks before saying yes stay in
// the reading colour; a location is a footnote to the name above it.
const FACT_LINE: Record<
	WriteCardFactKey,
	{ label?: I18nKey; quiet: boolean }
> = {
	to: { label: "connections.writeConfirm.fact.to", quiet: false },
	cc: { label: "connections.writeConfirm.fact.cc", quiet: false },
	when: { quiet: false },
	where: { quiet: true },
	folder: { quiet: true },
	new_name: { label: "connections.writeConfirm.fact.newName", quiet: false },
	photos: { label: "connections.writeConfirm.fact.photos", quiet: false },
};

export type WriteRiskTone = "danger" | "caution";

const RISK_COPY: Record<WriteCardRisk, { text: I18nKey; tone: WriteRiskTone }> =
	{
		replaces_file_for_good: {
			text: "connections.writeConfirm.risk.replacesFileForGood",
			tone: "danger",
		},
		replaces_file_unchecked: {
			text: "connections.writeConfirm.risk.replacesFileUnchecked",
			tone: "danger",
		},
		deletes_whole_series: {
			text: "connections.writeConfirm.risk.deletesWholeSeries",
			tone: "danger",
		},
		changes_whole_series: {
			text: "connections.writeConfirm.risk.changesWholeSeries",
			tone: "caution",
		},
		cannot_undo: {
			text: "connections.writeConfirm.risk.cannotUndo",
			tone: "danger",
		},
		public_link: {
			text: "connections.writeConfirm.risk.publicLink",
			tone: "caution",
		},
		outside_allowed_folders: {
			text: "connections.writeConfirm.risk.outsideAllowedFolders",
			tone: "caution",
		},
		unchecked_folder: {
			text: "connections.writeConfirm.risk.uncheckedFolder",
			tone: "caution",
		},
	};

export type WriteCardFactLine = {
	key: string;
	label: string | null;
	value: string;
	quiet: boolean;
};

export type WriteCardView = {
	/** What Alfy is asking, in the reader's language. */
	question: string;
	/** The account this lands in. */
	qualifier: string;
	/** The name drawn large, when the write has one. Without it the question is the headline. */
	name: string | null;
	/** What to call this write: the settled row's object and the accessible names'. */
	subject: string;
	facts: WriteCardFactLine[];
	message: string | null;
	risks: { key: string; tone: WriteRiskTone; text: string }[];
	approveLabel: string;
	doneLabel: string;
	danger: boolean;
	iconType: ToolCallIconType;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseEventDate(value: string): Date | null {
	// A bare date is a day in the reader's own calendar, and `new Date` would
	// read it as midnight in Greenwich, which is the day before west of it.
	const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00` : value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** An event's time in the reader's language and clock. A string that is no date is shown as it is. */
export function formatEventWhen(
	start: string,
	end: string | undefined,
	language: string,
): string {
	const from = parseEventDate(start);
	if (!from) return end ? `${start} – ${end}` : start;

	const allDay = DATE_ONLY.test(start);
	const to = end ? parseEventDate(end) : null;
	// Calendars end an all-day event at the start of the day after it, so the
	// last day it covers is the one before.
	if (allDay && to) to.setDate(to.getDate() - 1);

	const format = new Intl.DateTimeFormat(intlLocale(language), {
		weekday: "long",
		month: "long",
		day: "numeric",
		...(from.getFullYear() === new Date().getFullYear()
			? {}
			: { year: "numeric" }),
		...(allDay ? {} : { hour: "numeric", minute: "2-digit" }),
	});
	return to && to > from ? format.formatRange(from, to) : format.format(from);
}

function factValue(fact: WriteCardFact, language: string): string {
	return fact.key === "when"
		? formatEventWhen(fact.value, fact.end, language)
		: fact.value;
}

export function buildWriteCardView(
	write: PendingWrite,
	t: Translate,
	language: string,
): WriteCardView {
	const provider = getProviderCatalogEntry(write.provider).displayName;
	const qualifier = write.account ? `${provider} · ${write.account}` : provider;
	const card = write.card;
	if (!card) {
		return {
			question: write.preview.title,
			qualifier,
			name: null,
			subject: write.preview.title,
			facts: [],
			message: null,
			risks: write.preview.warnings.map((warning) => ({
				key: warning,
				tone: write.preview.destructive ? "danger" : "caution",
				text: warning,
			})),
			approveLabel: t("connections.writeConfirm.confirm"),
			doneLabel: t("connections.writeConfirm.done.generic"),
			danger: write.preview.destructive,
			iconType: "generic",
		};
	}

	const copy = KIND_COPY[card.kind];
	const approveLabel = t(copy.approve);
	return {
		question: t(copy.question),
		qualifier,
		name: card.subject || null,
		// Marking an email as read names no email: the row still says what it did.
		subject: card.subject || approveLabel,
		facts: card.facts.map((fact) => {
			const line = FACT_LINE[fact.key];
			return {
				key: fact.key,
				label: line.label ? t(line.label) : null,
				value: factValue(fact, language),
				quiet: line.quiet,
			};
		}),
		message: card.message,
		risks: card.risks.map((risk) => ({
			key: risk,
			tone: RISK_COPY[risk].tone,
			text: t(RISK_COPY[risk].text),
		})),
		approveLabel,
		doneLabel: t(copy.done),
		danger: card.danger,
		iconType: copy.icon,
	};
}

/** The line a settled write owes the reader beyond its status word. */
export function settledWriteNote(
	write: PendingWrite,
	t: Translate,
): string | null {
	if (write.status === "expired") {
		return t("connections.writeConfirm.note.expired");
	}
	if (write.status === "failed") {
		return t("connections.writeConfirm.note.failed");
	}
	return null;
}

const SETTLED_STATUS: Record<string, ToolActivityStatus> = {
	executed: "done",
	failed: "failed",
	cancelled: "skipped",
	expired: "skipped",
};

/** A decided write as the row every tool call draws: it is a record of what happened now, not a question. */
export function buildSettledWriteItem(
	write: PendingWrite,
	view: WriteCardView,
	t: Translate,
): ToolActivityItem {
	const verb =
		write.status === "executed"
			? view.doneLabel
			: write.status === "failed"
				? t("connections.writeConfirm.status.failed")
				: write.status === "expired"
					? t("connections.writeConfirm.status.expired")
					: t("connections.writeConfirm.status.cancelled");
	const hasDetails =
		view.facts.length > 0 ||
		view.message !== null ||
		settledWriteNote(write, t) !== null;
	return {
		key: `write-${write.id}`,
		status: SETTLED_STATUS[write.status] ?? "done",
		iconType: view.iconType,
		verb,
		object: view.subject,
		meta:
			write.status === "failed"
				? ""
				: getProviderCatalogEntry(write.provider).displayName,
		summaryLabel: `${verb} ${view.subject}`.trim(),
		pinned: true,
		alwaysOpen: false,
		body: hasDetails ? { kind: "write" } : null,
		title: `${verb} ${view.subject}`.trim(),
	};
}
