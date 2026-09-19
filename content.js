// content.js — runs in the extension isolated world at document_start.
// Its only job: inject injected.js into the page world, because only the
// page world can read YouTube's player data and call the player API.
(function () {
  'use strict';

  var SCRIPT_ID = 'auto-native-subtitles-page-script';
  var TAG = '[AutoNativeSubs]';

  function inject() {
    try {
      if (document.getElementById(SCRIPT_ID)) {
        return;
      }
      var script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = browser.runtime.getURL('injected.js');
      script.addEventListener('load', function () {
        console.info(TAG + ' page script loaded');
        pushConfig();
      });
      script.addEventListener('error', function (event) {
        console.error(TAG + ' failed to load page script', event);
      });
      (document.documentElement || document.head || document.body).appendChild(script);
    } catch (err) {
      console.error(TAG + ' injection failed', err);
    }
  }

  function pushConfig() {
    try {
      browser.storage.local.get(ANNS_DEFAULTS).then(function (stored) {
        window.postMessage({ type: 'ANNS_CONFIG', config: stored }, '*');
      }, function (err) {
        console.warn(TAG + ' could not load settings', err);
      });
    } catch (err) {
      console.warn(TAG + ' settings unavailable', err);
    }
  }

  try {
    browser.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') {
        return;
      }
      pushConfig();
    });
  } catch (err) {
    console.warn(TAG + ' could not watch settings changes', err);
  }

  inject();
})();
