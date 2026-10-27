// Downloads every third-party runtime file listed in scripts/assets/*.json and
// verifies it (SHA-256 of the bytes, or a Git blob SHA-1) before it is used.
// Verified files are cached in the working tree; the published release ships
// them, so players make no cross-site requests. Each manifest entry may also
// carry "replace": [[from, to], ...] string substitutions applied after the hash
// check (used to make vendored ES modules import the local renderer copy).
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const dir='scripts/assets';
const manifests=(await readdir(dir)).filter(f=>f.endsWith('.json')).sort();
const blobHash=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function apply(bytes,entry){if(!entry.replace)return bytes;let text=bytes.toString('utf8');for(const [from,to] of entry.replace){if(!text.includes(from))throw new Error(`Replacement text not found in ${entry.dest}: ${from}`);text=text.split(from).join(to);}return Buffer.from(text,'utf8');}
for(const name of manifests){
  const manifest=JSON.parse(await readFile(path.join(dir,name),'utf8'));
  for(const entry of manifest.files){
    if(!entry.dest||!entry.url||!(entry.sha256||entry.gitBlobSha1))throw new Error(`Manifest ${name}: each file needs dest, url and sha256 or gitBlobSha1.`);
    const matches=bytes=>entry.sha256?sha256(bytes)===entry.sha256:blobHash(bytes)===entry.gitBlobSha1;
    const verifiedPath=entry.replace?entry.dest+'.verified':entry.dest;
    let cached;try{cached=await readFile(verifiedPath);}catch{}
    if(cached&&matches(cached)){if(entry.replace){let out;try{out=await readFile(entry.dest);}catch{}if(!out||!out.equals(apply(cached,entry)))await writeFile(entry.dest,apply(cached,entry));}continue;}
    const response=await fetch(entry.url,{signal:AbortSignal.timeout(90000)});
    if(!response.ok)throw new Error(`Download failed: ${response.status} (${entry.dest})`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(!matches(bytes))throw new Error(`Integrity check failed: ${entry.dest} (${entry.sha256?sha256(bytes):blobHash(bytes)})`);
    await mkdir(path.dirname(entry.dest),{recursive:true});
    if(entry.replace){await writeFile(verifiedPath,bytes);await writeFile(entry.dest,apply(bytes,entry));}else await writeFile(entry.dest,bytes);
    console.log(`Prepared ${entry.dest} (verified)`);
  }
}
console.log(`Vendored assets from ${manifests.length} manifest(s) are present and verified.`);
