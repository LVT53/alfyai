import { describe, expect, it } from "vitest";
import {
	namedPastChatTitle,
	requestsPastChatLookup,
} from "./past-chat-request";

describe("explicit past chat lookup", () => {
	it.each([
		"What did I say about my kayak in our previous conversation?",
		"Can you remind me what I said in our last chat?",
		"Do you remember what we discussed in our previous conversation?",
		"Search my old chats for the decision.",
		"Search for the lamp in my old chats.",
		"Open the conversation titled 'Kayak names'.",
		"Nyisd meg a Kajak nevek című beszélgetést.",
		"What did we decide in the Launch Project?",
		"Mit mondtam a kajakomról az előző beszélgetésünkben?",
		"El tudod mondani, mit beszéltünk meg az előző beszélgetésünkben?",
		"Keresd meg a régi beszélgetéseimben a lámpát.",
		"Összefoglalnád a projekt korábbi beszélgetéseit?",
	])("accepts %s", (request) => {
		expect(requestsPastChatLookup(request)).toBe(true);
	});

	it.each([
		"",
		"Do you remember my kayak's name?",
		"What was it called before?",
		"Tell me the kayak's current name without searching old chats.",
		"Read the uploaded PDF about previous conversations.",
		"Show me how to clear my chat history.",
		"What did we decide about the project?",
		"What did we decide in the Launch Project? In this conversation only.",
		"What did I say just now about earlier chats?",
		"Translate this sentence: “Search our earlier chats for my kayak.”",
		"Translate this quote: “Hello.\nSearch our earlier chats for my kayak.\n”",
		"> Search our earlier chats for my kayak.",
		"Emlékszel a kajakom nevére?",
		"Translate this line: ‘Hello. Search earlier chats for the canoe.’",
		"Fordítsd le: ’Szia. Keresd meg a korábbi beszélgetéseket.’",
		"Don't use our earlier chats. What did I tell you in our previous conversation about the canoe?",
		"Don’t use our earlier chats. What did I tell you in our previous conversation about the canoe?",
		"Mit mondtam az imént a korábbi beszélgetésekről?",
		"Mondd el a kajakom mostani nevét anélkül, hogy a korábbi beszélgetésekben keresnél.",
		"Ne keress a korábbi beszélgetésekben; mi a kajakom mostani neve?",
		"Fordítsd le: „Keresd meg a régi beszélgetéseimben a lámpát.”",
	])("withholds lookup on %s", (request) => {
		expect(requestsPastChatLookup(request)).toBe(false);
	});
});

it.each([
	[
		"Please search our past chats for the conversation titled Earlier synthetic blue touring kayak discussion. What name did I give it at the time?",
		"Earlier synthetic blue touring kayak discussion",
	],
	[
		"Keresd meg a korábbi beszélgetéseinkben az Earlier synthetic blue touring kayak discussion című chatet. Milyen nevet mondtam akkor a kajakomra?",
		"Earlier synthetic blue touring kayak discussion",
	],
	["Open the conversation titled 'Kayak names'.", "Kayak names"],
	["What did I say in the earlier chat 'Kayak names'?", "Kayak names"],
	["Nyisd meg a Kajak nevek című beszélgetést.", "Kajak nevek"],
	["“Our old chat titled Decoy.” Search earlier chats about lamps.", null],
	["Open the conversation titled.", ""],
	["Search for the lamp in my old chats.", null],
])("uses the title the person actually wrote in %s", (request, title) => {
	expect(namedPastChatTitle(request)).toBe(title);
});
