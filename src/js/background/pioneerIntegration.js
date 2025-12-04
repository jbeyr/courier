const PIONEER_WS_URL = "ws://127.0.0.1:45000/ws";
const PIONEER_HEADER_NAME = "Pioneer-Correlation-Id";
let ws = null;
let reconnectInterval = 1000;
let globalCorrelationIdCounter = 0;
let isCounterInitialized = false;

// Initialize counter from storage
browser.storage.local.get("pioneerCorrelationId").then(res => {
  if (res.pioneerCorrelationId) {
    globalCorrelationIdCounter = res.pioneerCorrelationId;
  }
  isCounterInitialized = true;
}).catch(e => {
  console.error("Failed to initialize correlation ID:", e);
  isCounterInitialized = true;
});

function connect() {
  ws = new WebSocket(PIONEER_WS_URL);

  ws.onopen = () => {
    console.log("Connected to Pioneer");
    reconnectInterval = 1000;
  };

  ws.onclose = () => {
    console.log("Disconnected from Pioneer. Reconnecting...");
    setTimeout(connect, reconnectInterval);
    reconnectInterval = Math.min(reconnectInterval * 2, 30000);
  };

  ws.onerror = (error) => {
    console.error("Pioneer WebSocket error:", error);
    // ws.close() will trigger onclose
  };
}

connect();

async function handleRequest(details) {
  // Wait for counter initialization if needed
  if (!isCounterInitialized) {
    await new Promise(resolve => {
      const check = () => {
        if (isCounterInitialized) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
  }

  // Ignore requests from the default container (no container) or private browsing
  if (!details.cookieStoreId || details.cookieStoreId === "firefox-default" || details.cookieStoreId === "firefox-private") {
    return;
  }

  const headers = details.requestHeaders;
  if (!headers) return;

  let correlationHeader = headers.find(h => h.name.toLowerCase() === PIONEER_HEADER_NAME.toLowerCase());
  let correlationId;

  if (correlationHeader) {
    correlationId = correlationHeader.value;
  } else {
    // Generate ID using counter as per spec
    correlationId = (++globalCorrelationIdCounter).toString();
    headers.push({ name: PIONEER_HEADER_NAME, value: correlationId });
    // Persist the new counter value
    browser.storage.local.set({ pioneerCorrelationId: globalCorrelationIdCounter });
  }

  let containerName = "Default";
  let role = "default";

  if (details.cookieStoreId && details.cookieStoreId !== "firefox-default") {
    try {
      const identity = await browser.contextualIdentities.get(details.cookieStoreId);
      if (identity) {
        containerName = identity.name;
        
        const rolesStorage = await browser.storage.local.get("containerRoles");
        const roles = rolesStorage.containerRoles || {};
        if (roles[details.cookieStoreId]) {
          role = roles[details.cookieStoreId];
        } else {
          role = "";
        }

        if (!role) {
          browser.notifications.create({
            "type": "basic",
            "iconUrl": browser.runtime.getURL("img/multiaccountcontainer-48.svg"),
            "title": "Pioneer Integration Error",
            "message": `Container '${containerName}' missing role! Configure in settings.`
          });
          // Return headers so request proceeds, but don't send event to Pioneer
          return { requestHeaders: headers };
        }
      }
    } catch (e) {
      console.error("Error getting container identity:", e);
    }
  }

    const payload = {
      source: "courier",
      type: "context_event",
      data: {
        correlation_id: parseInt(correlationId, 10),
        role: role,
        container: containerName
      }
    };  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }

  return { requestHeaders: headers };
}

browser.webRequest.onBeforeSendHeaders.addListener(
  handleRequest,
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);
