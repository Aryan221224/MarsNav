// heap.js - binary min-heap keyed by float64 priority with an int32 payload.
// Structure-of-arrays storage so a search over millions of cells does not allocate an object per push.

export class MinHeap {
  constructor(capacity = 1 << 16) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }

  _grow() {
    const k = new Float64Array(this.keys.length * 2);
    const v = new Int32Array(this.vals.length * 2);
    k.set(this.keys);
    v.set(this.vals);
    this.keys = k;
    this.vals = v;
  }

  push(key, val) {
    if (this.size === this.keys.length) this._grow();
    let i = this.size++;
    const keys = this.keys, vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** Remove the minimum; returns its payload. Read `lastKey` for its priority. */
  pop() {
    const keys = this.keys, vals = this.vals;
    const topVal = vals[0];
    this.lastKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n], val = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return topVal;
  }

  peekKey() {
    return this.keys[0];
  }

  clear() {
    this.size = 0;
  }
}
