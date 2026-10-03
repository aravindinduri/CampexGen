/**
 * VideoArtifact → ELAH build spec (+ Remotion metadata).
 *
 * Pipeline (run before calling buildSpec):
 *   0. Enrich artifact with Gemma-generated image prompts (parallel)
 *   1. TTS per scene → audio files with durations (ElevenLabs or edge-tts)
 *   2. Scene durations = max(artifact.duration, audioDuration + 0.4), min 2.5s
 *   3. Generate per-scene background PNGs
 *   4. Generate background music (ElevenLabs or fallback loop.mp3)
 *   5. Build spec with remotionMeta attached
 */
import path from "path";
import { existsSync } from "fs";
import type { VideoArtifact } from "./artifact.js";
import {
  generateGradient,
  imageDimensions,
  fitScale,
  stageForRatio,
} from "./backgrounds.js";
import { synthesize, ttsAvailable } from "./tts.js";
import { enrichArtifactWithImagePrompts } from "./imageprompt.js";
import {
  elevenlabsAvailable,
  elevenLabsMusic,
} from "./elevenlabs.js";
import { generateImage } from "./imagegen.js";
import type { RemotionSceneMeta, ExtendedElahSpec } from "./renderRemotionVideo.js";

export interface ElahSpec {
  fps: number;
  stage: { width: number; height: number };
  assets: Record<string, string>;
  clips: ElahClip[];
}

// Re-export so render.ts and renderRemotionVideo.ts can use a single import
export type { ExtendedElahSpec, RemotionSceneMeta } from "./renderRemotionVideo.js";

interface ElahClip {
  track: string;
  asset?: string;
  text?: string;
  start: number;
  duration: number;
  x?: number;
  y?: number;
  scale?: number;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  fontWeight?: string;
  align?: string;
  volume?: number;
}

const FALLBACK_MUSIC_PATH = path.join(process.cwd(), "assets", "music", "loop.mp3");

// Mood → music prompt mapping for ElevenLabs text-to-music
const MUSIC_PROMPTS: Record<string, string> = {
  energetic: "Upbeat energetic electronic dance music, driving beat, modern commercial, high energy",
  calm: "Calm ambient background music, soft piano and strings, peaceful, corporate",
  premium: "Cinematic orchestral music, luxury brand feel, elegant and sophisticated, modern",
  playful: "Fun upbeat playful music, quirky and cheerful, bright ukulele and claps",
};

function buildMusicPrompt(mood: string, campaignType: string): string {
  const base = MUSIC_PROMPTS[mood] ?? MUSIC_PROMPTS.energetic;
  // Add campaign-type flavour
  if (campaignType === "discount" || campaignType === "event") {
    return `${base}, sense of urgency, promotional`;
  }
  return `${base}, promotional background`;
}

export async function buildSpec(
  artifact: VideoArtifact,
  assetPaths: Record<string, string>, // id → absolute file path
  workDir: string
): Promise<{ spec: ExtendedElahSpec; totalDuration: number }> {
  const stage = stageForRatio(artifact.aspect_ratio);
  const voice = artifact.voiceover.voice ?? "en-US-AriaNeural";
  const useTts = artifact.voiceover.enabled && (await ttsAvailable());

  // ── 0. Enrich artifact with Gemma image prompts ────────────────────────────
  let enrichedArtifact = artifact;
  try {
    enrichedArtifact = await enrichArtifactWithImagePrompts(artifact);
    console.log(`[adapter] Image prompts generated for ${enrichedArtifact.scenes.length} scenes`);
  } catch (err) {
    console.warn(`[adapter] Image prompt generation failed, continuing without: ${(err as Error).message}`);
  }

  // ── 1. TTS per scene ───────────────────────────────────────────────────────
  const audioDurations: number[] = [];
  const audioFiles: (string | null)[] = [];

  for (let i = 0; i < enrichedArtifact.scenes.length; i++) {
    const scene = enrichedArtifact.scenes[i];
    if (useTts && scene.voiceover) {
      const outPath = path.join(workDir, `vo_${i + 1}.mp3`);
      try {
        const ttsResult = await synthesize(scene.voiceover, voice, outPath);
        audioDurations.push(ttsResult.duration);
        if (i === 0) console.log(`[adapter] TTS provider: ${ttsResult.provider}`);
        audioFiles.push(outPath);
      } catch (err) {
        console.warn(`TTS failed for scene ${scene.id}: ${(err as Error).message}`);
        audioDurations.push(0);
        audioFiles.push(null);
      }
    } else {
      audioDurations.push(0);
      audioFiles.push(null);
    }
  }

  // ── 2. Adjust scene durations to fit audio ─────────────────────────────────
  const scenes = enrichedArtifact.scenes.map((scene, i) => ({
    ...scene,
    duration: Math.max(2.5, scene.duration, audioDurations[i] + 0.4),
  }));

  // ── 3. Per-scene background images (AI-generated, gradient fallback) ──────
  const bgPaths: string[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const bgPath = path.join(workDir, `bg_${i + 1}.png`);
    const imagePrompt = enrichedArtifact.scenes[i].image_prompt;

    let generated = false;
    if (imagePrompt) {
      generated = await generateImage(imagePrompt, stage.width, stage.height, bgPath);
    }

    if (!generated) {
      // Fallback: gradient PNG
      await generateGradient(
        enrichedArtifact.style.palette.bg1,
        enrichedArtifact.style.palette.bg2,
        stage,
        bgPath
      );
    }
    bgPaths.push(bgPath);
  }
  console.log(`[adapter] Background images generated for ${scenes.length} scenes`);

  // ── 4. Build spec ─────────────────────────────────────────────────────────
  const assets: Record<string, string> = {};
  const clips: ElahClip[] = [];

  // Register background assets
  for (let i = 0; i < scenes.length; i++) {
    assets[`bg_${i + 1}`] = bgPaths[i];
  }

  // Register user image assets
  for (const [id, p] of Object.entries(assetPaths)) {
    assets[id] = p;
  }

  // Register audio assets
  for (let i = 0; i < scenes.length; i++) {
    const af = audioFiles[i];
    if (af) assets[`vo_${i + 1}`] = af;
  }

  // Compute total duration
  const musicEnabled = enrichedArtifact.music.enabled;
  let totalDuration = 0;
  for (const s of scenes) totalDuration += s.duration;
  totalDuration = parseFloat(totalDuration.toFixed(3));

  // ── 4. Background music (ElevenLabs or fallback) ──────────────────────────
  if (musicEnabled) {
    let musicPath = FALLBACK_MUSIC_PATH;

    if (elevenlabsAvailable()) {
      const genMusicPath = path.join(workDir, "music_gen.mp3");
      try {
        const prompt = buildMusicPrompt(
          enrichedArtifact.style.mood,
          enrichedArtifact.campaign.type
        );
        await elevenLabsMusic(prompt, genMusicPath, {
          durationSeconds: Math.ceil(totalDuration) + 2, // slight overrun for fade
        });
        musicPath = genMusicPath;
        console.log(`[adapter] Background music generated via ElevenLabs`);
      } catch (err) {
        console.warn(`[adapter] ElevenLabs music failed, using fallback: ${(err as Error).message}`);
        // musicPath stays as FALLBACK_MUSIC_PATH
      }
    }

    assets["music"] = musicPath;
  }

  // Build clips per scene
  let cursor = 0;
  const { font_family: font } = enrichedArtifact.style;
  const textColor = enrichedArtifact.style.palette.text;
  const accentColor = enrichedArtifact.style.palette.accent;
  const isCta = (scene: typeof scenes[0]) => scene.purpose === "cta";

  // Remotion metadata: one entry per scene (0-indexed)
  const remotionMeta: RemotionSceneMeta[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const t = parseFloat(cursor.toFixed(3));
    const d = scene.duration;

    // Background image clip
    clips.push({
      track: "image",
      asset: `bg_${i + 1}`,
      start: t,
      duration: d,
      x: 0.5,
      y: 0.5,
      scale: 1,
    });

    // User image clip (if scene references one)
    if (scene.asset && assetPaths[scene.asset]) {
      let scale = 1;
      try {
        const { width, height } = await imageDimensions(assetPaths[scene.asset]);
        scale = fitScale(width, height, stage.width);
      } catch { /* use scale=1 */ }

      clips.push({
        track: "image",
        asset: scene.asset,
        start: t,
        duration: d,
        x: 0.5,
        y: 0.42,
        scale,
      });
    }

    // Headline text
    const headlineFontSize = isCta(scene) ? 108 :
      scene.headline.length > 18 ? Math.max(60, 96 - (scene.headline.length - 18) * 3) : 96;

    clips.push({
      track: "text",
      text: scene.headline,
      start: t + 0.2,
      duration: d - 0.2,
      fontSize: headlineFontSize,
      color: isCta(scene) ? accentColor : textColor,
      fontFamily: font,
      fontWeight: "bold",
      align: "center",
      x: 0.5,
      y: scene.asset ? 0.78 : 0.5,
    });

    // Subtext
    if (scene.subtext) {
      clips.push({
        track: "text",
        text: scene.subtext,
        start: t + 0.3,
        duration: d - 0.3,
        fontSize: 48,
        color: textColor,
        fontFamily: font,
        fontWeight: "normal",
        align: "center",
        x: 0.5,
        y: scene.asset ? 0.86 : 0.6,
      });
    }

    // Voiceover audio
    if (audioFiles[i]) {
      clips.push({
        track: "audio",
        asset: `vo_${i + 1}`,
        start: t,
        duration: audioDurations[i],
        volume: 1,
      });
    }

    // Remotion metadata for this scene
    remotionMeta.push({
      animation: scene.animation ?? "fade-in",
      isCta: isCta(scene),
      imagePrompt: scene.image_prompt,
    });

    cursor += d;
  }

  // Background music — single clip spanning the whole video
  if (musicEnabled) {
    clips.push({
      track: "audio",
      asset: "music",
      start: 0,
      duration: totalDuration,
      volume: enrichedArtifact.music.volume,
    });
  }

  const spec: ExtendedElahSpec = {
    fps: 30,
    stage,
    assets,
    clips,
    remotionMeta,
  };

  return { spec, totalDuration };
}
