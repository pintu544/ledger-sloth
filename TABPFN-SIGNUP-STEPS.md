# TabPFN license signup — Pintu's steps (do this yourself, ~5 minutes)

> Why: Ledger Sloth runs TabPFN-3.5 **locally** on the VM. The model weights are
> under Prior Labs' **non-commercial license (TABPFN-3-5 License v1.0)** and can
> only be downloaded after a named account accepts that license. The VM is
> headless (no browser), so the build cannot do the browser pop-up flow — it
> needs the token this signup produces. Verified Oct 20, 2026 against the
> `tabpfn` package docs (PyPI `tabpfn` 9.2.0 README/FAQ) and Prior Labs docs.

## The click-path

1. Go to **https://platform.priorlabs.ai** (this is the site the DEV "Best Use
   of TabPFN" category names for the license).
2. **Sign up / create an account** with **pksharmagh4@gmail.com** (the CV
   identity used for hackathon signups). Verify the email if asked.
3. Open the **Licenses** tab in the platform.
4. Find **TabPFN-3.5** and **accept the non-commercial license**
   (TABPFN-3-5 License v1.0). Accepting only unlocks the weights download —
   Prior Labs states your datasets are never sent to them.
5. Go to **https://platform.priorlabs.ai/account** and copy your **API key /
   token**.
   - If the token instead lives in the TabPFN app: sign in at
     **https://ux.priorlabs.ai**, open the **License** tab, accept there, and
     take the token from your account page (the `tabpfn` package FAQ points to
     ux.priorlabs.ai for token retrieval — same Prior Labs account).
6. **Hand the token back to Muse** (paste it in chat or drop it in the Secure
   Vault — never commit it to the repo).

## How the token reaches the build

- The build reads it from the environment variable **`TABPFN_TOKEN`** (set in
  the VM shell / a gitignored `.env`, never in code or git).
- With `TABPFN_TOKEN` set, the first `TabPFNRegressor`/`TabPFNClassifier`
  `fit()` downloads the TabPFN-3.5 checkpoint
  (`tabpfn-v3.5-20260909.safetensors`, one file for both classifier and
  regressor) into the local cache (`~/.cache/tabpfn/`).
- After that one download, **everything runs offline** — statements never
  leave the machine.

## Fallback if the token flow fails

The weights can also be downloaded manually from Hugging Face
(`Prior-Labs/tabpfn_3_5`) after accepting the license there, and placed in the
cache dir (or pointed to via `TABPFN_MODEL_CACHE_DIR`). Same license, same
account — just tell Muse which path worked.
