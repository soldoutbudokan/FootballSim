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
const assets={
  'sparse_grass_diff_1k.jpg':'ae94f2b34597b9108eefd88217f55eccaec6d6b382e858a478ee92df90e66617',
  'sparse_grass_nor_gl_1k.jpg':'1c840a24807346ddaaf94a5057aee4078fcec3a4cd84bfe45da7d3b480ef460b',
  'sparse_grass_rough_1k.jpg':'9ebe6d03a9551c17d1802835c92c1442acb8f5d38d4874ee8c37770f11c4bed1',
  'noon_grass_1k.hdr':'63413e8b3d8b4c394396d05ab9c7c590a8d70e2cf45187054d198d42f0209939',
};
await mkdir('dist/assets',{recursive:true});
for(const [name,expected] of Object.entries(assets)){
  const dest='dist/assets/'+name;let cached;try{cached=await readFile(dest);}catch{}
  const hash=b=>createHash('sha256').update(b).digest('hex');if(cached&&hash(cached)===expected)continue;
  const response=await fetch(`https://raw.githubusercontent.com/soldoutbudokan/CricSim/${revision}/dist/assets/${name}`,{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error(`Environment download failed: ${response.status} (${name})`);
  const bytes=Buffer.from(await response.arrayBuffer());if(hash(bytes)!==expected)throw new Error('Environment integrity check failed: '+name);
  await writeFile(dest,bytes);console.log('Prepared verified environment asset: '+name);
}
