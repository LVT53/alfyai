// Matched real-model evaluation prompts. Each plain question keeps the same
// subject as its visual partner without asking for its appearance.
export const imageSearchIntents = [
	{
		id: "connector",
		visual: {
			en: "I have a drawer of cables. How can I tell Mini-B and Micro-B plugs apart at a glance?",
			hu: "Van egy fióknyi kábelem. Hogyan tudom ránézésre megkülönböztetni a Mini-B és a Micro-B csatlakozót?",
		},
		text: {
			en: "What does USB stand for in the name USB Mini-B?",
			hu: "Mit jelent az USB rövidítés az USB Mini-B nevében?",
		},
	},
	{
		id: "market",
		visual: {
			en: "What should I look for to recognize the main entrance of Budapest’s Great Market Hall from Fővám Square?",
			hu: "Miről ismerem fel a budapesti Nagyvásárcsarnok főbejáratát a Fővám tér felől?",
		},
		text: {
			en: "Translate the Hungarian name Nagyvásárcsarnok into English.",
			hu: "Hogyan fordítanád angolra azt, hogy Nagyvásárcsarnok?",
		},
	},
	{
		id: "blackbird",
		visual: {
			en: "How can I recognize a male and a female common blackbird when I see them in my garden?",
			hu: "Miről ismerem fel a hím és a tojó feketerigót, ha meglátom őket a kertemben?",
		},
		text: {
			en: "What is the scientific name of the common blackbird?",
			hu: "Mi a feketerigó tudományos neve?",
		},
	},
] as const;
