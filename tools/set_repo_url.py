"""Point every link in the project at the GitHub repository it is published to.

The project names its home in a few places: the README's download link, the submission write-up, the deployment
document, the user guide, the portable build's notes and the User-Agent of the data-download tools. They say
github.com/Aryan221224/MarsNav. If the project is published somewhere else, run

    python tools/set_repo_url.py <owner>/<name>

then rebuild the user guide (python tools/guide/builder/build.py) and commit. The demo video shows the address too
(submission/video/timeline.json); its text is updated here, but the rendered MP4 changes only when it is re-rendered
(submission/video/build_video.sh).
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CURRENT = "Aryan221224/MarsNav"
FILES = [
    "README.md",
    "launcher/make_portable.py",
    "tools/build_pov.py",
    "tools/build_features.py",
    "tools/guide/builder/c1_front.py",
    "docs/07_deployment_and_new_sites.md",
    "submission/PROJECT_SUBMISSION.md",
    "submission/video/timeline.json",
]


def main(argv):
    if len(argv) != 2 or not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", argv[1]):
        print(__doc__)
        print("usage: python tools/set_repo_url.py <owner>/<name>   (for example: my-team/MarsNav)")
        return 2
    new = argv[1]
    changed = 0
    for rel in FILES:
        path = os.path.join(ROOT, rel)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        n = text.count(CURRENT)
        if n:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(text.replace(CURRENT, new))
            changed += n
            print(f"{rel}: {n} link(s)")
    with open(__file__, encoding="utf-8") as f:
        me = f.read()
    with open(__file__, "w", encoding="utf-8", newline="") as f:
        f.write(me.replace(f'CURRENT = "{CURRENT}"', f'CURRENT = "{new}"', 1))
    print(f"{changed} link(s) now point to github.com/{new}.")
    print("Next: python tools/guide/builder/build.py (the guide shows the address), then commit.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
