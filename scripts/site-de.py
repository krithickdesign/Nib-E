"""Builds the German website (docs/de/index.html) from the English page.

Run:  python3 scripts/site-de.py          (the Website workflow runs it on every deploy)

How it works: every entry in DE below is [English fragment, German fragment]. The
script replaces each fragment in docs/index.html and stops with an error when an
English fragment is no longer on the page, so a changed English text can't
silently stay untranslated. After changing the English page, update the matching
entry here. Paths are rewritten so the German page uses ../assets, ../app and the
German slides and trailer.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "index.html"
OUT = ROOT / "docs" / "de" / "index.html"

DE = [
    # ---- head ----
    ('<html lang="en">', '<html lang="de">'),
    ("<title>Nib-E · the all-in-one PDF editor, every feature free</title>", "<title>Nib-E · der All-in-one-PDF-Editor, alle Funktionen gratis</title>"),
    (
        'content="The all-in-one PDF editor: fill forms, sign, write, redact, organise pages and study. Every feature free, no paywalls, no Pro plan. Works in your browser or as an app, offline, no account."',
        'content="Der All-in-one-PDF-Editor: Formulare ausfüllen, unterschreiben, schreiben, schwärzen, Seiten ordnen und lernen. Alle Funktionen gratis, keine Bezahlschranke, kein Pro-Abo. Im Browser oder als App, offline, ohne Konto."',
    ),
    # ---- header ----
    ('aria-label="Nib-E home"', 'aria-label="Nib-E Startseite"'),
    ('href="#features">Features</a>', 'href="#features">Funktionen</a>'),
    ('href="#privacy">Privacy</a>', 'href="#privacy">Datenschutz</a>'),
    ('href="#download">Desktop app</a>', 'href="#download">Desktop-App</a>'),
    (
        '<nav class="lang" aria-label="Language"><a href="./" hreflang="en" aria-current="true" title="English (UK)"><svg class="flag" aria-hidden="true"><use href="#flag-uk" /></svg>EN</a><a href="de/" hreflang="de" lang="de" title="Deutsch"><svg class="flag" aria-hidden="true"><use href="#flag-de" /></svg>DE</a></nav>',
        '<nav class="lang" aria-label="Sprache"><a href="../" hreflang="en" lang="en" title="English (UK)"><svg class="flag" aria-hidden="true"><use href="#flag-uk" /></svg>EN</a><a href="./" hreflang="de" aria-current="true" title="Deutsch"><svg class="flag" aria-hidden="true"><use href="#flag-de" /></svg>DE</a></nav>',
    ),
    ("Open Nib-E</a>", "Nib-E öffnen</a>"),
    ("Open Nib-E <svg>", "Nib-E öffnen <svg>"),
    # ---- hero ----
    ("<h1>The all-in-one PDF editor. <em>Every feature free.</em></h1>", "<h1>Der All-in-one-PDF-Editor. <em>Alle Funktionen gratis.</em></h1>"),
    (
        "Fill forms, sign, write and draw, redact, organise pages and study, in your browser or as an app. No paywalls, no Pro plan, no account.",
        "Formulare ausfüllen, unterschreiben, schreiben und zeichnen, schwärzen, Seiten ordnen und lernen, im Browser oder als App. Keine Bezahlschranke, kein Pro-Abo, kein Konto.",
    ),
    ("</svg> Desktop app</a>", "</svg> Desktop-App</a>"),
    (
        "Works in Chrome, Edge, Firefox and Safari, also on phones and tablets · Desktop app for Windows (Microsoft Store), macOS and Linux.",
        "Läuft in Chrome, Edge, Firefox und Safari, auch auf Handy und Tablet · Desktop-App für Windows (Microsoft Store), macOS und Linux.",
    ),
    (
        'aria-label="Nib-E in 47 seconds: filling a form, signing, study mode, redaction and the toolbox"',
        'aria-label="Nib-E in 47 Sekunden: Formular ausfüllen, unterschreiben, Lernmodus, Schwärzen und der Werkzeugkasten"',
    ),
    # ---- features ----
    ('<p class="kicker">All in one</p>', '<p class="kicker">Alles in einem</p>'),
    ("<h2>Every PDF tool you need. None of them behind a paywall.</h2>", "<h2>Alle PDF-Werkzeuge, die Sie brauchen. Keins hinter einer Bezahlschranke.</h2>"),
    ('<span class="sr-only">Feature</span>', '<span class="sr-only">Funktion</span>'),
    ("<b>Many PDF editors</b><small>Reading is free. The rest needs a subscription or a “Pro” upgrade.</small>", "<b>Viele PDF-Editoren</b><small>Lesen ist gratis. Der Rest braucht ein Abo oder ein „Pro“-Upgrade.</small>"),
    ("<b>Nib-E</b><small>Every tool free. No trial, no watermark. MIT licence.</small>", "<b>Nib-E</b><small>Alle Werkzeuge gratis. Keine Testphase, kein Wasserzeichen. MIT-Lizenz.</small>"),
    ('data-label="Many PDF editors"', 'data-label="Viele PDF-Editoren"'),
    ("<strong>Fill any form</strong>", "<strong>Jedes Formular ausfüllen</strong>"),
    (
        "Even forms without form fields: Nib-E finds the boxes, lines and tick boxes and asks if you want to fill them. Text matches the form's font.",
        "Auch Formulare ohne Formularfelder: Nib-E findet Kästchen, Linien und Ankreuzfelder und fragt, ob Sie sie ausfüllen möchten. Der Text passt zur Schrift des Formulars.",
    ),
    ("Fillable forms only</span>", "Nur ausfüllbare Formulare</span>"),
    ("<strong>Sign</strong>", "<strong>Unterschreiben</strong>"),
    ("Draw your signature once, place it anywhere, keep it on this device if you like.", "Unterschrift einmal zeichnen, überall platzieren und auf Wunsch auf diesem Gerät behalten."),
    ("Often free</span>", "Oft gratis</span>"),
    ("<strong>Write like on paper</strong>", "<strong>Schreiben wie auf Papier</strong>"),
    (
        "Pen and highlighter with stylus pressure and palm rejection. Choose how much your writing is smoothed: precise for handwriting, smooth for diagrams.",
        "Stift und Textmarker mit Druckempfindlichkeit und Handballenerkennung. Sie wählen, wie stark geglättet wird: präzise für Handschrift, glatt für Skizzen.",
    ),
    ("Varies</span>", "Unterschiedlich</span>"),
    ("<strong>Study mode</strong>", "<strong>Lernmodus</strong>"),
    (
        "Your PDF beside a lined, grid or blank notebook. Notes are kept as you write and come back, at the page where you stopped, when you open the book again. The book file stays untouched unless you choose otherwise.",
        "Ihr PDF neben einem linierten, karierten oder leeren Notizbuch. Notizen werden beim Schreiben gespeichert und kommen beim nächsten Öffnen an der Seite wieder, an der Sie aufgehört haben. Die Buchdatei bleibt unverändert, wenn Sie es nicht anders wählen.",
    ),
    ("Rarely available</span>", "Selten verfügbar</span>"),
    ("<strong>Annotations and stamps</strong>", "<strong>Kommentare und Stempel</strong>"),
    ("Sticky notes, highlights, shapes, ready-made stamps, or design your own stamp and reuse it.", "Notizzettel, Markierungen, Formen, fertige Stempel, oder Sie gestalten Ihren eigenen Stempel und verwenden ihn wieder."),
    ("Basic free, custom stamps often paid</span>", "Grundfunktionen gratis, eigene Stempel oft kostenpflichtig</span>"),
    ("<strong>Redaction that really removes</strong>", "<strong>Schwärzen, das wirklich entfernt</strong>"),
    ("Text under the box is deleted and picture pixels erased. Nib-E checks the result before you save.", "Text unter dem Kasten wird gelöscht, Bildpixel werden überschrieben. Nib-E prüft das Ergebnis vor dem Speichern."),
    ("Usually a paid plan</span>", "Meist kostenpflichtig</span>"),
    ("<strong>Pages and files</strong>", "<strong>Seiten und Dateien</strong>"),
    (
        "Insert, rotate, reorder, delete and extract pages. Merge PDFs, reduce the file size, lock with a password, export pages as images.",
        "Seiten einfügen, drehen, sortieren, löschen und herauslösen. PDFs zusammenführen, Dateigröße verringern, mit Passwort schützen, Seiten als Bilder exportieren.",
    ),
    ("<strong>Several files at once</strong>", "<strong>Mehrere Dateien gleichzeitig</strong>"),
    (
        "Each PDF opens in its own tab. Save writes back to the file you opened, the earlier version can be restored, and unsaved work survives a crash.",
        "Jedes PDF öffnet in einem eigenen Tab. Speichern schreibt in die geöffnete Datei, die vorherige Version lässt sich wiederherstellen, und Ungespeichertes übersteht einen Absturz.",
    ),
    ('<use href="#i-check" /></svg>Usually</span>', '<use href="#i-check" /></svg>Meistens</span>'),
    ('<use href="#i-check" /></svg>Free</span>', '<use href="#i-check" /></svg>Gratis</span>'),
    # ---- carousel ----
    (
        '<div class="carousel" data-carousel aria-roledescription="carousel" aria-label="Screenshots">',
        '<div class="carousel" data-carousel aria-roledescription="Karussell" aria-label="Screenshots" data-dot-label="Screenshot" data-play-label="Diashow abspielen">',
    ),
    ('aria-roledescription="slide"', 'aria-roledescription="Folie"'),
    ('alt="The all-in-one PDF editor. Every feature free, no Pro plan."', 'alt="Der All-in-one-PDF-Editor. Alle Funktionen gratis, kein Pro-Abo."'),
    ('alt="Fill any form, even forms without fillable fields: Nib-E found 9 boxes to fill."', 'alt="Jedes Formular ausfüllen, auch ohne Formularfelder: Nib-E hat 9 Felder gefunden."'),
    ('alt="Sign in seconds: draw your signature once and place it on any line."', 'alt="Unterschrift in Sekunden: einmal zeichnen und auf jede Linie setzen."'),
    (
        'alt="Highlight, comment and stamp: a report with a highlight, a circled figure, an arrow and an Approved stamp."',
        'alt="Markieren, kommentieren, stempeln: ein Bericht mit Markierung, eingekreister Zahl, Pfeil und Stempel."',
    ),
    ('alt="Merge, reorder and shrink: the page manager with thumbnails."', 'alt="Zusammenführen, sortieren, verkleinern: die Seitenverwaltung mit Vorschaubildern."'),
    (
        'alt="Redaction before and after: the name is removed for good, and Nib-E checks that nothing is left underneath."',
        'alt="Schwärzen vorher und nachher: der Name ist endgültig entfernt, und Nib-E prüft, dass nichts darunter bleibt."',
    ),
    ('alt="Study mode: a worksheet beside a notebook with a sketch and typed notes."', 'alt="Lernmodus: ein Arbeitsblatt neben einem Notizbuch mit Skizze und getippten Notizen."'),
    (
        'alt="Every tool free: twelve tools, each marked free. Works offline, no account, no uploads, no ads."',
        'alt="Alle Werkzeuge gratis: zwölf Werkzeuge, jedes als gratis markiert. Offline, kein Konto, keine Uploads, keine Werbung."',
    ),
    ('aria-label="Previous screenshot"', 'aria-label="Vorheriger Screenshot"'),
    ('aria-label="Next screenshot"', 'aria-label="Nächster Screenshot"'),
    ('aria-label="Pause the slideshow"', 'aria-label="Diashow anhalten"'),
    # ---- privacy ----
    ('<p class="kicker">Private by design</p>', '<p class="kicker">Datenschutz eingebaut</p>'),
    ("<h2>And your PDFs never leave your computer.</h2>", "<h2>Und Ihre PDFs verlassen nie Ihren Computer.</h2>"),
    (
        "Most online PDF tools upload your documents to their servers. Nib-E does all the work inside your browser, so contracts, IDs and exam papers stay with you.",
        "Die meisten Online-PDF-Tools laden Ihre Dokumente auf ihre Server. Nib-E erledigt alles in Ihrem Browser, damit Verträge, Ausweise und Klausuren bei Ihnen bleiben.",
    ),
    ("<h3>Network: none</h3>", "<h3>Netzwerk: keins</h3>"),
    (
        "Opening, editing and saving happen on your device. The desktop app has no internet permission at all, and the web version can only load its own text-recognition files from this site once loaded.",
        "Öffnen, Bearbeiten und Speichern passieren auf Ihrem Gerät. Die Desktop-App hat gar keine Internet-Berechtigung, und die Web-Version kann nach dem Laden nur noch ihre eigenen Texterkennungs-Dateien von dieser Seite laden.",
    ),
    ("<h3>No account, no tracking, no AI</h3>", "<h3>Kein Konto, kein Tracking, keine KI</h3>"),
    ("Nothing about you or your files is collected. No AI service ever sees your text.", "Über Sie und Ihre Dateien wird nichts gesammelt. Kein KI-Dienst sieht jemals Ihren Text."),
    ("<h3>Safe mode</h3>", "<h3>Sicherer Modus</h3>"),
    ("Scripts inside PDFs never run and links can't open anything by themselves. Nib-E shows what it blocked.", "Skripte in PDFs laufen nie, und Links können nichts von selbst öffnen. Nib-E zeigt, was blockiert wurde."),
    # ---- download ----
    ('<p class="kicker">Desktop app</p>', '<p class="kicker">Desktop-App</p>'),
    ("<h2>Install Nib-E. It never goes online.</h2>", "<h2>Nib-E installieren. Es geht nie online.</h2>"),
    (
        "Same Nib-E, as a normal app: opens PDFs from your file manager (“Open with Nib-E”), saves straight back to the file, and has no permission to use the internet. Free, no account.",
        "Dasselbe Nib-E als normale App: öffnet PDFs aus dem Dateimanager („Öffnen mit Nib-E“), speichert direkt in die Datei und darf das Internet nicht nutzen. Gratis, ohne Konto.",
    ),
    ("<p>Windows 10 and 11.</p>", "<p>Windows 10 und 11.</p>"),
    (">Get Nib-E from the Microsoft Store</a>", ">Nib-E im Microsoft Store holen</a>"),
    ("Signed by Microsoft: no warning, and updates install by themselves.", "Von Microsoft signiert: keine Warnung, und Updates installieren sich von selbst."),
    ("Microsoft Store: on its way. Until then, use the installer from GitHub.", "Microsoft Store: kommt bald. Bis dahin nutzen Sie den Installer von GitHub."),
    (">Installer from GitHub (.exe)</button>", ">Installer von GitHub (.exe)</button>"),
    ("<p>Apple silicon and Intel.</p>", "<p>Apple Silicon und Intel.</p>"),
    (">Download for macOS</button>", ">Für macOS herunterladen</button>"),
    ("<p>AppImage (any distribution) or .deb (Ubuntu, Debian).</p>", "<p>AppImage (jede Distribution) oder .deb (Ubuntu, Debian).</p>"),
    (">Download for Linux</button>", ">Für Linux herunterladen</button>"),
    (
        "<strong>Why the warnings?</strong> The GitHub installers are not signed with a paid certificate yet; the Microsoft Store version is signed by Microsoft and has no warning. Every installer is built openly from this source code by GitHub. Nib-E never checks for updates by itself: the Store updates its version, and for the others you download a newer version here and install it over the old one (settings and study notes are kept). Prefer no install at all? <a href=\"app/index.html\" download=\"Nib-E.html\">Download Nib-E.html</a>, a single file that opens in your browser and works offline.",
        "<strong>Warum die Warnungen?</strong> Die Installer von GitHub sind noch nicht mit einem kostenpflichtigen Zertifikat signiert; die Version im Microsoft Store ist von Microsoft signiert und zeigt keine Warnung. Jeder Installer wird von GitHub offen aus diesem Quellcode gebaut. Nib-E sucht nie selbst nach Updates: Der Store aktualisiert seine Version, für die anderen laden Sie hier eine neuere Version und installieren sie über die alte (Einstellungen und Lernnotizen bleiben erhalten). Lieber gar nichts installieren? <a href=\"app/index.html\" download=\"Nib-E.html\">Nib-E.html herunterladen</a>, eine einzelne Datei, die im Browser öffnet und offline funktioniert.",
    ),
    # dialogs
    ('<h3 id="dlg-win-t">Before you download</h3>', '<h3 id="dlg-win-t">Vor dem Herunterladen</h3>'),
    ('aria-label="Close"', 'aria-label="Schließen"'),
    ("<strong>We recommend the Microsoft Store version.</strong>", "<strong>Wir empfehlen die Version aus dem Microsoft Store.</strong>"),
    (
        "<p>Same app, same features, free. It is checked and signed by Microsoft, installs without any warning and updates by itself.</p>",
        "<p>Dieselbe App, dieselben Funktionen, gratis. Sie ist von Microsoft geprüft und signiert, installiert sich ohne Warnung und aktualisiert sich selbst.</p>",
    ),
    (">Get it from the Microsoft Store</a>", ">Im Microsoft Store holen</a>"),
    ('<p class="dlg-sub">Still want the installer from GitHub?</p>', '<p class="dlg-sub">Trotzdem den Installer von GitHub?</p>'),
    (
        "(no admin rights needed). It is not signed with a paid certificate yet, so on first start Windows shows a blue window. Two clicks:",
        "(keine Administratorrechte nötig). Er ist noch nicht mit einem kostenpflichtigen Zertifikat signiert, deshalb zeigt Windows beim ersten Start ein blaues Fenster. Zwei Klicks:",
    ),
    ("<b>Windows protected your PC</b>", "<b>Der Computer wurde durch Windows geschützt</b>"),
    ("Microsoft Defender SmartScreen prevented an unrecognised app from starting…", "Von Microsoft Defender SmartScreen wurde der Start einer unbekannten App verhindert…"),
    ('<span class="ss-link">More info</span>', '<span class="ss-link">Weitere Informationen</span>'),
    ('<span class="ss-btn">Don\'t run</span>', '<span class="ss-btn">Nicht ausführen</span>'),
    ('<span class="ss-btn hl">Run anyway</span>', '<span class="ss-btn hl">Trotzdem ausführen</span>'),
    ("Publisher: Unknown publisher", "Herausgeber: Unbekannter Herausgeber"),
    ("In the blue window, click More info, then Run anyway.", "Im blauen Fenster auf Weitere Informationen klicken, dann auf Trotzdem ausführen."),
    ('<button type="button" class="btn" data-close>Cancel</button>', '<button type="button" class="btn" data-close>Abbrechen</button>'),
    ("Continue to GitHub <svg>", "Weiter zu GitHub <svg>"),
    ('<h3 id="dlg-mac-t">Before you download for macOS</h3>', '<h3 id="dlg-mac-t">Vor dem Herunterladen für macOS</h3>'),
    ("(Apple silicon and Intel), from the latest release on GitHub.", "(Apple Silicon und Intel), aus der neuesten Version auf GitHub."),
    (
        "<strong>First start:</strong> macOS says Nib-E cannot be opened, because it is not notarised by Apple yet. Open <strong>System Settings → Privacy &amp; Security</strong>, scroll down, click <strong>Open Anyway</strong>. You only do this once.",
        "<strong>Erster Start:</strong> macOS meldet, dass Nib-E nicht geöffnet werden kann, weil es noch nicht von Apple beglaubigt ist. Öffnen Sie <strong>Systemeinstellungen → Datenschutz &amp; Sicherheit</strong>, scrollen Sie nach unten und klicken Sie auf <strong>Dennoch öffnen</strong>. Das ist nur einmal nötig.",
    ),
    ("No install needed? <a href=\"app/\">Open Nib-E in your browser</a>: same features, works offline once loaded.", "Ohne Installation? <a href=\"app/\">Nib-E im Browser öffnen</a>: dieselben Funktionen, offline nutzbar, sobald es geladen ist."),
    ('<h3 id="dlg-linux-t">Before you download for Linux</h3>', '<h3 id="dlg-linux-t">Vor dem Herunterladen für Linux</h3>'),
    (
        '<p><strong>We recommend the web version on Linux:</strong> <a href="app/">open Nib-E in your browser</a>. Same features, works offline once loaded, nothing to install.</p>',
        '<p><strong>Unter Linux empfehlen wir die Web-Version:</strong> <a href="app/">Nib-E im Browser öffnen</a>. Dieselben Funktionen, offline nutzbar, sobald es geladen ist, nichts zu installieren.</p>',
    ),
    ('<p class="dlg-sub">Prefer an app?</p>', '<p class="dlg-sub">Lieber eine App?</p>'),
    (
        "<p>Take the <code>.deb</code> (Ubuntu, Debian, Mint) from the latest release on GitHub and double-click it to install with your software centre. The <code>.AppImage</code> works on any distribution: make it executable (right-click → Properties → Allow executing), then double-click it.</p>",
        "<p>Nehmen Sie das <code>.deb</code> (Ubuntu, Debian, Mint) aus der neuesten Version auf GitHub und doppelklicken Sie es, um es mit der Softwareverwaltung zu installieren. Das <code>.AppImage</code> läuft auf jeder Distribution: ausführbar machen (Rechtsklick → Eigenschaften → Ausführen erlauben), dann doppelklicken.</p>",
    ),
    (
        "<strong>Blank window or crash at start?</strong> Start it once more: Nib-E then switches to software drawing by itself. You can also start it with <code>NIB_SAFE_GRAPHICS=1</code>.",
        "<strong>Leeres Fenster oder Absturz beim Start?</strong> Starten Sie es noch einmal: Nib-E schaltet dann selbst auf Software-Darstellung um. Sie können es auch mit <code>NIB_SAFE_GRAPHICS=1</code> starten.",
    ),
    ("<strong>Edit existing text</strong>", "<strong>Vorhandenen Text bearbeiten</strong>"),
    ("Click a line of the PDF and type. Nib-E keeps the font, size, colour and alignment (one line at a time).", "Zeile im PDF anklicken und tippen. Nib-E behält Schrift, Größe, Farbe und Ausrichtung (zeilenweise)."),
    ("<strong>Certificate signatures</strong>", "<strong>Zertifikatssignaturen</strong>"),
    ("Sign with your own certificate (.p12/.pfx) and check the signatures in a PDF: intact, changed after signing, or not valid.", "Mit Ihrem eigenen Zertifikat (.p12/.pfx) signieren und die Signaturen eines PDFs prüfen: intakt, danach geändert oder ungültig."),
    ("Checking free, signing often paid", "Prüfen gratis, Signieren oft kostenpflichtig"),
    ("<strong>Text recognition (OCR)</strong>", "<strong>Texterkennung (OCR)</strong>"),
    ("Makes scanned pages searchable and copyable, on your device. English and German.", "Macht gescannte Seiten durchsuchbar und kopierbar, auf Ihrem Gerät. Englisch und Deutsch."),
    ("<p>File: <code>", "<p>Datei: <code>"),
    # ---- feedback ----
    ('<p class="kicker">Feedback</p>', '<p class="kicker">Feedback</p>'),
    ("<h2>Something odd? Tell us.</h2>", "<h2>Etwas seltsam? Sagen Sie es uns.</h2>"),
    ("Try Nib-E with your own PDFs: forms, lecture slides, scans, long reports. Every report helps.", "Probieren Sie Nib-E mit Ihren eigenen PDFs: Formulare, Vorlesungsfolien, Scans, lange Berichte. Jede Meldung hilft."),
    ("<li><strong>Open Nib-E</strong> and use it like you normally use a PDF reader.</li>", "<li><strong>Öffnen Sie Nib-E</strong> und nutzen Sie es wie sonst Ihren PDF-Reader.</li>"),
    ("<li>Something odd? Note what you did and which browser you use.</li>", "<li>Etwas seltsam? Notieren Sie, was Sie getan haben und welchen Browser Sie nutzen.</li>"),
    (
        'rel="noopener">Tell us in the feedback form</a> (no account needed), or use <strong>Help → Send feedback</strong> in Nib-E. Please don\'t attach private documents.',
        'rel="noopener">Schreiben Sie uns im Feedback-Formular</a> (kein Konto nötig), oder nutzen Sie <strong>Hilfe → Feedback senden</strong> in Nib-E. Bitte keine privaten Dokumente anhängen.',
    ),
    # ---- footer ----
    ("· part of the Desk-E family · MIT licence</span>", "· Teil der Desk-E-Familie · MIT-Lizenz</span>"),
    ("<span>Built on PDFium (the engine inside Chrome) via EmbedPDF</span>", "<span>Basiert auf PDFium (der Engine in Chrome) über EmbedPDF</span>"),
    (">Source on GitHub</a>", ">Quellcode auf GitHub</a>"),
    ("<span>This site uses no cookies and no analytics.</span>", "<span>Diese Seite nutzt keine Cookies und keine Analyse.</span>"),
    (">Legal notice &amp; privacy</a>", ">Impressum &amp; Datenschutz</a>"),
    (
        "Nib-E is an independent project and not affiliated with Adobe Inc. or any other PDF software maker. Adobe and Acrobat are trademarks of Adobe Inc. PDF is an open standard (ISO 32000).",
        "Nib-E ist ein unabhängiges Projekt und nicht mit Adobe Inc. oder einem anderen Hersteller von PDF-Software verbunden. Adobe und Acrobat sind Marken von Adobe Inc. PDF ist ein offener Standard (ISO 32000).",
    ),
    # ---- script text ----
    ("else a.replaceWith(document.createTextNode('Report it on the project’s GitHub page'));", "else a.replaceWith(document.createTextNode('Melden Sie es auf der GitHub-Seite des Projekts'));"),
]


def main() -> None:
    html = SRC.read_text(encoding="utf-8")
    missing = []
    for en, de in DE:
        if en not in html:
            missing.append(en)
            continue
        html = html.replace(en, de)
    if missing:
        print("These English texts are no longer on docs/index.html. Update scripts/site-de.py:", file=sys.stderr)
        for m in missing:
            print("  -", m[:110], file=sys.stderr)
        sys.exit(1)

    # The "also in German" hint is only for the English page.
    html, n = re.subn(r'\n\s*<div class="langhint"[^\n]*</div>', "", html)
    assert n == 1, "language hint not found"

    # German slides and trailer.
    html = re.sub(r'assets/slides/([\w-]+)\.webp', r'assets/slides/\1-de.webp', html)
    html = html.replace("assets/nib-e-trailer.mp4", "assets/nib-e-trailer-de.mp4").replace("assets/trailer-poster.jpg", "assets/trailer-poster-de.jpg")

    # The page lives in /de/: shared files are one folder up.
    html = re.sub(r'((?:src|href|poster)=")(assets/|app/|legal\.html)', r"\1../\2", html)
    html = html.replace('url("assets/', 'url("../assets/')

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(DE)} texts translated)")


if __name__ == "__main__":
    main()
