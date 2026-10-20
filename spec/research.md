# Research / spike log — Ledger Sloth

Measured on the real host: 2 vCPU / 7.7 GB RAM, no GPU, Python 3.12.3,
Node 24.20.0 (DESIGN §1 host decision). Numbers here are what the DEV
post cites — measured, never estimated.

## S1 — TabPFN spike (Oct 20)

| Leg | Result |
|---|---|
| CPU-only torch install (`torch --index-url https://download.pytorch.org/whl/cpu`) | **84 s** → torch 2.14.1+cpu |
| `tabpfn==9.2.0` install | **235 s** |
| venv size (`python/.venv`, torch + tabpfn + deps) | **1.4 GB** |
| `import tabpfn` | ✅ tabpfn 9.2.0 |
| TabPFN-3.5 checkpoint download | ✅ **876 MB** (`tabpfn-v3.5-20260909.safetensors`, in `~/.cache/tabpfn`) — one-time, token-gated; fully offline after |
| V3.5 fit without token | Blocked exactly as documented: `TabPFNLicenseError` — accept the license on the Licenses tab at ux.priorlabs.ai, copy the API key from /account, set `TABPFN_TOKEN` |
| **V3.5 timing (200 pooled rows, DESIGN §3 shape, token set)** | **fit+predict 38.7 s**, peak RSS **3,933 MB** (first-ever fit incl. checkpoint download/load: 677.1 s — download-dominated, proxy-shared) |
| Stand-in timing (TabPFN **V2** checkpoint, same 200 rows) | fit+predict 115.1 s, peak RSS 585 MB |
| V2 checkpoint size (in `~/.cache/tabpfn`) | 44 MB (`tabpfn-v2-regressor.ckpt`) |

Kill-criterion check: install worked through the VM proxy; V3.5
200-row fit+predict (38.7 s) is ~15× inside the ~10 min ceiling.
**No kill — S1 fully complete.**

⚠️ **RAM note for S9:** measured V3.5 peak RSS is **3.9 GB**, roughly
double DESIGN §1's ~2 GB estimate. Sequential residency still fits
(TabPFN 3.9 GB + Node ~0.2 GB ≪ 7.7 GB), but simultaneous residency
with Gemma (~4–4.5 GB) would exceed the box — DESIGN's spawn-per-run
decision (§2) is doing real work; do not relax it.

Transient-failure note: the first token-verification attempt failed
with "could not reach the license server" while the Ollama tarball
download was saturating the proxy (tabpfn verifies via a 10 s-timeout
urllib call to `api.priorlabs.ai/protected/`). A controlled retest
(curl + urllib, both proxies) returned HTTP 200 and the retry
succeeded — the worker's pre-flight should treat this error as
retryable, not as "token invalid."

### Cookbook references for S9/S10 (Prior Labs cookbook, Oct 20)

DESIGN remains the authority; these are implementation reference only:

- **"Forecast Related Time Series with TabPFN 3.5"** — individual vs
  pooled regressors with date/Fourier/autoregressive features. Our
  pooled choice (§3) matches their guidance; lag / rolling-mean /
  seasonal feature ideas may enrich the sample builder *if* the FR-9
  benchmark supports it.
- **"Get Started with Predictive Distribution"** — `TabPFNRegressor`
  predictive distributions: if cheap, the report's forecast can carry
  an expected range instead of a bare point estimate (fits FR-9's
  honesty angle).
- **"Faster Inference with KV Cache"** (`fit_with_cache`) — relevant
  to the per-transaction amount predictions (the `amounts` job).
- **"Credit Card Fraud Detection with TabPFN"** — reference for
  anomaly-flag framing and reason strings (§3 thresholds stay ours).

## S2 — Ollama spike (Oct 20)

- Install: the official script needs `zstd` for extraction; the first
  attempt failed on it (`apt` package lists were stale — `zstd` landed
  at `/usr/bin/zstd` from a later apt update). Binary: **Ollama 0.40.6**.
- Serve command for this VM (no systemd): `ollama serve` as a
  background process.
- ⚠️ **VM-restart lesson (Oct 20):** a runtime restart wiped
  `/usr/local` — the installed binary (and `zstd`) vanished; the home
  volume (venv, checkpoints, fixtures) survived. Reinstall therefore
  targets **`$HOME`** (`~/ollama-dist`), never `/usr/local`.
- Pull saga (root cause found): Ollama's **Go HTTP client cannot
  traverse this VM's egress proxy** — the registry manifest request
  either failed TLS ("first record does not look like a TLS
  handshake") or hung with an established-but-dead tunnel, through
  both the system proxy and the local forwarder, while **curl and
  Python reached `registry.ollama.ai` in ~1 s through both**. Same
  client class as the Rust/Chromium proxy failures in TOOLS.md.
  **Fix used:** fetched the manifest + all 6 blobs with curl into
  Ollama's on-disk layout (`~/.ollama/models/blobs/sha256-…` +
  `manifests/registry.ollama.ai/library/gemma3/4b`), each blob
  **sha256-verified against the manifest** — the installed model is
  byte-identical to `ollama pull gemma3:4b` (3.4 GB: 2.50 GB model +
  0.85 GB projector + template/license/params/config). Only the
  transport differs. On any machine where `ollama pull` works, prefer
  it; the SPEC's user-facing fix commands are unchanged.
- **Benchmark (Oct 20, this VM, gemma3:4b via Ollama 0.40.6):**

  | Measure | Result |
  |---|---|
  | Model load (first call) | 36.6 s |
  | Categorization batch (24 narrations, temp 0) | wall 76.6 s incl. load; prompt eval 420 tok in 18.2 s; eval 144 tok at **6.64 tok/s** |
  | Narrative generation | 267 tok at **6.57 tok/s**, wall 57.6 s |
  | Peak RSS (model resident) | **3,773 MB** |
  | Unload (`keep_alive: 0`) | `/api/ps` empty afterwards; server RSS falls to 34 MB ✅ |

  Kill-criterion check: narrative-length generation is 58 s vs the
  ~5 min ceiling — **no kill, S2 complete.** Combined with S1:
  sequential peaks are Gemma 3.8 GB / TabPFN 3.9 GB — never together
  (§2's spawn-per-run + `keep_alive: 0` discipline is what makes the
  7.7 GB box work).
  ⚠️ **S6 warning from Bench 1:** the ad-hoc batch response's array
  did not perfectly track input order (drift visible after index ~5).
  The production categorizer must validate reply length and map
  results positionally with the DESIGN's invalid→`Other` fallback —
  batching needs engineering, not trust.

## S5 — Rules + correction memory coverage (Oct 20)

Measured over the S3 fixture (249 transactions, empty memory file):

| Measure | Result |
|---|---|
| Rows categorized by rules+memory (no Gemma) | **249 / 249 — coverage 100%** |
| …of which memory / rule | 0 / 249 |
| Leftovers passed to Gemma | 0 |
| Rules+memory accuracy vs ground truth | **249 / 249 (100%)** |

Why so high: the fixture's persona uses 28 regular narration
templates (salary, rent, Swiggy/Zomato/Uber, BigBasket, subscriptions,
P2P names, ATM), and the ordered rule table covers each template plus
the precedence traps (NOTION LABS → Subscriptions not Health;
AMAZON FRESH → Groceries; JIO RECHARGE ↛ Fees). A real statement's
long tail of one-off merchants is exactly what Gemma (S6) exists for —
on this fixture it is the rules, not the model, that carry the number,
and the post will say so.

## S6 — Gemma categorizer, live verification (Oct 20)

Measured against the real Ollama 0.40.6 + gemma3:4b on this VM
(server started from `~/ollama-dist/bin/ollama serve`):

| Check | Result |
|---|---|
| Dead server | `OllamaUnavailable` with the exact `ollama serve` fix, no stack trace ✅ |
| Full pipeline over fixture (memory→rules→Gemma) | **accuracy 249/249 (100%)**, sources: memory 0 / rule 249 / gemma 0 / other 0 |
| Gemma alone, every-10th-row sample (25 real narrations) | **23/25 (92.0%)**, 192 s, 2 requests, 0 invalid rows, 0 failed batches |
| Gemma alone, 8 synthetic *unseen* merchants (rules-misses by construction) | **8/8** — Zudio→Shopping, Bikanervala→Food & Dining, Zoom→Subscriptions, Dr Lal PathLabs→Health & Pharmacy, Wendy's→Food & Dining, The Decor Store→Shopping, Kalyan Jewellers→Shopping, EaseMyTrip→Transport |
| Unload discipline | after the stage's final (`keep_alive: 0`) request, `/api/ps` is empty ✅ |

The two Gemma-only misses are instructive, not alarming: an incoming
P2P credit (`UPI-ANITA KUMAR-…`) read as Income where ground truth
says Transfers, and a Jio prepaid recharge read as Subscriptions
where our taxonomy says Utilities & Bills. Both are cases the
deterministic layer resolves by construction — which is the design
working as intended: rules carry the taxonomy's edge conventions,
the model carries the open world.

## S9 — TabPFN worker + client, measured on the fixture (Oct 20)

Worker (`python/worker.py`, spawn-per-run, one JSON over stdio) +
client (`src/tabpfn/client.ts`: preflight token → venv → checkpoint,
deterministic DESIGN §3 sample builders, data-driven job selection).
Full fixture round trip (249 txns, 4 months, all three jobs):

| Measure | Result |
|---|---|
| Fit seconds (worker meta) | forecast 6.5 · benchmark 2.3 · amounts 22.5 (~31 s + startup) |
| Forecast keys | exactly the 12 spend categories with history — no Income, no zero-history `Other`, no fabricated ₹0 |
| Benchmark (held-out Sep 2026) predictions vs actual | close on steady categories (Rent 28,005 vs 28,000; Food & Dining 14,828 vs 14,641; Transport 4,195 vs 4,008) — Shopping 5,795 vs 36,147, because Sep's actual contains the planted anomaly. The FR-9 verdict itself is S10's to compute |
| Amounts coverage | all 243 debits scored |
| License path | the venv runs v3.5 from the cached `~/.cache/tabpfn/auth_token` + checkpoint — `TABPFN_TOKEN` need not be in the shell env (verified with the var unset); preflight accepts either |

**⚠️ Finding for S10 — target leak in the amounts features.** The
expected amount for the planted CROMA anomaly (id 220, ₹32,999) came
out **₹21,834 — a ratio of only 1.51×**, which does NOT cross DESIGN
§3's flag rule (actual > 2.5× predicted AND gap > ₹1,000; the gap,
₹11,165, passes — the ratio fails). Mechanism: CROMA occurs exactly
once in the fixture, so the §3 `merchantMedian` feature for that row
is the anomaly's own amount (₹32,999) — the feature leaks the target.
The category median is clean (₹1,774). Candidate remedy for S10 to
decide: leave-one-out merchant median (median of the merchant's
*other* debits, falling back to the category median when the merchant
has only one) — same feature names, no target in the feature. S9
ships the DESIGN-literal features; the flag test is S10's.

## S10 decision — leave-one-out merchant median in `buildDebits` (Oct 20)

**Decided (parent) and applied:** the `merchantMedian` feature built
in `src/tabpfn/client.ts` (`buildDebits`) is a **leave-one-out
median** — the median of the merchant's *other* debits — falling
back to the category median when the merchant has only one debit.
Feature names and the worker protocol are unchanged; Python still
only fits/predicts on the rows TS hands it.

**Rationale — methodology beats DESIGN-literalism here.** DESIGN §3's
literal merchant median includes the row being scored, so for a
single-occurrence merchant the feature *is* the target: the planted
CROMA charge's `merchantMedian` was its own ₹32,999, and the model
reasonably predicted ₹21,834 (ratio 1.51×) — under §3's own flag rule
(> 2.5× and gap > ₹1,000) the fixture's one planted anomaly would
never flag, failing the SPEC's anomaly acceptance ("the planted
anomalous charge appears in the report's anomaly list") by
construction, not by model quality. A feature that contains the
answer is a leak in any methodology review; removing it keeps the
feature set, the thresholds, and the pooled philosophy of §3 intact
while making the acceptance testable. The category median is *not*
leave-one-out: it aggregates dozens of rows per category, the S9
measurement showed it clean (₹1,774 for Shopping), and changing it
was not needed to close the leak.

**Measured follow-up (same day): the feature fix alone was not
enough.** With LOO features, the amounts model still "expected"
**₹20,294** for the CROMA row (ratio 1.63×) — because DESIGN §3's
amounts protocol fits on all debits and predicts the same rows, and
TabPFN is an in-context learner: the row sits in its own context
with target ₹32,999, under a `merchantKey` ("croma") that occurs
exactly once, and the prediction is pulled toward it. Every other
Shopping row predicted ₹1,500–2,800 on near-identical features, so
the pull is the self-row, not the features. **Remedy applied in the
worker: the amounts job is now K-fold cross-fitted (5 deterministic
folds by id order)** — each debit is predicted by a model fit on the
other folds only; a row is never scored by a model that saw it. This
deviates from §3's "fit on all debits, predict all debits in one
batched call" in the same spirit as the median fix: self-scoring an
anomaly detector on its own training rows is a leak, and the
one-batched-*request* protocol (§2) is untouched — the folds live
inside the single worker invocation. Forecast/benchmark jobs are
unchanged: their test rows are constructed future/held-out months,
never training targets.

## S13 — Failure-mode sweep + adversarial QA (Oct 20, real end-to-end runs)

Every SPEC failure mode exercised with real CLI runs (not just the
unit suite), on the shipping code at `6517267` unless noted:

| Mode | Run | Observed | Verdict |
|---|---|---|---|
| (a) TabPFN unavailable | `HOME=/tmp/s13/fakehome` (no token, no cache) | exit 0, report produced; forecast section = "Forecast unavailable because TABPFN_TOKEN is not set…", anomaly section the matching explicit note; no table, no verdict, no invented numbers | ✅ |
| (b) Single-month input | Sep-2026-only extract (63 rows) | forecast section = "No forecast: this statement covers a single month, and at least two months of history are needed… Nothing is extrapolated from one month."; anomalies still ran; **CROMA flagged** (~22× the ~₹1,513 expected); amounts job only | ✅ |
| (c) Ollama down | network namespace, loopback up, no server | exit 1, message carries the exact fix (`ollama serve`), no stack trace, **out dir never created — zero partial artifacts** | ✅ |
| (d) Garbage CSV | prose file / empty file / unknown headers | all exit 1 with plain messages; unknown-columns variant lists the headers found + the readable shapes; no artifacts in any variant | ✅ |
| (e) Fully offline | network namespace with **no egress route at all** (curl to example.com fails), Ollama serving inside the namespace | full run completes exit 0; FR-9 verdict identical (TabPFN MAE ₹2,806.45 vs naive ₹2,558.75); accuracy 100% | ✅ |

**Reproducibility (real runs):** `categorized.csv` is byte-identical
across three full runs — online, offline (namespace), and post-fix.

**Adversarial inspection of the happy-path outputs** (`report.md` /
`report.html` / `categorized.csv` from a fresh demo run): anomaly
section shows exactly the one CROMA flag with its reason (₹32,999,
~17× the ~₹1,939 expected); FR-9 verdict printed plainly — **naive
won: TabPFN MAE ₹2,806.45 vs naive ₹2,558.75**; Shopping forecast
**₹82,866.32** shown raw with the anomaly-context note beneath the
forecast table; FR-11 metrics block complete (249 rows / 2 excluded,
per-stage seconds with per-job fits, sources 0/249/0/0, gemma3:4b via
Ollama 0.40.6, tabpfn 9.2.0, checkpoint 835.4 MiB, Python env
1328.6 MiB, host 2 vCPU · 7.7 GB); `categorized.csv` = 249 rows +
header; `report.html` contains **zero external references**.

**Narrative caveat — verdict: the sentence was WRONG.** The live
narrative wrote "a significant increase of ₹52,740" for Shopping:
₹52,740 is Shopping's *whole-period* (4-month) total; September's
actual month-over-month change was **+₹30,148** (to ₹36,147). A
month-in-review reader takes away a false increase. Value-only
grounding passed it because the figure exists in the payload — in
the wrong scope. A second instance of the same class: the
single-month run wrote a correct total with mangled digit grouping
("₹11,1622").

**Fix (commit `18553ee`):** grounding is now three checks, not one —
a figure must (1) exist in the payload, (2) be written in
well-formed digit grouping (Indian or international), and (3) be
used in its proper scope: whole-period-only figures
(`wholePeriodByCategory`, `topMerchants`) may appear only with
whole-period framing (`findMisScopedFigures`). The system prompt
states the scope + grouping rules up front; failures feed the same
sterner-retry → templated-fallback path. 4 new tests (suite now
**149**, tsc clean).

**Post-fix verification run:** both Gemma drafts failed the stricter
checks on genuinely bad figures — an invented ₹52,747, per-category
benchmark errors (₹140, ₹131) the model derived itself (the payload
carries only the MAEs, so citing them is ungrounded by design), a
period total used unframed (₹40,000), a ×10 slip (₹11,20,000), and
malformed groupings of real values — and the report substituted the
deterministic template, disclosing the substitution in the report
body and metrics, exactly per DESIGN §7. Probes against the real
payload confirm no false positives: correctly written, correctly
scoped citations of ₹30,148 and ₹1,11,622 pass all three checks.
Trade-off, stated plainly: stricter grounding raises the
template-fallback rate and a failed attempt costs a second
generation (this run's narrative stage: 375 s). The template is
accurately scoped by construction, so the report is never wrong —
at worst it is plainer.
