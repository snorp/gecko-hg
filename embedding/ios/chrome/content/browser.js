var Cu = Components.utils;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

let browser = document.getElementById("browser");
browser.focus();
window.focus();

Services.obs.notifyObservers(browser.docShell, "Window:Ready", "");
