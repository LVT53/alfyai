# RC-F · the final re-check before the last deploy: walk it like the owner (report only)

Everything of Wave 4 is merged on `feat/artifacts` except FX-E (the chat's Mermaid hardening, still running; leave it out).
Before the owner walks ai.dev, check two things and report; **do not fix** (one fix agent follows from your report).

- Worktree `.claude/worktrees/rc-f` (detached at the head the orchestrator names), port **5520**, label `rcf`. Report:
  `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/rcf-report.md`;
  screenshots `…/w4/shots/rcf/` (at most 16, each looked at).
- Read: `wave-4/common.md` (+ Wave 3 rules); `progress.md`'s Wave 4 table (what each agent did and left open); RV-F's review
  (`wave-4/rvf-review.md`); rulings 67, 71–75; AGENTS.md's Canvas and Tours subsections.

## 1. Each RV-F finding is closed (I-1–I-3, M-1–M-3, M-6, M-7, M-11), with the evidence named, and nothing they touched broke.

## 2. Walk like the owner — a production build on your port, a scratch DB, real pointer, keyboard, touch and wheel input,
Hungarian, at 1440, 1280 and 1100 with the panel docked, and 390; light and dark. Use the real model through a tunnel on
local port **30406** (`ssh -N -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none -L 30406:192.168.1.96:30000
alfyroot`, model `qwen3-6-27b`, in the same command; a few bounded prompts only) for the Canvas flows, the e2e fake provider
for the rest:
- **Canvas** (the owner's round): ask Alfy for a board with notes, a chart and a flowchart, then "add a note about X next to
  Y" and "put a chart in the Saturday frame" — where do they land, does anything overlap or peek out (CV-A's screenshot
  showed a stray text fragment between two notes), is the diagram a real diagram; edit what was inserted (a note, a
  checklist, a chart's data, a diagram's source, a map's title, a File's open) by mouse and on a phone; the selection
  toolbar near the top; the touchpad (two-finger pan, pinch, Ctrl/⌘+wheel, no back-swipe, a scroll over a note being
  typed in); the phone keyboard over a low note.
- **Chat:** the card at 1100/1280 docked, the Sources "Made in this chat" rows (and a deleted item's), a fork's copied rows,
  the follow-up chips and the title in a Hungarian chat, "Írj egy e-mailt angolul…" (only the email in English).
- **Panel and dialogs:** a project's Files dialog → open an item → Tab, Escape, a click on the ring, inside the Versions and
  Download popovers (in the dialog, in the chat's expanded panel and on the Knowledge page), browser Back.
- **Tours:** first open of each kind for a fresh user, replay, an incognito chat.
Note everything that looks wrong, moves, clips, reads oddly in Hungarian or takes more than one try.

## Report

Findings by severity (Critical / Important / Minor) with steps and file:line where known; a verdict (**ready to deploy** /
**not ready**). Your final reply is at most 12 lines: verdict, your model ID, counts, the top findings in one line each,
the screenshot paths to look at.
