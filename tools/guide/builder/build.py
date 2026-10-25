# -*- coding: utf-8 -*-
"""Build the MarsNav User Guide PDF.   python tools/guide/builder/build.py [output.pdf]   (needs reportlab and Pillow)

Default output: MarsNav_User_Guide.pdf at the repository root. Figures come from tools/guide/assets/img, or are
re-cropped from fresh captures in data_cache/guide when tools/guide/capture_guide.py has been run.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glib  # noqa: E402

for part in ("c1_front", "c2_landing", "c3_planner", "c4_rest"):
    t0 = time.time()
    exec(open(os.path.join(HERE, f"{part}.py"), encoding="utf-8").read(), {"__name__": part})
    print(part, f"{time.time() - t0:.1f}s, figures so far {glib._fig[0]}")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(glib.ROOT, "MarsNav_User_Guide.pdf")
doc = glib.make_doc(OUT)
doc.multiBuild(glib.story)
print("wrote", OUT)
