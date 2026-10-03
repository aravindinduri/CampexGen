/**
 * AI image generation for scene backgrounds.
 *
 * Uses Pollinations.ai — free, no API key, simple HTTP GET.
 * Falls back to gradient PNG if generation fails.
 *
 * ponytail: zero-dep, zero-config image gen via URL-based API
 */
import { writeFile } from "fs/promises";

const BASE_URL = "https://image.pollinations.ai/prompt";

/**
 * Generate an AI image from a text prompt and save it as PNG.
 * @returns true if image was generated, false if fallback needed
 */
export async function generateImage(
  prompt: string,
  width: number,
  height: number,
  outPath: string
): Promise<boolean> {
  try {
    // Pollinations has a max pixel limit (~1024x1024), so scale down for generation
    // then the renderer will scale up. For 9:16 (1080x1920), request 540x960.
    const scale = Math.min(1, 1024 / Math.max(width, height));
    const reqWidth = Math.round(width * scale);
    const reqHeight = Math.round(height * scale);

    const encoded = encodeURIComponent(prompt);
    const url = `${BASE_URL}/${encoded}?width=${reqWidth}&height=${reqHeight}&nologo=true&seed=${Date.now() % 100000}`;

    console.log(`[imagegen] Generating ${reqWidth}x${reqHeight} image...`);

    const res = await fetch(url, {
      signal: AbortSignal.timeout(45_000), // generous timeout for image gen
    });

    if (!res.ok) {
      console.warn(`[imagegen] HTTP ${res.status} from Pollinations`);
      return false;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("image")) {
      console.warn(`[imagegen] Unexpected content-type: ${contentType}`);
      return false;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) {
      // Too small to be a real image
      console.warn(`[imagegen] Image too small (${buf.length} bytes), skipping`);
      return false;
    }

    await writeFile(outPath, buf);
    console.log(`[imagegen] Saved ${outPath} (${(buf.length / 1024).toFixed(0)} KB)`);
    return true;
  } catch (err) {
    console.warn(`[imagegen] Failed: ${(err as Error).message}`);
    return false;
  }
}
