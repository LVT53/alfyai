// Connections-related i18n strings (Issue 7.0 — foundation for the
// Connections management panels built in 7.1-7.5).

const connectionsDict = {
	en: {
		"connections.actions.connect": "Connect",
		"connections.actions.disconnect": "Disconnect",
		"connections.actions.reconnect": "Reconnect",
		"connections.actions.viewDetails": "View details",
		"connections.addConnection.title": "Add a connection",
		"connections.addConnection.groupProducts": "Products",
		"connections.addConnection.groupCustom": "Custom integrations",
		"connections.row.capabilitiesA11y": "Capabilities: {list}",
		"connections.googleSignIn.label": "Continue with Google",
		"connections.allowWrites.label": "Allow writes",
		"connections.allowWrites.warning":
			"Writing is off by default. When on, AlfyAI can modify this account only after you confirm each change.",
		"connections.capabilities.label": "Capabilities",
		"connections.capability.calendar": "Calendar",
		"connections.capability.contacts": "Contacts",
		"connections.capability.email": "Email",
		"connections.capability.files": "Files",
		"connections.capability.location": "Location",
		"connections.capability.media": "Media",
		"connections.capability.photos": "Photos",
		"connections.capability.repos": "Repositories",
		"connections.capability.tasks": "Tasks",
		"connections.defaultOn.help":
			"When on, AlfyAI can use this connection automatically without asking each time.",
		"connections.defaultOn.label": "Default on",
		"connections.disconnectConfirm.message":
			"AlfyAI will no longer be able to access {provider}. You can reconnect it later.",
		"connections.disconnectConfirm.title": "Disconnect {provider}?",
		"connections.empty": "No connections yet.",
		"connections.status.connected": "Connected",
		"connections.status.disconnected": "Disconnected",
		"connections.status.error": "Error",
		"connections.status.needsReauth": "Needs reauthorization",
		"connections.status.noDetail": "No additional details available.",
		"connections.subtitle":
			"Connect your accounts so AlfyAI can read and, if you allow it, write to them.",
		"connections.title": "Connections",
		"connections.writeAllowlist.addA11y": "Add folder",
		"connections.writeAllowlist.addPlaceholder": "/folder/path",
		"connections.writeAllowlist.confirmNote":
			"Writes to this connection are confirmed individually before they happen.",
		"connections.writeAllowlist.empty":
			"No folders added yet — writes default to /AlfyAI.",
		"connections.writeAllowlist.label": "Allowed folders",
		"connections.writeAllowlist.removeA11y": "Remove {path}",
		"connections.writeAllowlist.suggestionsA11y": "Folder suggestions",
		"connections.writeAllowlist.suggestionsLoading": "Loading folders…",

		// Issue 7.3 — connect wizard (ConnectWizardModal) + OAuth-return notice.
		"connections.wizard.titleConnect": "Connect {provider}",
		"connections.wizard.titleReconnect": "Reconnect {provider}",
		"connections.wizard.connecting": "Connecting…",
		"connections.wizard.genericError":
			"Something went wrong. Please try again.",
		"connections.wizard.selectAtLeastOne": "Select at least one capability.",
		"connections.wizard.back": "Back",

		"connections.wizard.oauth.intro":
			"Choose what AlfyAI can access, then continue to {provider} to grant permission.",
		"connections.wizard.oauth.continue": "Continue to {provider}",
		"connections.wizard.oauth.redirecting": "Redirecting to {provider}…",
		"connections.wizard.oauth.notConfigured":
			"{provider} connect isn't configured on this server yet. Ask your administrator to set it up.",

		"connections.wizard.nextcloud.serverUrlLabel": "Server URL",
		"connections.wizard.nextcloud.serverUrlPlaceholder": "cloud.example.com",
		"connections.wizard.nextcloud.help":
			"We'll open a new tab where you can log in to Nextcloud and approve AlfyAI.",
		"connections.wizard.nextcloud.waiting":
			"Waiting for you to approve in Nextcloud…",
		"connections.wizard.nextcloud.checkApproval": "I've approved",
		"connections.wizard.nextcloud.timeout":
			"This took too long — the login link may have expired. Please try again.",

		"connections.wizard.immich.serverUrlLabel": "Server URL",
		"connections.wizard.immich.serverUrlPlaceholder": "cloud.example.com",
		"connections.wizard.immich.emailLabel": "Email",
		"connections.wizard.immich.passwordLabel": "Password",
		"connections.wizard.immich.help":
			"Use the same email and password you use to log in to your Immich server.",

		"connections.wizard.plex.serverUrlLabel": "Server URL",
		"connections.wizard.plex.serverUrlPlaceholder": "plex.example.com",
		"connections.wizard.plex.tokenLabel": "Plex token",
		"connections.wizard.plex.help":
			"Find your token by signing in to Plex Web, opening any item's “Get Info” → “View XML”, and copying the X-Plex-Token value from the URL.",

		"connections.wizard.github.tokenLabel": "Personal access token",
		"connections.wizard.github.tokenPlaceholder": "ghp_... or github_pat_...",
		"connections.wizard.github.help":
			'Create a token at github.com → Settings → Developer settings → Personal access tokens. A fine-grained token with read-only "Contents", "Issues", and "Pull requests" repository permissions is enough, or a classic token with the "repo" scope (read access only is used).',
		"connections.wizard.github.generateLink":
			"Create one at github.com/settings/tokens",
		"connections.wizard.github.advanced": "Advanced: custom server (Gitea/GHE)",
		"connections.wizard.github.baseUrlLabel": "API base URL (optional)",
		"connections.wizard.github.baseUrlPlaceholder": "git.example.com/api/v1",
		"connections.wizard.github.baseUrlHelp":
			"Leave blank for github.com. Set this only to connect a self-hosted Gitea or GitHub Enterprise Server instead.",

		"connections.wizard.apple.appleIdLabel": "Apple ID",
		"connections.wizard.apple.appPasswordLabel": "App-specific password",
		"connections.wizard.apple.help":
			"Generate an app-specific password at appleid.apple.com and paste it here — your regular Apple ID password won't work.",
		"connections.wizard.apple.generateLink":
			"Generate one at appleid.apple.com",

		"connections.wizard.caldav.serverUrlLabel": "CalDAV/CardDAV server URL",
		"connections.wizard.caldav.serverUrlPlaceholder":
			"cloud.example.com/remote.php/dav",
		"connections.wizard.caldav.usernameLabel": "Username",
		"connections.wizard.caldav.appPasswordLabel": "App password",
		"connections.wizard.caldav.help":
			"Works with any standards-compliant CalDAV/CardDAV server (Nextcloud, Fastmail, mailbox.org, Baïkal, Radicale, …), for your calendar, contacts, and tasks — whichever of those your server supports. Use an app-specific password if your server supports one, rather than your normal account password.",

		"connections.wizard.email.emailLabel": "Email address",
		"connections.wizard.email.imapHostLabel": "IMAP server",
		"connections.wizard.email.imapPortLabel": "Port",
		"connections.wizard.email.imapSecureLabel": "Use SSL/TLS",
		"connections.wizard.email.passwordLabel": "App password",
		"connections.wizard.email.smtpHostLabel": "SMTP server (optional)",
		"connections.wizard.email.smtpPortLabel": "SMTP port (optional)",
		"connections.wizard.email.help":
			"For Gmail or iCloud, use an app password rather than your normal password.",

		// Issue R4 (ADR 0044 Decision 4) — step 1 of the Email wizard: choose
		// Alfy Email / Gmail / Other (IMAP) before showing a form.
		"connections.wizard.email.choosePath": "How is your mailbox hosted?",
		"connections.wizard.email.path.alfy.name": "Alfy Email",
		"connections.wizard.email.path.alfy.description":
			"Email hosted on AlfyAI's own server.",
		"connections.wizard.email.path.gmail.name": "Gmail",
		"connections.wizard.email.path.gmail.description": "Your Gmail account.",
		"connections.wizard.email.path.other.name": "Other (IMAP)",
		"connections.wizard.email.path.other.description": "Any other mailbox.",

		"connections.wizard.email.alfy.help":
			"For mailboxes hosted on AlfyAI's own server — just enter your email address and password.",
		"connections.wizard.email.alfy.passwordLabel": "Password",
		"connections.wizard.email.alfy.errorHint":
			"If this doesn't work, your domain's mail server may use a different address — try \"Other (IMAP)\" to enter it manually.",

		"connections.wizard.email.gmail.emailLabel": "Gmail address",
		"connections.wizard.email.gmail.help1":
			"Gmail needs IMAP turned on: in Gmail, go to Settings → Forwarding and POP/IMAP, and enable IMAP.",
		"connections.wizard.email.gmail.help2":
			"You'll also need an app password: go to myaccount.google.com → Security → App passwords (requires 2-Step Verification).",

		"connections.wizard.owntracks.help":
			"Pick which device is yours. AlfyAI will only ever read this device's location.",
		"connections.wizard.owntracks.notConfigured":
			"OwnTracks isn't configured on this server. Ask your administrator to set the OwnTracks Recorder URL.",
		"connections.wizard.owntracks.empty":
			"No devices found on the OwnTracks recorder yet.",
		"connections.wizard.owntracks.deviceOption": "{otUser} / {otDevice}",

		"connections.wizard.contacts.notAvailable":
			"Connecting Contacts directly isn't available yet — connect Google, Apple, or Nextcloud instead to bring in contacts.",

		// Task 10 — OwnTracks home location editor (ConnectionDetailModal),
		// owntracks-only. Setting this enables the "distance" tool action's
		// "how far am I from home" branch (ownTracksHomeReference).
		"connections.ownTracksHome.label": "Home location",
		"connections.ownTracksHome.help":
			"Saving your home coordinates lets AlfyAI answer “how far am I from home”.",
		"connections.ownTracksHome.latLabel": "Latitude",
		"connections.ownTracksHome.lonLabel": "Longitude",
		"connections.ownTracksHome.save": "Save",
		"connections.ownTracksHome.clear": "Clear",
		"connections.ownTracksHome.invalidLat":
			"Latitude must be between -90 and 90.",
		"connections.ownTracksHome.invalidLon":
			"Longitude must be between -180 and 180.",
		"connections.ownTracksHome.saveError": "Failed to save home location.",

		"connections.oauthReturn.success": "Connected to {provider}.",
		"connections.oauthReturn.error": "Couldn't connect: {reason}",
		"connections.oauthReturn.reason.google_oauth_denied":
			"You declined the Google permission request.",
		"connections.oauthReturn.reason.google_oauth_invalid_request":
			"Google's response was missing required information.",
		"connections.oauthReturn.reason.google_oauth_invalid_state":
			"Your session expired before Google could finish. Please try again.",
		"connections.oauthReturn.reason.google_oauth_state_mismatch":
			"This request didn't match your session. Please try again.",
		"connections.oauthReturn.reason.google_oauth_failed":
			"Google couldn't complete the connection. Please try again.",
		"connections.oauthReturn.reason.onedrive_oauth_denied":
			"You declined the Microsoft permission request.",
		"connections.oauthReturn.reason.onedrive_oauth_invalid_request":
			"Microsoft's response was missing required information.",
		"connections.oauthReturn.reason.onedrive_oauth_invalid_state":
			"Your session expired before Microsoft could finish. Please try again.",
		"connections.oauthReturn.reason.onedrive_oauth_state_mismatch":
			"This request didn't match your session. Please try again.",
		"connections.oauthReturn.reason.onedrive_oauth_failed":
			"Microsoft couldn't complete the connection. Please try again.",
		"connections.oauthReturn.reason.generic": "Please try again.",

		// Issue 7.4 — Option C (composer cloud-connector warn-once modal) +
		// Option A (settings "Private, on-device processing" local-distill toggle).
		"connections.cloudWarning.title": "Sending data to a cloud model",
		"connections.cloudWarning.description":
			"This chat model is a third-party cloud model. Data from your connected accounts (like calendar, email, or files) may be sent to it to answer your message. You can continue, or keep this data on this device with local mode.",
		"connections.cloudWarning.continue": "Continue",
		"connections.cloudWarning.enableLocalMode": "Turn on local mode",

		"connections.locality.title": "Private, on-device processing",
		"connections.locality.toggleLabel": "Keep connector data on this device",
		"connections.locality.help":
			"When on, a local model summarizes your connected-account data before any third-party cloud model sees it. This keeps raw data on-device but may reduce answer detail.",
		"connections.locality.fidelityNote":
			"Local summarization aims to preserve the details relevant to your question, though some nuance can be lost compared to sending the raw data.",

		// Issue 7.5 — inline write-confirm card (WriteConfirmCard.svelte). The
		// write's title/detail/warnings text itself comes straight from the
		// server (write-guard.ts's buildWritePreview) and is not localized
		// here — only this card's static chrome is.
		"connections.writeConfirm.eyebrow": "Pending write",
		"connections.writeConfirm.cardLabel": "Pending write: {title}",
		"connections.writeConfirm.confirm": "Confirm",
		"connections.writeConfirm.confirmA11y": "Confirm: {title}",
		"connections.writeConfirm.cancel": "Cancel",
		"connections.writeConfirm.cancelA11y": "Cancel: {title}",
		"connections.writeConfirm.busy": "Working…",
		"connections.writeConfirm.destructiveBadge": "Destructive",
		"connections.writeConfirm.notReversibleBadge": "Not reversible",
		"connections.writeConfirm.etag": "Confirmation ref: {etag}",
		"connections.writeConfirm.status.executing": "This write is being applied…",
		"connections.writeConfirm.status.executed": "Done — this was saved.",
		"connections.writeConfirm.status.cancelled":
			"Cancelled — this was not saved.",
		"connections.writeConfirm.status.failed":
			"This write failed and was not applied.",
		"connections.writeConfirm.confirmError": "Failed to confirm the write.",
		"connections.writeConfirm.cancelError": "Failed to cancel the write.",

		// ─────────────────────────────────────────────────────────────────
		// CONNECTIONS REDESIGN — everything below this line is new copy for
		// the redesigned Connections tab, its dialogs, its error states and
		// its chat surfaces. One visual grammar for every state (a coloured
		// dot, a word, a sentence saying what happened and when), plainer
		// words in place of the old jargon ("Needs sign-in again", not "Needs
		// reauthorization"), and a way out of every failure.
		//
		// The pre-redesign keys above are deliberately LEFT IN PLACE: the
		// status words in particular are still referenced by tests and by the
		// accessible labels of surfaces that have not been reworked.
		// ─────────────────────────────────────────────────────────────────

		// Status words — the one word in a row's status column.
		"connections.status.needsSignIn": "Needs sign-in again",
		"connections.status.unreachable": "Can't reach it",
		"connections.status.turnedOff": "Turned off",

		// Status sentences — the "what happened and when" line underneath.
		// Every one has a no-timestamp variant, because a connection that has
		// never been used (or never changed state) has no honest date to name.
		"connections.status.sentence.lastUsed": "Last used {when}.",
		"connections.status.sentence.readyNotUsedYet":
			"Connected on {when}. Not used yet.",
		"connections.status.sentence.needsSignInOn":
			"{provider} stopped accepting the saved permission on {when}.",
		"connections.status.sentence.needsSignIn":
			"{provider} stopped accepting the saved permission.",
		"connections.status.sentence.unreachableAt":
			"Alfy couldn't reach {provider} on {when}.",
		"connections.status.sentence.unreachable":
			"Alfy couldn't reach {provider}.",
		"connections.status.sentence.turnedOffOn": "You turned this off on {when}.",
		"connections.status.sentence.turnedOff": "This connection is turned off.",

		// Recovery actions — each names what it will actually do.
		"connections.actions.signInAgain": "Sign in again",
		"connections.actions.fixThis": "Fix this",
		"connections.actions.connectAgain": "Connect again",
		"connections.actions.details": "Details",
		"connections.actions.done": "Done",
		"connections.actions.askAgain": "Ask again",
		// The discovered-grant equivalent of "Ask again". Nothing was refused
		// for a CalDAV server that simply had no address books when we looked;
		// reconnecting re-runs the discovery, which is the only thing that can
		// find one added since.
		"connections.actions.lookAgain": "Look again",
		"connections.actions.tryAgain": "Try again",
		"connections.actions.dismiss": "Dismiss",
		"connections.actions.whatWentWrong": "What went wrong?",
		"connections.actions.manage": "Manage",
		"connections.actions.disconnectProvider": "Disconnect {provider}",
		"connections.actions.open": "Open",
		"connections.actions.openItNow": "Open it now",

		// The tab itself.
		"connections.yourConnections": "Your connections",
		"connections.accountCount":
			"{count} account{count, plural, one {} other {s}}",
		"connections.addConnection.setUpYourself": "Set one up yourself",
		"connections.addConnection.alreadyConnected": "Already connected",

		// One line per provider saying what it brings, so the add grid reads
		// as a choice rather than a row of logos.
		"connections.provider.nextcloud.blurb": "Your files and contacts",
		"connections.provider.immich.blurb": "Your photo library",
		"connections.provider.imap.blurb": "Read and draft your mail",
		"connections.provider.google.blurb": "Your calendar and contacts",
		"connections.provider.apple.blurb": "Your calendar and contacts",
		"connections.provider.plex.blurb": "Films and shows you own",
		"connections.provider.owntracks.blurb":
			"Where you are, from your own phone",
		"connections.provider.github.blurb": "Your repositories and issues",
		"connections.provider.onedrive.blurb": "Your files",
		"connections.provider.caldav.blurb":
			"Any standards-based calendar or address book",
		"connections.provider.contacts.blurb": "A CardDAV address book",

		// Capability chips on a row.
		"connections.chip.denied": "{capability} — not allowed",
		"connections.chip.writesFolders":
			"Writes to {count} folder{count, plural, one {} other {s}}",
		"connections.chip.writesDefaultFolder": "Writes to /AlfyAI",
		"connections.chip.writesConfirm": "Writes, with your OK",
		"connections.chip.writesDrafts": "Drafts, with your OK",

		// What each capability actually lets Alfy do — shown under its switch
		// in the detail dialog and next to its checkbox in the OAuth wizard.
		"connections.capabilityAbout.calendar":
			"Read your events so Alfy can answer questions about your week.",
		"connections.capabilityAbout.contacts":
			"Read names and addresses so Alfy can find people you mention.",
		"connections.capabilityAbout.email":
			"Read your mail so Alfy can answer questions about it.",
		"connections.capabilityAbout.files": "Read your files and folders.",
		"connections.capabilityAbout.location":
			"Read this one device's position. No other device is visible.",
		"connections.capabilityAbout.media": "Read your library.",
		"connections.capabilityAbout.photos": "Read your photo library.",
		"connections.capabilityAbout.repos": "Read your repositories and issues.",
		"connections.capabilityAbout.tasks": "Read your task lists.",
		// Plex calls its library films and shows, not "media".
		"connections.capability.mediaPlex": "Films and shows",

		// The privacy control, now the first thing on the page.
		"connections.locality.headline": "Keep connected data on this device",
		"connections.locality.summary":
			"A model on this machine summarises what your accounts return, so the full text never leaves.",
		"connections.locality.tooltip":
			"Summaries aim to keep the details your question needs. With this off, the cloud model you pick sees the calendar entries, files and mail your question touches.",
		"connections.locality.badgeOn": "On",
		"connections.locality.badgeOff": "Off",
		// A locality read that failed is not the same answer as "off". The
		// switch used to show "off" either way — a definite answer about where
		// this user's data goes, given when we had no answer at all.
		"connections.locality.badgeUnknown": "Unknown",
		"connections.locality.unknown":
			"We couldn't check where your connected data is processed. Nothing changed.",

		// Detail dialog.
		"connections.detail.whatAlfyMayUse": "What Alfy may use",
		"connections.detail.howItBehaves": "How it behaves",
		"connections.detail.useWithoutAsking": "Use it without asking",
		"connections.detail.useWithoutAskingSub":
			"Alfy reaches for {provider} on its own when a question needs it.",
		"connections.detail.useWithoutAskingHelp":
			"On, Alfy reaches for this account whenever a question needs it. Off, it only uses {provider} when you turn connections on for that message.",
		"connections.detail.letAlfyWrite": "Let Alfy write",
		"connections.detail.letAlfyWriteSub":
			"Off by default. Every change still needs your OK first.",
		"connections.detail.letAlfyWriteHelp":
			"Writing is off by default. When on, Alfy can change this account only after you confirm each change.",
		"connections.detail.writeConfirmNote":
			"Every change is confirmed individually before it happens.",
		"connections.detail.writeConfirmNoteCalendar":
			"Calendar changes only, and each one needs your OK.",
		"connections.detail.foldersLabel": "Folders Alfy may write to",
		"connections.detail.deniedSub":
			"You didn't allow this, so there is nothing to switch on.",
		"connections.detail.deniedSubDiscovered":
			"Your server doesn't offer this, so there is nothing to switch on.",
		"connections.detail.grantedOn": "You allowed this on {when}.",
		"connections.detail.readOnlyNote":
			"{provider} is read-only — Alfy can never change it.",
		"connections.detail.signInBanner":
			"{provider} stopped accepting the saved permission on {when}. Signing in again takes about twenty seconds.",
		"connections.detail.signInBannerNoDate":
			"{provider} stopped accepting the saved permission. Signing in again takes about twenty seconds.",
		"connections.detail.unreachableBanner":
			"Alfy couldn't reach {provider} on {when}.",
		"connections.detail.unreachableBannerNoDate":
			"Alfy couldn't reach {provider}.",
		"connections.detail.turnedOffBanner":
			"This connection is turned off. Connect it again to start using it.",
		"connections.detail.homeHeading": "Home",
		"connections.detail.homeIntro":
			"Lets Alfy answer “how far am I from home”. Coordinates stay on this server.",
		"connections.detail.technicalDetail": "Technical detail",
		"connections.ownTracksHome.saveHome": "Save home",

		// Disconnect confirmation — says what is lost and what is not.
		"connections.disconnectConfirm.body":
			"Alfy loses access to {what}. Nothing is deleted from {provider}, and you can connect it again later.",
		"connections.disconnectConfirm.bodyNoCapabilities":
			"Alfy loses access to this account. Nothing is deleted from {provider}, and you can connect it again later.",
		"connections.disconnectConfirm.foldersNoteOne":
			"The write folder you set is forgotten too.",
		"connections.disconnectConfirm.foldersNoteMany":
			"The {count} write folders you set are forgotten too.",

		// Error and recovery states.
		"connections.states.loadFailed.title": "We couldn't load your connections",
		"connections.states.loadFailed.body":
			"Something went wrong on this server — your accounts are still connected. Nothing was changed.",
		"connections.states.saveFailed.title": "That change didn't save",
		"connections.states.saveFailed.body":
			"{change} didn't reach the server, so nothing changed. Nothing else was touched.",
		"connections.states.saveFailed.capabilityOn":
			"Turning on {capability} for {provider}",
		"connections.states.saveFailed.capabilityOff":
			"Turning off {capability} for {provider}",
		"connections.states.saveFailed.defaultOnOn":
			"Turning on “Use it without asking” for {provider}",
		"connections.states.saveFailed.defaultOnOff":
			"Turning off “Use it without asking” for {provider}",
		"connections.states.saveFailed.writesOn":
			"Turning on “Let Alfy write” for {provider}",
		"connections.states.saveFailed.writesOff":
			"Turning off “Let Alfy write” for {provider}",
		"connections.states.saveFailed.folders":
			"Changing the write folders for {provider}",
		"connections.states.saveFailed.home":
			"Saving the home location for {provider}",
		"connections.states.saveFailed.disconnect": "Disconnecting {provider}",
		"connections.states.saveFailed.privacyOn":
			"Turning on on-device processing",
		"connections.states.saveFailed.privacyOff":
			"Turning off on-device processing",
		"connections.states.partialGrant.title":
			"You allowed {allowed}, but not {missing}",
		"connections.states.partialGrant.titleNoneAllowed":
			"{provider} didn't allow {missing}",
		"connections.states.partialGrant.body":
			"{provider} only granted part of what Alfy asked for, so {missing} stays off.",
		"connections.states.partialGrant.ask": "Ask for {missing}",
		"connections.states.partialGrant.keep": "Keep it as it is",
		"connections.states.popupBlocked.title":
			"Your browser blocked the {provider} tab",
		"connections.states.popupBlocked.body":
			"The sign-in page opens in a new tab. Allow pop-ups for this site, or open it here.",
		"connections.states.connecting.title": "Connecting {provider}",
		"connections.states.connecting.hint": "Usually about five seconds.",

		// Wizard — plainer words, and a real way out of the "ask your
		// administrator" dead end on a one-person server.
		"connections.wizard.oauth.subtitle":
			"Choose what Alfy may use. You approve it again on {provider}'s own page.",
		"connections.wizard.nextcloud.waitingTitle": "Waiting for you to approve",
		"connections.wizard.nextcloud.waitingBody":
			"We opened {provider} in a new tab. Approve there, then come back to this one.",
		"connections.wizard.nextcloud.expires":
			"The link expires in {minutes} minute{minutes, plural, one {} other {s}}",
		"connections.wizard.nextcloud.approved": "I've approved it",
		"connections.wizard.nextcloud.subtitle":
			"Enter the address of your Nextcloud, and we'll open it so you can approve Alfy there.",
		"connections.wizard.email.title": "Connect your mail",
		"connections.wizard.email.subtitle": "Where is your mailbox?",
		"connections.wizard.email.path.alfy.description2":
			"The mailbox hosted on this server.",
		"connections.wizard.email.path.gmail.description2": "Your Google mailbox.",
		"connections.wizard.email.path.other.name2": "Somewhere else",
		"connections.wizard.email.path.other.description2":
			"Any other mailbox. You will need its server address.",
		"connections.wizard.github.subtitle":
			"GitHub does not use a normal sign-in for this.",
		"connections.wizard.github.tokenLabel2": "Access token",
		"connections.wizard.github.tokenHelp":
			"A token is a long password you create on GitHub. You choose what it may see, and you can revoke it there at any time.",
		"connections.wizard.github.createOn": "Create one on GitHub",
		"connections.wizard.github.differentServer":
			"Use a different server (Gitea, GitHub Enterprise)",
		"connections.wizard.owntracks.subtitle":
			"Which of these phones is yours? Alfy will only ever read that one.",
		"connections.wizard.owntracks.useThisDevice": "Use this device",
		"connections.wizard.owntracks.lastSeen": "Last seen {when}",
		"connections.wizard.owntracks.onRecorderAs": "On the recorder as {otUser}",
		"connections.wizard.notSetUp.subtitle": "Not set up on this server yet.",
		"connections.wizard.notSetUp.bodyAdmin":
			"{provider} needs an app id and secret before anyone can connect it. You are the administrator of this server, so you can add them yourself.",
		"connections.wizard.notSetUp.bodyMember":
			"{provider} needs an app id and secret before anyone can connect it. Ask whoever runs this server to add them.",
		"connections.wizard.notSetUp.ownTracksAdmin":
			"OwnTracks needs the address of your recorder before anyone can connect it. You are the administrator of this server, so you can add it yourself.",
		"connections.wizard.notSetUp.ownTracksMember":
			"OwnTracks needs the address of your recorder before anyone can connect it. Ask whoever runs this server to add it.",
		"connections.wizard.notSetUp.trail":
			"Administration → System → Advanced → Integrations",
		"connections.wizard.apple.subtitle":
			"Apple needs a password made just for Alfy, not your usual one.",
		"connections.wizard.immich.subtitle":
			"Sign in the same way you sign in to your own Immich server.",
		"connections.wizard.plex.subtitle":
			"Plex uses a token instead of a password.",
		"connections.wizard.caldav.subtitle":
			"For any calendar or address book that speaks the standard protocol.",
		"connections.wizard.contacts.subtitle": "Not available on its own yet.",

		// Chat surfaces.
		"connections.chat.useMyConnections": "Use my connections",
		"connections.chat.accountsReady": "{ready} of {total} accounts are ready",
		"connections.chat.noAccounts": "No accounts connected yet",
		"connections.chat.needsAttention": "{provider} needs attention",
		"connections.chat.toggleLabel": "Connections · {count}",
		"connections.chat.cloudTitle": "This message would leave your machine",
		"connections.chat.cloudBody":
			"You picked {cloudModel}, which runs at {vendor}. Data from your connected accounts would be sent there to answer this.",
		"connections.chat.cloudBodyNoVendor":
			"You picked {cloudModel}, a cloud model. Data from your connected accounts would be sent there to answer this.",
		"connections.chat.cloudLocalRow": "{localModel}, on this machine",
		"connections.chat.cloudLocalRowGeneric": "A model on this machine",
		"connections.chat.cloudLocalNote": "nothing leaves",
		"connections.chat.cloudRemoteRow": "{cloudModel}, at {vendor}",
		"connections.chat.cloudRemoteRowNoVendor": "{cloudModel}, in the cloud",
		"connections.chat.cloudRemoteNote": "sees your data",
		"connections.chat.cloudKeepLocal": "Keep it on this machine",
		"connections.chat.cloudSend": "Send to {cloudModel}",
		"connections.chat.cloudSendGeneric": "Send it anyway",
		"connections.chat.cloudAskedOnce": "Asked once per conversation.",
	},
	hu: {
		"connections.actions.connect": "Csatlakoztatás",
		"connections.actions.disconnect": "Leválasztás",
		"connections.actions.reconnect": "Újracsatlakoztatás",
		"connections.actions.viewDetails": "Részletek megtekintése",
		"connections.addConnection.title": "Kapcsolat hozzáadása",
		"connections.addConnection.groupProducts": "Termékek",
		"connections.addConnection.groupCustom": "Egyéni integrációk",
		"connections.row.capabilitiesA11y": "Képességek: {list}",
		"connections.googleSignIn.label": "Csatlakozás Google-fiókkal",
		"connections.allowWrites.label": "Írás engedélyezése",
		"connections.allowWrites.warning":
			"Az írás alapértelmezetten ki van kapcsolva. Ha bekapcsolod, az AlfyAI csak a jóváhagyásod után módosíthatja ezt a fiókot, minden egyes változtatásnál.",
		"connections.capabilities.label": "Képességek",
		"connections.capability.calendar": "Naptár",
		"connections.capability.contacts": "Névjegyek",
		"connections.capability.email": "E-mail",
		"connections.capability.files": "Fájlok",
		"connections.capability.location": "Helymeghatározás",
		"connections.capability.media": "Média",
		"connections.capability.photos": "Fényképek",
		"connections.capability.repos": "Tárolók",
		"connections.capability.tasks": "Feladatok",
		"connections.defaultOn.help":
			"Ha bekapcsolod, az AlfyAI automatikusan használhatja ezt a kapcsolatot, anélkül hogy minden alkalommal rákérdezne.",
		"connections.defaultOn.label": "Alapértelmezetten bekapcsolva",
		"connections.disconnectConfirm.message":
			"Az AlfyAI a továbbiakban nem fog hozzáférni ehhez: {provider}. Később újra csatlakoztathatod.",
		"connections.disconnectConfirm.title": "Leválasztod ezt: {provider}?",
		"connections.empty": "Még nincs kapcsolat.",
		"connections.status.connected": "Csatlakoztatva",
		"connections.status.disconnected": "Leválasztva",
		"connections.status.error": "Hiba",
		"connections.status.needsReauth": "Újbóli hitelesítés szükséges",
		"connections.status.noDetail": "Nincs további részlet.",
		"connections.subtitle":
			"Csatlakoztasd a fiókjaidat, hogy az AlfyAI olvashassa őket, és ha engedélyezed, írhasson is beléjük.",
		"connections.title": "Kapcsolatok",
		"connections.writeAllowlist.addA11y": "Mappa hozzáadása",
		"connections.writeAllowlist.addPlaceholder": "/mappa/elérési út",
		"connections.writeAllowlist.confirmNote":
			"Az ehhez a kapcsolathoz tartozó írásokat egyenként jóvá kell hagynod, mielőtt megtörténnek.",
		"connections.writeAllowlist.empty":
			"Még nincs hozzáadott mappa — az írások alapértelmezetten ide kerülnek: /AlfyAI.",
		"connections.writeAllowlist.label": "Engedélyezett mappák",
		"connections.writeAllowlist.removeA11y": "{path} eltávolítása",
		"connections.writeAllowlist.suggestionsA11y": "Mappajavaslatok",
		"connections.writeAllowlist.suggestionsLoading": "Mappák betöltése…",

		// Issue 7.3 — connect wizard (ConnectWizardModal) + OAuth-return notice.
		"connections.wizard.titleConnect": "{provider} csatlakoztatása",
		"connections.wizard.titleReconnect": "{provider} újracsatlakoztatása",
		"connections.wizard.connecting": "Csatlakozás…",
		"connections.wizard.genericError": "Hiba történt. Kérjük, próbáld újra.",
		"connections.wizard.selectAtLeastOne": "Válassz legalább egy képességet.",
		"connections.wizard.back": "Vissza",

		"connections.wizard.oauth.intro":
			"Válaszd ki, mihez férhet hozzá az AlfyAI, majd folytasd a(z) {provider} szolgáltatásnál a hozzájárulás megadásához.",
		"connections.wizard.oauth.continue": "Folytatás itt: {provider}",
		"connections.wizard.oauth.redirecting": "Átirányítás ide: {provider}…",
		"connections.wizard.oauth.notConfigured":
			"A(z) {provider} csatlakozás még nincs beállítva ezen a szerveren. Kérd meg a rendszergazdát, hogy állítsa be.",

		"connections.wizard.nextcloud.serverUrlLabel": "Szerver URL",
		"connections.wizard.nextcloud.serverUrlPlaceholder": "felho.pelda.hu",
		"connections.wizard.nextcloud.help":
			"Nyitunk egy új lapot, ahol bejelentkezhetsz a Nextcloudba, és jóváhagyhatod az AlfyAI-t.",
		"connections.wizard.nextcloud.waiting":
			"Várakozás a jóváhagyásodra a Nextcloudban…",
		"connections.wizard.nextcloud.checkApproval": "Jóváhagytam",
		"connections.wizard.nextcloud.timeout":
			"Ez túl sokáig tartott — a bejelentkezési link lejárhatott. Kérjük, próbáld újra.",

		"connections.wizard.immich.serverUrlLabel": "Szerver URL",
		"connections.wizard.immich.serverUrlPlaceholder": "felho.pelda.hu",
		"connections.wizard.immich.emailLabel": "E-mail",
		"connections.wizard.immich.passwordLabel": "Jelszó",
		"connections.wizard.immich.help":
			"Add meg ugyanazt az e-mail-címet és jelszót, amellyel az Immich szerveredre bejelentkezel.",

		"connections.wizard.plex.serverUrlLabel": "Szerver URL",
		"connections.wizard.plex.serverUrlPlaceholder": "plex.pelda.hu",
		"connections.wizard.plex.tokenLabel": "Plex token",
		"connections.wizard.plex.help":
			"A tokenedet a Plex Web-be bejelentkezve találod: nyiss meg egy elemet, válaszd a „Get Info” → „View XML” lehetőséget, majd másold ki az URL-ből az X-Plex-Token értékét.",

		"connections.wizard.github.tokenLabel": "Személyes hozzáférési token",
		"connections.wizard.github.tokenPlaceholder": "ghp_... vagy github_pat_...",
		"connections.wizard.github.help":
			"Hozz létre egy tokent itt: github.com → Settings → Developer settings → Personal access tokens. Egy finomszemcsés (fine-grained) token, csak olvasási „Contents”, „Issues” és „Pull requests” repó-jogosultságokkal elég, vagy egy klasszikus token a „repo” hatókörrel (csak az olvasási hozzáférést használjuk).",
		"connections.wizard.github.generateLink":
			"Hozz létre egyet a github.com/settings/tokens oldalon",
		"connections.wizard.github.advanced":
			"Speciális: egyéni szerver (Gitea/GHE)",
		"connections.wizard.github.baseUrlLabel": "API alap URL (nem kötelező)",
		"connections.wizard.github.baseUrlPlaceholder": "git.pelda.hu/api/v1",
		"connections.wizard.github.baseUrlHelp":
			"Hagyd üresen a github.com-hoz. Csak akkor add meg, ha egy önhosztolt Gitea vagy GitHub Enterprise Server példányhoz szeretnél csatlakozni.",

		"connections.wizard.apple.appleIdLabel": "Apple ID",
		"connections.wizard.apple.appPasswordLabel": "Alkalmazásspecifikus jelszó",
		"connections.wizard.apple.help":
			"Készíts egy alkalmazásspecifikus jelszót az appleid.apple.com oldalon, és illeszd be ide — a szokásos Apple ID jelszavad nem fog működni.",
		"connections.wizard.apple.generateLink":
			"Készíts egyet az appleid.apple.com oldalon",

		"connections.wizard.caldav.serverUrlLabel": "CalDAV/CardDAV szerver URL",
		"connections.wizard.caldav.serverUrlPlaceholder":
			"felho.pelda.hu/remote.php/dav",
		"connections.wizard.caldav.usernameLabel": "Felhasználónév",
		"connections.wizard.caldav.appPasswordLabel": "Alkalmazásjelszó",
		"connections.wizard.caldav.help":
			"Bármely szabványos CalDAV/CardDAV szerverrel működik (Nextcloud, Fastmail, mailbox.org, Baïkal, Radicale, …), a naptáradhoz, névjegyeidhez és feladataidhoz — attól függően, hogy a szervered melyiket támogatja. Ha a szervered támogatja, használj alkalmazásspecifikus jelszót a szokásos fiókjelszavad helyett.",

		"connections.wizard.email.emailLabel": "E-mail-cím",
		"connections.wizard.email.imapHostLabel": "IMAP szerver",
		"connections.wizard.email.imapPortLabel": "Port",
		"connections.wizard.email.imapSecureLabel": "SSL/TLS használata",
		"connections.wizard.email.passwordLabel": "Alkalmazásjelszó",
		"connections.wizard.email.smtpHostLabel": "SMTP szerver (nem kötelező)",
		"connections.wizard.email.smtpPortLabel": "SMTP port (nem kötelező)",
		"connections.wizard.email.help":
			"Gmailhez vagy iCloudhoz a szokásos jelszó helyett használj alkalmazásjelszót.",

		// Issue R4 (ADR 0044 Decision 4) — az e-mail varázsló 1. lépése: Alfy
		// Email / Gmail / Egyéb (IMAP) kiválasztása az űrlap megjelenítése előtt.
		"connections.wizard.email.choosePath": "Hol üzemel a postafiókod?",
		"connections.wizard.email.path.alfy.name": "Alfy Email",
		"connections.wizard.email.path.alfy.description":
			"Az AlfyAI saját szerverén tárolt e-mail.",
		"connections.wizard.email.path.gmail.name": "Gmail",
		"connections.wizard.email.path.gmail.description": "A Gmail-fiókod.",
		"connections.wizard.email.path.other.name": "Egyéb (IMAP)",
		"connections.wizard.email.path.other.description": "Bármely más postafiók.",

		"connections.wizard.email.alfy.help":
			"Az AlfyAI saját szerverén tárolt postafiókokhoz — csak add meg az e-mail-címedet és a jelszavadat.",
		"connections.wizard.email.alfy.passwordLabel": "Jelszó",
		"connections.wizard.email.alfy.errorHint":
			"Ha ez nem működik, előfordulhat, hogy a domainod levelezőszervere másik címet használ — próbáld az „Egyéb (IMAP)” lehetőséget, és add meg kézzel.",

		"connections.wizard.email.gmail.emailLabel": "Gmail-cím",
		"connections.wizard.email.gmail.help1":
			"A Gmailhez be kell kapcsolnod az IMAP-ot: a Gmailben nyisd meg a Beállítások → Továbbítás és POP/IMAP menüt, és engedélyezd az IMAP-ot.",
		"connections.wizard.email.gmail.help2":
			"Emellett alkalmazásjelszóra is szükséged lesz: a myaccount.google.com oldalon a Biztonság → Alkalmazásjelszavak menüben hozhatsz létre egyet (ehhez kétlépcsős azonosítás szükséges).",

		"connections.wizard.owntracks.help":
			"Válaszd ki, melyik eszköz a tiéd. Az AlfyAI kizárólag ennek az eszköznek a helyadatait fogja tudni olvasni.",
		"connections.wizard.owntracks.notConfigured":
			"Az OwnTracks nincs beállítva ezen a szerveren. Kérd meg a rendszergazdát, hogy állítsa be az OwnTracks Recorder URL-t.",
		"connections.wizard.owntracks.empty":
			"Még nem található eszköz az OwnTracks rekorderen.",
		"connections.wizard.owntracks.deviceOption": "{otUser} / {otDevice}",

		"connections.wizard.contacts.notAvailable":
			"A Névjegyek közvetlen csatlakoztatása még nem elérhető — csatlakoztasd inkább a Google-t, az Apple-t vagy a Nextcloudot a névjegyek behozatalához.",

		// Task 10 — OwnTracks otthon-hely szerkesztő (ConnectionDetailModal),
		// csak owntracks esetén. A beállítása lehetővé teszi a „distance”
		// eszközművelet „milyen messze vagyok otthontól” ágát
		// (ownTracksHomeReference).
		"connections.ownTracksHome.label": "Otthoni helyzet",
		"connections.ownTracksHome.help":
			"Az otthoni koordináták mentésével az AlfyAI meg tudja válaszolni, hogy „milyen messze vagyok otthontól”.",
		"connections.ownTracksHome.latLabel": "Szélesség",
		"connections.ownTracksHome.lonLabel": "Hosszúság",
		"connections.ownTracksHome.save": "Mentés",
		"connections.ownTracksHome.clear": "Törlés",
		"connections.ownTracksHome.invalidLat":
			"A szélességnek -90 és 90 között kell lennie.",
		"connections.ownTracksHome.invalidLon":
			"A hosszúságnak -180 és 180 között kell lennie.",
		"connections.ownTracksHome.saveError":
			"Nem sikerült menteni az otthoni helyzetet.",

		"connections.oauthReturn.success": "Csatlakoztatva: {provider}.",
		"connections.oauthReturn.error": "Nem sikerült csatlakozni: {reason}",
		"connections.oauthReturn.reason.google_oauth_denied":
			"Elutasítottad a Google jogosultságkérését.",
		"connections.oauthReturn.reason.google_oauth_invalid_request":
			"A Google válaszából hiányoztak a szükséges adatok.",
		"connections.oauthReturn.reason.google_oauth_invalid_state":
			"A munkameneted lejárt, mielőtt a Google befejezhette volna. Kérjük, próbáld újra.",
		"connections.oauthReturn.reason.google_oauth_state_mismatch":
			"Ez a kérés nem egyezett a munkameneteddel. Kérjük, próbáld újra.",
		"connections.oauthReturn.reason.google_oauth_failed":
			"A Google nem tudta befejezni a csatlakozást. Kérjük, próbáld újra.",
		"connections.oauthReturn.reason.onedrive_oauth_denied":
			"Elutasítottad a Microsoft jogosultságkérését.",
		"connections.oauthReturn.reason.onedrive_oauth_invalid_request":
			"A Microsoft válaszából hiányoztak a szükséges adatok.",
		"connections.oauthReturn.reason.onedrive_oauth_invalid_state":
			"A munkameneted lejárt, mielőtt a Microsoft befejezhette volna. Kérjük, próbáld újra.",
		"connections.oauthReturn.reason.onedrive_oauth_state_mismatch":
			"Ez a kérés nem egyezett a munkameneteddel. Kérjük, próbáld újra.",
		"connections.oauthReturn.reason.onedrive_oauth_failed":
			"A Microsoft nem tudta befejezni a csatlakozást. Kérjük, próbáld újra.",
		"connections.oauthReturn.reason.generic": "Kérjük, próbáld újra.",

		// Issue 7.4 — Option C (composer cloud-connector warn-once modal) +
		// Option A (settings "Private, on-device processing" local-distill toggle).
		"connections.cloudWarning.title": "Adatküldés egy felhőmodellnek",
		"connections.cloudWarning.description":
			"Ez a csevegőmodell egy harmadik féltől származó felhőalapú modell. A csatlakoztatott fiókjaid adatai (például naptár, e-mail vagy fájlok) elküldődhetnek neki az üzeneted megválaszolásához. Folytathatod, vagy a helyi móddal ezeket az adatokat az eszközödön tarthatod.",
		"connections.cloudWarning.continue": "Folytatás",
		"connections.cloudWarning.enableLocalMode": "Helyi mód bekapcsolása",

		"connections.locality.title": "Privát, helyi feldolgozás",
		"connections.locality.toggleLabel":
			"Csatlakoztatott fiókjaid adatainak tartása ezen az eszközön",
		"connections.locality.help":
			"Ha bekapcsolod, egy helyi modell összegzi a csatlakoztatott fiókjaid adatait, mielőtt bármelyik harmadik féltől származó felhőalapú modell látná őket. Ez az eszközön tartja a nyers adatokat, de csökkentheti a válasz részletességét.",
		"connections.locality.fidelityNote":
			"A helyi összegzés a kérdésed szempontjából releváns részleteket próbálja megőrizni, bár a nyers adatküldéshez képest némi árnyaltság elveszhet.",

		// Issue 7.5 — inline write-confirm card (WriteConfirmCard.svelte).
		"connections.writeConfirm.eyebrow": "Függőben lévő írás",
		"connections.writeConfirm.cardLabel": "Függőben lévő írás: {title}",
		"connections.writeConfirm.confirm": "Jóváhagyás",
		"connections.writeConfirm.confirmA11y": "Jóváhagyás: {title}",
		"connections.writeConfirm.cancel": "Mégse",
		"connections.writeConfirm.cancelA11y": "Mégse: {title}",
		"connections.writeConfirm.busy": "Feldolgozás…",
		"connections.writeConfirm.destructiveBadge": "Visszavonhatatlan hatású",
		"connections.writeConfirm.notReversibleBadge": "Nem vonható vissza",
		"connections.writeConfirm.etag": "Visszaigazolási azonosító: {etag}",
		"connections.writeConfirm.status.executing":
			"Ez az írás most kerül végrehajtásra…",
		"connections.writeConfirm.status.executed": "Kész — ez elmentve.",
		"connections.writeConfirm.status.cancelled":
			"Megszakítva — ez nem lett elmentve.",
		"connections.writeConfirm.status.failed":
			"Ez az írás nem sikerült, és nem lett alkalmazva.",
		"connections.writeConfirm.confirmError":
			"Nem sikerült jóváhagyni az írást.",
		"connections.writeConfirm.cancelError":
			"Nem sikerült megszakítani az írást.",

		// ─────────────────────────────────────────────────────────────────
		// KAPCSOLATOK ÚJRATERVEZÉS — az alábbi kulcsok mind az újratervezett
		// Kapcsolatok fülhöz, párbeszédeihez, hibaállapotaihoz és
		// csevegőfelületeihez tartoznak. Egyetlen vizuális nyelvtan minden
		// állapotra (színes pötty, egy szó, és egy mondat arról, mi történt
		// és mikor), a régi szakzsargon helyett hétköznapi szavak, és minden
		// hibából vezet kiút.
		//
		// A fenti, újratervezés előtti kulcsok szándékosan MEGMARADNAK.
		// ─────────────────────────────────────────────────────────────────

		"connections.status.needsSignIn": "Újra be kell jelentkezned",
		"connections.status.unreachable": "Nem érhető el",
		"connections.status.turnedOff": "Kikapcsolva",

		"connections.status.sentence.lastUsed": "Utoljára használva: {when}.",
		"connections.status.sentence.readyNotUsedYet":
			"Csatlakoztatva ekkor: {when}. Még nem volt használatban.",
		"connections.status.sentence.needsSignInOn":
			"A(z) {provider} {when} óta nem fogadja el a mentett engedélyt.",
		"connections.status.sentence.needsSignIn":
			"A(z) {provider} már nem fogadja el a mentett engedélyt.",
		"connections.status.sentence.unreachableAt":
			"Az Alfy nem érte el a(z) {provider} szolgáltatást ekkor: {when}.",
		"connections.status.sentence.unreachable":
			"Az Alfy nem érte el a(z) {provider} szolgáltatást.",
		"connections.status.sentence.turnedOffOn":
			"Ezt te kapcsoltad ki ekkor: {when}.",
		"connections.status.sentence.turnedOff": "Ez a kapcsolat ki van kapcsolva.",

		"connections.actions.signInAgain": "Bejelentkezés újra",
		"connections.actions.fixThis": "Javítsuk meg",
		"connections.actions.connectAgain": "Csatlakoztatás újra",
		"connections.actions.details": "Részletek",
		"connections.actions.done": "Kész",
		"connections.actions.askAgain": "Kérjük el újra",
		"connections.actions.lookAgain": "Nézzük meg újra",
		"connections.actions.tryAgain": "Próbáld újra",
		"connections.actions.dismiss": "Elvetés",
		"connections.actions.whatWentWrong": "Mi történt pontosan?",
		"connections.actions.manage": "Kezelés",
		"connections.actions.disconnectProvider": "{provider} leválasztása",
		"connections.actions.open": "Megnyitás",
		"connections.actions.openItNow": "Nyissuk meg most",

		"connections.yourConnections": "A kapcsolataid",
		"connections.accountCount": "{count} fiók",
		"connections.addConnection.setUpYourself": "Állítsd be te magad",
		"connections.addConnection.alreadyConnected": "Már csatlakoztatva",

		"connections.provider.nextcloud.blurb": "A fájljaid és névjegyeid",
		"connections.provider.immich.blurb": "A fényképtárad",
		"connections.provider.imap.blurb": "Leveleid olvasása és fogalmazása",
		"connections.provider.google.blurb": "A naptárad és névjegyeid",
		"connections.provider.apple.blurb": "A naptárad és névjegyeid",
		"connections.provider.plex.blurb": "A saját filmjeid és sorozataid",
		"connections.provider.owntracks.blurb": "Hol vagy — a saját telefonodról",
		"connections.provider.github.blurb": "A tárolóid és hibajegyeid",
		"connections.provider.onedrive.blurb": "A fájljaid",
		"connections.provider.caldav.blurb":
			"Bármely szabványos naptár vagy címjegyzék",
		"connections.provider.contacts.blurb": "Egy CardDAV címjegyzék",

		"connections.chip.denied": "{capability} — nincs engedélyezve",
		"connections.chip.writesFolders": "{count} mappába írhat",
		"connections.chip.writesDefaultFolder": "Ide írhat: /AlfyAI",
		"connections.chip.writesConfirm": "Írhat, a jóváhagyásoddal",
		"connections.chip.writesDrafts": "Piszkozatok, a jóváhagyásoddal",

		"connections.capabilityAbout.calendar":
			"Elolvassa az eseményeidet, hogy az Alfy válaszolni tudjon a hetedről.",
		"connections.capabilityAbout.contacts":
			"Elolvassa a neveket és címeket, hogy az Alfy megtalálja, akit említesz.",
		"connections.capabilityAbout.email":
			"Elolvassa a leveleidet, hogy az Alfy válaszolni tudjon róluk.",
		"connections.capabilityAbout.files": "Elolvassa a fájljaidat és mappáidat.",
		"connections.capabilityAbout.location":
			"Ennek az egy eszköznek a helyzetét olvassa. Más eszköz nem látható.",
		"connections.capabilityAbout.media": "Elolvassa a könyvtáradat.",
		"connections.capabilityAbout.photos": "Elolvassa a fényképtáradat.",
		"connections.capabilityAbout.repos":
			"Elolvassa a tárolóidat és hibajegyeidet.",
		"connections.capabilityAbout.tasks": "Elolvassa a feladatlistáidat.",
		"connections.capability.mediaPlex": "Filmek és sorozatok",

		"connections.locality.headline":
			"A csatlakoztatott adatok maradjanak ezen a gépen",
		"connections.locality.summary":
			"Egy modell ezen a gépen összegzi, amit a fiókjaid visszaadnak, így a teljes szöveg soha nem hagyja el a gépet.",
		"connections.locality.tooltip":
			"Az összegzés igyekszik megőrizni a kérdésedhez szükséges részleteket. Ha ezt kikapcsolod, az általad választott felhőmodell látja azokat a naptárbejegyzéseket, fájlokat és leveleket, amelyeket a kérdésed érint.",
		"connections.locality.badgeOn": "Be",
		"connections.locality.badgeOff": "Ki",
		"connections.locality.badgeUnknown": "Ismeretlen",
		"connections.locality.unknown":
			"Nem sikerült ellenőrizni, hol dolgozzuk fel a csatlakoztatott adataidat. Semmi nem változott.",

		"connections.detail.whatAlfyMayUse": "Mit használhat az Alfy",
		"connections.detail.howItBehaves": "Hogyan viselkedik",
		"connections.detail.useWithoutAsking": "Használhatja rákérdezés nélkül",
		"connections.detail.useWithoutAskingSub":
			"Az Alfy magától nyúl a(z) {provider} szolgáltatáshoz, ha egy kérdéshez szükség van rá.",
		"connections.detail.useWithoutAskingHelp":
			"Bekapcsolva az Alfy magától nyúl ehhez a fiókhoz, valahányszor egy kérdéshez kell. Kikapcsolva csak akkor használja a(z) {provider} szolgáltatást, ha az adott üzenetnél bekapcsolod a kapcsolatokat.",
		"connections.detail.letAlfyWrite": "Az Alfy írhat is",
		"connections.detail.letAlfyWriteSub":
			"Alapból kikapcsolva. Minden változtatáshoz akkor is kell a jóváhagyásod.",
		"connections.detail.letAlfyWriteHelp":
			"Az írás alapból ki van kapcsolva. Ha bekapcsolod, az Alfy csak azután módosíthatja ezt a fiókot, hogy minden egyes változtatást jóváhagytál.",
		"connections.detail.writeConfirmNote":
			"Minden változtatást egyenként hagysz jóvá, mielőtt megtörténik.",
		"connections.detail.writeConfirmNoteCalendar":
			"Csak naptárváltozások, és mindegyikhez kell a jóváhagyásod.",
		"connections.detail.foldersLabel": "Mappák, ahová az Alfy írhat",
		"connections.detail.deniedSub":
			"Ezt nem engedélyezted, így nincs mit bekapcsolni.",
		"connections.detail.deniedSubDiscovered":
			"A szervered ezt nem kínálja, így nincs mit bekapcsolni.",
		"connections.detail.grantedOn": "Ezt {when} engedélyezted.",
		"connections.detail.readOnlyNote":
			"A(z) {provider} csak olvasható — az Alfy soha nem tudja módosítani.",
		"connections.detail.signInBanner":
			"A(z) {provider} {when} óta nem fogadja el a mentett engedélyt. Az újbóli bejelentkezés körülbelül húsz másodperc.",
		"connections.detail.signInBannerNoDate":
			"A(z) {provider} már nem fogadja el a mentett engedélyt. Az újbóli bejelentkezés körülbelül húsz másodperc.",
		"connections.detail.unreachableBanner":
			"Az Alfy nem érte el a(z) {provider} szolgáltatást ekkor: {when}.",
		"connections.detail.unreachableBannerNoDate":
			"Az Alfy nem érte el a(z) {provider} szolgáltatást.",
		"connections.detail.turnedOffBanner":
			"Ez a kapcsolat ki van kapcsolva. Csatlakoztasd újra, hogy használni tudd.",
		"connections.detail.homeHeading": "Otthon",
		"connections.detail.homeIntro":
			"Ezzel az Alfy megválaszolja, hogy „milyen messze vagyok otthontól”. A koordináták ezen a szerveren maradnak.",
		"connections.detail.technicalDetail": "Technikai részlet",
		"connections.ownTracksHome.saveHome": "Otthon mentése",

		"connections.disconnectConfirm.body":
			"Az Alfy elveszíti a hozzáférést ehhez: {what}. A(z) {provider} szolgáltatásból semmi nem törlődik, és később újra csatlakoztathatod.",
		"connections.disconnectConfirm.bodyNoCapabilities":
			"Az Alfy elveszíti a hozzáférést ehhez a fiókhoz. A(z) {provider} szolgáltatásból semmi nem törlődik, és később újra csatlakoztathatod.",
		"connections.disconnectConfirm.foldersNoteOne":
			"A beállított írási mappa is elfelejtődik.",
		"connections.disconnectConfirm.foldersNoteMany":
			"A beállított {count} írási mappa is elfelejtődik.",

		"connections.states.loadFailed.title":
			"Nem sikerült betölteni a kapcsolataidat",
		"connections.states.loadFailed.body":
			"Valami hiba történt ezen a szerveren — a fiókjaid továbbra is csatlakoztatva vannak. Semmi nem változott.",
		"connections.states.saveFailed.title": "Ez a változtatás nem mentődött el",
		"connections.states.saveFailed.body":
			"{change} nem jutott el a szerverig, így semmi nem változott. Máshoz nem nyúltunk.",
		"connections.states.saveFailed.capabilityOn":
			"A(z) {capability} bekapcsolása ehhez: {provider}",
		"connections.states.saveFailed.capabilityOff":
			"A(z) {capability} kikapcsolása ehhez: {provider}",
		"connections.states.saveFailed.defaultOnOn":
			"A „Használhatja rákérdezés nélkül” bekapcsolása ehhez: {provider}",
		"connections.states.saveFailed.defaultOnOff":
			"A „Használhatja rákérdezés nélkül” kikapcsolása ehhez: {provider}",
		"connections.states.saveFailed.writesOn":
			"Az „Az Alfy írhat is” bekapcsolása ehhez: {provider}",
		"connections.states.saveFailed.writesOff":
			"Az „Az Alfy írhat is” kikapcsolása ehhez: {provider}",
		"connections.states.saveFailed.folders":
			"Az írási mappák módosítása ehhez: {provider}",
		"connections.states.saveFailed.home":
			"Az otthoni helyzet mentése ehhez: {provider}",
		"connections.states.saveFailed.disconnect": "A(z) {provider} leválasztása",
		"connections.states.saveFailed.privacyOn":
			"A helyi feldolgozás bekapcsolása",
		"connections.states.saveFailed.privacyOff":
			"A helyi feldolgozás kikapcsolása",
		"connections.states.partialGrant.title":
			"A(z) {allowed} engedélyezve lett, a(z) {missing} nem",
		"connections.states.partialGrant.titleNoneAllowed":
			"A(z) {provider} nem engedélyezte ezt: {missing}",
		"connections.states.partialGrant.body":
			"A(z) {provider} csak részben adta meg, amit az Alfy kért, így a(z) {missing} kikapcsolva marad.",
		"connections.states.partialGrant.ask": "Kérjük el ezt: {missing}",
		"connections.states.partialGrant.keep": "Maradjon így",
		"connections.states.popupBlocked.title":
			"A böngésződ blokkolta a(z) {provider} lapot",
		"connections.states.popupBlocked.body":
			"A bejelentkezési oldal új lapon nyílik meg. Engedélyezd a felugró ablakokat ehhez az oldalhoz, vagy nyisd meg itt.",
		"connections.states.connecting.title": "Csatlakozás: {provider}",
		"connections.states.connecting.hint": "Általában öt másodperc körül.",

		"connections.wizard.oauth.subtitle":
			"Válaszd ki, mit használhat az Alfy. Ezt a(z) {provider} saját oldalán is jóváhagyod majd.",
		"connections.wizard.nextcloud.waitingTitle": "Várunk a jóváhagyásodra",
		"connections.wizard.nextcloud.waitingBody":
			"A(z) {provider} szolgáltatást új lapon nyitottuk meg. Hagyd jóvá ott, majd gyere vissza ide.",
		"connections.wizard.nextcloud.expires": "A link {minutes} perc múlva lejár",
		"connections.wizard.nextcloud.approved": "Jóváhagytam",
		"connections.wizard.nextcloud.subtitle":
			"Add meg a Nextcloudod címét, és megnyitjuk, hogy ott jóváhagyhasd az Alfyt.",
		"connections.wizard.email.title": "Csatlakoztasd a leveleidet",
		"connections.wizard.email.subtitle": "Hol van a postafiókod?",
		"connections.wizard.email.path.alfy.description2":
			"Az ezen a szerveren üzemelő postafiók.",
		"connections.wizard.email.path.gmail.description2": "A Google-postafiókod.",
		"connections.wizard.email.path.other.name2": "Valahol máshol",
		"connections.wizard.email.path.other.description2":
			"Bármely más postafiók. Szükség lesz a szerver címére.",
		"connections.wizard.github.subtitle":
			"A GitHub ehhez nem a szokásos bejelentkezést használja.",
		"connections.wizard.github.tokenLabel2": "Hozzáférési token",
		"connections.wizard.github.tokenHelp":
			"A token egy hosszú jelszó, amelyet a GitHubon hozol létre. Te döntöd el, mit láthat, és bármikor vissza is vonhatod ott.",
		"connections.wizard.github.createOn": "Hozz létre egyet a GitHubon",
		"connections.wizard.github.differentServer":
			"Másik szerver használata (Gitea, GitHub Enterprise)",
		"connections.wizard.owntracks.subtitle":
			"Melyik telefon a tiéd? Az Alfy kizárólag azt az egyet fogja olvasni.",
		"connections.wizard.owntracks.useThisDevice": "Ezt az eszközt használom",
		"connections.wizard.owntracks.lastSeen": "Utoljára látva: {when}",
		"connections.wizard.owntracks.onRecorderAs":
			"A rekorderen így szerepel: {otUser}",
		"connections.wizard.notSetUp.subtitle":
			"Ezen a szerveren még nincs beállítva.",
		"connections.wizard.notSetUp.bodyAdmin":
			"A(z) {provider} csatlakoztatásához előbb kell egy alkalmazásazonosító és egy titkos kulcs. Te vagy ennek a szervernek a rendszergazdája, így magad is hozzáadhatod őket.",
		"connections.wizard.notSetUp.bodyMember":
			"A(z) {provider} csatlakoztatásához előbb kell egy alkalmazásazonosító és egy titkos kulcs. Kérd meg azt, aki ezt a szervert üzemelteti, hogy adja hozzá őket.",
		"connections.wizard.notSetUp.ownTracksAdmin":
			"Az OwnTracks csatlakoztatásához előbb meg kell adni a rekordered címét. Te vagy ennek a szervernek a rendszergazdája, így magad is megadhatod.",
		"connections.wizard.notSetUp.ownTracksMember":
			"Az OwnTracks csatlakoztatásához előbb meg kell adni a rekorder címét. Kérd meg azt, aki ezt a szervert üzemelteti, hogy adja meg.",
		"connections.wizard.notSetUp.trail":
			"Adminisztráció → Rendszer → Speciális → Integrációk",
		"connections.wizard.apple.subtitle":
			"Az Apple-höz kifejezetten az Alfy számára készített jelszó kell, nem a szokásos.",
		"connections.wizard.immich.subtitle":
			"Jelentkezz be ugyanúgy, ahogy a saját Immich szerveredre szoktál.",
		"connections.wizard.plex.subtitle": "A Plex jelszó helyett tokent használ.",
		"connections.wizard.caldav.subtitle":
			"Bármely naptárhoz vagy címjegyzékhez, amely a szabványos protokollt beszéli.",
		"connections.wizard.contacts.subtitle": "Önállóan még nem elérhető.",

		"connections.chat.useMyConnections": "Használja a kapcsolataimat",
		"connections.chat.accountsReady": "{total} fiókból {ready} áll készen",
		"connections.chat.noAccounts": "Még nincs csatlakoztatott fiók",
		"connections.chat.needsAttention": "A(z) {provider} figyelmet igényel",
		"connections.chat.toggleLabel": "Kapcsolatok · {count}",
		"connections.chat.cloudTitle": "Ez az üzenet elhagyná a gépedet",
		"connections.chat.cloudBody":
			"A(z) {cloudModel} modellt választottad, amely a(z) {vendor} szolgáltatásnál fut. A csatlakoztatott fiókjaid adatai oda kerülnének a válaszhoz.",
		"connections.chat.cloudBodyNoVendor":
			"A(z) {cloudModel} modellt választottad, amely felhőben fut. A csatlakoztatott fiókjaid adatai oda kerülnének a válaszhoz.",
		"connections.chat.cloudLocalRow": "{localModel}, ezen a gépen",
		"connections.chat.cloudLocalRowGeneric": "Egy modell ezen a gépen",
		"connections.chat.cloudLocalNote": "semmi nem távozik",
		"connections.chat.cloudRemoteRow": "{cloudModel}, itt: {vendor}",
		"connections.chat.cloudRemoteRowNoVendor": "{cloudModel}, a felhőben",
		"connections.chat.cloudRemoteNote": "látja az adataidat",
		"connections.chat.cloudKeepLocal": "Maradjon ezen a gépen",
		"connections.chat.cloudSend": "Küldés ide: {cloudModel}",
		"connections.chat.cloudSendGeneric": "Küldés mégis",
		"connections.chat.cloudAskedOnce": "Beszélgetésenként egyszer kérdezzük.",
	},
} as const;

export default connectionsDict;
