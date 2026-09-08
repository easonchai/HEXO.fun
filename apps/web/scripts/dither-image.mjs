// Runs a still image through the same ordered pass as dither-video.mjs, for
// the Figma card art that ships as a raster rather than a video.
//
//   node scripts/dither-image.mjs <source.png> <out.png> <cellsWide>
//
// The cell count, not a pixel size, is the knob here: card art is placed at a
// known CSS size, and matching its cells to the neighbouring card's is what
// makes the two read as one treatment. The page scales the cells back up with
// image-rendering: pixelated, so the output is written at 2x the CSS box.
// Needs ffmpeg on PATH.
import { spawn } from "node:child_process";

const [SRC, OUT, CELLS_W] = process.argv.slice(2);
if (!SRC || !OUT || !CELLS_W) {
  throw new Error(
    "usage: node scripts/dither-image.mjs <source.png> <out.png> <cellsWide>",
  );
}

const LEVELS = 3;
const BAYER_N = 16;

// Same recursive construction as bayerMatrix()/flattenBayer() in dither.js.
function bayer(n) {
  if (n === 1) return [[0]];
  const small = bayer(n / 2);
  const m = n / 2;
  return Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      const qx = Math.floor(x / m);
      const qy = Math.floor(y / m);
      const qoff =
        qy === 0 && qx === 0 ? 0 : qy === 0 && qx === 1 ? 2 : qy === 1 && qx === 0 ? 3 : 1;
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

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "inherit"] });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`ffmpeg exited ${code}`)),
    );
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

const cellsW = Number(CELLS_W);
// One decode at cell resolution; RGBA so a transparent source stays transparent.
const raw = await run([
  "-v", "error", "-i", SRC, "-frames:v", "1",
  "-vf", `scale=${cellsW}:-1`, "-f", "rawvideo", "-pix_fmt", "rgba", "-",
]);
const cellsH = raw.length / 4 / cellsW;
if (!Number.isInteger(cellsH)) throw new Error("unexpected frame size from ffmpeg");

for (let y = 0; y < cellsH; y++) {
  const row = (y % BAYER_N) * BAYER_N;
  for (let x = 0; x < cellsW; x++) {
    const t = TILE[row + (x % BAYER_N)];
    const i = (y * cellsW + x) * 4;
    // Alpha is quantized too, or the dithered art keeps a smooth soft edge
    // that gives away that only the colour went through the pass.
    for (let c = 0; c < 4; c++) {
      raw[i + c] = Math.round(quantize(raw[i + c] / 255, t) * 255);
    }
  }
}

await run(
  [
    "-v", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${cellsW}x${cellsH}`, "-i", "-",
    "-vf", "scale=iw*8:ih*8:flags=neighbor",
    // PNG, like dither-video.mjs's poster: three levels per channel is a tiny
    // palette, so a lossless PNG beats what this ffmpeg build can encode.
    "-c:v", "png", "-frames:v", "1",
    OUT,
  ],
  raw,
);

console.log(`${OUT}: ${cellsW}x${cellsH} cells → ${cellsW * 8}x${cellsH * 8}`);
