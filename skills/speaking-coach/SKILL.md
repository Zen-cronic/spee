---
name: speaking-coach
description: Coach the user's speaking habits (unsure words such as "I guess", and the filler "like") through the Speaking Mirror hub, which grades from the user's Bee wearable. Use when the user asks how their speaking is going, wants a warm-up before a meeting or call, asks about their speaking goal, or wants a short if-then cue on their wrist before a conversation. Also run its heartbeat every few minutes to send one wrist cue before each calendar meeting.
---

# Speaking coach

This skill talks to the Speaking Mirror hub on the user's machine. The hub listens to Bee's live, wearer-tagged transcript, counts two practised habits (unsure words and the filler "like"), and reaches the wrist through Bee to-dos with alarms. Each command below is one call to the hub, and the script prints plain sentences you can pass on to the user.

## Before you start

- The hub must be running on this machine: `npm run hub` in the Speaking Mirror repo (or `npm run hub -- --demo` for synthetic data). Its `/api` routes answer this machine and the LAN only.
- The script uses `COACH_HUB_URL` if set, else `http://127.0.0.1:8791`. `--hub <url>` overrides both.
- Node 22.12 or later. No keys or tokens: the hub owns the Bee login.

## Commands

Run from the repo root: `node skills/speaking-coach/scripts/coach.mjs <command>`. Add `--json` for the structured answer instead of sentences.

| Command | When to use it | What it does |
|---|---|---|
| `status` | "How is my speaking going?" | Reads `GET /api/coach/now`: the coach's summary, whether live coaching is on, and how many practice lines are due |
| `brief` | "Warm me up", "I have a meeting soon" | Reads `GET /api/brief`: when the next meeting starts (never its title), the habit to watch, and one warm-up line to say aloud |
| `goal` | "What's my speaking goal?" | Reads `GET /api/coach/facts`: the coach's one goal fact in Bee, whether Bee has confirmed it, and Bee's fact and insight counts |
| `cue [--in N]` | "Remind me on my wrist before the call" | `POST /api/coach/cue`: one if-then cue, at most 60 characters, through the hub's wrist queue, with its alarm N minutes from now (default 0) |
| `heartbeat [--dry-run]` | On a schedule, every 2 to 4 minutes | Reads the brief and sends one cue when the next meeting starts in 8 to 12 minutes, once per meeting. `--dry-run` only says whether it would |

The hub picks the cue's habit and words. A cue only ever names a habit the user has already practised, never the one kept unpractised for comparison, and the hub refuses it during quiet hours, over its cap, or when cues are off. A repeat within its dedupe window comes back as "nothing new reached the wrist".

The heartbeat remembers which meetings had their cue by a hash of the start time, in `$COACH_SKILL_STATE`, else `~/.local/state/speaking-mirror/coach-skill.json` (`--state <file>` overrides). It needs the user's calendar connected in the Bee app; without one, the brief has no meeting and the heartbeat waits.

## Working with Bee's own skill

If Bee's official Agent Skill is installed, use it for the user's day, conversations, facts and to-dos in general. Use this skill for speaking practice. Two rules keep them from stepping on each other:

- Don't write speaking goals as Bee facts yourself. The hub keeps exactly one goal fact and updates it; `goal` shows it.
- Don't create wrist reminders about speaking with `bee todos create`. Use `cue`: the hub's queue applies the caps, the dedupe and quiet hours.

## Rules

- Never repeat a calendar title to the wrist or into a cue. The script never prints one; don't add it from another source.
- A model may phrase a recap, but the counts and verdicts are the hub's deterministic results. Report them as they are, with their time window ("this week", "this conversation").
- The goal fact may not be read by Bee's chat or by Alexa+. Say so if the user asks, as the `goal` output does.
- The before/after check is a pilot, not proof. If the user asks whether practice worked, run `status` and quote its result; don't claim more.

## Exit codes

`0` done (including "no cue yet"), `1` the hub did not answer or failed, `2` the hub refused (the message says why) or the command was wrong. The message on stderr is safe to show the user.
