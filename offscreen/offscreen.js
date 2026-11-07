import { recognizeShazam, recognizeAudd } from "../lib/recognize.js";
import { t } from "../lib/i18n.js";

const ATTEMPTS_AT = [4, 8, 12];
const MAX_SECONDS = 12;
const SILENCE_RMS = 0.002;

const send = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === "offscreen" && msg.type === "record") {
    record(msg.streamId, msg.auddToken).then(
      (result) => send({ type: "done", result }),
      (e) => send({ type: "done", error: e.message || String(e) })
    );
  }
});

async function record(streamId, auddToken) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(ctx.destination);

  const chunks = [];
  let length = 0;
  try {
    await ctx.audioWorklet.addModule("recorder-worklet.js");
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    throw e;
  }
  const proc = new AudioWorkletNode(ctx, "recorder", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: "explicit",
  });
  proc.port.onmessage = (e) => {
    chunks.push(e.data);
    length += e.data.length;
  };
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(proc);
  proc.connect(silent).connect(ctx.destination);

  const collect = () => {
    const keep = Math.min(length, MAX_SECONDS * ctx.sampleRate);
    const out = new Float32Array(keep);
    let pos = keep;
    for (let i = chunks.length - 1; i >= 0 && pos > 0; i--) {
      const c = chunks[i];
      const take = Math.min(c.length, pos);
      out.set(c.subarray(c.length - take), pos - take);
      pos -= take;
    }
    return out;
  };

  try {
    let heardSound = false;
    let lastPcm = null;
    let shazamError = null;

    for (let s = 1; s <= MAX_SECONDS; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!ATTEMPTS_AT.includes(s)) continue;

      const pcm = await to16k(collect(), ctx.sampleRate);
      if (rms(pcm) < SILENCE_RMS) continue;
      heardSound = true;
      lastPcm = pcm;
      try {
        const hit = await recognizeShazam(pcm);
        if (hit) return hit;
      } catch (e) {
        shazamError = e;
      }
    }

    if (!heardSound) throw new Error(t("noAudioHeard"));
    if (auddToken && lastPcm) return await recognizeAudd(lastPcm, auddToken);
    if (shazamError) throw new Error(`${t("serviceUnreachable")} (${shazamError.message}).`);
    return null;
  } finally {
    proc.port.onmessage = null;
    proc.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  }
}

async function to16k(pcm, rate) {
  const frames = Math.max(1, Math.ceil((pcm.length * 16000) / rate));
  const off = new OfflineAudioContext(1, frames, 16000);
  const buf = off.createBuffer(1, Math.max(1, pcm.length), rate);
  buf.copyToChannel(pcm, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

function rms(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / (pcm.length || 1));
}
