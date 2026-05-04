const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const inputDir = 'G:\\\\ChessGPT';
const outputDir = path.join(__dirname, 'public', 'images');

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

const files = [
    { name: 'claude-logo.svg', output: 'claude.png' },
    { name: 'Google_Gemini_icon_2025.svg.png', output: 'gemini.png' },
    { name: 'grok-seeklogo-.svg', output: 'grok.png' },
    { name: 'openai-chatgpt-logo-icon-free-png.png', output: 'chatgpt.png' }
];

async function processLogos() {
    for (const file of files) {
        const inputPath = path.join(inputDir, file.name);
        const outputPath = path.join(outputDir, file.output);
        
        try {
            await sharp(inputPath)
                .resize(256, 256, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 } // transparent background
                })
                .png()
                .toFile(outputPath);
            console.log(`Successfully processed ${file.name} to ${file.output}`);
        } catch (error) {
            console.error(`Error processing ${file.name}:`, error);
        }
    }
}

processLogos();
