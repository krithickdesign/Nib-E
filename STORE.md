# Nib-E in the Microsoft Store

Why: the Store signs the app for free, so people **never see the blue
"Windows protected your PC" window**, and the Store **updates Nib-E
automatically** (Nib-E itself still never goes online).

Cost: nothing. Registration for individual developers is free; you verify
your identity once (ID photo + selfie).

The Store build is a separate **Store edition**: it has no "Get the latest
version" link (the Store handles updates) and shows "Microsoft Store edition"
in Settings and About.

## One-time setup

### 1. Developer account (you, ~30 min)
1. <https://storedeveloper.microsoft.com> → **Get started** → *Individual*.
2. Sign in with a Microsoft account, verify your identity, accept the agreement.
3. **Publisher display name:** `Axiomate Technologies` (placeholder brand; it can be
   changed later in Partner Center → Account settings). If you change it, also run
   `npm run publisher:set -- "New Name"` and update the GitHub variable
   `MSIX_PUBLISHER_NAME`; the three must match exactly.
4. If Partner Center asks whether you are a **trader** (EU Digital Services Act):
   a free app with no income is normally *non-trader*. Read the question carefully;
   if in doubt, ask before answering.

### 2. Reserve the name (you, 2 min)
Partner Center → **Apps and games → New product → MSIX or PWA app** → reserve **Nib-E**.
A reserved name is kept for about 3 months without a submission.

### 3. Copy the identity into GitHub (you, 5 min)
Partner Center → Nib-E → **Product management → Product identity**. Then GitHub →
**Settings → Secrets and variables → Actions → Variables tab → New repository variable**:

| Partner Center shows | GitHub variable |
|---|---|
| Package/Identity/Name | `MSIX_IDENTITY_NAME` |
| Package/Identity/Publisher (starts with `CN=`) | `MSIX_PUBLISHER` |
| Package/Properties/PublisherDisplayName | `MSIX_PUBLISHER_NAME` |
| Store ID (12 characters, e.g. `9N1234ABCD56`, under *Product identity*) | `MS_STORE_ID` |

`MS_STORE_ID` makes the website show **"Get Nib-E from the Microsoft Store"** as the
main Windows button (GitHub download below it) and adds a Store link to release notes.
Set it once the listing is live; before that, the website says "on its way".

### 4. Build the Store package
**Actions → Release → Run workflow** with the next version. When it is done:
run page → **Artifacts** → download `Nib-E-<version>-store-msix` and unzip it. Inside:
- `Nib-E_<version>_x64.msix`: the file for Partner Center
- `stage/` and `test-local.ps1`: to test on your own PC first

### 5. Test on your PC first (recommended, 10 min)
1. Windows **Settings → System → For developers → Developer Mode: On**.
2. PowerShell in the unzipped folder:
   `powershell -ExecutionPolicy Bypass -File .\test-local.ps1`
3. Open Nib-E from the Start menu. Check: Settings shows *Microsoft Store edition*,
   no *Get the latest version* button, a PDF opens with *Open with → Nib-E*, Save works.
4. Remove the test install: `powershell -ExecutionPolicy Bypass -File .\test-local.ps1 -Remove`

### 6. First submission (you, ~30 min, then 1–3 days review)
All texts are ready in [store/STORE-LISTING.md](store/STORE-LISTING.md), screenshots in
`store/screenshots/`.

| Section | What to do |
|---|---|
| Pricing and availability | Free, all markets |
| Properties | Category *Productivity*; privacy policy URL `https://<user>.github.io/<repo>/legal.html#datenschutz` |
| Age ratings | Questionnaire: answers in STORE-LISTING.md |
| Packages | Upload the `.msix` |
| Store listings | English (and German): paste from STORE-LISTING.md, add the 5 screenshots |
| Submission options → restricted capability | Paste the *runFullTrust* text from STORE-LISTING.md |

**Before submitting:** fill in `docs/legal.html` (Impressum); the privacy policy URL must work.

## Every update after that (~5 min of your time)
1. **Actions → Release → Run workflow** with a new version.
2. Download the new `.msix` from the run's Artifacts.
3. Partner Center → Nib-E → **Start update** → Packages → replace the file →
   update *What's new* → **Submit**.
4. After approval, the Store updates everyone's Nib-E by itself.

## Notes and risks
- GitHub installers (`.exe`, `.msi`) stay available for people who don't use the Store.
- Store and GitHub versions are separate installs with **separate study notes**:
  move notes with a `.nibe` backup (Toolbox → Study mode → Back up).
- **Uninstalling the Store version deletes its study notes and settings** (Windows
  removes Store app data). Back up first.
- The Store package was prepared and checked on Linux but **not yet tested on real
  Windows**. Do step 5 first. If Partner Center rejects it, send the error text.
