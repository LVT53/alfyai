import type { JSONSchema7 } from "@ai-sdk/provider";
import { type Tool, type ToolExecutionOptions, tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import { recordParallelUsage } from "$lib/server/services/analytics";
import type { ReasoningDepthWebSourceBudget } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type { Capability } from "$lib/server/services/connections/registry";
import type { FileProductionIntakeResult } from "$lib/server/services/file-production";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
import { searchImages } from "$lib/server/services/image-search";
import { getMemoryContext } from "$lib/server/services/memory-context";
import { fetchUrlViaParallel } from "$lib/server/services/parallel-search/fetch-url";
import { researchWebViaParallel } from "$lib/server/services/parallel-search/research";
import { createOrsProvider } from "$lib/server/services/routing/ors-provider";
import { getRoutingRegionManager } from "$lib/server/services/routing/region-runtime";
import { createRegionalRoutingProvider } from "$lib/server/services/routing/regional-provider";
import { OSM_ATTRIBUTION } from "$lib/server/services/routing/types";
import { getCachedToolHealthSnapshot } from "$lib/server/services/tool-health";
import {
	buildGroundedWebModelPayload,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
	summarizeGroundedWebResult,
} from "$lib/server/services/web-grounding";
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
	buildSameTurnProduceFileDedupeKey,
	buildScopedIdempotencyKey,
	compactProduceFileModelPayload,
	createProduceFileToolCallEntry,
	normalizeProduceFileInput,
	produceFileInputSchema,
	produceFileModelInputSchema,
	sanitizeProduceFileInput,
	sanitizeUnsafeProduceFileInput,
	summarizeProduceFileResult,
} from "./produce-file";
import {
	buildReadGeneratedFileModelPayload,
	extractContentFromMemoryText,
	readGeneratedFileContent,
	readGeneratedFileInputSchema,
	sanitizeReadGeneratedFileInput,
	summarizeReadGeneratedFileResult,
} from "./read-generated-file";
import {
	reposToolInputSchema,
	runReposTool,
	sanitizeReposToolInput,
} from "./repos";
import {
	researchWebInputSchema,
	sanitizeResearchWebInput,
} from "./research-web";
import {
	routingToolInputSchema,
	routingToolModelSchema,
	runRoutingTool,
	sanitizeRoutingToolInput,
} from "./routing";
import {
	compactToolInputSchema,
	createToolCallRecorder,
	executeToolWithEnvelope,
	modelSafeToolError,
	TOOL_TIMEOUTS_MS,
	type ToolCallRecorder,
} from "./shared";
import {
	runTasksTool,
	sanitizeTasksToolInput,
	tasksToolInputSchema,
} from "./tasks";
import {
	applyDegradedToolHints,
	collectDegradedToolHints,
} from "./tool-health-hints";

// Per-result excerpt budget (chars) requested from Parallel for research_web.
// Keeps each source's excerpt short enough to fit several sources into the
// model payload without crowding out the answer brief.
const RESEARCH_WEB_EXCERPT_MAX_CHARS = 2000;

type RequiredExecuteTool<TInput, TOutput> = Tool<TInput, TOutput> & {
	execute: NonNullable<Tool<TInput, TOutput>["execute"]>;
};

function asExecutableTool<TInput, TOutput>(
	toolDefinition: Tool<TInput, TOutput>,
): RequiredExecuteTool<TInput, TOutput> {
	return toolDefinition as RequiredExecuteTool<TInput, TOutput>;
}

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
}

// ── I18n ───────────────────────────────────────────────────────

type ToolI18n = Record<string, { description: string; errorPrefix: string }>;

const TOOL_I18N: Record<"en" | "hu", ToolI18n> = {
	en: {
		research_web: {
			description:
				'Search the web for current or verifiable facts: prices, specs, news, policies, comparisons. Pass {"query": "the exact research question"}; optionally `objective` and 2-3 short keyword `searchQueries` (no site: operators, no years unless historical). Returns `evidence` snippets and an `answerBriefMarkdown`; prefer primary sources when they conflict. Do not call it again when this turn already contains web research results.',
			errorPrefix: "Web research failed",
		},
		fetch_url: {
			description:
				'Read specific web pages: {"urls": ["https://example.com"]} (always an array, at most 5) plus an optional `objective` saying what to extract. Use for a link the user gave, or for a detail that research results lack and only the page has. Returns `evidence` snippets and an `answerBriefMarkdown`.',
			errorPrefix: "Fetch URL failed",
		},
		map_route: {
			description:
				'Geography on OpenStreetMap data. Pass one `action`: `geocode` (query, optional near/limit), `route` (origin, destination, optional waypoints), `matrix` (origins, destinations) or `isochrone` (origin, ranges_s in seconds). A place is a name string or {"lat":52.52,"lng":13.4}; `mode` is drive (default), walk or bike. Example: {"action":"route","origin":"Berlin Hbf","destination":"Brandenburg Gate","mode":"walk"}. It does not know where the user is: call `location` first for their coordinates. Narrate the structured result (distance_m, duration_s, legs, polygons) and always include "© OpenStreetMap contributors".',
			errorPrefix: "Routing failed",
		},
		memory_context: {
			description:
				"Look up durable memory when it would materially improve the answer. `mode` `persona` (default) for preferences and goals; `history` for older conversations matching `query`, then one of them via `historyConversationId` + `maxMessages`; `project` for project-folder continuity (name the folder in `query`), then a returned `siblingConversationId` for detail. `conversationId` is supplied automatically; never ask for or pass user, folder or project ids. An empty result is not proof that no memory exists.",
			errorPrefix: "Memory context lookup failed",
		},
		image_search: {
			description:
				'Find web images for the current request: {"query": "golden retriever puppy"}. Returns a list of image URLs. Embed the ones you use in your visible answer with markdown `![alt text](url)` where they belong; the user never sees raw tool output, so an unembedded image is invisible to them.',
			errorPrefix: "Image search failed",
		},
		produce_file: {
			description:
				"Create a downloadable file (PDF, DOCX, XLSX, PPTX, CSV, Markdown, ...). Call it only when the user asks for a file, after dependent tools have returned real content — never with placeholder or empty content. Simple form: `requestTitle`, `filename` or `outputType`, and `markdown`; the server picks the production mode. To change an existing file, call `read_generated_file` first, then resend the full content or send `patches` [{oldText, newText}] where each oldText is an exact, unique excerpt of 20+ characters. Use `program` only for artifacts that need code to build (XLSX, PPTX, ZIP). Use `documentSource` blocks only when structure clearly improves a PDF/DOCX/HTML report: heading{level,text}, paragraph{text}, list{style,items}, table{columns:[{key,label}],rows:[{key:value}]}, chart{chartType:bar|line|pie|donut|scatter,title,labelKey,valueKey,data:[{label,value}]}, code{language,text}, callout{tone,text}. Never draw tables or charts as text (no pipe tables in paragraphs, no block-character bars anywhere) and encode line breaks as \\n inside JSON strings. Success means the request was accepted, not that rendering has finished.",
			errorPrefix: "File production intake failed",
		},
		read_generated_file: {
			description:
				"Read the full current content of a file generated earlier in this conversation, by `filename` or `requestTitle`. Call it before sending `produce_file` patches: a patch whose oldText does not match the file exactly is rejected. If the file is not found, say so instead of guessing.",
			errorPrefix: "Read generated file failed",
		},
		files: {
			description:
				"List, search, read, and manage the user's connected files (e.g. their Nextcloud or OneDrive). Use action `list` to see and count the contents of a folder (pass the folder path, or omit it to list the root); action `search` to find files by name across the whole tree; and action `read` to open one specific file by its path. Every list/search/read result includes the item's last-modified time, so you can answer 'my most recent invoice' or 'the newest file'. Use when the user asks to browse, find, count, look up, or read a document/file. Can also `save` a new file, `move`/rename a file (set `destinationPath`), `delete` a file (to trash, recoverable), `create_folder` (make a new folder), and `share_link` (create a PUBLIC link — anyone with the URL can open the file, a deliberate exposure, so use sparingly) on the connected storage (requires the user to have enabled writes; NOT available for OneDrive connections, which are read-only) — these NEVER apply immediately: each only proposes a pending write the user must explicitly confirm before anything is saved, moved, deleted, created, or shared. If the user has more than one Files account connected (e.g. both Nextcloud and OneDrive), pass `account` (a provider name, connection label, or account email) to target a specific one.",
			errorPrefix: "Files lookup failed",
		},
		calendar: {
			description:
				"Read the user's connected calendar (Google or Apple iCloud): `list_events` (upcoming/ranged, optionally scoped to one calendar via `calendarId`), `check_availability` (free/busy, Google only, also `calendarId`-scopable), or `list_calendars` to discover the user's calendars and their ids — use it to find a `calendarId` before scoping a read or write (Google enumerates fully; Apple iCloud reads can't be scoped to a single calendar). Use when the user asks about their schedule, upcoming events, or whether they're free at a time. Can also create_event/update_event/delete_event on a connected Google Calendar (requires the user to have enabled writes) — these NEVER apply immediately: each one only proposes a pending change that the user must explicitly confirm before anything is created, changed, or deleted. If the target event is part of a recurring series, you must ask the user whether to affect just that occurrence or the whole series before proposing the change. If the user has more than one Calendar account connected (e.g. both Apple and Google), pass `account` (a provider name, connection label, or account email) to target a specific one.",
			errorPrefix: "Calendar lookup failed",
		},
		email: {
			description:
				"Read the user's connected email (IMAP): list recent messages; `search` by free text and/or `from` (sender), `subject`, and a `since`/`before` date range; `count` how many messages match without listing them (defaults to unread); or read a specific message by uid. Reads default to the Inbox but accept an optional `folder` (e.g. 'Sent', 'Archive', or a name from `list_folders`, which lists the mailbox's folders); a read also lists any attachments (filename/type/size). Use for the inbox or another folder, a specific email, the unread count, or attachments. Can also send a new email, move a message to Trash, or flag/mark a message (requires the user to have enabled writes) — these NEVER apply immediately: each only proposes a pending change the user must explicitly confirm before anything is sent, moved, or flagged. A sent email cannot be unsent, so double-check recipient, subject, and body before proposing a send. If the user has more than one Email account connected, pass `account` (a provider name, connection label, or account email) to target a specific one.",
			errorPrefix: "Email lookup failed",
		},
		photos: {
			description:
				"Find the user's photos/videos in their connected library (Immich). `search` is a natural-language SMART search matching visual/semantic CONTENT (what a photo depicts) — use it for 'a beach at sunset' or 'my dog in the snow'. For PRECISE filtering use `search_by_date`: a capture-date range (`from`/`to`, YYYY-MM-DD), place (`city`/`country`), media `type` (IMAGE/VIDEO), `favorites`, and/or a `personName` — this answers 'photos from June 2019', 'my favourites', or 'photos of a named person'. Use `list_albums` and `album` (by `albumId`) to browse albums, and `list_people` to find a recognized person's exact name. Each photo result includes an `imageUrl` — to actually SHOW a photo, not just list its filename, embed it in your answer as a markdown image `![short caption](imageUrl)`; prefer vividly showing a few relevant photos over a bare filename table. Can also add photos to an 'AlfyAI' album (requires the user to have enabled writes) — this only PROPOSES a pending, confirm-required change and never deletes or modifies the originals. If the user has more than one Photos account connected, pass `account` (a provider name, connection label, or account email) to target a specific one.",
			errorPrefix: "Photos lookup failed",
		},
		media: {
			description:
				"Read the user's connected media server (Plex): `watch_history` and `libraries` for analytics ('what did we watch this week'); `continue_watching` for what's in progress or up next; and `library_search` to search the OWNED library (titles the user has, watched or not) with match counts. Note: `watch_history`'s `query` filters HISTORY only — for 'do I own X?' use `library_search`, not history. Read-only. If the user has more than one Media account connected, pass `account` (a provider name, connection label, or account email) to target a specific one.",
			errorPrefix: "Media lookup failed",
		},
		location: {
			description:
				"Read the user's own current or past location from their connected OwnTracks device: `last` (where am I now), `history` (raw fixes over a range), `places` (a compact 'places visited' summary — best for 'where was I yesterday' or 'was I at the office'), and `distance` (straight-line distance — from the current fix to a given lat/lon, across a range for 'how far did I travel', or to a saved home if one is configured). Always resolves to the user's own self-selected device only. Read-only. If the user has more than one Location (OwnTracks) device connected, pass `account` (a provider name, connection label, or account email) to target a specific one.",
			errorPrefix: "Location lookup failed",
		},
		contacts: {
			description:
				"Look up a contact's identity (email/phone/organization) by name with the `lookup` action, or list everyone in a named contact group (e.g. 'Family', 'Work') with the `group` action — across the user's connected contacts sources (Google, Apple iCloud; groups are Google-only for now). Use when the user asks for someone's email/phone/company, or who's in a contact group. Read-only. Results are combined across every connected contacts source by default; pass `account` (a provider name, connection label, or account email) to narrow the lookup to one specific source.",
			errorPrefix: "Contacts lookup failed",
		},
		repos: {
			description:
				"Read the user's connected code repositories (GitHub, or a Gitea/GHE-compatible server): `list_repos` to see the user's repositories (most recently pushed first); `list_issues`, `list_prs` (pull requests), and `list_commits` (all scoped to a repo via `owner`+`repo`, optionally filtered by `state` for issues/PRs); `read_file` to open one file by `path` in a repo (optionally at a specific `ref`); `ci_status` to see recent CI/Actions runs for a repo; and `search_code` to search code across the user's accessible repositories with `query`. Use when the user asks about their code, a repo's issues/PRs/commits, build/CI status, or to find something in their code. Read-only — this connector never creates, comments on, merges, or pushes anything.",
			errorPrefix: "Repositories lookup failed",
		},
		tasks: {
			description:
				"Read the user's connected to-do/task lists (a CalDAV account's task lists): `list_tasks` to see open tasks (optionally filtered by `due` — a 'YYYY-MM-DD' date or the literal 'overdue'); and `search_tasks` to free-text search task titles/notes with `query`, optionally combined with `due`. Results are combined across every connected task source. Use when the user asks about their to-dos, what's due, or a specific task. Read-only. Pass `account` (a provider name, connection label, or account email) to narrow to one specific task source instead of combining every source.",
			errorPrefix: "Tasks lookup failed",
		},
	},
	hu: {
		research_web: {
			description:
				'Keresés az interneten aktuális vagy ellenőrizhető tényekért: árak, specifikációk, hírek, szabályzatok, összehasonlítások. Add meg: {"query": "a pontos kutatási kérdés"}; opcionálisan `objective` és 2-3 rövid kulcsszavas `searchQueries` (site: operátor nélkül, évszám nélkül, hacsak nem történeti a kérdés). `evidence` részleteket és `answerBriefMarkdown` összefoglalót ad vissza; ellentmondás esetén az elsődleges forrást részesítsd előnyben. Ne hívd újra, ha ebben a körben már vannak webes kutatási eredmények.',
			errorPrefix: "A webes kutatás sikertelen",
		},
		fetch_url: {
			description:
				'Konkrét weboldalak elolvasása: {"urls": ["https://example.com"]} (mindig tömb, legfeljebb 5) és opcionális `objective`, hogy mit keresel. Akkor használd, ha a felhasználó linket adott, vagy ha egy részlet hiányzik a kutatási eredményekből, és csak az oldalon található meg. `evidence` részleteket és `answerBriefMarkdown` összefoglalót ad vissza.',
			errorPrefix: "Az URL letöltése sikertelen",
		},
		map_route: {
			description:
				'Földrajz OpenStreetMap adatokon. Egy `action`-t adj meg: `geocode` (query, opcionális near/limit), `route` (origin, destination, opcionális waypoints), `matrix` (origins, destinations) vagy `isochrone` (origin, ranges_s másodpercben). Egy hely lehet helynév szöveg vagy {"lat":52.52,"lng":13.4}; a `mode` drive (alapértelmezett), walk vagy bike. Példa: {"action":"route","origin":"Keleti pályaudvar","destination":"Lánchíd","mode":"walk"}. Nem tudja, hol van a felhasználó: előbb hívd a `location` eszközt a koordinátákért. Mondd el az eredményt (distance_m, duration_s, legs, poligonok), és mindig szerepeljen benne a "© OpenStreetMap contributors" felirat.',
			errorPrefix: "Az útvonaltervezés sikertelen",
		},
		memory_context: {
			description:
				"Tartós memória lekérése, ha érdemben javítja a választ. `mode`: `persona` (alapértelmezett) preferenciákhoz és célokhoz; `history` a `query`-re illő régebbi beszélgetésekhez, majd egy beszélgetés részletei `historyConversationId` + `maxMessages` megadásával; `project` projektmappa-folytonossághoz (a mappa nevét a `query`-ben add meg), majd egy visszakapott `siblingConversationId` a részletekhez. A `conversationId`-t a rendszer adja meg; soha ne kérj vagy adj meg felhasználó-, mappa- vagy projektazonosítót. Az üres eredmény nem bizonyítja, hogy nincs kapcsolódó memória.",
			errorPrefix: "A memória kontextus lekérése sikertelen",
		},
		image_search: {
			description:
				'Képek keresése az interneten az aktuális kéréshez: {"query": "aranyszínű retriever kölyök"}. Kép-URL-ek listáját adja vissza. A használt képeket ágyazd be a látható válaszba Markdown képszintaxissal: `![alt szöveg](url)`, ott, ahová valók; a felhasználó nem látja a nyers eszközkimenetet, ezért a be nem ágyazott kép láthatatlan marad számára.',
			errorPrefix: "A képkeresés sikertelen",
		},
		produce_file: {
			description:
				"Letölthető fájl készítése (PDF, DOCX, XLSX, PPTX, CSV, Markdown, ...). Csak akkor hívd, ha a felhasználó fájlt kér, és a függő eszközök már valódi tartalmat adtak vissza — soha ne helyőrző vagy üres tartalommal. Egyszerű forma: `requestTitle`, `filename` vagy `outputType`, és `markdown`; az előállítási módot a szerver választja. Meglévő fájl módosításához előbb hívd a `read_generated_file`-t, majd küldd újra a teljes tartalmat, vagy adj `patches`-t [{oldText, newText}], ahol minden oldText pontos, egyedi, legalább 20 karakteres részlet. A `program`-ot csak kódot igénylő fájlokhoz használd (XLSX, PPTX, ZIP). `documentSource` blokkokat csak akkor, ha a struktúra egyértelműen javít egy PDF/DOCX/HTML riportot: heading{level,text}, paragraph{text}, list{style,items}, table{columns:[{key,label}],rows:[{key:value}]}, chart{chartType:bar|line|pie|donut|scatter,title,labelKey,valueKey,data:[{label,value}]}, code{language,text}, callout{tone,text}. Soha ne rajzolj táblázatot vagy diagramot szövegként (nincs pipe-táblázat paragraph-ban, nincs blokk-karakteres sáv sehol), és a sortöréseket \\n-ként kódold a JSON szövegekben. A siker azt jelenti, hogy a kérést elfogadták, nem azt, hogy a renderelés kész.",
			errorPrefix: "A fájl-előállítás sikertelen",
		},
		read_generated_file: {
			description:
				"Egy ebben a beszélgetésben korábban generált fájl teljes aktuális tartalmának beolvasása `filename` vagy `requestTitle` alapján. Hívd meg, mielőtt `produce_file` patch-eket küldenél: a fájllal pontosan nem egyező oldText-ű patch-et a szerver elutasítja. Ha a fájl nem található, mondd ki, ne találgass.",
			errorPrefix: "A fájl beolvasása sikertelen",
		},
		files: {
			description:
				"A felhasználó csatlakoztatott fájljainak (pl. Nextcloud vagy OneDrive) listázása, keresése, olvasása és kezelése. A `list` egy mappa tartalmát nézi meg és számolja meg; a `search` név alapján keres az egész fában; a `read` egy konkrét fájlt nyit meg útvonal alapján. Minden list/search/read találat tartalmazza az utolsó módosítás idejét ('a legutóbbi számlám', 'a legújabb fájl'). Emellett új fájl mentésére (`save`), áthelyezésére/átnevezésére (`move`, add meg a `destinationPath`-t), törlésére (`delete` — a kukába, visszaállítható), mappa létrehozására (`create_folder`) és NYILVÁNOS megosztási link készítésére (`share_link` — a linkkel bárki megnyithatja a fájlt, ez szándékos közzététel, óvatosan használd) is képes (ehhez az írásnak engedélyezve kell lennie; OneDrive-kapcsolatoknál ez NEM elérhető, azok csak olvashatók) — ezek SOHA nem lépnek életbe azonnal: mindegyik csak egy függőben lévő műveletet javasol, amelyet a felhasználónak kifejezetten jóvá kell hagynia. Ha a felhasználónak több Files-fiókja is csatlakoztatva van (pl. Nextcloud ÉS OneDrive), add meg az `account` mezőt (szolgáltató neve, kapcsolat címkéje vagy fiók e-mail címe) egy konkrét fiók megcélzásához.",
			errorPrefix: "A fájlok elérése sikertelen",
		},
		calendar: {
			description:
				"A felhasználó csatlakoztatott naptárának (Google vagy Apple iCloud) olvasása: `list_events` (közelgő/időszakra vonatkozó események, opcionálisan egy naptárra szűkítve a `calendarId`-vel), `check_availability` (szabad/foglalt állapot, csak Google, szintén `calendarId`-vel szűkíthető), vagy `list_calendars` a felhasználó naptárainak és azonosítóinak felfedezéséhez — ezzel találhatod meg a `calendarId`-t egy olvasás vagy írás szűkítése előtt (Google esetén teljes a felsorolás; Apple iCloudnál egy olvasás nem szűkíthető egyetlen naptárra). Akkor használd, ha a felhasználó a naptárára, közelgő eseményeire kérdez rá, vagy hogy ráér-e egy adott időpontban. Google Calendaren esemény létrehozására (create_event), módosítására (update_event) és törlésére (delete_event) is képes (ehhez az írásnak engedélyezve kell lennie) — ezek SOHA nem lépnek életbe azonnal: mindegyik csak egy függőben lévő módosítást javasol, amelyet a felhasználónak kifejezetten jóvá kell hagynia, mielőtt bármi létrejönne, módosulna vagy törlődne. Ha a célesemény egy ismétlődő sorozat része, a módosítás javaslata előtt meg kell kérdezned a felhasználót, hogy csak az adott alkalomra vagy az egész sorozatra vonatkozzon-e. Ha a felhasználónak több Naptár-fiókja is csatlakoztatva van (pl. Apple ÉS Google), add meg az `account` mezőt (szolgáltató neve, kapcsolat címkéje vagy fiók e-mail címe) egy konkrét fiók megcélzásához.",
			errorPrefix: "A naptár elérése sikertelen",
		},
		email: {
			description:
				"A felhasználó csatlakoztatott e-mail fiókjának (IMAP) olvasása: legutóbbi üzenetek listázása; `search` szabad szöveg és/vagy `from` (feladó), `subject` (tárgy), `since`/`before` dátumtartomány alapján; `count` a találatok megszámolása felsorolás nélkül (alapból olvasatlanok); vagy egy üzenet elolvasása uid alapján. Az olvasás alapból a Beérkezett mappára vonatkozik, de elfogad egy opcionális `folder`-t (pl. 'Elküldött', 'Archívum', vagy egy név a `list_folders`-ból, amely a mappákat listázza); egy olvasás a csatolmányokat is felsorolja (fájlnév/típus/méret). Új e-mail küldésére, Törölt elemek közé helyezésére vagy megjelölésére is képes (ehhez az írásnak engedélyezve kell lennie) — ezek SOHA nem lépnek életbe azonnal: mindegyik csak egy függőben lévő módosítást javasol, amelyet a felhasználónak jóvá kell hagynia. Egy elküldött e-mailt nem lehet visszavonni, ezért a küldés előtt ellenőrizd a címzettet, tárgyat és szöveget. Ha a felhasználónak több E-mail fiókja is csatlakoztatva van, add meg az `account` mezőt (szolgáltató neve, kapcsolat címkéje vagy fiók e-mail címe) egy konkrét fiók megcélzásához.",
			errorPrefix: "Az e-mail elérése sikertelen",
		},
		photos: {
			description:
				"A felhasználó csatlakoztatott fényképtárának (Immich) keresése. A `search` természetes nyelvű INTELLIGENS keresés, a fényképek vizuális/szemantikai TARTALMÁRA illeszkedik ('tengerpart naplementében', 'a kutyám a hóban'). PONTOS szűréshez használd a `search_by_date`-et: készítési dátumtartomány (`from`/`to`, ÉÉÉÉ-HH-NN), hely (`city`/`country`), médiatípus (`type`: IMAGE/VIDEO), kedvencek (`favorites`) és/vagy `personName` — ez válaszolja meg a '2019 júniusi fényképek', 'kedvenceim' vagy 'X személy fényképei' kéréseket. A `list_albums` és `album` (az `albumId`-vel) az albumok böngészéséhez, a `list_people` egy felismert személy pontos nevének megtalálásához. Minden fénykép-találat tartalmaz egy `imageUrl`-t — ha nem csak a fájlnevet akarod felsorolni, hanem meg is akarod MUTATNI a fényképet, ágyazd be a válaszodba Markdown képként: `![rövid felirat](imageUrl)`; inkább mutass élénken néhány releváns fényképet, mint hogy csupasz fájlnév-táblázatot adj. Fényképek egy 'AlfyAI' albumhoz adására is képes (ehhez az írásnak engedélyezve kell lennie) — ez csak egy függőben lévő, megerősítést igénylő módosítást javasol; az eredetieket soha nem törli és nem módosítja. Ha a felhasználónak több Fényképek-fiókja is csatlakoztatva van, add meg az `account` mezőt (szolgáltató neve, kapcsolat címkéje vagy fiók e-mail címe) egy konkrét fiók megcélzásához.",
			errorPrefix: "A fényképek elérése sikertelen",
		},
		media: {
			description:
				"A felhasználó csatlakoztatott médiaszerverének (Plex) olvasása: `watch_history` és `libraries` az analitikához ('mit néztünk ezen a héten'); `continue_watching` ahhoz, ami épp folyamatban van vagy következik; és `library_search` a BIRTOKOLT könyvtár keresésére (amit a felhasználó birtokol, akár nézte, akár nem), találati számmal. Megjegyzés: a `watch_history` `query` szűrője csak az ELŐZMÉNYEKBEN keres — a 'megvan-e nekem X?' kérdéshez a `library_search`-öt használd, ne az előzményeket. Csak olvasható. Ha a felhasználónak több Media-fiókja is csatlakoztatva van, add meg az `account` mezőt (szolgáltató neve, kapcsolat címkéje vagy fiók e-mail címe) egy konkrét fiók megcélzásához.",
			errorPrefix: "A média elérése sikertelen",
		},
		location: {
			description:
				"A felhasználó saját, csatlakoztatott OwnTracks eszközének helyzete: `last` (hol vagyok most), `history` (nyers pozíciók egy időszakban), `places` (tömör 'meglátogatott helyek' összegzés — a 'hol voltam tegnap' vagy 'ott voltam-e az irodában' kérdésekhez) és `distance` (légvonalbeli távolság — a jelenlegi ponttól egy megadott lat/lon-ig, egy időszakon át a 'mennyit utaztam'-hoz, vagy egy elmentett otthonig, ha be van állítva). Mindig kizárólag a felhasználó saját, általa kiválasztott eszközére vonatkozik. Csak olvasható. Ha a felhasználónak több Helyadat-fiókja (eszköze) is csatlakoztatva van, add meg az `account` mezőt (szolgáltató neve, kapcsolat címkéje vagy fiók e-mail címe) egy konkrét eszköz megcélzásához.",
			errorPrefix: "A helyadat lekérdezése sikertelen",
		},
		contacts: {
			description:
				"Egy kapcsolattartó adatainak (e-mail/telefonszám/cég) keresése név alapján a `lookup` művelettel, vagy egy megnevezett kapcsolattartó-csoport (pl. 'Család', 'Munka') tagjainak listázása a `group` művelettel — a felhasználó csatlakoztatott forrásaiban (Google, Apple iCloud; a csoportok egyelőre csak Google esetén). Akkor használd, ha valakinek az e-mail címét/telefonszámát/cégét kérik, vagy hogy ki tartozik egy csoportba. Csak olvasható. Alapból minden csatlakoztatott kapcsolattartó-forrásból összesíti a találatokat; add meg az `account` mezőt (szolgáltató neve, kapcsolat címkéje vagy fiók e-mail címe) egy konkrét forrásra szűkítéshez.",
			errorPrefix: "A kapcsolattartók elérése sikertelen",
		},
		repos: {
			description:
				"A felhasználó csatlakoztatott kódtárolóinak (GitHub, vagy egy Gitea/GHE-kompatibilis szerver) olvasása: `list_repos` a felhasználó repóinak listázásához (legutóbb pusholt elöl); `list_issues`, `list_prs` (pull requestek) és `list_commits` (mindegyik egy repóra szűkítve az `owner`+`repo` paraméterrel, az issue-k/PR-ek opcionálisan `state` szerint szűrhetők); `read_file` egy fájl megnyitásához `path` alapján egy repóban (opcionálisan adott `ref`-en); `ci_status` egy repó legutóbbi CI/Actions futásainak megtekintéséhez; és `search_code` kódkereséshez a felhasználó elérhető repóiban a `query` alapján. Akkor használd, ha a felhasználó a kódjára, egy repó issue-jaira/PR-jeire/commitjaira, build/CI állapotára kérdez rá, vagy valamit keres a kódjában. Csak olvasható — ez a kapcsolat soha nem hoz létre, nem kommentál, nem egyesít és nem pushol semmit.",
			errorPrefix: "A kódtárolók elérése sikertelen",
		},
		tasks: {
			description:
				"A felhasználó csatlakoztatott teendő-/feladatlistáinak (egy CalDAV-fiók feladatlistái) olvasása: `list_tasks` a nyitott feladatok megtekintéséhez (opcionálisan `due` szerint szűrve — egy 'ÉÉÉÉ-HH-NN' dátum vagy a szó szerinti 'overdue'); és `search_tasks` a feladatcímek/jegyzetek szabad szöveges kereséséhez a `query` alapján, opcionálisan `due`-val kombinálva. Az eredmények minden csatlakoztatott feladatforrásból összesítve jelennek meg. Akkor használd, ha a felhasználó a teendőire, a határidőkre vagy egy konkrét feladatra kérdez rá. Csak olvasható. Add meg az `account` mezőt (szolgáltató neve, kapcsolat címkéje vagy fiók e-mail címe) egy konkrét feladatforrásra szűkítéshez, ahelyett hogy minden forrást összesítene.",
			errorPrefix: "A feladatok elérése sikertelen",
		},
	},
};

// ── Tool factory ───────────────────────────────────────────────

export function createNormalChatTools(ctx: CreateNormalChatToolsContext) {
	const recorder = ctx.recorder ?? createToolCallRecorder();
	const lang = ctx.language ?? "en";
	const i18n = TOOL_I18N[lang];
	const sameTurnProduceFileResults = new Map<
		string,
		Extract<FileProductionIntakeResult, { ok: true }>
	>();
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
	const mapRouteDescription = orsCoverageLabel
		? `${i18n.map_route.description} ${
				registrationConfig.routingOnDemandEnabled
					? lang === "hu"
						? `LEFEDETTSÉG: jelenleg betöltött régiók: ${orsCoverageLabel}. Más régiók térképadatát a szerver első használatkor igény szerint letölti és felépíti (10–40 perc); ha az eszköz azt jelzi, hogy egy régió előkészítés alatt áll, mondd el a felhasználónak, hogy kérdezzen rá később, és ne becsülj.`
						: `COVERAGE: regions loaded right now: ${orsCoverageLabel}. Other regions are downloaded and built on demand the first time they are needed (10–40 minutes); if the tool reports a region is being prepared, tell the user to ask again later and do not estimate.`
					: lang === "hu"
						? `FONTOS: az útvonaltervező térképadatai CSAK ezt a régiót fedik le: ${orsCoverageLabel}. Ezen kívüli helyekre ne hívd útvonalhoz/mátrixhoz/izokronhoz — mondd ki, hogy a hely kívül esik az útvonaltervezés lefedettségén, és ne becsülj.`
						: `IMPORTANT: the routing map data on this server covers ONLY ${orsCoverageLabel}. Do not call route/matrix/isochrone for places outside it — say the location is outside the routing coverage instead, and do not estimate.`
			}`
		: i18n.map_route.description;
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
					research_web: asExecutableTool(
						tool({
							description: i18n.research_web.description,
							inputSchema: researchWebInputSchema,
							execute: async (
								input: z.infer<typeof researchWebInputSchema>,
								options: ToolExecutionOptions,
							) => {
								const safeInput = sanitizeResearchWebInput(input);
								return executeToolWithEnvelope({
									toolName: "research_web",
									timeoutMs: TOOL_TIMEOUTS_MS.research_web,
									options,
									recorder,
									run: async (abortSignal) => {
										const { parallelApiKey, parallelBaseUrl } = getConfig();
										const result = await researchWebViaParallel(
											safeInput,
											{
												fetch,
												config: { parallelApiKey, parallelBaseUrl },
												signal: abortSignal,
											},
											{
												sessionId: ctx.turnId,
												excerptMaxChars: RESEARCH_WEB_EXCERPT_MAX_CHARS,
											},
										);
										// Fire-and-forget Parallel Turbo usage tracking; never
										// block or alter the tool result on analytics failure.
										void recordParallelUsage({
											userId: ctx.userId,
											conversationId: ctx.conversationId,
											tool: "research_web",
										}).catch(() => {});
										const modelPayload = buildGroundedWebModelPayload(result);
										const candidates = createGroundedWebCandidates(result);
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "research_web",
												input: safeInput,
												status: "done",
												outputSummary: summarizeGroundedWebResult(result),
												sourceType: "web",
												candidates,
												metadata: createGroundedWebMetadata(result),
											},
										};
									},
									onError: (error) => {
										const message = modelSafeToolError(
											error,
											i18n.research_web.errorPrefix,
										);
										const modelPayload = {
											success: false as const,
											error: message,
										};
										return {
											modelPayload,
											entry: {
												callId: options.toolCallId,
												name: "research_web",
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
										const { parallelApiKey, parallelBaseUrl } = getConfig();
										// Size returned page content to the selected model's context
										// window, and chain this fetch to the conversation's session.
										const maxCharsTotal = resolveFetchContentCharCap(
											await resolveModelContextTokens(ctx.modelId),
										);
										const result = await fetchUrlViaParallel(
											safeInput,
											{
												fetch,
												config: { parallelApiKey, parallelBaseUrl },
												signal: abortSignal,
											},
											{ sessionId: ctx.turnId, maxCharsTotal },
										);
										// Fire-and-forget Parallel Extract usage tracking; never
										// block or alter the tool result on analytics failure.
										void recordParallelUsage({
											userId: ctx.userId,
											conversationId: ctx.conversationId,
											tool: "fetch_url",
										}).catch(() => {});
										// Keep the answer brief sized to the same model-aware cap the
										// fetch used, so the detailed full_content isn't re-truncated
										// below it when building the model payload.
										const modelPayload = buildGroundedWebModelPayload(result, {
											maxMarkdownChars: maxCharsTotal,
											name: "fetch_url",
										});
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
												metadata: createGroundedWebMetadata(result),
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
					const parsedInput = produceFileInputSchema.safeParse(input);
					if (!parsedInput.success) {
						const safeInput = sanitizeUnsafeProduceFileInput(input);
						const error =
							parsedInput.error.issues[0]?.message ??
							"Invalid file production tool input";
						const result: Extract<FileProductionIntakeResult, { ok: false }> = {
							ok: false,
							status: 422,
							code: "invalid_tool_input",
							error,
						};
						const modelPayload = compactProduceFileModelPayload(result);
						recorder.record(
							createProduceFileToolCallEntry({
								callId: options.toolCallId,
								input: safeInput,
								result,
								outputSummary: summarizeProduceFileResult(modelPayload),
							}),
						);
						return modelPayload;
					}
					const normalized = normalizeProduceFileInput(parsedInput.data);
					if (!normalized.ok) {
						const safeInput = sanitizeUnsafeProduceFileInput(input);
						const result: Extract<FileProductionIntakeResult, { ok: false }> = {
							ok: false,
							status: 422,
							code: "invalid_tool_input",
							error: normalized.error,
						};
						const modelPayload = compactProduceFileModelPayload(result);
						recorder.record(
							createProduceFileToolCallEntry({
								callId: options.toolCallId,
								input: safeInput,
								result,
								outputSummary: summarizeProduceFileResult(modelPayload),
							}),
						);
						return modelPayload;
					}
					const normalizedInput = normalized.input;

					// Resolve patches: if the model provided surgical edits instead of full content,
					// fetch the previous version and apply patches to reconstruct the full file.
					if (
						normalizedInput.patches &&
						normalizedInput.patches.length > 0 &&
						normalizedInput.sourceMode === "program" &&
						normalizedInput.program
					) {
						const previousContent = await getPreviousGeneratedFileContent(
							ctx.userId,
							ctx.conversationId,
							normalizedInput.requestTitle,
						);
						if (previousContent === null) {
							const error =
								"No previous version of this file could be found. Use content, markdown, or text to create the initial version instead of patches.";
							const result: Extract<FileProductionIntakeResult, { ok: false }> =
								{
									ok: false,
									status: 422,
									code: "no_previous_version_for_patches",
									error,
								};
							const safeInput = sanitizeProduceFileInput(normalizedInput);
							const modelPayload = compactProduceFileModelPayload(result);
							recorder.record(
								createProduceFileToolCallEntry({
									callId: options.toolCallId,
									input: safeInput,
									result,
									outputSummary: summarizeProduceFileResult(modelPayload),
								}),
							);
							return modelPayload;
						}
						const patchResult = applyTextPatches(
							previousContent,
							normalizedInput.patches,
						);
						if (!patchResult.ok) {
							const result: Extract<FileProductionIntakeResult, { ok: false }> =
								{
									ok: false,
									status: 422,
									code: "patch_failed",
									error: patchResult.error,
								};
							const safeInput = sanitizeProduceFileInput(normalizedInput);
							const modelPayload = compactProduceFileModelPayload(result);
							recorder.record(
								createProduceFileToolCallEntry({
									callId: options.toolCallId,
									input: safeInput,
									result,
									outputSummary: summarizeProduceFileResult(modelPayload),
								}),
							);
							return modelPayload;
						}
						normalizedInput.program.sourceCode = buildResolvedProgramSource(
							normalizedInput.program.filename ?? "generated-file.txt",
							patchResult.resolvedText,
						);
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
					const sameTurnResult =
						sameTurnProduceFileResults.get(sameTurnDedupeKey);
					if (sameTurnResult) {
						const result = { ...sameTurnResult, reused: true };
						const modelPayload = compactProduceFileModelPayload(result);
						recorder.record(
							createProduceFileToolCallEntry({
								callId: options.toolCallId,
								input: safeInput,
								result,
								outputSummary: summarizeProduceFileResult(modelPayload),
								metadata: { dedupedSameTurn: true },
							}),
						);
						return modelPayload;
					}

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
								sameTurnProduceFileResults.set(sameTurnDedupeKey, result);
							}
							const modelPayload = compactProduceFileModelPayload(result);
							return {
								modelPayload,
								entry: createProduceFileToolCallEntry({
									callId: options.toolCallId,
									input: safeInput,
									result,
									outputSummary: summarizeProduceFileResult(modelPayload),
								}),
							};
						},
						onError: (error) => {
							const safeError = modelSafeToolError(
								error,
								i18n.produce_file.errorPrefix,
							);
							const modelPayload = {
								ok: false as const,
								status: 500,
								code: "tool_execution_failed",
								error: i18n.produce_file.errorPrefix,
							};
							return {
								modelPayload,
								entry: {
									callId: options.toolCallId,
									name: "produce_file",
									input: safeInput,
									status: "done",
									outputSummary: modelPayload.error,
									sourceType: "tool",
									metadata: {
										ok: false,
										evidenceReady: false,
										intakeStatus: 500,
										error: safeError,
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
					const parsedInput = readGeneratedFileInputSchema.safeParse(input);
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
							const result = await readGeneratedFileContent({
								userId: ctx.userId,
								conversationId: ctx.conversationId,
								filename: parsedInput.data.filename ?? null,
								requestTitle: parsedInput.data.requestTitle ?? null,
							});
							const modelPayload = buildReadGeneratedFileModelPayload(result);
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
										ok: !result.notFound,
										evidenceReady: false,
										found: !result.notFound,
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
		done: tool({
			description:
				"Call once, at the very end, when the answer is complete and every requested file has been produced; pass a one-line `summary`. It ends the turn, so if more tool calls might be needed, make them instead.",
			inputSchema: z.object({
				summary: z.string().describe("One line on what was accomplished"),
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

async function getPreviousGeneratedFileContent(
	userId: string,
	conversationId: string,
	requestTitle: string,
): Promise<string | null> {
	const rows = await db
		.select({
			contentText: artifacts.contentText,
		})
		.from(artifacts)
		.where(
			and(
				eq(artifacts.userId, userId),
				eq(artifacts.conversationId, conversationId),
				eq(artifacts.type, "generated_output"),
			),
		)
		.orderBy(desc(artifacts.updatedAt))
		.limit(24);

	const normalizedTitle = requestTitle.trim().toLowerCase();
	for (const row of rows) {
		if (!row.contentText) continue;
		if (row.contentText.toLowerCase().includes(normalizedTitle)) {
			const extracted = extractContentFromMemoryText(row.contentText);
			return extracted ?? row.contentText;
		}
	}

	return null;
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
