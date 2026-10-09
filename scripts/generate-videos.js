'use strict';

/**
 * Video generation — the (small) video pipeline, §13.2 and FR-24.
 *
 *   node scripts/generate-videos.js           # build anything missing
 *   node scripts/generate-videos.js --force   # rebuild everything
 *   node scripts/generate-videos.js --check   # report only, exit 1 if work is due
 *
 * Real, playable MP4s: a slow push-in over an existing photo, H.264, faststart,
 * no audio track. Silent on purpose — the label under the play button is about
 * data, and an audio track is bytes a visitor on a data budget pays for before
 * they have decided they want the video at all.
 *
 * Every clip is deliberately short and small (≤ 400 KB) because §13.2 asks the
 * visitor to spend it on a Nigerian mobile connection, and because the tap-to-load
 * label has to state the cost up front.
 *
 * The ffmpeg binary comes from @ffmpeg-installer/ffmpeg, which is a build-time
 * dependency only: nothing in src/ requires it, and a machine without it can
 * still run the site from the committed media.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'video');
// The metadata the pages need (duration, bytes, poster) travels with the clips,
// so nothing has to stat a file or guess a size while rendering.
const MANIFEST = path.join(ROOT, 'src', 'lib', 'video-manifest.json');
const IMG_DIR = path.join(ROOT, 'public', 'img');

/**
 * The clips. `source` is an existing prepared photo (1200×900); `motion` is the
 * ffmpeg zoompan expression. Kept to a table so adding one is a line, and so the
 * seed and this script can never disagree about what exists.
 */
const CLIPS = [
  {
    name: 'inspection-walkaround',
    source: 'site/home-hero.jpg',
    title: 'The 45-minute inspection, in 12 seconds',
    caption: 'What our inspector does before a car reaches you — the same checklist on every listing.',
    seconds: 12,
  },
  {
    name: 'odometer-check',
    source: 'details/odometer.jpg',
    title: 'Two odometer checks anyone can do',
    caption: 'The wear test and the service-record cross-check, on a real PH car.',
    seconds: 10,
  },
  {
    name: 'tyre-tread',
    source: 'details/tyres.jpg',
    title: 'What uneven tyre wear tells you',
    caption: 'Three wear patterns that mean the car has a story the dealer is not telling.',
    seconds: 9,
  },
  {
    name: 'flood-damage-check',
    source: 'site/catch-flood.jpg',
    title: 'Spotting flood damage before you pay',
    caption: 'The three places water leaves a mark — and why PH sellers know to clean two of them.',
    seconds: 10,
  },
];

const WIDTH = 960;
const HEIGHT = 540;
const FPS = 24;

function ffmpegPath() {
  try {
    // eslint-disable-next-line global-require
    return require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    return null;
  }
}

function sourceFor(name) {
  const file = path.join(IMG_DIR, name);
  if (!fs.existsSync(file)) throw new Error(`missing source photo: ${path.relative(ROOT, file)}`);
  return file;
}

/**
 * One clip: centre-cropped to 16:9, then a slow zoom so the still has life.
 *
 * `zoompan` renders on a 2× oversampled canvas before the final scale — zooming
 * a 1200px photo straight to 960 makes the push-in visibly soft by the last
 * frame, and the extra pass costs generation time, not delivery bytes.
 */
function encode(clip, file, ffmpeg) {
  const frames = clip.seconds * FPS;
  const filter = [
    `scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH * 2}:${HEIGHT * 2}`,
    `zoompan=z='min(zoom+0.0009,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    'format=yuv420p',
  ].join(',');

  execFileSync(ffmpeg, [
    '-y',
    '-loop', '1',
    '-i', sourceFor(clip.source),
    '-t', String(clip.seconds),
    '-vf', filter,
    '-an',                       // no audio: the label is about data, and silence is cheaper
    '-c:v', 'libx264',
    '-preset', 'veryslow',
    '-crf', '30',
    '-movflags', '+faststart',   // the first frame can render before the whole file lands
    '-r', String(FPS),
    `${file}.tmp.mp4`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  fs.renameSync(`${file}.tmp.mp4`, file);
}

/** The poster: the still a visitor sees before deciding to spend anything. */
function poster(clip, file, ffmpeg) {
  execFileSync(ffmpeg, [
    '-y',
    '-i', sourceFor(clip.source),
    '-vf', `scale=640:360:force_original_aspect_ratio=increase,crop=640:360`,
    '-frames:v', '1',
    '-q:v', '4',
    `${file}.tmp.jpg`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.renameSync(`${file}.tmp.jpg`, file);
}

/** What the seed stores: the metadata a tap-to-load label needs. */
function stat(file, seconds) {
  return { bytes: fs.statSync(file).size, seconds };
}

async function main() {
  const check = process.argv.includes('--check');
  const force = process.argv.includes('--force');
  const ffmpeg = ffmpegPath();

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const pending = [];
  for (const clip of CLIPS) {
    const video = path.join(OUT_DIR, `${clip.name}.mp4`);
    const still = path.join(OUT_DIR, `${clip.name}-poster.jpg`);
    if (!force && fs.existsSync(video) && fs.existsSync(still)) {
      continue;
    }
    pending.push({ clip, video, still });
  }

  if (check && pending.length) {
    console.error(`✗ ${pending.length} video(s) missing — run: node scripts/generate-videos.js`);
    for (const item of pending) console.error(`  · ${item.clip.name}`);
    process.exit(1);
  }

  if (!ffmpeg) {
    if (pending.length) {
      console.error('✗ @ffmpeg-installer/ffmpeg is not installed and video(s) are missing:');
      for (const item of pending) console.error(`  · ${item.clip.name}`);
      console.error('  Install it with: npm i --no-save @ffmpeg-installer/ffmpeg');
      process.exit(1);
    }
    console.log('✓ videos: nothing to build (ffmpeg not installed, but every clip and poster is present)');
    return;
  }

  for (const item of pending) {
    encode(item.clip, item.video, ffmpeg);
    poster(item.clip, item.still, ffmpeg);
    const info = stat(item.video, item.clip.seconds);
    console.log(`· ${item.clip.name}.mp4 — ${item.clip.seconds}s · ${Math.round(info.bytes / 1024)} KB`);
  }

  // The manifest the app reads — same idea as the blur placeholders: the fact
  // that a clip is 238 KB is measured once here, not calculated at render time
  // (and never claimed by a person typing it into a CMS field).
  const manifest = {};
  for (const clip of CLIPS) manifest[`/video/${clip.name}.mp4`] = {
    seconds: clip.seconds,
    bytes: fs.statSync(path.join(OUT_DIR, `${clip.name}.mp4`)).size,
    poster: `/video/${clip.name}-poster.jpg`,
    title: clip.title,
    caption: clip.caption,
  };
  const previous = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8') : '';
  const next = `${JSON.stringify(manifest, null, 2)}\n`;
  if (previous !== next) {
    fs.writeFileSync(MANIFEST, next);
    console.log(`· ${path.relative(ROOT, MANIFEST)} updated`);
  }

  const total = CLIPS.reduce((sum, clip) => sum + fs.statSync(path.join(OUT_DIR, `${clip.name}.mp4`)).size, 0);
  console.log(`✓ ${CLIPS.length} clip(s) in public/video — ${Math.round(total / 1024)} KB total`);
  console.log('  Run `npm run db:seed` to put them on a listing and three posts.');
}

main().catch((error) => {
  console.error('video generation failed:', error.message);
  process.exit(1);
});
