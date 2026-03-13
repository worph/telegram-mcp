// State
let currentConfig = null;
let botRunning = false;
let mcpEditVisible = false;

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
const mcpTestActions = document.getElementById('mcp-test-actions');
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
  botRunning = status.bot.running;

  if (botRunning) {
    // Bot is running - show running state
    telegramSetup.classList.add('hidden');
    telegramRunning.classList.remove('hidden');
    telegramStatus.className = 'status-badge success';
    telegramStatusText.textContent = 'Connected';
    botUsername.textContent = '@' + (status.bot.botUsername || 'bot');
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
    document.getElementById('mode').value = currentConfig.telegram.mode || 'polling';

    // Populate MCP form
    document.getElementById('transport').value = currentConfig.target.transport;
    document.getElementById('targetUrl').value = currentConfig.target.url;
    document.getElementById('tool').value = currentConfig.target.tool;
    document.getElementById('params').value = JSON.stringify(currentConfig.target.params, null, 2);

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
        transport: 'sse',
        url: 'http://localhost:8080/mcp/sse',
        tool: 'echo',
        params: {
          message: '{{text}}',
          chatId: '{{chatId}}',
          username: '{{username}}',
        },
      },
      server: { port: 8080 },
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
    const config = {
      telegram: {
        botToken: document.getElementById('botTokenEdit').value,
        mode: document.getElementById('mode').value,
      },
      target: currentConfig.target,
      server: { port: 8080 },
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

    const config = {
      telegram: currentConfig.telegram,
      target: {
        transport: document.getElementById('transport').value,
        url: document.getElementById('targetUrl').value,
        tool: document.getElementById('tool').value,
        params: params,
      },
      server: { port: 8080 },
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
    mcpTestActions.classList.remove('hidden');
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
    mcpTestActions.classList.add('hidden');
    editBtnText.textContent = 'Cancel Editing';
  } else {
    mcpEditForm.classList.add('hidden');
    mcpTestActions.classList.remove('hidden');
    editBtnText.textContent = 'Edit Configuration';
  }
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

// Test echo
async function testEcho() {
  if (!botRunning) {
    showToast('Connect your Telegram bot first', 'error');
    return;
  }
  showToast('Send a message to your bot on Telegram to test the echo!');
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  updateStatus();

  // Poll status every 3 seconds
  setInterval(updateStatus, 3000);
});
