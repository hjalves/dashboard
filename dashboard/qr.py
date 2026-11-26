"""QR codes drawn as Metro-style SVG: small square modules with thin gaps, and the three finder
"eyes" as a ring plus a solid centre. Built from segno's matrix; low error correction keeps the
code coarse (and so scannable from further away)."""

import segno

DARK = "#22163a"   # deep purple, as the news tile
LIGHT = "#f3f0f7"  # soft off-white


def qr_svg(text: str, dark: str = DARK, light: str | None = None, border: int = 2, px: int = 4) -> bytes:
    """With light=None the background is left transparent, for the page to style (frosted glass)."""
    """`px` screen pixels per module (shown at natural size): the dots are px-1 pixels with a
    1-pixel gap, so every gap lands on whole pixels and the pattern stays even."""
    q = segno.make(text, error="l", micro=False)
    m = q.matrix
    n = len(m)
    size = n + 2 * border
    dot = (px - 1) / px
    finders = [(0, 0), (n - 7, 0), (0, n - 7)]

    def in_finder(x, y):
        return any(fx <= x < fx + 7 and fy <= y < fy + 7 for fx, fy in finders)

    inset = 0  # dot in the top-left px-1 pixels, gap on the right and bottom: whole pixels
    dots = []
    for y, row in enumerate(m):
        for x, v in enumerate(row):
            if v and not in_finder(x, y):
                dots.append(f"M{x + border + inset:.2f} {y + border + inset:.2f}h{dot:.2f}v{dot:.2f}h-{dot:.2f}z")

    eyes = []
    for fx, fy in finders:
        x, y = fx + border, fy + border
        # Ring: a 7×7 square with a 5×5 hole (even-odd), then the 3×3 centre.
        eyes.append(f'<path fill-rule="evenodd" d="M{x} {y}h7v7h-7z M{x + 1} {y + 1}v5h5v-5z"/>'
                    f'<rect x="{x + 2}" y="{y + 2}" width="3" height="3" rx=".45"/>')

    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size * px}" '
           f'height="{size * px}" shape-rendering="crispEdges">'
           + (f'<rect width="{size}" height="{size}" fill="{light}"/>' if light else "") +
           f'<g fill="{dark}"><path d="{"".join(dots)}"/>{"".join(eyes)}</g></svg>')
    return svg.encode()
