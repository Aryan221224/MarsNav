"""Window chrome for MarsNav's native windows, in the app's console colours.

  * a dark title bar (Windows 10 version 2004 and later, Windows 11) with the caption in the app's panel colour (Windows 11),
  * the menu bar (MarsNav / View / Data / Help) drawn dark, instead of the default light Windows menu.

Everything here is cosmetic and best-effort: if any step fails (older Windows, a pywebview or .NET change), the window keeps
the standard Windows look and the failure is only logged.
"""
from __future__ import annotations

import ctypes

# console palette (app/css/app.css)
BG = (0x12, 0x19, 0x23)          # menu bar and caption
DROP = (0x16, 0x1D, 0x28)        # drop-down menus
TEXT = (0xE6, 0xEA, 0xEF)
HOT = (0x26, 0x32, 0x43)         # highlighted menu item
LINE = (0x34, 0x44, 0x5A)        # drop-down border and separators
DIM = (0x8D, 0x9A, 0xAB)         # disabled item
_keep = []                       # .NET objects and handlers that must live as long as the windows


def _renderer_class():
    """A WinForms menu renderer in the console colours: menu bar, drop-downs, highlight, text and separators, and no
    light border. Defined once, at import (pythonnet cannot define a .NET subclass inside a UI-thread call). None if
    subclassing is unavailable; the menu then falls back to the system renderer with dark colours."""
    try:
        import clr  # noqa: F401
        from System.Drawing import Color, Pen, Point, Rectangle, SolidBrush
        from System.Windows.Forms import TextRenderer, ToolStripDropDown, ToolStripSystemRenderer
    except Exception:  # noqa: BLE001
        return None
    bg, drop, hot, line, text, dim = (Color.FromArgb(*c) for c in (BG, DROP, HOT, LINE, TEXT, DIM))
    brushes = {"bg": SolidBrush(bg), "drop": SolidBrush(drop), "hot": SolidBrush(hot)}
    pen = Pen(line)

    try:
        class MarsNavMenuRenderer(ToolStripSystemRenderer):
            __namespace__ = "MarsNav.Desktop"

            def OnRenderToolStripBackground(self, e):
                e.Graphics.FillRectangle(brushes["drop" if isinstance(e.ToolStrip, ToolStripDropDown) else "bg"], e.ToolStrip.ClientRectangle)

            def OnRenderToolStripBorder(self, e):
                if isinstance(e.ToolStrip, ToolStripDropDown):
                    r = e.ToolStrip.ClientRectangle
                    e.Graphics.DrawRectangle(pen, 0, 0, r.Width - 1, r.Height - 1)

            def OnRenderImageMargin(self, e):
                e.Graphics.FillRectangle(brushes["drop"], e.AffectedBounds)

            def OnRenderMenuItemBackground(self, e):
                it = e.Item
                r = Rectangle(Point.Empty, it.Size)
                if it.Selected or it.Pressed:
                    if it.IsOnDropDown:
                        r = Rectangle(2, 0, max(1, r.Width - 4), r.Height)
                    e.Graphics.FillRectangle(brushes["hot"], r)
                else:
                    e.Graphics.FillRectangle(brushes["drop" if it.IsOnDropDown else "bg"], r)

            def OnRenderItemText(self, e):
                TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, e.TextRectangle, text if e.Item.Enabled else dim, e.TextFormat)

            def OnRenderSeparator(self, e):
                y = e.Item.Height // 2
                e.Graphics.DrawLine(pen, 6, y, e.Item.Width - 6, y)

        return MarsNavMenuRenderer
    except Exception:  # noqa: BLE001
        return None


_RENDERER = _renderer_class()


def _colorref(rgb) -> int:
    r, g, b = rgb
    return r | (g << 8) | (b << 16)


def dark_title_bar(hwnd: int) -> bool:
    """DWMWA_USE_IMMERSIVE_DARK_MODE (20; 19 on early Windows 10 builds), then the caption and text colours (Windows 11:
    DWMWA_CAPTION_COLOR 35, DWMWA_TEXT_COLOR 36; ignored on Windows 10)."""
    dwm = ctypes.windll.dwmapi
    h = ctypes.c_void_p(hwnd)
    on = ctypes.c_int(1)
    ok = any(dwm.DwmSetWindowAttribute(h, attr, ctypes.byref(on), ctypes.sizeof(on)) == 0 for attr in (20, 19))
    for attr, rgb in ((35, BG), (36, TEXT)):
        c = ctypes.c_int(_colorref(rgb))
        dwm.DwmSetWindowAttribute(h, attr, ctypes.byref(c), ctypes.sizeof(c))
    # redraw the frame now (SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
    ctypes.windll.user32.SetWindowPos(h, None, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020)
    return ok


def _theme_menus(form) -> int:
    """Menu bar and drop-downs in the console colours: the console renderer when it could be defined, otherwise the
    system renderer with dark colours (visual styles off for tool strips; the selection then uses the Windows highlight)."""
    from System.Drawing import Color
    from System.Windows.Forms import MenuStrip, ToolStripDropDownMenu, ToolStripManager, ToolStripMenuItem, ToolStripRenderMode
    strips = [c for c in form.Controls if isinstance(c, MenuStrip)]
    if not strips:
        return 0
    bg, drop, text = Color.FromArgb(*BG), Color.FromArgb(*DROP), Color.FromArgb(*TEXT)
    renderer = None
    if _RENDERER is not None:
        try:
            renderer = _RENDERER()
            _keep.append(renderer)
        except Exception:  # noqa: BLE001
            renderer = None
    if renderer is None:
        ToolStripManager.VisualStylesEnabled = False

    def style(strip, color):
        if renderer is not None:
            strip.Renderer = renderer
        else:
            strip.RenderMode = ToolStripRenderMode.System
        strip.BackColor = color
        strip.ForeColor = text

    def paint(items):
        for it in items:
            it.ForeColor = text
            if isinstance(it, ToolStripMenuItem):
                dd = it.DropDown
                if dd is not None:
                    style(dd, drop)
                    if isinstance(dd, ToolStripDropDownMenu):
                        dd.ShowImageMargin = False
                paint(it.DropDownItems)

    form.BackColor = bg
    from System.Drawing import Rectangle, Region

    def clip(sender, e=None):              # leave out the two bottom rows, where Windows draws a light etched line
        r = sender.ClientRectangle
        sender.Region = Region(Rectangle(0, 0, r.Width, max(1, r.Height - 2)))

    for ms in strips:
        style(ms, bg)
        paint(ms.Items)
        clip(ms)
        ms.Resize += clip
        _keep.append(clip)
        ms.Invalidate()
    return len(strips)


def apply(window, log=lambda m: None) -> None:
    """Theme one pywebview window (WinForms backend). Safe to call from any thread once the window has been shown."""
    form = getattr(window, "native", None)
    if form is None:
        log("window theme: no native form")
        return

    def ui():
        try:
            dark_title_bar(int(form.Handle.ToInt64()))
        except Exception as e:  # noqa: BLE001
            log(f"window theme: title bar left standard ({type(e).__name__}: {e})")
        try:
            n = _theme_menus(form)
            if n:
                form.Invalidate(True)
            log(f"window theme: dark title bar, {n} menu bar(s), {'console' if _RENDERER is not None else 'system'} renderer")
        except Exception as e:  # noqa: BLE001
            log(f"window theme: menu left standard ({type(e).__name__}: {e})")

    try:
        from System import Func, Type          # the delegate type pywebview itself uses for Invoke
        if form.InvokeRequired:
            form.Invoke(Func[Type](ui))
        else:
            ui()
    except Exception as e:  # noqa: BLE001
        import traceback
        log(f"window theme skipped ({type(e).__name__}: {e})\n{traceback.format_exc()[-1500:]}")
