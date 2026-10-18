# Releasing Nib-E

## Every update

| # | Step | Where | Result |
|---|---|---|---|
| 0 | **Fetch origin, then Pull** before copying new files in | GitHub Desktop | Your copy matches GitHub; no conflicts with commits made on github.com |
| 1 | Copy the delivered files into the repo folder | File manager | Changes show up in GitHub Desktop |
| 2 | Commit (one heading + summary from the delivery), Push origin | GitHub Desktop | Website and web app update by themselves (Actions → Website ✅) |
| 3 | Actions → Release → Run workflow (leave the version empty) | github.com | Release vX.Y.Z with installers and SHA256SUMS.txt; Store package (.msix) as artifact |
| 4 | Partner Center → Nib-E → Update → Packages: replace the .msix, paste "What's new" (store/STORE-LISTING.md), Submit | Partner Center | Store users get the update after review (1–3 days) |
| 5 | Flathub: merge the bot's pull request (first time: see flatpak/README.md) | github.com/flathub | Flatpak users get the update |

## Rules

- The version is set in the delivery (`npm run version:set -- X.Y.Z`). Leave the Release version field empty.
- A version can only be released once. Fixes go into the next patch number.
- One Store submission can be in review at a time.
- Store package versions must keep going up; the Release workflow does this.
- Never commit personal files (invoices, IDs) from testing. `docs/legal.html` holds your real contact details: keep your version.

## Checks before step 2

```bash
npm run typecheck
npm run test          # pen feel + browser test suite
python3 scripts/site-de.py   # German website still builds
```
