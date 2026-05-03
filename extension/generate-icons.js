// Run with: node generate-icons.js
// Creates simple colored PNG icons for the extension.
const fs = require('fs');
const path = require('path');

// Minimal 1x1 red pixel PNG, scaled versions generated via Canvas in Node
// We'll create simple solid-color PNGs using raw PNG bytes.

function createSimplePNG(size, r, g, b) {
  // Use the 'canvas' package if available, otherwise write a stub PNG header
  try {
    const { createCanvas } = require('canvas');
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, size, size);

    // Red circle
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = '#e94560';
    ctx.fill();

    // Play triangle
    const s = size * 0.22;
    ctx.beginPath();
    ctx.moveTo(size / 2 - s * 0.5, size / 2 - s);
    ctx.lineTo(size / 2 - s * 0.5, size / 2 + s);
    ctx.lineTo(size / 2 + s, size / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    return canvas.toBuffer('image/png');
  } catch {
    // Fallback: 1x1 red pixel PNG (valid minimal PNG)
    return Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
      '2e0000000c4944415408d76360f8cfc000000002' + '0001e221bc330000000049454e44ae426082',
      'hex'
    );
  }
}

const outDir = path.join(__dirname, 'icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

for (const size of [16, 48, 128]) {
  const buf = createSimplePNG(size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buf);
  console.log(`Created icons/icon${size}.png`);
}
console.log('Done. If icons look wrong, install "canvas" package: npm install canvas');
