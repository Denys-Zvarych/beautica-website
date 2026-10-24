// Runs BEFORE the card is painted (a tiny blocking script, same origin): marks Android so the «Відкрити в застосунку» button is laid out from the
// first paint. Showing it from the deferred module script instead moved the content below it after paint (CLS 0.02 on a slow CPU).
if (/Android/i.test(navigator.userAgent)) document.documentElement.classList.add("android");
