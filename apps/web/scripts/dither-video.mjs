// Renders a screen background: an mp4 run through the Figma "Dither"
// shader's ordered pass (Bayer 16x16, size 2, 3 levels, colour), so the
// web build ships a plain looping video instead of a WebGPU port.
//
//   node scripts/dither-video.mjs <source.mp4> <name> [speed] [cell]
//
//   HOME:  node scripts/dither-video.mjs coin-ring.mp4 home-bg 0.8 8
//   VAULT: node scripts/dither-video.mjs Checkmark_LoopVideo.mp4 vault-bg 0.6 4
//
// Writes public/<name>.mp4 (H.264, no audio) and public/<name>.png
// (dithered first frame, the poster). Needs ffmpeg and ffprobe on PATH.
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [SRC, NAME, SPEED_ARG = "0.8", CELL_ARG = "8"] = process.argv.slice(2);
if (!SRC || !NAME) throw new Error("usage: node scripts/dither-video.mjs <source.mp4> <name> [speed] [cell]");
const SPEED = Number(SPEED_ARG);
if (!(SPEED > 0)) throw new Error(`speed must be a positive number, got ${SPEED_ARG}`);
// Source pixels per dither cell, tuned by eye against each Figma frame:
// 8 on the 1080p coin ring (240x135 cells), 4 on the 720p checkmark.
const PIXEL_SIZE = Number(CELL_ARG);
if (!Number.isInteger(PIXEL_SIZE) || PIXEL_SIZE < 1) throw new Error(`cell must be a positive integer, got ${CELL_ARG}`);

// dither.js parameters: 3 levels per channel, Bayer 16x16.
// The page scales the cells back up with image-rendering: pixelated.
const LEVELS = 3;
const BRIGHT = (100 - 100) / 200;
const CONTRAST = 1;
const BAYER_N = 16;

const probe = execFileSync(
  "ffprobe",
  ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", SRC],
  { encoding: "utf8" },
).trim();
const [srcW, srcH, rate] = probe.split(",");
const [num, den] = rate.split("/").map(Number);
const W = Math.round(Number(srcW) / PIXEL_SIZE);
const H = Math.round(Number(srcH) / PIXEL_SIZE);
const SRC_FPS = num / den;

const here = dirname(fileURLToPath(import.meta.url));
const OUT_MP4 = resolve(here, `../public/${NAME}.mp4`);
const OUT_PNG = resolve(here, `../public/${NAME}.png`);

// Same recursive construction as bayerMatrix()/flattenBayer() in dither.js.
function bayer(n) {
  if (n === 1) return [[0]];
  const small = bayer(n / 2);
  const m = n / 2;
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      const qx = Math.floor(x / m);
      const qy = Math.floor(y / m);
      const qoff = qy === 0 && qx === 0 ? 0 : qy === 0 && qx === 1 ? 2 : qy === 1 && qx === 0 ? 3 : 1;
      return small[y % m][x % m] * 4 + qoff;
    }),
  );
}
const TILE = Float32Array.from(bayer(BAYER_N).flat(), (v) => (v + 0.5) / (BAYER_N * BAYER_N));

// quantize() from buildOrderedShader(), per channel, colour mode.
const L = LEVELS - 1;
function quantize(c, t) {
  const off = (t - 0.5) / L;
  return Math.min(1, Math.max(0, Math.round((c + off) * L) / L));
}

function ditherFrame(rgb) {
  const out = Buffer.allocUnsafe(rgb.length);
  for (let y = 0; y < H; y++) {
    const row = (y % BAYER_N) * BAYER_N;
    for (let x = 0; x < W; x++) {
      const t = TILE[row + (x % BAYER_N)];
      const i = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) {
        let c = rgb[i + k] / 255;
        c = Math.min(1, Math.max(0, (c - 0.5) * CONTRAST + 0.5 + BRIGHT));
        out[i + k] = Math.round(quantize(c, t) * 255);
      }
    }
  }
  return out;
}

function ffmpeg(args, stdio) {
  const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { stdio });
  p.on("error", (err) => {
    throw new Error("ffmpeg failed to start (is it on PATH?)", { cause: err });
  });
  return p;
}

// Bilinear downscale stands in for the load pass sampling block centres.
// Slow the clip first, then motion-interpolate back to the source rate so a
// 0.6x render still plays at 24fps instead of 14.
const decode = ffmpeg(
  [
    "-i", SRC, "-an",
    "-vf", `setpts=PTS/${SPEED},minterpolate=fps=${SRC_FPS}:mi_mode=mci,scale=${W}:${H}:flags=bilinear`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ],
  ["ignore", "pipe", "inherit"],
);
const encode = ffmpeg(
  [
    "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(SRC_FPS), "-i", "-",
    // 2x nearest upscale so 4:2:0 chroma subsampling still covers every cell.
    // Explicit bt709 limited range: untagged files leave browsers guessing,
    // and a wrong guess lifts black to grey, which screen blend then shows.
    "-vf", "scale=iw*2:ih*2:flags=neighbor:out_color_matrix=bt709:out_range=tv",
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    OUT_MP4,
  ],
  ["pipe", "inherit", "inherit"],
);

const FRAME_BYTES = W * H * 3;
let pending = Buffer.alloc(0);
let frames = 0;
let poster = null;

decode.stdout.on("data", (chunk) => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= FRAME_BYTES) {
    const dithered = ditherFrame(pending.subarray(0, FRAME_BYTES));
    pending = pending.subarray(FRAME_BYTES);
    poster ??= dithered;
    frames++;
    if (!encode.stdin.write(dithered)) {
      decode.stdout.pause();
      encode.stdin.once("drain", () => decode.stdout.resume());
    }
  }
});

decode.stdout.on("end", () => encode.stdin.end());

encode.on("close", (code) => {
  if (code !== 0) throw new Error(`ffmpeg encode exited with ${code}`);
  const png = ffmpeg(
    ["-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", "-", "-frames:v", "1", OUT_PNG],
    ["pipe", "inherit", "inherit"],
  );
  png.stdin.end(poster);
  png.on("close", (c) => {
    if (c !== 0) throw new Error(`ffmpeg poster exited with ${c}`);
    console.log(`wrote ${OUT_MP4} (${frames} frames) and ${OUT_PNG}`);
  });
});
