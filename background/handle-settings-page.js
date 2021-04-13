import runPersistentScripts from "./imports/run-persistent-scripts.js";

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  // Message used to load popups as well
  if (request === "getSettingsInfo") {
    const sendRes = () =>
      sendResponse({
        manifests: scratchAddons.manifests,
        // Firefox breaks if we send proxies
        addonsEnabled: scratchAddons.localState._target.addonsEnabled,
        addonSettings: scratchAddons.globalState._target.addonSettings,
      });
    // Data might have not loaded yet, or be partial.
    // Only respond when all data is ready
    if (scratchAddons.localState.allReady) {
      sendRes();
    } else {
      scratchAddons.localEvents.addEventListener("ready", sendRes);
      return true;
    }
  } else if (request.changeEnabledState) {
    const { addonId, newState } = request.changeEnabledState;
    scratchAddons.localState.addonsEnabled[addonId] = newState;
    chrome.storage.sync.set({
      addonsEnabled: scratchAddons.localState.addonsEnabled,
    });

    // Fire disabled event for userscripts
    // TODO: this might not be an addon being reenabled. We should consider this
    // in case we want to provide userscripts with a way to run after the page
    // has loaded, dynamically.
    chrome.tabs.query({}, (tabs) =>
      tabs.forEach(
        (tab) =>
          (tab.url || (!tab.url && typeof browser !== "undefined")) &&
          chrome.tabs.sendMessage(tab.id, {
            fireEvent: {
              target: "self",
              name: newState ? "reenabled" : "disabled",
              addonId,
            },
          })
      )
    );

    if (newState === false) {
      // TODO: can there be many addon objects for the same addon?
      const addonObjs = scratchAddons.addonObjects.filter((addonObj) => addonObj.self.id === addonId);
      if (addonObjs)
        addonObjs.forEach((addonObj) => {
          addonObj.self.dispatchEvent(new CustomEvent("disabled"));
          addonObj._kill();
        });
      scratchAddons.localEvents.dispatchEvent(new CustomEvent("badgeUpdateNeeded"));
    } else {
      runPersistentScripts(addonId);
    }

    if (scratchAddons.manifests.find((obj) => obj.addonId === addonId).manifest.tags.includes("theme"))
      scratchAddons.localEvents.dispatchEvent(new CustomEvent("themesUpdated"));
  } else if (request.changeAddonSettings) {
    const { addonId, newSettings } = request.changeAddonSettings;
    scratchAddons.globalState.addonSettings[addonId] = newSettings;
    chrome.storage.sync.set({
      addonSettings: scratchAddons.globalState.addonSettings,
    });

    if (scratchAddons.manifests.find((obj) => obj.addonId === addonId).manifest.tags.includes("theme"))
      scratchAddons.localEvents.dispatchEvent(new CustomEvent("themesUpdated"));
  }
});
