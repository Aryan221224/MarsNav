# -*- coding: utf-8 -*-
"""Layout library for the MarsNav User Guide (reportlab)."""
import os
import re
from PIL import Image as PILImage
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Image, Table, TableStyle,
                                PageBreak, KeepTogether, NextPageTemplate, Flowable, CondPageBreak)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon, Circle
from reportlab.graphics import renderPDF

# Paths, relative to the repository. Raw screenshots come from tools/guide/capture_guide.py (data_cache/guide, run
# against the desktop app); the cropped figures they produce are kept in tools/guide/assets/img, so the guide also
# builds from a fresh clone without re-capturing.
_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", ".."))
ASSETS = os.path.join(_HERE, "..", "assets")
FONTS = os.environ.get("MARSNAV_GUIDE_FONTS", os.path.join(ASSETS, "fonts"))
SHOTS = os.path.join(ROOT, "data_cache", "guide")
SHOTS2 = os.path.join(ROOT, "data_cache", "shots")
IMG = os.path.join(ASSETS, "img")
LOGO = os.path.join(ASSETS, "logo.png")
os.makedirs(IMG, exist_ok=True)

# ------------------------------------------------------------------ fonts
for name, f in [("Barlow", "Barlow-Regular.ttf"), ("Barlow-Medium", "Barlow-Medium.ttf"),
                ("Barlow-SemiBold", "Barlow-SemiBold.ttf"), ("Barlow-Bold", "Barlow-Bold.ttf"),
                ("Barlow-Italic", "Barlow-Italic.ttf"), ("Barlow-MediumItalic", "Barlow-MediumItalic.ttf"),
                ("BarlowC-Medium", "BarlowCondensed-Medium.ttf"), ("BarlowC-SemiBold", "BarlowCondensed-SemiBold.ttf"),
                ("BarlowC-Bold", "BarlowCondensed-Bold.ttf"), ("Plex", "IBMPlexMono-Regular.ttf"),
                ("Plex-Medium", "IBMPlexMono-Medium.ttf")]:
    pdfmetrics.registerFont(TTFont(name, os.path.join(FONTS, f)))
pdfmetrics.registerFont(TTFont("DejaVu", os.path.join(FONTS, "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("DejaVu-Bold", os.path.join(FONTS, "DejaVuSans-Bold.ttf")))
addMapping("Barlow", 0, 0, "Barlow"); addMapping("Barlow", 1, 0, "Barlow-SemiBold")
addMapping("Barlow", 0, 1, "Barlow-Italic"); addMapping("Barlow", 1, 1, "Barlow-MediumItalic")
addMapping("Plex", 0, 0, "Plex"); addMapping("Plex", 1, 0, "Plex-Medium"); addMapping("Plex", 0, 1, "Plex"); addMapping("Plex", 1, 1, "Plex-Medium")
addMapping("BarlowC-SemiBold", 0, 0, "BarlowC-SemiBold"); addMapping("BarlowC-SemiBold", 1, 0, "BarlowC-Bold")
addMapping("BarlowC-SemiBold", 0, 1, "BarlowC-SemiBold"); addMapping("BarlowC-SemiBold", 1, 1, "BarlowC-Bold")
addMapping("DejaVu", 0, 0, "DejaVu"); addMapping("DejaVu", 1, 0, "DejaVu-Bold"); addMapping("DejaVu", 0, 1, "DejaVu"); addMapping("DejaVu", 1, 1, "DejaVu-Bold")

# ------------------------------------------------------------------ palette
INK = colors.HexColor("#171a20")
BODY = colors.HexColor("#2a2d33")
MUTED = colors.HexColor("#6b6f77")
RUST = colors.HexColor("#c8502d")
RUST_D = colors.HexColor("#9c3a1f")
SAND = colors.HexColor("#d9a77c")
NIGHT = colors.HexColor("#0c0f13")
NIGHT2 = colors.HexColor("#161b22")
PALE = colors.HexColor("#f7f2eb")
PALE2 = colors.HexColor("#fbf8f4")
LINE = colors.HexColor("#e2d8ca")
GO = colors.HexColor("#2c8a55")
CAUT = colors.HexColor("#c58a12")
NOGO = colors.HexColor("#b4302a")
CYAN = colors.HexColor("#1f7a99")

PAGE_W, PAGE_H = LETTER
M = 0.78 * inch
TOP = 0.95 * inch
BOT = 0.8 * inch
CW = PAGE_W - 2 * M          # content width

# ------------------------------------------------------------------ text
_SYM = "→←↑↓✓✗▲■σ∼⟂"


def fx(t):
    """Glyph fixes: subscripts as markup, symbols Barlow lacks in DejaVu."""
    t = str(t)
    t = t.replace("₂", "<sub>2</sub>").replace("₃", "<sub>3</sub>").replace("²", "<super>2</super>").replace("³", "<super>3</super>")
    out = []
    for ch in t:
        out.append(f'<font name="DejaVu">{ch}</font>' if ch in _SYM else ch)
    return "".join(out)


def S(name, **kw):
    base = dict(fontName="Barlow", fontSize=10.2, leading=15.2, textColor=BODY, spaceAfter=7)
    base.update(kw)
    return ParagraphStyle(name, **base)


ST = {
    "body": S("body"),
    "lead": S("lead", fontSize=12.6, leading=19, textColor=INK, spaceAfter=12),
    "small": S("small", fontSize=8.9, leading=12.6, textColor=MUTED, spaceAfter=5),
    "bullet": S("bullet", leftIndent=14, bulletIndent=2, spaceAfter=3.5, bulletFontName="DejaVu", bulletFontSize=7.5, bulletColor=RUST),
    "num": S("num", leftIndent=14, bulletIndent=0, spaceAfter=3.5, bulletFontName="Barlow-SemiBold", bulletColor=RUST),
    "h1": S("h1", fontName="BarlowC-Bold", fontSize=30, leading=33, textColor=INK, spaceAfter=6),
    "kicker": S("kicker", fontName="BarlowC-SemiBold", fontSize=11, leading=13, textColor=RUST, spaceAfter=2),
    "h2": S("h2", fontName="BarlowC-Bold", fontSize=17.5, leading=21, textColor=INK, spaceBefore=12, spaceAfter=6),
    "h3": S("h3", fontName="BarlowC-SemiBold", fontSize=12.8, leading=16, textColor=RUST_D, spaceBefore=8, spaceAfter=3.5),
    "cap": S("cap", fontName="Barlow-Italic", fontSize=8.6, leading=11.8, textColor=MUTED, spaceBefore=4, spaceAfter=12),
    "code": S("code", fontName="Plex", fontSize=8.3, leading=12.2, textColor=INK, backColor=PALE, borderPadding=(6, 8, 6, 8),
              spaceBefore=4, spaceAfter=11),
    "cell": S("cell", fontSize=8.7, leading=11.6, spaceAfter=0),
    "cellb": S("cellb", fontName="Barlow-SemiBold", fontSize=8.7, leading=11.6, spaceAfter=0, textColor=INK),
    "cellh": S("cellh", fontName="BarlowC-SemiBold", fontSize=9.4, leading=11.6, spaceAfter=0, textColor=colors.white),
    "cellm": S("cellm", fontName="Plex", fontSize=7.9, leading=10.8, spaceAfter=0, textColor=INK),
    "callt": S("callt", fontName="BarlowC-Bold", fontSize=11.5, leading=14, textColor=RUST_D, spaceAfter=3),
    "call": S("call", fontSize=9.6, leading=14, spaceAfter=3),
    "stat": S("stat", fontName="BarlowC-Bold", fontSize=25, leading=27, textColor=RUST, alignment=TA_LEFT, spaceAfter=1),
    "statl": S("statl", fontSize=8.1, leading=10.6, textColor=BODY, spaceAfter=0),
    "toc0": S("toc0", fontName="Barlow-SemiBold", fontSize=10.2, leading=13, textColor=INK, spaceBefore=1.5),
    "toc1": S("toc1", fontSize=8.3, leading=9.9, leftIndent=18, textColor=BODY),
}

story = []
_fig = [0]
_chap = [0]


def P(t, st="body"):
    story.append(Paragraph(fx(t), ST[st]))


def lead(t):
    P(t, "lead")


def small(t):
    P(t, "small")


def H2(t):
    story.append(CondPageBreak(1.3 * inch))
    story.append(Paragraph(fx(t), ST["h2"]))


def H3(t):
    story.append(CondPageBreak(0.9 * inch))
    story.append(Paragraph(fx(t), ST["h3"]))


def bullets(items, st="bullet"):
    for t in items:
        story.append(Paragraph(fx(t), ST[st], bulletText="▪"))
    story.append(Spacer(1, 4))


def numbered(items):
    for i, t in enumerate(items, 1):
        story.append(Paragraph(fx(t), ST["num"], bulletText=f"{i}."))
    story.append(Spacer(1, 4))


def code(t):
    story.append(Paragraph(t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br/>").replace("  ", "&nbsp;&nbsp;"), ST["code"]))


def spacer(h=6):
    story.append(Spacer(1, h))


def page_break():
    story.append(PageBreak())


def chapter(title, kicker=None, lead_text=None):
    """New chapter: page break, numbered kicker, big title, rust rule."""
    story.append(PageBreak())
    _chap[0] += 1
    n = _chap[0]
    story.append(ChapterMark(n, title))
    story.append(Paragraph(f"CHAPTER {n:02d}" + (f"  ·  {kicker.upper()}" if kicker else ""), ST["kicker"]))
    story.append(Paragraph(fx(title), ST["h1"]))
    story.append(Rule(CW, RUST, 2.2, space=10))
    if lead_text:
        lead(lead_text)


class ChapterMark(Flowable):
    """Invisible marker: TOC entry, outline and running-header text for a chapter."""
    def __init__(self, n, title):
        super().__init__()
        self.n, self.title = n, title
        self.width = self.height = 0

    def draw(self):
        pass


class Rule(Flowable):
    def __init__(self, w, color, thick=1, space=6):
        super().__init__()
        self.w, self.color, self.thick, self.space = w, color, thick, space

    def wrap(self, *a):
        return self.w, self.thick + self.space

    def draw(self):
        self.canv.setStrokeColor(self.color)
        self.canv.setLineWidth(self.thick)
        self.canv.line(0, self.space * 0.4, 56, self.space * 0.4)
        self.canv.setStrokeColor(LINE)
        self.canv.setLineWidth(0.6)
        self.canv.line(60, self.space * 0.4, self.w, self.space * 0.4)


def prep(name, crop=None, maxw=1800, quality=86, folder=None):
    """Load a screenshot, crop (px box), save as JPEG; returns (path, w, h)."""
    src = None
    for d in ([folder] if folder else []) + [SHOTS, SHOTS2]:
        p = os.path.join(d, name if name.endswith(".png") else name + ".png")
        if os.path.exists(p):
            src = p
            break
    key = os.path.splitext(os.path.basename(name))[0] + ("_c" + "_".join(map(str, crop)) if crop else "")
    out = os.path.join(IMG, key + ".jpg")
    if not src:
        # no raw capture on this machine: use the figure kept in the repository
        if os.path.exists(out):
            with PILImage.open(out) as im:
                return out, im.width, im.height
        raise FileNotFoundError(name)
    im = PILImage.open(src).convert("RGB")
    if crop:
        im = im.crop(crop)
    if im.width > maxw:
        im = im.resize((maxw, round(im.height * maxw / im.width)), PILImage.LANCZOS)
    im.save(out, quality=quality, optimize=True)
    return out, im.width, im.height


class Framed(Flowable):
    """An image with a thin frame and a soft shadow; optional numbered markers (x, y as fractions)."""
    def __init__(self, path, w, h, marks=None, frame=True):
        super().__init__()
        self.path, self.w, self.h, self.marks, self.frame = path, w, h, marks or [], frame

    def wrap(self, *a):
        return self.w, self.h + 3

    def draw(self):
        c = self.canv
        if self.frame:
            c.saveState()                   # the shadow's transparency must not apply to the image
            c.setFillColor(colors.Color(0, 0, 0, alpha=0.10))
            c.rect(2.2, -2.2 + 3, self.w, self.h, stroke=0, fill=1)
            c.restoreState()
        c.drawImage(self.path, 0, 3, self.w, self.h)
        if self.frame:
            c.setStrokeColor(colors.HexColor("#b9b2a8"))
            c.setLineWidth(0.5)
            c.rect(0, 3, self.w, self.h, stroke=1, fill=0)
        for (fx_, fy, label) in self.marks:
            x, y = fx_ * self.w, 3 + (1 - fy) * self.h
            c.setFillColor(RUST)
            c.setStrokeColor(colors.white)
            c.setLineWidth(1.2)
            c.circle(x, y, 7.2, stroke=1, fill=1)
            c.setFillColor(colors.white)
            c.setFont("BarlowC-Bold", 9.5)
            c.drawCentredString(x, y - 3.3, str(label))


def figure(name, caption, width=CW, crop=None, marks=None, keep=True):
    path, w0, h0 = prep(name, crop)
    h = width * h0 / w0
    if h > 7.9 * inch:
        width = width * 7.9 * inch / h
        h = 7.9 * inch
    _fig[0] += 1
    img = Framed(path, width, h, marks)
    t = Table([[img]], colWidths=[CW], style=[("ALIGN", (0, 0), (-1, -1), "CENTER"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                                ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 2),
                                                ("BOTTOMPADDING", (0, 0), (-1, -1), 0)])
    cap = Paragraph(fx(f"<font name='Barlow-SemiBold' color='#9c3a1f'>Figure {_fig[0]}.</font> {caption}"), ST["cap"])
    story.append(KeepTogether([t, cap]) if keep else t)
    if not keep:
        story.append(cap)


def figrow(items, caption, height=None, gap=10):
    """Several images side by side at the same height: items = [(name, crop or None, sub-caption or None)]."""
    preps = [prep(n, c) for n, c, _ in items]
    ratios = [w / h for _, w, h in preps]
    total_gap = gap * (len(items) - 1)
    hh = (CW - total_gap) / sum(ratios)
    if height:
        hh = min(hh, height)
    cells, subs = [], []
    for (path, w, h), (n, c, sub) in zip(preps, items):
        ww = hh * w / h
        cells.append(Framed(path, ww, hh))
        subs.append(Paragraph(fx(sub or ""), S("sub", fontName="Barlow-Medium", fontSize=8.2, leading=10.5, textColor=MUTED,
                                               alignment=TA_CENTER, spaceAfter=0)))
    widths = [hh * w / h + (gap if i < len(preps) - 1 else 0) for i, (_, w, h) in enumerate(preps)]
    rows = [cells] + ([subs] if any(s for _, _, s in items) else [])
    t = Table(rows, colWidths=widths, style=[("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                             ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 2),
                                             ("BOTTOMPADDING", (0, 0), (-1, -1), 0)])
    _fig[0] += 1
    cap = Paragraph(fx(f"<font name='Barlow-SemiBold' color='#9c3a1f'>Figure {_fig[0]}.</font> {caption}"), ST["cap"])
    story.append(KeepTogether([t, cap]))


def callout(title, text, tone="rust", items=None):
    col = {"rust": RUST, "green": GO, "cyan": CYAN, "amber": CAUT}[tone]
    bg = {"rust": colors.HexColor("#fbf1ec"), "green": colors.HexColor("#eef7f1"), "cyan": colors.HexColor("#ecf5f8"),
          "amber": colors.HexColor("#fdf6e7")}[tone]
    tst = ParagraphStyle("ct", parent=ST["callt"], textColor=col)
    flow = [Paragraph(fx(title), tst)]
    if text:
        flow.append(Paragraph(fx(text), ST["call"]))
    for it in items or []:
        flow.append(Paragraph(fx(it), ParagraphStyle("cb", parent=ST["call"], leftIndent=12, bulletIndent=0, bulletFontName="DejaVu", bulletFontSize=7.5), bulletText="▪"))
    t = Table([[flow]], colWidths=[CW], style=[("BACKGROUND", (0, 0), (-1, -1), bg), ("LINEBEFORE", (0, 0), (0, -1), 3, col),
                                              ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                                              ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)])
    t.spaceAfter = 9
    story.append(t)


def table(rows, widths, head=True, mono_first=False, bold_first=True, zebra=True, font=None):
    data = []
    for i, r in enumerate(rows):
        cells = []
        for j, c in enumerate(r):
            if head and i == 0:
                st = "cellh"
            elif j == 0 and mono_first:
                st = "cellm"
            elif j == 0 and bold_first:
                st = "cellb"
            else:
                st = "cell"
            cells.append(Paragraph(fx(str(c)).replace("\n", "<br/>"), ST[st]))
        data.append(cells)
    t = Table(data, colWidths=widths, repeatRows=1 if head else 0)
    sty = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.5, LINE),
           ("TOPPADDING", (0, 0), (-1, -1), 4.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 4.2),
           ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6)]
    if head:
        sty += [("BACKGROUND", (0, 0), (-1, 0), NIGHT2), ("LINEBELOW", (0, 0), (-1, 0), 1.2, RUST)]
    if zebra:
        sty += [("ROWBACKGROUNDS", (0, 1 if head else 0), (-1, -1), [colors.white, PALE2])]
    t.setStyle(TableStyle(sty))
    t.spaceAfter = 9                      # (a Spacer would be carried to the next page and could leave it empty)
    story.append(t)


def stats(items, cols=4):
    """Big-number tiles: items = [(number, label)]."""
    cells = []
    for num, lab in items:
        cells.append([Paragraph(fx(num), ST["stat"]), Paragraph(fx(lab), ST["statl"])])
    rows = [cells[i:i + cols] for i in range(0, len(cells), cols)]
    for r in rows:
        while len(r) < cols:
            r.append("")
    w = CW / cols
    t = Table(rows, colWidths=[w] * cols)
    sty = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
           ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
           ("BACKGROUND", (0, 0), (-1, -1), PALE2), ("LINEABOVE", (0, 0), (-1, 0), 2, RUST),
           ("INNERGRID", (0, 0), (-1, -1), 0.6, colors.white)]
    t.setStyle(TableStyle(sty))
    t.spaceAfter = 10
    story.append(t)


# ------------------------------------------------------------------ diagrams
def _box(d, x, y, w, h, title, sub, fill, fg=colors.white, subfg=None):
    d.add(Rect(x, y, w, h, rx=7, ry=7, fillColor=fill, strokeColor=None))
    d.add(String(x + w / 2, y + h - 18, title, fontName="BarlowC-Bold", fontSize=11.5, fillColor=fg, textAnchor="middle"))
    yy = y + h - 31
    for line in sub:
        d.add(String(x + w / 2, yy, line, fontName="Barlow", fontSize=7.6, fillColor=subfg or fg, textAnchor="middle"))
        yy -= 9.6


def _arrow(d, x1, y1, x2, y2, col=RUST):
    d.add(Line(x1, y1, x2, y2, strokeColor=col, strokeWidth=1.6))
    import math
    a = math.atan2(y2 - y1, x2 - x1)
    s = 5.5
    d.add(Polygon([x2, y2, x2 - s * math.cos(a - 0.45), y2 - s * math.sin(a - 0.45), x2 - s * math.cos(a + 0.45),
                   y2 - s * math.sin(a + 0.45)], fillColor=col, strokeColor=None))


def journey():
    """The mission workflow MarsNav covers, as five stages."""
    W, H = CW, 128
    d = Drawing(W, H)
    stages = [("1  CHOOSE", ["Landing mode:", "screen 66 candidate", "sites on real data"], NIGHT2),
              ("2  COMMIT", ["Assess the ellipse,", "water, dust, craters;", "build the hub site"], NIGHT2),
              ("3  PLAN", ["EVA planner: hard", "limits first, five", "named routes"], RUST_D),
              ("4  FLY", ["Live telemetry,", "closed loop, C&W,", "walk-home re-plans"], RUST_D),
              ("5  REVIEW", ["Planned vs flown,", "cue card, GeoJSON,", "validation"], RUST_D)]
    n = len(stages)
    gap = 14
    bw = (W - gap * (n - 1)) / n
    for i, (t, sub, col) in enumerate(stages):
        x = i * (bw + gap)
        _box(d, x, 22, bw, 84, t, sub, col, subfg=colors.HexColor("#e9ddd2"))
        if i < n - 1:
            _arrow(d, x + bw + 1.5, 64, x + bw + gap - 1.5, 64)
    d.add(String(W * 0.2, 6, "LANDING MODE  ·  where the crew lands and lives", fontName="BarlowC-SemiBold", fontSize=8.5,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(W * 0.7, 6, "EVA PLANNER  ·  every Marswalk, before, during and after", fontName="BarlowC-SemiBold",
                 fontSize=8.5, fillColor=MUTED, textAnchor="middle"))
    d.add(Line(0, 16, 2 * bw + gap, 16, strokeColor=NIGHT2, strokeWidth=1))
    d.add(Line(2 * (bw + gap), 16, W, 16, strokeColor=RUST_D, strokeWidth=1))
    story.append(d)
    story.append(Spacer(1, 8))


def architecture():
    W, H = CW, 270
    d = Drawing(W, H)
    # top: the window
    _box(d, 0, 196, W, 66, "MarsNav.exe  ·  native desktop window", ["Microsoft Edge WebView2 via pywebview  ·  menus, start-up screen, native Save dialogs, extra windows",
                                                                     "The app itself: HTML/JS interface + the planning engine in plain JavaScript (runs in the window, offline)"],
         NIGHT2, subfg=colors.HexColor("#d9d2c8"))
    _arrow(d, W / 2, 196, W / 2, 172)
    d.add(String(W / 2 + 8, 181, "HTTP on 127.0.0.1 only", fontName="Barlow-Italic", fontSize=7.6, fillColor=MUTED))
    # middle: server
    _box(d, 0, 104, W * 0.62, 66, "Local server  (supervised process)", ["Serves the app, streams whole-planet map tiles, planet API,",
                                                                          "landing assessment, Local mode, live TSS telemetry bridge"], RUST_D,
         subfg=colors.HexColor("#f3e2d8"))
    _box(d, W * 0.65, 104, W * 0.35, 66, "Workers and jobs", ["1-3 raster readers (GDAL),", "routes, hub builds, downloads", "in their own processes"],
         RUST, subfg=colors.HexColor("#fbe9e0"))
    _arrow(d, W * 0.62 + 2, 137, W * 0.65 - 2, 137)
    _arrow(d, W * 0.3, 104, W * 0.3, 80)
    _arrow(d, W * 0.82, 104, W * 0.82, 80)
    # bottom: data
    _box(d, 0, 10, W * 0.48, 68, "On this computer", ["data_cache/: tile cache, MOLA grids, catalogues,", "science layers, Local mode packs, built sites",
                                                       "app/data/: Jezero sites (shipped, fully offline)"], colors.HexColor("#3a3f47"),
         subfg=colors.HexColor("#dcdcdc"))
    _box(d, W * 0.52, 10, W * 0.48, 68, "NASA / USGS / ASU / PSI servers", ["MOLA, HRSC, CTX, HiRISE (USGS STAC, PDS),", "Mars Trek tiles, SWIM ice, TES, GRS, craters",
                                                                           "(never contacted in Mars mode)"], colors.HexColor("#3a3f47"),
         subfg=colors.HexColor("#dcdcdc"))
    story.append(d)
    story.append(Spacer(1, 6))


# ------------------------------------------------------------------ document
class GuideDoc(BaseDocTemplate):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.chapter_title = ""

    def beforeDocument(self):
        self.chapter_title = ""          # multiBuild runs several passes

    def afterFlowable(self, f):
        if isinstance(f, ChapterMark):
            self.chapter_title = f.title
            key = f"ch{f.n}"
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(f"{f.n}. {f.title}", key, level=0, closed=True)
            self.notify("TOCEntry", (0, f"{f.n:02d}   {f.title}", self.page, key))
        elif isinstance(f, Paragraph) and f.style.name == "h2" and self.chapter_title:
            key = f"h2-{self.page}-{id(f)}"
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(f.getPlainText(), key, level=1, closed=True)
            self.notify("TOCEntry", (1, f.getPlainText(), self.page, key))


def body_page_end(c, doc):
    c.saveState()
    # header
    c.drawImage(LOGO, M, PAGE_H - 0.66 * inch, 0.32 * inch, 0.32 * inch, mask="auto")
    c.setFont("BarlowC-Bold", 9.5)
    c.setFillColor(INK)
    c.drawString(M + 0.4 * inch, PAGE_H - 0.55 * inch, "MARSNAV")
    c.setFont("BarlowC-Medium", 9.5)
    c.setFillColor(MUTED)
    c.drawString(M + 0.4 * inch + 44, PAGE_H - 0.55 * inch, "USER GUIDE")
    c.drawRightString(PAGE_W - M, PAGE_H - 0.55 * inch, (doc.chapter_title or "").upper())
    c.setStrokeColor(LINE)
    c.setLineWidth(0.6)
    c.line(M, PAGE_H - 0.72 * inch, PAGE_W - M, PAGE_H - 0.72 * inch)
    # footer
    c.line(M, 0.58 * inch, PAGE_W - M, 0.58 * inch)
    c.setFont("Barlow", 8)
    c.drawString(M, 0.42 * inch, "NASA Space Apps Challenge 2026  ·  Interplanetary Survival Guide: Martian Map")
    c.setFont("BarlowC-Bold", 10)
    c.setFillColor(RUST)
    c.drawRightString(PAGE_W - M, 0.41 * inch, str(doc.page))
    c.restoreState()


def make_doc(out):
    doc = GuideDoc(out, pagesize=LETTER, leftMargin=M, rightMargin=M, topMargin=TOP, bottomMargin=BOT,
                   title="MarsNav User Guide", author="MarsNav team (NASA Space Apps Challenge 2026)",
                   subject="Landing site selection and EVA planning for human Mars exploration - user guide",
                   keywords="MarsNav, Mars, EVA, landing site, NASA Space Apps, Martian Map")
    full = Frame(0, 0, PAGE_W, PAGE_H, id="full", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    body = Frame(M, BOT, CW, PAGE_H - TOP - BOT, id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="Cover", frames=[full], onPage=draw_cover),
                          PageTemplate(id="Body", frames=[body], onPageEnd=body_page_end)])
    return doc


def draw_cover(c, doc):
    c.saveState()
    c.setFillColor(NIGHT)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    # faint stars
    import random
    rnd = random.Random(7)
    c.saveState()
    for _ in range(140):
        x, y = rnd.uniform(0, PAGE_W), rnd.uniform(0, PAGE_H)
        r = rnd.choice([0.4, 0.5, 0.6, 0.8, 1.0])
        c.setFillColor(colors.Color(1, 1, 1, alpha=rnd.uniform(0.15, 0.6)))
        c.circle(x, y, r, stroke=0, fill=1)
    c.restoreState()
    # glow + logo
    cx, cy, R = PAGE_W / 2, PAGE_H * 0.60, 2.15 * inch
    c.saveState()
    for k in range(18, 0, -1):
        c.setFillColor(colors.Color(0.85, 0.36, 0.2, alpha=0.012 * (19 - k) / 3))
        c.circle(cx, cy, R * (0.95 + k * 0.03), stroke=0, fill=1)
    c.restoreState()
    c.drawImage(LOGO, cx - R, cy - R, 2 * R, 2 * R, mask="auto")
    # title
    c.setFillColor(colors.white)
    c.setFont("BarlowC-Bold", 54)
    title = "MARSNAV"
    tw = sum(pdfmetrics.stringWidth(ch, "BarlowC-Bold", 54) for ch in title) + 14 * (len(title) - 1)
    x = cx - tw / 2
    for i, ch in enumerate(title):
        c.setFillColor(colors.white if i < 4 else colors.HexColor("#e8925a"))
        c.drawString(x, PAGE_H * 0.315, ch)
        x += pdfmetrics.stringWidth(ch, "BarlowC-Bold", 54) + 14
    c.setFont("Barlow", 13.5)
    c.setFillColor(colors.HexColor("#d8d2c9"))
    c.drawCentredString(cx, PAGE_H * 0.275, "Landing site selection and EVA navigation for the first humans on Mars")
    c.setStrokeColor(RUST)
    c.setLineWidth(1.5)
    c.line(cx - 40, PAGE_H * 0.252, cx + 40, PAGE_H * 0.252)
    c.setFont("BarlowC-SemiBold", 17)
    c.setFillColor(colors.white)
    c.drawCentredString(cx, PAGE_H * 0.218, "USER GUIDE  &  MISSION HANDBOOK")
    c.setFont("Barlow", 10)
    c.setFillColor(colors.HexColor("#9aa0a8"))
    c.drawCentredString(cx, PAGE_H * 0.19, "Version 2.0  ·  Windows desktop app  ·  real NASA and USGS Mars data")
    # bottom band
    c.setFillColor(NIGHT2)
    c.rect(0, 0, PAGE_W, 0.9 * inch, stroke=0, fill=1)
    c.setFillColor(RUST)
    c.rect(0, 0.9 * inch, PAGE_W, 2.2, stroke=0, fill=1)
    c.setFont("BarlowC-SemiBold", 11)
    c.setFillColor(colors.white)
    c.drawCentredString(cx, 0.52 * inch, "NASA SPACE APPS CHALLENGE 2026")
    c.setFont("Barlow", 9.5)
    c.setFillColor(colors.HexColor("#c9c3ba"))
    c.drawCentredString(cx, 0.32 * inch, "Challenge: Interplanetary Survival Guide: Martian Map")
    c.restoreState()


def toc_flowable():
    toc = TableOfContents()
    toc.levelStyles = [ST["toc0"], ST["toc1"]]
    toc.dotsMinLevel = 0
    return toc
