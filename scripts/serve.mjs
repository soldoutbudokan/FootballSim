import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.argv[2]||'dist'),port=Number(process.env.PORT||8000);
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.txt':'text/plain'};
http.createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname),filename=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));if(filename!==root&&!filename.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}const body=await readFile(filename);res.writeHead(200,{'content-type':types[path.extname(filename)]||'application/octet-stream','cache-control':'no-cache'});res.end(body);}catch{res.writeHead(404);res.end('Not found');}}).listen(port,'0.0.0.0',()=>console.log(`FootballSim preview: http://localhost:${port}`));
