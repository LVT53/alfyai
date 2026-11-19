// What a tool row says, in plain words (spec: docs/superpowers/specs/2026-11-18-tool-row-words-design.md).
//
// Every outcome a tool's server code tells apart has one short sentence here, in
// English and Hungarian, and the browser's registry (`utils/tool-reason-words.ts`)
// maps each reason code to its sentence and to a kind (broke, stopped on purpose,
// information, nothing found). A person never reads a code, an exception, an
// HTTP status or the note the tool wrote for the model: the raw cause stays in the
// server log. Hungarian is short and natural and fits a 360 to 390 px row; "készség"
// is a skill; no sentence names an "artifact" (the app's word is "item").
//
// Keys are spelled out one by one on purpose: the i18n parity test reads this file's
// syntax, and a key built at run time would not be watched.

const toolRowsDict = {
	en: {
		// The three outcomes every tool can have, from the envelope that runs it.
		"toolRows.shared.stopped": "You stopped this before it finished.",
		"toolRows.shared.timed_out": "This took too long, so Alfy stopped waiting.",
		"toolRows.shared.out_of_time":
			"The time for this reply ran out, so Alfy stopped here.",
		// Alfy asked the wrong way and corrected itself.
		"toolRows.shared.request_adjusted": "Alfy adjusted its request.",
		// A read or a change of an item (a document, an app, a file) that is gone.
		"toolRows.shared.item_not_found": "That item isn't there any more.",
		// A tool this list does not know (a new tool before its words are written).
		"toolRows.generic.fallback": "This step couldn't be finished.",

		// What a row says on its own line, beside its words (a search, a picture
		// search or a lookup that found nothing does not open).
		"toolRows.meta.nothingFound": "nothing found",
		"toolRows.meta.pictures":
			"{count} picture{count, plural, one {} other {s}}",
		"toolRows.meta.pastChats":
			"{count} past chat{count, plural, one {} other {s}}",
		// After the 5th thing a list names: "and 3 more".
		"toolRows.more": "and {count} more",

		// The verb of a row whose outcome changes what it did (a stop on purpose, a
		// lookup into chats rather than memories, an offer instead of a tool).
		"toolRows.verb.didntOpen": "Didn't open",
		"toolRows.verb.lookedThrough": "Looked through",
		"toolRows.verb.noSkillCalled": "No skill called",
		"toolRows.verb.suggestedInstruction": "Suggested an instruction",
		"toolRows.verb.leftAsItWas": "Left as it was:",
		"toolRows.verb.adjustingRequest": "Adjusting the request",

		// After the object of a read of a file: which part of it.
		"toolRows.suffix.page": "· page {number}",
		"toolRows.suffix.part": "· part {number}",

		// What an account row counts on its right ("Calendar · 3 events"), and what
		// each call says it found beside its own words ("3 found").
		"toolRows.unit.events": "{count} event{count, plural, one {} other {s}}",
		"toolRows.unit.messages":
			"{count} message{count, plural, one {} other {s}}",
		"toolRows.unit.found": "{count} found",
		"toolRows.object.notConnected": "not connected",

		// The English stand-ins the account tools give a thing that has no name,
		// shown in the person's own words.
		"toolRows.placeholder.untitledEvent": "Untitled event",
		"toolRows.placeholder.noSubject": "No subject",
		"toolRows.placeholder.photo": "Photo",
		"toolRows.placeholder.placeAt": "A place at {time}",
		"toolRows.placeholder.unnamedContact": "Unnamed contact",
		"toolRows.placeholder.watchedItem": "A watched title",

		// What each call of an account tool did, one phrase per action the tool's
		// schema offers, and one for an action this list does not know. A change is
		// only ever proposed: the person confirms it on its own card.
		"toolRows.connector.calendar.list_events": "Looked at your events",
		"toolRows.connector.calendar.list_calendars": "Looked at your calendars",
		"toolRows.connector.calendar.check_availability":
			"Checked when you're free",
		"toolRows.connector.calendar.create_event": "Proposed a new event",
		"toolRows.connector.calendar.update_event": "Proposed a change to an event",
		"toolRows.connector.calendar.delete_event": "Proposed deleting an event",
		"toolRows.connector.calendar.other": "Used your calendar",
		"toolRows.connector.email.recent": "Looked at your inbox",
		"toolRows.connector.email.search": "Searched your email",
		"toolRows.connector.email.count": "Counted your emails",
		"toolRows.connector.email.read": "Read an email",
		"toolRows.connector.email.list_folders": "Looked at your mail folders",
		"toolRows.connector.email.send": "Proposed sending an email",
		"toolRows.connector.email.trash": "Proposed moving an email to Trash",
		"toolRows.connector.email.flag": "Proposed flagging an email",
		"toolRows.connector.email.other": "Used your email",
		"toolRows.connector.files.list": "Looked in a folder",
		"toolRows.connector.files.search": "Searched your files",
		"toolRows.connector.files.read": "Opened a file",
		"toolRows.connector.files.save": "Proposed saving a file",
		"toolRows.connector.files.move": "Proposed moving a file",
		"toolRows.connector.files.delete": "Proposed deleting a file",
		"toolRows.connector.files.create_folder": "Proposed a new folder",
		"toolRows.connector.files.share_link": "Proposed a share link",
		"toolRows.connector.files.other": "Used your files",
		"toolRows.connector.photos.search": "Searched your photos",
		"toolRows.connector.photos.search_by_date": "Looked at your photos by date",
		"toolRows.connector.photos.list_albums": "Looked at your albums",
		"toolRows.connector.photos.album": "Looked in an album",
		"toolRows.connector.photos.list_people":
			"Looked at the people in your photos",
		"toolRows.connector.photos.add_to_album":
			"Proposed adding photos to an album",
		"toolRows.connector.photos.other": "Used your photos",
		"toolRows.connector.media.watch_history": "Looked at what you watched",
		"toolRows.connector.media.libraries": "Looked at your libraries",
		"toolRows.connector.media.continue_watching":
			"Looked at what you're watching",
		"toolRows.connector.media.library_search": "Searched your library",
		"toolRows.connector.media.other": "Used your media",
		"toolRows.connector.location.last": "Looked at where you were last",
		"toolRows.connector.location.history": "Looked at your location history",
		"toolRows.connector.location.places": "Looked at your places",
		"toolRows.connector.location.distance": "Worked out a distance",
		"toolRows.connector.location.other": "Used your location",
		"toolRows.connector.contacts.lookup": "Looked up a contact",
		"toolRows.connector.contacts.group": "Looked at a contact group",
		"toolRows.connector.contacts.other": "Used your contacts",
		"toolRows.connector.repos.list_repos": "Looked at your repositories",
		"toolRows.connector.repos.read_file": "Read a file from a repository",
		"toolRows.connector.repos.list_issues": "Looked at issues",
		"toolRows.connector.repos.list_prs": "Looked at pull requests",
		"toolRows.connector.repos.list_commits": "Looked at commits",
		"toolRows.connector.repos.ci_status": "Checked the build status",
		"toolRows.connector.repos.search_code": "Searched the code",
		"toolRows.connector.repos.other": "Used your repositories",
		"toolRows.connector.tasks.list_tasks": "Looked at your tasks",
		"toolRows.connector.tasks.search_tasks": "Searched your tasks",
		"toolRows.connector.tasks.other": "Used your tasks",

		// research_web
		"toolRows.research_web.search_unavailable":
			"The search service didn't answer, so nothing came back this time.",
		"toolRows.research_web.nothing_found":
			"Nothing useful came up for this search.",
		"toolRows.research_web.reading_budget_used":
			"Alfy had already searched enough for this reply.",
		"toolRows.research_web.fallback": "The search couldn't be finished.",

		// fetch_url
		"toolRows.fetch_url.link_not_from_a_source":
			"Alfy opens only links you gave it or a search found, and this one was neither.",
		"toolRows.fetch_url.site_timeout": "The site didn't answer in time.",
		"toolRows.fetch_url.site_refused": "The site wouldn't let Alfy in.",
		"toolRows.fetch_url.page_not_found": "That page doesn't exist any more.",
		"toolRows.fetch_url.no_readable_text":
			"The page had no text Alfy could read.",
		"toolRows.fetch_url.reading_budget_used":
			"Alfy had already read enough pages for this reply.",
		"toolRows.fetch_url.read_unavailable":
			"The page reader didn't answer, so nothing was read.",
		"toolRows.fetch_url.fallback": "The page couldn't be read.",

		// image_search
		"toolRows.image_search.search_unavailable":
			"The picture search isn't available right now.",
		"toolRows.image_search.search_timeout":
			"The picture search didn't answer in time.",
		"toolRows.image_search.not_set_up": "The picture search isn't set up yet.",
		"toolRows.image_search.nothing_found":
			"No pictures came up for this search.",
		"toolRows.image_search.fallback":
			"The picture search couldn't be finished.",

		// memory_context
		"toolRows.memory_context.chat_out_of_reach":
			"Alfy can't look into that chat from here.",
		"toolRows.memory_context.nothing_found":
			"Nothing about this in your memory.",
		"toolRows.memory_context.memory_off":
			"Memory is turned off, so Alfy didn't look.",
		"toolRows.memory_context.memory_unavailable":
			"Alfy couldn't look in your memory this time.",

		// The nine account tools: each says its own account's name.
		"toolRows.connector.details_kept_local":
			"The cloud model got a summary only, so the details stayed on your server.",
		"toolRows.connector.details_withheld":
			"To keep them private, the cloud model wasn't given these details.",
		"toolRows.connector.too_large": "That's too large to open here.",

		"toolRows.connector.calendar.not_connected":
			"Calendar isn't connected yet. You can connect it in Settings › Connections.",
		"toolRows.connector.calendar.needs_reconnect":
			"Calendar needs to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.calendar.no_such_account":
			"There's no connected calendar by that name.",
		"toolRows.connector.calendar.account_unreachable":
			"Your calendar didn't answer, so Alfy couldn't look.",
		"toolRows.connector.calendar.writes_turned_off":
			"Changing your calendar is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.calendar.read_only_account":
			"This calendar can only be read, not changed.",
		"toolRows.connector.calendar.item_not_found":
			"Alfy couldn't find that event.",
		"toolRows.connector.calendar.not_supported": "This calendar can't do that.",
		"toolRows.connector.calendar.not_set_up": "Your calendar isn't set up yet.",
		"toolRows.connector.calendar.fallback":
			"Alfy couldn't use your calendar this time.",

		"toolRows.connector.contacts.not_connected":
			"Contacts aren't connected yet. You can connect them in Settings › Connections.",
		"toolRows.connector.contacts.needs_reconnect":
			"Contacts need to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.contacts.no_such_account":
			"There's no connected address book by that name.",
		"toolRows.connector.contacts.account_unreachable":
			"Your contacts didn't answer, so Alfy couldn't look.",
		"toolRows.connector.contacts.writes_turned_off":
			"Changing your contacts is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.contacts.read_only_account":
			"These contacts can only be read, not changed.",
		"toolRows.connector.contacts.item_not_found":
			"Alfy couldn't find that contact.",
		"toolRows.connector.contacts.not_supported":
			"These contacts can't do that.",
		"toolRows.connector.contacts.not_set_up":
			"Your contacts aren't set up yet.",
		"toolRows.connector.contacts.fallback":
			"Alfy couldn't use your contacts this time.",

		"toolRows.connector.email.not_connected":
			"Email isn't connected yet. You can connect it in Settings › Connections.",
		"toolRows.connector.email.needs_reconnect":
			"Email needs to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.email.no_such_account":
			"There's no connected email account by that name.",
		"toolRows.connector.email.account_unreachable":
			"Your email didn't answer, so Alfy couldn't look.",
		"toolRows.connector.email.writes_turned_off":
			"Changing your email is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.email.read_only_account":
			"This email account can only be read, not changed.",
		"toolRows.connector.email.item_not_found": "Alfy couldn't find that email.",
		"toolRows.connector.email.too_large":
			"That email is too large to open here.",
		"toolRows.connector.email.not_supported":
			"This email account can't do that.",
		"toolRows.connector.email.not_set_up": "Your email isn't set up yet.",
		"toolRows.connector.email.fallback":
			"Alfy couldn't use your email this time.",

		"toolRows.connector.files.not_connected":
			"Files aren't connected yet. You can connect them in Settings › Connections.",
		"toolRows.connector.files.needs_reconnect":
			"Files need to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.files.no_such_account":
			"There's no connected file storage by that name.",
		"toolRows.connector.files.account_unreachable":
			"Your file storage didn't answer, so Alfy couldn't look.",
		"toolRows.connector.files.writes_turned_off":
			"Changing your files is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.files.read_only_account":
			"These files can only be read, not changed.",
		"toolRows.connector.files.item_not_found": "Alfy couldn't find that file.",
		"toolRows.connector.files.too_large":
			"That file is too large to open here.",
		"toolRows.connector.files.not_supported":
			"This file storage can't do that.",
		"toolRows.connector.files.not_set_up": "Your files aren't set up yet.",
		"toolRows.connector.files.fallback":
			"Alfy couldn't use your files this time.",

		"toolRows.connector.location.not_connected":
			"Location isn't connected yet. You can connect it in Settings › Connections.",
		"toolRows.connector.location.needs_reconnect":
			"Location needs to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.location.no_such_account":
			"There's no connected location source by that name.",
		"toolRows.connector.location.account_unreachable":
			"Your location source didn't answer, so Alfy couldn't look.",
		"toolRows.connector.location.writes_turned_off":
			"Changing your location is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.location.read_only_account":
			"Your location can only be read, not changed.",
		"toolRows.connector.location.item_not_found":
			"Alfy couldn't find that place.",
		"toolRows.connector.location.not_supported":
			"Your location source can't do that.",
		"toolRows.connector.location.not_set_up": "Your home isn't set yet.",
		"toolRows.connector.location.fallback":
			"Alfy couldn't use your location this time.",

		"toolRows.connector.media.not_connected":
			"Media isn't connected yet. You can connect it in Settings › Connections.",
		"toolRows.connector.media.needs_reconnect":
			"Media needs to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.media.no_such_account":
			"There's no connected media server by that name.",
		"toolRows.connector.media.account_unreachable":
			"Your media server didn't answer, so Alfy couldn't look.",
		"toolRows.connector.media.writes_turned_off":
			"Changing your media is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.media.read_only_account":
			"This media server can only be read, not changed.",
		"toolRows.connector.media.item_not_found":
			"Alfy couldn't find that show or film.",
		"toolRows.connector.media.not_supported":
			"This media server can't do that.",
		"toolRows.connector.media.not_set_up": "Your media isn't set up yet.",
		"toolRows.connector.media.fallback":
			"Alfy couldn't use your media this time.",

		"toolRows.connector.photos.not_connected":
			"Photos aren't connected yet. You can connect them in Settings › Connections.",
		"toolRows.connector.photos.needs_reconnect":
			"Photos need to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.photos.no_such_account":
			"There's no connected photo library by that name.",
		"toolRows.connector.photos.account_unreachable":
			"Your photo library didn't answer, so Alfy couldn't look.",
		"toolRows.connector.photos.writes_turned_off":
			"Changing your photos is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.photos.read_only_account":
			"This photo library can only be read, not changed.",
		"toolRows.connector.photos.item_not_found":
			"Alfy couldn't find that photo.",
		"toolRows.connector.photos.too_large":
			"That photo is too large to open here.",
		"toolRows.connector.photos.not_supported":
			"This photo library can't do that.",
		"toolRows.connector.photos.not_set_up": "Your photos aren't set up yet.",
		"toolRows.connector.photos.fallback":
			"Alfy couldn't use your photos this time.",

		"toolRows.connector.repos.not_connected":
			"Repositories aren't connected yet. You can connect them in Settings › Connections.",
		"toolRows.connector.repos.needs_reconnect":
			"Repositories need to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.repos.no_such_account":
			"There's no connected code account by that name.",
		"toolRows.connector.repos.account_unreachable":
			"Your code account didn't answer, so Alfy couldn't look.",
		"toolRows.connector.repos.writes_turned_off":
			"Changing your repositories is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.repos.read_only_account":
			"This code account can only be read, not changed.",
		"toolRows.connector.repos.item_not_found":
			"Alfy couldn't find that repository, issue or pull request.",
		"toolRows.connector.repos.not_supported":
			"This code account can't do that.",
		"toolRows.connector.repos.not_set_up":
			"Your repositories aren't set up yet.",
		"toolRows.connector.repos.fallback":
			"Alfy couldn't use your repositories this time.",

		"toolRows.connector.tasks.not_connected":
			"Tasks aren't connected yet. You can connect them in Settings › Connections.",
		"toolRows.connector.tasks.needs_reconnect":
			"Tasks need to be connected again. You can do it in Settings › Connections.",
		"toolRows.connector.tasks.no_such_account":
			"There's no connected task list by that name.",
		"toolRows.connector.tasks.account_unreachable":
			"Your tasks didn't answer, so Alfy couldn't look.",
		"toolRows.connector.tasks.writes_turned_off":
			"Changing your tasks is turned off. You can turn it on in Settings › Connections.",
		"toolRows.connector.tasks.read_only_account":
			"These tasks can only be read, not changed.",
		"toolRows.connector.tasks.item_not_found": "Alfy couldn't find that task.",
		"toolRows.connector.tasks.not_supported": "This task list can't do that.",
		"toolRows.connector.tasks.not_set_up": "Your tasks aren't set up yet.",
		"toolRows.connector.tasks.fallback":
			"Alfy couldn't use your tasks this time.",

		// run_python
		"toolRows.run_python.timed_out": "The calculation ran out of time.",
		"toolRows.run_python.program_error":
			"The calculation stopped with an error.",
		"toolRows.run_python.sandbox_unavailable":
			"Calculations aren't available right now.",

		// map_route
		"toolRows.map_route.out_of_coverage":
			"Routes can only be planned where Alfy has maps.",
		"toolRows.map_route.no_route":
			"No route was found between these two places.",
		"toolRows.map_route.region_preparing":
			"The map for this area is still being prepared. Try again later.",
		"toolRows.map_route.multi_region":
			"This trip crosses map areas, which isn't possible yet.",
		"toolRows.map_route.region_unavailable":
			"The map for this area isn't available right now.",
		"toolRows.map_route.transit_unavailable":
			"There are no public transport times for this area.",
		"toolRows.map_route.place_not_found":
			"Alfy couldn't find “{place}” on the map.",
		"toolRows.map_route.geocoder_unavailable": "The map search didn't answer.",
		"toolRows.map_route.not_set_up": "Route planning isn't set up yet.",
		"toolRows.map_route.route_service_unavailable":
			"The route service didn't answer.",
		"toolRows.map_route.fallback": "The route couldn't be planned.",

		// use_skill
		"toolRows.use_skill.skill_turned_off":
			"This skill is turned off. You can turn it on in Settings.",
		"toolRows.use_skill.fallback": "The skill couldn't be loaded.",

		// suggest_instruction
		"toolRows.suggest_instruction.already_offered":
			"Alfy had already suggested this one.",
		"toolRows.suggest_instruction.not_offered":
			"The suggestion couldn't be offered.",

		// read_artifact and read_generated_file
		"toolRows.read.file_not_found":
			"Alfy couldn't find that file in this chat.",
		"toolRows.read.ambiguous": "Several files matched, so Alfy didn't guess.",
		"toolRows.read.fallback": "That couldn't be read.",

		// create_artifact
		"toolRows.create_artifact.reply_limit_reached":
			"Alfy has already made as many new items as one reply allows.",
		"toolRows.create_artifact.kind_not_creatable":
			"That kind of item can't be made here.",
		"toolRows.create_artifact.too_large":
			"That's too large to make as one item.",
		"toolRows.create_artifact.fallback": "This couldn't be made.",

		// edit_artifact: the first line says what changed, by the kind of item.
		"toolRows.edit_artifact.changed_since_read":
			"This changed since Alfy read it, so Alfy left it as it was.",
		"toolRows.edit_artifact.changed_since_read.document":
			"The document changed since Alfy read it, so Alfy left it as it was.",
		"toolRows.edit_artifact.changed_since_read.canvas":
			"The canvas changed since Alfy read it, so Alfy left it as it was.",
		"toolRows.edit_artifact.changed_since_read.app":
			"The app changed since Alfy read it, so Alfy left it as it was.",
		"toolRows.edit_artifact.changed_since_read.slides":
			"The slides changed since Alfy read them, so Alfy left them as they were.",
		"toolRows.edit_artifact.not_editable_as_text":
			"Files, pictures and videos can't be changed as text.",
		"toolRows.edit_artifact.kind_not_editable":
			"That kind of item can't be changed here.",
		"toolRows.edit_artifact.rebuild_limit_reached":
			"An app can be rebuilt twice in one reply.",
		"toolRows.edit_artifact.fallback": "The change couldn't be made.",

		// make_video (the sentences a picture already has live in toolActivity.pictureReason.*)
		"toolRows.make_video.not_asked_for":
			"Alfy wasn't sure you wanted a video, so it didn't make one yet.",
		"toolRows.make_video.explicit_request":
			"Explicit videos are not made here.",
		"toolRows.make_video.video_graph_rejected":
			"The video server refused this request.",
		"toolRows.make_video.video_render_failed":
			"The video server couldn't make the clip.",
		"toolRows.make_video.video_render_timeout":
			"The clip took too long to make.",
		"toolRows.make_video.video_result_missing":
			"The video server lost the clip.",
		"toolRows.make_video.video_input_missing":
			"A picture the clip starts from is gone.",
		"toolRows.make_video.video_request_invalid":
			"The video request couldn't be read.",
		"toolRows.make_video.video_item_deleted":
			"The clip was deleted while it was being made.",
		"toolRows.make_video.video_media_failed":
			"The finished clip couldn't be saved.",
		"toolRows.make_video.video_artifact_failed":
			"The clip was made but couldn't be kept.",
		"toolRows.make_video.video_take_missing": "The clip's record went missing.",
		"toolRows.make_video.fallback": "The video couldn't be made.",

		// An Atlas report (its existing failure line, `atlas.failed`, is the fallback)
		"toolRows.atlas.atlas_worker_heartbeat_timeout":
			"The research stopped partway and couldn't be restarted.",
		"toolRows.atlas.atlas_v3_local_source_unavailable":
			"Atlas couldn't reach a source it needed.",
		"toolRows.atlas.atlas_v3_no_evidence":
			"Atlas found nothing it could rely on for this question.",
		"toolRows.atlas.atlas_v3_no_verdict": "Atlas couldn't reach a conclusion.",
		"toolRows.atlas.atlas_v3_no_sections": "Atlas couldn't write the report.",
	},
	hu: {
		"toolRows.shared.stopped": "Ezt leállítottad, mielőtt befejeződött.",
		"toolRows.shared.timed_out":
			"Ez túl sokáig tartott, ezért Alfy nem várt tovább.",
		"toolRows.shared.out_of_time":
			"A válaszra szánt idő lejárt, ezért Alfy itt abbahagyta.",
		"toolRows.shared.request_adjusted": "Alfy pontosította a kérést.",
		"toolRows.shared.item_not_found": "Ez az elem már nincs meg.",
		"toolRows.generic.fallback": "Ezt a lépést nem sikerült befejezni.",

		"toolRows.meta.nothingFound": "nincs találat",
		"toolRows.meta.pictures": "{count} kép",
		"toolRows.meta.pastChats": "{count} korábbi beszélgetés",
		"toolRows.more": "és még {count}",

		"toolRows.verb.didntOpen": "Nem nyitotta meg:",
		"toolRows.verb.lookedThrough": "Átnézve:",
		"toolRows.verb.noSkillCalled": "Nincs ilyen készség:",
		"toolRows.verb.suggestedInstruction": "Utasítást javasolt:",
		"toolRows.verb.leftAsItWas": "Változatlan maradt:",
		"toolRows.verb.adjustingRequest": "Kérés pontosítása",

		"toolRows.suffix.page": "· {number}. oldal",
		"toolRows.suffix.part": "· {number}. rész",

		"toolRows.unit.events": "{count} esemény",
		"toolRows.unit.messages": "{count} levél",
		"toolRows.unit.found": "{count} találat",
		"toolRows.object.notConnected": "nincs csatlakoztatva",

		"toolRows.placeholder.untitledEvent": "Névtelen esemény",
		"toolRows.placeholder.noSubject": "Nincs tárgy",
		"toolRows.placeholder.photo": "Fotó",
		"toolRows.placeholder.placeAt": "Egy hely, {time}",
		"toolRows.placeholder.unnamedContact": "Névtelen névjegy",
		"toolRows.placeholder.watchedItem": "Megnézett cím",

		"toolRows.connector.calendar.list_events": "Megnézte az eseményeidet",
		"toolRows.connector.calendar.list_calendars": "Megnézte a naptáraidat",
		"toolRows.connector.calendar.check_availability": "Megnézte, mikor érsz rá",
		"toolRows.connector.calendar.create_event": "Új eseményt javasolt",
		"toolRows.connector.calendar.update_event":
			"Egy esemény módosítását javasolta",
		"toolRows.connector.calendar.delete_event":
			"Egy esemény törlését javasolta",
		"toolRows.connector.calendar.other": "Használta a naptáradat",
		"toolRows.connector.email.recent": "Megnézte a beérkezett leveleidet",
		"toolRows.connector.email.search": "Keresett a leveleidben",
		"toolRows.connector.email.count": "Megszámolta a leveleidet",
		"toolRows.connector.email.read": "Elolvasott egy levelet",
		"toolRows.connector.email.list_folders": "Megnézte a levelezőmappáidat",
		"toolRows.connector.email.send": "Levél küldését javasolta",
		"toolRows.connector.email.trash": "Egy levél kukába helyezését javasolta",
		"toolRows.connector.email.flag": "Egy levél megjelölését javasolta",
		"toolRows.connector.email.other": "Használta a levelezésedet",
		"toolRows.connector.files.list": "Megnézett egy mappát",
		"toolRows.connector.files.search": "Keresett a fájljaid között",
		"toolRows.connector.files.read": "Megnyitott egy fájlt",
		"toolRows.connector.files.save": "Egy fájl mentését javasolta",
		"toolRows.connector.files.move": "Egy fájl áthelyezését javasolta",
		"toolRows.connector.files.delete": "Egy fájl törlését javasolta",
		"toolRows.connector.files.create_folder": "Új mappát javasolt",
		"toolRows.connector.files.share_link": "Megosztási linket javasolt",
		"toolRows.connector.files.other": "Használta a fájljaidat",
		"toolRows.connector.photos.search": "Keresett a fotóid között",
		"toolRows.connector.photos.search_by_date":
			"Megnézte a fotóidat dátum szerint",
		"toolRows.connector.photos.list_albums": "Megnézte az albumaidat",
		"toolRows.connector.photos.album": "Megnézett egy albumot",
		"toolRows.connector.photos.list_people": "Megnézte, kik vannak a fotóidon",
		"toolRows.connector.photos.add_to_album":
			"Fotók hozzáadását javasolta egy albumhoz",
		"toolRows.connector.photos.other": "Használta a fotóidat",
		"toolRows.connector.media.watch_history": "Megnézte, mit néztél",
		"toolRows.connector.media.libraries": "Megnézte a médiatáraidat",
		"toolRows.connector.media.continue_watching": "Megnézte, mit nézel éppen",
		"toolRows.connector.media.library_search": "Keresett a médiatáradban",
		"toolRows.connector.media.other": "Használta a médiádat",
		"toolRows.connector.location.last": "Megnézte, hol voltál utoljára",
		"toolRows.connector.location.history": "Megnézte a helyelőzményeidet",
		"toolRows.connector.location.places": "Megnézte a helyeidet",
		"toolRows.connector.location.distance": "Kiszámolt egy távolságot",
		"toolRows.connector.location.other": "Használta a helyadataidat",
		"toolRows.connector.contacts.lookup": "Rákeresett egy névjegyre",
		"toolRows.connector.contacts.group": "Megnézett egy névjegycsoportot",
		"toolRows.connector.contacts.other": "Használta a névjegyeidet",
		"toolRows.connector.repos.list_repos": "Megnézte a kódtáraidat",
		"toolRows.connector.repos.read_file": "Elolvasott egy fájlt egy kódtárból",
		"toolRows.connector.repos.list_issues": "Megnézte a hibajegyeket",
		"toolRows.connector.repos.list_prs": "Megnézte a pull requesteket",
		"toolRows.connector.repos.list_commits": "Megnézte a commitokat",
		"toolRows.connector.repos.ci_status": "Megnézte a build állapotát",
		"toolRows.connector.repos.search_code": "Keresett a kódban",
		"toolRows.connector.repos.other": "Használta a kódtáraidat",
		"toolRows.connector.tasks.list_tasks": "Megnézte a teendőidet",
		"toolRows.connector.tasks.search_tasks": "Keresett a teendőid között",
		"toolRows.connector.tasks.other": "Használta a teendőidet",

		// research_web
		"toolRows.research_web.search_unavailable":
			"A keresőszolgáltatás nem válaszolt, ezért most nem jött eredmény.",
		"toolRows.research_web.nothing_found":
			"Ehhez a kereséshez nem jött hasznos találat.",
		"toolRows.research_web.reading_budget_used":
			"Alfy ehhez a válaszhoz már eleget keresett.",
		"toolRows.research_web.fallback": "A keresést nem sikerült befejezni.",

		// fetch_url
		"toolRows.fetch_url.link_not_from_a_source":
			"Alfy csak a tőled kapott vagy keresésben talált linkeket nyitja meg, ez pedig egyik sem volt.",
		"toolRows.fetch_url.site_timeout": "Az oldal nem válaszolt időben.",
		"toolRows.fetch_url.site_refused": "Az oldal nem engedte be Alfyt.",
		"toolRows.fetch_url.page_not_found": "Ez az oldal már nem létezik.",
		"toolRows.fetch_url.no_readable_text":
			"Az oldalon nem volt olvasható szöveg.",
		"toolRows.fetch_url.reading_budget_used":
			"Alfy ehhez a válaszhoz már elég oldalt elolvasott.",
		"toolRows.fetch_url.read_unavailable":
			"Az oldalolvasó nem válaszolt, ezért semmit nem olvasott el.",
		"toolRows.fetch_url.fallback": "Az oldalt nem sikerült elolvasni.",

		// image_search
		"toolRows.image_search.search_unavailable":
			"A képkeresés most nem érhető el.",
		"toolRows.image_search.search_timeout":
			"A képkeresés nem válaszolt időben.",
		"toolRows.image_search.not_set_up": "A képkeresés még nincs beállítva.",
		"toolRows.image_search.nothing_found": "Ehhez a kereséshez nem jött kép.",
		"toolRows.image_search.fallback": "A képkeresést nem sikerült befejezni.",

		// memory_context
		"toolRows.memory_context.chat_out_of_reach":
			"Abba a beszélgetésbe Alfy innen nem láthat bele.",
		"toolRows.memory_context.nothing_found":
			"Erről nincs semmi az emlékeid között.",
		"toolRows.memory_context.memory_off":
			"A memória ki van kapcsolva, ezért Alfy nem nézett utána.",
		"toolRows.memory_context.memory_unavailable":
			"Alfy most nem tudott az emlékeid között keresni.",

		// The nine account tools
		"toolRows.connector.details_kept_local":
			"A felhős modell csak összefoglalót kapott, így a részletek a saját szervereden maradtak.",
		"toolRows.connector.details_withheld":
			"Az adatvédelem miatt a felhős modell nem kapta meg ezeket a részleteket.",
		"toolRows.connector.too_large": "Ez túl nagy ahhoz, hogy itt megnyíljon.",

		"toolRows.connector.calendar.not_connected":
			"A naptár még nincs csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod.",
		"toolRows.connector.calendar.needs_reconnect":
			"A naptárt újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.calendar.no_such_account":
			"Nincs ilyen nevű csatlakoztatott naptár.",
		"toolRows.connector.calendar.account_unreachable":
			"A naptár nem válaszolt, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.calendar.writes_turned_off":
			"A naptár módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.calendar.read_only_account":
			"Ez a naptár csak olvasható, nem módosítható.",
		"toolRows.connector.calendar.item_not_found":
			"Alfy nem találta ezt az eseményt.",
		"toolRows.connector.calendar.not_supported": "Ez a naptár erre nem képes.",
		"toolRows.connector.calendar.not_set_up": "A naptárad még nincs beállítva.",
		"toolRows.connector.calendar.fallback":
			"Alfy most nem tudta használni a naptáradat.",

		"toolRows.connector.contacts.not_connected":
			"A névjegyek még nincsenek csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod őket.",
		"toolRows.connector.contacts.needs_reconnect":
			"A névjegyeket újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.contacts.no_such_account":
			"Nincs ilyen nevű csatlakoztatott névjegyzék.",
		"toolRows.connector.contacts.account_unreachable":
			"A névjegyek nem válaszoltak, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.contacts.writes_turned_off":
			"A névjegyek módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.contacts.read_only_account":
			"Ezek a névjegyek csak olvashatók, nem módosíthatók.",
		"toolRows.connector.contacts.item_not_found":
			"Alfy nem találta ezt a névjegyet.",
		"toolRows.connector.contacts.not_supported":
			"A névjegyek erre nem képesek.",
		"toolRows.connector.contacts.not_set_up":
			"A névjegyeid még nincsenek beállítva.",
		"toolRows.connector.contacts.fallback":
			"Alfy most nem tudta használni a névjegyeidet.",

		"toolRows.connector.email.not_connected":
			"A levelezés még nincs csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod.",
		"toolRows.connector.email.needs_reconnect":
			"A levelezést újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.email.no_such_account":
			"Nincs ilyen nevű csatlakoztatott levelezés.",
		"toolRows.connector.email.account_unreachable":
			"A levelezés nem válaszolt, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.email.writes_turned_off":
			"A levelezés módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.email.read_only_account":
			"Ez a levelezés csak olvasható, nem módosítható.",
		"toolRows.connector.email.item_not_found":
			"Alfy nem találta ezt a levelet.",
		"toolRows.connector.email.too_large":
			"Ez a levél túl nagy ahhoz, hogy itt megnyíljon.",
		"toolRows.connector.email.not_supported": "Ez a levelezés erre nem képes.",
		"toolRows.connector.email.not_set_up": "A levelezésed még nincs beállítva.",
		"toolRows.connector.email.fallback":
			"Alfy most nem tudta használni a levelezésedet.",

		"toolRows.connector.files.not_connected":
			"A fájlok még nincsenek csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod őket.",
		"toolRows.connector.files.needs_reconnect":
			"A fájlokat újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.files.no_such_account":
			"Nincs ilyen nevű csatlakoztatott tárhely.",
		"toolRows.connector.files.account_unreachable":
			"A tárhely nem válaszolt, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.files.writes_turned_off":
			"A fájlok módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.files.read_only_account":
			"Ezek a fájlok csak olvashatók, nem módosíthatók.",
		"toolRows.connector.files.item_not_found": "Alfy nem találta ezt a fájlt.",
		"toolRows.connector.files.too_large":
			"Ez a fájl túl nagy ahhoz, hogy itt megnyíljon.",
		"toolRows.connector.files.not_supported": "Ez a tárhely erre nem képes.",
		"toolRows.connector.files.not_set_up":
			"A fájljaid még nincsenek beállítva.",
		"toolRows.connector.files.fallback":
			"Alfy most nem tudta használni a fájljaidat.",

		"toolRows.connector.location.not_connected":
			"A helyadatok még nincsenek csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod őket.",
		"toolRows.connector.location.needs_reconnect":
			"A helyadatokat újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.location.no_such_account":
			"Nincs ilyen nevű csatlakoztatott helyforrás.",
		"toolRows.connector.location.account_unreachable":
			"A helyforrás nem válaszolt, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.location.writes_turned_off":
			"A helyadatok módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.location.read_only_account":
			"A helyadataid csak olvashatók, nem módosíthatók.",
		"toolRows.connector.location.item_not_found":
			"Alfy nem találta ezt a helyet.",
		"toolRows.connector.location.not_supported": "A helyforrás erre nem képes.",
		"toolRows.connector.location.not_set_up": "Az otthonod még nincs megadva.",
		"toolRows.connector.location.fallback":
			"Alfy most nem tudta használni a helyadataidat.",

		"toolRows.connector.media.not_connected":
			"A média még nincs csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod.",
		"toolRows.connector.media.needs_reconnect":
			"A médiát újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.media.no_such_account":
			"Nincs ilyen nevű csatlakoztatott médiaszerver.",
		"toolRows.connector.media.account_unreachable":
			"A médiaszerver nem válaszolt, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.media.writes_turned_off":
			"A média módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.media.read_only_account":
			"Ez a médiaszerver csak olvasható, nem módosítható.",
		"toolRows.connector.media.item_not_found":
			"Alfy nem találta ezt a sorozatot vagy filmet.",
		"toolRows.connector.media.not_supported":
			"Ez a médiaszerver erre nem képes.",
		"toolRows.connector.media.not_set_up": "A médiád még nincs beállítva.",
		"toolRows.connector.media.fallback":
			"Alfy most nem tudta használni a médiádat.",

		"toolRows.connector.photos.not_connected":
			"A fotók még nincsenek csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod őket.",
		"toolRows.connector.photos.needs_reconnect":
			"A fotókat újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.photos.no_such_account":
			"Nincs ilyen nevű csatlakoztatott fotótár.",
		"toolRows.connector.photos.account_unreachable":
			"A fotótár nem válaszolt, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.photos.writes_turned_off":
			"A fotók módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.photos.read_only_account":
			"Ez a fotótár csak olvasható, nem módosítható.",
		"toolRows.connector.photos.item_not_found": "Alfy nem találta ezt a fotót.",
		"toolRows.connector.photos.too_large":
			"Ez a fotó túl nagy ahhoz, hogy itt megnyíljon.",
		"toolRows.connector.photos.not_supported": "Ez a fotótár erre nem képes.",
		"toolRows.connector.photos.not_set_up": "A fotóid még nincsenek beállítva.",
		"toolRows.connector.photos.fallback":
			"Alfy most nem tudta használni a fotóidat.",

		"toolRows.connector.repos.not_connected":
			"A kódtárak még nincsenek csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod őket.",
		"toolRows.connector.repos.needs_reconnect":
			"A kódtárakat újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.repos.no_such_account":
			"Nincs ilyen nevű csatlakoztatott kódtár.",
		"toolRows.connector.repos.account_unreachable":
			"A kódtár nem válaszolt, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.repos.writes_turned_off":
			"A kódtárak módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.repos.read_only_account":
			"Ez a kódtár csak olvasható, nem módosítható.",
		"toolRows.connector.repos.item_not_found":
			"Alfy nem találta ezt a kódtárat, hibajegyet vagy pull requestet.",
		"toolRows.connector.repos.not_supported": "Ez a kódtár erre nem képes.",
		"toolRows.connector.repos.not_set_up":
			"A kódtáraid még nincsenek beállítva.",
		"toolRows.connector.repos.fallback":
			"Alfy most nem tudta használni a kódtáraidat.",

		"toolRows.connector.tasks.not_connected":
			"A teendők még nincsenek csatlakoztatva. A Beállítások › Kapcsolatok alatt csatlakoztathatod őket.",
		"toolRows.connector.tasks.needs_reconnect":
			"A teendőket újra csatlakoztatni kell. A Beállítások › Kapcsolatok alatt megteheted.",
		"toolRows.connector.tasks.no_such_account":
			"Nincs ilyen nevű csatlakoztatott teendőlista.",
		"toolRows.connector.tasks.account_unreachable":
			"A teendők nem válaszoltak, ezért Alfy nem tudott belenézni.",
		"toolRows.connector.tasks.writes_turned_off":
			"A teendők módosítása ki van kapcsolva. A Beállítások › Kapcsolatok alatt bekapcsolhatod.",
		"toolRows.connector.tasks.read_only_account":
			"Ezek a teendők csak olvashatók, nem módosíthatók.",
		"toolRows.connector.tasks.item_not_found":
			"Alfy nem találta ezt a teendőt.",
		"toolRows.connector.tasks.not_supported":
			"Ez a teendőlista erre nem képes.",
		"toolRows.connector.tasks.not_set_up":
			"A teendőid még nincsenek beállítva.",
		"toolRows.connector.tasks.fallback":
			"Alfy most nem tudta használni a teendőidet.",

		// run_python
		"toolRows.run_python.timed_out": "A számítás kifutott az időből.",
		"toolRows.run_python.program_error": "A számítás hibával leállt.",
		"toolRows.run_python.sandbox_unavailable": "A számolás most nem érhető el.",

		// map_route
		"toolRows.map_route.out_of_coverage":
			"Útvonalat csak ott lehet tervezni, ahol Alfynak van térképe.",
		"toolRows.map_route.no_route": "Nem található útvonal a két hely között.",
		"toolRows.map_route.region_preparing":
			"Ennek a területnek a térképe még készül. Próbáld újra később.",
		"toolRows.map_route.multi_region":
			"Ez az út több térképterületen halad át, ez még nem lehetséges.",
		"toolRows.map_route.region_unavailable":
			"Ennek a területnek a térképe most nem érhető el.",
		"toolRows.map_route.transit_unavailable":
			"Ehhez a területhez nincs tömegközlekedési menetrend.",
		"toolRows.map_route.place_not_found":
			"Alfy nem találta meg a térképen: „{place}”.",
		"toolRows.map_route.geocoder_unavailable":
			"A térképes kereső nem válaszolt.",
		"toolRows.map_route.not_set_up": "Az útvonaltervezés még nincs beállítva.",
		"toolRows.map_route.route_service_unavailable":
			"Az útvonaltervező nem válaszolt.",
		"toolRows.map_route.fallback": "Az útvonalat nem sikerült megtervezni.",

		// use_skill
		"toolRows.use_skill.skill_turned_off":
			"Ez a készség ki van kapcsolva. A Beállításokban bekapcsolhatod.",
		"toolRows.use_skill.fallback": "A készséget nem sikerült betölteni.",

		// suggest_instruction
		"toolRows.suggest_instruction.already_offered": "Alfy ezt már javasolta.",
		"toolRows.suggest_instruction.not_offered":
			"A javaslatot nem lehetett felajánlani.",

		// read_artifact and read_generated_file
		"toolRows.read.file_not_found":
			"Alfy nem találta ezt a fájlt ebben a beszélgetésben.",
		"toolRows.read.ambiguous":
			"Több fájl is egyezett, ezért Alfy nem találgatott.",
		"toolRows.read.fallback": "Ezt nem sikerült elolvasni.",

		// create_artifact
		"toolRows.create_artifact.reply_limit_reached":
			"Alfy ebben a válaszban már annyi új elemet készített, amennyit lehet.",
		"toolRows.create_artifact.kind_not_creatable":
			"Ilyen elemet itt nem lehet készíteni.",
		"toolRows.create_artifact.too_large":
			"Ez túl nagy ahhoz, hogy egy elemként elkészüljön.",
		"toolRows.create_artifact.fallback": "Ezt nem sikerült elkészíteni.",

		// edit_artifact
		"toolRows.edit_artifact.changed_since_read":
			"Ez megváltozott, mióta Alfy elolvasta, ezért Alfy nem nyúlt hozzá.",
		"toolRows.edit_artifact.changed_since_read.document":
			"A dokumentum megváltozott, mióta Alfy elolvasta, ezért Alfy nem nyúlt hozzá.",
		"toolRows.edit_artifact.changed_since_read.canvas":
			"A tábla megváltozott, mióta Alfy elolvasta, ezért Alfy nem nyúlt hozzá.",
		"toolRows.edit_artifact.changed_since_read.app":
			"Az alkalmazás megváltozott, mióta Alfy elolvasta, ezért Alfy nem nyúlt hozzá.",
		"toolRows.edit_artifact.changed_since_read.slides":
			"A diasor megváltozott, mióta Alfy elolvasta, ezért Alfy nem nyúlt hozzá.",
		"toolRows.edit_artifact.not_editable_as_text":
			"Fájlt, képet és videót nem lehet szövegként módosítani.",
		"toolRows.edit_artifact.kind_not_editable":
			"Ilyen elemet itt nem lehet módosítani.",
		"toolRows.edit_artifact.rebuild_limit_reached":
			"Egy alkalmazás egy válaszban kétszer építhető újra.",
		"toolRows.edit_artifact.fallback": "A módosítást nem sikerült elvégezni.",

		// make_video
		"toolRows.make_video.not_asked_for":
			"Alfy nem volt biztos benne, hogy videót szeretnél, ezért még nem készített.",
		"toolRows.make_video.explicit_request":
			"Szexuális tartalmú videók itt nem készülnek.",
		"toolRows.make_video.video_graph_rejected":
			"A videókészítő elutasította a kérést.",
		"toolRows.make_video.video_render_failed":
			"A videókészítő nem tudta elkészíteni a klipet.",
		"toolRows.make_video.video_render_timeout": "A klip túl sokáig készült.",
		"toolRows.make_video.video_result_missing":
			"A videókészítő elvesztette a klipet.",
		"toolRows.make_video.video_input_missing":
			"Egy kép, amelyből a klip indul, már nincs meg.",
		"toolRows.make_video.video_request_invalid": "A videókérés nem olvasható.",
		"toolRows.make_video.video_item_deleted":
			"A klipet készítés közben törölték.",
		"toolRows.make_video.video_media_failed":
			"Az elkészült klipet nem sikerült elmenteni.",
		"toolRows.make_video.video_artifact_failed":
			"A klip elkészült, de nem sikerült megtartani.",
		"toolRows.make_video.video_take_missing": "A klip adatai elvesztek.",
		"toolRows.make_video.fallback": "A videó nem készíthető el.",

		// Atlas
		"toolRows.atlas.atlas_worker_heartbeat_timeout":
			"A kutatás félúton leállt, és nem sikerült újraindítani.",
		"toolRows.atlas.atlas_v3_local_source_unavailable":
			"Az Atlas nem érte el az egyik szükséges forrást.",
		"toolRows.atlas.atlas_v3_no_evidence":
			"Az Atlas nem talált erre a kérdésre megbízható forrást.",
		"toolRows.atlas.atlas_v3_no_verdict":
			"Az Atlas nem jutott következtetésre.",
		"toolRows.atlas.atlas_v3_no_sections":
			"Az Atlas nem tudta megírni a jelentést.",
	},
} as const;

export default toolRowsDict;
