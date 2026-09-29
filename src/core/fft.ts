/** 大于等于 n 的最小 2 的幂 */
export function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/**
 * 原地迭代式 FFT（Cooley–Tukey）。
 * re / im 长度必须为 2 的幂；inverse=true 时执行逆变换并归一化。
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length

  // 位反转置换
  let j = 0
  for (let i = 1; i < n; i++) {
    let bit = n >> 1
    while (j & bit) {
      j ^= bit
      bit >>= 1
    }
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((2 * Math.PI) / len) * (inverse ? 1 : -1)
    const wlenRe = Math.cos(angle)
    const wlenIm = Math.sin(angle)

    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      const half = len >> 1

      for (let k = 0; k < half; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + half] * wRe - im[i + k + half] * wIm
        const vIm = re[i + k + half] * wIm + im[i + k + half] * wRe

        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + half] = uRe - vRe
        im[i + k + half] = uIm - vIm

        const nwRe = wRe * wlenRe - wIm * wlenIm
        wIm = wRe * wlenIm + wIm * wlenRe
        wRe = nwRe
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/**
 * 自相关：IFFT(|FFT(x)|²)
 * 计算前先减去均值，否则 DC 分量会压制周期性结构；
 * 结果按重叠样本数归一化，使 lag 之间的幅值可比。
 */
export function autocorrelation(signal: Float64Array): Float64Array {
  const n = signal.length
  if (n === 0) return new Float64Array(0)

  const size = nextPow2(n * 2)
  const re = new Float64Array(size)
  const im = new Float64Array(size)

  let mean = 0
  for (const x of signal) mean += x
  mean /= n
  for (let i = 0; i < n; i++) re[i] = signal[i] - mean

  fft(re, im)
  for (let i = 0; i < size; i++) {
    const power = re[i] * re[i] + im[i] * im[i]
    re[i] = power
    im[i] = 0
  }
  fft(re, im, true)

  const result = new Float64Array(n)
  const zero = re[0] || 1e-9
  for (let lag = 0; lag < n; lag++) {
    const overlap = n - lag
    result[lag] = re[lag] / overlap
    result[lag] /= zero / n
  }
  return result
}
