// The one registry of what a tool outcome says to a person.
//
// A tool row never shows a code, an exception, an HTTP status or the English note
// a tool wrote for the model. The server names every failure, refusal and notable
// outcome with a reason code from its tool's closed list (`$lib/shared/tool-reasons`,
// written on the call's `metadata.reasonCode`); this module maps each code to its
// kind and to the key of its sentence in `i18n/tool-rows.ts`, in both languages.
// `tool-reason-words.test.ts` holds the rule: a code with no entry here does not
// compile, a key that does not resolve in English and Hungarian fails its test, and
// a tool of the model's catalogue without a fallback fails too. So a new tool cannot
// ship without its words, and a new code cannot ship without its sentence.
//
// Pure and browser-safe: nothing here reads a store or touches the server. It
// replaces the picture and clip rows' own code maps (`IMAGE_REASON_KEYS`,
// `videoReasonKey`), which `tool-activity.ts` used to keep.

import {
	FILE_PRODUCTION_ERROR_KEYS,
	FILE_PRODUCTION_STOP_CODES,
} from "$lib/components/chat/file-production-helpers";
import type { I18nKey } from "$lib/i18n";
import {
	type AtlasErrorCode,
	type ConnectorReasonCode,
	type IMAGE_DERIVED_CODES,
	type ImageErrorCode,
	type ImageRefusalCode,
	SHARED_REASON_CODES,
	type SharedReasonCode,
	TOOL_REASON_CODES,
	type ToolWithReasons,
	type VideoErrorCode,
} from "$lib/shared/tool-reasons";
import {
	getToolCallIconType,
	type ToolCallIconType,
} from "$lib/utils/tool-calls";

/**
 * What a code stands for, as the row draws it:
 * - `fail`: something broke. The red cross, shown status `failed`.
 * - `stop`: the app stopped on purpose (a check, a filter, a limit), or a setting
 *   the person can change. The quiet dash, shown status `skipped`.
 * - `info`: nothing is wrong and there is one thing to say. A tick with a line.
 * - `empty`: a search or a lookup that found nothing. A tick, the meta "nothing
 *   found", and no body.
 */
export type ReasonKind = "fail" | "stop" | "info" | "empty";

/** `key: null` when the row's own verb says it all and the row has no body. */
type ReasonWords = { kind: ReasonKind; key: I18nKey | null };

type ToolWords<Codes extends string> = {
	codes: Record<Codes, ReasonWords> &
		Partial<Record<SharedReasonCode, ReasonWords>>;
	/** The sentence for a failure with a code this table does not know, or none. */
	fallback: I18nKey;
};

type OwnCodes<T extends ToolWithReasons> =
	(typeof TOOL_REASON_CODES)[T][number];

type ImageDerivedCode = (typeof IMAGE_DERIVED_CODES)[number];

type ToolReasonTables = {
	[T in ToolWithReasons]: ToolWords<OwnCodes<T>>;
} & {
	make_image: ToolWords<ImageRefusalCode | ImageErrorCode | ImageDerivedCode>;
	make_video: ToolWords<VideoErrorCode>;
	/** An Atlas report job, which is drawn as a tool row too. */
	atlas: ToolWords<AtlasErrorCode>;
	/** A file job: its codes are open strings, worded by the file card's own map. */
	produce_file: ToolWords<string>;
};

const fail = (key: I18nKey | null): ReasonWords => ({ kind: "fail", key });
const stop = (key: I18nKey | null): ReasonWords => ({ kind: "stop", key });
const info = (key: I18nKey | null): ReasonWords => ({ kind: "info", key });
const empty = (key: I18nKey | null): ReasonWords => ({ kind: "empty", key });
/** A stop whose row says it all in its own verb and has no sentence. */
const quiet: ReasonWords = { kind: "stop", key: null };

/** The floor under every tool: what the envelope that runs a tool can say about any of them. */
const SHARED_WORDS: Record<SharedReasonCode, ReasonWords> = {
	stopped: stop("toolRows.shared.stopped"),
	timed_out: fail("toolRows.shared.timed_out"),
	out_of_time: stop("toolRows.shared.out_of_time"),
};

/**
 * A call the browser found cut off: still marked `running` in a reply that is
 * over, though the person did not press Stop (an update or a crash ended the
 * reply, and the server never closed the step). The server never writes it, so it
 * is in none of `$lib/shared/tool-reasons`' lists: the row's builder gives it to
 * the call, and it is a quiet stop with one sentence for every tool. A Stop the
 * person pressed is the server's `stopped` instead.
 */
export const UNFINISHED_CODE = "unfinished";
const UNFINISHED_WORDS: ReasonWords = stop("toolRows.shared.unfinished");

/**
 * The nine account tools tell the same cases apart, each in its own account's
 * words, so one builder holds what is common (a code's kind, the words shared by
 * all nine) and each tool gives its own sentences.
 */
function connectorTable(keys: {
	notConnected: I18nKey;
	needsReconnect: I18nKey;
	noSuchAccount: I18nKey;
	accountUnreachable: I18nKey;
	writesTurnedOff: I18nKey;
	readOnlyAccount: I18nKey;
	itemNotFound: I18nKey;
	tooLarge: I18nKey;
	notSupported: I18nKey;
	notSetUp: I18nKey;
	fallback: I18nKey;
}): ToolWords<ConnectorReasonCode> {
	return {
		codes: {
			not_connected: stop(keys.notConnected),
			needs_reconnect: fail(keys.needsReconnect),
			no_such_account: stop(keys.noSuchAccount),
			account_unreachable: fail(keys.accountUnreachable),
			writes_turned_off: stop(keys.writesTurnedOff),
			read_only_account: stop(keys.readOnlyAccount),
			item_not_found: fail(keys.itemNotFound),
			too_large: stop(keys.tooLarge),
			not_supported: stop(keys.notSupported),
			not_set_up: stop(keys.notSetUp),
			request_adjusted: stop("toolRows.shared.request_adjusted"),
			details_kept_local: info("toolRows.connector.details_kept_local"),
			details_withheld: info("toolRows.connector.details_withheld"),
		},
		fallback: keys.fallback,
	};
}

/** The file maker's codes with the card's sentences, each a stop on purpose or a breakage. */
function fileMakerWords(): Record<string, ReasonWords> {
	return Object.fromEntries(
		Object.entries(FILE_PRODUCTION_ERROR_KEYS).map(([code, key]) => [
			code,
			FILE_PRODUCTION_STOP_CODES.has(code) ? stop(key) : fail(key),
		]),
	);
}

export const TOOL_REASON_WORDS: ToolReasonTables = {
	research_web: {
		codes: {
			search_unavailable: fail("toolRows.research_web.search_unavailable"),
			nothing_found: empty("toolRows.research_web.nothing_found"),
			reading_budget_used: stop("toolRows.research_web.reading_budget_used"),
		},
		fallback: "toolRows.research_web.fallback",
	},
	fetch_url: {
		codes: {
			link_not_from_a_source: stop("toolRows.fetch_url.link_not_from_a_source"),
			reading_budget_used: stop("toolRows.fetch_url.reading_budget_used"),
			read_unavailable: fail("toolRows.fetch_url.read_unavailable"),
			site_timeout: fail("toolRows.fetch_url.site_timeout"),
			site_refused: fail("toolRows.fetch_url.site_refused"),
			page_not_found: fail("toolRows.fetch_url.page_not_found"),
			no_readable_text: fail("toolRows.fetch_url.no_readable_text"),
			// The tool's own time limit is the site not answering in time.
			timed_out: fail("toolRows.fetch_url.site_timeout"),
		},
		fallback: "toolRows.fetch_url.fallback",
	},
	image_search: {
		codes: {
			search_unavailable: fail("toolRows.image_search.search_unavailable"),
			not_set_up: stop("toolRows.image_search.not_set_up"),
			nothing_found: empty("toolRows.image_search.nothing_found"),
			timed_out: fail("toolRows.image_search.search_timeout"),
		},
		fallback: "toolRows.image_search.fallback",
	},
	memory_context: {
		codes: {
			chat_out_of_reach: stop("toolRows.memory_context.chat_out_of_reach"),
			nothing_found: empty("toolRows.memory_context.nothing_found"),
			memory_off: stop("toolRows.memory_context.memory_off"),
			memory_unavailable: fail("toolRows.memory_context.memory_unavailable"),
		},
		fallback: "toolRows.memory_context.memory_unavailable",
	},
	calendar: connectorTable({
		notConnected: "toolRows.connector.calendar.not_connected",
		needsReconnect: "toolRows.connector.calendar.needs_reconnect",
		noSuchAccount: "toolRows.connector.calendar.no_such_account",
		accountUnreachable: "toolRows.connector.calendar.account_unreachable",
		writesTurnedOff: "toolRows.connector.calendar.writes_turned_off",
		readOnlyAccount: "toolRows.connector.calendar.read_only_account",
		itemNotFound: "toolRows.connector.calendar.item_not_found",
		tooLarge: "toolRows.connector.too_large",
		notSupported: "toolRows.connector.calendar.not_supported",
		notSetUp: "toolRows.connector.calendar.not_set_up",
		fallback: "toolRows.connector.calendar.fallback",
	}),
	contacts: connectorTable({
		notConnected: "toolRows.connector.contacts.not_connected",
		needsReconnect: "toolRows.connector.contacts.needs_reconnect",
		noSuchAccount: "toolRows.connector.contacts.no_such_account",
		accountUnreachable: "toolRows.connector.contacts.account_unreachable",
		writesTurnedOff: "toolRows.connector.contacts.writes_turned_off",
		readOnlyAccount: "toolRows.connector.contacts.read_only_account",
		itemNotFound: "toolRows.connector.contacts.item_not_found",
		tooLarge: "toolRows.connector.too_large",
		notSupported: "toolRows.connector.contacts.not_supported",
		notSetUp: "toolRows.connector.contacts.not_set_up",
		fallback: "toolRows.connector.contacts.fallback",
	}),
	email: connectorTable({
		notConnected: "toolRows.connector.email.not_connected",
		needsReconnect: "toolRows.connector.email.needs_reconnect",
		noSuchAccount: "toolRows.connector.email.no_such_account",
		accountUnreachable: "toolRows.connector.email.account_unreachable",
		writesTurnedOff: "toolRows.connector.email.writes_turned_off",
		readOnlyAccount: "toolRows.connector.email.read_only_account",
		itemNotFound: "toolRows.connector.email.item_not_found",
		tooLarge: "toolRows.connector.email.too_large",
		notSupported: "toolRows.connector.email.not_supported",
		notSetUp: "toolRows.connector.email.not_set_up",
		fallback: "toolRows.connector.email.fallback",
	}),
	files: connectorTable({
		notConnected: "toolRows.connector.files.not_connected",
		needsReconnect: "toolRows.connector.files.needs_reconnect",
		noSuchAccount: "toolRows.connector.files.no_such_account",
		accountUnreachable: "toolRows.connector.files.account_unreachable",
		writesTurnedOff: "toolRows.connector.files.writes_turned_off",
		readOnlyAccount: "toolRows.connector.files.read_only_account",
		itemNotFound: "toolRows.connector.files.item_not_found",
		tooLarge: "toolRows.connector.files.too_large",
		notSupported: "toolRows.connector.files.not_supported",
		notSetUp: "toolRows.connector.files.not_set_up",
		fallback: "toolRows.connector.files.fallback",
	}),
	location: connectorTable({
		notConnected: "toolRows.connector.location.not_connected",
		needsReconnect: "toolRows.connector.location.needs_reconnect",
		noSuchAccount: "toolRows.connector.location.no_such_account",
		accountUnreachable: "toolRows.connector.location.account_unreachable",
		writesTurnedOff: "toolRows.connector.location.writes_turned_off",
		readOnlyAccount: "toolRows.connector.location.read_only_account",
		itemNotFound: "toolRows.connector.location.item_not_found",
		tooLarge: "toolRows.connector.too_large",
		notSupported: "toolRows.connector.location.not_supported",
		notSetUp: "toolRows.connector.location.not_set_up",
		fallback: "toolRows.connector.location.fallback",
	}),
	media: connectorTable({
		notConnected: "toolRows.connector.media.not_connected",
		needsReconnect: "toolRows.connector.media.needs_reconnect",
		noSuchAccount: "toolRows.connector.media.no_such_account",
		accountUnreachable: "toolRows.connector.media.account_unreachable",
		writesTurnedOff: "toolRows.connector.media.writes_turned_off",
		readOnlyAccount: "toolRows.connector.media.read_only_account",
		itemNotFound: "toolRows.connector.media.item_not_found",
		tooLarge: "toolRows.connector.too_large",
		notSupported: "toolRows.connector.media.not_supported",
		notSetUp: "toolRows.connector.media.not_set_up",
		fallback: "toolRows.connector.media.fallback",
	}),
	photos: connectorTable({
		notConnected: "toolRows.connector.photos.not_connected",
		needsReconnect: "toolRows.connector.photos.needs_reconnect",
		noSuchAccount: "toolRows.connector.photos.no_such_account",
		accountUnreachable: "toolRows.connector.photos.account_unreachable",
		writesTurnedOff: "toolRows.connector.photos.writes_turned_off",
		readOnlyAccount: "toolRows.connector.photos.read_only_account",
		itemNotFound: "toolRows.connector.photos.item_not_found",
		tooLarge: "toolRows.connector.photos.too_large",
		notSupported: "toolRows.connector.photos.not_supported",
		notSetUp: "toolRows.connector.photos.not_set_up",
		fallback: "toolRows.connector.photos.fallback",
	}),
	repos: connectorTable({
		notConnected: "toolRows.connector.repos.not_connected",
		needsReconnect: "toolRows.connector.repos.needs_reconnect",
		noSuchAccount: "toolRows.connector.repos.no_such_account",
		accountUnreachable: "toolRows.connector.repos.account_unreachable",
		writesTurnedOff: "toolRows.connector.repos.writes_turned_off",
		readOnlyAccount: "toolRows.connector.repos.read_only_account",
		itemNotFound: "toolRows.connector.repos.item_not_found",
		tooLarge: "toolRows.connector.too_large",
		notSupported: "toolRows.connector.repos.not_supported",
		notSetUp: "toolRows.connector.repos.not_set_up",
		fallback: "toolRows.connector.repos.fallback",
	}),
	tasks: connectorTable({
		notConnected: "toolRows.connector.tasks.not_connected",
		needsReconnect: "toolRows.connector.tasks.needs_reconnect",
		noSuchAccount: "toolRows.connector.tasks.no_such_account",
		accountUnreachable: "toolRows.connector.tasks.account_unreachable",
		writesTurnedOff: "toolRows.connector.tasks.writes_turned_off",
		readOnlyAccount: "toolRows.connector.tasks.read_only_account",
		itemNotFound: "toolRows.connector.tasks.item_not_found",
		tooLarge: "toolRows.connector.too_large",
		notSupported: "toolRows.connector.tasks.not_supported",
		notSetUp: "toolRows.connector.tasks.not_set_up",
		fallback: "toolRows.connector.tasks.fallback",
	}),
	run_python: {
		codes: {
			program_error: fail("toolRows.run_python.program_error"),
			sandbox_unavailable: fail("toolRows.run_python.sandbox_unavailable"),
			// Its own time limit reads as the calculation running out of time.
			timed_out: fail("toolRows.run_python.timed_out"),
		},
		fallback: "toolRows.run_python.sandbox_unavailable",
	},
	map_route: {
		codes: {
			not_set_up: stop("toolRows.map_route.not_set_up"),
			place_not_found: fail("toolRows.map_route.place_not_found"),
			out_of_coverage: stop("toolRows.map_route.out_of_coverage"),
			no_route: fail("toolRows.map_route.no_route"),
			region_preparing: stop("toolRows.map_route.region_preparing"),
			multi_region: stop("toolRows.map_route.multi_region"),
			region_unavailable: fail("toolRows.map_route.region_unavailable"),
			transit_unavailable: stop("toolRows.map_route.transit_unavailable"),
			geocoder_unavailable: fail("toolRows.map_route.geocoder_unavailable"),
			route_service_unavailable: fail(
				"toolRows.map_route.route_service_unavailable",
			),
			request_adjusted: stop("toolRows.shared.request_adjusted"),
		},
		fallback: "toolRows.map_route.fallback",
	},
	use_skill: {
		codes: {
			// The row says it in its verb ("No skill called …") and has no body.
			skill_not_found: quiet,
			skill_turned_off: stop("toolRows.use_skill.skill_turned_off"),
		},
		fallback: "toolRows.use_skill.fallback",
	},
	suggest_instruction: {
		codes: {
			already_offered: stop("toolRows.suggest_instruction.already_offered"),
			empty_text: stop("toolRows.suggest_instruction.not_offered"),
			text_too_long: stop("toolRows.suggest_instruction.not_offered"),
		},
		fallback: "toolRows.suggest_instruction.not_offered",
	},
	read_artifact: {
		codes: {
			item_not_found: fail("toolRows.shared.item_not_found"),
			request_adjusted: stop("toolRows.shared.request_adjusted"),
		},
		fallback: "toolRows.read.fallback",
	},
	read_generated_file: {
		codes: {
			file_not_found: fail("toolRows.read.file_not_found"),
			ambiguous: stop("toolRows.read.ambiguous"),
			request_adjusted: stop("toolRows.shared.request_adjusted"),
		},
		fallback: "toolRows.read.fallback",
	},
	create_artifact: {
		codes: {
			reply_limit_reached: stop("toolRows.create_artifact.reply_limit_reached"),
			kind_not_creatable: stop("toolRows.create_artifact.kind_not_creatable"),
			too_large: stop("toolRows.create_artifact.too_large"),
			// The row says it in its verb ("Adjusting the request") and has no body.
			request_adjusted: quiet,
		},
		fallback: "toolRows.create_artifact.fallback",
	},
	edit_artifact: {
		codes: {
			request_adjusted: quiet,
			item_not_found: fail("toolRows.shared.item_not_found"),
			not_editable_as_text: stop("toolRows.edit_artifact.not_editable_as_text"),
			kind_not_editable: stop("toolRows.edit_artifact.kind_not_editable"),
			rebuild_limit_reached: stop(
				"toolRows.edit_artifact.rebuild_limit_reached",
			),
			changed_since_read: stop("toolRows.edit_artifact.changed_since_read"),
		},
		fallback: "toolRows.edit_artifact.fallback",
	},
	make_image: {
		codes: {
			// A refusal meant for the model, which corrects itself: the row's own
			// "Adjusting the picture request", no sentence.
			unknown_picture: quiet,
			too_many_pictures: quiet,
			too_many_takes: quiet,
			too_many_calls: quiet,
			retry_unknown: quiet,
			retry_twice: quiet,
			transparent_unavailable: stop(
				"toolActivity.pictureReason.transparentUnavailable",
			),
			not_configured: fail("toolActivity.pictureReason.notConfigured"),
			explicit_request: stop("toolActivity.pictureReason.explicitRequest"),
			image_server_unreachable: fail("toolActivity.pictureReason.unreachable"),
			image_graph_rejected: fail("toolActivity.pictureReason.rejected"),
			image_graph_missing: fail("toolActivity.pictureReason.generic"),
			image_render_failed: fail("toolActivity.pictureReason.renderFailed"),
			image_render_timeout: fail("toolActivity.pictureReason.renderTimeout"),
			image_result_missing: fail("toolActivity.pictureReason.resultMissing"),
			image_input_missing: fail("toolActivity.pictureReason.inputMissing"),
			image_server_not_configured: fail(
				"toolActivity.pictureReason.notConfigured",
			),
			image_request_invalid: fail("toolActivity.pictureReason.requestInvalid"),
			// The filter turned the finished picture down on purpose; when it could
			// not check, it may later, so that one stays a failure.
			image_blocked: stop("toolActivity.pictureReason.blocked"),
			image_unchecked: fail("toolActivity.pictureReason.unchecked"),
			image_worker_lost: fail("toolActivity.pictureReason.generic"),
			image_take_missing: fail("toolActivity.pictureReason.generic"),
			// The tool gave up waiting, but the take is still rendering and lands on
			// its card: the row's "still being made", no sentence.
			image_tool_timeout: info(null),
			image_error: fail("toolActivity.pictureReason.generic"),
			image_unreadable: fail("toolActivity.pictureReason.unreadable"),
			// A Stop keeps the row's verb ("Picture stopped") and says no more.
			stopped: quiet,
		},
		fallback: "toolActivity.pictureReason.generic",
	},
	make_video: {
		codes: {
			not_configured: fail("artifacts.video.card.unavailable"),
			not_asked_for: stop("toolRows.make_video.not_asked_for"),
			explicit_request: stop("toolRows.make_video.explicit_request"),
			// A picture that is not in the chat: the row's "Adjusting the video
			// request", no sentence.
			unknown_picture: quiet,
			video_error: fail("toolRows.make_video.fallback"),
			video_server_unreachable: fail("artifacts.video.card.unavailable"),
			video_graph_rejected: fail("toolRows.make_video.video_graph_rejected"),
			video_render_failed: fail("toolRows.make_video.video_render_failed"),
			video_render_timeout: fail("toolRows.make_video.video_render_timeout"),
			video_result_missing: fail("toolRows.make_video.video_result_missing"),
			video_input_missing: fail("toolRows.make_video.video_input_missing"),
			video_server_not_configured: fail("artifacts.video.card.unavailable"),
			video_request_invalid: fail("toolRows.make_video.video_request_invalid"),
			video_item_deleted: fail("toolRows.make_video.video_item_deleted"),
			video_media_unavailable: fail("toolRows.make_video.video_media_failed"),
			video_media_failed: fail("toolRows.make_video.video_media_failed"),
			video_artifact_failed: fail("toolRows.make_video.video_artifact_failed"),
			video_blocked: stop("artifacts.video.card.blockedDetail"),
			video_unchecked: fail("artifacts.video.card.uncheckedDetail"),
			video_take_missing: fail("toolRows.make_video.video_take_missing"),
			video_worker_lost: fail("toolRows.make_video.fallback"),
			// The tool gave up waiting, but the clip is still rendering and lands on
			// its card: the row's "still being made", no sentence.
			video_tool_timeout: info(null),
			// A Stop keeps the row's verb ("Stopped the video") and says no more.
			stopped: quiet,
		},
		fallback: "toolRows.make_video.fallback",
	},
	atlas: {
		codes: {
			atlas_pipeline_failed: fail("atlas.failed"),
			atlas_v3_local_source_unavailable: fail(
				"toolRows.atlas.atlas_v3_local_source_unavailable",
			),
			atlas_v3_no_evidence: stop("toolRows.atlas.atlas_v3_no_evidence"),
			atlas_v3_no_verdict: fail("toolRows.atlas.atlas_v3_no_verdict"),
			atlas_v3_no_sections: fail("toolRows.atlas.atlas_v3_no_sections"),
			atlas_worker_heartbeat_timeout: fail(
				"toolRows.atlas.atlas_worker_heartbeat_timeout",
			),
			no_verdict: fail("toolRows.atlas.atlas_v3_no_verdict"),
			job_failed: fail("atlas.failed"),
			// A report the person stopped keeps the row's own cancelled state.
			cancelled: quiet,
			// Stored by earlier releases: their cause is not worth a sentence of its own.
			research_failed: fail("atlas.failed"),
			atlas_quality_gate_failed: fail("atlas.failed"),
		},
		fallback: "atlas.failed",
	},
	produce_file: {
		// The file maker's codes are open strings the file card words itself
		// (`FILE_PRODUCTION_ERROR_KEYS`, `file-production-helpers.ts`); the row takes
		// each one's kind from the same place: a limit, a kind of file it will not
		// make and a cancel are stops on purpose, everything else a breakage.
		codes: fileMakerWords(),
		fallback: "fileProduction.failedDescription",
	},
};

/** The sentence for a tool this registry does not know: a new tool before its words are written. */
const GENERIC_FALLBACK: I18nKey = "toolRows.generic.fallback";

/**
 * `changed_since_read` names the kind of item that changed ("The document
 * changed since Alfy read it"): the base sentence is for any other kind.
 */
const CHANGED_SINCE_READ_BY_KIND: Readonly<Record<string, I18nKey>> = {
	document: "toolRows.edit_artifact.changed_since_read.document",
	canvas: "toolRows.edit_artifact.changed_since_read.canvas",
	app: "toolRows.edit_artifact.changed_since_read.app",
	slides: "toolRows.edit_artifact.changed_since_read.slides",
};

/**
 * The tool each kind of row stands for, for a call saved under another name: an
 * older release's search tool ("web_search") is still a web search in the rail, and
 * a failure of it should read as one.
 */
const TOOL_OF_ICON_TYPE: Partial<Record<ToolCallIconType, string>> = {
	"web-search": "research_web",
	"fetch-url": "fetch_url",
	"image-search": "image_search",
	memory: "memory_context",
	"run-python": "run_python",
	"map-route": "map_route",
	"use-skill": "use_skill",
	"file-production": "produce_file",
	calendar: "calendar",
	contacts: "contacts",
	email: "email",
	files: "files",
	location: "location",
	media: "media",
	photos: "photos",
	repos: "repos",
	tasks: "tasks",
};

function tableFor(toolName: string): ToolWords<string> | null {
	const tables = TOOL_REASON_WORDS as unknown as Record<
		string,
		ToolWords<string>
	>;
	if (Object.hasOwn(tables, toolName)) return tables[toolName];
	const aliasOf = TOOL_OF_ICON_TYPE[getToolCallIconType(toolName)];
	return aliasOf ? tables[aliasOf] : null;
}

function isSharedCode(code: string): code is SharedReasonCode {
	return (SHARED_REASON_CODES as readonly string[]).includes(code);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

type ReasonMetadata = Record<string, string | number | boolean | null>;

/**
 * The reason code a call's metadata carries, or null: `metadata.reasonCode`, and
 * for the tools that kept their own fields, those. A picture's and a clip's
 * Stop is a flag of its own (`imageStopped`, `videoStopped`), and so is a picture
 * that could not be read (`imageUnreadable`); a suggestion's refusal wrote its
 * `reason`; an account call a local model summarised (`localDistilled`) kept its
 * details on the person's server. A stored `errorCode` is never read: it is the
 * stream's bucket (`"timeout"` and the rest), not a cause, so an older failed row
 * gets its tool's fallback.
 *
 * A Stop and the turn's deadline win over any code a tool wrote itself (a Stop
 * must never read as a tool's catch-all); a tool's own code wins over the shared
 * timeout. An older read that was refused on purpose (`ok: false` with a count of
 * the addresses it refused, and no code) reads as that refusal.
 */
export function readReasonCode(
	toolName: string,
	metadata: ReasonMetadata | undefined,
): string | null {
	const shared = nonEmptyString(metadata?.reasonCode);
	if (shared === "stopped" || shared === "out_of_time") return shared;
	if (toolName === "make_image") {
		if (metadata?.imageStopped === true) return "stopped";
		if (metadata?.imageUnreadable === true) return "image_unreadable";
		return (
			nonEmptyString(metadata?.imageRefusal) ??
			nonEmptyString(metadata?.imageError) ??
			shared
		);
	}
	if (toolName === "make_video") {
		if (metadata?.videoStopped === true) return "stopped";
		return nonEmptyString(metadata?.videoError) ?? shared;
	}
	if (shared) return shared;
	if (toolName === "suggest_instruction") {
		return nonEmptyString(metadata?.reason);
	}
	// A refusal saved before codes: the app turned a link down (it came from neither
	// the person nor a search), which an older release recorded as `ok: false` and the
	// number of addresses it refused, with a status of done and no code.
	if (
		getToolCallIconType(toolName) === "fetch-url" &&
		metadata?.ok === false &&
		typeof metadata.refusedUrlCount === "number" &&
		metadata.refusedUrlCount > 0
	) {
		return "link_not_from_a_source";
	}
	if (
		metadata?.localDistilled === true &&
		Object.hasOwn(TOOL_REASON_CODES, toolName) &&
		(
			TOOL_REASON_CODES[toolName as ToolWithReasons] as readonly string[]
		).includes("details_kept_local")
	) {
		return "details_kept_local";
	}
	return null;
}

/**
 * What a code says and how the row draws it. A known code gives its words; a
 * shared code the tool does not word itself gives the shared words; an unknown
 * code, or none, gives the tool's fallback as a failure, so an older row (saved
 * before codes) and a code from a newer server both read as a sentence and never
 * as the code or the model's note. A tool outside the registry gets a generic
 * fallback. `context.artifactKind` lets a changed item name its own kind.
 */
export function resolveToolReason(
	toolName: string,
	code: string | null,
	context?: { artifactKind?: string | null },
): { code: string | null; kind: ReasonKind; key: I18nKey | null } {
	if (code === UNFINISHED_CODE) return { code, ...UNFINISHED_WORDS };
	const table = tableFor(toolName);
	const own =
		table && code && Object.hasOwn(table.codes, code)
			? (table.codes as Record<string, ReasonWords>)[code]
			: null;
	if (own) {
		const byKind =
			toolName === "edit_artifact" &&
			code === "changed_since_read" &&
			context?.artifactKind &&
			Object.hasOwn(CHANGED_SINCE_READ_BY_KIND, context.artifactKind)
				? CHANGED_SINCE_READ_BY_KIND[context.artifactKind]
				: null;
		return { code, kind: own.kind, key: byKind ?? own.key };
	}
	if (code && isSharedCode(code)) {
		return { code, ...SHARED_WORDS[code] };
	}
	return {
		code,
		kind: "fail",
		key: table ? table.fallback : GENERIC_FALLBACK,
	};
}

/**
 * Every sentence key this registry can answer with, for the one test that asserts
 * each resolves in both languages: a key that landed in neither dictionary would
 * otherwise print the key itself in a person's row.
 */
export function toolReasonKeys(): I18nKey[] {
	const keys = new Set<I18nKey>([
		GENERIC_FALLBACK,
		...Object.values(CHANGED_SINCE_READ_BY_KIND),
	]);
	if (UNFINISHED_WORDS.key) keys.add(UNFINISHED_WORDS.key);
	for (const words of Object.values(SHARED_WORDS)) {
		if (words.key) keys.add(words.key);
	}
	for (const table of Object.values(
		TOOL_REASON_WORDS as unknown as Record<string, ToolWords<string>>,
	)) {
		keys.add(table.fallback);
		for (const words of Object.values(
			table.codes as Record<string, ReasonWords>,
		)) {
			if (words.key) keys.add(words.key);
		}
	}
	return [...keys];
}
