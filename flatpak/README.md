# Nib-E on Flathub

These three files are what Flathub needs. The manifest packs the official `.deb`
from the GitHub release, so the Flatpak is the same build as the other Linux downloads.

| File | What it is |
|---|---|
| `io.github.krithickdesign.NibE.yml` | Build manifest (runtime, permissions, how to install) |
| `io.github.krithickdesign.NibE.metainfo.xml` | Store page text, screenshots, release notes |
| `io.github.krithickdesign.NibE.desktop` | Start-menu entry, opens PDFs |

The app ID `io.github.krithickdesign.NibE` matches the website (krithickdesign.github.io),
which is how Flathub checks that the app is yours.

## Test locally (any Linux PC)

```bash
flatpak install flathub org.gnome.Platform//49 org.gnome.Sdk//49
# put the real sha256 of the .deb into the .yml first (from SHA256SUMS.txt in the release)
flatpak-builder --user --install --force-clean build flatpak/io.github.krithickdesign.NibE.yml
flatpak run io.github.krithickdesign.NibE
```

## Submit (once)

1. Fork https://github.com/flathub/flathub and create a branch `new-pr` from `new-pr`.
2. Add the three files in the root of that branch, with the real `sha256`.
3. Open a pull request titled “Add io.github.krithickdesign.NibE”. Reviewers reply in the pull request.
4. After approval, Flathub creates `github.com/flathub/io.github.krithickdesign.NibE`; you become its maintainer.

## Each new version

The manifest has `x-checker-data`: after a GitHub release, Flathub's bot opens a pull request in
`flathub/io.github.krithickdesign.NibE` with the new `url` and `sha256`. Check that the build passed, merge it.
Add the new `<release>` line to the metainfo in the same pull request (or the next one).

## Notes for reviewers (if they ask)

- **Prebuilt binary:** Nib-E is open source (MIT); the `.deb` is built by GitHub Actions from the public repo.
  Building from source inside Flatpak needs offline npm and cargo sources (flatpak-builder-tools); that can follow later.
- **`--filesystem=home`:** Nib-E is a document editor. Save writes back to the file that was opened, and
  recent files reopen by path.
- **No network permission:** the app works fully offline.
- Screenshots are WebP from the website. If Flathub asks for PNG, export two screenshots as PNG into
  `docs/assets/` and point the metainfo at them.
