const fs = require('node:fs');
const path = require('node:path');
const output = path.join(__dirname, 'dist');
const typescript = path.dirname(require.resolve('typescript/package.json'));
const manifestPath = path.join(__dirname, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log(`Building NgRx Inspector ${manifest.version}`);
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'src/inspector.js'), path.join(output, 'inspector.js'));
fs.copyFileSync(path.join(__dirname, 'src/metadata.js'), path.join(output, 'metadata.js'));
fs.copyFileSync(path.join(__dirname, 'src/extension.js'), path.join(output, 'extension.js'));
fs.writeFileSync(
  path.join(output, 'handlers.js'),
  fs
    .readFileSync(path.join(__dirname, 'src/handlers.js'), 'utf8')
    .replace("require('typescript')", "require('./typescript')"),
);
fs.copyFileSync(path.join(typescript, 'lib/typescript.js'), path.join(output, 'typescript.js'));
fs.copyFileSync(path.join(typescript, 'LICENSE.txt'), path.join(output, 'TYPESCRIPT-LICENSE.txt'));
fs.copyFileSync(
  path.join(typescript, 'ThirdPartyNoticeText.txt'),
  path.join(output, 'TYPESCRIPT-NOTICES.txt'),
);

fs.writeFileSync(
  path.join(output, 'selectors.js'),
  fs
    .readFileSync(path.join(__dirname, 'src/selectors.js'), 'utf8')
    .replace("require('typescript')", "require('./typescript')"),
);
