// Every cap the artifact family enforces, with the reason it is a constant.
//
// None of these is environment-backed or admin-configurable in v1. If one ever
// needs tuning it follows the env.ts → config-store.ts → settings-route path
// (AGENTS.md), and that is a change to that cap alone. Refusals are return
// values, never throws: the model-facing tools (slice 5a) must hand the model a
// structured refusal it can read, and a throw would make every caller wrap.

/**
 * A body is `artifacts.content_text` in SQLite. 2 MiB is twenty times the
 * largest real document body; a knob for a value nothing tunes is a worse trade
 * than a pinned constant. Over it, create/update answer `too_large`.
 */
export const ARTIFACT_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Card and panel titles are one line. Clamped at write — never refused, since
 * refusing a whole artifact over its title would lose the body with it — so no
 * render has to truncate.
 */
export const ARTIFACT_TITLE_MAX_CHARS = 200;

/**
 * A version summary is a sentence rendered in the history list. Clamped at
 * write for the title's reason: a long summary must not cost the version.
 */
export const ARTIFACT_VERSION_SUMMARY_MAX_CHARS = 500;

/** The repo's list-page convention; overridable per call. */
export const ARTIFACT_VERSIONS_DEFAULT_LIMIT = 50;

/** A comment is prose, not a document. Over it, the comment is refused. */
export const ARTIFACT_COMMENT_BODY_MAX_CHARS = 10_000;

/**
 * An App's storage (slice 2's `window.alfy.storage` bridge) must not become an
 * unbounded bag. Checked on the insert path only: updating an existing key
 * never counts against it.
 */
export const ARTIFACT_KV_MAX_KEYS = 200;

/** localStorage-shaped keys. */
export const ARTIFACT_KV_KEY_MAX_CHARS = 128;

/**
 * One App's whole state should stay in the low hundreds of kB; slice 2
 * surfaces the refusal to the App.
 */
export const ARTIFACT_KV_VALUE_MAX_BYTES = 256 * 1024;
