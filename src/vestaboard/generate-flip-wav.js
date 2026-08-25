#!/usr/bin/env node
// Convert the recorded Vestaboard sample into the admin simulator clip.
// Source lives under `dev assets/vestaboard-requirements/` (stereo PCM WAV).
// Output is mono 44.1kHz 16-bit WAV so every browser can play it without a
// codec, at about half the original size.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'dev assets', 'vestaboard-requirements', 'vestaboard-sample.wav');
const OUT = path.join(__dirname, '..', 'web', 'admin', 'vb-flip.wav');

function readWavPcm16(filePath) {
  const wav = fs.readFileSync(filePath);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${filePath} is not a WAVE file`);
  }
  let offset = 12;
  let format = null;
  let dataStart = 0;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      format = {
        audioFormat: wav.readUInt16LE(offset + 8),
        channels: wav.readUInt16LE(offset + 10),
        sampleRate: wav.readUInt32LE(offset + 12),
        bits: wav.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') {
      dataStart = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || format.audioFormat !== 1 || format.bits !== 16) {
    throw new Error(`${filePath} must be PCM 16-bit WAVE`);
  }
  const frameSize = format.channels * 2;
  const frames = Math.floor(dataSize / frameSize);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      sum += wav.readInt16LE(dataStart + i * frameSize + channel * 2) / 32768;
    }
    samples[i] = sum / format.channels;
  }
  return { sampleRate: format.sampleRate, samples };
}

function contentWindow(samples, sampleRate) {
  const win = Math.max(1, Math.floor(sampleRate * 0.02));
  const thresh = 0.02;
  const peakOf = (from, to) => {
    let peak = 0;
    for (let i = from; i < to; i += 1) {
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    return peak;
  };
  let first = 0;
  let last = samples.length;
  for (let i = 0; i < samples.length; i += win) {
    if (peakOf(i, Math.min(samples.length, i + win)) >= thresh) {
      first = i;
      break;
    }
  }
  for (let i = samples.length - win; i >= 0; i -= win) {
    if (peakOf(i, Math.min(samples.length, i + win)) >= thresh) {
      last = Math.min(samples.length, i + win);
      break;
    }
  }
  // Keep ~40ms of lead-in so play() and the first visual flap start together.
  const pad = Math.floor(sampleRate * 0.04);
  return {
    start: Math.max(0, first - pad),
    end: Math.min(samples.length, last + pad),
  };
}

function encodeWav(samples, rate) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((clipped * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

function main() {
  const { sampleRate, samples } = readWavPcm16(SRC);
  const window = contentWindow(samples, sampleRate);
  const sliced = samples.subarray(window.start, window.end);
  let peak = 0;
  for (let i = 0; i < sliced.length; i += 1) {
    peak = Math.max(peak, Math.abs(sliced[i]));
  }
  const scale = peak > 0 ? Math.min(1, 0.89 / peak) : 1;
  const out = new Float32Array(sliced.length);
  for (let i = 0; i < sliced.length; i += 1) {
    out[i] = sliced[i] * scale;
  }
  fs.writeFileSync(OUT, encodeWav(out, sampleRate));
  const seconds = out.length / sampleRate;
  process.stdout.write(
    `${path.relative(process.cwd(), OUT)} ${fs.statSync(OUT).size} bytes ${seconds.toFixed(3)}s\n`,
  );
}

main();
