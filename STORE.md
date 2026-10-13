# Nib-E in the Microsoft Store

Why: the Store signs the app for free, so people **never see the blue
"Windows protected your PC" window**, and the Store **updates Nib-E
automatically** (Nib-E itself still never goes online).

What it costs: nothing. Registration for individual developers is free;
you verify your identity once (ID photo + selfie).

## One-time setup (about 30 minutes, then a few days of Microsoft review)

### 1. Developer account
1. Go to <https://storedeveloper.microsoft.com> → **Get started** → *Individual*.
2. Sign in with a Microsoft account, verify your identity, accept the agreement.

### 2. Reserve the name
1. Partner Center → **Apps and games → New product → MSIX or PWA app**.
2. Reserve **Nib-E**. If it is taken, reserve a variant (e.g. "Nib-E PDF") and tell me,
   so the app name inside the package matches.

### 3. Copy the identity into GitHub
1. In Partner Center open the app → **Product management → Product identity**.
2. Copy three values:

   | Partner Center shows | GitHub variable name |
   |---|---|
   | Package/Identity/Name | `MSIX_IDENTITY_NAME` |
   | Package/Identity/Publisher (starts with `CN=`) | `MSIX_PUBLISHER` |
   | Package/Properties/PublisherDisplayName | `MSIX_PUBLISHER_NAME` |

3. GitHub repository → **Settings → Secrets and variables → Actions → Variables tab →
   New repository variable**, once for each of the three.

### 4. Build the Store package
1. **Actions → Release → Run workflow** (new version number, e.g. `0.5.1`).
2. When it is done, open that run → **Artifacts** → download
   `Nib-E-<version>-store-msix` and unzip it: inside is `Nib-E_<version>_x64.msix`.

### 5. First submission in Partner Center
| Section | What to enter |
|---|---|
| Pricing and availability | Free, all markets (or the ones you want) |
| Properties | Category *Productivity*; privacy policy URL: `https://<user>.github.io/<repo>/legal.html#datenschutz` |
| Age ratings | Fill in the questionnaire (no user content sharing, no ads, no purchases) |
| Packages | Upload the `.msix` file |
| Store listings | Description, at least one screenshot (1366×768 or larger; `docs/assets/*.webp` converted to PNG work) |
| Restricted capability *runFullTrust* | Explain: "Nib-E is a desktop (Win32) app packaged as MSIX; runFullTrust is required for desktop apps. It has no network access." |

Submit. Review usually takes 1–3 working days.

## Every update after that
1. **Actions → Release → Run workflow** with a new version.
2. Download the new `.msix` from the run's Artifacts.
3. Partner Center → the app → **Start update** → Packages → replace the file → Submit.
4. After approval, the Store updates everyone's Nib-E by itself.

## Notes
- The GitHub installers (`.exe`, `.msi`) stay available for people who don't use the Store.
- The Store version and the GitHub version are separate installs; Windows may show two "Nib-E" entries if someone installs both.
- First submission risk: this packaging was prepared but not yet tested on a real Windows
  machine. If Partner Center rejects the package, copy its error message and send it over.
