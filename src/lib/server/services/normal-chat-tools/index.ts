import type { JSONSchema7 } from "@ai-sdk/provider";
import { type Tool, type ToolExecutionOptions, tool } from "ai";
import { z } from "zod";

import { getConfig } from "$lib/server/config-store";
import { recordParallelUsage } from "$lib/server/services/analytics";
import type { ReasoningDepthWebSourceBudget } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type { Capability } from "$lib/server/services/connections/registry";
import {
	getConversationFileProductionJob,
	submitFileProductionIntake,
	waitForFileProductionJobVerdict,
} from "$lib/server/services/file-production";
import { getFileProductionWorkerConfig } from "$lib/server/services/file-production/config";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import { searchImages } from "$lib/server/services/image-search";
import { getMemoryContext } from "$lib/server/services/memory-context";
import { toolReadArtifactIdsMetadata } from "$lib/server/services/message-evidence";
import { fetchUrlViaParallel } from "$lib/server/services/parallel-search/fetch-url";
import type { GroundedWebResult } from "$lib/server/services/parallel-search/types";
import {
	getConversationProjectId,
	getProjectInstructions,
} from "$lib/server/services/projects";
import { transitCoverageLabelFor } from "$lib/server/services/routing/gtfs-catalogue";
import { createOrsProvider } from "$lib/server/services/routing/ors-provider";
import { loadedGtfsFeedIds } from "$lib/server/services/routing/region-manager";
import { getRoutingRegionManager } from "$lib/server/services/routing/region-runtime";
import { createRegionalRoutingProvider } from "$lib/server/services/routing/regional-provider";
import { OSM_ATTRIBUTION } from "$lib/server/services/routing/types";
import { executeCode as executeSandboxCode } from "$lib/server/services/sandbox-execution";
import { resolveSkillInstructionsForUse } from "$lib/server/services/skills/prompt-context";
import { getCachedToolHealthSnapshot } from "$lib/server/services/tool-health";
import {
	buildGroundedWebModelPayload,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
	summarizeGroundedWebResult,
} from "$lib/server/services/web-grounding";
import { isTextLikeExtension } from "$lib/shared/file-types/production";
import {
	advertisedArtifactKinds,
	buildCreateArtifactInputSchema,
	buildCreateArtifactModelInputSchema,
	type CreatableArtifactKind,
	type CreateArtifactModelPayload,
	MAX_CREATE_ARTIFACT_CALLS_PER_TURN,
	runCreateArtifactTool,
} from "./artifact-tools/create";
import {
	buildEditArtifactModelInputSchema,
	type EditArtifactModelPayload,
	editArtifactInputSchema,
	runEditArtifactTool,
} from "./artifact-tools/edit";
import {
	artifactKindListEn,
	artifactKindListHu,
	artifactKindListHuAccusative,
	createArtifactChoiceClause,
	createArtifactUseCasePhrase,
	editArtifactExampleClause,
	editArtifactRuleClause,
} from "./artifact-tools/kind-prose";
import {
	type ReadArtifactModelPayload,
	readArtifactInputSchema,
	runReadArtifactTool,
} from "./artifact-tools/read";
import {
	calendarToolInputSchema,
	runCalendarTool,
	sanitizeCalendarToolInput,
} from "./calendar";
import {
	contactsToolInputSchema,
	runContactsTool,
	sanitizeContactsToolInput,
} from "./contacts";
import {
	emailToolInputSchema,
	runEmailTool,
	sanitizeEmailToolInput,
} from "./email";
import {
	fetchUrlInputSchema,
	resolveFetchContentCharCap,
	sanitizeFetchUrlInput,
} from "./fetch-url";
import {
	filesToolInputSchema,
	runFilesTool,
	sanitizeFilesToolInput,
} from "./files";
import {
	compactImageSearchResults,
	createImageSearchCandidates,
	imageSearchInputSchema,
	sanitizeImageSearchInput,
} from "./image-search";
import {
	locationToolInputSchema,
	runLocationTool,
	sanitizeLocationToolInput,
} from "./location";
import {
	mediaToolInputSchema,
	runMediaTool,
	sanitizeMediaToolInput,
} from "./media";
import {
	compactMemoryContextCandidates,
	compactMemoryContextModelPayload,
	createMemoryContextMetadata,
	memoryContextCandidateLimit,
	memoryContextInputSchema,
	sanitizeMemoryContextInput,
	summarizeMemoryContextResult,
} from "./memory-context";
import { resolveModelContextTokens } from "./model-context-tokens";
import {
	photosToolInputSchema,
	runPhotosTool,
	sanitizePhotosToolInput,
} from "./photos";
import {
	applyTextPatches,
	buildNoPatchBaseMessage,
	buildProduceFileFailedPayload,
	buildProduceFileIntakeFailurePayload,
	buildProduceFileRunningPayload,
	buildProduceFileSucceededPayload,
	buildSameTurnProduceFileArtifactKey,
	buildSameTurnProduceFileDedupeKey,
	buildScopedIdempotencyKey,
	createProduceFileToolCallEntry,
	MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN,
	MAX_SAME_TURN_PRODUCE_FILE_SUBMISSIONS,
	namedOutputTypeFromInput,
	normalizeProduceFileInput,
	outputTypeFromFilename,
	PRODUCE_FILE_RETRY_LIMIT_ERROR_CODE,
	PRODUCE_FILE_TURN_LIMIT_ERROR_CODE,
	PRODUCE_FILE_VERDICT_POLL_INTERVAL_MS,
	PRODUCE_FILE_VERDICT_WAIT_MS,
	type ProduceFileModelPayload,
	produceFileInputSchema,
	produceFileModelInputSchema,
	sanitizeProduceFileInput,
	sanitizeUnsafeProduceFileInput,
	summarizeProduceFileResult,
	withProduceFileWarnings,
} from "./produce-file";
import {
	buildReadGeneratedFileModelPayload,
	readGeneratedFileExecutionInputSchema,
	readGeneratedFileForTool,
	readGeneratedFileInputSchema,
	resolveGeneratedFilePatchBase,
	sanitizeReadGeneratedFileInput,
	summarizeReadGeneratedFileResult,
} from "./read-generated-file";
import {
	reposToolInputSchema,
	runReposTool,
	sanitizeReposToolInput,
} from "./repos";
import { createResearchWebTool, RESEARCH_WEB_I18N } from "./research-web-tool";
import {
	routingToolInputSchema,
	routingToolModelSchema,
	runRoutingTool,
	sanitizeRoutingToolInput,
} from "./routing";
import {
	buildRunPythonModelPayload,
	runPythonInputSchema,
	sanitizeRunPythonInput,
	summarizeRunPythonResult,
} from "./run-python";
import {
	asExecutableTool,
	compactToolInputSchema,
	createToolCallRecorder,
	executeToolWithEnvelope,
	modelSafeToolError,
	TOOL_TIMEOUTS_MS,
	type ToolCallRecorder,
} from "./shared";
import {
	buildInstructionSuggestion,
	buildSuggestInstructionOffered,
	buildSuggestInstructionRefusal,
	normalizeSuggestedInstruction,
	resolveOfferedScope,
	type SuggestInstructionFailurePayload,
	type SuggestInstructionModelPayload,
	type SuggestInstructionRefusalReason,
	type SuggestInstructionRefusedPayload,
	suggestInstructionInputSchema,
} from "./suggest-instruction";
import {
	runTasksTool,
	sanitizeTasksToolInput,
	tasksToolInputSchema,
} from "./tasks";
import {
	applyDegradedToolHints,
	collectDegradedToolHints,
} from "./tool-health-hints";
import {
	buildToolResultCacheKey,
	getCachedToolResult,
	setCachedToolResult,
} from "./tool-result-cache";

const useSkillInputSchema = z.object({
	name: z
		.string()
		.min(1)
		.max(200)
		.describe('Exact skill name from "## Skills available"'),
});

type UseSkillModelPayload =
	| { found: true; error: null; displayName: string; instructions: string }
	| { found: false; error: string; displayName: null; instructions: null };

// ── Public re-exports ──────────────────────────────────────────

export {
	isProduceFileRequest,
	shouldForceProduceFileTool,
} from "./produce-file";
export type { ToolCallRecorder } from "./shared";
export { createToolCallRecorder, recordToolCallEntry } from "./shared";

// ── Context ────────────────────────────────────────────────────

export interface CreateNormalChatToolsContext {
	userId: string;
	conversationId: string;
	turnId: string;
	recorder?: ToolCallRecorder;
	language?: "en" | "hu";
	webSourceBudget?: ReasoningDepthWebSourceBudget;
	// The capabilities the user currently has at least one connected
	// connection serving (see getEnabledConnectionCapabilities). Controls
	// which connection-backed tools (e.g. "files") are exposed to the model —
	// callers compute this upstream and should fail closed (omit/empty) on
	// error rather than block the turn. Connections work in incognito (issue
	// 0.1 removed incognito gating) — this is deliberately NOT gated on it.
	enabledConnectionCapabilities?: Set<Capability>;
	// The chat model selected for this turn. Threaded through to
	// connection-backed tools (e.g. "files") so they can gate connector data
	// on the locality Option-A distillation rule (isCloudModel(modelId) +
	// hasLocalDistillEnabled(userId)). Falls back to "model1" (local) when
	// omitted, which matches today's behavior for callers not yet updated.
	modelId?: string;
	// Names of the routing regions currently ready (on-demand coverage), used
	// in the map_route description. Computed upstream (createToolPack) because
	// tool construction is synchronous; omitted when on-demand routing is off.
	routingCoverageLabel?: string;
	// Names of the regions whose public-transport timetables are loaded, for
	// the map_route description's TIMETABLES line. Computed upstream for the
	// same reason routingCoverageLabel is.
	routingTransitCoverageLabel?: string;
	// The turn's current user message, used by use_skill to select the (up to
	// 3) pack resources whose keywords match this request — the same
	// selectSkillResources logic the forced `$` skill injection uses.
	requestText?: string;
	// How long produce_file waits in-turn for the file-production ledger's
	// verdict, and how often it looks. Defaults to
	// PRODUCE_FILE_VERDICT_WAIT_MS / PRODUCE_FILE_VERDICT_POLL_INTERVAL_MS;
	// overridden only by tests and by callers that stage the worker themselves
	// (0 means "report whatever the ledger already says, do not wait").
	fileProductionVerdictWaitMs?: number;
	fileProductionVerdictPollIntervalMs?: number;
}

// ── I18n ───────────────────────────────────────────────────────

type ToolI18n = Record<string, { description: string; errorPrefix: string }>;

const TOOL_I18N: Record<"en" | "hu", ToolI18n> = {
	en: {
		// Moved to research-web-tool.ts (ruling 57) alongside the tool itself;
		// re-imported here so the assembled catalogue is byte-identical.
		research_web: RESEARCH_WEB_I18N.en,
		fetch_url: {
			description:
				'Read named web pages: {"urls": ["https://example.com"]} (always an array, at most 5) plus an optional `objective` saying what to extract. Call for a link the user gave, or a detail only that page has. Do not use it to find pages you have no URL for (research_web finds them, and its `readPages` returns page text), nor for stored files or files in this conversation (files, read_generated_file). Returns `evidence` snippets and an `answerBriefMarkdown`.',
			errorPrefix: "Fetch URL failed",
		},
		map_route: {
			description:
				'Places, distances, travel times, routes and public transport departures on OpenStreetMap data. Call for "how far", "how long to get there", "route/directions", "what is within 20 minutes", a transit journey or the next departures, and to turn a place name into coordinates. Do not use research_web or image_search for any of those, and do not use this tool to find out where the user is — it does not know; call `location` first for their coordinates. Pass one `action`: `geocode` (query, optional near/limit), `route` (origin, destination, optional waypoints), `matrix` (origins, destinations), `isochrone` (origin, ranges_s in seconds), `transit` (public transport journey with times and lines: origin, destination, optional departure or arrive_by and max_walk_minutes), `timetable` (the next departures between two places: origin, destination, optional from, window_minutes, rows) or `journey` (mixed modes in order, e.g. bike, train, walk; give `legs` plus origin/destination and either arrive_by or departure). A place is a name string or {"lat":52.52,"lng":13.4}; `mode` is drive (default), walk or bike. Example: {"action":"route","origin":"Berlin Hbf","destination":"Brandenburg Gate","mode":"walk"}. Returns summary, distance_m, duration_s, steps, legs and polygons (transit and journey add local clock times, lines and changes), and renders a map card already showing the FULL directions or timeline — so summarise the journey\'s key turns or changes and the times, not every step, and always include "© OpenStreetMap contributors".',
			errorPrefix: "Routing failed",
		},
		memory_context: {
			description:
				"Look up durable memory when it would materially improve the answer. `mode` `persona` (default) for preferences and goals; `history` for older conversations matching `query`, then one of them via `historyConversationId` + `maxMessages`; `project` for project-folder continuity (name the folder in `query`), then a returned `siblingConversationId` for detail. Do not use it to re-fetch memory this turn already quotes — same store, so call only to go deeper or further back — nor for this conversation, which you already read, nor for stored files (files). `conversationId` is supplied automatically; never ask for or pass user, folder or project ids. Returns memory entries and conversation excerpts; an empty result is not proof no memory exists.",
			errorPrefix: "Memory context lookup failed",
		},
		image_search: {
			description:
				'Find web images (photos, illustrations, diagrams) to show in the answer: {"query": "golden retriever puppy"}. Do not use it for maps, routes, distances or anything geographic (map_route renders its own map card), for the user\'s own pictures (photos), or for facts and text (research_web). Returns a list of image URLs. Embed the ones you use in your answer with markdown `![alt text](url)` where they belong; the user never sees raw tool output, so an unembedded image is invisible.',
			errorPrefix: "Image search failed",
		},
		produce_file: {
			description:
				"Create a downloadable file (PDF, DOCX, XLSX, PPTX, CSV, Markdown, ...). Call it only when the user asks for a file, after dependent tools have returned real content — never placeholder or empty content. Do not use it to work the data out (run_python first), to read a file back (read_generated_file), or when no download was asked for — a summary, table or list belongs in your reply. Simple form: `requestTitle`, `filename` or `outputType`, and `markdown`; the server picks the production mode. Do not mix PDF/DOCX/HTML with md/txt/csv/tsv/json/code in one request; call twice. To change an existing file, call `read_generated_file` first, then resend it in full or send `patches` [{oldText, newText}] with each oldText an exact, unique excerpt of 20+ characters. Use `program` only for artifacts that need code to build (XLSX, PPTX, ZIP): name the type in `outputType`/`requestedOutputs`, and the code must write into `/output` (e.g. `/output/report.xlsx`) — a bare filename is lost. Use `documentSource` blocks only when structure clearly improves a PDF/DOCX/HTML report: heading{level,text}, paragraph{text}, list{style,items}, table{columns:[{key,label}],rows:[{key:value}]}, chart{chartType:bar|stackedBar|line|area|pie|scatter|donut,title,labelKey,valueKey,seriesKey(stackedBar only),data:[{label,value}]}, code{language,text}, callout{tone,text}. Never draw tables or charts as text (no pipe tables, no block-character bars); encode line breaks as \\n in JSON strings. Returns `status`: `succeeded` with `files` — only then say the file is ready; `failed` with `errorCode`/`message` — if `retryable`, fix it and resubmit once, else say plainly why it failed; `running` — still being made, not ready.",
			errorPrefix: "File production intake failed",
		},
		read_generated_file: {
			description:
				"Read a file's full current text in THIS conversation or its project — one produced here, one uploaded or linked here (under Conversation Files), or one linked to the project (under Project Files) — by `filename` or `requestTitle`. Name a project's file to read it: that list only says it exists. Call it before `produce_file` patches (a non-exact oldText is rejected), or when the user wants more of a document than your context shows. Long text arrives in windows: on `hasMore`, call again with `from: nextFrom`. Pass `query` for up to 3 passages about a topic instead of the window. For a paged document pass `page`; excerpts carry citable `[p. 3]`/`[slide 2]` markers. Do not use it for connected cloud storage (files), web pages (fetch_url), remembered preferences (memory_context), or a passage already quoted in your context. Returns text with `hasMore`/`nextFrom`, or not found / ambiguous (several files match — retry with one exact name); say so, don't guess.",
			errorPrefix: "Read generated file failed",
		},
		run_python: {
			description:
				'Run a short Python 3.11 script for scratch work: arithmetic beyond mental math, unit and date/time conversions, parsing or aggregating data the user gave you, quick algorithms. Pass {"code": "..."} and optionally a one-line `purpose`; print() the values you need. Do not use it to deliver a file (produce_file — files written to /output are NOT delivered), to reach the network (there is none), or for one step you can state and check in prose. Only the Python standard library is available (no numpy, no pandas, no pip installs); openpyxl, xlsxwriter, python-docx and python-pptx are present for produce_file\'s program mode, not here. Returns stdout, stderr and the exit code only, capped at 8,000 characters each (head and tail kept). Isolated Docker sandbox, 90-second limit; a run that times out is reported, not silently dropped.',
			errorPrefix: "Python execution failed",
		},
		files: {
			description:
				"List, search, read, and manage the user's connected file storage (Nextcloud or OneDrive). `list` counts a folder's contents (pass its path, or omit it for the root); `search` finds files by name across the whole tree; `read` opens one file by its path. Every result carries the last-modified time, so 'my most recent invoice' or 'the newest file' is answerable. Do not use it for photos or videos (photos), for a file in this conversation (read_generated_file), for a web page (fetch_url), or for remembered preferences (memory_context). Can also `save`, `move`/rename (`destinationPath`), `delete` (to trash, recoverable), `create_folder` and `share_link` (a PUBLIC link anyone with the URL can open, a deliberate exposure — use sparingly): these require the user to have enabled writes, are NOT available for OneDrive (read-only), and NEVER apply immediately — each only proposes a pending write the user must confirm. Returns entries with path, size and modified time; `read` adds the text. With several accounts connected, pass `account` (provider, label, or email).",
			errorPrefix: "Files lookup failed",
		},
		calendar: {
			description:
				"Read the user's connected calendar (Google or Apple iCloud): `list_events` (upcoming/ranged, optionally scoped via `calendarId`), `check_availability` (free/busy, Google only, also `calendarId`-scopable), or `list_calendars` to discover calendar ids before scoping a read or write (Google enumerates fully; Apple iCloud reads can't be scoped). Call when the user asks about their schedule, upcoming events, or whether they're free at a time. Do not use it for to-dos, due dates or checklists — those live in `tasks`, a separate store this cannot see — or for travel time between events (map_route). Can also create_event/update_event/delete_event on a connected Google Calendar (requires the user to have enabled writes) — these NEVER apply immediately: each only proposes a pending change the user must confirm. For an event in a recurring series, ask first whether to affect that occurrence or the whole series. Returns events with start/end, title and location. With several accounts connected, pass `account` (provider, label, or email).",
			errorPrefix: "Calendar lookup failed",
		},
		email: {
			description:
				"Read the user's connected email (IMAP): list recent messages; `search` by free text and/or `from` (sender), `subject`, and a `since`/`before` date range; `count` matches without listing them (defaults to unread); or read a specific message by uid. Reads default to the Inbox but accept a `folder` (e.g. 'Sent', 'Archive', or a name from `list_folders`); a read also lists attachments (filename/type/size). Do not use it to open an attachment's contents or the user's stored documents (files), or for meetings and invitations, which belong to `calendar`. Can also send a new email, move a message to Trash, or flag/mark a message (requires the user to have enabled writes) — these NEVER apply immediately: each only proposes a pending change the user must confirm. A sent email cannot be unsent: double-check recipient, subject and body first. Returns headers, plus the body on a uid read. With several accounts connected, pass `account` (provider, label, or email).",
			errorPrefix: "Email lookup failed",
		},
		photos: {
			description:
				"Find the user's own photos/videos in their connected library (Immich). `search` is a natural-language SMART search matching visual/semantic CONTENT (what a photo depicts) — use it for 'a beach at sunset' or 'my dog in the snow'. For PRECISE filtering use `search_by_date`: a capture-date range (`from`/`to`, YYYY-MM-DD), place (`city`/`country`), media `type` (IMAGE/VIDEO), `favorites`, and/or a `personName` — this answers 'photos from June 2019', 'my favourites', or 'photos of a named person'. `list_albums` and `album` (by `albumId`) browse albums; `list_people` finds a recognized person's exact name. Do not use it for pictures from the web (image_search), for non-media documents (files), or for where the user was at a time (location). Each result includes an `imageUrl` — to SHOW a photo rather than list its filename, embed it as a markdown image `![short caption](imageUrl)`; prefer a few relevant photos over a filename table. Can also add photos to an 'AlfyAI' album (requires the user to have enabled writes) — this only PROPOSES a pending, confirm-required change and never deletes or modifies the originals. With several accounts connected, pass `account` (provider, label, or email).",
			errorPrefix: "Photos lookup failed",
		},
		media: {
			description:
				"Read the user's connected media server (Plex): `watch_history` and `libraries` for analytics ('what did we watch this week'); `continue_watching` for in-progress or up-next titles; `library_search` to search the OWNED library (titles the user has, watched or not) with match counts. `watch_history`'s `query` filters HISTORY only — for 'do I own X?' use `library_search`, not history. Do not use it for the user's own photos and home videos (photos), for facts about a film or show (research_web), or for files on their storage (files). Returns titles with watch state and counts. Read-only; with several accounts connected, pass `account` (provider, label, or email).",
			errorPrefix: "Media lookup failed",
		},
		location: {
			description:
				"Read the user's OWN current or past position from their connected OwnTracks device: `last` (where am I now), `history` (raw fixes over a range), `places` (a compact 'places visited' summary — best for 'where was I yesterday' or 'was I at the office'), and `distance` (straight-line — from the current fix to a given lat/lon, across a range for 'how far did I travel', or to a saved home). Do not use it for road or transit distance and travel time, or for any place that is not the user's own device — that is map_route; call this first only when a route needs the user's coordinates. Returns coordinates, timestamps and place labels. Read-only; with several devices connected, pass `account` (provider, label, or email).",
			errorPrefix: "Location lookup failed",
		},
		contacts: {
			description:
				"Look up a contact's identity (email/phone/organization) by name with the `lookup` action, or list everyone in a named contact group (e.g. 'Family', 'Work') with the `group` action, across the user's connected sources (Google, Apple iCloud; groups are Google-only for now). Call when the user asks for someone's email/phone/company, or who's in a contact group. Do not use it to find messages from that person (email), to look up a public company or public figure (research_web), or to turn an address into a location (map_route). Returns matching contacts. Read-only; pass `account` (provider, label, or email) to narrow to one source.",
			errorPrefix: "Contacts lookup failed",
		},
		repos: {
			description:
				"Read the user's connected repositories (GitHub, or a Gitea/GHE-compatible server): `list_repos` (most recently pushed first); `list_issues`, `list_prs` (pull requests) and `list_commits` (scoped to a repo via `owner`+`repo`, issues/PRs optionally filtered by `state`); `read_file` to open one file by `path` (optionally at a specific `ref`); `ci_status` for recent CI/Actions runs; `search_code` to search the user's repositories with `query`. Call when the user asks about their code, a repo's issues/PRs/commits, build/CI status, or to find something in their code. Do not use it for public documentation or a third-party project the user has no repository for (research_web, fetch_url), or for files on their storage (files). Read-only — this connector never creates, comments on, merges, or pushes anything.",
			errorPrefix: "Repositories lookup failed",
		},
		tasks: {
			description:
				"Read the user's connected to-do/task lists (a CalDAV account's task lists): `list_tasks` for open tasks (optionally filtered by `due` — a 'YYYY-MM-DD' date or the literal 'overdue'); `search_tasks` free-text searches task titles/notes with `query`, optionally with `due`. Call when the user asks about their to-dos, what's due, or a specific task. Do not use it for appointments or anything with a start and end time — that is `calendar`, a different store — and do not use it to add or complete a task; this tool is read-only. Returns tasks with title, notes and due date. Results combine every connected source; pass `account` (provider, label, or email) to narrow to one.",
			errorPrefix: "Tasks lookup failed",
		},
		use_skill: {
			description:
				"Load a skill's full instructions, by exact `name` from \"## Skills available\". Call it once, before answering, when the user's request matches a listed skill, then follow the returned instructions for the rest of this turn instead of improvising. Do not use it for a skill absent from that list, do not guess or translate a name, and do not call it twice for the same skill. Returns the skill's instruction text.",
			errorPrefix: "Loading the skill failed",
		},
		suggest_instruction: {
			description:
				'Offer to add a standing instruction when the user just stated a rule for the future ("from now on…", "always…", "never…"), in their own words: {"text": "Only suggest trains, no flights.", "scope": "project"}. The user sees a row with Review and Dismiss; nothing is saved until they review it. Do not use it for a one-off request, or to restate an offer you already made.',
			errorPrefix: "Recording the instruction suggestion failed",
		},
	},
	hu: {
		// Moved to research-web-tool.ts (ruling 57) alongside the tool itself;
		// re-imported here so the assembled catalogue is byte-identical.
		research_web: RESEARCH_WEB_I18N.hu,
		fetch_url: {
			description:
				'Megnevezett weboldalak elolvasása: {"urls": ["https://example.com"]} (mindig tömb, legfeljebb 5) és opcionális `objective`, hogy mit keresel. Akkor hívd, ha a felhasználó linket adott, vagy ha egy részlet csak azon az oldalon található meg. Ne használd oldalak megkeresésére, amelyeknek nincs URL-je (a research_web keresi meg őket, és a `readPages`-szel oldalszöveget is ad), sem tárolt fájlokhoz vagy a beszélgetés fájljaihoz (files, read_generated_file). `evidence` részleteket és `answerBriefMarkdown` összefoglalót ad vissza.',
			errorPrefix: "Az URL letöltése sikertelen",
		},
		map_route: {
			description:
				'Helyek, távolságok, menetidők, útvonalak és tömegközlekedési indulások OpenStreetMap adatokon. Akkor hívd, ha a kérdés „milyen messze”, „mennyi idő odaérni”, „útvonal/útbaigazítás”, „mi érhető el 20 percen belül”, tömegközlekedési utazás vagy a következő indulások, illetve ha egy helynevet koordinátává kell alakítani. Ne használd ezekre az image_search vagy research_web eszközt, és ne ezzel próbáld megtudni, hol van a felhasználó — nem tudja; előbb hívd a `location` eszközt a koordinátáiért. Egy `action`-t adj meg: `geocode` (query, opcionális near/limit), `route` (origin, destination, opcionális waypoints), `matrix` (origins, destinations), `isochrone` (origin, ranges_s másodpercben), `transit` (tömegközlekedési utazás időpontokkal és járatszámokkal: origin, destination, opcionális departure vagy arrive_by és max_walk_minutes), `timetable` (a következő indulások két hely között: origin, destination, opcionális from, window_minutes, rows) vagy `journey` (vegyes közlekedési módok sorrendben, pl. bringa, vonat, gyalog; add meg a `legs` listát az origin/destination mellett, és vagy az arrive_by, vagy a departure időt). Egy hely lehet helynév szöveg vagy {"lat":52.52,"lng":13.4}; a `mode` drive (alapértelmezett), walk vagy bike. Példa: {"action":"route","origin":"Keleti pályaudvar","destination":"Lánchíd","mode":"walk"}. Visszaadja: summary, distance_m, duration_s, steps, legs, poligonok (tömegközlekedésnél és vegyes útnál a helyi időpontokat, járatokat és átszállásokat), és térképkártyát jelenít meg, amely már mutatja a TELJES útbaigazítást vagy menetrendi idővonalat — ezért foglald össze az utat (a fontosabb kanyarokat vagy átszállásokat, az időpontokat), ne ismételd meg minden lépését, és mindig szerepeljen benne a "© OpenStreetMap contributors" felirat.',
			errorPrefix: "Az útvonaltervezés sikertelen",
		},
		memory_context: {
			description:
				"Tartós memória lekérése, ha érdemben javítja a választ. `mode`: `persona` (alapértelmezett) preferenciákhoz és célokhoz; `history` a `query`-re illő régebbi beszélgetésekhez, majd egy beszélgetés részletei `historyConversationId` + `maxMessages` megadásával; `project` projektmappa-folytonossághoz (a mappa nevét a `query`-ben add meg), majd egy visszakapott `siblingConversationId` a részletekhez. Ne használd olyan memória újbóli lekérésére, amelyet a kontextus már idéz — ugyanaz a tár, csak mélyebbre vagy régebbre menni hívd —, sem a jelenlegi beszélgetéshez, amelyet amúgy is olvasol, sem tárolt fájlokhoz (files). A `conversationId`-t a rendszer adja meg; soha ne kérj vagy adj meg felhasználó-, mappa- vagy projektazonosítót. Memóriabejegyzéseket és beszélgetésrészleteket ad vissza; az üres eredmény nem bizonyítja, hogy nincs kapcsolódó memória.",
			errorPrefix: "A memória kontextus lekérése sikertelen",
		},
		image_search: {
			description:
				'Webes képek (fotók, illusztrációk, ábrák) keresése a válaszhoz: {"query": "aranyszínű retriever kölyök"}. Ne használd térképhez, útvonalhoz, távolsághoz vagy bármi földrajzihoz (arra a map_route való, amely saját térképkártyát jelenít meg), a felhasználó saját képeihez (photos), sem tényekhez vagy szöveghez (research_web). Kép-URL-ek listáját adja vissza. A használt képeket ágyazd be a válaszba Markdown képszintaxissal: `![alt szöveg](url)` oda, ahová valók; a felhasználó nem látja a nyers eszközkimenetet, ezért a be nem ágyazott kép számára láthatatlan.',
			errorPrefix: "A képkeresés sikertelen",
		},
		produce_file: {
			description:
				"Letölthető fájl készítése (PDF, DOCX, XLSX, PPTX, CSV, Markdown, ...). Csak akkor hívd, ha a felhasználó fájlt kér, és a függő eszközök már valódi tartalmat adtak vissza — soha ne helyőrzővel vagy üresen. Ne használd magának az adatnak a kidolgozására (előbb run_python), fájl visszaolvasására (read_generated_file), és akkor sem, ha nem kértek letöltést — egy összefoglaló, táblázat vagy lista a válaszodban a helye. Egyszerű forma: `requestTitle`, `filename` vagy `outputType`, és `markdown`; az előállítási módot a szerver választja. Egy kérésben ne keverd a PDF/DOCX/HTML formátumokat az md/txt/csv/tsv/json/code fájlokkal; hívd meg kétszer. Meglévő fájl módosításához előbb hívd a `read_generated_file`-t, majd küldd újra a teljes tartalmat, vagy adj `patches`-t [{oldText, newText}], ahol minden oldText pontos, egyedi, legalább 20 karakteres részlet. A `program`-ot csak kódot igénylő fájlokhoz használd (XLSX, PPTX, ZIP): a típust add meg az `outputType`/`requestedOutputs` mezőben, a kód pedig a `/output` könyvtárba írja a fájlt (pl. `/output/report.xlsx`) — a puszta fájlnév a `/output`-on kívülre kerül és elvész. `documentSource` blokkokat csak akkor, ha a struktúra egyértelműen javít egy PDF/DOCX/HTML riportot: heading{level,text}, paragraph{text}, list{style,items}, table{columns:[{key,label}],rows:[{key:value}]}, chart{chartType:bar|stackedBar|line|area|pie|scatter|donut,title,labelKey,valueKey,seriesKey(stackedBar only),data:[{label,value}]}, code{language,text}, callout{tone,text}. Soha ne rajzolj táblázatot vagy diagramot szövegként (nincs pipe-táblázat, nincs blokk-karakteres sáv); a sortöréseket \\n-ként kódold a JSON szövegekben. `status`-t ad vissza: `succeeded` a `files` listával — csak ekkor mondd, hogy kész; `failed` `errorCode`/`message` mezőkkel — ha `retryable`, javítsd és küldd be még egyszer, különben mondd meg, miért nem sikerült; `running` — még készül, nincs kész fájl.",
			errorPrefix: "A fájl-előállítás sikertelen",
		},
		read_generated_file: {
			description:
				"Egy EBBEN a beszélgetésben vagy a beszélgetés projektjében lévő fájl teljes aktuális szövegének beolvasása — itt előállított fájlé, ide feltöltött/csatolt dokumentumé (a Conversation Files alatti nevek), vagy a projekthez kapcsolt fájlé (a Project Files alatti nevek) — `filename` vagy `requestTitle` alapján. A projekt fájlját közvetlenül a nevével olvasod ki: az a lista csak azt mondja meg, hogy létezik. Hívd meg, mielőtt `produce_file` patch-eket küldenél (a pontosan nem egyező oldText-ű patch-et a szerver elutasítja), vagy ha a felhasználó többet kér egy dokumentumból, mint amennyit a kontextusod mutat. A hosszú szöveg ablakokban érkezik: ha az eredményben `hasMore` áll, hívd újra `from: nextFrom` értékkel. A `query` megadásával az ablak helyett annak az egy fájlnak legfeljebb 3, a témához tartozó részletét kapod. Oldalszámozott dokumentumnál a `page` megadásával onnan indul az olvasás; a kontextusodban lévő részletek `[p. 3]`/`[slide 2]` jelölései idézhetők. Ne használd csatlakoztatott felhőtárhoz (files), weboldalhoz (fetch_url), megjegyzett preferenciákhoz (memory_context), sem akkor, ha a szükséges részlet már idézve van a kontextusodban. Szöveget ad vissza `hasMore`/`nextFrom` mezőkkel, vagy azt, hogy nincs meg / több fájl is egyezik (akkor hívd újra egy pontos névvel); ilyenkor mondd ki, ne találgass.",
			errorPrefix: "A fájl beolvasása sikertelen",
		},
		run_python: {
			description:
				'Rövid Python 3.11 szkript futtatása gyors számításokhoz: fejben nem elvégezhető aritmetika, mértékegység- és dátum/idő-átváltás, a felhasználó által megadott adatok elemzése vagy összesítése, gyors algoritmusok. Add meg: {"code": "..."}, opcionálisan egy egysoros `purpose`-t; a szükséges értékeket print()-eld ki. Ne használd fájl kézbesítésére (produce_file — a /output-ba írt fájlok NEM jutnak el a felhasználóhoz), hálózat elérésére (nincs), sem olyan egyetlen lépéshez, amelyet szövegben is kimondhatsz és ellenőrizhetsz. Csak a Python standard könyvtár érhető el (nincs numpy, nincs pandas, nincs pip telepítés); az openpyxl, xlsxwriter, python-docx és python-pptx a produce_file program módjához van jelen, nem ehhez az eszközhöz. Csak a stdout, a stderr és a kilépési kód érkezik vissza, egyenként 8000 karakterre korlátozva (az elejét és a végét megtartva). Elszigetelt Docker sandbox, 90 másodperces korlát; az időtúllépést jelenti, nem csendben eldobja.',
			errorPrefix: "A Python-végrehajtás sikertelen",
		},
		files: {
			description:
				"A felhasználó csatlakoztatott fájltárának (Nextcloud vagy OneDrive) listázása, keresése, olvasása és kezelése. A `list` egy mappa tartalmát nézi meg és számolja meg (add meg az útvonalát, vagy hagyd el a gyökérhez); a `search` név alapján keres az egész fában; a `read` egy konkrét fájlt nyit meg útvonal alapján. Minden találat tartalmazza az utolsó módosítás idejét ('a legutóbbi számlám', 'a legújabb fájl'). Ne használd fényképekhez vagy videókhoz (photos), egy ebben a beszélgetésben lévő fájlhoz (read_generated_file), weboldalhoz (fetch_url), sem megjegyzett preferenciákhoz (memory_context). Emellett új fájl mentésére (`save`), áthelyezésére/átnevezésére (`move`, `destinationPath`), törlésére (`delete` — a kukába, visszaállítható), mappa létrehozására (`create_folder`) és NYILVÁNOS megosztási link készítésére (`share_link` — a linkkel bárki megnyithatja a fájlt, szándékos közzététel, óvatosan) is képes: ezekhez az írásnak engedélyezve kell lennie, OneDrive-nál NEM elérhetők (csak olvasható), és SOHA nem lépnek életbe azonnal — mindegyik csak egy függőben lévő műveletet javasol, amelyet a felhasználónak kifejezetten jóvá kell hagynia. Találatokat ad vissza útvonallal, mérettel és módosítási idővel; a `read` a szöveget is. Több csatlakoztatott fióknál add meg az `account` mezőt (szolgáltató, címke vagy e-mail).",
			errorPrefix: "A fájlok elérése sikertelen",
		},
		calendar: {
			description:
				"A felhasználó csatlakoztatott naptárának (Google vagy Apple iCloud) olvasása: `list_events` (közelgő/időszakra vonatkozó események, opcionálisan a `calendarId`-vel szűkítve), `check_availability` (szabad/foglalt, csak Google, szintén `calendarId`-vel szűkíthető), vagy `list_calendars` a naptárak és azonosítóik felfedezéséhez, mielőtt egy olvasást vagy írást szűkítenél (Google esetén teljes a felsorolás; Apple iCloudnál egy olvasás nem szűkíthető egyetlen naptárra). Akkor hívd, ha a felhasználó a naptárára, közelgő eseményeire kérdez rá, vagy hogy ráér-e egy időpontban. Ne használd teendőkhöz, határidőkhöz vagy ellenőrzőlistákhoz — azok a `tasks` eszközben vannak, egy külön tárban, amelyet ez nem lát —, sem az események közötti menetidőhöz (map_route). Google Calendaren esemény létrehozására (create_event), módosítására (update_event) és törlésére (delete_event) is képes (ehhez az írásnak engedélyezve kell lennie) — ezek SOHA nem lépnek életbe azonnal: mindegyik csak egy függőben lévő módosítást javasol, amelyet a felhasználónak kifejezetten jóvá kell hagynia. Ismétlődő sorozat részét képező eseménynél előbb kérdezd meg, hogy csak az adott alkalomra vagy az egész sorozatra vonatkozzon-e. Eseményeket ad vissza kezdéssel/véggel, címmel és helyszínnel. Több csatlakoztatott fióknál add meg az `account` mezőt (szolgáltató, címke vagy e-mail).",
			errorPrefix: "A naptár elérése sikertelen",
		},
		email: {
			description:
				"A felhasználó csatlakoztatott e-mail fiókjának (IMAP) olvasása: legutóbbi üzenetek listázása; `search` szabad szöveg és/vagy `from` (feladó), `subject` (tárgy), `since`/`before` dátumtartomány alapján; `count` a találatok megszámolása felsorolás nélkül (alapból olvasatlanok); vagy egy üzenet elolvasása uid alapján. Az olvasás alapból a Beérkezett mappára vonatkozik, de elfogad egy `folder`-t (pl. 'Elküldött', 'Archívum', vagy egy név a `list_folders`-ból); egy olvasás a csatolmányokat is felsorolja (fájlnév/típus/méret). Ne használd egy csatolmány tartalmának megnyitására vagy a felhasználó tárolt dokumentumaihoz (files), sem találkozókhoz és meghívókhoz, amelyek a `calendar` eszközhöz tartoznak. Új e-mail küldésére, Törölt elemek közé helyezésére vagy megjelölésére is képes (ehhez az írásnak engedélyezve kell lennie) — ezek SOHA nem lépnek életbe azonnal: mindegyik csak egy függőben lévő módosítást javasol, amelyet a felhasználónak jóvá kell hagynia. Egy elküldött e-mailt nem lehet visszavonni: a küldés előtt ellenőrizd a címzettet, tárgyat és szöveget. Fejléceket ad vissza, uid-olvasásnál a törzzsel. Több csatlakoztatott fióknál add meg az `account` mezőt (szolgáltató, címke vagy e-mail).",
			errorPrefix: "Az e-mail elérése sikertelen",
		},
		photos: {
			description:
				"A felhasználó saját fényképeinek/videóinak keresése a csatlakoztatott fényképtárában (Immich). A `search` természetes nyelvű INTELLIGENS keresés, a fényképek vizuális/szemantikai TARTALMÁRA illeszkedik ('tengerpart naplementében', 'a kutyám a hóban'). PONTOS szűréshez a `search_by_date`: készítési dátumtartomány (`from`/`to`, ÉÉÉÉ-HH-NN), hely (`city`/`country`), médiatípus (`type`: IMAGE/VIDEO), kedvencek (`favorites`) és/vagy `personName` — ez válaszolja meg a '2019 júniusi fényképek', 'kedvenceim' vagy 'X személy fényképei' kéréseket. A `list_albums` és `album` (az `albumId`-vel) az albumokhoz, a `list_people` egy felismert személy pontos nevéhez. Ne használd webes képekhez (image_search), nem média dokumentumokhoz (files), sem ahhoz, hogy hol volt a felhasználó egy időpontban (location). Minden találat tartalmaz egy `imageUrl`-t — ha MUTATNI is akarod a fényképet, nem csak felsorolni, ágyazd be Markdown képként: `![rövid felirat](imageUrl)`; inkább néhány releváns fénykép, mint csupasz fájlnév-táblázat. Fényképek egy 'AlfyAI' albumhoz adására is képes (ehhez az írásnak engedélyezve kell lennie) — ez csak egy függőben lévő, megerősítést igénylő módosítást javasol; az eredetieket soha nem törli és nem módosítja. Több csatlakoztatott fióknál add meg az `account` mezőt (szolgáltató, címke vagy e-mail).",
			errorPrefix: "A fényképek elérése sikertelen",
		},
		media: {
			description:
				"A felhasználó csatlakoztatott médiaszerverének (Plex) olvasása: `watch_history` és `libraries` az analitikához ('mit néztünk ezen a héten'); `continue_watching` ahhoz, ami folyamatban van vagy következik; `library_search` a BIRTOKOLT könyvtár keresésére (amit a felhasználó birtokol, akár nézte, akár nem), találati számmal. A `watch_history` `query` szűrője csak az ELŐZMÉNYEKBEN keres — a 'megvan-e nekem X?' kérdéshez a `library_search`-öt használd. Ne használd a felhasználó saját fényképeihez és házi videóihoz (photos), egy filmről vagy sorozatról szóló tényekhez (research_web), sem a tárhelyén lévő fájlokhoz (files). Címeket ad vissza megtekintési állapottal és darabszámmal. Csak olvasható; több csatlakoztatott fióknál add meg az `account` mezőt (szolgáltató, címke vagy e-mail).",
			errorPrefix: "A média elérése sikertelen",
		},
		location: {
			description:
				"A felhasználó SAJÁT, csatlakoztatott OwnTracks eszközének jelenlegi vagy korábbi helyzete: `last` (hol vagyok most), `history` (nyers pozíciók egy időszakban), `places` (tömör 'meglátogatott helyek' összegzés — a 'hol voltam tegnap' vagy 'ott voltam-e az irodában' kérdésekhez) és `distance` (légvonalbeli távolság — a jelenlegi ponttól egy megadott lat/lon-ig, egy időszakon át a 'mennyit utaztam'-hoz, vagy egy elmentett otthonig). Ne használd közúti vagy tömegközlekedési távolsághoz és menetidőhöz, sem olyan helyhez, amely nem a felhasználó saját eszköze — az a map_route; ezt csak akkor hívd előtte, ha egy útvonalhoz a felhasználó koordinátái kellenek. Koordinátákat, időbélyegeket és helycímkéket ad vissza. Csak olvasható; több csatlakoztatott eszköznél add meg az `account` mezőt (szolgáltató, címke vagy e-mail).",
			errorPrefix: "A helyadat lekérdezése sikertelen",
		},
		contacts: {
			description:
				"Egy kapcsolattartó adatainak (e-mail/telefonszám/cég) keresése név alapján a `lookup` művelettel, vagy egy megnevezett kapcsolattartó-csoport (pl. 'Család', 'Munka') tagjainak listázása a `group` művelettel, a felhasználó csatlakoztatott forrásaiban (Google, Apple iCloud; a csoportok egyelőre csak Google esetén). Akkor hívd, ha valakinek az e-mail címét/telefonszámát/cégét kérik, vagy hogy ki tartozik egy csoportba. Ne használd az illetőtől származó üzenetek megkeresésére (email), nyilvános cég vagy közszereplő lekérdezésére (research_web), sem cím helyszínné alakítására (map_route). Illeszkedő kapcsolattartókat ad vissza. Csak olvasható; add meg az `account` mezőt (szolgáltató, címke vagy e-mail) egy forrásra szűkítéshez.",
			errorPrefix: "A kapcsolattartók elérése sikertelen",
		},
		repos: {
			description:
				"A felhasználó csatlakoztatott kódtárolóinak (GitHub, vagy egy Gitea/GHE-kompatibilis szerver) olvasása: `list_repos` (legutóbb pusholt elöl); `list_issues`, `list_prs` (pull requestek) és `list_commits` (egy repóra szűkítve az `owner`+`repo` paraméterrel, az issue-k/PR-ek opcionálisan `state` szerint); `read_file` egy fájl megnyitásához `path` alapján (opcionálisan adott `ref`-en); `ci_status` a legutóbbi CI/Actions futásokhoz; `search_code` kódkereséshez a repókban a `query` alapján. Akkor hívd, ha a felhasználó a kódjára, egy repó issue-jaira/PR-jeire/commitjaira, build/CI állapotára kérdez rá, vagy valamit keres a kódjában. Ne használd nyilvános dokumentációhoz vagy olyan külső projekthez, amelyhez a felhasználónak nincs repója (research_web, fetch_url), sem a tárhelyén lévő fájlokhoz (files). Csak olvasható — ez a kapcsolat soha nem hoz létre, nem kommentál, nem egyesít és nem pushol semmit.",
			errorPrefix: "A kódtárolók elérése sikertelen",
		},
		tasks: {
			description:
				"A felhasználó csatlakoztatott teendő-/feladatlistáinak (egy CalDAV-fiók feladatlistái) olvasása: `list_tasks` a nyitott feladatokhoz (opcionálisan `due` szerint szűrve — egy 'ÉÉÉÉ-HH-NN' dátum vagy a szó szerinti 'overdue'); `search_tasks` a feladatcímek/jegyzetek szabad szöveges kereséséhez a `query` alapján, opcionálisan `due`-val. Akkor hívd, ha a felhasználó a teendőire, a határidőkre vagy egy konkrét feladatra kérdez rá. Ne használd időponthoz kötött találkozókhoz vagy bármihez, aminek kezdete és vége van — az a `calendar`, egy másik tár —, és ne használd feladat hozzáadására vagy lezárására; ez az eszköz csak olvasható. Feladatokat ad vissza címmel, jegyzettel és határidővel. Minden csatlakoztatott forrásból összesít; add meg az `account` mezőt (szolgáltató, címke vagy e-mail) egy forrásra szűkítéshez.",
			errorPrefix: "A feladatok elérése sikertelen",
		},
		use_skill: {
			description:
				'Egy skill teljes utasításainak betöltése, pontos `name` alapján a "## Skills available" listából. Ha a felhasználó kérése megfelel egy listázott skillnek, hívd meg egyszer, mielőtt válaszolnál, és a kör hátralévő részében kövesd a visszakapott utasításokat ahelyett, hogy magadtól rögtönöznél. Ne használd olyan skillre, amely nincs a listában, ne találgasd és ne fordítsd le a nevet, és ne hívd meg kétszer ugyanarra a skillre. A skill utasításszövegét adja vissza.',
			errorPrefix: "A skill betöltése sikertelen",
		},
		suggest_instruction: {
			description:
				'Állandó utasítás felajánlása, ha a felhasználó épp szabályként mondta ki a jövőre nézve („mostantól…”, „mindig…”, „soha…”): a szabályt a saját szavaival add meg, így: {"text": "Csak vonatot javasolj, repülőt ne.", "scope": "project"}. A felhasználó egy sort lát Áttekintés és Elvetés gombokkal; semmi sem mentődik, amíg át nem tekinti. Ne használd egyszeri kérésre, és ne ismételd meg a felajánlást prózában.',
			errorPrefix: "Az utasításjavaslat rögzítése sikertelen",
		},
	},
};

// ── create_artifact / read_artifact / edit_artifact i18n ────────
//
// These three live outside TOOL_I18N (unlike every other tool) because their
// descriptions name the artifact KINDS the model may create, and that set
// changes at runtime as type slices register a create handler
// (advertisedArtifactKinds() in artifact-tools/kind-registry.ts — Canvas and Slides
// are not registered yet). A static string here would either lie about
// unavailable kinds or go stale the moment a new one is registered, so these
// are assembled fresh from artifact-tools/kind-prose.ts's per-kind fragments
// every time createNormalChatTools runs, the same way the tool set itself is
// rebuilt per turn. errorPrefix carries no kind names, so it stays static.
const ARTIFACT_TOOL_ERROR_PREFIX: Record<
	"en" | "hu",
	{ create_artifact: string; read_artifact: string; edit_artifact: string }
> = {
	en: {
		create_artifact: "Create failed",
		read_artifact: "Read failed",
		edit_artifact: "Edit failed",
	},
	hu: {
		create_artifact: "A létrehozás nem sikerült",
		read_artifact: "Az olvasás nem sikerült",
		edit_artifact: "A szerkesztés nem sikerült",
	},
};

function buildCreateArtifactDescription(
	kinds: readonly CreatableArtifactKind[],
	lang: "en" | "hu",
): string {
	if (lang === "hu") {
		return `Tarts meg valamit a beszélgetés mellett, amihez a felhasználó visszatér, amit megnyit és veled együtt szerkeszt. Ne használd olyan válaszhoz, amely már teljes a válaszodban, se akkor, ha a felhasználó letölthető fájlt kért — az a produce_file dolga, nem ezé. Használd ${createArtifactUseCasePhrase(kinds, "hu")}, amin a felhasználó tovább dolgozik. Az artifactType-ot aszerint válaszd, mit őrzöl meg: ${createArtifactChoiceClause(kinds, "hu")} Nincs artifactType "file": amit a felhasználó letölteni kért, az a produce_file dolga, és Fájlként jelenik meg. Kérésenként legfeljebb egyet készíts — mondd el, mit csináltál, és ajánld fel a megnyitását, és ne írd bele ugyanazt a tartalmat a válaszodba is. Példa: {"artifactType":"document","title":"Bécsi hétvégi terv","body":"# Bécsi hétvége\\n- [ ] Vonatjegy foglalása"}. Utólag soha ne találj ki azonosítót — a read_artifact adja vissza azt, amivel szerkeszteni fogsz. Elutasítás esetén olvasd el az okát, javítsd ki azt az egy dolgot, és legfeljebb egyszer próbáld újra.`;
	}
	return `Keep something beside the chat that the user will return to, open and edit with you. Do not use it for an answer that is already complete in your reply, or when the user asked for a downloadable file — that is produce_file's job, not this one. Use it for a ${createArtifactUseCasePhrase(kinds, "en")} the user keeps working on. Choose artifactType by what you are keeping: ${createArtifactChoiceClause(kinds, "en")} There is no artifactType "file": anything the user asked to download is produce_file's job, and it shows up as a File. Make at most one per request — say what you made and offer to open it, and do not also paste the same content into your reply. Example: {"artifactType":"document","title":"Vienna weekend plan","body":"# Vienna weekend\\n- [ ] Book train"}. Never invent an id afterward — read_artifact returns the one you edit against. On a refusal, read the reason, fix that one thing, and retry at most once.`;
}

function buildReadArtifactDescription(
	kinds: readonly CreatableArtifactKind[],
	lang: "en" | "hu",
): string {
	if (lang === "hu") {
		return `Egy ${artifactKindListHu(kinds, { withFile: true })} elem jelenlegi tartalmát és szerkezetét nézd meg vele, a create_artifact-tól, egy korábbi hívástól vagy a beszélgetés katalógusától kapott azonosítóval. Ne használd azonosító kitalálására — előbb nézd meg a katalógust, és soha ne találj ki egyet. A detail:"blocks" a szerkeszthető azonosítókat és hasheket adja vissza, amelyekre az edit_artifact-nak szüksége van (minden edit_artifact hívás előtt olvasd el ezt: a baseHash mindig innen származik, sosem kitalálva); hagyd el a detail mezőt, vagy add meg "full"-ként, a teljes tartalomhoz. Ismeretlen azonosítóra a beszélgetés saját jelöltjeit kapod vissza tartalom helyett — ezek közül válassz, ne próbáld ugyanazt az azonosítót újra.`;
	}
	return `See a ${artifactKindListEn(kinds, { withFile: true })} item's current content and structure, addressed by the id from create_artifact, a prior call, or the artifact catalogue. Do not use it to guess at an id — read the catalogue first, and never invent one. Pass detail:"blocks" to get the addressable ids and hashes edit_artifact needs (read this before every edit_artifact call: baseHash always comes from here, never guessed); omit detail, or pass "full", for the whole body. An unknown id returns the conversation's own candidates instead of a body — pick one of those rather than retrying the same id.`;
}

function buildEditArtifactDescription(
	kinds: readonly CreatableArtifactKind[],
	lang: "en" | "hu",
): string {
	if (lang === "hu") {
		return [
			`Módosíts egy már elkészített ${artifactKindListHuAccusative(kinds)}, a create_artifact vagy a read_artifact által adott azonosítóval. Ne használd anélkül, hogy előbb elolvasnád az elemet — hívd meg a read_artifact-ot, és használd az onnan kapott baseHash-t; egy elutasítás általában azt jelenti, hogy a felhasználó azóta szerkesztette azt a részt, hogy utoljára olvastad, ezért mondd el neki, ne próbáld újra ugyanazt a javítást.`,
			editArtifactRuleClause(kinds, "hu"),
			editArtifactExampleClause(kinds, "hu"),
			`Egy köteg részlegesen is alkalmazódik: amit lehet, megteszi, és minden elutasított művelet a saját okával tér vissza, ezért mondd el a felhasználónak, mi változott és mi nem, ahelyett hogy feltételeznéd, hogy az egész megtörtént. Elutasított szerkesztés megkerülésére soha ne hozz létre új elemet — mondd el inkább a felhasználónak.`,
		]
			.filter(Boolean)
			.join(" ");
	}
	return [
		`Change a ${artifactKindListEn(kinds)} item you already made, addressed by the id from create_artifact or read_artifact. Do not use it before reading the item first — call read_artifact and use the baseHash it just gave you; a refusal usually means the user edited that part since you last read it, so tell them rather than retrying the same patch.`,
		editArtifactRuleClause(kinds, "en"),
		editArtifactExampleClause(kinds, "en"),
		`A batch applies partially: whatever it can, it does, and each refused op comes back with its own reason, so tell the user what changed and what did not rather than assuming the whole thing landed. Never make a new item to work around a refused edit — tell the user instead.`,
	]
		.filter(Boolean)
		.join(" ");
}

// ── suggest_instruction scope ──────────────────────────────────

/**
 * The project this conversation is in, when the offer asked for one.
 *
 * Two reads, both only for a `scope: "project"` request: the offer carries the
 * project's name (a scope token without one is an icon with no text) and never
 * its id, so the model cannot name a project and the row can still say which
 * one it means. A project the user has no instructions in yet is still a
 * project — that case is what an offer is for — so this does not look at the
 * instruction text.
 */
async function resolveConversationProject(params: {
	userId: string;
	conversationId: string;
	wanted: boolean;
}): Promise<{ id: string; name: string } | null> {
	if (!params.wanted) return null;

	const projectId = await getConversationProjectId(
		params.userId,
		params.conversationId,
	);
	if (!projectId) return null;

	const project = await getProjectInstructions(params.userId, projectId);
	return project ? { id: project.id, name: project.name } : null;
}

// ── produce_file in-turn verdict ───────────────────────────────

// Intake only says the job was ACCEPTED. The worker that decides whether a
// file exists runs detached, and its failure path is a pure DB write — no
// stream part, no callback, nothing that would reach the model. So after a
// successful intake the tool watches the ledger for a bounded time and reports
// what it finds; `running` is returned honestly rather than dressed up as
// success. See produce-file.ts for the bound and the payload shapes.
async function resolveProduceFileVerdict(params: {
	userId: string;
	conversationId: string;
	job: FileProductionJob;
	reused: boolean;
	signal?: AbortSignal;
	waitMs?: number;
	pollIntervalMs?: number;
}): Promise<ProduceFileModelPayload> {
	const verdict = await waitForFileProductionJobVerdict({
		getJob: () =>
			getConversationFileProductionJob({
				userId: params.userId,
				conversationId: params.conversationId,
				jobId: params.job.id,
			}),
		timeoutMs: params.waitMs ?? PRODUCE_FILE_VERDICT_WAIT_MS,
		pollIntervalMs:
			params.pollIntervalMs ?? PRODUCE_FILE_VERDICT_POLL_INTERVAL_MS,
		signal: params.signal,
	});

	if (!verdict.settled) {
		// A job that is still QUEUED while the worker is switched off is not
		// "being made" — nothing is making it. It is not lost either: it stays in
		// the ledger and runs when production is switched back on. Read here
		// rather than at intake so an admin who paused during the wait is
		// reflected, and only for a queued job: an attempt already running
		// finishes whatever the switch says.
		const paused =
			verdict.job?.status !== "running" &&
			!getFileProductionWorkerConfig().workerEnabled;
		return buildProduceFileRunningPayload({
			jobId: params.job.id,
			reused: params.reused,
			productionPaused: paused,
		});
	}
	if (verdict.job.status === "succeeded") {
		// `succeeded` is the JOB's status; the promise this tool makes is that a
		// file EXISTS. getConversationFileProductionJob resolves the job's file
		// links against the chat-file rows and drops any that no longer resolve
		// for this user, so a succeeded job can legitimately come back with an
		// empty `files` — the same case listConversationFileProductionJobs
		// already refuses to project. Reporting that as success would put the
		// tool right back in the business of announcing files that are not
		// there, so it is reported as a failure instead.
		if (verdict.job.files.length === 0) {
			return buildProduceFileFailedPayload({
				jobId: verdict.job.id,
				errorCode: "file_production_no_output_files",
				message:
					"The job finished but no downloadable file is attached to it. Do not tell the user the file is ready.",
			});
		}
		return buildProduceFileSucceededPayload({
			jobId: verdict.job.id,
			files: verdict.job.files,
			warnings: verdict.job.warnings,
			reused: params.reused,
		});
	}
	return buildProduceFileFailedPayload({
		jobId: verdict.job.id,
		errorCode:
			verdict.job.error?.code ??
			(verdict.job.status === "cancelled"
				? "file_production_cancelled"
				: "file_production_failed"),
		message:
			verdict.job.error?.message ??
			(verdict.job.status === "cancelled"
				? "The file production job was cancelled before it produced anything."
				: "File production failed without reporting a reason."),
	});
}

// ── Tool factory ───────────────────────────────────────────────

export function createNormalChatTools(ctx: CreateNormalChatToolsContext) {
	const recorder = ctx.recorder ?? createToolCallRecorder();
	const lang = ctx.language ?? "en";
	const i18n = TOOL_I18N[lang];
	// Recomputed every call (never cached at module load) so a newly
	// registered create handler — in production, or in a test that pokes
	// CREATE_ARTIFACT_HANDLERS directly — is reflected the next time the tool
	// set is built, exactly like the schemas in artifact-tools/{create,edit}.ts.
	const advertisedKinds = advertisedArtifactKinds();
	const artifactToolI18n = {
		create_artifact: {
			description: buildCreateArtifactDescription(advertisedKinds, lang),
			errorPrefix: ARTIFACT_TOOL_ERROR_PREFIX[lang].create_artifact,
		},
		read_artifact: {
			description: buildReadArtifactDescription(advertisedKinds, lang),
			errorPrefix: ARTIFACT_TOOL_ERROR_PREFIX[lang].read_artifact,
		},
		edit_artifact: {
			description: buildEditArtifactDescription(advertisedKinds, lang),
			errorPrefix: ARTIFACT_TOOL_ERROR_PREFIX[lang].edit_artifact,
		},
	};
	// Verdict (not intake receipt) of every produce_file call this turn, keyed
	// by the requested artifact AND its content. A repeated identical call replays the verdict
	// instead of queueing a second job — but a FAILED verdict is deliberately
	// not cached, because the model is expected to resubmit a corrected one.
	const sameTurnProduceFileVerdicts = new Map<
		string,
		Extract<ProduceFileModelPayload, { ok: true }>
	>();
	// Submissions that actually reached intake, per requested artifact. Bounds
	// the correction loop the description asks for to exactly one retry.
	const sameTurnProduceFileSubmissions = new Map<string, number>();
	// Same, but for the whole turn regardless of what each request was called —
	// see MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN.
	let totalProduceFileSubmissions = 0;
	// Every create_artifact call this turn, whatever kind — see
	// MAX_CREATE_ARTIFACT_CALLS_PER_TURN (artifact-tools/create.ts).
	let totalCreateArtifactCalls = 0;
	// At most one instruction offer per turn (Slice F). The offer is a row the
	// user has to answer; a second row about the same sentence is a second
	// decision, so a repeated call is refused rather than recorded.
	let sameTurnInstructionSuggestionMade = false;
	// Parallel-backed web tools (research_web, fetch_url) are registered only
	// when a Parallel API key is configured. Mirrors the stability snapshot's
	// `parallelConfigured = Boolean(config.parallelApiKey.trim())`. The execute
	// closures below already read getConfig() at call time; reading it once here
	// for the registration gate matches that existing dependency.
	// Read runtime config ONCE for the registration gates (the execute closures
	// below re-read getConfig() at call time). Capturing a single snapshot keeps
	// both the Parallel gate and the ORS gate reading the same config object.
	const registrationConfig = getConfig();
	const parallelConfigured = Boolean(registrationConfig.parallelApiKey?.trim());
	// map_route is ORS-backed: register it ONLY when ORS_BASE_URL is configured,
	// so an unconfigured deployment omits it entirely (mirrors the Parallel gate).
	// The tool ALSO degrades in-band (returns "routing unavailable") if a call
	// fails, but the gate keeps it out of the tool set when there's no server.
	const orsConfigured =
		Boolean(registrationConfig.orsBaseUrl?.trim()) ||
		registrationConfig.routingOnDemandEnabled;
	// Tell the model up front which regions the self-hosted graphs cover (and
	// whether others are prepared on demand), so it does not burn tool steps
	// routing outside coverage and can explain a "preparing" answer.
	const orsCoverageLabel = registrationConfig.routingOnDemandEnabled
		? (ctx.routingCoverageLabel?.trim() ?? "")
		: (registrationConfig.orsCoverageLabel?.trim() ?? "");
	// Timetables are a per-region GTFS graph, so they cover FEWER regions than
	// road routing. Naming them separately stops the model from calling
	// transit/timetable for a region that only has roads.
	const transitCoverageLabel = ctx.routingTransitCoverageLabel?.trim() ?? "";
	const transitCoverageSuffix = transitCoverageLabel
		? lang === "hu"
			? ` MENETREND: tömegközlekedési menetrend csak ezekre a régiókra érhető el: ${transitCoverageLabel}. Máshol ne hívd a transit/timetable műveletet — mondd ki, hogy nincs menetrend, és ne találj ki indulási időket.`
			: ` TIMETABLES: public transport timetables are loaded for ${transitCoverageLabel} only. Do not call transit/timetable elsewhere — say timetables are unavailable there, and never invent departure times.`
		: lang === "hu"
			? " MENETREND: ezen a szerveren jelenleg egyetlen régióhoz sincs tömegközlekedési menetrend; ne hívd a transit/timetable műveletet."
			: " TIMETABLES: no region on this server has public transport timetables loaded right now; do not call transit/timetable.";
	const mapRouteDescription = `${
		orsCoverageLabel
			? `${i18n.map_route.description} ${
					registrationConfig.routingOnDemandEnabled
						? lang === "hu"
							? `LEFEDETTSÉG: jelenleg betöltött régiók: ${orsCoverageLabel}. Más régiók térképadatát a szerver első használatkor igény szerint letölti és felépíti (10–40 perc); ha az eszköz azt jelzi, hogy egy régió előkészítés alatt áll, mondd el a felhasználónak, hogy kérdezzen rá később, és ne becsülj.`
							: `COVERAGE: regions loaded right now: ${orsCoverageLabel}. Other regions are downloaded and built on demand the first time they are needed (10–40 minutes); if the tool reports a region is being prepared, tell the user to ask again later and do not estimate.`
						: lang === "hu"
							? `FONTOS: az útvonaltervező térképadatai CSAK ezt a régiót fedik le: ${orsCoverageLabel}. Ezen kívüli helyekre ne hívd útvonalhoz/mátrixhoz/izokronhoz — mondd ki, hogy a hely kívül esik az útvonaltervezés lefedettségén, és ne becsülj.`
							: `IMPORTANT: the routing map data on this server covers ONLY ${orsCoverageLabel}. Do not call route/matrix/isochrone for places outside it — say the location is outside the routing coverage instead, and do not estimate.`
				}`
			: i18n.map_route.description
	}${transitCoverageSuffix}`;
	const includeFilesTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("files"),
	);
	const includeCalendarTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("calendar"),
	);
	const includeEmailTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("email"),
	);
	const includePhotosTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("photos"),
	);
	const includeMediaTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("media"),
	);
	const includeLocationTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("location"),
	);
	const includeContactsTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("contacts"),
	);
	const includeReposTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("repos"),
	);
	const includeTasksTool = Boolean(
		ctx.enabledConnectionCapabilities?.has("tasks"),
	);

	const tools = {
		// research_web + fetch_url are Parallel-backed. Register them ONLY when
		// Parallel is configured, so an unconfigured deployment omits them
		// entirely — the model then follows the prompt's "web retrieval is
		// unavailable" guidance instead of calling the tool and receiving a raw
		// "Parallel search failed: 401 …" provider error.
		...(parallelConfigured
			? {
					// Moved to research-web-tool.ts (ruling 57): the App verifier
					// (artifacts/app/verify.ts) needed this ONE tool without pulling in
					// this whole factory, which closed a cycle back to the App's own
					// generation path through artifact-tools/create.ts's per-kind
					// dispatch. Exact same tool — the frozen catalogue snapshot tests
					// below prove it.
					research_web: createResearchWebTool({
						userId: ctx.userId,
						conversationId: ctx.conversationId,
						turnId: ctx.turnId,
						modelId: ctx.modelId,
						language: lang,
						recorder,
					}),
					fetch_url: asExecutableTool(
						tool({
							description: i18n.fetch_url.description,
							inputSchema: fetchUrlInputSchema,
							execute: async (
								input: z.infer<typeof fetchUrlInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeFetchUrlInput(input);
								return executeToolWithEnvelope({
									toolName: "fetch_url",
									timeoutMs: TOOL_TIMEOUTS_MS.fetch_url,
									options,
									recorder,
									run: async (abortSignal) => {
										// Per-conversation cache: fetching the same URL set again
										// this conversation (including a fetch_url that repeats a
										// server pasted-URL prefetch, see normal-chat-context.ts) is
										// served from memory instead of paying and waiting twice
										// (see tool-result-cache.ts). Keyed on {urls, objective}
										// only — not on maxCharsTotal below — so a hit is still
										// re-sized to THIS turn's model context window when the
										// payload is built.
										const cacheKey = buildToolResultCacheKey({
											conversationId: ctx.conversationId,
											toolName: "fetch_url",
											input: safeInput,
										});
										const cached =
											getCachedToolResult<GroundedWebResult>(cacheKey);
										// Size returned page content to the selected model's context
										// window, and chain this fetch to the conversation's session.
										const maxCharsTotal = resolveFetchContentCharCap(
											await resolveModelContextTokens(ctx.modelId),
										);
										let result: GroundedWebResult;
										if (cached) {
											result = cached;
										} else {
											const { parallelApiKey, parallelBaseUrl } = getConfig();
											result = await fetchUrlViaParallel(
												safeInput,
												{
													fetch,
													config: { parallelApiKey, parallelBaseUrl },
													signal: abortSignal,
												},
												{ sessionId: ctx.turnId, maxCharsTotal },
											);
											// Only a result that actually carries a page is
											// cacheable. Parallel Extract reports a per-URL failure
											// (404, paywall, timeout, transient upstream error) in
											// the RESPONSE BODY — fetchUrlViaParallel returns
											// normally with zero sources and a "## Could not read"
											// brief instead of throwing (see
											// parallel-search/fetch-url.ts). Caching that soft
											// failure would pin it for the full TTL, leaving the
											// model no way to retry the URL in this conversation.
											if (result.sources.length > 0) {
												setCachedToolResult(cacheKey, result);
											}
											// Fire-and-forget Parallel Extract usage tracking; never
											// block or alter the tool result on analytics failure.
											// Skipped entirely on a cache hit above — a repeated
											// identical call must not bill twice.
											void recordParallelUsage({
												userId: ctx.userId,
												conversationId: ctx.conversationId,
												tool: "fetch_url",
											}).catch(() => {});
										}
										// Keep the answer brief sized to the same model-aware cap the
										// fetch used, so the detailed full_content isn't re-truncated
										// below it when building the model payload.
										const modelPayload = {
											...buildGroundedWebModelPayload(result, {
												maxMarkdownChars: maxCharsTotal,
												name: "fetch_url",
											}),
											...(cached ? { cached: true as const } : {}),
										};
										const candidates = createGroundedWebCandidates(result);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "fetch_url",
												input: safeInput,
												status: "done",
												outputSummary: summarizeGroundedWebResult(result),
												sourceType: "web",
												candidates,
												metadata: {
													...createGroundedWebMetadata(result),
													...(cached ? { cached: true as const } : {}),
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.fetch_url.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											error: message,
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "fetch_url",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.error,
												sourceType: "web",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: modelPayload.error,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		memory_context: asExecutableTool(
			tool({
				description: i18n.memory_context.description,
				inputSchema: compactToolInputSchema(
					memoryContextInputSchema,
					memoryContextInputSchema.omit({
						selectedConversationId: true,
						includeEvidenceCandidates: true,
					}),
				),
				execute: async (
					input: z.infer<typeof memoryContextInputSchema>,
					options: ToolExecutionOptions,
				) => {
					const safeInput = sanitizeMemoryContextInput(input);
					return executeToolWithEnvelope({
						toolName: "memory_context",
						timeoutMs: TOOL_TIMEOUTS_MS.memory_context,
						options,
						recorder,
						run: async () => {
							const result = await getMemoryContext({
								userId: ctx.userId,
								conversationId: ctx.conversationId,
								...safeInput,
							});
							const candidates = compactMemoryContextCandidates(
								result,
								memoryContextCandidateLimit(input, result),
							);
							const modelPayload = compactMemoryContextModelPayload(
								result,
								candidates,
							);
							return {
								modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "memory_context",
									input: safeInput,
									status: "done",
									outputSummary: summarizeMemoryContextResult(result),
									sourceType: "memory",
									candidates,
									metadata: createMemoryContextMetadata(result),
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								i18n.memory_context.errorPrefix,
							);
							const modelPayload = {
								success: false as const,
								error: message,
							};
							return {
								modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "memory_context",
									input: safeInput,
									status: "done",
									outputSummary: modelPayload.error,
									sourceType: "memory",
									candidates: [],
									metadata: {
										ok: false,
										evidenceReady: false,
										error: modelPayload.error,
									},
								},
							};
						},
					});
				},
			}),
		),
		image_search: asExecutableTool(
			tool({
				description: i18n.image_search.description,
				inputSchema: imageSearchInputSchema,
				execute: async (
					input: z.infer<typeof imageSearchInputSchema>,
					options: ToolExecutionOptions,
				) => {
					const safeInput = sanitizeImageSearchInput(input);
					return executeToolWithEnvelope({
						toolName: "image_search",
						timeoutMs: TOOL_TIMEOUTS_MS.image_search,
						options,
						recorder,
						run: async () => {
							const results = await searchImages(safeInput.query);
							const compactResults = compactImageSearchResults(results);
							const candidates = createImageSearchCandidates(compactResults);
							const modelPayload = {
								success: true as const,
								name: "image_search",
								sourceType: "web",
								message: `Found ${compactResults.length} ${compactResults.length === 1 ? "image" : "images"}`,
								results: compactResults,
							};
							return {
								modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "image_search",
									input: safeInput,
									status: "done",
									outputSummary: `${modelPayload.message}.`,
									sourceType: "web",
									candidates,
									metadata: {
										ok: true,
										evidenceReady: true,
										resultCount: compactResults.length,
									},
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								i18n.image_search.errorPrefix,
							);
							const modelPayload = {
								success: false as const,
								error: message,
							};
							return {
								modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "image_search",
									input: safeInput,
									status: "done",
									outputSummary: modelPayload.error,
									sourceType: "web",
									candidates: [],
									metadata: {
										ok: false,
										evidenceReady: false,
										error: modelPayload.error,
									},
								},
							};
						},
					});
				},
			}),
		),
		produce_file: asExecutableTool(
			tool({
				description: i18n.produce_file.description,
				inputSchema: produceFileModelInputSchema,
				execute: async (
					input: z.infer<typeof produceFileModelInputSchema>,
					options: ToolExecutionOptions,
				) => {
					const refuse = (params: {
						input: Record<string, unknown>;
						errorCode: string;
						message: string;
						intakeStatus?: number;
					}): ProduceFileModelPayload => {
						const payload = buildProduceFileFailedPayload({
							errorCode: params.errorCode,
							message: params.message,
						});
						recorder.record(
							createProduceFileToolCallEntry({
								callId: options.toolCallId,
								input: params.input,
								payload,
								intakeStatus: params.intakeStatus,
								outputSummary: summarizeProduceFileResult(payload),
							}),
						);
						return payload;
					};

					const parsedInput = produceFileInputSchema.safeParse(input);
					if (!parsedInput.success) {
						return refuse({
							input: sanitizeUnsafeProduceFileInput(input),
							errorCode: "invalid_tool_input",
							message:
								parsedInput.error.issues[0]?.message ??
								"Invalid file production tool input",
							intakeStatus: 422,
						});
					}
					const normalized = normalizeProduceFileInput(parsedInput.data);
					if (!normalized.ok) {
						return refuse({
							input: sanitizeUnsafeProduceFileInput(input),
							errorCode: "invalid_tool_input",
							message: normalized.error,
							intakeStatus: 422,
						});
					}
					let normalizedInput = normalized.input;
					// Repairs that changed what the model sent (e.g. table cells cut
					// to the column count), reported with the verdict.
					const inputWarnings = normalized.warnings ?? [];

					// Resolve patches: if the model provided surgical edits instead of full content,
					// fetch the previous version and apply patches to reconstruct the full file.
					//
					// This used to run only for `sourceMode === "program"`, so a
					// request whose outputs are a PDF/DOCX/HTML — which the
					// normaliser sends down the document_source path — had its
					// patches stripped a few lines below and reported success on the
					// UNPATCHED document. The tool's description promises patches for
					// every format, so the resolution now runs for every mode.
					if (normalizedInput.patches && normalizedInput.patches.length > 0) {
						// Only a name the MODEL supplied. `normalizedInput.program.filename`
						// is derived from the request TITLE when the model named no file,
						// and looking for a file under a name the app has just invented
						// could only ever miss: live, a patch of `release-notes.md` was
						// answered `no_previous_version_for_patches` because the resolver
						// was sent `release-notes-for-small-app-release.md`.
						const modelFilename =
							parsedInput.data.filename ??
							parsedInput.data.program?.filename ??
							null;
						const namedOutputType = namedOutputTypeFromInput(parsedInput.data);
						const patchBase = await resolveGeneratedFilePatchBase({
							userId: ctx.userId,
							conversationId: ctx.conversationId,
							filename: modelFilename,
							requestTitle: normalizedInput.requestTitle,
							outputType: namedOutputType,
						});
						if (patchBase.status !== "found") {
							return refuse({
								input: sanitizeProduceFileInput(normalizedInput),
								errorCode: "no_previous_version_for_patches",
								message: buildNoPatchBaseMessage(patchBase.candidates),
								intakeStatus: 422,
							});
						}
						const previousContent = patchBase.base;
						const patchResult = applyTextPatches(
							previousContent.text,
							normalizedInput.patches,
						);
						if (!patchResult.ok) {
							return refuse({
								input: sanitizeProduceFileInput(normalizedInput),
								errorCode: "patch_failed",
								message: previousContent.programSource
									? `${patchResult.error} ${PROGRAM_PATCH_BASE_HINT}`
									: patchResult.error,
								intakeStatus: 422,
							});
						}
						if (previousContent.programSource) {
							// The previous version is a binary a program built, and the
							// patch base was that PROGRAM: the patched program is what
							// runs, under the base file's name and type.
							const baseFilename =
								previousContent.programSource.filename ??
								previousContent.filename ??
								undefined;
							normalizedInput = {
								idempotencyKey: normalizedInput.idempotencyKey,
								requestTitle: normalizedInput.requestTitle,
								requestedOutputs: [
									{
										type:
											outputTypeFromFilename(baseFilename) ??
											normalizedInput.requestedOutputs[0].type,
									},
								],
								sourceMode: "program",
								documentIntent: normalizedInput.documentIntent,
								templateHint: normalizedInput.templateHint,
								program: {
									language: previousContent.programSource.language,
									sourceCode: patchResult.resolvedText,
									...(baseFilename ? { filename: baseFilename } : {}),
								},
							};
						} else {
							// Phase 6 D8, now for every mode. The patched bytes exist only
							// here, after the previous version has been fetched, so the
							// request is re-normalised as if the model had sent that text
							// as `content`: the plain-text outputs become `inline_text`
							// (same bytes, same types, no renderer and no sandbox — a
							// patched `.md` used to start a Docker container to run a
							// generated `write_text` one-liner), and the document outputs
							// become a `document_source` built from the PATCHED Markdown.
							//
							// Re-normalising rather than hand-building the request is
							// deliberate: filename resolution, the mixed-group refusal and
							// the mode decision stay in ONE place, so a patched file can
							// never be named — or produced — differently from the same
							// file sent whole.
							//
							// The patched file is the NEXT VERSION of the file the base came
							// from, so it keeps that file's name — never a fresh one derived
							// from this turn's title, which would fork the artifact and leave
							// the next patch resolving against a file nobody can see. When the
							// request named no output type either, the base's own extension is
							// the honest answer: a patch-only call defaults to `txt`, and
							// writing `release-notes.txt` beside `release-notes.md` is the
							// same fork.
							const baseFilename = previousContent.filename;
							const patched = normalizeProduceFileInput({
								...parsedInput.data,
								requestTitle: normalizedInput.requestTitle,
								requestedOutputs:
									!namedOutputType && baseFilename
										? [
												{
													type:
														outputTypeFromFilename(baseFilename) ??
														normalizedInput.requestedOutputs[0].type,
												},
											]
										: normalizedInput.requestedOutputs,
								filename: baseFilename ?? parsedInput.data.filename,
								content: patchResult.resolvedText,
								markdown: undefined,
								text: undefined,
								patches: undefined,
								sourceMode: undefined,
								program: undefined,
								documentSource: undefined,
							});
							// The text a patch is applied to is the text
							// `read_generated_file` showed the model — for a
							// document-source file, the rendered Markdown that its
							// `oldText` was copied from. Producing a document from the
							// result therefore means rebuilding the source from that
							// Markdown, which a chart or an image does not survive: it
							// would ship a report with the chart silently gone. Better a
							// refusal the model can act on than a success that lost data.
							const unpatchableBlock =
								patched.ok && patched.input.sourceMode === "document_source"
									? unpatchableDocumentBlockType(previousContent.documentSource)
									: null;
							if (unpatchableBlock) {
								return refuse({
									input: sanitizeProduceFileInput(normalizedInput),
									errorCode: "patch_not_applicable",
									message: `This document contains a ${unpatchableBlock} block, which cannot be rebuilt from the text you patched. Resend the full content (or documentSource) for this file instead of patches.`,
									intakeStatus: 422,
								});
							}
							if (
								patched.ok &&
								(patched.input.sourceMode === "inline_text" ||
									patched.input.sourceMode === "document_source")
							) {
								normalizedInput = patched.input;
							} else if (
								normalizedInput.sourceMode === "program" &&
								normalizedInput.program &&
								isBinaryOutputFilename(normalizedInput.program.filename)
							) {
								// A workbook, deck or archive is not text: writing the
								// patched text into it would ship a corrupt file (or fail
								// output validation) under a success-shaped request. Only a
								// stored program could carry the patch, and there is none.
								const filename =
									normalizedInput.program.filename ?? "the previous version";
								return refuse({
									input: sanitizeProduceFileInput(normalizedInput),
									errorCode: "patch_not_applicable",
									message: `"${filename}" is a binary ${outputTypeFromFilename(filename) ?? ""} file with no stored program to patch, so patched text cannot be written into it. Resend the whole file instead: for this type, a program that writes it into /output.`,
									intakeStatus: 422,
								});
							} else if (
								normalizedInput.sourceMode === "program" &&
								normalizedInput.program
							) {
								// A program is what runs, so the patched bytes go into the
								// program that writes them — unchanged, including the
								// fallback for a patch whose result the normaliser will not
								// take as `content` (too short to look substantive).
								normalizedInput.program.sourceCode = buildResolvedProgramSource(
									normalizedInput.program.filename ?? "generated-file.txt",
									patchResult.resolvedText,
								);
							} else {
								// No mode can carry the patched text: refusing is the only
								// honest answer, because shipping `normalizedInput` here
								// would produce the file WITHOUT the patch and report
								// success.
								return refuse({
									input: sanitizeProduceFileInput(normalizedInput),
									errorCode: "patch_not_applicable",
									message: `The patched file could not be produced as requested${
										patched.ok ? "" : `: ${patched.error}`
									}. Resend the full content for this file instead of patches.`,
									intakeStatus: 422,
								});
							}
						}
					}
					const { patches: _patches, ...intakeNormalizedInput } =
						normalizedInput;

					const safeInput = sanitizeProduceFileInput(normalizedInput);
					const intakeBody = {
						...intakeNormalizedInput,
						conversationId: ctx.conversationId,
						idempotencyKey: buildScopedIdempotencyKey({
							turnId: ctx.turnId,
							input: normalizedInput,
						}),
					};
					const sameTurnDedupeKey =
						buildSameTurnProduceFileDedupeKey(normalizedInput);
					const sameTurnArtifactKey =
						buildSameTurnProduceFileArtifactKey(normalizedInput);
					// Replay a non-failed verdict only for a byte-identical resend of
					// the same artifact: the dedupe key carries a content hash, so a
					// corrected resend (same title, fixed content) is a new job, not a
					// replay of the earlier success. A FAILED verdict is never
					// replayed either — reporting it is what invites the correction.
					const sameTurnVerdict =
						sameTurnProduceFileVerdicts.get(sameTurnDedupeKey);
					if (sameTurnVerdict) {
						const payload: ProduceFileModelPayload = {
							...sameTurnVerdict,
							reused: true,
						};
						recorder.record(
							createProduceFileToolCallEntry({
								callId: options.toolCallId,
								input: safeInput,
								payload,
								outputSummary: summarizeProduceFileResult(payload),
								metadata: { dedupedSameTurn: true },
							}),
						);
						return payload;
					}

					// Counted per ARTIFACT, not per content: a correction changes the
					// content, and keying the cap on it would let a model that cannot
					// fix its program resubmit forever.
					const submissionCount =
						sameTurnProduceFileSubmissions.get(sameTurnArtifactKey) ?? 0;
					if (submissionCount >= MAX_SAME_TURN_PRODUCE_FILE_SUBMISSIONS) {
						return refuse({
							input: safeInput,
							errorCode: PRODUCE_FILE_RETRY_LIMIT_ERROR_CODE,
							message: `This file was already submitted ${submissionCount} times in this turn, the limit for one file. Do not call produce_file for it again now: if the last attempt produced the file, the user has that version; if it did not, tell the user plainly that the file could not be produced and what went wrong.`,
						});
					}
					// The per-artifact guard above is keyed by title, so a model that
					// keeps renaming its failing request slips past it every time. This
					// one counts every submission the turn makes, whatever it is called.
					if (
						totalProduceFileSubmissions >= MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN
					) {
						return refuse({
							input: safeInput,
							errorCode: PRODUCE_FILE_TURN_LIMIT_ERROR_CODE,
							message: `produce_file has already been called ${totalProduceFileSubmissions} times in this turn, which is the limit. Do not call it again now: answer the user with what you have and say which files could not be produced.`,
						});
					}
					sameTurnProduceFileSubmissions.set(
						sameTurnArtifactKey,
						submissionCount + 1,
					);
					totalProduceFileSubmissions += 1;

					// The job that `run` submits outlives this tool call: when the
					// envelope's timeout or the user's Stop wins the race, the
					// detached worker carries on and the file still lands. `onError`
					// therefore has to know whether a job was queued before the abort,
					// so it can report "running" instead of inventing a failure.
					let submittedJob: FileProductionJob | null = null;
					return executeToolWithEnvelope({
						toolName: "produce_file",
						timeoutMs: TOOL_TIMEOUTS_MS.produce_file,
						options,
						recorder,
						run: async (abortSignal) => {
							const result = await submitFileProductionIntake({
								userId: ctx.userId,
								body: intakeBody,
								signal: abortSignal,
							});
							if (result.ok) {
								submittedJob = result.job;
							}
							const modelPayload = withProduceFileWarnings(
								result.ok
									? await resolveProduceFileVerdict({
											userId: ctx.userId,
											conversationId: ctx.conversationId,
											job: result.job,
											reused: result.reused,
											signal: abortSignal,
											waitMs: ctx.fileProductionVerdictWaitMs,
											pollIntervalMs: ctx.fileProductionVerdictPollIntervalMs,
										})
									: buildProduceFileIntakeFailurePayload(result),
								// Intake's own substitutions (e.g. an output type taken
								// from program.filename) come after the input repairs.
								[
									...inputWarnings,
									...(result.ok ? (result.warnings ?? []) : []),
								],
							);
							if (modelPayload.ok) {
								sameTurnProduceFileVerdicts.set(
									sameTurnDedupeKey,
									modelPayload,
								);
							}
							return {
								modelPayload,
								entry: createProduceFileToolCallEntry({
									callId: options.toolCallId,
									input: safeInput,
									payload: modelPayload,
									intakeStatus: result.status,
									outputSummary: summarizeProduceFileResult(modelPayload),
								}),
							};
						},
						onError: (error) => {
							// A timeout or a user Stop that lands inside the 20s verdict
							// wait is NOT a file-production failure — the job is queued
							// and the worker is unaffected. Saying "failed" here would
							// put a red "file production failed" notice on a turn whose
							// file is about to arrive, which is the exact dishonesty
							// this whole change set exists to remove.
							const modelPayload = submittedJob
								? buildProduceFileRunningPayload({
										jobId: submittedJob.id,
										reused: false,
									})
								: buildProduceFileFailedPayload({
										errorCode: "tool_execution_failed",
										message: modelSafeToolError(
											error,
											i18n.produce_file.errorPrefix,
										),
									});
							return {
								modelPayload,
								entry: createProduceFileToolCallEntry({
									callId: options.toolCallId,
									input: safeInput,
									payload: modelPayload,
									intakeStatus: submittedJob ? undefined : 500,
									outputSummary: summarizeProduceFileResult(modelPayload),
								}),
							};
						},
					});
				},
			}),
		),
		// run_python shares produce_file's program-mode sandbox execution path
		// (sandbox-execution.ts / sandbox/config.ts) and, like produce_file, is
		// registered unconditionally — the Docker sandbox has no static
		// "configured" flag to gate on (see tool-health registry: both entries'
		// `configured` is `() => true`); an unreachable Docker daemon degrades
		// in-band via the tool-health hint and a per-call execution error,
		// rather than being hidden from the tool set.
		run_python: asExecutableTool(
			tool({
				description: i18n.run_python.description,
				inputSchema: runPythonInputSchema,
				execute: async (
					input: z.infer<typeof runPythonInputSchema>,
					options: ToolExecutionOptions,
				) => {
					const safeInput = sanitizeRunPythonInput(input);
					return executeToolWithEnvelope({
						toolName: "run_python",
						timeoutMs: TOOL_TIMEOUTS_MS.run_python,
						options,
						recorder,
						run: async () => {
							// stdout/stderr only: run_python never delivers files (the
							// description tells the model to use produce_file for that),
							// so skip the /output inspection, archive pull, and the 1.5s
							// re-inspection wait that would otherwise run on every
							// successful scratch call.
							const execution = await executeSandboxCode(
								safeInput.code,
								"python",
								{ collectFiles: false },
							);
							const modelPayload = buildRunPythonModelPayload(execution);
							return {
								modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "run_python",
									input: safeInput,
									status: "done",
									outputSummary: summarizeRunPythonResult(modelPayload),
									sourceType: "tool",
									candidates: [],
									metadata: {
										ok: true,
										evidenceReady: false,
										exitCode: modelPayload.exitCode,
										timedOut: modelPayload.timedOut,
										truncated: modelPayload.truncated,
									},
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								i18n.run_python.errorPrefix,
							);
							const modelPayload = {
								success: false as const,
								error: message,
							};
							return {
								modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "run_python",
									input: safeInput,
									status: "done",
									outputSummary: message,
									sourceType: "tool",
									candidates: [],
									metadata: {
										ok: false,
										evidenceReady: false,
										error: message,
									},
								},
							};
						},
					});
				},
			}),
		),
		read_generated_file: asExecutableTool(
			tool({
				description: i18n.read_generated_file.description,
				inputSchema: readGeneratedFileInputSchema,
				execute: async (
					input: z.infer<typeof readGeneratedFileInputSchema>,
					options: ToolExecutionOptions,
				) => {
					// Parsed with the EXECUTION schema, not the advertised one: it
					// is the only place the undocumented `page` (OQ5, undocumented
					// until the single Phase 6 prose release) is read.
					const parsedInput =
						readGeneratedFileExecutionInputSchema.safeParse(input);
					if (!parsedInput.success) {
						const error =
							parsedInput.error.issues[0]?.message ?? "Invalid input";
						return {
							found: false,
							error,
						};
					}
					const safeInput = sanitizeReadGeneratedFileInput(parsedInput.data);
					return executeToolWithEnvelope({
						toolName: "read_generated_file",
						timeoutMs: TOOL_TIMEOUTS_MS.read_generated_file,
						options,
						recorder,
						run: async () => {
							const { result, readArtifactId } = await readGeneratedFileForTool(
								{
									userId: ctx.userId,
									conversationId: ctx.conversationId,
									filename: parsedInput.data.filename ?? null,
									requestTitle: parsedInput.data.requestTitle ?? null,
									from: parsedInput.data.from ?? null,
									query: parsedInput.data.query ?? null,
									page: parsedInput.data.page ?? null,
									part: parsedInput.data.part ?? null,
									turnId: ctx.turnId,
								},
							);
							const modelPayload = buildReadGeneratedFileModelPayload(result);
							const found = !result.notFound && !result.ambiguous;
							return {
								modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "read_generated_file",
									input: safeInput,
									status: "done",
									outputSummary: summarizeReadGeneratedFileResult(result),
									sourceType: "tool",
									metadata: {
										ok: found,
										evidenceReady: false,
										found,
										...(result.ambiguous ? { ambiguous: true } : {}),
										...(result.source ? { source: result.source } : {}),
										// Which stored file this call read, for the
										// "project files read" count at finalize. Never
										// in the model payload.
										...toolReadArtifactIdsMetadata([readArtifactId]),
									},
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								i18n.read_generated_file.errorPrefix,
							);
							return {
								modelPayload: {
									found: false,
									error: message,
								},
								entry: {
									callId: options.toolCallId,
									name: "read_generated_file",
									input: safeInput,
									status: "done",
									outputSummary: message,
									sourceType: "tool",
									metadata: {
										ok: false,
										evidenceReady: false,
										found: false,
										error: message,
									},
								},
							};
						},
					});
				},
			}),
		),
		// The three artifact tools (Feature 2 · Artifacts, decisions.md ruling
		// 43): registered unconditionally, like read_generated_file above — the
		// tool set sits inside the cached prompt prefix, so a per-turn decision
		// about which tools exist would cost the cache. Schemas, payload
		// shaping and the per-kind dispatch registries live beside this file in
		// ./artifact-tools/{create,read,edit}.ts; each type slice appends ONLY
		// its kind's entry to those registries, never here.
		create_artifact: asExecutableTool(
			tool({
				description: artifactToolI18n.create_artifact.description,
				inputSchema: buildCreateArtifactModelInputSchema(advertisedKinds),
				execute: async (
					input: z.infer<
						ReturnType<typeof buildCreateArtifactModelInputSchema>
					>,
					options: ToolExecutionOptions,
				) => {
					// Parsed again with the EXECUTION schema (the server's bounds),
					// mirroring read_generated_file's split: a validation failure is
					// answered directly, never through the timeout/abort envelope.
					const parsedInput =
						buildCreateArtifactInputSchema(advertisedKinds).safeParse(input);
					if (!parsedInput.success) {
						const error =
							parsedInput.error.issues[0]?.message ?? "Invalid input";
						return {
							success: false,
							error,
						} satisfies CreateArtifactModelPayload;
					}
					const safeInput = parsedInput.data;
					// Counted and refused exactly the way
					// MAX_PRODUCE_FILE_SUBMISSIONS_PER_TURN is: every kind shares one
					// turn-wide counter, and the call past the cap runs no handler at
					// all — recorded directly, never through the envelope, mirroring
					// produce_file's own `refuse(...)` helper.
					if (totalCreateArtifactCalls >= MAX_CREATE_ARTIFACT_CALLS_PER_TURN) {
						const message = `create_artifact has already been called ${totalCreateArtifactCalls} times in this turn, which is the limit. Stop creating more, and tell the user what you already made.`;
						const payload: CreateArtifactModelPayload = {
							success: false,
							error: message,
						};
						recorder.record({
							callId: options.toolCallId,
							name: "create_artifact",
							input: safeInput,
							status: "done",
							outputSummary: message,
							sourceType: "tool",
							metadata: { ok: false, error: message },
						});
						return payload;
					}
					totalCreateArtifactCalls += 1;
					return executeToolWithEnvelope<CreateArtifactModelPayload>({
						toolName: "create_artifact",
						timeoutMs: TOOL_TIMEOUTS_MS.create_artifact,
						options,
						recorder,
						run: async (abortSignal) => {
							const result = await runCreateArtifactTool({
								userId: ctx.userId,
								conversationId: ctx.conversationId,
								turnId: ctx.turnId,
								artifactType: safeInput.artifactType,
								title: safeInput.title,
								body: safeInput.body,
								// The turn's own resolved language (ruling 55), never
								// re-detected per kind — see CreateArtifactHandlerParams.
								language: ctx.language ?? "en",
								abortSignal,
							});
							return {
								modelPayload: result.modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "create_artifact",
									input: safeInput,
									status: "done",
									outputSummary: result.outputSummary,
									sourceType: "tool",
									metadata: result.metadata,
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								artifactToolI18n.create_artifact.errorPrefix,
							);
							return {
								modelPayload: { success: false, error: message },
								entry: {
									callId: options.toolCallId,
									name: "create_artifact",
									input: safeInput,
									status: "done",
									outputSummary: message,
									sourceType: "tool",
									metadata: { ok: false, error: message },
								},
							};
						},
					});
				},
			}),
		),
		read_artifact: asExecutableTool(
			tool({
				description: artifactToolI18n.read_artifact.description,
				inputSchema: readArtifactInputSchema,
				execute: async (
					input: z.infer<typeof readArtifactInputSchema>,
					options: ToolExecutionOptions,
				) => {
					return executeToolWithEnvelope<ReadArtifactModelPayload>({
						toolName: "read_artifact",
						timeoutMs: TOOL_TIMEOUTS_MS.read_artifact,
						options,
						recorder,
						run: async (abortSignal) => {
							const result = await runReadArtifactTool({
								userId: ctx.userId,
								conversationId: ctx.conversationId,
								artifactId: input.artifactId,
								detail: input.detail,
								abortSignal,
							});
							return {
								modelPayload: result.modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "read_artifact",
									input,
									status: "done",
									outputSummary: result.outputSummary,
									sourceType: "tool",
									metadata: result.metadata,
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								artifactToolI18n.read_artifact.errorPrefix,
							);
							return {
								modelPayload: { success: false, error: message },
								entry: {
									callId: options.toolCallId,
									name: "read_artifact",
									input,
									status: "done",
									outputSummary: message,
									sourceType: "tool",
									metadata: { ok: false, found: false, error: message },
								},
							};
						},
					});
				},
			}),
		),
		edit_artifact: asExecutableTool(
			tool({
				description: artifactToolI18n.edit_artifact.description,
				// The model is SHOWN the real Document op union (`patches`'s type in
				// buildEditArtifactModelInputSchema, once Document is advertised —
				// the same schema EDIT_ARTIFACT_HANDLERS.document validates every
				// call against, artifact-tools/edit.ts), but what actually GATES
				// `execute` below stays editArtifactInputSchema's existing, generic
				// envelope check: a per-kind handler's own refusal message (naming
				// the valid ops, artifact-tools/edit.ts) is more actionable for the
				// model than however the AI SDK would format a raw schema-validation
				// failure, and this way that message is what the model always sees
				// for a malformed patch, never bypassed by framework-level rejection.
				inputSchema: compactToolInputSchema(
					editArtifactInputSchema,
					buildEditArtifactModelInputSchema(advertisedKinds),
				),
				execute: async (
					input: z.infer<typeof editArtifactInputSchema>,
					options: ToolExecutionOptions,
				) => {
					const parsedInput = editArtifactInputSchema.safeParse(input);
					if (!parsedInput.success) {
						const error =
							parsedInput.error.issues[0]?.message ?? "Invalid input";
						return { success: false, error } satisfies EditArtifactModelPayload;
					}
					const safeInput = parsedInput.data;
					return executeToolWithEnvelope<EditArtifactModelPayload>({
						toolName: "edit_artifact",
						timeoutMs: TOOL_TIMEOUTS_MS.edit_artifact,
						options,
						recorder,
						run: async (abortSignal) => {
							const result = await runEditArtifactTool({
								userId: ctx.userId,
								conversationId: ctx.conversationId,
								turnId: ctx.turnId,
								artifactId: safeInput.artifactId,
								patches: safeInput.patches,
								ops: safeInput.ops,
								summary: safeInput.summary,
								abortSignal,
							});
							return {
								modelPayload: result.modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "edit_artifact",
									input: safeInput,
									status: "done",
									outputSummary: result.outputSummary,
									sourceType: "tool",
									metadata: result.metadata,
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								artifactToolI18n.edit_artifact.errorPrefix,
							);
							return {
								modelPayload: { success: false, error: message },
								entry: {
									callId: options.toolCallId,
									name: "edit_artifact",
									input: safeInput,
									status: "done",
									outputSummary: message,
									sourceType: "tool",
									metadata: { ok: false, error: message },
								},
							};
						},
					});
				},
			}),
		),
		...(includeFilesTool
			? {
					files: asExecutableTool(
						tool({
							description: i18n.files.description,
							inputSchema: filesToolInputSchema,
							execute: async (
								input: z.infer<typeof filesToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeFilesToolInput(input);
								return executeToolWithEnvelope({
									toolName: "files",
									timeoutMs: TOOL_TIMEOUTS_MS.files,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runFilesTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
											ctx.conversationId,
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "files",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "document",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													resultCount: modelPayload.results.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.files.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "files" as const,
											sourceType: "document" as const,
											action: safeInput.action,
											message,
											results: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "files",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "document",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		...(includeCalendarTool
			? {
					calendar: asExecutableTool(
						tool({
							description: i18n.calendar.description,
							inputSchema: calendarToolInputSchema,
							execute: async (
								input: z.infer<typeof calendarToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeCalendarToolInput(input);
								return executeToolWithEnvelope({
									toolName: "calendar",
									timeoutMs: TOOL_TIMEOUTS_MS.calendar,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runCalendarTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
											ctx.conversationId,
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "calendar",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													eventCount: modelPayload.events.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.calendar.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "calendar" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											events: [] as never[],
											busy: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "calendar",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		...(includeEmailTool
			? {
					email: asExecutableTool(
						tool({
							description: i18n.email.description,
							inputSchema: emailToolInputSchema,
							execute: async (
								input: z.infer<typeof emailToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeEmailToolInput(input);
								return executeToolWithEnvelope({
									toolName: "email",
									timeoutMs: TOOL_TIMEOUTS_MS.email,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runEmailTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
											ctx.conversationId,
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "email",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													messageCount: modelPayload.messages.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.email.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "email" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											messages: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "email",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		...(includePhotosTool
			? {
					photos: asExecutableTool(
						tool({
							description: i18n.photos.description,
							inputSchema: photosToolInputSchema,
							execute: async (
								input: z.infer<typeof photosToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizePhotosToolInput(input);
								return executeToolWithEnvelope({
									toolName: "photos",
									timeoutMs: TOOL_TIMEOUTS_MS.photos,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runPhotosTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
											ctx.conversationId,
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "photos",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													resultCount: modelPayload.results.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.photos.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "photos" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											results: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "photos",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		...(includeMediaTool
			? {
					media: asExecutableTool(
						tool({
							description: i18n.media.description,
							inputSchema: mediaToolInputSchema,
							execute: async (
								input: z.infer<typeof mediaToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeMediaToolInput(input);
								return executeToolWithEnvelope({
									toolName: "media",
									timeoutMs: TOOL_TIMEOUTS_MS.media,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runMediaTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "media",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													resultCount: modelPayload.results.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.media.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "media" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											results: [] as never[],
											libraries: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "media",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		...(includeLocationTool
			? {
					location: asExecutableTool(
						tool({
							description: i18n.location.description,
							inputSchema: locationToolInputSchema,
							execute: async (
								input: z.infer<typeof locationToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeLocationToolInput(input);
								return executeToolWithEnvelope({
									toolName: "location",
									timeoutMs: TOOL_TIMEOUTS_MS.location,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runLocationTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "location",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													resultCount: modelPayload.results.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.location.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "location" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											results: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "location",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		...(includeContactsTool
			? {
					contacts: asExecutableTool(
						tool({
							description: i18n.contacts.description,
							inputSchema: contactsToolInputSchema,
							execute: async (
								input: z.infer<typeof contactsToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeContactsToolInput(input);
								return executeToolWithEnvelope({
									toolName: "contacts",
									timeoutMs: TOOL_TIMEOUTS_MS.contacts,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runContactsTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "contacts",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													contactCount: modelPayload.contacts.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.contacts.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "contacts" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											contacts: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "contacts",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		...(includeReposTool
			? {
					repos: asExecutableTool(
						tool({
							description: i18n.repos.description,
							inputSchema: reposToolInputSchema,
							execute: async (
								input: z.infer<typeof reposToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeReposToolInput(input);
								return executeToolWithEnvelope({
									toolName: "repos",
									timeoutMs: TOOL_TIMEOUTS_MS.repos,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runReposTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "repos",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													repoCount: modelPayload.repos.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.repos.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "repos" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											repos: [] as never[],
											issues: [] as never[],
											prs: [] as never[],
											commits: [] as never[],
											ciRuns: [] as never[],
											codeResults: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "repos",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		...(includeTasksTool
			? {
					tasks: asExecutableTool(
						tool({
							description: i18n.tasks.description,
							inputSchema: tasksToolInputSchema,
							execute: async (
								input: z.infer<typeof tasksToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeTasksToolInput(input);
								return executeToolWithEnvelope({
									toolName: "tasks",
									timeoutMs: TOOL_TIMEOUTS_MS.tasks,
									options,
									recorder,
									run: async () => {
										const { modelPayload, candidates } = await runTasksTool(
											ctx.userId,
											safeInput,
											ctx.modelId ?? "model1",
										);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "tasks",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													taskCount: modelPayload.tasks.length,
												},
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.tasks.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "tasks" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											tasks: [] as never[],
											projects: [] as never[],
											citations: [] as never[],
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "tasks",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		// map_route is ORS-backed (self-hosted OpenRouteService + optional
		// geocoder). Register it ONLY when ORS_BASE_URL is configured, so an
		// unconfigured deployment omits it and the model follows the prompt's
		// "routing unavailable" guidance instead of calling a dead tool.
		...(orsConfigured
			? {
					map_route: asExecutableTool(
						tool({
							description: mapRouteDescription,
							inputSchema: compactToolInputSchema(
								routingToolInputSchema,
								routingToolModelSchema as unknown as JSONSchema7,
							),
							execute: async (
								input: z.infer<typeof routingToolInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeRoutingToolInput(input);
								return executeToolWithEnvelope({
									toolName: "map_route",
									timeoutMs: TOOL_TIMEOUTS_MS.map_route,
									options,
									recorder,
									run: async (abortSignal) => {
										const {
											orsBaseUrl,
											geocoderBaseUrl,
											orsCoverageLabel,
											routingOnDemandEnabled,
										} = getConfig();
										const providerDeps = {
											fetch,
											signal: abortSignal,
											timeoutMs: TOOL_TIMEOUTS_MS.map_route,
										};
										const provider = routingOnDemandEnabled
											? await (async () => {
													const manager = getRoutingRegionManager();
													const ready = await manager.listReadyRegions();
													return createRegionalRoutingProvider({
														manager,
														onDemandEnabled: true,
														requestedBy: ctx.userId ?? null,
														readyRegionNames: ready.map((row) => row.name),
														transitRegionNames: ready
															.filter((row) => row.transitStatus === "ready")
															.map((row) =>
																transitCoverageLabelFor(
																	row.id,
																	row.name,
																	loadedGtfsFeedIds(row.gtfsFeeds),
																),
															),
														geocoder: createOrsProvider(
															{ orsBaseUrl, geocoderBaseUrl },
															providerDeps,
														),
														createProvider: (baseUrl) =>
															createOrsProvider(
																{ orsBaseUrl: baseUrl, geocoderBaseUrl },
																providerDeps,
															),
													});
												})()
											: createOrsProvider(
													{
														orsBaseUrl,
														geocoderBaseUrl,
														coverageLabel: orsCoverageLabel,
													},
													providerDeps,
												);
										const { modelPayload, candidates, map } =
											await runRoutingTool(safeInput, { provider });
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "map_route",
												input: safeInput,
												status: "done",
												outputSummary: modelPayload.message,
												sourceType: "tool",
												candidates,
												metadata: {
													ok: modelPayload.success,
													evidenceReady:
														modelPayload.success && candidates.length > 0,
													action: modelPayload.action,
													attribution: modelPayload.attribution,
												},
												...(map ? { map } : {}),
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.map_route.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											name: "map_route" as const,
											sourceType: "tool" as const,
											action: safeInput.action,
											message,
											attribution: OSM_ATTRIBUTION,
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "map_route",
												input: safeInput,
												status: "done",
												outputSummary: message,
												sourceType: "tool",
												candidates: [],
												metadata: {
													ok: false,
													evidenceReady: false,
													error: message,
												},
											},
										};
									},
								});
							},
						}),
					),
				}
			: {}),
		use_skill: asExecutableTool(
			tool({
				description: i18n.use_skill.description,
				inputSchema: useSkillInputSchema,
				execute: async (
					input: z.infer<typeof useSkillInputSchema>,
					options: ToolExecutionOptions,
				) => {
					const safeInput = { name: input.name.trim() };
					return executeToolWithEnvelope<UseSkillModelPayload>({
						toolName: "use_skill",
						timeoutMs: TOOL_TIMEOUTS_MS.use_skill,
						options,
						recorder,
						run: async () => {
							const result = await resolveSkillInstructionsForUse({
								userId: ctx.userId,
								name: safeInput.name,
								requestText: ctx.requestText ?? "",
							});
							if (!result.ok) {
								const message =
									result.reason === "disabled"
										? `Skill "${safeInput.name}" is not currently enabled.`
										: `No skill named "${safeInput.name}" was found. Only call use_skill with a name from "## Skills available".`;
								return {
									modelPayload: {
										found: false as const,
										error: message,
										displayName: null,
										instructions: null,
									},
									entry: {
										callId: options.toolCallId,
										name: "use_skill",
										input: safeInput,
										status: "done",
										outputSummary: message,
										sourceType: "tool",
										metadata: {
											ok: false,
											evidenceReady: false,
											found: false,
											error: message,
											skillId: null,
											skillOwnership: null,
											skillDisplayName: null,
										},
									},
								};
							}
							return {
								modelPayload: {
									found: true as const,
									error: null,
									displayName: result.displayName,
									instructions: result.envelope,
								},
								entry: {
									callId: options.toolCallId,
									name: "use_skill",
									input: safeInput,
									status: "done",
									outputSummary: `Loaded skill "${result.displayName}"`,
									sourceType: "tool",
									metadata: {
										ok: true,
										evidenceReady: false,
										found: true,
										error: null,
										skillId: result.skillId,
										skillOwnership: result.skillOwnership,
										// Analytics overhaul (backend half) — carried through so
										// recordToolCallActivityEvents can record a skill_use
										// event named after the skill rather than the tool.
										skillDisplayName: result.displayName,
									},
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								i18n.use_skill.errorPrefix,
							);
							return {
								modelPayload: {
									found: false as const,
									error: message,
									displayName: null,
									instructions: null,
								},
								entry: {
									callId: options.toolCallId,
									name: "use_skill",
									input: safeInput,
									status: "done",
									outputSummary: message,
									sourceType: "tool",
									metadata: {
										ok: false,
										evidenceReady: false,
										found: false,
										error: message,
										skillId: null,
										skillOwnership: null,
										skillDisplayName: null,
									},
								},
							};
						},
					});
				},
			}),
		),
		// The offer is registered for the whole conversation, never gated per
		// turn: it renders inside the cached prompt prefix, and a turn-varying
		// tool set is the failure shouldExposeFileProductionTools() exists to
		// prevent (see normal-chat-tool-gating.ts). What *is* gated is the
		// offer itself — absent in incognito (the catalogue gate), once per
		// turn (a closure counter below), and with the project scope only when
		// the conversation is really in a project.
		suggest_instruction: asExecutableTool(
			tool({
				description: i18n.suggest_instruction.description,
				inputSchema: suggestInstructionInputSchema,
				execute: async (
					input: z.infer<typeof suggestInstructionInputSchema>,
					options: ToolExecutionOptions,
				) => {
					// What the tool call records as its input. Bounded, because
					// the refused case is exactly the one where the text is a
					// blob the 2,000-character limit is meant to keep out, and
					// the call is persisted with the turn.
					const recordedInput = {
						text:
							typeof input.text === "string" ? input.text.slice(0, 200) : "",
						scope: input.scope ?? "personal",
					};
					// The `refuse(...)` shape produce_file uses for the same
					// reason: a refusal is a recorded call the model can act on,
					// not an envelope failure.
					const refuseSuggestion = (
						reason: SuggestInstructionRefusalReason,
					): SuggestInstructionRefusedPayload => {
						const payload = buildSuggestInstructionRefusal(reason);
						recorder.record({
							callId: options.toolCallId,
							name: "suggest_instruction",
							input: recordedInput,
							status: "done",
							outputSummary: payload.message,
							sourceType: "tool",
							metadata: {
								ok: false,
								evidenceReady: false,
								offered: false,
								reason,
							},
							instructionSuggestion: null,
						});
						return payload;
					};

					// One offer per turn: the row under this reply is the offer,
					// and a second one would be a second decision to make about
					// the same sentence.
					if (sameTurnInstructionSuggestionMade) {
						return refuseSuggestion("already_offered");
					}
					// The shared validator, not a second copy of the limit —
					// blank text reads as "clear the instructions" there, which
					// is not an offer anything could be shown for.
					const normalized = normalizeSuggestedInstruction(
						typeof input.text === "string" ? input.text : "",
					);
					if (!normalized.ok) return refuseSuggestion(normalized.reason);

					return executeToolWithEnvelope<
						SuggestInstructionModelPayload,
						SuggestInstructionFailurePayload
					>({
						toolName: "suggest_instruction",
						timeoutMs: TOOL_TIMEOUTS_MS.suggest_instruction,
						options,
						recorder,
						run: async () => {
							const scope = resolveOfferedScope({
								requestedScope: input.scope,
								project: await resolveConversationProject({
									userId: ctx.userId,
									conversationId: ctx.conversationId,
									wanted: input.scope === "project",
								}),
							});
							const suggestion = buildInstructionSuggestion({
								text: normalized.text,
								scope,
							});
							sameTurnInstructionSuggestionMade = true;
							return {
								modelPayload: buildSuggestInstructionOffered({ scope }),
								entry: {
									callId: options.toolCallId,
									name: "suggest_instruction",
									input: { text: suggestion.text, scope: scope.kind },
									status: "done",
									outputSummary: `Instruction suggestion offered for ${
										scope.kind === "project"
											? (scope.name ?? "the project")
											: "personal instructions"
									}`,
									sourceType: "tool",
									// No `ok`/`evidenceReady` flags: this entry is
									// not evidence, but the offer it carries has
									// to reach finalize, and those two keys are
									// what the run results filter on.
									metadata: { offered: true, scope: scope.kind },
									instructionSuggestion: suggestion,
								},
							};
						},
						onError: (error) => {
							const message = modelSafeToolError(
								error,
								i18n.suggest_instruction.errorPrefix,
							);
							return {
								modelPayload: {
									ok: false as const,
									offered: false as const,
									errorCode: "suggest_instruction_failed" as const,
									message,
								},
								entry: {
									callId: options.toolCallId,
									name: "suggest_instruction",
									input: recordedInput,
									status: "failed",
									outputSummary: message,
									sourceType: "tool",
									metadata: {
										ok: false,
										evidenceReady: false,
										offered: false,
									},
									instructionSuggestion: null,
								},
							};
						},
					});
				},
			}),
		),
		done: tool({
			description:
				"Call once, at the very end, when the answer is complete and every requested file has been produced; pass a one-line `summary`. Do not use it before the answer text exists, or while another tool call might still be needed — it ends the turn.",
			inputSchema: z.object({
				summary: z.string().describe("One line on what was accomplished"),
			}),
			// The loop stops on `done` only once answer text exists (see
			// normal-chat-model's doneAfterAnswer). When the model calls it
			// before writing anything, this result is what it reads next.
			execute: async () => ({
				acknowledged: true,
				note: "If the final answer has not been written yet, write it now in full; otherwise you are finished.",
			}),
		}),
	};

	// Honest degradation: a backend the health registry currently reports as
	// failing stays registered but its description warns the model, so a
	// failure is narrated instead of hidden (cached snapshot only, no probes).
	const hintedTools = applyDegradedToolHints(
		compactToolSchemas(tools),
		collectDegradedToolHints(getCachedToolHealthSnapshot(), lang),
	);

	return {
		tools: hintedTools,
		recorder,
		getToolCalls: () => recorder.getEntries(),
	};
}

// Every tool keeps its zod schema for validation but shows the model a
// compact JSON schema (see compactToolInputSchema).
function compactToolSchemas<T extends Record<string, Tool>>(toolSet: T): T {
	const out: Record<string, Tool> = {};
	for (const [name, definition] of Object.entries(toolSet)) {
		const schema = definition.inputSchema;
		out[name] =
			schema && schema instanceof z.ZodType
				? { ...definition, inputSchema: compactToolInputSchema(schema) }
				: definition;
	}
	return out as T;
}

// The patch base lives in `read-generated-file.ts` now
// (`resolveGeneratedFilePatchBase`): a patch's `oldText` is an excerpt of
// exactly what `read_generated_file` showed the model, so the two must be one
// resolver, not two that agree by hand. This module's copy could only see
// artifacts, which made a same-turn patch impossible and a second patch land
// on the stale previous version.

/**
 * The block types a document source loses when it is rebuilt from its own
 * Markdown, which is what patching a document-source file has to do.
 *
 * A chart's data points and an image's bytes have no Markdown form to parse
 * back — the Markdown carries a sentence about the chart and, for an inline
 * image, the placeholder `(embedded image/png)` that the artifact text
 * substitutes. Re-deriving the source from that text would quietly ship a
 * report with the chart or the picture gone, so the request is refused and
 * the model is told to resend the document instead.
 */
const UNPATCHABLE_DOCUMENT_BLOCK_TYPES = new Set(["chart", "image"]);

function unpatchableDocumentBlockType(documentSource: unknown): string | null {
	if (!documentSource || typeof documentSource !== "object") return null;
	const blocks = (documentSource as { blocks?: unknown }).blocks;
	if (!Array.isArray(blocks)) return null;
	for (const block of blocks) {
		const type =
			block && typeof block === "object"
				? (block as { type?: unknown }).type
				: null;
		if (
			typeof type === "string" &&
			UNPATCHABLE_DOCUMENT_BLOCK_TYPES.has(type)
		) {
			return type;
		}
	}
	return null;
}

/** Added to a failed patch of a program-built file: the oldText has to come
 * from the program, which the model may not have read yet. */
const PROGRAM_PATCH_BASE_HINT =
	'This file was built by a program, so patches apply to that program: call read_generated_file with part: "source" and copy oldText from it.';

/** True for a filename whose type is not text (XLSX, PPTX, ZIP, …). */
function isBinaryOutputFilename(filename: string | undefined): boolean {
	const extension = outputTypeFromFilename(filename);
	return Boolean(extension) && !isTextLikeExtension(`.${extension}`);
}

function buildResolvedProgramSource(filename: string, content: string): string {
	const jsonFilename = JSON.stringify(filename);
	const jsonContent = JSON.stringify(content);
	return [
		"from pathlib import Path",
		"output = Path('/output')",
		"output.mkdir(parents=True, exist_ok=True)",
		`(output / ${jsonFilename}).write_text(${jsonContent}, encoding='utf-8')`,
		"",
	].join("\n");
}
