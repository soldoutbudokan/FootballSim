import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const files=(await readdir('dist/js')).filter(f=>f.endsWith('.js'));
for(const f of files){const result=spawnSync(process.execPath,['--check','dist/js/'+f],{stdio:'inherit'});if(result.status)process.exit(result.status);const source=await readFile('dist/js/'+f,'utf8');for(const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))throw new Error('Runtime import must be local: '+m[1]);}}
for(const f of ['dist/vendor/three.core.js','dist/vendor/three.module.js','dist/vendor/THREE-LICENSE.txt'])if((await readFile(f)).length<100)throw new Error('Missing vendor file: '+f);
console.log(`Checked ${files.length} modules and vendored renderer.`);
