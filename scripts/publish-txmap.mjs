// Publish the exact event → transaction map to the `txmap` branch (read by the dashboard from
// raw.githubusercontent.com). Runs at the end of every cloud swarm run; merges, never overwrites.
//   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/publish-txmap.mjs [.keys/txmap-new.json]
import fs from 'node:fs';

const repo = process.env.GITHUB_REPOSITORY || 'Shivam-sopho/hivemind-near';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const file = process.argv[2] || '.keys/txmap-new.json';
if (!token) { console.log('no token, skipping'); process.exit(0); }
let fresh = {};
try { fresh = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.log('no new tx mappings'); process.exit(0); }

const api = (path, init = {}) => fetch(`https://api.github.com/repos/${repo}/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...(init.headers || {}) } });

for (let attempt = 0; attempt < 3; attempt++) {
  const cur = await api('contents/txmap.json?ref=txmap');
  let existing = {}, sha;
  if (cur.ok) { const j = await cur.json(); sha = j.sha; existing = JSON.parse(Buffer.from(j.content, 'base64').toString()); }
  const merged = { ...existing, ...fresh };
  if (sha && Object.keys(merged).length === Object.keys(existing).length) { console.log(`txmap up to date (${Object.keys(merged).length} events)`); process.exit(0); }
  const put = await api('contents/txmap.json', {
    method: 'PUT',
    body: JSON.stringify({ message: `txmap: ${Object.keys(merged).length} events`, branch: 'txmap', sha, content: Buffer.from(JSON.stringify(merged)).toString('base64') }),
  });
  if (put.ok) { console.log(`txmap published: ${Object.keys(merged).length} events (+${Object.keys(merged).length - Object.keys(existing).length})`); process.exit(0); }
  console.log(`publish attempt ${attempt + 1} failed: ${put.status} ${(await put.text()).slice(0, 160)}`);
  await new Promise((s) => setTimeout(s, 3000));
}
process.exit(1);
