import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const srcDir = 'C:/Users/Любовь/.gemini/antigravity/scratch/obsidian-yandex-disk-sync';
const targetObsidian = 'D:/Programs/Obsidian/2026 г/Awerness/Awerness/.obsidian/plugins/yandex-disk-sync';
const targetDownloads = 'D:/Downloads/yandex-disk-sync';

const files = ['main.js', 'manifest.json', 'styles.css'];

fs.mkdirSync(targetObsidian, { recursive: true });
fs.mkdirSync(targetDownloads, { recursive: true });

for (const file of files) {
  const srcFile = path.join(srcDir, file);
  const dest1 = path.join(targetObsidian, file);
  const dest2 = path.join(targetDownloads, file);
  fs.copyFileSync(srcFile, dest1);
  fs.copyFileSync(srcFile, dest2);
  console.log(`Copied ${file} -> Obsidian & Downloads`);
}

const zipScript = `
Remove-Item -Force -ErrorAction SilentlyContinue 'D:\\Downloads\\yandex-disk-sync.zip', 'D:\\Downloads\\obsidian-yandex-disk-sync.zip'
Compress-Archive -Path 'D:\\Downloads\\yandex-disk-sync' -DestinationPath 'D:\\Downloads\\yandex-disk-sync.zip'
Copy-Item -Force 'D:\\Downloads\\yandex-disk-sync.zip' 'D:\\Downloads\\obsidian-yandex-disk-sync.zip'
`;

fs.writeFileSync(path.join(srcDir, 'scripts/make-zip.ps1'), zipScript, 'utf8');
execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(srcDir, 'scripts/make-zip.ps1')}"`, { stdio: 'inherit' });
fs.unlinkSync(path.join(srcDir, 'scripts/make-zip.ps1'));

console.log('Deployment and ZIP archives creation completed successfully!');
