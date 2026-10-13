**Nib-E desktop app.** Works fully offline: no account, no uploads, no network access.

**Which file?**
- Windows: `Nib-E_…_x64-setup.exe` (no admin rights needed) or the `.msi`
- macOS (Apple silicon and Intel): `Nib-E_…_universal.dmg`
- Linux: `.AppImage` (any distribution) or `.deb` (Ubuntu, Debian)

**First start: your computer warns you, because these installers are not signed yet.**
- Windows shows a blue window "Windows protected your PC" → click **More info** → **Run anyway**. (The Microsoft Store version has no warning.)
- macOS: "Nib-E cannot be opened" → **System Settings → Privacy & Security** → scroll down → **Open Anyway**.
- Linux: make the AppImage executable (`chmod +x Nib-E_*.AppImage`), then run it.

**Updating:** install the new version over the old one. Settings, signature, stamps and study notes are kept. Nib-E never checks for updates by itself.

**Check your download (optional):** `SHA256SUMS.txt` lists the fingerprint of every file. Windows: `certutil -hashfile <file> SHA256`; macOS/Linux: `shasum -a 256 <file>`.
