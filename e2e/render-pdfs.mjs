import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(process.cwd(), '..');
const jobs = [
  ['docs/print/feature-guide.html', 'Nyaywala-Feature-Guide-for-Beginners.pdf'],
  ['docs/print/implementation-and-workflow.html', 'Nyaywala-Implementation-and-Workflow.pdf'],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out] of jobs) {
  await page.goto(pathToFileURL(path.join(root, src)).href, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: path.join(root, out),
    printBackground: true,
    preferCSSPageSize: true,
  });
  console.log('wrote', out);
}
await browser.close();
