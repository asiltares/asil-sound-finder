// Shazam audio fingerprint generator: a JavaScript port of the algorithm from
// SongRec (https://github.com/marin-m/SongRec), licensed under GPL-3.0.

const SAMPLE_RATE = 16000;
const FFT_SIZE = 2048;
const BINS = FFT_SIZE / 2 + 1;
const RING = 256;

const HANNING = new Float64Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANNING[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 1)) / 2049);
}

const LOG2N = Math.log2(FFT_SIZE);
const REV = new Uint32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  let r = 0;
  for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
  REV[i] = r;
}
const COS = new Float64Array(FFT_SIZE / 2);
const SIN = new Float64Array(FFT_SIZE / 2);
for (let i = 0; i < FFT_SIZE / 2; i++) {
  COS[i] = Math.cos((-2 * Math.PI * i) / FFT_SIZE);
  SIN[i] = Math.sin((-2 * Math.PI * i) / FFT_SIZE);
}

function fftInPlace(re, im) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step], wi = SIN[k * step];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

class SignatureGenerator {
  constructor() {
    this.samples = new Int16Array(FFT_SIZE);
    this.samplesPos = 0;
    this.fftOutputs = Array.from({ length: RING }, () => new Float64Array(BINS));
    this.fftPos = 0;
    this.fftWritten = 0;
    this.spread = Array.from({ length: RING }, () => new Float64Array(BINS));
    this.spreadPos = 0;
    this.spreadWritten = 0;
    this.peaks = new Map();
    this.re = new Float64Array(FFT_SIZE);
    this.im = new Float64Array(FFT_SIZE);
  }

  processChunk(chunk ) {
    this.doFft(chunk);
    this.doPeakSpreading();
    if (this.spreadWritten >= 46) this.doPeakRecognition();
  }

  doFft(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      this.samples[this.samplesPos] = chunk[i];
      this.samplesPos = (this.samplesPos + 1) % FFT_SIZE;
    }
    const { re, im } = this;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = this.samples[(this.samplesPos + i) % FFT_SIZE] * HANNING[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const out = this.fftOutputs[this.fftPos];
    for (let i = 0; i < BINS; i++) {
      const v = (re[i] * re[i] + im[i] * im[i]) / (1 << 17);
      out[i] = v < 1e-10 ? 1e-10 : v;
    }
    this.fftPos = (this.fftPos + 1) % RING;
    this.fftWritten++;
  }

  doPeakSpreading() {
    const last = this.fftOutputs[(this.fftPos - 1 + RING) % RING];
    const s = Float64Array.from(last);
    for (let p = 0; p <= BINS - 3; p++) {
      s[p] = Math.max(s[p], s[p + 1], s[p + 2]);
    }
    for (let p = 0; p < BINS; p++) {
      let maxValue = s[p];
      for (const back of [1, 3, 6]) {
        const former = this.spread[(this.spreadPos - back + RING) % RING];
        if (former[p] < maxValue) former[p] = maxValue;
        maxValue = former[p];
      }
    }
    this.spread[this.spreadPos] = s;
    this.spreadPos = (this.spreadPos + 1) % RING;
    this.spreadWritten++;
  }

  doPeakRecognition() {
    const f46 = this.fftOutputs[(this.fftPos - 46 + RING) % RING];
    const f49 = this.spread[(this.spreadPos - 49 + RING) % RING];
    const MIN = 1 / 64;
    const mag = (v) => Math.log(Math.max(MIN, v)) * 1477.3 + 6144;

    for (let bin = 10; bin < 1015; bin++) {
      const v = f46[bin];
      if (!(v >= MIN && v >= f49[bin - 1])) continue;

      let maxN = 0;
      for (const o of [-10, -7, -4, -3, 1, 2, 5, 8]) maxN = Math.max(maxN, f49[bin + o]);
      if (!(v > maxN)) continue;

      let maxOther = maxN;
      for (const o of [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249]) {
        const other = this.spread[(((this.spreadPos + o) % RING) + RING) % RING];
        maxOther = Math.max(maxOther, other[bin - 1]);
      }
      if (!(v > maxOther)) continue;

      const fftNumber = this.spreadWritten - 46;
      const m = mag(v);
      const before = mag(f46[bin - 1]);
      const after = mag(f46[bin + 1]);
      const var1 = m * 2 - before - after;
      if (!(var1 > 0)) continue;
      const var2 = ((after - before) * 32) / var1;
      const corrected = bin * 64 + var2;
      const hz = corrected * (SAMPLE_RATE / 2 / 1024 / 64);

      let band;
      const h = Math.trunc(hz);
      if (h >= 250 && h < 520) band = 0;
      else if (h >= 520 && h < 1450) band = 1;
      else if (h >= 1450 && h < 3500) band = 2;
      else if (h >= 3500 && h <= 5500) band = 3;
      else continue;

      if (!this.peaks.has(band)) this.peaks.set(band, []);
      this.peaks.get(band).push({
        fft: fftNumber,
        mag: Math.trunc(m) & 0xffff,
        bin: Math.trunc(corrected) & 0xffff,
      });
    }
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class ByteWriter {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >>> 8); }
  u32(v) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
  raw(arr) { for (const b of arr) this.bytes.push(b); }
  get length() { return this.bytes.length; }
}

function encode(peaksByBand, numberSamples) {
  const contents = new ByteWriter();
  for (const band of [...peaksByBand.keys()].sort((a, b) => a - b)) {
    const peaks = new ByteWriter();
    let pass = 0;
    for (const p of peaksByBand.get(band)) {
      if (p.fft - pass >= 255) {
        peaks.u8(0xff);
        peaks.u32(p.fft);
        pass = p.fft;
      }
      peaks.u8(p.fft - pass);
      peaks.u16(p.mag);
      peaks.u16(p.bin);
      pass = p.fft;
    }
    contents.u32(0x60030040 + band);
    contents.u32(peaks.length);
    contents.raw(peaks.bytes);
    const pad = (4 - (peaks.length % 4)) % 4;
    for (let i = 0; i < pad; i++) contents.u8(0);
  }

  const sizeMinusHeader = contents.length + 8;
  const out = new ByteWriter();
  out.u32(0xcafe2580);
  out.u32(0);
  out.u32(sizeMinusHeader);
  out.u32(0x94119c00);
  out.u32(0); out.u32(0); out.u32(0);
  out.u32((3 << 27) >>> 0);
  out.u32(0); out.u32(0);
  out.u32(Math.trunc(numberSamples + SAMPLE_RATE * 0.24));
  out.u32((15 << 19) + 0x40000);
  out.u32(0x40000000);
  out.u32(sizeMinusHeader);
  out.raw(contents.bytes);

  const bytes = Uint8Array.from(out.bytes);
  const crc = crc32(bytes.subarray(8));
  new DataView(bytes.buffer).setUint32(4, crc, true);
  return bytes;
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function createSignature(pcm) {
  const gen = new SignatureGenerator();
  const total = pcm.length - (pcm.length % 128);
  const chunk = new Int16Array(128);
  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 128; i++) {
      const v = Math.max(-1, Math.min(1, pcm[off + i]));
      chunk[i] = Math.round(v * 32767);
    }
    gen.processChunk(chunk);
  }
  const bytes = encode(gen.peaks, total);
  return {
    uri: "data:audio/vnd.shazam.sig;base64," + toBase64(bytes),
    samplems: Math.round((total / SAMPLE_RATE) * 1000),
  };
}

export const SIGNATURE_SAMPLE_RATE = SAMPLE_RATE;
