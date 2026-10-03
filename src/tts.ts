/**
 * TTS provider — routes to ElevenLabs (preferred) or edge-tts (fallback).
 *
 * Provider priority:
 *   1. ElevenLabs  — if ELEVENLABS_API_KEY is set
 *   2. edge-tts    — Python subprocess (pip install edge-tts)
 *
 * Returns the output path and duration in seconds.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import {
  elevenlabsAvailable,
  elevenLabsTTS,
  type ElevenLabsTTSOptions,
} from "./elevenlabs.js";

// ── Public API ────────────────────────────────────────────────────────────────

export type TTSProvider = "elevenlabs" | "edge-tts";

/**
 * Synthesize text to speech.
 * Automatically picks the best available provider.
 *
 * @param voice  For edge-tts: voice name (e.g. "en-US-AriaNeural")
 *               For ElevenLabs: this is ignored (uses default Rachel voice
 *               or ELEVENLABS_VOICE_ID env var)
 */
export async function synthesize(
  text: string,
  voice: string,
  outPath: string
): Promise<{ path: string; duration: number; provider: TTSProvider }> {
  // Try ElevenLabs first
  if (elevenlabsAvailable()) {
    try {
      const voiceId = process.env.ELEVENLABS_VOICE_ID; // optional override
      await elevenLabsTTS(text, outPath, voiceId ? { voiceId } : {});
      const duration = await probeDuration(outPath);
      return { path: outPath, duration, provider: "elevenlabs" };
    } catch (err) {
      console.warn(`[tts] ElevenLabs failed, falling back to edge-tts: ${(err as Error).message}`);
    }
  }

  // Fallback: edge-tts
  await runEdgeTts(text, voice, outPath);
  const duration = await probeDuration(outPath);
  return { path: outPath, duration, provider: "edge-tts" };
}

// ── edge-tts subprocess ──────────────────────────────────────────────────────

function runEdgeTts(text: string, voice: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // On Windows, edge-tts runs as `python -m edge_tts`; on Linux/Mac it may also be a standalone binary.
    // Try python -m edge_tts first (works everywhere pip installed it).
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

// Check if any TTS provider is available
export async function ttsAvailable(): Promise<boolean> {
  if (elevenlabsAvailable()) return true;

  // Check edge-tts
  return new Promise((resolve) => {
    const proc = spawn("python", ["-m", "edge_tts", "--version"]);
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}
