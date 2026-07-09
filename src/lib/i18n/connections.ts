// Connections-related i18n strings (Issue 7.0 — foundation for the
// Connections management panels built in 7.1-7.5).

const connectionsDict = {
	en: {
		"connections.actions.connect": "Connect",
		"connections.actions.disconnect": "Disconnect",
		"connections.actions.reconnect": "Reconnect",
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
		"connections.emptyAddPrompt": "Add a connection to get started.",
		"connections.status.connected": "Connected",
		"connections.status.disconnected": "Disconnected",
		"connections.status.error": "Error",
		"connections.status.needsReauth": "Needs reauthorization",
		"connections.status.noDetail": "No additional details available.",
		"connections.subtitle":
			"Connect your accounts so AlfyAI can read and, if you allow it, write to them.",
		"connections.title": "Connections",
		"connections.writeAllowlist.add": "Add",
		"connections.writeAllowlist.addPlaceholder": "/folder/path",
		"connections.writeAllowlist.confirmNote":
			"Writes to this connection are confirmed individually before they happen.",
		"connections.writeAllowlist.empty":
			"No folders added yet — writes default to /AlfyAI.",
		"connections.writeAllowlist.label": "Allowed folders",
		"connections.writeAllowlist.removeA11y": "Remove {path}",
	},
	hu: {
		"connections.actions.connect": "Csatlakoztatás",
		"connections.actions.disconnect": "Leválasztás",
		"connections.actions.reconnect": "Újracsatlakoztatás",
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
		"connections.emptyAddPrompt": "Kezdéshez adj hozzá egy kapcsolatot.",
		"connections.status.connected": "Csatlakoztatva",
		"connections.status.disconnected": "Leválasztva",
		"connections.status.error": "Hiba",
		"connections.status.needsReauth": "Újbóli hitelesítés szükséges",
		"connections.status.noDetail": "Nincs további részlet.",
		"connections.subtitle":
			"Csatlakoztasd a fiókjaidat, hogy az AlfyAI olvashassa őket, és ha engedélyezed, írhasson is beléjük.",
		"connections.title": "Kapcsolatok",
		"connections.writeAllowlist.add": "Hozzáadás",
		"connections.writeAllowlist.addPlaceholder": "/mappa/elérési út",
		"connections.writeAllowlist.confirmNote":
			"Az ehhez a kapcsolathoz tartozó írásokat egyenként jóvá kell hagynod, mielőtt megtörténnek.",
		"connections.writeAllowlist.empty":
			"Még nincs hozzáadott mappa — az írások alapértelmezetten ide kerülnek: /AlfyAI.",
		"connections.writeAllowlist.label": "Engedélyezett mappák",
		"connections.writeAllowlist.removeA11y": "{path} eltávolítása",
	},
} as const;

export default connectionsDict;
