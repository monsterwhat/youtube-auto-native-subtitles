(function () {
  'use strict';

  browser.action.onClicked.addListener(function () {
    try {
      var opened = browser.runtime.openOptionsPage();
      if (opened && typeof opened.catch === 'function') {
        opened.catch(function (err) {
          console.error('[AutoNativeSubs] could not open options page', err);
        });
      }
    } catch (err) {
      console.error('[AutoNativeSubs] could not open options page', err);
    }
  });
})();
