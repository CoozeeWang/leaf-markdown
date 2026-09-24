if (new URLSearchParams(location.search).has('export')) import('./pdf-export.js');
else import('./main.js');
