// node_io.js - Node.js I/O adapter for loadTerrain (tests, CLI, validation). Not used in the browser.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export function nodeIO(dir) {
  return {
    json: async (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")),
    gz: async (f) => {
      const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, f)));
      // copy into an aligned buffer so typed-array views of any width are legal
      const out = new Uint8Array(new ArrayBuffer(b.length));
      out.set(b);
      return out;
    },
  };
}
