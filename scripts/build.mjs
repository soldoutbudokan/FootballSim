import {cp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const out='.pages-dist';await rm(out,{recursive:true,force:true});await mkdir(out);await cp('dist',out,{recursive:true});
async function walk(dir){const result=[];for(const ent of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,ent.name);result.push(...(ent.isDirectory()?await walk(f):[f]));}return result;}
const files=(await walk(out)).sort(),hash=createHash('sha256');for(const f of files){hash.update(path.relative(out,f));hash.update(await readFile(f));}const version=hash.digest('hex').slice(0,12);
// One release key covers the entire ES module graph, including vendor imports.
for(const f of files.filter(f=>/\.(html|js|css)$/.test(f))){let text=await readFile(f,'utf8');if(f.endsWith('.js'))text=text.replace(/((?:from\s*|import\s*)['"])(\.{1,2}\/[^'"?]+\.js)(['"])/g,`$1$2?v=${version}$3`);if(f.endsWith('.html'))text=text.replace(/((?:src|href)=["'])(\.\/[^"'?]+\.(?:js|css))(["'])/g,`$1$2?v=${version}$3`);await writeFile(f,text);}
await writeFile(path.join(out,'release.json'),JSON.stringify({version},null,2)+'\n');console.log(`Built self-contained GitHub Pages release ${version}.`);
