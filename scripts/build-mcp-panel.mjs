import {build} from 'vite';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const out='.cache/mcp-panel';
await build({configFile:false,logLevel:'error',build:{outDir:out,emptyOutDir:true,cssCodeSplit:false,lib:{entry:'src/mcp-panel/app.js',formats:['iife'],name:'LeafReader',fileName:()=> 'reader.js'},rollupOptions:{output:{inlineDynamicImports:true}}}});
const js=(await readFile(`${out}/reader.js`,'utf8')).replaceAll('</script','<\\/script');
const css=await readFile(`${out}/leaf.css`,'utf8');
const hash=value=>`'sha256-${createHash('sha256').update(value).digest('base64')}'`;
// Same artifact for the host and authenticated loopback page; browser mode is
// selected only by its actual /reader route. No credential enters an iframe.
const csp=`default-src 'none'; script-src ${hash(js)}; style-src ${hash(css)}; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'`;
const index=await readFile('src/mcp-panel/index.html','utf8');
const html=index.replace('<title>',()=>`<meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css}</style><title>`).replace('<script type="module" src="./app.js"></script>',()=>`<script>${js}</script>`);
await mkdir('dist',{recursive:true});await writeFile('dist/mcp-reader.html',html);
console.log('Built self-contained Leaf MCP reader with hashed script/style CSP');
