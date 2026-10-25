"""
targets.py - named places used by the demonstration, each tied to a real, checkable source.

Coordinates are Perseverance rover localisations from NASA's own traverse feed
(mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json, mirrored as data_cache/m20_waypoints_enomis.json),
taken at the sol of a publicly reported event. Sols are computed from NASA's Earth dates with engine/marstime.js
(Mars24 algorithm; sol 0 = 18 Feb 2021 landing) and matched to the nearest end-of-drive localisation.

`value` is the science priority used by the sortie optimiser. The ranking is the team's assumption [ASSUME],
argued from the Mars 2020 science case (biosignature candidates first, then the oldest rocks, then the delta).
"""

import json
import os

# The curated lists live in the site file so every site is defined in one place.
_SITE = json.load(open(os.path.join(os.environ.get("MM_ROOT") or os.path.join(os.path.dirname(__file__), ".."), "pipeline", "sites", "jezero.json")))
TARGETS = _SITE["targets"]
KEEPOUTS = _SITE["keepouts"]
