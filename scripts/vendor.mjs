// Reuse CricSim's exact Three.js 0.180.0 distribution at build time. Both files
// are shipped inside the Pages artifact; players make no cross-site requests.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const revision='b70aaf8a1bae5aa4ca42690b8c4e3ee8a79d05a6';
const files={
  'three.core.js':'7dcd0fbcbc04b8d9a20ecb96c1ce344cb55150d5',
  'three.module.js':'477ca4dafa7af919a2b9818e01b5ae25198d4aa4',
};
function blobHash(bytes){return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');}
await mkdir('dist/vendor',{recursive:true});
for(const [name,expected] of Object.entries(files)){
  const dest='dist/vendor/'+name;let cached;try{cached=await readFile(dest);}catch{}
  if(cached&&blobHash(cached)===expected)continue;
  const url=`https://raw.githubusercontent.com/soldoutbudokan/CricSim/${revision}/dist/vendor/${name}`;
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error(`Renderer download failed: ${response.status} (${name})`);
  const bytes=Buffer.from(await response.arrayBuffer());if(blobHash(bytes)!==expected)throw new Error('Renderer integrity check failed: '+name);
  await writeFile(dest,bytes);console.log('Prepared '+name+' (verified '+expected+')');
}
