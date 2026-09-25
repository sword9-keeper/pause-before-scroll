chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1, priority: 1,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: `${chrome.runtime.getURL("old-blocked.html")}#\\0` }
    },
    condition: { regexFilter: "^https?://www\\.douyin\\.com/.*", resourceTypes: ["main_frame"] }
  }]
}).then(() => { globalThis.legacyReady = true; });
