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

/**
 * Ruling 48 (orchestrator, 2026-09-25, from Slice 0's own data review): a
 * per-value cap (256 KiB) and a key-count cap (200) still allow one App to
 * hold ~50 MiB, because neither bounds the SUM. `kv.setKv` enforces this
 * inside its own transaction — the sum of every row's value bytes AFTER the
 * write, refusing with no write at all — in the same reason family as the
 * per-value cap; slice 2's `APP_KV_LIMITS.maxTotalBytes` derives from this
 * constant rather than restating it (a test pins the equality).
 */
export const ARTIFACT_KV_TOTAL_MAX_BYTES = 512 * 1024;

/**
 * Ruling 47: a user-authored save coalesces into the latest version (same
 * version number, body/hash/timestamp updated in place) when that latest
 * version is also the user's and was created within this window. Every Alfy
 * change, restore and creation still always appends. Ten minutes is the
 * ruling's own number — one editing burst, not a rolling debounce.
 */
export const ARTIFACT_USER_VERSION_COALESCE_MS = 10 * 60 * 1000;
