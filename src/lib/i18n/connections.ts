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
		"connections.defaultOn.help":
			"When on, AlfyAI can use this connection automatically without asking each time.",
		"connections.defaultOn.label": "Default on",
		"connections.empty": "No connections yet.",
		"connections.status.connected": "Connected",
		"connections.status.disconnected": "Disconnected",
		"connections.status.error": "Error",
		"connections.status.needsReauth": "Needs reauthorization",
		"connections.subtitle":
			"Connect your accounts so AlfyAI can read and, if you allow it, write to them.",
		"connections.title": "Connections",
	},
	hu: {
		"connections.actions.connect": "Csatlakoztatás",
		"connections.actions.disconnect": "Leválasztás",
		"connections.actions.reconnect": "Újracsatlakoztatás",
		"connections.allowWrites.label": "Írás engedélyezése",
		"connections.allowWrites.warning":
			"Az írás alapértelmezetten ki van kapcsolva. Ha bekapcsolod, az AlfyAI csak a jóváhagyásod után módosíthatja ezt a fiókot, minden egyes változtatásnál.",
		"connections.capabilities.label": "Képességek",
		"connections.defaultOn.help":
			"Ha bekapcsolod, az AlfyAI automatikusan használhatja ezt a kapcsolatot, anélkül hogy minden alkalommal rákérdezne.",
		"connections.defaultOn.label": "Alapértelmezetten bekapcsolva",
		"connections.empty": "Még nincs kapcsolat.",
		"connections.status.connected": "Csatlakoztatva",
		"connections.status.disconnected": "Leválasztva",
		"connections.status.error": "Hiba",
		"connections.status.needsReauth": "Újbóli hitelesítés szükséges",
		"connections.subtitle":
			"Csatlakoztasd a fiókjaidat, hogy az AlfyAI olvashassa őket, és ha engedélyezed, írhasson is beléjük.",
		"connections.title": "Kapcsolatok",
	},
} as const;

export default connectionsDict;
