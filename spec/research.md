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
