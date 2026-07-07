// Fixture data for the skill-instructions A/B evaluation harness.
//
// For each of the 7 built-in system skill packs, this module holds:
//   - `before`: the CURRENT English `instructions` string, copied verbatim
//     (joined with "\n", matching the `.join("\n")` used in user-skills.ts)
//     from `src/lib/server/services/skills/user-skills.ts` (builtInSystemSkills,
//     lines ~383-641 at the time of writing).
//   - `after`: `before` + "\n" + the exact lines the plan
//     (`~/.claude/plans/write-this-into-a-zippy-hamming.md`, "Tier B — per-pack
//     content upgrades" section) appends for that pack.
//   - `fixtures`: 2 realistic per-pack task prompts grounded in the pack's
//     `activationExamples` plus a concrete scenario. Document Explainer and
//     Plan Critic fixtures include an `attachedDoc` snippet since those skills
//     depend on source material.
//
// IMPORTANT: this file is READ-ONLY with respect to production code. It does
// not import from user-skills.ts — the strings below are copied by hand so the
// eval can run entirely offline against fixed text. If user-skills.ts changes,
// this file must be re-synced by hand (the harness has no way to detect drift
// automatically; a human diff against the source is required).
//
// Spreadsheet Builder note: per the plan, the AFTER upgrade for this pack is
// specified to land in the `spreadsheet-finance-models` managed RESOURCE
// content, not in the base `instructions` array (the resource is injected
// separately by `buildSkillSystemPromptAppendix` via `skillResources`, see
// `buildSkillResourceLines` in prompt-context.ts). For this eval we do not
// wire up a separate managed-resource injection path; we APPROXIMATE the
// upgrade by appending the plan's 3 finance lines directly onto the base
// instructions as the AFTER variant. This is a simplification for the
// harness only — it is not how the change will ship in production.

export type SkillEvalFixture = {
	id: string;
	userMessage: string;
	attachedDoc?: string;
};

export type SkillEvalPack = {
	skillId: string;
	displayName: string;
	before: string;
	after: string;
	fixtures: SkillEvalFixture[];
};

const planCriticBefore = [
	"Run a focused plan-critique workflow. Your job is to improve correctness before execution, not to rubber-stamp the plan.",
	"Use the current user message, conversation context, and selected linked sources. Do not claim to have read documents or code that were not provided in context.",
	"When source material is available, separate source-backed findings from reasoned concerns. Quote or reference source facts only when they are actually present.",
	"Check for contradictions, weak assumptions, missing decisions, overloaded terminology, unverified dependencies, scope creep, and cases where the plan conflicts with product language or prior decisions.",
	"If a question is needed, ask one focused question and include your recommended answer. If the answer can be discovered from available context, discover it instead of asking.",
	"Prefer concrete revisions: changed wording, added acceptance criteria, removed scope, renamed terms, or an explicit decision that should be recorded.",
	"Output with the highest-impact issues first. Keep summaries brief and make the next action obvious.",
].join("\n");

const planCriticAppend = [
	"Tag each finding with a severity — Blocker (breaks correctness or a hard constraint), Major (likely rework), or Minor (polish) — and lead with Blockers.",
	'For every Blocker, name the concrete failure it causes if the plan ships as-is, not just that it is "risky".',
	"Give the plan one overall risk read (Low / Medium / High) with a one-line rationale, so the user knows whether it is safe to proceed.",
].join("\n");

const documentExplainerBefore = [
	"Explain the selected or attached document so the user can act on it.",
	"Start with the main point in plain language, then unpack the important terms, obligations, decisions, numbers, and caveats.",
	"Ground claims in the provided document. If the user asks for something the document does not answer, say that clearly and separate inference from source fact.",
	"Preserve important concrete details such as dates, thresholds, names, requirements, and exceptions. Do not flatten them into vague summaries.",
	"Adapt depth to the user's apparent familiarity. For beginners, define terms before using them; for advanced users, focus on implications and edge cases.",
	"When useful, end with a short list of decisions, risks, or follow-up questions the document implies.",
].join("\n");

const documentExplainerAppend = [
	"Lead with a one-line takeaway, then a short plain-language summary, then the detailed breakdown, so the user can stop at the depth they need.",
	'For any claim that is uncertain or that the document leaves ambiguous, add an explicit inline "Confidence: high/medium/low" label with a one-line reason — never bury the uncertainty in prose.',
	"Keep visibly separate: what the document actually states, what you are inferring, and what needs outside verification.",
].join("\n");

const studyCoachBefore = [
	"Coach the user through active learning rather than only summarizing material.",
	"Break the topic into learnable chunks, identify prerequisites, and explain the first chunk before moving deeper.",
	"Use retrieval practice: ask one short check-for-understanding question when useful, then adapt based on the user's answer.",
	"Correct misunderstandings directly and kindly. Explain why the correction matters, not just what the right answer is.",
	"Use examples, contrasts, and small exercises. Prefer concrete practice over abstract encouragement.",
	"End with practical next study steps, spaced repetition prompts, or a small self-test when appropriate.",
].join("\n");

const studyCoachAppend = [
	"Teach the material actively first (explain, check understanding, correct) — then reinforce it; do not replace teaching with an offer to make study aids.",
	"When the user has a test or interview coming up, provide a short day-by-day review schedule keyed to that date, and offer an atomic flashcard set (one fact per card, question form, cloze where useful).",
	"When the material is fact-dense (numbers, formulas, dates), pull those into a compact cheat sheet alongside the explanation.",
].join("\n");

const purchaseHelperBefore = [
	"Help the user make a purchase decision that fits their actual constraints, not a generic best-product ranking.",
	"First identify the decision criteria: budget, location, timeline, must-haves, nice-to-haves, dealbreakers, ownership costs, compatibility, warranty, support, and risk tolerance.",
	"Compare options by practical tradeoffs. Include why an option may be wrong for this user even if it is objectively strong.",
	"Treat prices, availability, laws, insurance terms, and product specifications as freshness-sensitive. Use available current sources when possible; otherwise label uncertainty clearly.",
	"Preserve concrete user facts from the conversation, such as owned items, existing subscriptions, region, compatibility requirements, and prior preferences.",
	"End with a recommendation only when the evidence supports it. Otherwise provide a shortlist, decision matrix, or the one missing fact that would decide it.",
].join("\n");

const purchaseHelperAppend = [
	"When comparing options, present them as a comparison table across the criteria that matter to this user (price, the two or three specs they care about, key differentiators), not as prose paragraphs.",
	"For your leading recommendation, always name at least one real weakness or who should skip it — never present a pick as flawless.",
	"End with a clear call — buy now / wait / skip, tied to this user's use case — or the single missing fact that would decide it.",
].join("\n");

const translateRewriteBefore = [
	"Transform the user's text while preserving meaning, intent, facts, and audience fit.",
	"Before changing ambiguous meaning, ask a focused question or provide the safest version with a brief note about the ambiguity.",
	"Keep terminology, names, dates, numbers, and formatting-sensitive details consistent unless the user asks to change them.",
	"For translation, prefer natural target-language phrasing over word-for-word literalism, while preserving register and nuance.",
	"For rewriting, match the requested tone and medium. Remove clutter, improve structure, and keep the user's voice where possible.",
	"Usually provide the revised text first. Add a short explanation only when changes are material or the user asked for reasoning.",
].join("\n");

const translateRewriteAppend = [
	"If the user has established terminology (a glossary, product names, prior translations), lock those terms and reuse them consistently; flag rather than silently override when context demands a different choice.",
	"Never silently drop or alter placeholders, tags, or formatting tokens such as {name}, <tag>, or markdown — preserve them exactly.",
	"When a segment is genuinely ambiguous, surface it with two or three candidate renderings and your recommended one, instead of guessing.",
].join("\n");

const appointmentPrepBefore = [
	"Prepare the user for an appointment, meeting, call, or administrative interaction.",
	"Identify the goal, counterpart, timing, constraints, prior context, required documents, decisions needed, and what a good outcome looks like.",
	"Organize the preparation into agenda, context to mention, questions to ask, materials to bring or send, risks or sensitive points, and follow-up actions.",
	"Preserve concrete facts from the conversation and selected sources. Do not invent appointment details, eligibility rules, deadlines, or legal/medical/financial advice.",
	"If the situation is high-stakes or current-rule-dependent, flag what should be verified with an official source or professional.",
	"Keep the output usable during the appointment: concise phrasing, prioritized questions, and a short checklist.",
].join("\n");

const appointmentPrepAppend = [
	"Lead with the actions that matter most before the appointment, not with background — the user may be reading this minutes beforehand.",
	'Add a short "verify / flag" section for anything high-stakes or rule-dependent: what to confirm with an official source or professional, and how urgently.',
	"Where relevant, call out what to avoid saying or committing to, and what to preserve or bring (documents, evidence, references).",
].join("\n");

const spreadsheetBuilderBefore = [
	"Use this skill when the user asks to create, edit, analyze, visualize, or work with spreadsheet files such as .xlsx, .xls, .csv, or .tsv.",
	'For downloadable XLSX creation, route the work through produce_file with structured tool input: sourceMode: "program", requestedOutputs: [{ "type": "xlsx" }], program: { language: "javascript", sourceCode, filename }, idempotencyKey, requestTitle, and documentIntent.',
	'The JavaScript program.sourceCode should use exceljs and write final requested files under /output with workbook.xlsx.writeFile("/output/<name>.xlsx"). When program.filename is provided, produce exactly one final requested workbook at /output/<name>.xlsx and do not write scratch diagnostics or unrelated files under /output.',
	"Use bounded sheets, tables, and helper ranges. Keep raw/source data, assumptions, calculations, outputs, checks, and dashboard or KPI views separated when the task is analytical.",
	"Use formula-driven workbook logic for derived values. Avoid magic numbers in formulas; put assumptions in labeled cells or sheets and reference them.",
	"When formulas are included, set workbook.calcProperties.fullCalcOnLoad = true. Verify only with sandbox-local assertions, formula-text/error scans, ZIP/workbook reload checks, and representative worksheet checks.",
	"Use exceljs tables, freeze panes, filters, data validation, number formats, column widths, fills, borders, conditional formatting where supported, and clear titles to make the workbook usable and polished.",
	"For visual summaries, create chart-ready helper tables, KPI/dashboard layouts, heatmaps, timelines, and tested static worksheet visuals. Do not use embedded plotting APIs until the runtime has explicit support for them.",
	"Keep domain-specific guidance selective: include finance, healthcare, marketing, or scientific conventions only when the user's request clearly matches that domain.",
	"Be explicit about source facts versus assumptions. Cite sources inside workbook cells or source/audit sheets when the task depends on external or user-provided data.",
].join("\n");

// NOTE (see file header): in production this content ships inside the
// `spreadsheet-finance-models` managed resource, not the base instructions.
// Approximated here by appending directly to base instructions for the eval.
const spreadsheetBuilderAppend = [
	"For financial models, build explicit scenario columns (base / downside / upside) driven by labeled assumption cells, and surface trigger points such as the month cash falls below one payroll.",
	"Include unit economics where relevant (gross and contribution margin, CAC payback, LTV/CAC) and flag any line operating below breakeven.",
	'End model-backed recommendations with an explicit "what would change this conclusion" note or cell.',
].join("\n");

export const skillEvalPacks: SkillEvalPack[] = [
	{
		skillId: "system:grill-with-docs",
		displayName: "Plan Critic",
		before: planCriticBefore,
		after: `${planCriticBefore}\n${planCriticAppend}`,
		fixtures: [
			{
				id: "plan-critic-adr-conflict",
				userMessage:
					"criticize this plan: we're going to add a global in-memory cache for user sessions to speed up auth checks, keyed by user id, with a 24h TTL and no invalidation on password change.",
				attachedDoc:
					"ADR-014: Session invalidation must be immediate on password change, role change, or explicit logout across all nodes. Any caching layer for auth state must support push-based invalidation; TTL-only expiry is explicitly disallowed for security-sensitive state.",
			},
			{
				id: "plan-critic-migration-scope",
				userMessage:
					"stress-test this implementation plan: migrate the billing table from monthly to usage-based pricing in one PR, dropping the old `plan_tier` column immediately, backfilling historical invoices via a script we'll write later, and flipping all customers over at once next Friday.",
				attachedDoc:
					"Engineering constraint doc: All schema migrations touching the billing table require a two-phase rollout (additive migration, then a follow-up removal migration at least one release later) and a dry-run against a production snapshot before customer-facing cutover.",
			},
		],
	},
	{
		skillId: "system:document-explainer",
		displayName: "Document Explainer",
		before: documentExplainerBefore,
		after: `${documentExplainerBefore}\n${documentExplainerAppend}`,
		fixtures: [
			{
				id: "document-explainer-lease-clause",
				userMessage:
					"explain this document — specifically, can my landlord raise the rent mid-lease?",
				attachedDoc:
					"Section 7.2: Rent shall remain fixed for the initial 12-month term. After the initial term, the Landlord may increase rent upon 60 days' written notice, provided the increase does not exceed 5% annually unless mutually agreed in writing. Section 9.1: Tenant is responsible for renters insurance with minimum liability coverage of $100,000.",
			},
			{
				id: "document-explainer-research-abstract",
				userMessage:
					"summarize this source and extract the important caveats for someone who isn't a statistician",
				attachedDoc:
					"Abstract: We find a 12% reduction in reported symptoms in the treatment group (n=48) versus placebo (n=45) over 8 weeks (p=0.04). The study was not pre-registered and relied on self-reported outcomes; a per-protocol sensitivity analysis excluding 6 dropouts showed a smaller, non-significant effect (p=0.11). Funding was provided by the manufacturer of the studied supplement.",
			},
		],
	},
	{
		skillId: "system:study-coach",
		displayName: "Study Coach",
		before: studyCoachBefore,
		after: `${studyCoachBefore}\n${studyCoachAppend}`,
		fixtures: [
			{
				id: "study-coach-exam-prep",
				userMessage:
					"help me study this for my exam in 6 days: I need to know the Krebs cycle steps, the enzymes involved at each step, and the net ATP/NADH/FADH2 yield per glucose molecule.",
			},
			{
				id: "study-coach-quiz-me",
				userMessage:
					"quiz me on JavaScript closures and hoisting — I keep mixing them up and want a study plan for the next few days before my technical interview.",
			},
		],
	},
	{
		skillId: "system:purchase-helper",
		displayName: "Purchase Helper",
		before: purchaseHelperBefore,
		after: `${purchaseHelperBefore}\n${purchaseHelperAppend}`,
		fixtures: [
			{
				id: "purchase-helper-laptop",
				userMessage:
					'help me choose what to buy: I need a laptop under $1200 for software development (mostly web + some Docker/local LLM experiments), I already own a Dell 27" 1440p monitor with DisplayPort, and I care most about RAM, battery life, and keyboard quality. Compare 2-3 realistic options.',
			},
			{
				id: "purchase-helper-vacuum",
				userMessage:
					"which option fits my needs — I have two cats, a mix of hardwood and rugs, and a budget around $400 for a robot vacuum. I already tried a cheap $150 one and it got tangled in cat hair constantly.",
			},
		],
	},
	{
		skillId: "system:translate-rewrite",
		displayName: "Translate & Rewrite",
		before: translateRewriteBefore,
		after: `${translateRewriteBefore}\n${translateRewriteAppend}`,
		fixtures: [
			{
				id: "translate-rewrite-placeholders",
				userMessage:
					'translate this to Spanish for our email template, keep it natural: "Hi {name}, your order <order_id> has shipped and will arrive by {eta}. Track it here: {tracking_url}"',
			},
			{
				id: "translate-rewrite-tone",
				userMessage:
					'make this more professional for a client-facing status update: "hey so basically we\'re kinda behind on the API integration, the third party docs were garbage and we had to redo auth twice, should be done by friday probably"',
			},
		],
	},
	{
		skillId: "system:appointment-prep",
		displayName: "Appointment Prep",
		before: appointmentPrepBefore,
		after: `${appointmentPrepBefore}\n${appointmentPrepAppend}`,
		fixtures: [
			{
				id: "appointment-prep-visa-interview",
				userMessage:
					"prepare me for this appointment — I have a visa interview at the consulate tomorrow morning, it's my first time applying, and I'm nervous about the financial documentation questions.",
			},
			{
				id: "appointment-prep-salary-negotiation",
				userMessage:
					"help me plan this meeting: I have a performance review with my manager in 2 hours where I want to negotiate a raise. I've been at the company 2 years, took on a lead role 6 months ago, and haven't had a raise since I started.",
			},
		],
	},
	{
		skillId: "system:spreadsheet-builder",
		displayName: "Spreadsheet Builder",
		before: spreadsheetBuilderBefore,
		after: `${spreadsheetBuilderBefore}\n${spreadsheetBuilderAppend}`,
		fixtures: [
			{
				id: "spreadsheet-builder-runway",
				userMessage:
					"turn this into a financial model: we have $180k in the bank, monthly burn of $32k (including $22k payroll), and we're about to sign a new contract worth $9k MRR starting next month. Build a runway model with scenarios.",
			},
			{
				id: "spreadsheet-builder-kpi-dashboard",
				userMessage:
					"make a KPI dashboard for our SaaS product: current MRR is $48k, 210 customers, average contract value $228/mo, monthly churn around 3.5%, and CAC of about $850 with a $1900 average LTV. I want to see if we're healthy and what would change that read.",
			},
		],
	},
];
