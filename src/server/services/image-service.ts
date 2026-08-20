import { basename } from "node:path";
import sharp from "sharp";

export const acceptedImageMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif"
] as const;

const acceptedFormats = new Set(["jpeg", "png", "webp", "heif", "avif"]);

export function isAcceptedImageMimeType(value: string): boolean {
  return (acceptedImageMimeTypes as readonly string[]).includes(value.toLowerCase());
}

export function safeImageFilename(value?: string): string {
  const platformNeutralName = (value?.trim() || "photo").split(/[\\/]/).pop() || "photo";
  const name = basename(platformNeutralName)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 120);
  return name || "photo";
}

export async function normalizeUploadedImage(
  input: Buffer,
  options: { maxDimension: number; quality: number; maxOutputBytes: number }
): Promise<Buffer> {
  const image = sharp(input, {
    failOn: "error",
    limitInputPixels: 40_000_000,
    sequentialRead: true
  });
  const metadata = await image.metadata();
  if (!metadata.format || !acceptedFormats.has(metadata.format) || !metadata.width || !metadata.height) {
    throw new Error("Unsupported or invalid image data");
  }
  if ((metadata.pages ?? 1) > 1) throw new Error("Animated images are not supported");

  const output = await image
    .rotate()
    .resize({
      width: options.maxDimension,
      height: options.maxDimension,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp({ quality: options.quality, effort: 4 })
    .toBuffer();
  if (output.length > options.maxOutputBytes) {
    throw new Error("The processed image is still too large");
  }
  return output;
}
