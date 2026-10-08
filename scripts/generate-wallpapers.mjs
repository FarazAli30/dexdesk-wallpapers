#!/usr/bin/env node

/**
 * DexDesk Wallpapers catalog generator
 *
 * Source of truth:
 *   originals/
 *
 * Generated:
 *   thumbnails/
 *   manifest.json
 *
 * The script intentionally does NOT require manually maintained metadata.
 * It extracts image metadata with sharp and derives a stable ID/title from
 * the original filename.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const ROOT = process.cwd();
const ORIGINALS = path.join(ROOT, "originals");
const THUMBNAILS = path.join(ROOT, "thumbnails");
const MANIFEST = path.join(ROOT, "manifest.json");

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".tif", ".tiff"
]);

const THUMB_WIDTH = Number(process.env.THUMB_WIDTH || 640);
const THUMB_HEIGHT = Number(process.env.THUMB_HEIGHT || 360);
const THUMB_QUALITY = Number(process.env.THUMB_QUALITY || 82);

const MANIFEST_VERSION = 1;
const SCHEMA_VERSION = 1;

const MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff"
};

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exitCode = 1;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function slugify(input) {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase();
}

function titleFromFilename(filename) {
  const withoutExt = path.basename(filename, path.extname(filename));
  const cleaned = withoutExt.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map(word => {
      if (/^\d+k$/i.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getIdFromFilename(filename) {
  const id = slugify(path.basename(filename, path.extname(filename)));
  if (!id) {
    throw new Error(`Cannot create an ID from filename: ${filename}`);
  }
  return id;
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      result.push(...await walk(full));
      continue;
    }

    result.push(full);
  }

  return result;
}

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function cleanGeneratedThumbnails(validThumbnailNames) {
  let entries = [];
  try {
    entries = await fs.readdir(THUMBNAILS, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".webp")) continue;

    if (!validThumbnailNames.has(entry.name)) {
      await fs.rm(path.join(THUMBNAILS, entry.name), { force: true });
      console.log(`Removed stale thumbnail: ${entry.name}`);
    }
  }
}

async function generateThumbnail(input, output) {
  await sharp(input)
    .rotate()
    .resize({
      width: THUMB_WIDTH,
      height: THUMB_HEIGHT,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp({ quality: THUMB_QUALITY, effort: 5 })
    .toFile(output);
}

async function main() {
  await ensureDirectory(ORIGINALS);
  await ensureDirectory(THUMBNAILS);

  const allFiles = await walk(ORIGINALS);
  const originals = allFiles
    .filter(file => SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  if (originals.length === 0) {
    console.log("No supported wallpapers found in originals/.");
    console.log("Supported: JPG, JPEG, PNG, WebP, AVIF, TIFF.");
  }

  const seenHashes = new Map();
  const seenIds = new Map();
  const wallpapers = [];
  const validThumbnailNames = new Set();
  const errors = [];

  for (const input of originals) {
    const relativeOriginal = toPosix(path.relative(ROOT, input));
    const filename = path.basename(input);
    const extension = path.extname(filename).toLowerCase();
    const id = getIdFromFilename(filename);
    const title = titleFromFilename(filename);
    const thumbnailName = `${id}.webp`;
    const thumbnailPath = path.join(THUMBNAILS, thumbnailName);

    try {
      const buffer = await fs.readFile(input);
      const hash = sha256(buffer);

      if (seenHashes.has(hash)) {
        errors.push(
          `Duplicate image content:\n  ${relativeOriginal}\n  ${seenHashes.get(hash)}\n  SHA-256: ${hash}`
        );
        continue;
      }
      seenHashes.set(hash, relativeOriginal);

      if (seenIds.has(id)) {
        errors.push(
          `Duplicate wallpaper ID "${id}":\n  ${relativeOriginal}\n  ${seenIds.get(id)}\n  Rename one of the files so their generated IDs differ.`
        );
        continue;
      }
      seenIds.set(id, relativeOriginal);

      const metadata = await sharp(input).metadata();

      if (!metadata.width || !metadata.height) {
        throw new Error("Image dimensions could not be detected.");
      }

      await generateThumbnail(input, thumbnailPath);
      validThumbnailNames.add(thumbnailName);

      const stats = await fs.stat(input);
      const thumbnailStats = await fs.stat(thumbnailPath);

      const aspectRatio = Number((metadata.width / metadata.height).toFixed(4));

      wallpapers.push({
        id,
        title,
        category: "Uncategorized",
        tags: [],
        original: relativeOriginal,
        thumbnail: toPosix(path.relative(ROOT, thumbnailPath)),
        width: metadata.width,
        height: metadata.height,
        aspectRatio,
        orientation:
          metadata.width === metadata.height
            ? "square"
            : metadata.width > metadata.height
              ? "landscape"
              : "portrait",
        format: (metadata.format || extension.replace(".", "")).toLowerCase(),
        mimeType: MIME_TYPES[extension] || null,
        fileSize: stats.size,
        thumbnailSize: thumbnailStats.size,
        sha256: hash,
        hasAlpha: Boolean(metadata.hasAlpha)
      });

      console.log(`Generated: ${id} (${metadata.width}x${metadata.height})`);
    } catch (error) {
      errors.push(`${relativeOriginal}: ${error.message}`);
    }
  }

  await cleanGeneratedThumbnails(validThumbnailNames);

  if (errors.length > 0) {
    console.error("\nValidation failed:");
    for (const error of errors) {
      console.error(`\n- ${error}`);
    }
    throw new Error(`Found ${errors.length} validation error(s).`);
  }

  wallpapers.sort((a, b) => a.title.localeCompare(b.title));

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    generator: "DexDesk Wallpapers Generator",
    thumbnail: {
      format: "webp",
      maxWidth: THUMB_WIDTH,
      maxHeight: THUMB_HEIGHT,
      quality: THUMB_QUALITY
    },
    supportedFormats: [...SUPPORTED_EXTENSIONS].map(ext => ext.slice(1)),
    count: wallpapers.length,
    wallpapers
  };

  await fs.writeFile(
    MANIFEST,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );

  console.log(`\nManifest generated: ${path.relative(ROOT, MANIFEST)}`);
  console.log(`Wallpapers: ${wallpapers.length}`);
}

main().catch(error => {
  console.error(`\n${error.stack || error.message}`);
  process.exitCode = 1;
});
