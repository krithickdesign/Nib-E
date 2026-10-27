# Nib-E promo: "We listened to your feedback"

Short motion piece (Reddit / social) showing what changed in 0.6 because of user feedback.
Real app footage, made-up sample files only. Same look and pipeline as `store/trailer/`.

```
npm run build:single && node scripts/copy-ocr.mjs dist-single   # the app the footage comes from
python3 store/promo/capture.py          # stills of each step -> frames/
python3 store/promo/render.py           # all formats + thumbnail -> out/
python3 store/promo/render.py --preview 16x9 9.5 25   # check single frames
```

Scenes: hook → edit existing text → text recognition + select & copy → form fields
(number boxes, dropdown, list box, multi-line) → page layout button → digital signatures →
"and a lot of small fixes" (print check, rename, fonts, languages, Linux, Windows icons) → outro.

| File | Size | Use |
|---|---|---|
| `Nib-E-we-listened-16x9-1920x1080.mp4` | 1920×1080 | Reddit (desktop), YouTube, X |
| `Nib-E-we-listened-4x5-1080x1350.mp4` | 1080×1350 | Reddit / Instagram / LinkedIn feed on phones |
| `Nib-E-we-listened-1x1-1080x1080.mp4` | 1080×1080 | Square feeds |
| `Nib-E-we-listened-thumbnail-1920x1080.png` | 1920×1080 | Thumbnail |

54 s, 30 fps, H.264, silent audio track. Add music in the app you post with.
After UI changes, run capture.py again so the footage matches the app.
