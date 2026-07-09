// Connections-related i18n strings (Issue 7.0 — foundation for the
// Connections management panels built in 7.1-7.5).

const connectionsDict = {
	en: {
		"connections.actions.connect": "Connect",
		"connections.actions.disconnect": "Disconnect",
		"connections.actions.reconnect": "Reconnect",
		"connections.actions.viewDetails": "View details",
		"connections.addConnection.title": "Add a connection",
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
			"Choose what AlfyAI can access, then continue to Google to grant permission.",
		"connections.wizard.oauth.continue": "Continue to Google",
		"connections.wizard.oauth.redirecting": "Redirecting to Google…",
		"connections.wizard.oauth.notConfigured":
			"Google connect isn't configured on this server yet. Ask your administrator to set it up.",

		"connections.wizard.nextcloud.serverUrlLabel": "Server URL",
		"connections.wizard.nextcloud.serverUrlPlaceholder":
			"https://cloud.example.com",
		"connections.wizard.nextcloud.help":
			"We'll open a new tab where you can log in to Nextcloud and approve AlfyAI.",
		"connections.wizard.nextcloud.waiting":
			"Waiting for you to approve in Nextcloud…",
		"connections.wizard.nextcloud.checkApproval": "I've approved",
		"connections.wizard.nextcloud.timeout":
			"This took too long — the login link may have expired. Please try again.",

		"connections.wizard.immich.serverUrlLabel": "Server URL",
		"connections.wizard.immich.emailLabel": "Email",
		"connections.wizard.immich.passwordLabel": "Password",
		"connections.wizard.immich.help":
			"Use the same email and password you use to log in to your Immich server.",

		"connections.wizard.plex.serverUrlLabel": "Server URL",
		"connections.wizard.plex.tokenLabel": "Plex token",
		"connections.wizard.plex.help":
			"Find your token by signing in to Plex Web, opening any item's “Get Info” → “View XML”, and copying the X-Plex-Token value from the URL.",

		"connections.wizard.apple.appleIdLabel": "Apple ID",
		"connections.wizard.apple.appPasswordLabel": "App-specific password",
		"connections.wizard.apple.help":
			"Generate an app-specific password at appleid.apple.com and paste it here — your regular Apple ID password won't work.",
		"connections.wizard.apple.generateLink":
			"Generate one at appleid.apple.com",

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
			"OwnTracks isn't configured on this server yet. Ask your administrator to set it up.",
		"connections.wizard.owntracks.empty":
			"No devices found on the OwnTracks recorder yet.",
		"connections.wizard.owntracks.deviceOption": "{otUser} / {otDevice}",

		"connections.wizard.contacts.notAvailable":
			"Connecting Contacts directly isn't available yet — connect Google, Apple, or Nextcloud instead to bring in contacts.",

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
	},
	hu: {
		"connections.actions.connect": "Csatlakoztatás",
		"connections.actions.disconnect": "Leválasztás",
		"connections.actions.reconnect": "Újracsatlakoztatás",
		"connections.actions.viewDetails": "Részletek megtekintése",
		"connections.addConnection.title": "Kapcsolat hozzáadása",
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
			"Válaszd ki, mihez férhet hozzá az AlfyAI, majd folytasd a Google-nél a hozzájárulás megadásához.",
		"connections.wizard.oauth.continue": "Folytatás a Google-nél",
		"connections.wizard.oauth.redirecting": "Átirányítás a Google-höz…",
		"connections.wizard.oauth.notConfigured":
			"A Google-csatlakozás még nincs beállítva ezen a szerveren. Kérd meg a rendszergazdát, hogy állítsa be.",

		"connections.wizard.nextcloud.serverUrlLabel": "Szerver URL",
		"connections.wizard.nextcloud.serverUrlPlaceholder":
			"https://felho.pelda.hu",
		"connections.wizard.nextcloud.help":
			"Nyitunk egy új lapot, ahol bejelentkezhetsz a Nextcloudba, és jóváhagyhatod az AlfyAI-t.",
		"connections.wizard.nextcloud.waiting":
			"Várakozás a jóváhagyásodra a Nextcloudban…",
		"connections.wizard.nextcloud.checkApproval": "Jóváhagytam",
		"connections.wizard.nextcloud.timeout":
			"Ez túl sokáig tartott — a bejelentkezési link lejárhatott. Kérjük, próbáld újra.",

		"connections.wizard.immich.serverUrlLabel": "Szerver URL",
		"connections.wizard.immich.emailLabel": "E-mail",
		"connections.wizard.immich.passwordLabel": "Jelszó",
		"connections.wizard.immich.help":
			"Add meg ugyanazt az e-mail-címet és jelszót, amellyel az Immich szerveredre bejelentkezel.",

		"connections.wizard.plex.serverUrlLabel": "Szerver URL",
		"connections.wizard.plex.tokenLabel": "Plex token",
		"connections.wizard.plex.help":
			"A tokenedet a Plex Web-be bejelentkezve találod: nyiss meg egy elemet, válaszd a „Get Info” → „View XML” lehetőséget, majd másold ki az URL-ből az X-Plex-Token értékét.",

		"connections.wizard.apple.appleIdLabel": "Apple ID",
		"connections.wizard.apple.appPasswordLabel": "Alkalmazásspecifikus jelszó",
		"connections.wizard.apple.help":
			"Készíts egy alkalmazásspecifikus jelszót az appleid.apple.com oldalon, és illeszd be ide — a szokásos Apple ID jelszavad nem fog működni.",
		"connections.wizard.apple.generateLink":
			"Készíts egyet az appleid.apple.com oldalon",

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
			"Az OwnTracks még nincs beállítva ezen a szerveren. Kérd meg a rendszergazdát, hogy állítsa be.",
		"connections.wizard.owntracks.empty":
			"Még nem található eszköz az OwnTracks rekorderen.",
		"connections.wizard.owntracks.deviceOption": "{otUser} / {otDevice}",

		"connections.wizard.contacts.notAvailable":
			"A Névjegyek közvetlen csatlakoztatása még nem elérhető — csatlakoztasd inkább a Google-t, az Apple-t vagy a Nextcloudot a névjegyek behozatalához.",

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
	},
} as const;

export default connectionsDict;
