/**
 * Generate app icons from raw/logo1.png for all platforms.
 * Windows: .ico
 * macOS: .png (32x32, 128x128, 256x256)
 * Linux: .png (same as macOS)
 */

import sharp from "sharp";
import fs from "fs";
import path from "path";

const INPUT = "raw/logo4.png";
const OUT_DIR = "src-tauri/icons";

const SIZES = [32, 128, 256];

async function main() {
  console.log("Generating icons from", INPUT);

  if (!fs.existsSync(INPUT)) {
    console.error("Input not found:", INPUT);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const inputBuffer = fs.readFileSync(INPUT);
  const img = sharp(inputBuffer).ensureAlpha();

  // Generate PNGs for all sizes (always RGBA)
  for (const size of SIZES) {
    const outPath = path.join(OUT_DIR, `${size}x${size}.png`);
    await img.clone().resize(size, size).png().toFile(outPath);
    console.log(`Created ${outPath}`);

    // Also create @2x version for retina
    if (size === 128) {
      const outPath2x = path.join(OUT_DIR, `128x128@2x.png`);
      await img.clone().resize(256, 256).png().toFile(outPath2x);
      console.log(`Created ${outPath2x}`);
    }
  }

  // Generate .ico (Windows) - contains multiple sizes
  // ICO format: header + directory entries + image data
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoBuffers = [];

  for (const size of icoSizes) {
    const buf = await img.clone().resize(size, size).png().toBuffer();
    // PNG data with BMP info for ICO
    const raw = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bmpData = createBMPData(raw.data, raw.info.width, raw.info.height);
    icoBuffers.push({ width: size, height: size, data: bmpData });
  }

  const icoBuffer = createICO(icoBuffers);
  const icoPath = path.join(OUT_DIR, "icon.ico");
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`Created ${icoPath}`);

  console.log("\nDone! All icons generated.");
}

function createBMPData(pixelData, width, height) {
  // Create a 32-bit BGRA BMP data from RGBA pixels
  const rowSize = width * 4;
  const padding = (4 - (rowSize % 4)) % 4;
  const dataSize = (rowSize + padding) * height;

  const buffer = Buffer.alloc(dataSize);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstRow = height - 1 - y; // BMP is bottom-up
      const dstIdx = dstRow * (rowSize + padding) + x * 4;

      buffer[dstIdx] = pixelData[srcIdx + 2]; // B
      buffer[dstIdx + 1] = pixelData[srcIdx + 1]; // G
      buffer[dstIdx + 2] = pixelData[srcIdx]; // R
      buffer[dstIdx + 3] = pixelData[srcIdx + 3]; // A
    }
  }

  return { data: buffer, dataSize: dataSize };
}

function createICO(entries) {
  const numEntries = entries.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const header = Buffer.alloc(headerSize + dirEntrySize * numEntries);

  // ICO header
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(numEntries, 4); // Number of entries

  let offset = headerSize + dirEntrySize * numEntries;

  for (let i = 0; i < numEntries; i++) {
    const entry = entries[i];
    const w = entry.width >= 256 ? 0 : entry.width;
    const h = entry.height >= 256 ? 0 : entry.height;
    const bmpHeaderSize = 40;
    const totalSize = bmpHeaderSize + entry.data.dataSize;

    const dirOffset = headerSize + i * dirEntrySize;
    header.writeUInt8(w, dirOffset); // Width
    header.writeUInt8(h, dirOffset + 1); // Height
    header.writeUInt8(0, dirOffset + 2); // Colors
    header.writeUInt8(0, dirOffset + 3); // Reserved
    header.writeUInt16LE(1, dirOffset + 4); // Planes
    header.writeUInt16LE(32, dirOffset + 6); // BPP
    header.writeUInt32LE(totalSize, dirOffset + 8); // Size
    header.writeUInt32LE(offset, dirOffset + 12); // Offset

    entry._offset = offset;
    offset += totalSize;
  }

  // Combine header + image data
  const buffers = [header];

  for (const entry of entries) {
    const bmpHeader = Buffer.alloc(40);
    bmpHeader.writeUInt32LE(40, 0); // Header size
    bmpHeader.writeInt32LE(entry.width, 4); // Width
    bmpHeader.writeInt32LE(entry.height * 2, 8); // Height (double for ICO)
    bmpHeader.writeUInt16LE(1, 12); // Planes
    bmpHeader.writeUInt16LE(32, 14); // BPP
    bmpHeader.writeUInt32LE(0, 16); // Compression
    bmpHeader.writeUInt32LE(entry.data.dataSize, 20); // Image size
    bmpHeader.writeUInt32LE(0, 24); // X pixels per meter
    bmpHeader.writeUInt32LE(0, 28); // Y pixels per meter
    bmpHeader.writeUInt32LE(0, 32); // Colors used
    bmpHeader.writeUInt32LE(0, 36); // Important colors

    buffers.push(bmpHeader);
    buffers.push(entry.data.data);
  }

  return Buffer.concat(buffers);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
