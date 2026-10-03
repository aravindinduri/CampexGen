/**
 * ElevenLabs API client for TTS and music generation.
 *
 * Uses the REST API directly (no SDK dependency) to keep things lean.
 * - Text-to-Speech: POST /v1/text-to-speech/{voice_id}
 * - Text-to-Music:  POST /v1/text-to-music
 *
 * ponytail: raw fetch instead of @elevenlabs/elevenlabs-js SDK — one less dep
 */
import { writeFile } from "fs/promises";

const API_BASE = "https://api.elevenlabs.io";

// Default voice: "Rachel" — a clear, professional female narrator
// See https://elevenlabs.io/docs/voices for full list
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  return key;
}

/** Check if ElevenLabs is configured */
export function elevenlabsAvailable(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

// ── Text-to-Speech ──────────────────────────────────────────────────────────

export interface ElevenLabsTTSOptions {
  /** ElevenLabs voice ID (default: Rachel) */
  voiceId?: string;
  /** Model ID (default: eleven_multilingual_v2) */
  modelId?: string;
  /** Stability 0-1 (default: 0.5) */
  stability?: number;
  /** Similarity boost 0-1 (default: 0.75) */
  similarityBoost?: number;
}

/**
 * Generate speech from text using ElevenLabs TTS.
 * Returns the output file path.
 */
export async function elevenLabsTTS(
  text: string,
  outPath: string,
  options: ElevenLabsTTSOptions = {}
): Promise<string> {
  const apiKey = getApiKey();
  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
  const modelId = options.modelId ?? "eleven_multilingual_v2";

  const url = `${API_BASE}/v1/text-to-speech/${voiceId}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        stability: options.stability ?? 0.5,
        similarity_boost: options.similarityBoost ?? 0.75,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errorText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buf);
  console.log(`[elevenlabs] TTS → ${outPath} (${buf.length} bytes)`);
  return outPath;
}

// ── Text-to-Music ───────────────────────────────────────────────────────────

export interface ElevenLabsMusicOptions {
  /** Duration in seconds (default: 30) */
  durationSeconds?: number;
}

/**
 * Generate background music from a text prompt using ElevenLabs.
 * Returns the output file path.
 */
export async function elevenLabsMusic(
  prompt: string,
  outPath: string,
  options: ElevenLabsMusicOptions = {}
): Promise<string> {
  const apiKey = getApiKey();
  const duration = options.durationSeconds ?? 30;

  const url = `${API_BASE}/v1/music/stream`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      prompt,
      duration_seconds: duration,
    }),
    // Music gen can be slow — generous timeout
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`ElevenLabs music gen failed (${res.status}): ${errorText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buf);
  console.log(`[elevenlabs] Music → ${outPath} (${buf.length} bytes, ${duration}s)`);
  return outPath;
}
