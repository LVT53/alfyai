/**
 * The reason codes of the tool rows: one closed list per tool, shared by the
 * server that names a failure and the browser that words it.
 *
 * A person reads a tool row, never a code, an exception or the English note the
 * tool wrote for the model. So the server names every failure, refusal and
 * notable outcome it tells apart with a code from its tool's list below and
 * writes it on the call's segment (`metadata.reasonCode`); the browser maps each
 * code to a kind and a sentence in both languages (`utils/tool-reason-words.ts`).
 * A code a tool writes that is missing here does not compile, a code listed here
 * that the browser has no words for fails its test, and the raw cause stays in
 * the server log.
 *
 * A code rides on the call's metadata and never in the payload the model reads:
 * what the model sees, a segment's stored `status` and the tool catalogue stay
 * exactly as they were. Pure and browser-safe: nothing here imports server code.
 */

/** The metadata field a call's reason code is written to. (`errorCode` is taken: the stream's bucket on `tool_error` segments.) */
export const REASON_CODE_KEY = "reasonCode";
/** run_python's short copy of what the program printed, for the row; never sent to the model. */
export const DISPLAY_OUTPUT_KEY = "displayOutput";
/** The place a `place_not_found` refusal could not resolve, as the person's own words. */
export const REASON_PLACE_KEY = "reasonPlace";

/** Outcomes every tool can have, from the envelope that runs it. A tool lists one of these itself only to give it words of its own. */
export const SHARED_REASON_CODES = [
	// The person pressed Stop.
	"stopped",
	// The tool's own time limit.
	"timed_out",
	// The turn's working time ran out while the step ran.
	"out_of_time",
] as const;
export type SharedReasonCode = (typeof SHARED_REASON_CODES)[number];

/** The nine tools that read or change one of the person's accounts. */
export const CONNECTOR_TOOL_NAMES = [
	"calendar",
	"contacts",
	"email",
	"files",
	"location",
	"media",
	"photos",
	"repos",
	"tasks",
] as const;

/** What the nine account tools tell apart, one list for all of them. */
export const CONNECTOR_REASON_CODES = [
	"not_connected",
	"needs_reconnect",
	"no_such_account",
	"account_unreachable",
	"writes_turned_off",
	"read_only_account",
	"item_not_found",
	"too_large",
	"not_supported",
	"not_set_up",
	"request_adjusted",
	// A cloud model got a summary a local model wrote (`metadata.localDistilled`): the details stayed on the person's server.
	"details_kept_local",
	// A cloud model got nothing: the "details were withheld" successes.
	"details_withheld",
] as const;
export type ConnectorReasonCode = (typeof CONNECTOR_REASON_CODES)[number];

/** Each tool's closed list of reason codes (the shared ones in `SHARED_REASON_CODES` come on top for every tool). */
export const TOOL_REASON_CODES = {
	research_web: ["search_unavailable", "nothing_found", "reading_budget_used"],
	fetch_url: [
		"link_not_from_a_source",
		"reading_budget_used",
		"read_unavailable",
		"site_timeout",
		"site_refused",
		"page_not_found",
		"no_readable_text",
	],
	image_search: ["search_unavailable", "not_set_up", "nothing_found"],
	memory_context: [
		"chat_out_of_reach",
		"nothing_found",
		"memory_off",
		"memory_unavailable",
	],
	calendar: CONNECTOR_REASON_CODES,
	contacts: CONNECTOR_REASON_CODES,
	email: CONNECTOR_REASON_CODES,
	files: CONNECTOR_REASON_CODES,
	location: CONNECTOR_REASON_CODES,
	media: CONNECTOR_REASON_CODES,
	photos: CONNECTOR_REASON_CODES,
	repos: CONNECTOR_REASON_CODES,
	tasks: CONNECTOR_REASON_CODES,
	run_python: ["program_error", "sandbox_unavailable"],
	map_route: [
		"not_set_up",
		"place_not_found",
		"out_of_coverage",
		"no_route",
		"region_preparing",
		"multi_region",
		"region_unavailable",
		"transit_unavailable",
		"geocoder_unavailable",
		"route_service_unavailable",
		"request_adjusted",
	],
	use_skill: ["skill_not_found", "skill_turned_off"],
	suggest_instruction: ["already_offered", "empty_text", "text_too_long"],
	read_artifact: ["item_not_found", "request_adjusted"],
	read_generated_file: ["file_not_found", "ambiguous", "request_adjusted"],
	create_artifact: [
		"reply_limit_reached",
		"kind_not_creatable",
		"too_large",
		"request_adjusted",
	],
	edit_artifact: [
		"request_adjusted",
		"item_not_found",
		"not_editable_as_text",
		"kind_not_editable",
		"rebuild_limit_reached",
		"changed_since_read",
	],
} as const satisfies Record<string, readonly string[]>;

export type ToolWithReasons = keyof typeof TOOL_REASON_CODES;
/** What a tool may name: its own list, or a shared outcome. */
export type ToolReasonCode<T extends ToolWithReasons> =
	| (typeof TOOL_REASON_CODES)[T][number]
	| SharedReasonCode;

/**
 * make_image's refusals (`metadata.imageRefusal`): the call was turned down
 * before a take was queued. Most are the model's to correct; the ones a person
 * must act on, or may care about, get words.
 */
export const IMAGE_REFUSAL_CODES = [
	"unknown_picture",
	"too_many_pictures",
	"too_many_takes",
	"too_many_calls",
	"retry_unknown",
	"retry_twice",
	"transparent_unavailable",
	"not_configured",
	"explicit_request",
] as const;
export type ImageRefusalCode = (typeof IMAGE_REFUSAL_CODES)[number];

/**
 * make_image's failures (`metadata.imageError`): a take that did not make its
 * picture, and the tool's own breakage. A Stop is never one of these: it is
 * `metadata.imageStopped` and reads as the shared `stopped`.
 */
export const IMAGE_ERROR_CODES = [
	"image_server_unreachable",
	"image_graph_rejected",
	"image_graph_missing",
	"image_render_failed",
	"image_render_timeout",
	"image_result_missing",
	"image_input_missing",
	"image_server_not_configured",
	"image_request_invalid",
	"image_blocked",
	"image_unchecked",
	"image_worker_lost",
	"image_take_missing",
	"image_tool_timeout",
	"image_error",
] as const;
export type ImageErrorCode = (typeof IMAGE_ERROR_CODES)[number];

/** A make_image outcome the browser reads from another field: `metadata.imageUnreadable === true`. */
export const IMAGE_DERIVED_CODES = ["image_unreadable"] as const;

/**
 * make_video's refusals and failures (`metadata.videoError`). A Stop is
 * `metadata.videoStopped`, never one of these.
 */
export const VIDEO_ERROR_CODES = [
	"not_configured",
	"not_asked_for",
	"explicit_request",
	"unknown_picture",
	"video_error",
	"video_server_unreachable",
	"video_graph_rejected",
	"video_render_failed",
	"video_render_timeout",
	"video_result_missing",
	"video_input_missing",
	"video_server_not_configured",
	"video_request_invalid",
	"video_item_deleted",
	"video_media_unavailable",
	"video_media_failed",
	"video_artifact_failed",
	"video_blocked",
	"video_unchecked",
	"video_take_missing",
	"video_worker_lost",
	"video_tool_timeout",
] as const;
export type VideoErrorCode = (typeof VIDEO_ERROR_CODES)[number];

/** The codes an Atlas report job ends with (`errorCode`), the job engine's own and the pipeline's, and two it no longer writes but old jobs keep. */
export const ATLAS_ERROR_CODES = [
	"atlas_pipeline_failed",
	"atlas_v3_local_source_unavailable",
	"atlas_v3_no_evidence",
	"atlas_v3_no_verdict",
	"atlas_v3_no_sections",
	"atlas_worker_heartbeat_timeout",
	"no_verdict",
	"job_failed",
	"cancelled",
	// Stored by earlier releases.
	"research_failed",
	"atlas_quality_gate_failed",
] as const;
export type AtlasErrorCode = (typeof ATLAS_ERROR_CODES)[number];

/** Every code any tool can write on a call: what `withReasonCode` accepts. */
export type AnyReasonCode =
	| SharedReasonCode
	| (typeof TOOL_REASON_CODES)[ToolWithReasons][number]
	| ImageRefusalCode
	| ImageErrorCode
	| (typeof IMAGE_DERIVED_CODES)[number]
	| VideoErrorCode
	| AtlasErrorCode;

/**
 * The titles the account tools give a thing that has none. They are
 * model-facing candidate titles in English; a row shows a localized word for
 * each, found by these exact strings, so the server and the browser share them.
 */
export const CONNECTOR_PLACEHOLDER_TITLES = {
	untitledEvent: "(untitled event)",
	noSubject: "(no subject)",
	photo: "(photo)",
} as const;
/** A location fix with no place name is titled this, followed by its ISO time. */
export const LOCATION_AT_PREFIX = "Location at ";

/** run_python's display copy of the program's output: at most this many lines and characters, cut at a line end. */
export const DISPLAY_OUTPUT_MAX_LINES = 12;
export const DISPLAY_OUTPUT_MAX_CHARS = 600;
