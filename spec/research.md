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
| TabPFN-3.5 checkpoint download | 🔑 **PENDING-TOKEN** — no `TABPFN_TOKEN` in Doppler muse/dev (checked Oct 20; signup in flight) |
| V3.5 fit without token | Blocked exactly as documented: `TabPFNLicenseError` — accept the license on the Licenses tab at ux.priorlabs.ai, copy the API key from /account, set `TABPFN_TOKEN` |
| Stand-in timing (TabPFN **V2** checkpoint, 200 pooled rows, DESIGN §3 shape) | **fit+predict 115.1 s**, peak RSS **585 MB** |
| V2 checkpoint size (in `~/.cache/tabpfn`) | 44 MB (`tabpfn-v2-regressor.ckpt`) |

Kill-criterion check: install worked through the VM proxy; stand-in
200-row fit+predict is ~5× inside the ~10 min ceiling. **No kill.**
The V3.5 timing leg runs the moment `TABPFN_TOKEN` exists (S9/S10 are
marked 🔑 for exactly this).

## S2 — Ollama spike (Oct 20)

- Install: the official script needs `zstd` for extraction; the first
  attempt failed on it (`apt` package lists were stale — `zstd` landed
  at `/usr/bin/zstd` from a later apt update). Binary: **Ollama 0.40.6**
  at `/usr/local/bin/ollama`.
- Serve command for this VM (no systemd): `ollama serve` as a
  background process.
- `gemma3:4b` pull: in progress at the time of writing (slow proxy,
  ~1.3 MB/s). Benchmark numbers (tokens/sec, load time, `keep_alive: 0`
  unload, peak RSS) land here when the pull completes.
