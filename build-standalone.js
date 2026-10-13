// Inlines the shared engine and player data into one HTML file that runs with no server
// (solo + bots and couch drafts). Output: dist/madden-draft-standalone.html
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
let html = read('public/index.html');
const inline = f => '<script>\n' + read(f) + '\n</script>';
html = html.replace('<script src="shared/draft-engine.js"></script>', () => '<script>window.MSFD_STANDALONE = true;</script>\n' + inline('shared/draft-engine.js'));
html = html.replace('<script src="shared/player-data.js"></script>', () => inline('shared/player-data.js'));
if (html.includes('src="shared/')) throw new Error('Inlining failed');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/madden-draft-standalone.html'), html);
console.log('Wrote dist/madden-draft-standalone.html (' + Math.round(html.length / 1024) + ' KB)');
