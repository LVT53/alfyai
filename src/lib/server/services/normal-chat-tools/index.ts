import { type Tool, type ToolExecutionOptions, tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "$lib/server/db";
import { artifacts } from "$lib/server/db/schema";
import type { ReasoningDepthWebSourceBudget } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type { Capability } from "$lib/server/services/connections/registry";
import type { FileProductionIntakeResult } from "$lib/server/services/file-production";
import { submitFileProductionIntake } from "$lib/server/services/file-production";
import { searchImages } from "$lib/server/services/image-search";
import { getMemoryContext } from "$lib/server/services/memory-context";
import {
	buildGroundedWebModelPayload,
	createGroundedWebCandidates,
	createGroundedWebMetadata,
	summarizeGroundedWebResult,
} from "$lib/server/services/web-grounding";
import { researchWeb } from "$lib/server/services/web-research";
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
	researchWebInputSchema,
	sanitizeResearchWebInput,
} from "./research-web";

import {
	createToolCallRecorder,
	executeToolWithEnvelope,
	modelSafeToolError,
	TOOL_TIMEOUTS_MS,
	type ToolCallRecorder,
} from "./shared";

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
}

// ── I18n ───────────────────────────────────────────────────────

type ToolI18n = Record<string, { description: string; errorPrefix: string }>;

const TOOL_I18N: Record<"en" | "hu", ToolI18n> = {
	en: {
		research_web: {
			description:
				"Search and fetch current web sources, returning compact citation-ready evidence.",
			errorPrefix: "Web research failed",
		},
		memory_context: {
			description:
				"Retrieve bounded durable memory, named project-folder context, project continuity, persona memory, or account history for this conversation.",
			errorPrefix: "Memory context lookup failed",
		},
		image_search: {
			description: "Search the web for image results for the current request.",
			errorPrefix: "Image search failed",
		},
		produce_file: {
			description:
				"Queue generation of downloadable files for the current conversation.",
			errorPrefix: "File production intake failed",
		},
		read_generated_file: {
			description:
				"Read the full content of a previously generated file by filename or title, so you can review it before making surgical edits.",
			errorPrefix: "Read generated file failed",
		},
		files: {
			description:
				"List, search, read, and manage the user's connected files (e.g. their Nextcloud). Use action `list` to see and count the contents of a folder (pass the folder path, or omit it to list the root); action `search` to find files by name across the whole tree; and action `read` to open one specific file by its path. Every list/search/read result includes the item's last-modified time, so you can answer 'my most recent invoice' or 'the newest file'. Use when the user asks to browse, find, count, look up, or read a document/file. Can also `save` a new file, `move` a file to a new path (this also renames — set `destinationPath`), and `delete` a file (sent to trash, recoverable) on the connected storage (requires the user to have enabled writes) — these NEVER apply immediately: each only proposes a pending write the user must explicitly confirm before anything is saved, moved, or deleted.",
			errorPrefix: "Files lookup failed",
		},
		calendar: {
			description:
				"Read the user's connected calendar (Google or Apple iCloud): `list_events` (upcoming/ranged, optionally scoped to one calendar via `calendarId`), `check_availability` (free/busy, Google only, also `calendarId`-scopable), or `list_calendars` to discover the user's calendars and their ids — use it to find a `calendarId` before scoping a read or write (Google enumerates fully; Apple iCloud reads can't be scoped to a single calendar). Use when the user asks about their schedule, upcoming events, or whether they're free at a time. Can also create_event/update_event/delete_event on a connected Google Calendar (requires the user to have enabled writes) — these NEVER apply immediately: each one only proposes a pending change that the user must explicitly confirm before anything is created, changed, or deleted. If the target event is part of a recurring series, you must ask the user whether to affect just that occurrence or the whole series before proposing the change.",
			errorPrefix: "Calendar lookup failed",
		},
		email: {
			description:
				"Read the user's connected email inbox (IMAP): list recent messages; `search` by free text and/or `from` (sender), `subject`, and a `since`/`before` date range; `count` how many messages match without listing them (defaults to unread — good for 'how many unread do I have'); or read a specific message by uid. Reads cover the inbox. Use when the user asks about their inbox, a specific email, their unread count, or wants you to look something up in their email. Can also send a new email, move a message to Trash, or flag/mark a message (requires the user to have enabled writes) — these NEVER apply immediately: each one only proposes a pending change that the user must explicitly confirm before anything is sent, moved, or flagged. A sent email cannot be unsent, so double-check the recipient, subject, and body before proposing a send.",
			errorPrefix: "Email lookup failed",
		},
		photos: {
			description:
				'Search the user\'s connected photo library (Immich) with a natural-language SMART search — it matches on the visual/semantic CONTENT of photos (what they depict), NOT reliably by exact date, album, or specific person. Use it for "a beach at sunset" or "my dog in the snow", not for precise "photos from June 3rd" or "photos in my Trip album" filtering (it can\'t do those yet, and will return plausible-but-unfiltered results if you try). Use when the user asks you to find or recall photos/videos by what they show. Can also add photos to an "AlfyAI" album (requires the user to have enabled writes) — this NEVER applies immediately: it only proposes a pending change that the user must explicitly confirm before anything is added. It never deletes or modifies the original photos.',
			errorPrefix: "Photos lookup failed",
		},
		media: {
			description:
				"Read the user's connected media server (Plex) watch history and library sections — analytics only, e.g. 'what did we watch this week' or 'how many episodes of X have we seen'. Note: the `query` filter searches the WATCH HISTORY, not the whole library, so it can't confirm whether the user OWNS a title they haven't watched — don't conclude they don't have it just because history has no match. Use when the user asks about what they've watched. Read-only.",
			errorPrefix: "Media lookup failed",
		},
		location: {
			description:
				"Read the user's own current or past location from their connected OwnTracks device — e.g. 'where am I' or 'where was I yesterday'. Always resolves to the user's own self-selected device only. Read-only.",
			errorPrefix: "Location lookup failed",
		},
		contacts: {
			description:
				"Look up a contact's identity (email/phone) by name across the user's connected contacts sources (Google, Apple iCloud). Use when the user asks for someone's email address, phone number, or wants you to address a message to a named person. Read-only.",
			errorPrefix: "Contacts lookup failed",
		},
	},
	hu: {
		research_web: {
			description:
				"Keresés az interneten aktuális források után, tömör, hivatkozásra kész bizonyítékokkal.",
			errorPrefix: "A webes kutatás sikertelen",
		},
		memory_context: {
			description:
				"Tartós memória, projektmappa-kontextus, folytonosság, személyre szabott memória vagy fiókelőzmények lekérése ehhez a beszélgetéshez.",
			errorPrefix: "A memória kontextus lekérése sikertelen",
		},
		image_search: {
			description: "Képkeresés az interneten az aktuális kéréshez.",
			errorPrefix: "A képkeresés sikertelen",
		},
		produce_file: {
			description:
				"Letölthető fájlok generálásának ütemezése az aktuális beszélgetéshez.",
			errorPrefix: "A fájl-előállítás sikertelen",
		},
		read_generated_file: {
			description:
				"Egy korábban generált fájl teljes tartalmának beolvasása fájlnév vagy cím alapján, hogy ellenőrizhesd a tartalmát a módosítások előtt.",
			errorPrefix: "A fájl beolvasása sikertelen",
		},
		files: {
			description:
				"A felhasználó csatlakoztatott fájljainak (pl. Nextcloud) listázása, keresése, olvasása és kezelése. A `list` művelettel egy mappa tartalmát nézheted meg és számolhatod meg (add meg a mappa útvonalát, vagy hagyd el a gyökér listázásához); a `search` művelettel név alapján kereshetsz fájlokat az egész fában; a `read` művelettel pedig egy konkrét fájlt nyithatsz meg az útvonala alapján. Minden list/search/read találat tartalmazza az elem utolsó módosítási idejét, így megválaszolhatod a 'a legutóbbi számlám' vagy 'a legújabb fájl' kérdéseket. Akkor használd, ha a felhasználó fájlok böngészését, megkeresését, megszámolását, megnyitását vagy elolvasását kéri. Emellett új fájl mentésére (`save`), fájl áthelyezésére új útvonalra (`move` — ez átnevezésre is szolgál, add meg a `destinationPath`-t), és fájl törlésére (`delete` — a kukába kerül, visszaállítható) is képes a csatlakoztatott tárhelyen (ehhez az írásnak engedélyezve kell lennie) — ezek SOHA nem lépnek életbe azonnal: mindegyik csak egy függőben lévő műveletet javasol, amelyet a felhasználónak kifejezetten jóvá kell hagynia, mielőtt bármi elmentődne, áthelyeződne vagy törlődne.",
			errorPrefix: "A fájlok elérése sikertelen",
		},
		calendar: {
			description:
				"A felhasználó csatlakoztatott naptárának (Google vagy Apple iCloud) olvasása: `list_events` (közelgő/időszakra vonatkozó események, opcionálisan egy naptárra szűkítve a `calendarId`-vel), `check_availability` (szabad/foglalt állapot, csak Google, szintén `calendarId`-vel szűkíthető), vagy `list_calendars` a felhasználó naptárainak és azonosítóinak felfedezéséhez — ezzel találhatod meg a `calendarId`-t egy olvasás vagy írás szűkítése előtt (Google esetén teljes a felsorolás; Apple iCloudnál egy olvasás nem szűkíthető egyetlen naptárra). Akkor használd, ha a felhasználó a naptárára, közelgő eseményeire kérdez rá, vagy hogy ráér-e egy adott időpontban. Google Calendaren esemény létrehozására (create_event), módosítására (update_event) és törlésére (delete_event) is képes (ehhez az írásnak engedélyezve kell lennie) — ezek SOHA nem lépnek életbe azonnal: mindegyik csak egy függőben lévő módosítást javasol, amelyet a felhasználónak kifejezetten jóvá kell hagynia, mielőtt bármi létrejönne, módosulna vagy törlődne. Ha a célesemény egy ismétlődő sorozat része, a módosítás javaslata előtt meg kell kérdezned a felhasználót, hogy csak az adott alkalomra vagy az egész sorozatra vonatkozzon-e.",
			errorPrefix: "A naptár elérése sikertelen",
		},
		email: {
			description:
				"A felhasználó csatlakoztatott e-mail postafiókjának (IMAP) olvasása: legutóbbi üzenetek listázása; `search` szabad szöveg és/vagy `from` (feladó), `subject` (tárgy) és `since`/`before` dátumtartomány alapján; `count` a megfelelő üzenetek megszámolása felsorolás nélkül (alapból az olvasatlanok — jó a 'hány olvasatlanom van' kérdéshez); vagy egy adott üzenet elolvasása uid alapján. Az olvasás a Beérkezett üzenetekre vonatkozik. Akkor használd, ha a felhasználó a postafiókjára, egy konkrét e-mailre, az olvasatlanok számára kérdez rá, vagy szeretnéd, hogy megnézz valamit az e-mailjei között. Új e-mail küldésére, egy üzenet Törölt elemek közé helyezésére, vagy egy üzenet megjelölésére/jelzésére is képes (ehhez az írásnak engedélyezve kell lennie) — ezek SOHA nem lépnek életbe azonnal: mindegyik csak egy függőben lévő módosítást javasol, amelyet a felhasználónak kifejezetten jóvá kell hagynia, mielőtt bármi elküldődne, áthelyeződne vagy megjelölődne. Egy elküldött e-mailt nem lehet visszavonni, ezért a küldés javaslata előtt mindig ellenőrizd a címzettet, a tárgyat és a szöveget.",
			errorPrefix: "Az e-mail elérése sikertelen",
		},
		photos: {
			description:
				'A felhasználó csatlakoztatott fényképtárának (Immich) keresése természetes nyelvű INTELLIGENS kereséssel — a fényképek vizuális/szemantikai TARTALMÁRA illeszkedik (mit ábrázolnak), NEM megbízhatóan pontos dátum, album vagy konkrét személy alapján. Ilyesmire használd: "tengerpart naplementében" vagy "a kutyám a hóban", ne pedig pontos "június 3-i fényképek" vagy "a Nyaralás albumom fényképei" szűrésre (ezeket még nem tudja, és hihető, de nem szűrt találatokat ad, ha megpróbálod). Akkor használd, ha a felhasználó fényképeket vagy videókat keres, illetve idéz fel az alapján, amit ábrázolnak. Fényképek egy "AlfyAI" albumhoz adására is képes (ehhez az írásnak engedélyezve kell lennie) — ez SOHA nem lép életbe azonnal: csak egy függőben lévő módosítást javasol, amelyet a felhasználónak kifejezetten jóvá kell hagynia, mielőtt bármi hozzáadódna. Az eredeti fényképeket soha nem törli és nem módosítja.',
			errorPrefix: "A fényképek elérése sikertelen",
		},
		media: {
			description:
				"A felhasználó csatlakoztatott médiaszerverének (Plex) megtekintési előzményeinek és könyvtárrészeinek olvasása — csak analitika, pl. 'mit néztünk ezen a héten' vagy 'hány részt láttunk X-ből'. Megjegyzés: a `query` szűrő a MEGTEKINTÉSI ELŐZMÉNYEKBEN keres, nem a teljes könyvtárban, így nem tudja megerősíteni, hogy a felhasználó BIRTOKOL-e egy olyan címet, amelyet még nem nézett meg — ne vond le, hogy nincs meg neki, csak mert az előzményekben nincs találat. Akkor használd, ha a felhasználó arra kérdez rá, mit nézett. Csak olvasható.",
			errorPrefix: "A média elérése sikertelen",
		},
		location: {
			description:
				"A felhasználó saját, csatlakoztatott OwnTracks eszközének jelenlegi vagy korábbi helyzetének lekérdezése — pl. 'hol vagyok' vagy 'hol voltam tegnap'. Mindig kizárólag a felhasználó saját, általa kiválasztott eszközére vonatkozik. Csak olvasható.",
			errorPrefix: "A helyadat lekérdezése sikertelen",
		},
		contacts: {
			description:
				"Egy kapcsolattartó adatainak (e-mail/telefonszám) keresése név alapján a felhasználó csatlakoztatott kapcsolattartó-forrásaiban (Google, Apple iCloud). Akkor használd, ha a felhasználó valakinek az e-mail címét, telefonszámát kéri, vagy szeretné, hogy egy megnevezett személynek címezz egy üzenetet. Csak olvasható.",
			errorPrefix: "A kapcsolattartók elérése sikertelen",
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

	const tools = {
		research_web: asExecutableTool(
			tool({
				description: i18n.research_web.description,
				inputSchema: researchWebInputSchema,
				execute: async (
					input: z.infer<typeof researchWebInputSchema>,
					options: ToolExecutionOptions,
				) => {
					const safeInput = applyResearchWebSourceBudget(
						sanitizeResearchWebInput(input),
						ctx.webSourceBudget,
					);
					return executeToolWithEnvelope({
						toolName: "research_web",
						timeoutMs: TOOL_TIMEOUTS_MS.research_web,
						options,
						recorder,
						run: async (abortSignal) => {
							const result = await researchWeb(safeInput, {
								signal: abortSignal,
							});
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
		memory_context: asExecutableTool(
			tool({
				description: i18n.memory_context.description,
				inputSchema: memoryContextInputSchema,
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
				inputSchema: produceFileInputSchema,
				execute: async (
					input: z.infer<typeof produceFileInputSchema>,
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
		done: tool({
			description:
				"Call this when the task is fully complete and you have nothing more to add. Include a brief summary of what was accomplished. Calling this ends the agent loop — do not call it until you are truly finished.",
			inputSchema: z.object({
				summary: z
					.string()
					.describe("Brief summary of what was accomplished in this turn"),
			}),
		}),
	};

	return {
		tools,
		recorder,
		getToolCalls: () => recorder.getEntries(),
	};
}

function applyResearchWebSourceBudget(
	input: z.infer<typeof researchWebInputSchema>,
	budget: ReasoningDepthWebSourceBudget | undefined,
): z.infer<typeof researchWebInputSchema> {
	if (!budget) return input;
	const maxSources = Math.max(1, Math.min(12, Math.floor(budget.maxSources)));
	if (input.maxSources === undefined) {
		return { ...input, maxSources };
	}
	return {
		...input,
		maxSources: Math.min(input.maxSources, maxSources),
	};
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
