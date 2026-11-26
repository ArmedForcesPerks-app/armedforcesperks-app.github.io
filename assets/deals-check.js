// Safety net for the Deals page. If the deal script can't run at all (a very old browser,
// or it failed to download), show a clear message instead of "Loading deals..." forever.
(function () {
  setTimeout(function () {
    if (window.afpDealsStarted) return;
    var err = document.getElementById('load-error');
    var count = document.getElementById('count');
    if (err) err.hidden = false;
    if (count) count.textContent = '';
  }, 12000);
})();
