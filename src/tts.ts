/**
 * TTS provider — powered by edge-tts (Microsoft Neural TTS).
 *
 * Uses `python -m edge_tts` subprocess to generate high-quality voiceovers
 * with zero cost, zero API keys, and dozens of natural voices.
 *
 * Returns the output path and duration in seconds.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import ffmpeg from "fluent-ffmpeg";

export type TTSProvider = "edge-tts";

/**
 * Synthesize text to speech using edge-tts.
 *
 * @param text   Text to speak
 * @param voice  Voice name (default: "en-US-AriaNeural")
 * @param outPath Destination audio path (.mp3)
 */
export async function synthesize(
  text: string,
  voice: string = "en-US-AriaNeural",
  outPath: string
): Promise<{ path: string; duration: number; provider: TTSProvider }> {
  await runEdgeTts(text, voice, outPath);
  const duration = await probeDuration(outPath);
  return { path: outPath, duration, provider: "edge-tts" };
}

// ── edge-tts subprocess ──────────────────────────────────────────────────────

function runEdgeTts(text: string, voice: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python", [
      "-m", "edge_tts",
      "--voice", voice,
      "--text", text,
      "--write-media", outPath,
    ]);

    const errs: string[] = [];
    proc.stderr.on("data", (d: Buffer) => errs.push(d.toString()));

    proc.on("close", (code) => {
      if (code === 0 && existsSync(outPath)) {
        resolve();
      } else {
        reject(new Error(`edge-tts exited ${code}: ${errs.join("")}`));
      }
    });
    proc.on("error", reject);
  });
}

// ── Shared utilities ────────────────────────────────────────────────────────

export async function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration ?? 0);
    });
  });
}

// Check if edge-tts is available
export async function ttsAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("python", ["-m", "edge_tts", "--version"]);
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
