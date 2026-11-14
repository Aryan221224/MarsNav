#!/usr/bin/env bash
# Rebuild everything from raw data: fetch + verify inputs, terrain, layers, imagery, climate fit, app engine,
# tests and validation. Usage:  bash tools/build_all.sh [site ...]      (default: every site in pipeline/sites)
set -euo pipefail
cd "$(dirname "$0")/.."
SITES=("$@")
if [ ${#SITES[@]} -eq 0 ]; then
  mapfile -t SITES < <(python3 -c "import sys; sys.path.insert(0,'pipeline'); import sitecfg; print('\n'.join(sitecfg.list_sites()))")
fi
python3 pipeline/fetch_data.py ${FETCH_OPTIONAL:+--optional}
for s in "${SITES[@]}"; do python3 pipeline/build_terrain.py --site "$s"; done
python3 pipeline/build_layers.py --site jezero                # the MEDA fit samples this site's DEM at the rover
python3 pipeline/fit_meda.py                                 # Jezero MEDA climatology (reused by other sites)
for s in "${SITES[@]}"; do
  echo "=== site $s"
  python3 pipeline/build_layers.py --site "$s"
  python3 pipeline/build_imagery.py --site "$s"
done
python3 pipeline/build_clutter.py               # Jezero: 25 cm HiRISE clutter for the robotic scout (reads the mosaic in place, ~2 GB of range requests)
if [ -n "${GLOBAL_PRODUCTS:-}" ]; then         # the whole-planet products of the Worldview-style tools (docs/13)
  python3 tools/build_dust.py                   # dust climatology: 13 Mars Climate Database NetCDF files, pinned by SHA-256
  python3 tools/build_magnetic.py               # MGS crustal magnetic field (USGS grids, README check values asserted)
  python3 tools/build_marci_index.py            # MARCI daily-map index with coverage (reads 1.2 GB of monthly archives)
fi
bash tools/build_app.sh
python3 -m pytest tests -q
node --test tests/*.test.mjs
node validation/validate.mjs
node validation/closed_loop_campaign.mjs      # paired closed-loop trials; adds its rows to the Review panel
node validation/rover_case_study.mjs          # same trips as Perseverance, MarsNav vs the rover
echo "done: serve with  python3 -m http.server 8765 --directory app  and open http://localhost:8765"
