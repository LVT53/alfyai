// Personal and project instruction strings (Workspaces feature 1).
//
// One namespace for the whole instructions surface: the shared
// InstructionsDialog, its scope token, and the Settings row that opens it.
// Slice D renders the same dialog with a project scope and adds no strings of
// its own — the project-scope descriptions are already here.

const instructionsDict = {
	en: {
		"instructions.appendedLine":
			"Added to the end. Edit the whole text if something no longer fits.",
		"instructions.cancel": "Cancel",
		"instructions.counter": "{count} / {max}",
		"instructions.descriptionPersonal": "These apply in every chat.",
		"instructions.descriptionProject":
			"AlfyAI follows these in every chat in this project. They take priority over your memory and style.",
		"instructions.loadFailed": "Could not open the instructions.",
		"instructions.save": "Save",
		"instructions.saveFailed": "Could not save the instructions.",
		"instructions.scopeA11y": "Instructions for {scope}",
		"instructions.scopePersonal": "Personal",
		"instructions.scopeYou": "You",
		"instructions.suggestionA11y": "Add to instructions for {scope}: {text}",
		"instructions.suggestionDismiss": "Dismiss",
		"instructions.suggestionDismissFailed": "Could not dismiss the suggestion.",
		"instructions.suggestionInvalidRequest":
			"That suggestion request was incomplete.",
		"instructions.suggestionInvalidStatus":
			"A suggestion is answered as reviewed or dismissed.",
		"instructions.suggestionNotFound": "Could not find that suggestion.",
		"instructions.suggestionPrefix": "Add to instructions for",
		"instructions.suggestionReview": "Review",
		"instructions.suggestionReviewFailed": "Could not save the instructions.",
		"instructions.title": "Instructions",
		"instructions.tooLong": "Instructions can be at most {max} characters.",
		"instructions.tokenA11y": "Project {name}",
	},
	hu: {
		"instructions.appendedLine":
			"A végéhez fűztük. Ha valami már nem illik, nyugodtan írd át az egészet.",
		"instructions.cancel": "Mégsem",
		"instructions.counter": "{count} / {max}",
		"instructions.descriptionPersonal": "Minden csevegésben érvényesek.",
		"instructions.descriptionProject":
			"Az AlfyAI minden csevegésben követi ezeket a projektben. Elsőbbséget élveznek a memóriáddal és a stílussal szemben.",
		"instructions.loadFailed": "Nem sikerült megnyitni az utasításokat.",
		"instructions.save": "Mentés",
		"instructions.saveFailed": "Nem sikerült menteni az utasításokat.",
		"instructions.scopeA11y": "Utasítások ehhez: {scope}",
		"instructions.scopePersonal": "Személyes",
		"instructions.scopeYou": "Te",
		"instructions.suggestionA11y":
			"Hozzáadás az utasításokhoz ({scope}): {text}",
		"instructions.suggestionDismiss": "Elvetés",
		"instructions.suggestionDismissFailed":
			"Nem sikerült elvetni a javaslatot.",
		"instructions.suggestionInvalidRequest": "A javaslat kérése hiányos volt.",
		"instructions.suggestionInvalidStatus":
			"A javaslatot áttekintettként vagy elvetettként lehet lezárni.",
		"instructions.suggestionNotFound": "Nem találtuk a javaslatot.",
		"instructions.suggestionPrefix": "Hozzáadás az utasításokhoz:",
		"instructions.suggestionReview": "Áttekintés",
		"instructions.suggestionReviewFailed":
			"Nem sikerült menteni az utasításokat.",
		"instructions.title": "Utasítások",
		"instructions.tooLong": "Az utasítás legfeljebb {max} karakter lehet.",
		"instructions.tokenA11y": "{name} projekt",
	},
} as const;

export default instructionsDict;
