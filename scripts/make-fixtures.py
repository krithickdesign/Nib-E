"""Builds the PDFs used by the tests (including the "Heat transfer" worksheet).

Run:  python3 scripts/make-fixtures.py
Needs: reportlab, pikepdf
"""
from pathlib import Path

import pikepdf
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "test" / "fixtures" / "sample.pdf"
FIX = ROOT / "test" / "fixtures"
FIX.mkdir(parents=True, exist_ok=True)
SAMPLE.parent.mkdir(parents=True, exist_ok=True)

INK = HexColor("#1d2233")
MUTED = HexColor("#6b7085")
RULE = HexColor("#c9ccd8")


def header(c, w, h, title, sub):
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(56, h - 72, title)
    c.setFont("Helvetica", 10.5)
    c.setFillColor(MUTED)
    c.drawString(56, h - 90, sub)
    c.setStrokeColor(RULE)
    c.setLineWidth(0.8)
    c.line(56, h - 102, w - 56, h - 102)


def para(c, x, y, lines, size=11, leading=16, color=INK, font="Helvetica"):
    c.setFont(font, size)
    c.setFillColor(color)
    for i, t in enumerate(lines):
        c.drawString(x, y - i * leading, t)
    return y - len(lines) * leading


def working_space(c, x, y, w, rows, gap=22):
    c.setStrokeColor(HexColor("#e2e4ec"))
    c.setLineWidth(0.6)
    for i in range(rows):
        c.line(x, y - i * gap, x + w, y - i * gap)


def make_sample():
    w, h = A4
    c = canvas.Canvas(str(SAMPLE), pagesize=A4)
    c.setTitle("Heat Transfer - Worksheet 3 (Nib-E sample)")
    c.setAuthor("Nib-E sample document")

    # Page 1: worksheet with a fillable form
    header(c, w, h, "Heat Transfer · Worksheet 3", "Conduction through plane walls  ·  Sample document bundled with Nib-E")
    form = c.acroForm
    c.setFont("Helvetica", 10)
    c.setFillColor(MUTED)
    c.drawString(56, h - 134, "Name")
    form.textfield(name="student_name", x=56, y=h - 162, width=250, height=22,
                   borderColor=RULE, fillColor=HexColor("#f6f7fb"), textColor=INK,
                   fontSize=11, borderWidth=0.8, tooltip="Your name")
    c.drawString(322, h - 134, "Matriculation no.")
    form.textfield(name="matriculation", x=322, y=h - 162, width=150, height=22,
                   borderColor=RULE, fillColor=HexColor("#f6f7fb"), textColor=INK,
                   fontSize=11, borderWidth=0.8, maxlen=10)
    form.checkbox(name="worked_alone", x=56, y=h - 196, size=14, borderColor=RULE,
                  fillColor=HexColor("#f6f7fb"), buttonStyle="check", checked=False)
    c.setFillColor(INK)
    c.drawString(78, h - 192, "I solved these problems on my own")

    y = h - 236
    c.setFont("Helvetica-Bold", 12.5)
    c.drawString(56, y, "Problem 1")
    y = para(c, 56, y - 20, [
        "A furnace wall is 0.20 m thick with thermal conductivity k = 1.2 W/(m·K).",
        "The inner surface is held at 850 °C and the outer surface at 90 °C.",
        "Find the heat flux q'' through the wall using Fourier's law: q'' = k (T1 − T2) / L.",
    ])
    # wall sketch
    bx, by = 380, y - 110
    c.setFillColor(HexColor("#eceef5"))
    c.setStrokeColor(INK)
    c.setLineWidth(1)
    c.rect(bx + 40, by, 46, 92, fill=1)
    c.setFont("Helvetica", 9)
    c.setFillColor(INK)
    c.drawString(bx, by + 96, "T1 = 850 °C")
    c.drawString(bx + 92, by + 96, "T2 = 90 °C")
    c.drawString(bx + 46, by - 14, "L = 0.20 m")
    c.setStrokeColor(HexColor("#c2410c"))
    c.setLineWidth(1.4)
    c.line(bx + 20, by + 46, bx + 110, by + 46)
    c.line(bx + 104, by + 50, bx + 110, by + 46)
    c.line(bx + 104, by + 42, bx + 110, by + 46)
    working_space(c, 56, y - 18, 300, 6)

    y = y - 170
    c.setFont("Helvetica-Bold", 12.5)
    c.setFillColor(INK)
    c.drawString(56, y, "Problem 2")
    y = para(c, 56, y - 20, [
        "Add a 0.05 m insulation layer with k = 0.08 W/(m·K) on the outside.",
        "Keeping the same surface temperatures, by what factor does the heat loss drop?",
    ])
    working_space(c, 56, y - 18, w - 112, 8)
    c.setFont("Helvetica", 8.5)
    c.setFillColor(MUTED)
    c.drawString(56, 40, "Tip: pick the pen and write your working on the lines. Fill the fields above with the hand tool.")
    c.showPage()

    # Page 2: formula sheet
    header(c, w, h, "Formula sheet", "One-dimensional steady conduction")
    rows = [
        ("Fourier's law", "q'' = −k dT/dx"),
        ("Plane wall resistance", "R = L / (k A)"),
        ("Series walls", "R_total = R1 + R2 + …"),
        ("Convection resistance", "R = 1 / (h A)"),
        ("Heat rate", "q = ΔT / R_total"),
        ("Cylinder wall", "R = ln(r2/r1) / (2π k L)"),
    ]
    y = h - 140
    for name, f in rows:
        c.setFont("Helvetica", 11)
        c.setFillColor(MUTED)
        c.drawString(56, y, name)
        c.setFont("Courier-Bold", 12)
        c.setFillColor(INK)
        c.drawString(250, y, f)
        c.setStrokeColor(HexColor("#e2e4ec"))
        c.line(56, y - 10, w - 56, y - 10)
        y -= 34
    y -= 10
    c.setFont("Helvetica-Bold", 12.5)
    c.drawString(56, y, "Notes")
    working_space(c, 56, y - 24, w - 112, 16)
    c.showPage()

    # Page 3: blank grid for sketches
    header(c, w, h, "Sketch space", "Draw the temperature profile for both problems")
    c.setStrokeColor(HexColor("#e6e8ef"))
    c.setLineWidth(0.5)
    step = 14.17  # 5 mm
    x = 56
    while x <= w - 56:
        c.line(x, 60, x, h - 120)
        x += step
    y = 60
    while y <= h - 120:
        c.line(56, y, w - 56, y)
        y += step
    c.showPage()
    c.save()


def make_rotated():
    """Page 1 normal, page 2 /Rotate 90, page 3 with an offset crop box."""
    path = FIX / "rotated.pdf"
    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    for label in ("PAGE ONE", "PAGE TWO (Rotate 90)", "PAGE THREE (offset box)"):
        c.setFillColor(HexColor("#b91c1c"))
        c.rect(0, h - 80, 80, 80, fill=1, stroke=0)  # red square marks the top-left corner
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 24)
        c.drawString(100, h - 60, label)
        c.showPage()
    c.save()
    pdf = pikepdf.open(path, allow_overwriting_input=True)
    pdf.pages[1].Rotate = 90
    p3 = pdf.pages[2]
    p3.MediaBox = [40, 30, w + 40, h + 30]
    p3.CropBox = [40, 30, w + 40, h + 30]
    pdf.save(path)


def make_second():
    path = FIX / "second.pdf"
    w, h = LETTER
    c = canvas.Canvas(str(path), pagesize=LETTER)
    for i in (1, 2):
        c.setFont("Helvetica-Bold", 28)
        c.setFillColor(HexColor("#1e40af"))
        c.drawString(72, h - 100, f"Second file · page {i}")
        c.showPage()
    c.save()


def make_active():
    """A harmless PDF that carries the kinds of active content safe mode reports."""
    path = FIX / "active.pdf"
    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(56, h - 80, "Active content test file")
    c.setFont("Helvetica", 12)
    c.drawString(56, h - 110, "Has: open-action script, launch link, web link, attachment.")
    c.drawString(56, h - 150, "Web link: https://example.com")
    c.linkURL("https://example.com", (56, h - 156, 300, h - 140), relative=0)
    c.showPage()
    c.save()
    pdf = pikepdf.open(path, allow_overwriting_input=True)
    pdf.Root.OpenAction = pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS=pikepdf.String("app.alert('hello from a script');"))
    launch = pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link, Rect=[56, 600, 300, 620], Border=[0, 0, 0],
        A=pikepdf.Dictionary(S=pikepdf.Name.Launch, F=pikepdf.String("calc.exe")),
    )
    page = pdf.pages[0]
    page.Annots.append(pdf.make_indirect(launch))
    pdf.attachments["notes.txt"] = pikepdf.AttachedFileSpec(pdf, b"attachment body", mime_type="text/plain")
    pdf.save(path)


def make_report():
    """An ordinary document: rules, a filled table and a footnote. No fill-in places."""
    path = FIX / "report.pdf"
    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(56, h - 80, "Quarterly report")
    c.setStrokeColor(INK)
    c.setLineWidth(1)
    c.line(56, h - 88, w - 56, h - 88)
    c.setFont("Helvetica", 10)
    y = h - 120
    for line in ["Revenue grew in every region this quarter, led by new contracts in the south.",
                 "Costs stayed flat. The table below lists the main figures per region."]:
        c.drawString(56, y, line)
        y -= 15
    y -= 10
    cols = [56, 216, 336, 456]
    c.setFillColor(HexColor("#d9d9d9"))
    c.rect(56, y - 6, w - 112, 20, fill=1, stroke=0)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 10)
    for x, t in zip(cols, ["Region", "Revenue", "Costs", "Margin"]):
        c.drawString(x + 4, y, t)
    c.setFont("Helvetica", 10)
    for row in [["North", "1.2 M", "0.8 M", "33 %"], ["South", "2.4 M", "1.1 M", "54 %"], ["West", "0.9 M", "0.7 M", "22 %"]]:
        y -= 22
        c.setStrokeColor(RULE)
        c.rect(56, y - 6, w - 112, 22, fill=0, stroke=1)
        for x, t in zip(cols, row):
            c.drawString(x + 4, y, t)
    c.setStrokeColor(INK)
    c.line(56, 90, 156, 90)
    c.setFont("Helvetica", 8)
    c.drawString(56, 80, "1 Figures are unaudited and rounded to one decimal. Currency: euro. Source: internal finance system, export of 30 September.")
    c.showPage()
    c.save()


def make_form():
    """A form drawn with plain shapes (no real form fields), like many exported Word forms."""
    path = FIX / "form.pdf"
    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Times-Bold", 16)
    c.drawString(56, h - 72, "Membership application")
    rows = ["Surname", "First name", "Date of birth"]
    y = h - 120
    for label in rows:
        c.setFillColor(INK)
        c.setFont("Times-Roman", 12)
        c.drawString(56, y + 5, label)
        c.setFillColor(HexColor("#dcdcdc"))
        c.rect(200, y, 300, 20, fill=1, stroke=0)
        y -= 28
    c.setFillColor(INK)
    c.drawString(56, y + 5, "Student")
    for x, opt in ((200, "Yes"), (270, "No")):
        c.setStrokeColor(INK)
        c.setLineWidth(0.8)
        c.circle(x + 5, y + 9, 5, stroke=1, fill=0)
        c.drawString(x + 14, y + 5, opt)
    y -= 28
    c.drawString(56, y + 5, "Interests")
    for x, opt in ((200, "Sailing"), (290, "Climbing")):
        c.rect(x, y + 4, 10, 10, stroke=1, fill=0)
        c.drawString(x + 14, y + 5, opt)
    y -= 34
    c.drawString(56, y + 5, "City:")
    c.line(100, y + 2, 300, y + 2)
    y -= 60
    c.setFillColor(HexColor("#808080"))
    c.drawString(60, y + 5, "Click here to sign")
    c.setStrokeColor(INK)
    c.line(56, y + 2, 300, y + 2)
    c.setFillColor(INK)
    c.setFont("Times-Roman", 9)
    c.drawString(56, y - 10, "Place, date, signature")
    c.showPage()
    c.save()


def make_photos():
    """Test images, and a PDF with an oversized photo for the compression test."""
    from PIL import Image
    import numpy as np
    yy, xx = np.mgrid[0:1600, 0:2400]
    img = np.stack([(xx * 255 // 2400), (yy * 255 // 1600), ((xx + yy) * 255 // 4000)], axis=-1).astype(np.uint8)
    noise = (np.random.default_rng(1).integers(0, 40, img.shape)).astype(np.uint8)
    big = Image.fromarray(np.clip(img.astype(int) + noise - 20, 0, 255).astype(np.uint8))
    big.save(FIX / "big.jpg", quality=95)
    small = big.resize((400, 266))
    small.save(FIX / "photo.png")
    small.save(FIX / "photo.jpg", quality=90)
    w, h = A4
    path = FIX / "photo.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(56, h - 80, "Site photo")
    c.drawImage(str(FIX / "big.jpg"), 56, h - 380, 300, 200)
    c.setFont("Helvetica", 10)
    c.drawString(56, h - 400, "Photo taken on site, printed at 300 x 200 pt.")
    c.showPage()
    c.save()


def make_mixed():
    """Page 1 has one real form field and one drawn box; page 2 only drawn boxes,
    plus empty decorative frames that must not become fields."""
    path = FIX / "mixed.pdf"
    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(56, h - 72, "Contact sheet")
    c.setFont("Helvetica", 11)
    for i, label in enumerate(("Name", "Email")):
        y = h - 120 - i * 32
        c.setFillColor(INK)
        c.drawString(56, y + 6, label)
        c.setFillColor(HexColor("#e2e2e2"))
        c.rect(160, y, 280, 20, fill=1, stroke=0)
    # A real field on top of the first drawn box only.
    c.acroForm.textfield(name="name", x=160, y=h - 120, width=280, height=20, borderWidth=0, fillColor=None, forceBorder=False)
    c.showPage()
    c.setFont("Helvetica-Bold", 16)
    c.drawString(56, h - 72, "Page two")
    c.setFont("Helvetica", 11)
    for i, label in enumerate(("Phone", "Notes")):
        y = h - 120 - i * 32
        c.setFillColor(INK)
        c.drawString(56, y + 6, label)
        c.setFillColor(HexColor("#e2e2e2"))
        c.rect(160, y, 280, 20, fill=1, stroke=0)
    # Decoration: empty frames and a colour block with nothing written near them.
    c.setStrokeColor(HexColor("#9aa3b5"))
    c.setLineWidth(1)
    c.rect(56, 120, 220, 140, stroke=1, fill=0)
    c.rect(320, 120, 220, 140, stroke=1, fill=0)
    c.setFillColor(HexColor("#2f3fd6"))
    c.rect(w - 90, h - 60, 34, 34, fill=1, stroke=0)
    c.showPage()
    c.save()


def make_retype():
    """Text to edit in place: an embedded (subset) TrueType font, a standard font,
    centred, right-aligned and coloured lines, a tinted box behind one line."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    ttf = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    pdfmetrics.registerFont(TTFont("DejaVuSans", ttf))
    path = FIX / "retype.pdf"
    w, h = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle("Edit text test")
    c.setFillColor(INK)
    c.setFont("DejaVuSans", 20)
    c.drawCentredString(w / 2, h - 80, "Invoice for March")
    c.setFont("DejaVuSans", 11)
    lines = ["Customer: Hartmann GmbH, Regensburg", "Amount due: 1,250.00 EUR", "Please pay within 14 days."]
    for i, t in enumerate(lines):
        c.drawString(56, h - 130 - i * 18, t)
    c.setFont("Helvetica", 11)
    c.drawString(56, h - 200, "Reference number 4471-B")
    c.drawRightString(w - 56, h - 230, "Total: 1,250.00 EUR")
    c.drawRightString(w - 56, h - 248, "VAT included")
    c.setFillColor(HexColor("#fff4c2"))
    c.rect(50, h - 292, 300, 22, fill=1, stroke=0)
    c.setFillColor(HexColor("#c42a35"))
    c.setFont("Helvetica-Bold", 12)
    c.drawString(56, h - 285, "Overdue since 12 April")
    c.showPage()
    c.save()


def make_form_fields():
    """Real form fields of every common kind, like the GemBox sample a tester sent:
    text, comb (10 boxes), radio, checkbox, dropdown, multi-select list, multi-line
    text and a Reset button. Default font settings (/DA, /DR) are removed on purpose:
    many forms in the wild lack them."""
    path = FIX / "form-fields.pdf"
    w, h = LETTER
    c = canvas.Canvas(str(path), pagesize=LETTER)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(50, h - 60, "PDF Form Example")
    c.setFont("Helvetica", 11)
    c.drawString(50, h - 76, "Fields of every common kind.")
    f = c.acroForm
    rows = [("Full name:", 675), ("Name:", 635), ("Gender:", 595), ("Married:", 555), ("City:", 515), ("Language:", 480), ("Notes:", 400)]
    for label, y in rows:
        c.drawRightString(195, y + 6, label)
    f.textfield(name="FullName", x=203, y=675, width=150, height=20, borderWidth=0, fillColor=None, fontSize=12)
    f.textfield(name="ID", x=203, y=635, width=150, height=20, maxlen=10, fieldFlags="comb", borderColor=INK, fontSize=12)
    f.radio(name="Gender", value="Male", x=203, y=595, size=20, buttonStyle="circle", selected=False, borderColor=INK, fillColor=None)
    f.radio(name="Gender", value="Female", x=278, y=595, size=20, buttonStyle="circle", selected=False, borderColor=INK, fillColor=None)
    c.drawString(228, 601, "Male")
    c.drawString(303, 601, "Female")
    f.checkbox(name="Married", x=203, y=555, size=20, buttonStyle="check", borderColor=INK, fillColor=None)
    f.textfield(name="Notes", x=203, y=332, width=150, height=80, fieldFlags="multiline", fontSize=12, borderWidth=0, fillColor=None)
    c.setFillColor(HexColor("#bfbfbf"))
    c.rect(203, 292, 150, 20, fill=1, stroke=0)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 11)
    c.drawCentredString(278, 298, "Reset")
    c.showPage()
    c.save()
    # The Reset button (a push button with a ResetForm action), and no default font settings.
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        page = pdf.pages[0]
        btn = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Btn, Ff=65536,
            T=pikepdf.String("ResetButton"), Rect=[203, 292, 353, 312], F=4, P=page.obj,
            A=pikepdf.Dictionary(S=pikepdf.Name.ResetForm),
        ))
        page.obj.Annots.append(btn)
        af = pdf.Root.AcroForm
        af.Fields.append(btn)
        # Dropdown (with typing allowed) and a multi-select list, as in the sample.
        def choice(name, rect, flags, opts, ap):
            stream = pikepdf.Stream(pdf, ap)
            stream.Type = pikepdf.Name.XObject
            stream.Subtype = pikepdf.Name.Form
            stream.BBox = [0, 0, rect[2] - rect[0], rect[3] - rect[1]]
            stream.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica)))
            d = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Ch, Ff=flags,
                T=pikepdf.String(name), Rect=rect, F=4, P=page.obj, Opt=[pikepdf.String(o) for o in opts],
                AP=pikepdf.Dictionary(N=stream),
            ))
            page.obj.Annots.append(d)
            af.Fields.append(d)
        choice("City", [203, 515, 353, 535], 393216, ["New York", "London", "Berlin", "Paris", "Rome"], b"/Tx BMC q 1 1 148 18 re W n Q EMC")
        choice("Language", [203, 432, 353, 492], 2097152, ["English", "German", "French", "Italian"], b"/Tx BMC q 1 1 148 58 re W n BT /Helv 12 Tf 0 g 2 47.4 Td (English) Tj 0 -14.28 Td (German) Tj 0 -14.28 Td (French) Tj 0 -14.28 Td (Italian) Tj ET Q EMC")
        for key in ("/DA", "/DR", "/NeedAppearances"):
            if key in af:
                del af[key]
        def strip(d):
            if "/DA" in d:
                del d["/DA"]
            for k in d.get("/Kids", []):
                strip(k)
        for fld in af.Fields:
            strip(fld)
        pdf.save(path)


if __name__ == "__main__":
    make_sample()
    make_retype()
    make_rotated()
    make_second()
    make_active()
    make_report()
    make_photos()
    make_form()
    make_form_fields()
    make_mixed()
    for p in [SAMPLE, *sorted(FIX.glob("*.pdf"))]:
        print(p.relative_to(ROOT), p.stat().st_size, "bytes")
