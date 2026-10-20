# GRILL (DRAFT) — Hacktoberfest Week 3: "Slow and Steady"

> **Status: DRAFT for Pintu's approval — GRILL step only. No SPEC, DESIGN, TASKS, or code yet.**
> Prepared: Tue Oct 20, 2026. Theme and judging verified live from the official challenge page today.
> Per the spec-driven skill, research is filed here with sources (§5) — nothing in this doc rests on memory alone.

## 0. Ground truth (verified Oct 20, 2026)

- **Theme:** "Slow and Steady" — *build something with open-weight models or open-source AI that rewards laziness; something that does the work so you don't have to.* Organizers' own example ideas, verbatim: "a local agent that reads your group chats overnight and hands you a two-line summary in the morning" · "a wind-down companion… running entirely offline" · "a fridge photo to grocery list tool" · "a file and inbox tidier that automatically sorts, renames, and archives the clutter you keep putting off."
- **The write-up must answer:** why open innovation matters *for this build* — runs with no internet? keeps personal messages/files on your own machine? set up once, never pay again? fine-tune / swap models?
- **Judging:** Writing Quality (**weighted most heavily**) · Prompt/Theme relevance · Creativity · Technical Execution · Use of Partner Technology (optional). One win max per submission; a project may enter every partner category it *genuinely* uses.
- **Deadline:** Oct 25, 23:59 UTC (≈ Oct 26, 05:29 IST). Pintu's plan: submit Oct 24 → ~4 build days, with the DEV post drafted by Oct 23 (writing is the top-weighted criterion — it cannot be a day-4 afterthought).
- **Hardware reality:** this VM = 2 vCPU / 7.7 GB RAM / no GPU / no Docker; Node 24, Python 3.12. Pintu's Windows machine specs are unknown (GRILL Q4). Any 4B-class Q4 model fits in RAM (Qwen3 4B = 2.5 GB, Gemma 3 4B ≈ 3.3 GB via Ollama), but CPU generation speed on 2 vCPU is **unmeasured** — day-1 benchmark spike required before locking the model (skill rule: prototype the question, not the feature).

---

## 1. Ranked shortlist

### #1 — "While You Slept" — the overnight group-chat digest agent ⭐ RECOMMENDED

**Concept.** Drop in a WhatsApp group-chat export (`.txt` — a real format every phone produces). A local agent works through the day's messages in chunks and hands you one calm morning brief: a 2–3 line TL;DR, decisions that were made, questions that are waiting on *you*, action items with owners, and the links/numbers people shared that you'd otherwise scroll forever to find. You run it before bed; it thinks slowly all night; you read for two minutes with your coffee.

**Theme fit.** Maximum possible — this is the organizers' first example idea, almost word for word. The laziness payoff is visceral and universal: 400 unread messages → a two-minute read. And the theme word "slow" becomes the thesis: on a CPU the agent *is* slow, and that's fine, because it works while you sleep. Slowness as a feature, not an apology.

**Open-AI core story.** Three open pieces, each load-bearing, zero closed APIs, zero keys:
- **Gemma 3 4B** (open-weight, via Ollama) does map-reduce summarization: chunk summaries → merged brief → extraction of asks/actions. Gemma 3's library page explicitly lists summarization as a strength; 128K context; 140+ languages (matters for Hinglish chats).
- **Embeddings** (`embeddinggemma` via Ollama's JS `embed` API — verified in Ollama docs) dedupe near-identical forwards and cluster the chatter into threads before summarization, so the small model isn't wasting cycles on 30 copies of the same good-morning image caption.
- **Mastra** (open-source TypeScript agent framework) orchestrates the pipeline as a workflow — Mastra's own docs show agents pointed at a local Ollama endpoint (`http://localhost:11434/v1`), so the harness is open *and* local.

**Why-open-innovation-matters narrative (the writing that wins).** Group chats are the most private text in a person's life — family groups, housing-society groups, the work group where the real decisions happen. *No closed API version of this product should exist*: uploading your family chat to a third-party server so a model can summarize it is a trade almost nobody would accept if they thought about it for ten seconds. Open weights don't make this product cheaper — they make it *possible*. Supporting beats: works fully offline; ₹0 per run, forever; the model is swappable (the post can show the same fixture run through Gemma 3 4B vs Qwen3 4B and compare briefs — a small honest experiment judges love); and the closing line writes itself: "the fastest model would finish before you fall asleep. This one finishes before you wake up. That's the whole point."

**Partner-category options (all genuine, none bolted on).**
- **Best Use of Gemma — $200 (featured):** Gemma *is* the engine, run locally — exactly what the category text asks for.
- **Best Use of Mastra — $100:** the category text literally says "orchestrate an agent over open models."
- **Best Use of Sentry Agent Tracing — $100 (stretch):** per-chunk traces (latency, tokens) are the debugging story of the build; the category asks for exactly that. Tension with the privacy narrative — see Q8.
- Deliberately excluded: SerpApi (web search would break the offline story, and Pintu's existing SerpApi key is scoped to LiveDocs only).

**Technical risk: LOW–MEDIUM.** Everything is one language (TypeScript, the existing scaffold), one local HTTP dependency (Ollama), no accounts, no cloud. The real unknowns are quality and speed, both measurable on day 1 (see §4).

---

### #2 — "Tidy" — the folder janitor (file & inbox tidier)

**Concept.** Point it at the folder everyone dreads — Downloads. Tidy reads file *contents* (extracted text from PDFs/docs/code, names + metadata for the rest), clusters them semantically, and proposes a plan: folders, human-readable renames (`IMG_4021.pdf` → `2026-04-electricity-bill.pdf`), archive candidates. It shows the full plan as a dry run, moves **nothing** until you approve, never deletes anything, and keeps an undo log so every move can be reversed.

**Theme fit.** Very strong — the organizers' fourth example, verbatim ("sorts, renames, and archives the clutter you keep putting off"). The before/after folder tree is the most screenshot-able demo of the three concepts.

**Open-AI core story.** Local embeddings (`embeddinggemma` via Ollama) cluster files by meaning, not extension; **Gemma 3 4B** names and categorizes from extracted text; a **Mastra** agent holds the tools (list / read / propose / apply) behind a hard human-approval gate.

**Why-open-innovation-matters narrative.** Your files are the second thing you never upload to a stranger's API. Add the economics argument: a tidier that charges per file is absurd — local means set it up once, never pay again (one of the organizers' own suggested angles). And a genuinely interesting writing section the other concepts can't offer: *how do you let an agent touch your real files safely?* Dry run, approve, undo, never delete — a small essay on trustworthy automation.

**Partner-category options.**
- **Best Use of Gemma — $200 (featured)** and **Best Use of Mastra — $100**, same as #1.
- **Best Use of Auth0 for AI Agents — $100 (stretch, but a remarkable textual fit):** the category description literally includes "ask a person to approve a risky action before the agent takes it" — that *is* Tidy's core interaction. Wiring real Auth0 sign-in for the approval step in 4 days is the cost; flag as stretch only.

**Technical risk: MEDIUM.** More moving parts than #1: PDF text extraction, Office formats, images (Gemma 3 4B vision on CPU is slow — images would be name/metadata-only in v1), file-operation safety, and authoring a believably messy fixture folder. Each part is known tech; the risk is their sum inside 4 days.

---

### #3 — "Ledger Sloth" — the monthly money-chores agent

**Concept.** Drop in a bank/UPI statement CSV. The agent categorizes every transaction with a local LLM, writes a plain-English month-in-review ("food delivery up 23%; three subscriptions renewed silently; one charge looks wrong"), and runs **TabPFN** — Prior Labs' open-weight tabular foundation model, locally — to forecast next month's per-category spend and flag anomalous charges. Output: a clean report + a categorized CSV you can hand to an accountant or a spreadsheet.

**Theme fit.** Good, not literal: nobody's example list mentions expenses, but "the monthly chore everyone postpones" is squarely "a task they dread," and the overnight-batch shape fits "slow and steady."

**Open-AI core story.** Two open models doing two different jobs — Qwen3 or Gemma (Ollama) for language work, TabPFN-3.5 for tabular prediction. The "open ecosystem composes" story is the most sophisticated of the three.

**Why-open-innovation-matters narrative.** Bank statements are the third thing you never upload. Plus a fine-tuneability angle the others lack: you can teach it *your* categories and *your* merchants, locally, and it stays yours.

**Partner-category options.**
- **Best Use of TabPFN — $200 (featured):** the headline; the category text favors "TabPFN inside a wider prediction agent," which is exactly this shape.
- **Best Use of Gemma — $200 (featured)** if Gemma writes the narrative: two featured categories from one build is rare.

**Technical risk: HIGH.** TabPFN is Python/PyTorch inside a TypeScript scaffold (Python sidecar), a heavy install on a 7.7 GB RAM VM, and it requires signing TabPFN's non-commercial license at platform.priorlabs.ai before local use — a human step with an eligibility question. The forecast also creates an honesty burden: the write-up must benchmark it against a naive "same as last month" baseline or it overclaims. And a realistic Indian bank/UPI fixture has to be authored. Highest ceiling, highest chance of eating the schedule.

---

### Considered and rejected (one line each)

- **Fridge photo → grocery list** (organizer example): vision on CPU + a believable fridge-photo fixture problem, and it will be the most-copied idea of the week.
- **Offline wind-down companion** (organizer example): completion evidence is fuzzy ("did it relax you?"), and its most demoable feature — a generated voice — pulls toward closed TTS and against the open story.
- **Read-it-later digester:** live-page fetching is unreliable (paywalls, JS-heavy pages) — a flaky demo risk for a writing-weighted contest.

---

## 2. Recommendation

**Build #1, "While You Slept."** It is the organizers' own example (maximum theme relevance), it has the strongest and most honest why-open story of the week (privacy isn't a feature of this product — it's the *precondition*), it double-enters two partner categories without a single bolt-on (Gemma featured $200 + Mastra $100), and it is the only concept whose entire stack is TypeScript on the existing scaffold with no accounts, no licenses to sign, and no cloud. Its main risks (small-model quality, CPU speed) are both *measurable on day 1* and — uniquely — the speed risk converts into the essay's thesis. #2 is the fallback if Pintu wants the more visual demo; #3 only if he wants to chase the TabPFN featured prize and accepts the schedule risk.

---

## 3. GRILL questions — answers needed before SPEC can stabilize

*Format per the GRILL template: no "to be decided." Each question carries a recommended answer; it locks when Pintu confirms or overrides.*

### Q1 — Which concept?
**Blocks:** everything.
**Options:** #1 While You Slept / #2 Tidy / #3 Ledger Sloth.
**Recommended:** #1.

### Q2 — Completion evidence: what is the ONE demo that proves it works?
**Blocks:** SPEC's acceptance criteria and the DEV post's demo section.
**Recommended (for #1):** one command — `npx tsx src/index.ts digest fixtures/society-group.txt` — run against a fixed fixture chat, producing a `digest.md` whose TL;DR, decisions, "waiting on you," and action items can be checked line-by-line against the fixture by hand. If a judge can't verify the brief against the source chat in two minutes, the demo has failed. (Plus one screenshot of the rendered digest for the post.)

### Q3 — Inference runtime: Ollama server vs in-process?
**Blocks:** stack, setup instructions in the post, and how a reader reproduces the demo.
**Options:** (a) **Ollama** — separate local server, `ollama` npm client (v0.6.4) or its `/v1` endpoint; model swap = one string; runs identically on this VM and on Windows. (b) **node-llama-cpp** (v3.22.2, llama.cpp bindings) — GGUF in-process, no server, but native binaries and more setup friction.
**Recommended:** (a) Ollama. Zero native-build risk on either machine, and "install Ollama, pull one model, run one command" is the most reproducible story for readers.

### Q4 — Model, and where does inference actually run?
**Blocks:** performance requirements, the featured-category entry, and the license paragraph of the post. Two sub-decisions:
- **Model:** Gemma 3 4B (featured Gemma category; summarization strength; 140+ languages; but *open-weight under the Gemma Terms*, not an OSI license — the post must say "open-weight," never "open-source," for Gemma) vs Qwen3 4B (Apache 2.0 — the whole Qwen3 family, verified; 2.5 GB; strong multilingual/Hinglish; no featured category). **Recommended:** Gemma 3 4B as primary, with a documented swap-run against Qwen3 4B in the post (the swap *is* the open-innovation argument, demonstrated). Day-1 spike benchmarks both on the real hardware before this locks.
- **Machine:** this VM (2 vCPU — honest but slow numbers) vs Pintu's Windows machine (specs unknown — **Pintu: what CPU/RAM?**) vs a DigitalOcean GPU Droplet (featured $200 category; credits via hacktoberfest promos; but adds account setup and moves inference off "your machine," weakening the privacy demo). **Recommended:** develop + demo on local hardware (VM and/or Windows); DO droplet only if local speed makes the demo unusable.

### Q5 — Input contract: which formats are in v1?
**Blocks:** parser scope — the silent schedule-killer in every "agent that reads X" build.
**Recommended (for #1):** WhatsApp `.txt` export ONLY (both Android and iOS export shapes), plus a `--since` date filter. Telegram JSON, email/mbox, and paste-a-URL are explicitly out of scope. One format, parsed properly, beats four formats parsed hopefully.

### Q6 — Interface: CLI, web UI, or agent-with-schedule?
**Blocks:** TASKS size and the post's screenshots.
**Recommended:** CLI core that emits a single self-contained `digest.html`/`.md`. No server, no frontend build — the scaffold stays the product. The "agent" quality comes from the Mastra workflow (chunk → dedupe → summarize → merge → extract), not from a chat UI. A real overnight daemon/cron mode is documented as a stretch, not built.

### Q7 — Language honesty: what do we claim about Hinglish?
**Blocks:** the post's claims and the fixture design. Real Indian group chats are Hinglish + emoji + voice-note placeholders ("<Media omitted>").
**Recommended:** claim English-first, and *test* Hinglish with a mixed fixture section, reporting what actually happened (both Gemma 3 and Qwen3 advertise strong multilingual support — the post reports our measured result, not the brochure). Media-omitted lines and system messages (encryption notices, "X added Y") must be filtered by the parser, never fed to the model as content.

### Q8 — Privacy boundary: is "nothing leaves the machine" literally true?
**Blocks:** the post's central claim — if it's not airtight, the narrative collapses under one judge question.
**Recommended:** v1 makes **zero** outbound calls after model download: no telemetry, no cloud tracing. That means the Sentry Agent Tracing category is entered *only* if traces can be kept local/self-hosted or fully redacted — otherwise we skip Sentry and use Mastra's local observability + a run-metrics table (chunks, tokens, seconds per chunk) in the post instead. Decide now: **privacy claim is non-negotiable; Sentry is negotiable.**

### Q9 — Failure modes the build MUST handle (not "maybe")?
**Blocks:** SPEC boundary cases.
**Recommended list (for #1):** empty/1-message chats; a chat with no questions or actions (brief must say so, not invent some — hallucinated action items are the credibility-killer); a single message longer than the chunk budget; Ollama not running / model not pulled (fail with the exact fix command, not a stack trace); non-WhatsApp file passed in (detect and refuse clearly); digest regeneration must overwrite cleanly (idempotent, fixture rule 15).

### Q10 — Out of scope + post packaging (decide now, not on day 4)?
**Blocks:** scope creep and the top-weighted criterion.
**Out of scope (recommended):** multiple chat formats; real-time/daemon mode; sending the digest anywhere (no WhatsApp/Telegram/email send — the product *reads* exports, it does not touch accounts); voice notes transcription; a hosted public demo (the demo is a reproducible local run + screenshots/GIF in the post).
**Post packaging (recommended):** draft the DEV post skeleton on day 2 (title, the unread-messages hook, architecture, the model-swap experiment, honest latency table, why-open essay); fill in results on day 3; submit Oct 24. Categories declared: Gemma + Mastra (+ Sentry only per Q8). 

---

## 4. Frank risk assessment

| | Biggest technical unknown | Biggest writing / judging risk |
|---|---|---|
| **#1 While You Slept** | **Summarization quality + speed of a 4B model on 2 vCPU.** Chunked map-reduce on a ~500-message fixture could take 10–30 min locally (unmeasured — day-1 benchmark decides model and chunk size). Quality risk is hallucinated or missed "waiting on you" items; mitigated by extract-then-verify prompting and a fixture whose ground truth is known. | **Crowding.** It's the organizers' first example — dozens of entries will do a chat summarizer. The win must come from the writing (privacy-as-precondition essay + model-swap experiment + honest latency table) and from verifiable demo rigor, not from the idea alone. If the post reads like a product README, it loses. |
| **#2 Tidy** | **The sum of small parts:** PDF/doc text extraction quality, clustering coherence, and safe file ops — each fine alone, together they are the 4-day risk. Vision for images is effectively out (CPU), which a judge may poke at. | **Safety skepticism.** Judges will ask "would you let it touch *your* files?" — the post must prove the dry-run/approve/undo design with a real before/after, not assert it. Demo folder must feel real; a toy fixture with 6 files sinks credibility. |
| **#3 Ledger Sloth** | **TabPFN itself:** license sign-up step, heavyweight Python install on 7.7 GB RAM, Python↔TS sidecar plumbing — any one can eat a day. Forecast validity needs a naive-baseline comparison or the numbers are decoration. | **Overclaiming.** A "forecast" from a foundation model invites the question "better than just repeating last month?" If the honest answer is "about the same," the post must say so and pivot the value to categorization + anomaly flags — survivable, but it weakens the featured-category pitch. |

**Cross-cutting risk (all concepts):** model downloads (~2.5–3.3 GB) must work through this VM's egress proxy on day 1 — verify the Ollama pull early; if the VM chokes, develop against Ollama on Pintu's Windows machine instead. This is a 30-minute check that de-risks the whole week.

---

## 5. Research log (all fetched Oct 20, 2026)

- **Challenge page (theme, judging, category descriptions, FAQ):** https://dev.to/challenges/hacktoberfest-week3-2026-10-19 — theme "Slow and Steady," organizer example ideas, Writing Quality weighted most heavily, Gemma/Mastra/Temporal/Sentry/Auth0/SerpApi category texts, one-win-per-submission rule.
- **Gemma 3 on Ollama:** https://ollama.com/library/gemma3 — sizes 270M/1B (text), 4B/12B/27B (multimodal, 128K context), "excel in… summarization," 140+ languages; Gemma Terms of Use linked (open-weight, not OSI).
- **Qwen3 on Ollama:** https://ollama.com/library/qwen3 — 0.6B (523 MB), 1.7B (1.4 GB), 4B (2.5 GB, 256K context), 8B (5.2 GB); tool use; 100+ languages.
- **Qwen3 licensing:** the entire Qwen3 family shipped under Apache 2.0 (Apr 2025) — https://www.marktechpost.com/2026/10/04/the-story-of-qwen-alibabas-ai-models-from-7b-to-2-4t/ and https://mungomash.com/ai/qwen/versions/
- **Ollama embeddings (JS):** Context7 → https://docs.ollama.com/capabilities/embeddings and /api/embed — `ollama.embed({ model: 'embeddinggemma', … })`, `/api/embed` endpoint.
- **Mastra + Ollama:** https://mastra.ai/models/embeddings — `ModelRouterEmbeddingModel({ providerId: 'ollama', modelId: 'nomic-embed-text', url: 'http://localhost:11434/v1' })`; plus a DEV field report (Oct 2026) of Mastra agents against Ollama's `/v1` endpoint with `@mastra/core` 1.78.0: https://dev.to/amankumar_apiclaw/using-mastra-agents-with-a-custom-openai-compatible-api-the-url-model-config-the-silent-5-step-34oc
- **node-llama-cpp:** Context7 → /withcatai/node-llama-cpp — llama.cpp bindings for Node, prebuilt binaries, Metal/CUDA/Vulkan.
- **Temporal (Q6 stretch option):** https://docs.temporal.io/develop/typescript/set-up-your-local-typescript — `temporal server start-dev` runs a full local service from one CLI binary (no Docker), TS SDK v1.24.0.
- **npm versions checked live (Oct 20):** `ollama` 0.6.4 · `@mastra/core` 1.78.0 · `node-llama-cpp` 3.22.2 · `tesseract.js` 7.0.0 · `@temporalio/client` 1.24.0.

*Not yet verified (SPEC-step, if the concept is chosen): partner-credit claim flow at hacktoberfest.com/my/promos (Render/.tech credits); TabPFN-3.5 license-signup eligibility; CPU tokens/sec for gemma3:4b and qwen3:4b on this VM (day-1 benchmark spike).*
