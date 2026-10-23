import { initializeLanguage, t } from './i18n.js';
async function start() {
  await initializeLanguage();
  if (new URLSearchParams(location.search).has('updateWindow')) await import('./update-window.js');
  else if (new URLSearchParams(location.search).has('export')) await import('./pdf-export.js');
  else await import('./main.js');
}
void start().catch(error => {
  console.error('Leaf initialization failed', error);
  document.querySelector('#app').textContent = t('main.desktop_app_initialization_failed', {error});
});
