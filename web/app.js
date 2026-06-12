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
    document.getElementById('promptTemplate').value = currentConfig.target.promptTemplate || '';
    refreshPromptWrapperFromParams();

    // Populate access control
    renderAccessControl();

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
        accessMode: currentConfig?.telegram?.accessMode || 'private',
        allowedUsers: currentConfig?.telegram?.allowedUsers || [],
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
      accessMode: currentConfig.telegram.accessMode || 'private',
      allowedUsers: currentConfig.telegram.allowedUsers || [],
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

// --- Access control (public/private + allowed users) ---

function renderAccessControl() {
  const mode = currentConfig?.telegram?.accessMode || 'private';
  const users = currentConfig?.telegram?.allowedUsers || [];

  document.getElementById('access-public-btn').classList.toggle('active', mode === 'public');
  document.getElementById('access-private-btn').classList.toggle('active', mode === 'private');

  const hint = document.getElementById('access-hint');
  const section = document.getElementById('allowed-users-section');

  if (mode === 'public') {
    hint.textContent = 'Anyone who finds the bot can message it and trigger the MCP target.';
    section.classList.add('hidden');
    return;
  }

  hint.textContent = 'Only the users below can use the bot (direct or group chats). Others get a reply with their user ID.';
  section.classList.remove('hidden');

  const chips = document.getElementById('user-chips');
  chips.innerHTML = '';
  if (users.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'user-chips-empty';
    empty.textContent = '⚠ No users allowed yet — nobody can use the bot. Message the bot to get your user ID, then add it here.';
    chips.appendChild(empty);
  }
  users.forEach((entry) => {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    const label = document.createElement('span');
    label.textContent = /^\d+$/.test(entry) ? entry : (entry.startsWith('@') ? entry : '@' + entry);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.onclick = () => removeAllowedUser(entry);
    chip.appendChild(label);
    chip.appendChild(remove);
    chips.appendChild(chip);
  });
}

async function setAccessMode(mode) {
  if ((currentConfig?.telegram?.accessMode || 'private') === mode) return;
  currentConfig.telegram.accessMode = mode;
  await saveAccessConfig(mode === 'public' ? 'Bot is now public' : 'Bot is now private');
}

async function addAllowedUser() {
  const input = document.getElementById('allowed-user-input');
  const value = input.value.trim();
  if (!value) return;
  if (!/^(@?[A-Za-z][A-Za-z0-9_]{0,31}|\d+)$/.test(value)) {
    showToast('Enter a numeric user ID or a @username', 'error');
    return;
  }
  const users = currentConfig.telegram.allowedUsers || [];
  const normalized = value.replace(/^@/, '').toLowerCase();
  if (users.some(u => u.replace(/^@/, '').toLowerCase() === normalized)) {
    showToast('Already in the list', 'error');
    return;
  }
  currentConfig.telegram.allowedUsers = [...users, value];
  input.value = '';
  await saveAccessConfig('User added');
}

async function removeAllowedUser(entry) {
  currentConfig.telegram.allowedUsers =
    (currentConfig.telegram.allowedUsers || []).filter(u => u !== entry);
  await saveAccessConfig('User removed');
}

async function saveAccessConfig(message) {
  renderAccessControl();
  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram: currentConfig.telegram,
        target: currentConfig.target,
        server: currentConfig.server || { port: 9634 },
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Failed to save');
    showToast(message);
  } catch (error) {
    showToast('Failed to save: ' + error.message, 'error');
    await loadConfig(); // re-sync UI with what the server actually has
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
    // Persist the prompt template (referenced as {{template}} in params) when in use
    const promptTemplate = document.getElementById('promptTemplate').value;
    if (JSON.stringify(params).includes('{{template}}') && promptTemplate.trim()) {
      target.promptTemplate = promptTemplate;
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
};

// Apply a preset to the form
function applyPreset() {
  const presetName = document.getElementById('preset').value;
  const beaconPanel = document.getElementById('beacon-panel');

  if (presetName === 'beacon') {
    beaconPanel.classList.remove('hidden');
    runBeaconDiscovery();
    return;
  } else {
    beaconPanel.classList.add('hidden');
  }

  if (!presetName || !PRESETS[presetName]) {
    // Custom: keep current fields, just re-evaluate the prompt-template editor
    refreshPromptWrapperFromParams();
    return;
  }

  const preset = PRESETS[presetName];
  document.getElementById('transport').value = preset.transport;
  document.getElementById('targetUrl').value = preset.url;
  document.getElementById('authToken').value = preset.authToken;
  document.getElementById('tool').value = preset.tool;
  document.getElementById('params').value = JSON.stringify(preset.params, null, 2);
  refreshPromptWrapperFromParams();
}

// Template variable mapping for auto-generating params from tool schemas
const TEMPLATE_MAP = {
  text: '{{text}}',
  message: '{{text}}',
  prompt: '{{text}}',
  query: '{{text}}',
  input: '{{text}}',
  content: '{{text}}',
  chatId: '{{chatId}}',
  chat_id: '{{chatId}}',
  userId: '{{userId}}',
  user_id: '{{userId}}',
  username: '{{username}}',
  user_name: '{{username}}',
  firstName: '{{firstName}}',
  first_name: '{{firstName}}',
  lastName: '{{lastName}}',
  last_name: '{{lastName}}',
  messageId: '{{messageId}}',
  message_id: '{{messageId}}',
  permissionCallbackUrl: '{{permissionCallbackUrl}}',
  callback_url: '{{permissionCallbackUrl}}',
};

// Generate params object from a tool's inputSchema using template variables
function generateParamsFromSchema(inputSchema) {
  if (!inputSchema || !inputSchema.properties) return {};

  const params = {};
  const required = new Set(inputSchema.required || []);

  for (const [key] of Object.entries(inputSchema.properties)) {
    if (TEMPLATE_MAP[key]) {
      params[key] = TEMPLATE_MAP[key];
    } else if (required.has(key)) {
      params[key] = '';
    }
  }

  return params;
}

// ── Claude / LLM Detection (ported from chronos-mcp) ─────────────────────────
const CLAUDE_TOOL_PATTERNS = [
  /^(query_?claude|ask_?claude|claude_?query|prompt_?claude)$/i,
  /^(llm_?prompt|llm_?query|send_?prompt|run_?prompt)$/i,
  /^(ask_?llm|query_?llm|chat|complete|generate)$/i,
  /claude/i,
];

const CLAUDE_DESCRIPTION_KEYWORDS = [
  'claude', 'llm', 'language model', 'anthropic',
  'send a prompt', 'query claude', 'natural language',
  'ai prompt', 'ask claude', 'claude code agent',
];

// Scan discovered servers for a Claude/LLM tool. Returns indices so the panel
// can auto-select it, or null if none looks like an LLM destination.
function detectClaudeTool(servers) {
  for (let si = 0; si < servers.length; si++) {
    const tools = servers[si].tools || [];
    for (let ti = 0; ti < tools.length; ti++) {
      const tool = tools[ti];
      const nameMatch = CLAUDE_TOOL_PATTERNS.some(p => p.test(tool.name));
      const descMatch = CLAUDE_DESCRIPTION_KEYWORDS.some(kw =>
        (tool.description || '').toLowerCase().includes(kw)
      );
      if (nameMatch || descMatch) {
        return { serverIndex: si, toolIndex: ti, server: servers[si], tool };
      }
    }
  }
  return null;
}

// Param names that typically carry the user's message / prompt text.
const PROMPT_PARAM_NAMES = ['prompt', 'message', 'query', 'text', 'input', 'content', 'question'];

// Find the prompt-carrying param in a tool's inputSchema (or among existing param keys).
function findPromptParam(inputSchema) {
  if (!inputSchema || !inputSchema.properties) return null;
  for (const name of PROMPT_PARAM_NAMES) {
    const p = inputSchema.properties[name];
    if (p && p.type === 'string') return name;
  }
  const required = inputSchema.required || [];
  const strings = Object.entries(inputSchema.properties).filter(([, v]) => v.type === 'string');
  if (strings.length === 1) return strings[0][0];
  const reqStrings = strings.filter(([k]) => required.includes(k));
  if (reqStrings.length === 1) return reqStrings[0][0];
  return null;
}

// Default prompt template applied when an LLM (e.g. Claude) is auto-selected.
// Instructs the model how to pull more conversation context on demand. Stored
// once in config.target.promptTemplate; referenced from params as {{template}}.
const DEFAULT_CLAUDE_PROMPT = `You are responding to a message from a Telegram user ({{firstName}}).

If you need more context about the conversation, call the get_chat_history tool with chatId "{{chatId}}" to retrieve recent messages. Only messages the bot has already seen are available — there is no older backfill.

Reply directly and concisely.

Message:
{{text}}`;

// The prompt template lives in its own field ({{template}} expands to it at send
// time), so the text is stored once — not duplicated inside the params JSON.
function showPromptWrapper() {
  document.getElementById('prompt-wrapper-group').classList.remove('hidden');
}

function hidePromptWrapper() {
  document.getElementById('prompt-wrapper-group').classList.add('hidden');
}

// The editor is shown whenever the params JSON references the {{template}} token.
function refreshPromptWrapperFromParams() {
  const raw = document.getElementById('params').value || '';
  if (raw.includes('{{template}}')) showPromptWrapper();
  else hidePromptWrapper();
}

// Beacon discovery state
let _beaconServers = [];

// Run beacon discovery scan
async function runBeaconDiscovery() {
  const loading = document.getElementById('beacon-loading');
  const empty = document.getElementById('beacon-empty');
  const serversDiv = document.getElementById('beacon-servers');
  const toolsDiv = document.getElementById('beacon-tools');
  const scanBtn = document.getElementById('beacon-scan-btn');

  loading.classList.remove('hidden');
  empty.classList.add('hidden');
  document.getElementById('beacon-claude-status').classList.add('hidden');
  serversDiv.innerHTML = '';
  toolsDiv.innerHTML = '';
  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning...';

  try {
    const response = await fetch('/api/beacon/discover');
    const { servers } = await response.json();

    if (!servers || servers.length === 0) {
      empty.classList.remove('hidden');
      return;
    }

    _beaconServers = servers;

    // Auto-detect a Claude/LLM destination among discovered servers (like chronos)
    const claude = detectClaudeTool(servers);
    const selectedServer = claude ? claude.serverIndex : 0;

    serversDiv.innerHTML = servers.map((s, i) => `
      <div class="beacon-server ${i === selectedServer ? 'selected' : ''}" onclick="selectBeaconServer(${i})" data-index="${i}">
        <div class="beacon-server-name">${escapeHtml(s.name)}</div>
        <div class="beacon-desc">${escapeHtml(s.description)}</div>
        <div class="beacon-url">${escapeHtml(s.url)}</div>
      </div>
    `).join('');

    const claudeStatus = document.getElementById('beacon-claude-status');
    if (claude) {
      // Found Claude — pre-select its server, then its specific tool, and announce it.
      selectBeaconServer(claude.serverIndex);
      selectBeaconTool(claude.serverIndex, claude.toolIndex);
      document.getElementById('beacon-claude-status-text').textContent =
        `Claude connected via beacon — auto-selected ${claude.server.name} / ${claude.tool.name}`;
      claudeStatus.classList.remove('hidden');
    } else {
      claudeStatus.classList.add('hidden');
      selectBeaconServer(0);
    }
  } catch (err) {
    showToast('Discovery failed: ' + err.message, 'error');
  } finally {
    loading.classList.add('hidden');
    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan Network';
  }
}

// Select a discovered beacon server and show its tools
function selectBeaconServer(index) {
  if (!_beaconServers[index]) return;

  const server = _beaconServers[index];

  document.querySelectorAll('.beacon-server').forEach((el, i) => {
    el.classList.toggle('selected', i === index);
  });

  const toolsDiv = document.getElementById('beacon-tools');
  if (server.tools && server.tools.length > 0) {
    toolsDiv.innerHTML =
      '<div style="font-weight: 600; font-size: 13px; margin-bottom: 8px;">Tools</div>' +
      server.tools.map((t, i) => `
        <div class="beacon-tool" onclick="selectBeaconTool(${index}, ${i})" data-server="${index}" data-tool="${i}">
          <div class="beacon-tool-name">${escapeHtml(t.name)}</div>
          <div class="beacon-desc">${escapeHtml(t.description || '')}</div>
        </div>
      `).join('');
  } else {
    toolsDiv.innerHTML = '<div style="color: #6c757d; font-size: 13px;">No tools advertised by this server.</div>';
  }
}

// Select a tool from a beacon server and fill the form
function selectBeaconTool(serverIndex, toolIndex) {
  const server = _beaconServers[serverIndex];
  const tool = server.tools[toolIndex];

  document.querySelectorAll('.beacon-tool').forEach((el, i) => {
    el.classList.toggle('selected', i === toolIndex);
  });

  document.getElementById('transport').value = 'http';
  document.getElementById('targetUrl').value = server.url;
  // Servers announce their auth over local discovery (e.g. claude-code sends
  // { type: 'bearer', token: ... }); carry it into the form or the saved
  // target gets 401s against auth-enforcing MCP servers.
  document.getElementById('authToken').value =
    (server.auth && server.auth.type === 'bearer' && server.auth.token) ? server.auth.token : '';
  document.getElementById('tool').value = tool.name;

  const generated = generateParamsFromSchema(tool.inputSchema);
  const promptParam = findPromptParam(tool.inputSchema);
  // For LLM-style tools, point the prompt param at {{template}} (resolved to the
  // template text at send time) and seed the template field with the default.
  if (promptParam) {
    generated[promptParam] = '{{template}}';
    document.getElementById('promptTemplate').value = DEFAULT_CLAUDE_PROMPT;
  }
  document.getElementById('params').value = JSON.stringify(generated, null, 2);

  if (promptParam) showPromptWrapper();
  else hidePromptWrapper();
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
