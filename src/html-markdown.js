import { markdownLink, safeTarget } from './resources.js';
const escape = text => text.replace(/([\\`*_\[\]])/g, '\\$1');
export function htmlToMarkdown(html) {
  const blocks = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  function children(node) { return [...node.childNodes].map(visit).join(''); }
  function visit(node) {
    if (node.nodeType === 3) return escape(node.textContent.replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script','style','iframe','object','embed','template','svg','form','input','button','noscript'].includes(tag) || node.hidden) return '';
    if (tag === 'br') return '\n';
    if (tag === 'pre') {
      const code = node.textContent.replace(/\n$/, '');
      const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(m => m[0].length + 1)));
      const index = blocks.push(`${fence}\n${code}\n${fence}`) - 1;
      return `\n\n\u0000BLOCK${index}\u0000\n\n`;
    }
    if (tag === 'code') { const code=node.textContent; const fence='`'.repeat(Math.max(1,...[...code.matchAll(/`+/g)].map(m=>m[0].length+1))); return `${fence} ${code} ${fence}`; }
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].filter(row => row.closest('table') === node).map(row => [...row.children].filter(c=>/^(TD|TH)$/.test(c.tagName)).map(c=>children(c).trim().replace(/\n+/g,'<br>').replace(/\|/g,'\\|')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(r=>r.length));
      const line = row => '| ' + Array.from({length:width},(_,i)=>row[i]||'').join(' | ') + ' |';
      return '\n\n' + [line(rows[0]),line(Array(width).fill('---')),...rows.slice(1).map(line)].join('\n') + '\n\n';
    }
    if (tag === 'ul' || tag === 'ol') {
      const start = Number(node.getAttribute('start')) || 1;
      return '\n' + [...node.children].filter(n=>n.tagName==='LI').map((li,i)=>{
        const marker=tag==='ul'?'- ':`${start+i}. `;
        return marker + children(li).trim().split('\n').map((line,j)=>j?' '.repeat(marker.length)+line:line).join('\n');
      }).join('\n') + '\n';
    }
    const text = children(node);
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${text.trim()}\n\n`;
    if (tag === 'strong' || tag === 'b') return `**${text.trim()}**`;
    if (tag === 'em' || tag === 'i') return `*${text.trim()}*`;
    if (tag === 'del' || tag === 's') return `~~${text.trim()}~~`;
    if (tag === 'a') { const url=safeTarget(node.getAttribute('href')); return url ? markdownLink(node.textContent,url) : text; }
    if (tag === 'img') return escape(node.getAttribute('alt') || '');
    if (tag === 'blockquote') return '\n\n' + text.trim().split('\n').map(l=>'> '+l).join('\n') + '\n\n';
    if (tag === 'hr') return '\n\n---\n\n';
    if (['p','div','section','article'].includes(tag)) return `\n\n${text.trim()}\n\n`;
    return text;
  }
  return children(doc.body).replace(/\n{3,}/g,'\n\n').trim().replace(/\u0000BLOCK(\d+)\u0000/g, (_,i)=>blocks[Number(i)]);
}
