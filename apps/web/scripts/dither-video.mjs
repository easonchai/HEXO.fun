// Renders the HOME background: the coin-ring mp4 run through the Figma
// "Dither" shader's ordered pass (Bayer 16x16, size 2, 3 levels, colour),
// so the web build ships a plain looping video instead of a WebGPU port.
//
//   node scripts/dither-video.mjs <source.mp4>
//
// Writes public/home-bg.mp4 (H.264, no audio) and public/home-bg.png
// (dithered first frame, the poster). Needs ffmpeg on PATH.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = process.argv[2];
if (!SRC) throw new Error("usage: node scripts/dither-video.mjs <source.mp4>");

// dither.js parameters, size 8, tuned by eye against the Figma frame
// on a 1080p source = 240x135 cells, 3 levels per channel.
// The page scales the cells back up with image-rendering: pixelated.
const PIXEL_SIZE = 8;
const LEVELS = 3;
const BRIGHT = (100 - 100) / 200;
const CONTRAST = 1;
const BAYER_N = 16;
const W = 1920 / PIXEL_SIZE;
const H = 1080 / PIXEL_SIZE;
// Source is 24 fps; encoding the same frames at 0.8x that plays them slower.
const SPEED = 0.8;
const FPS = 24 * SPEED;

const here = dirname(fileURLToPath(import.meta.url));
const OUT_MP4 = resolve(here, "../public/home-bg.mp4");
const OUT_PNG = resolve(here, "../public/home-bg.png");

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
const decode = ffmpeg(
  ["-i", SRC, "-an", "-vf", `scale=${W}:${H}:flags=bilinear`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
  ["ignore", "pipe", "inherit"],
);
const encode = ffmpeg(
  [
    "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
    // 2x nearest upscale so 4:2:0 chroma subsampling still covers every cell.
    "-vf", "scale=iw*2:ih*2:flags=neighbor",
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
