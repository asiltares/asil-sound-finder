import { createSignature, SIGNATURE_SAMPLE_RATE } from "./signature.js";
import { t } from "./i18n.js";

const searchLinks = (title, artist) => {
  const q = encodeURIComponent(`${title} ${artist}`.trim());
  return {
    spotify: `https://open.spotify.com/search/${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    apple: `https://music.apple.com/search?term=${q}`,
  };
};

function appleMusicUrl(track) {
  for (const option of track.hub?.options || []) {
    for (const action of option.actions || []) {
      const m = /^intent:\/\/(music\.apple\.com\/[^?#]+)(\?[^#]*)?/.exec(action.uri || "");
      if (!m) continue;
      const song = new URLSearchParams(m[2] || "").get("i");
      return `https://${m[1]}${song ? `?i=${encodeURIComponent(song)}` : ""}`;
    }
  }
  return null;
}

export async function recognizeShazam(pcm16k) {
  const sig = createSignature(pcm16k);
  const now = Date.now();
  const url =
    `https://amp.shazam.com/discovery/v5/en/US/android/-/tag/` +
    `${crypto.randomUUID().toUpperCase()}/${crypto.randomUUID().toUpperCase()}` +
    `?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&video=v3`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Language": "en_US" },
    body: JSON.stringify({
      geolocation: { altitude: 300, latitude: 45, longitude: 2 },
      signature: { samplems: sig.samplems, timestamp: now, uri: sig.uri },
      timestamp: now,
      timezone: "Europe/Istanbul",
    }),
  });
  if (!res.ok) throw new Error(`Shazam HTTP ${res.status}`);
  const data = await res.json();
  if (!data.matches?.length || !data.track) return null;

  const t = data.track;
  const song = Object.fromEntries(
    ((t.sections || []).find((s) => s.type === "SONG")?.metadata || []).map((m) => [m.title, m.text])
  );
  return {
    album: (song.Album || "").replace(/\s+-\s+(Single|EP)$/i, ""),
    year: song.Released || "",
    genre: t.genres?.primary || "",
    title: t.title,
    artist: t.subtitle,
    cover: t.images?.coverarthq || t.images?.coverart || "",
    position: Math.round((data.matches[0].offset || 0) + sig.samplems / 1000),
    links: (() => {
      const links = searchLinks(t.title, t.subtitle);
      const apple = appleMusicUrl(t);
      if (apple) links.apple = apple;
      return links;
    })(),
  };
}

export async function recognizeAudd(pcm16k, token) {
  const form = new FormData();
  form.append("api_token", token);
  form.append("return", "spotify");
  form.append("file", new Blob([toWav(pcm16k, SIGNATURE_SAMPLE_RATE)], { type: "audio/wav" }), "clip.wav");
  const res = await fetch("https://api.audd.io/", { method: "POST", body: form });
  if (!res.ok) throw new Error(`AudD HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === "error") throw new Error(`AudD: ${data.error?.error_message || t("unknownError")}`);
  const r = data.result;
  if (!r) return null;
  return {
    title: r.title,
    artist: r.artist,
    cover: r.spotify?.album?.images?.[0]?.url || "",
    links: { songlink: r.song_link, ...searchLinks(r.title, r.artist) },
  };
}

function toWav(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), true);
  }
  return buf;
}
