import type { JudgeSegmentMessage } from "./prompt";

export type JudgeEvalFixture = {
	name: string;
	segment: JudgeSegmentMessage[];
	expect:
		| "reject_all"
		| {
				admitContaining: string;
				category?: string;
				expiryClass?: "durable" | "time_bound";
		  };
};

export const JUDGE_EVAL_FIXTURES: JudgeEvalFixture[] = [
	{
		name: "log_scrape",
		expect: "reject_all",
		segment: [
			{
				role: "user",
				content:
					"Why is my disk full? Successfully imported modules: ... /dev/mapper/almalinux_alfyws-root 200G 131G 70G 66% /",
			},
			{ role: "assistant", content: "Your root partition is 66% used..." },
		],
	},
	{
		name: "hedged_bike",
		expect: "reject_all",
		segment: [
			{
				role: "user",
				content: "Random question — how does bike insurance generally work?",
			},
			{ role: "assistant", content: "Bike insurance typically covers..." },
		],
	},
	{
		name: "frozen_project_state",
		expect: "reject_all",
		segment: [
			{
				role: "user",
				content:
					"This draft page duplicates content and over-explains everything, help me tighten it for now.",
			},
			{ role: "assistant", content: "Here is a tighter version..." },
		],
	},
	{
		name: "vacuous",
		expect: "reject_all",
		segment: [
			{ role: "user", content: "I'm working with a client on something." },
			{ role: "assistant", content: "Happy to help..." },
		],
	},
	{
		name: "translation_not_owned",
		expect: "reject_all",
		segment: [
			{
				role: "user",
				content:
					"Translate to Dutch: 'I live in Budapest and love spicy food.'",
			},
			{ role: "assistant", content: "'Ik woon in Boedapest...'" },
		],
	},
	{
		name: "hypothetical",
		expect: "reject_all",
		segment: [
			{
				role: "user",
				content: "If I were a vegetarian, what would I cook this week?",
			},
			{ role: "assistant", content: "Hypothetically..." },
		],
	},
	{
		name: "durable_preference",
		segment: [
			{
				role: "user",
				content:
					"Please always explain things in simple everyday language, I hate jargon.",
			},
			{ role: "assistant", content: "Got it..." },
		],
		expect: {
			admitContaining: "simple",
			category: "preferences",
			expiryClass: "durable",
		},
	},
	{
		name: "time_bound_search_hu",
		segment: [
			{
				role: "user",
				content:
					"Még mindig keresek albérletet Limerickben, szeptemberig kell találnom.",
			},
			{ role: "assistant", content: "Nézzük a lehetőségeket..." },
		],
		expect: { admitContaining: "Limerick", expiryClass: "time_bound" },
	},
	{
		name: "stated_identity_hu",
		segment: [
			{
				role: "user",
				content:
					"Magyar Erasmus-hallgató vagyok, ezt vedd figyelembe a válaszoknál.",
			},
			{ role: "assistant", content: "Rendben..." },
		],
		expect: {
			admitContaining: "Erasmus",
			category: "about_you",
			expiryClass: "durable",
		},
	},
	{
		name: "explicit_remember",
		segment: [
			{
				role: "user",
				content: "Remember that I don't plan to work in Ireland.",
			},
			{ role: "assistant", content: "Noted." },
		],
		expect: { admitContaining: "Ireland", category: "constraints_boundaries" },
	},
];
