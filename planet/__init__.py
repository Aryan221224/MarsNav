"""
planet - the whole of Mars for MarsNav, streamed the way a flight simulator streams the Earth.

A tile pyramid covers the planet (equirectangular, the same layout as NASA's Mars Trek: zoom 0 = two 180 x 180 degree
tiles of 256 px). Every tile is built on demand from the best real data that exists at that place and scale, cached on
disk (rolling cache), and served to the app by the launcher:

  elevation   z 0-4   MOLA MEGDR 16 ppd (MGS laser altimeter; the whole planet, 3.7 km)               NASA PDS Geosciences
              z 5-9   MOLA-HRSC blended DEM, 200 m (read by HTTP range requests)                      USGS Astrogeology
              z 10+   + CTX stereo DTMs, 20 m, wherever they exist (USGS STAC catalogue, COGs)          USGS / MRO CTX
              z 13+   + HiRISE stereo DTMs, 1 m, wherever they exist (USGS STAC catalogue, COGs)        USGS / MRO HiRISE
  imagery     z 0-7   Viking MDIM 2.1 colour mosaic, or MOLA colour shaded relief (NASA Mars Trek WMTS)
              z 8+    upsampled colour pan-sharpened with CTX (6 m) and HiRISE orthoimages where they exist, otherwise
                      with a shaded relief of the elevation tile itself (so relief detail is always real data)

On top of the stream: a global router (any two points on Mars), a landing-site assessor (how NASA picks and flies a
landing), and a site builder that turns any point on Mars into a full MarsNav EVA site with the existing pipeline.
Every product records which dataset it came from and at what resolution.
"""

__version__ = "2.0.0"
