import {access,readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
// Every original module under dist/js, including dist/js/env and dist/js/athletes.
async function walk(dir){const result=[];for(const ent of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,ent.name);if(ent.isDirectory())result.push(...await walk(f));else if(f.endsWith('.js'))result.push(f);}return result;}
const files=(await walk('dist/js')).sort();
for(const f of files){const result=spawnSync(process.execPath,['--check',f],{stdio:'inherit'});if(result.status)process.exit(result.status);const source=await readFile(f,'utf8');for(const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))throw new Error(`Runtime import must be local: ${m[1]} in ${f}`);const target=path.resolve(path.dirname(f),m[1]);await access(target).catch(()=>{throw new Error(`Missing module ${m[1]} imported by ${f}`);});}}
for(const f of ['dist/vendor/three.core.js','dist/vendor/three.module.js','dist/vendor/THREE-LICENSE.txt','dist/vendor/Sky.js'])if((await readFile(f)).length<100)throw new Error('Missing vendor file: '+f);
console.log(`Checked ${files.length} modules and vendored renderer.`);
