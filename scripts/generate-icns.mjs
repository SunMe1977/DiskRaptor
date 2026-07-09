/**
 * Generate macOS .icns file from raw/logo1.png
 *
 * ICNS format contains multiple icon sizes in a single file.
 * Required sizes for retina macOS: 16, 32, 128, 256, 512, 1024
 */

import sharp from "sharp";
import fs from "fs";
import path from "path";
import zlib from "zlib";

const INPUT = "raw/logo6.png";
const OUT_DIR = "src-tauri/icons";
const OUTPUT = path.join(OUT_DIR, "icon.icns");

// ICNS icon types and their sizes
const ICON_TYPES = [
  { type: "ic04", size: 16, suffix: "" }, // 16x16 - 16x16
  { type: "ic05", size: 32, suffix: "" }, // 32x32
  { type: "ic06", size: 32, suffix: "@2x" }, // 32x32@2x (64)
  { type: "ic07", size: 128, suffix: "" }, // 128x128
  { type: "ic08", size: 256, suffix: "" }, // 256x256
  { type: "ic09", size: 512, suffix: "" }, // 512x512
  { type: "ic10", size: 1024, suffix: "" }, // 1024x1024
  { type: "ic11", size: 256, suffix: "@2x" }, // 256x256@2x (512)
  { type: "ic12", size: 512, suffix: "@2x" }, // 512x512@2x (1024)
  { type: "ic13", size: 16, suffix: "@2x" }, // 16x16@2x (32)
];

async function main() {
  console.log("Generating macOS .icns from", INPUT);

  if (!fs.existsSync(INPUT)) {
    console.error("Input not found:", INPUT);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const inputBuffer = fs.readFileSync(INPUT);
  const img = sharp(inputBuffer).ensureAlpha();

  const iconEntries = [];

  for (const icon of ICON_TYPES) {
    const targetSize = icon.size * (icon.suffix === "@2x" ? 2 : 1);
    console.log(`  Generating ${icon.type} (${targetSize}x${targetSize})...`);

    // Resize and get raw RGBA pixels
    const resized = await img
      .clone()
      .resize(targetSize, targetSize)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // For ICNS, we use PNG compression (ic07+ types) or raw ARGB data (ic04-ic06)
    // Modern macOS prefers ic07+ with PNG data
    if (icon.type === "ic04" || icon.type === "ic05" || icon.type === "ic06") {
      // Old format: raw ARGB (non-premultiplied), uncompressed
      const data = convertToARGB(
        resized.data,
        resized.info.width,
        resized.info.height,
      );
      iconEntries.push({
        type: icon.type,
        data: data,
        origSize: data.length,
      });
    } else {
      // Modern format: PNG compressed
      const pngBuffer = await sharp(resized.data, {
        raw: {
          width: resized.info.width,
          height: resized.info.height,
          channels: 4,
        },
      })
        .png()
        .toBuffer();
      iconEntries.push({
        type: icon.type,
        data: pngBuffer,
        origSize: pngBuffer.length,
      });
    }
  }

  // Build ICNS file
  const headerSize = 8;
  let totalSize = headerSize;

  // Calculate offsets
  const entries = [];
  for (const entry of iconEntries) {
    const entrySize = 8 + entry.data.length; // type(4) + size(4) + data
    entries.push({
      type: entry.type,
      data: entry.data,
      size: entrySize,
    });
    totalSize += entrySize;
  }

  const buffer = Buffer.alloc(totalSize);
  let offset = 0;

  // Header
  buffer.write("icns", offset, 4, "ascii");
  offset += 4;
  buffer.writeUInt32BE(totalSize, offset);
  offset += 4;

  // Icon entries
  for (const entry of entries) {
    buffer.write(entry.type, offset, 4, "ascii");
    offset += 4;
    buffer.writeUInt32BE(entry.size, offset);
    offset += 4;
    entry.data.copy(buffer, offset);
    offset += entry.data.length;
  }

  fs.writeFileSync(OUTPUT, buffer);
  console.log(`\nCreated ${OUTPUT} (${(totalSize / 1024).toFixed(0)} KB)`);
  console.log(`Contains ${entries.length} icon sizes:`);
  for (const entry of entries) {
    const kb = (entry.data.length / 1024).toFixed(0);
    console.log(`  ${entry.type} - ${kb} KB`);
  }
}

function convertToARGB(pixels, width, height) {
  // Convert RGBA to ARGB (non-premultiplied)
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * 4;
    const dst = i * 4;
    data[dst] = pixels[src + 3]; // A
    data[dst + 1] = pixels[src]; // R
    data[dst + 2] = pixels[src + 1]; // G
    data[dst + 3] = pixels[src + 2]; // B
  }
  return data;
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
