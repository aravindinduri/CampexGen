/**
 * FFmpeg-based video renderer.
 *
 * Composes per-scene background images, text overlays, voiceover audio,
 * and background music into an MP4 using ffmpeg's filter_complex.
 *
 * This replaces both ELAH and Remotion with a single ffmpeg call that
 * works reliably on any system with ffmpeg installed.
 */
import { spawn } from "child_process";
import path from "path";
import type { ElahSpec } from "./adapter.js";

interface SceneInfo {
  bgPath: string;
  userAssetPath?: string;
  headline: string;
  subtext?: string;
  start: number;
  duration: number;
  fontSize: number;
  subtextFontSize: number;
  textColor: string;
  fontFamily: string;
  voicePath: string | null;
  voiceDuration: number;
}

function getFontFile(bold = false): string {
  if (process.platform === "win32") {
    return bold ? "/Windows/Fonts/arialbd.ttf" : "/Windows/Fonts/arial.ttf";
  }
  return bold
    ? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
}

function wrapText(text: string, maxCharsPerLine = 22): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine + " " + word).length <= maxCharsPerLine) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.join("\n");
}

function extractScenes(spec: ElahSpec): SceneInfo[] {
  const { clips, assets } = spec;
  const scenes: SceneInfo[] = [];

  // Find all background clips (ordered by start time)
  const bgClips = clips
    .filter((c) => c.track === "image" && c.asset && /^bg_\d+$/.test(c.asset))
    .sort((a, b) => a.start - b.start);

  for (const bgClip of bgClips) {
    const idx = bgClip.asset!.replace("bg_", "");
    const bgPath = assets[bgClip.asset!];

    // Find user image asset in this scene (if any)
    const userAssetClip = clips.find(
      (c) =>
        c.track === "image" &&
        c.asset &&
        !/^bg_\d+$/.test(c.asset) &&
        c.start >= bgClip.start - 0.01 &&
        c.start < bgClip.start + bgClip.duration
    );
    const userAssetPath = userAssetClip?.asset ? assets[userAssetClip.asset] : undefined;

    // Find text clips in this scene's time window
    const textClips = clips.filter(
      (c) =>
        c.track === "text" &&
        c.start >= bgClip.start - 0.01 &&
        c.start < bgClip.start + bgClip.duration
    );

    const headlineClip = textClips[0];
    const subtextClip = textClips.length > 1 ? textClips[1] : undefined;

    // Find voiceover
    const voClip = clips.find(
      (c) => c.track === "audio" && c.asset === `vo_${idx}`
    );

    scenes.push({
      bgPath,
      userAssetPath,
      headline: headlineClip?.text ?? "",
      subtext: subtextClip?.text,
      start: bgClip.start,
      duration: bgClip.duration,
      fontSize: headlineClip?.fontSize ?? 72,
      subtextFontSize: subtextClip?.fontSize ?? 36,
      textColor: headlineClip?.color ?? "#ffffff",
      fontFamily: headlineClip?.fontFamily ?? "Arial",
      voicePath: voClip ? assets[`vo_${idx}`] ?? null : null,
      voiceDuration: voClip?.duration ?? 0,
    });
  }

  return scenes;
}

// Escape text for ffmpeg drawtext filter
function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:");
}

// Convert hex color to ffmpeg format (e.g., #ff6b35 → 0xff6b35)
function hexToFfmpeg(hex: string): string {
  if (!hex.startsWith("#")) return hex;
  return hex.replace("#", "0x");
}

export async function renderWithFfmpeg(
  spec: ElahSpec,
  outPath: string,
  jobId: string
): Promise<string> {
  const { fps, stage, assets, clips } = spec;
  const { width, height } = stage;
  const scenes = extractScenes(spec);

  if (scenes.length === 0) {
    throw new Error("No scenes found in spec");
  }

  const totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);

  // Find music
  const musicClip = clips.find(
    (c) => c.track === "audio" && c.asset === "music"
  );
  const musicPath = musicClip ? assets["music"] ?? null : null;
  const musicVolume = musicClip?.volume ?? 0.2;

  // ── Build ffmpeg command ─────────────────────────────────────────────────
  const args: string[] = ["-y"];

  // Inputs: scene background images
  for (let i = 0; i < scenes.length; i++) {
    args.push(
      "-loop", "1",
      "-t", scenes[i].duration.toFixed(3),
      "-i", scenes[i].bgPath
    );
  }

  // Inputs: user asset images (if any)
  const userAssetInputIndices: (number | null)[] = [];
  let inputIdx = scenes.length;
  for (const scene of scenes) {
    if (scene.userAssetPath) {
      args.push("-loop", "1", "-t", scene.duration.toFixed(3), "-i", scene.userAssetPath);
      userAssetInputIndices.push(inputIdx++);
    } else {
      userAssetInputIndices.push(null);
    }
  }

  // Inputs: voiceover audio files
  const voiceInputIndices: (number | null)[] = [];
  for (const scene of scenes) {
    if (scene.voicePath) {
      args.push("-i", scene.voicePath);
      voiceInputIndices.push(inputIdx++);
    } else {
      voiceInputIndices.push(null);
    }
  }

  // Input: background music (if present)
  let musicInputIdx: number | null = null;
  if (musicPath) {
    args.push("-i", musicPath);
    musicInputIdx = inputIdx++;
  }

  // ── filter_complex: compose scenes with text overlays ─────────────────
  const filters: string[] = [];
  const concatInputs: string[] = [];

  const fontBold = getFontFile(true);
  const fontRegular = getFontFile(false);
  const scaleRatio = width / 1080;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const label = `scene${i}`;

    // 1. Scale background image to cover stage dimensions
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}[bg${i}]`
    );

    // 2. Add dark translucent overlay for text contrast
    filters.push(
      `[bg${i}]drawbox=c=black@0.45:t=fill[dark${i}]`
    );

    let currentLayer = `dark${i}`;

    // 3. User image overlay if present
    const userAssetIdx = userAssetInputIndices[i];
    if (userAssetIdx !== null) {
      const targetW = Math.round(width * 0.7);
      filters.push(
        `[${userAssetIdx}:v]scale=${targetW}:-1:force_original_aspect_ratio=decrease[uimg${i}]`
      );
      filters.push(
        `[${currentLayer}][uimg${i}]overlay=(W-w)/2:h*0.25:enable='gte(t,0.1)'[comp${i}]`
      );
      currentLayer = `comp${i}`;
    }

    // 4. Headline text with auto-wrapping
    const wrappedHeadline = wrapText(scene.headline, 20);
    const escapedHeadline = escapeText(wrappedHeadline);
    const textColor = hexToFfmpeg(scene.textColor);
    const headlineFontSize = Math.max(36, Math.round(scene.fontSize * scaleRatio));

    const headlineY = scene.subtext
      ? (userAssetIdx !== null ? `h*0.62` : `(h-text_h)/2 - 30`)
      : (userAssetIdx !== null ? `h*0.70` : `(h-text_h)/2`);

    filters.push(
      `[${currentLayer}]drawtext=fontfile='${fontBold}':text='${escapedHeadline}':expansion=none:fontsize=${headlineFontSize}:fontcolor=${textColor}:line_spacing=12:x=(w-text_w)/2:y=${headlineY}:enable='gte(t,0.2)':alpha='if(lt(t,0.5),(t-0.2)/0.3,1)'[hl${i}]`
    );
    currentLayer = `hl${i}`;

    // 5. Subtext if present
    if (scene.subtext) {
      const wrappedSubtext = wrapText(scene.subtext, 26);
      const escapedSubtext = escapeText(wrappedSubtext);
      const subFontSize = Math.max(22, Math.round(scene.subtextFontSize * scaleRatio));
      const subtextY = userAssetIdx !== null ? `h*0.78` : `(h-text_h)/2 + 65`;

      filters.push(
        `[${currentLayer}]drawtext=fontfile='${fontRegular}':text='${escapedSubtext}':expansion=none:fontsize=${subFontSize}:fontcolor=${textColor}@0.9:line_spacing=8:x=(w-text_w)/2:y=${subtextY}:enable='gte(t,0.3)':alpha='if(lt(t,0.6),(t-0.3)/0.3,1)'[${label}]`
      );
    } else {
      filters.push(`[${currentLayer}]copy[${label}]`);
    }

    concatInputs.push(`[${label}]`);
  }

  // Concatenate all visual scenes
  filters.push(
    `${concatInputs.join("")}concat=n=${scenes.length}:v=1:a=0[video]`
  );

  // ── Audio mixing ──────────────────────────────────────────────────────
  const audioStreams: string[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const vi = voiceInputIndices[i];
    if (vi !== null) {
      const delay = Math.round(scenes[i].start * 1000); // ms
      filters.push(
        `[${vi}:a]adelay=${delay}|${delay},apad[vo${i}]`
      );
      audioStreams.push(`[vo${i}]`);
    }
  }

  // Background music
  if (musicInputIdx !== null) {
    filters.push(
      `[${musicInputIdx}:a]atrim=0:${totalDuration.toFixed(3)},volume=${musicVolume},apad[bgm]`
    );
    audioStreams.push(`[bgm]`);
  }

  // Mix audio streams
  if (audioStreams.length > 1) {
    filters.push(
      `${audioStreams.join("")}amix=inputs=${audioStreams.length}:duration=first:dropout_transition=2[audio]`
    );
  } else if (audioStreams.length === 1) {
    filters.push(
      `${audioStreams[0]}aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[audio]`
    );
  }

  args.push("-filter_complex", filters.join(";\n"));
  args.push("-map", "[video]");

  if (audioStreams.length > 0) {
    args.push("-map", "[audio]");
  }

  // Output encoding settings
  args.push(
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    "-t", totalDuration.toFixed(3),
    outPath
  );

  console.log(`[${jobId}][ffmpeg] Rendering ${scenes.length} scenes, ${totalDuration.toFixed(1)}s to ${outPath}...`);

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });

    const stderr: string[] = [];
    proc.stderr.on("data", (d: Buffer) => {
      const line = d.toString();
      stderr.push(line);
      if (line.includes("frame=") || line.includes("time=")) {
        const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (timeMatch) {
          process.stdout.write(`\r[${jobId}][ffmpeg] ${timeMatch[1]}  `);
        }
      }
    });

    proc.on("close", (code) => {
      process.stdout.write("\n");
      if (code === 0) {
        console.log(`[${jobId}][ffmpeg] Render successful → ${outPath}`);
        resolve(outPath);
      } else {
        const errMsg = stderr.join("").slice(-600);
        reject(new Error(`ffmpeg exited ${code}: ${errMsg}`));
      }
    });

    proc.on("error", reject);
  });
}
