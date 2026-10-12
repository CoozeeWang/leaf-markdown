// This only compiles a no-op synthetic EXE; it never executes the installer hooks.
import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
mkdirSync(new URL('../test-results/',import.meta.url), {recursive:true});
const env={...process.env};
if(process.platform==='darwin')env.LANG=env.LC_ALL=env.LC_CTYPE='en_US.UTF-8';
const result=spawnSync(process.argv[2]||'makensis',['-V3',fileURLToPath(new URL('./windows-i18n-hooks.nsi',import.meta.url))],{env,stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
