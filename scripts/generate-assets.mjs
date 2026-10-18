// One-off: favicon / touch icons / OG image from the app launcher icon (read-only source).
// Usage: node scripts/generate-assets.mjs [../beautica-mobile/assets/branding/launcher_icon_source.png]
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const src = process.argv[2] ?? "../beautica-mobile/assets/branding/launcher_icon_source.png";
const png = (size) => sharp(src).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

// ICO container holding one 48x48 PNG (valid per the ICO spec, accepted by all browsers).
const ico48 = await png(48);
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt8(48, 6); header.writeUInt8(48, 7); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(ico48.length, 14); header.writeUInt32LE(22, 18);
writeFileSync("public/favicon.ico", Buffer.concat([header, ico48]));
writeFileSync("public/icon-192.png", await png(192));
writeFileSync("public/apple-touch-icon.png", await png(180));

// OG 1200x630: the app base colour with the logo tile centred.
const logo = await png(360);
await sharp({ create: { width: 1200, height: 630, channels: 3, background: "#E6DDD0" } })
  .composite([{ input: logo, left: 420, top: 135 }])
  .png({ compressionLevel: 9 })
  .toFile("public/og-default.png");
console.log("assets written");
