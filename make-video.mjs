// Zero Trust in under a minute: script to screen pipeline
// narration + generated footage (both via Kie) -> trimmed and cut with FFmpeg -> one mp4
//
// Run:  KIE_API_KEY=... node make-video.mjs
// Needs: node 18+, ffmpeg on PATH
//
// ponytail: one file, no deps, no job queue. Scenes are inline below because the
// script IS the deliverable. If this ever runs for more than one video, move
// SCENES to a json file and keep everything else as is.

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const KIE_API_KEY = process.env.KIE_API_KEY;
// ponytail: Kie serves voice and footage on the same jobs endpoint, so one key
// buys both. Slugs below are the ones that actually answered: veo3_fast resolves
// to veo-3-1 at 720p/8s (60 credits a clip), gemini TTS costs 0.14 and returns
// wav. Kie also resells ElevenLabs but every job there failed with "Internal
// Error" on 2026-10-13, so Gemini it is.
const VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || 'veo3_fast';
const VOICE_MODEL = process.env.KIE_VOICE_MODEL || 'google/gemini-3-8-flash-tts';
const VOICE = process.env.KIE_VOICE || 'Charon'; // informative male narrator

const KIE_JOBS = 'https://api.kie.ai/api/v1/jobs';
const OUT = 'build';

// The model returns a fixed 8s take, so no scene may outrun it. Measured pace of
// the Gemini voice is about 151 wpm, which puts the ceiling near 18 words a scene.
const WPM = 151;
const MAX_CLIP_SECONDS = 8;

// Two people carry the whole thing, so their descriptions are copied verbatim
// between scenes. Text to video has no memory between takes and the only lever
// on continuity is wording that does not drift.
const MARIA =
  'a woman in her early thirties with dark curly hair tied back wearing a grey knit sweater';
const INTRUDER = 'a figure in a dark hooded jacket seen from behind, face never visible';

// narration: what the voice says.  visual: the prompt sent to the video model.
// Nothing is drawn on screen. A label that repeats the narration makes the viewer
// read and listen to the same sentence at once, which costs them the sentence.
const SCENES = [
  {
    id: '01',
    narration:
      'Maria works from home. Her laptop has been signed in to the company network since Monday morning.',
    visual:
      `Documentary style medium shot of ${MARIA}, working on a laptop at a kitchen table in a sunlit apartment, a coffee cup beside her, calm natural morning light, shallow depth of field, no text anywhere in frame`,
  },
  {
    id: '02',
    narration:
      'On Thursday she signs in to what looks exactly like the company portal. It is not.',
    visual:
      `Over the shoulder shot of ${MARIA}, typing a password into a login form on a laptop, the screen slightly out of focus and unreadable, her face lit by the screen, quiet tension, no legible text`,
  },
  {
    id: '03',
    narration:
      'Minutes later, someone else is using her session. In the old model that is already enough.',
    visual:
      `Dim room at night, ${INTRUDER}, sitting at a desk typing fast on a keyboard, monitor glow on the walls, cold blue light, cinematic, slow push in, no legible text on the screens`,
  },
  {
    id: '04',
    narration:
      'Inside the perimeter everything trusts everything. One stolen login reaches the file server and the database.',
    visual:
      `${INTRUDER}, walking calmly down a long corridor lined with office doors that each swing open by themselves as he passes, dramatic side lighting, slow dolly following him, no text`,
  },
  {
    id: '05',
    narration:
      'Zero Trust starts from the opposite assumption. No user, no device, no network is trusted by default.',
    visual:
      'Security operations centre, a woman analyst in her forties standing in front of large wall monitors, turning to look toward the camera with quiet confidence, cool blue light, screens blurred and unreadable, no text',
  },
  {
    id: '06',
    narration:
      'Every request is checked on its own. Least privilege, for the shortest time that still works.',
    visual:
      'Close up of a hand holding an access badge to a card reader beside a heavy door, the reader turns green and that one door unlocks while two identical doors further down the corridor stay shut, no text',
  },
  {
    id: '07',
    narration:
      'So the next door does not open. The breach stops at one laptop instead of the whole company.',
    visual:
      `${INTRUDER}, stopping in front of a closed glass security door at the end of a modern office corridor, the door stays shut, a small red light on the card reader beside it, cool office lighting at night, camera holds still, no text`,
  },
];

async function kie(path, init = {}) {
  const res = await fetch(`${KIE_JOBS}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Kie ${path} failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.code !== 200)
    throw new Error(body.message || body.msg || `Kie ${path} returned ${body.code}`);
  return body.data;
}

// Every Kie model takes the same job shape, so one helper covers voice and footage.
async function kieJob(model, input, file) {
  if (existsSync(file)) return file; // resume without paying twice

  const { taskId } = await kie('/createTask', {
    method: 'POST',
    body: JSON.stringify({ model, input }),
  });

  for (let i = 0; i < 150; i++) {
    const info = await kie(`/recordInfo?taskId=${taskId}`);
    if (info.state === 'success') {
      const url = JSON.parse(info.resultJson).resultUrls[0];
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      await writeFile(file, bytes);
      return file;
    }
    if (info.state === 'fail') throw new Error(`${file}: ${info.failMsg}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`${file}: timed out`);
}

const clipOf = (scene) =>
  kieJob(
    VIDEO_MODEL,
    { prompt: scene.visual, aspect_ratio: '16:9' },
    `${OUT}/clip-${scene.id}.mp4`
  );

const voiceOf = (scene) =>
  kieJob(
    VOICE_MODEL,
    {
      speakers: [{ speaker_id: 'Speaker 1', voice_name: VOICE }],
      dialogue_turns: [{ speaker_id: 'Speaker 1', text: scene.narration }],
      temperature: 0.6,
    },
    `${OUT}/voice-${scene.id}.wav`
  );

// The narration decides how long the scene runs and the clip is trimmed to it,
// never looped: looping an 8s take replayed its first second before every cut.
// tpad only matters if a take comes back short, and holds the last frame instead.
async function composeScene(scene, clip, voice) {
  const file = `${OUT}/scene-${scene.id}.mp4`;
  await run('ffmpeg', [
    '-y',
    '-i', clip,
    '-i', voice,
    '-filter_complex',
    `[0:v]scale=1920:1080,fps=30,tpad=stop_mode=clone:stop_duration=3[v];` +
      `[1:a]apad=pad_dur=0.7[a]`, // half a beat of air before the next scene
    '-map', '[v]', '-map', '[a]',
    '-shortest',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    file,
  ]);
  return file;
}

async function main() {
  if (!KIE_API_KEY) throw new Error('Set KIE_API_KEY');
  check();
  await mkdir(OUT, { recursive: true });

  const scenes = [];
  for (const scene of SCENES) {
    process.stdout.write(`scene ${scene.id} ... `);
    const [clip, voice] = await Promise.all([clipOf(scene), voiceOf(scene)]);
    scenes.push(await composeScene(scene, clip, voice));
    console.log('done');
  }

  await writeFile(
    `${OUT}/list.txt`,
    scenes.map((f) => `file '${f.replace(`${OUT}/`, '')}'`).join('\n')
  );
  await run('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', `${OUT}/list.txt`,
    '-c', 'copy', 'zero-trust.mp4',
  ]);
  console.log('\nzero-trust.mp4 ready');
}

// Self check: run with --check to validate the script without spending credits.
// Runs before every real run too, because a scene that outruns its take is the
// one mistake that cannot be fixed after the credits are gone.
function check() {
  const seconds = (s) => (s.narration.split(/\s+/).length / WPM) * 60;
  const bad = SCENES.filter((s) => !s.narration || !s.visual);
  if (bad.length) throw new Error(`bad scenes: ${bad.map((s) => s.id).join(', ')}`);
  const long = SCENES.filter((s) => seconds(s) > MAX_CLIP_SECONDS);
  if (long.length)
    throw new Error(
      `scenes longer than the ${MAX_CLIP_SECONDS}s take: ${long.map((s) => s.id).join(', ')}`
    );
  const total = SCENES.reduce((n, s) => n + seconds(s) + 0.7, 0);
  console.log(
    `${SCENES.length} scenes, longest ${Math.max(...SCENES.map(seconds)).toFixed(1)}s, ` +
      `about ${Math.round(total)}s total`
  );
}

if (process.argv.includes('--check')) {
  check();
  console.log('ok');
} else {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
