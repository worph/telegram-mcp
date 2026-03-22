// State
let currentConfig = null;
let currentStatus = null;
let botRunning = false;
let mcpEditVisible = false;
let csrfToken = null;

// DOM elements
const telegramSetup = document.getElementById('telegram-setup');
const telegramRunning = document.getElementById('telegram-running');
const telegramStatus = document.getElementById('telegram-status');
const telegramStatusText = document.getElementById('telegram-status-text');
const mcpStatus = document.getElementById('mcp-status');
const mcpStatusText = document.getElementById('mcp-status-text');
const mcpSetup = document.getElementById('mcp-setup');
const mcpConfig = document.getElementById('mcp-config');
const mcpEditForm = document.getElementById('mcp-edit-form');
const botUsername = document.getElementById('bot-username');
const flowToolName = document.getElementById('flow-tool-name');
const mcpToolDisplay = document.getElementById('mcp-tool-display');
const mcpUrlDisplay = document.getElementById('mcp-url-display');
const editBtnText = document.getElementById('edit-btn-text');

// Toast notification
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// Update UI based on bot status
function updateUI(status) {
  currentStatus = status;
  botRunning = status.bot.running;

  if (botRunning) {
    // Bot is running - show running state
    telegramSetup.classList.add('hidden');
    telegramRunning.classList.remove('hidden');
    telegramStatus.className = 'status-badge success';
    telegramStatusText.textContent = 'Connected';
    botUsername.textContent = '@' + (status.bot.botUsername || 'bot');
    const chatIdEl = document.getElementById('bot-chat-id');
    const chatId = status.bot.defaultChatId || status.bot.lastChatId;
    if (chatId) {
      chatIdEl.textContent = 'Chat ID: ' + chatId;
    } else {
      chatIdEl.textContent = 'Chat ID: send a message to the bot to auto-detect';
    }
  } else {
    // Bot not running - show setup wizard
    telegramSetup.classList.remove('hidden');
    telegramRunning.classList.add('hidden');
    telegramStatus.className = 'status-badge error';
    telegramStatusText.textContent = 'Not connected';
  }

  // Always show MCP config (hide setup prompt)
  mcpSetup.classList.add('hidden');
  mcpConfig.classList.remove('hidden');

  // Update MCP status
  if (status.mcpClient.connected) {
    mcpStatus.className = 'status-badge success';
    mcpStatusText.textContent = 'Connected';
  } else {
    mcpStatus.className = 'status-badge warning';
    mcpStatusText.textContent = 'Disconnected';
  }

  updateSendMcpInfoButton();
}

// Load config from server
async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('Failed to load config');

    currentConfig = await response.json();

    // Populate setup form
    document.getElementById('botToken').value = currentConfig.telegram.botToken;

    // Populate running form
    document.getElementById('botTokenEdit').value = currentConfig.telegram.botToken;
    document.getElementById('defaultChatId').value = currentConfig.telegram.chatId || '';
    document.getElementById('mode').value = currentConfig.telegram.mode || 'polling';
    // Auto-fill webhook URL from PUBLIC_URL env if not already set
    let webhookUrlValue = currentConfig.telegram.webhookUrl || '';
    if (!webhookUrlValue) {
      try {
        const pubRes = await fetch('/api/public-url');
        if (pubRes.ok) {
          const { webhookUrl: envWebhookUrl } = await pubRes.json();
          if (envWebhookUrl) webhookUrlValue = envWebhookUrl;
        }
      } catch (e) { /* ignore */ }
    }
    document.getElementById('webhookUrl').value = webhookUrlValue;
    toggleWebhookUrl();

    // Populate MCP form
    document.getElementById('transport').value = currentConfig.target.transport;
    document.getElementById('targetUrl').value = currentConfig.target.url;
    document.getElementById('authToken').value = currentConfig.target.authToken || '';
    document.getElementById('tool').value = currentConfig.target.tool;
    document.getElementById('params').value = JSON.stringify(currentConfig.target.params, null, 2);
    document.getElementById('preset').value = detectPreset(currentConfig.target);

    // Update MCP display
    updateMCPDisplay();

  } catch (error) {
    showToast('Failed to load config: ' + error.message, 'error');
  }
}

// Fetch and update status
async function updateStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Failed to fetch status');

    const status = await response.json();
    updateUI(status);
  } catch (error) {
    console.error('Status update failed:', error);
  }
}

// Connect bot (from setup wizard)
async function connectBot() {
  const token = document.getElementById('botToken').value.trim();

  if (!token) {
    showToast('Please enter a bot token', 'error');
    return;
  }

  try {
    // Save config with new token
    const config = {
      telegram: {
        botToken: token,
        mode: 'polling',
      },
      target: currentConfig?.target || {
        transport: 'http',
        url: 'http://localhost:9634/mcp',
        tool: 'echo',
        params: {
          message: '{{text}}',
          chatId: '{{chatId}}',
          username: '{{username}}',
        },
      },
      server: { port: 9634 },
    };

    const saveResponse = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    if (!saveResponse.ok) {
      const result = await saveResponse.json();
      throw new Error(result.error || 'Failed to save');
    }

    // Restart bot
    const restartResponse = await fetch('/api/restart', { method: 'POST' });
    if (!restartResponse.ok) {
      const result = await restartResponse.json();
      throw new Error(result.error || 'Failed to restart');
    }

    showToast('Bot connected successfully!');
    await loadConfig();
    await updateStatus();

  } catch (error) {
    showToast('Failed to connect: ' + error.message, 'error');
  }
}

// Save Telegram settings
async function saveTelegram() {
  try {
    const mode = document.getElementById('mode').value;
    const chatId = document.getElementById('defaultChatId').value.trim();
    const telegram = {
      botToken: document.getElementById('botTokenEdit').value,
      mode: mode,
    };
    if (chatId) {
      telegram.chatId = chatId;
    }
    if (mode === 'webhook') {
      telegram.webhookUrl = document.getElementById('webhookUrl').value.trim();
    }
    const config = {
      telegram: telegram,
      target: currentConfig.target,
      server: { port: 9634 },
    };

    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to save');
    }

    showToast('Telegram settings saved');
    await loadConfig();

  } catch (error) {
    showToast('Failed to save: ' + error.message, 'error');
  }
}

// Save MCP settings
async function saveMCP() {
  try {
    let params;
    try {
      params = JSON.parse(document.getElementById('params').value);
    } catch (e) {
      showToast('Invalid JSON in Parameters field', 'error');
      return;
    }

    const authToken = document.getElementById('authToken').value.trim();
    const target = {
      transport: document.getElementById('transport').value,
      url: document.getElementById('targetUrl').value,
      tool: document.getElementById('tool').value,
      params: params,
    };
    if (authToken) {
      target.authToken = authToken;
    }

    const config = {
      telegram: currentConfig.telegram,
      target: target,
      server: { port: 9634 },
    };

    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to save');
    }

    showToast('MCP settings saved');

    // Close edit form
    mcpEditVisible = false;
    mcpEditForm.classList.add('hidden');
    editBtnText.textContent = 'Edit Configuration';

    await loadConfig();

    // Restart to apply MCP changes
    await fetch('/api/restart', { method: 'POST' });
    await updateStatus();

  } catch (error) {
    showToast('Failed to save: ' + error.message, 'error');
  }
}

// Restart bot
async function restartBot() {
  try {
    const response = await fetch('/api/restart', { method: 'POST' });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to restart');
    }

    showToast('Bot restarted');
    await updateStatus();

  } catch (error) {
    showToast('Failed to restart: ' + error.message, 'error');
  }
}

// Toggle MCP edit form
function toggleMCPEdit() {
  mcpEditVisible = !mcpEditVisible;

  if (mcpEditVisible) {
    mcpEditForm.classList.remove('hidden');
    editBtnText.textContent = 'Cancel Editing';
  } else {
    mcpEditForm.classList.add('hidden');
    editBtnText.textContent = 'Edit Configuration';
  }
}

// Preset configurations
const PRESETS = {
  echo: {
    transport: 'http',
    url: 'http://localhost:9634/mcp',
    authToken: '',
    tool: 'echo',
    params: {
      message: '{{text}}',
      chatId: '{{chatId}}',
      username: '{{username}}',
    },
  },
  query_claude: {
    transport: 'http',
    url: 'http://claude:9090/mcp',
    authToken: '',
    tool: 'query_claude',
    params: {
      prompt: '{{text}}',
      chatId: '{{chatId}}',
      permissionCallbackUrl: '{{permissionCallbackUrl}}',
    },
  },
};

// Apply a preset to the form
function applyPreset() {
  const presetName = document.getElementById('preset').value;
  if (!presetName || !PRESETS[presetName]) return;

  const preset = PRESETS[presetName];
  document.getElementById('transport').value = preset.transport;
  document.getElementById('targetUrl').value = preset.url;
  document.getElementById('authToken').value = preset.authToken;
  document.getElementById('tool').value = preset.tool;
  document.getElementById('params').value = JSON.stringify(preset.params, null, 2);
}

// Detect which preset matches current config
function detectPreset(target) {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (target.tool === preset.tool && target.transport === preset.transport) {
      return name;
    }
  }
  return '';
}

// Update MCP display
function updateMCPDisplay() {
  if (currentConfig) {
    const toolName = currentConfig.target.tool || 'echo';
    const url = currentConfig.target.url || '';

    flowToolName.textContent = toolName;
    mcpToolDisplay.textContent = toolName;
    mcpUrlDisplay.textContent = url;
    mcpUrlDisplay.title = url; // Full URL on hover
  }
}

// Toggle webhook URL field visibility
function toggleWebhookUrl() {
  const mode = document.getElementById('mode').value;
  const group = document.getElementById('webhookUrlGroup');
  if (mode === 'webhook') {
    group.classList.remove('hidden');
  } else {
    group.classList.add('hidden');
  }
}

// Generic card toggle — header passes itself and the body id
function toggleCard(bodyId, header) {
  document.getElementById(bodyId).classList.toggle('hidden');
  header.classList.toggle('collapsed');
}

// Toggle about card (kept for backward compat with inline onclick)
function toggleAbout() {
  const content = document.getElementById('about-content');
  const header = document.querySelector('#about-card .card-header');
  content.classList.toggle('hidden');
  header.classList.toggle('collapsed');
}

// Send MCP server info through the configured MCP target
async function sendMcpInfo() {
  const btn = document.getElementById('send-mcp-info-btn');
  const responseBox = document.getElementById('mcp-target-response');
  const responseText = document.getElementById('mcp-target-response-text');

  btn.disabled = true;
  btn.textContent = 'Sending…';
  responseBox.classList.add('hidden');

  try {
    const response = await fetch('/api/send-mcp-info', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to send');

    if (result.response) {
      responseText.textContent = result.response;
      responseBox.classList.remove('hidden');
    } else {
      showToast('Sent — no response from target');
    }
  } catch (error) {
    showToast('Failed to send: ' + error.message, 'error');
  } finally {
    btn.textContent = 'Send Config via MCP Target';
    updateSendMcpInfoButton();
  }
}

// Update the send button state based on MCP connection and last chat
function updateSendMcpInfoButton() {
  const btn = document.getElementById('send-mcp-info-btn');
  const hint = document.getElementById('send-mcp-info-hint');
  if (!btn) return;

  const mcpConnected = currentStatus?.mcpClient?.connected;

  if (!mcpConnected) {
    btn.disabled = true;
    hint.textContent = 'MCP target not connected — configure and connect it above first.';
  } else {
    btn.disabled = false;
    hint.textContent = '';
  }
}

// Load MCP server info
async function loadMcpServerInfo() {
  try {
    const response = await fetch('/api/mcp-server-info');
    if (!response.ok) return;
    const info = await response.json();

    document.getElementById('mcp-http-url').textContent = info.httpUrl;
    document.getElementById('mcp-claude-config').textContent = JSON.stringify(info.claudeConfig, null, 2);
  } catch (e) {
    console.error('Failed to load MCP server info:', e);
  }
}

// Copy text from an element by id
function copyText(elementId, btn) {
  const text = document.getElementById(elementId).textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  });
}

// Copy a code block
function copyBlock(elementId, btn) {
  const text = document.getElementById(elementId).textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  });
}

// Escape HTML for safe display
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Connect to the SSE permission stream
function connectPermissionStream() {
  const es = new EventSource('/api/permission/stream');

  es.addEventListener('csrf', (e) => {
    const data = JSON.parse(e.data);
    csrfToken = data.token;
    console.log('Permission stream connected');
  });

  es.addEventListener('permission', (e) => {
    const req = JSON.parse(e.data);
    showPermissionDialog(req);
  });

  es.addEventListener('ping', () => {
    // keep-alive, nothing to do
  });

  es.onerror = () => {
    csrfToken = null;
    // EventSource auto-reconnects; reset token on next csrf event
  };
}

// Show modal permission dialog
function showPermissionDialog(req) {
  // Remove any existing overlay
  const existing = document.getElementById('permission-overlay');
  if (existing) existing.remove();

  const inputStr = JSON.stringify(req.toolInput, null, 2);
  const timeoutSec = req.timeout || 60;

  const overlay = document.createElement('div');
  overlay.id = 'permission-overlay';
  overlay.innerHTML = `
    <div class="permission-dialog">
      <div class="permission-title">Permission Required</div>
      <div class="permission-tool">Tool: <code>${escapeHtml(req.toolName)}</code></div>
      ${req.description ? `<div class="permission-desc">${escapeHtml(req.description)}</div>` : ''}
      <div class="permission-label">Input:</div>
      <pre class="permission-input">${escapeHtml(inputStr)}</pre>
      <div class="permission-timer" id="perm-timer">Expires in ${timeoutSec}s</div>
      <div class="permission-actions">
        <button class="btn-primary" onclick="resolveWebPermission('${escapeHtml(req.queryId)}', 'allow')">Allow</button>
        <button class="btn-secondary" onclick="resolveWebPermission('${escapeHtml(req.queryId)}', 'deny')">Deny</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Countdown timer
  let remaining = timeoutSec;
  const timerEl = document.getElementById('perm-timer');
  const timerId = setInterval(() => {
    remaining--;
    if (timerEl) timerEl.textContent = `Expires in ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(timerId);
      overlay.remove();
    }
  }, 1000);
  overlay._timerId = timerId;
}

// Resolve a web permission prompt
async function resolveWebPermission(queryId, decision) {
  const overlay = document.getElementById('permission-overlay');
  if (overlay) {
    clearInterval(overlay._timerId);
    overlay.remove();
  }

  try {
    const response = await fetch('/api/permission/web/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryId, decision, csrfToken }),
    });
    if (!response.ok) {
      const result = await response.json();
      console.error('Failed to resolve permission:', result.error);
    }
  } catch (err) {
    console.error('Failed to resolve permission:', err);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  updateStatus();
  loadMcpServerInfo();
  connectPermissionStream();

  // Poll status every 3 seconds
  setInterval(updateStatus, 3000);
});
