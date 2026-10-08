#!/usr/bin/env node

/**
 * Independent validation step.
 *
 * Checks:
 * - originals contain supported files only
 * - generated manifest exists
 * - every wallpaper has a thumbnail
 * - every manifest original exists
 * - every ID is unique
 * - every SHA-256 is unique
 * - manifest count matches actual wallpaper count
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const ORIGINALS = path.join(ROOT, "originals");
const THUMBNAILS = path.join(ROOT, "thumbnails");
const MANIFEST = path.join(ROOT, "manifest.json");

const SUPPORTED = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".tif", ".tiff"
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      result.push(...await walk(full));
    } else {
      result.push(full);
    }
  }

  return result;
}

function hash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const errors = [];

  if (!(await exists(MANIFEST))) {
    errors.push("manifest.json does not exist.");
  }

  let manifest = null;

  if (await exists(MANIFEST)) {
    try {
      manifest = JSON.parse(await fs.readFile(MANIFEST, "utf8"));
    } catch (error) {
      errors.push(`manifest.json is invalid JSON: ${error.message}`);
    }
  }

  const files = await walk(ORIGINALS);
  const originals = files.filter(file =>
    SUPPORTED.has(path.extname(file).toLowerCase())
  );

  const unsupported = files.filter(file =>
    !SUPPORTED.has(path.extname(file).toLowerCase())
  );

  if (unsupported.length) {
    for (const file of unsupported) {
      errors.push(
        `Unsupported file in originals/: ${toPosix(path.relative(ROOT, file))}`
      );
    }
  }

  if (manifest) {
    if (!Array.isArray(manifest.wallpapers)) {
      errors.push("manifest.wallpapers must be an array.");
    } else {
      if (manifest.count !== manifest.wallpapers.length) {
        errors.push(
          `Manifest count mismatch: count=${manifest.count}, actual=${manifest.wallpapers.length}`
        );
      }

      const ids = new Set();
      const hashes = new Set();

      for (const wallpaper of manifest.wallpapers) {
        if (!wallpaper.id) errors.push("Wallpaper is missing id.");
        if (!wallpaper.title) errors.push(`Wallpaper ${wallpaper.id} is missing title.`);
        if (!wallpaper.original) errors.push(`Wallpaper ${wallpaper.id} is missing original.`);
        if (!wallpaper.thumbnail) errors.push(`Wallpaper ${wallpaper.id} is missing thumbnail.`);

        if (ids.has(wallpaper.id)) {
          errors.push(`Duplicate manifest ID: ${wallpaper.id}`);
        }
        ids.add(wallpaper.id);

        if (hashes.has(wallpaper.sha256)) {
          errors.push(`Duplicate manifest SHA-256: ${wallpaper.sha256}`);
        }
        hashes.add(wallpaper.sha256);

        if (wallpaper.original) {
          const originalPath = path.join(ROOT, wallpaper.original);
          if (!(await exists(originalPath))) {
            errors.push(
              `Missing original for ${wallpaper.id}: ${wallpaper.original}`
            );
          }
        }

        if (wallpaper.thumbnail) {
          const thumbnailPath = path.join(ROOT, wallpaper.thumbnail);
          if (!(await exists(thumbnailPath))) {
            errors.push(
              `Missing thumbnail for ${wallpaper.id}: ${wallpaper.thumbnail}`
            );
          }
        }
      }
    }

    if (manifest.count !== originals.length) {
      errors.push(
        `Original count mismatch: originals=${originals.length}, manifest=${manifest.count}`
      );
    }
  }

  // Exact duplicate detection directly from source files.
  const sourceHashes = new Map();

  for (const file of originals) {
    const content = await fs.readFile(file);
    const digest = hash(content);
    const relative = toPosix(path.relative(ROOT, file));

    if (sourceHashes.has(digest)) {
      errors.push(
        `Exact duplicate originals detected:\n  ${sourceHashes.get(digest)}\n  ${relative}\n  SHA-256: ${digest}`
      );
    } else {
      sourceHashes.set(digest, relative);
    }
  }

  // Ensure no generated thumbnail is orphaned.
  if (await exists(THUMBNAILS)) {
    const thumbs = (await fs.readdir(THUMBNAILS))
      .filter(name => name.toLowerCase().endsWith(".webp"));

    const expected = new Set(
      (manifest?.wallpapers || []).map(item => path.basename(item.thumbnail))
    );

    for (const thumb of thumbs) {
      if (!expected.has(thumb)) {
        errors.push(`Orphaned thumbnail: thumbnails/${thumb}`);
      }
    }
  }

  if (errors.length) {
    console.error("\nWallpaper validation FAILED:\n");
    errors.forEach((error, index) => console.error(`${index + 1}. ${error}\n`));
    process.exit(1);
  }

  console.log("Wallpaper validation PASSED.");
  console.log(`Original wallpapers: ${originals.length}`);
  console.log(`Manifest entries: ${manifest?.count ?? 0}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
