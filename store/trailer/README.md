# Nib-E trailer

Motion trailer made from real app footage (made-up sample files only).

```
npm run build:single                    # the app the footage comes from
python3 store/trailer/capture.py        # stills of each step -> frames/
python3 store/trailer/render.py         # all formats -> out/
python3 store/trailer/render.py --preview 16x9 12 20   # check single frames
python3 store/trailer/render.py --lang de              # German text (files end in -de)
```

| File | Size | Use |
|---|---|---|
| `Nib-E-trailer-16x9-1920x1080.mp4` | 1920×1080 | Microsoft Store trailer, YouTube, LinkedIn, X |
| `Nib-E-trailer-thumbnail-1920x1080.png` | 1920×1080 | Store trailer thumbnail, YouTube thumbnail |
| `Nib-E-trailer-9x16-1080x1920.mp4` | 1080×1920 | Instagram Reels / Stories, TikTok, YouTube Shorts |
| `Nib-E-trailer-4x5-1080x1350.mp4` | 1080×1350 | Instagram and LinkedIn feed posts |

German: same files with `-de` before the extension; texts are in the `DE` table in `trailer.html`.

46.8 s, 30 fps, H.264, silent audio track. Add music in the app you post with.
After UI changes, run capture.py again so the footage matches the app.
