// Minimal in-place iterative radix-2 complex FFT.
// Good enough for N=2048 in JS; swap for WASM later if profiling says so.

export class FFT {
  readonly n: number
  private readonly rev: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array

  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT size must be a power of two')
    this.n = n
    const bits = Math.log2(n)
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = Math.sin((2 * Math.PI * i) / n)
    }
  }

  forward(re: Float64Array, im: Float64Array) {
    this.transform(re, im, false)
  }

  /** Inverse transform, including the 1/N scaling. */
  inverse(re: Float64Array, im: Float64Array) {
    this.transform(re, im, true)
    const s = 1 / this.n
    for (let i = 0; i < this.n; i++) {
      re[i] *= s
      im[i] *= s
    }
  }

  private transform(re: Float64Array, im: Float64Array, inv: boolean) {
    const { n, rev, cos, sin } = this
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    const sign = inv ? 1 : -1
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k]
          const wi = sign * sin[k]
          const a = start + j
          const b = a + half
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}
