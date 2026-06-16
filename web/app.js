// State
let currentConfig = null;
let currentStatus = null;
let botRunning = false;
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
const botUsername = document.getElementById('bot-username');

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

    // Build the unified target models and render every card (default + per-chat)
    buildModels();
    renderAllTargets();

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
      chatTargets: currentConfig?.chatTargets || [],
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
      chatTargets: currentConfig.chatTargets || [],
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

// ── Target cards (one shared component) ──────────────────────────────────────
// ONE renderer (renderTargetBody) drives BOTH the Default target card and every
// per-chat card. The Default is simply a target with no chat filter (the
// catch-all); a per-chat target adds a Chat IDs box. Same markup, same classes,
// same look and feel — there is no second copy of the card to drift.
//
// Edits live in plain model objects. Text inputs sync via oninput (so chip/
// toggle re-renders never lose what you typed); chips/toggles re-render. The
// whole document is persisted together by saveAll() (POST /api/config applies
// live — no restart).

let defaultModel = null;
let chatTargetsState = [];

function blankModel() {
  return {
    chatIds: [], accessMode: 'private', allowedUsers: [],
    url: '', authToken: '', tool: '',
    paramsText: JSON.stringify({ message: '{{text}}', chatId: '{{chatId}}' }, null, 2),
    promptTemplate: '', _editOpen: false, _beacon: null,
    _preset: '', _beaconServerIdx: 0, _beaconLoading: false, _claudeStatus: '',
  };
}

// Map the saved config onto editable models: the Default card = telegram access
// + the top-level target; each per-chat card = a chatTargets entry.
function buildModels() {
  const tg = currentConfig.telegram || {};
  const tgt = currentConfig.target || {};
  defaultModel = {
    chatIds: [],
    accessMode: tg.accessMode || 'private',
    allowedUsers: (tg.allowedUsers || []).slice(),
    url: tgt.url || '', authToken: tgt.authToken || '', tool: tgt.tool || '',
    paramsText: JSON.stringify(tgt.params || {}, null, 2),
    promptTemplate: tgt.promptTemplate || '', _editOpen: false, _beacon: null,
    _preset: tgt.tool === 'echo' ? 'echo' : '', _beaconServerIdx: 0, _beaconLoading: false, _claudeStatus: '',
  };
  chatTargetsState = (currentConfig.chatTargets || []).map((t) => ({
    chatIds: Array.isArray(t.chatIds) ? t.chatIds.map(String) : [],
    accessMode: t.accessMode || 'private',
    allowedUsers: Array.isArray(t.allowedUsers) ? t.allowedUsers.slice() : [],
    url: t.url || '', authToken: t.authToken || '', tool: t.tool || '',
    paramsText: JSON.stringify(t.params || {}, null, 2),
    promptTemplate: t.promptTemplate || '', _editOpen: false, _beacon: null,
    _preset: t.tool === 'echo' ? 'echo' : '', _beaconServerIdx: 0, _beaconLoading: false, _claudeStatus: '',
  }));
}

function getModel(key) {
  return key === 'default' ? defaultModel : chatTargetsState[Number(key)];
}

function chipsHtml(items, removeFn, key) {
  return (items || []).map((v) =>
    `<span class="user-chip"><span>${escapeHtml(v)}</span>` +
    `<button type="button" title="Remove" onclick="${removeFn}('${key}', '${escapeHtml(v)}')">×</button></span>`
  ).join('');
}

// The shared card body. key === 'default' for the catch-all, else a chat index.
function renderTargetBody(m, key) {
  const isDefault = key === 'default';
  const toolName = m.tool || 'echo';
  const urlDisplay = m.url || '(not set)';
  const accessHint = m.accessMode === 'public'
    ? (isDefault
        ? 'Anyone who can message the bot can trigger this target.'
        : 'Anyone who can message the bot in these chats can trigger this target.')
    : (isDefault
        ? 'Only the users below can use the bot (direct or group chats). Others get a reply with their user ID.'
        : 'Only the users below can use the bot in these chats. Others are ignored.');

  // Beacon discovery panel (shown when the Beacon preset is selected) — same
  // layout as the original: a "Discovered Servers" box with Scan Network, a
  // selectable server list and the selected server's tools.
  const sel = m._beaconServerIdx || 0;
  const beaconPanel = m._preset === 'beacon' ? `
    <div style="margin-bottom: 16px;">
      <div style="background: #f8f9fa; border-radius: 8px; padding: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <span style="font-weight: 600; font-size: 14px;">Discovered Servers</span>
          <button type="button" class="btn-secondary" style="padding: 6px 14px; font-size: 13px;" onclick="tgtScanBeacon('${key}')">${m._beaconLoading ? 'Scanning…' : 'Scan Network'}</button>
        </div>
        ${m._beaconLoading ? '<div style="text-align:center;padding:20px;color:#6c757d;">Scanning for MCP servers…</div>' : ''}
        ${(m._beacon && m._beacon.length === 0 && !m._beaconLoading) ? '<div style="text-align:center;padding:20px;color:#6c757d;">No servers found. Make sure MCP servers are running on the network.</div>' : ''}
        ${m._claudeStatus ? `<div style="display:flex;align-items:center;gap:8px;background:#e7f5ec;color:#1a7f4b;border:1px solid #b7e4c7;border-radius:6px;padding:8px 12px;font-size:13px;font-weight:600;margin-bottom:12px;"><span>✓</span><span>${escapeHtml(m._claudeStatus)}</span></div>` : ''}
        ${(m._beacon || []).map((s, si) => `
          <div class="beacon-server ${si === sel ? 'selected' : ''}" onclick="tgtSelectBeaconServer('${key}', ${si})">
            <div class="beacon-server-name">${escapeHtml(s.name)}</div>
            <div class="beacon-desc">${escapeHtml(s.description || '')}</div>
            <div class="beacon-url">${escapeHtml(s.url)}</div>
          </div>`).join('')}
        ${(m._beacon && m._beacon[sel] && (m._beacon[sel].tools || []).length) ? `
          <div style="margin-top: 12px;">
            <div style="font-weight: 600; font-size: 13px; margin-bottom: 8px;">Tools</div>
            ${m._beacon[sel].tools.map((t, ti) => `
              <div class="beacon-tool" onclick="tgtPickBeaconTool('${key}', ${sel}, ${ti})">
                <div class="beacon-tool-name">${escapeHtml(t.name)}</div>
                <div class="beacon-desc">${escapeHtml(t.description || '')}</div>
              </div>`).join('')}
          </div>` : ''}
      </div>
    </div>` : '';

  return `
    ${isDefault ? '' : `
    <div class="access-control">
      <div class="access-header"><span class="access-title">Chat IDs</span></div>
      <p class="access-hint">Telegram chat IDs this card serves. Group IDs can be negative.</p>
      <div class="allowed-users">
        <div class="user-chips">${chipsHtml(m.chatIds, 'tgtRemoveChatId', key)}</div>
        <div class="chip-add">
          <input type="text" placeholder="chat ID, e.g. 123456789"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();tgtAddChatId('${key}', this);}">
          <button type="button" class="btn-secondary" onclick="tgtAddChatId('${key}', this.previousElementSibling)">+</button>
        </div>
      </div>
    </div>`}

    <div class="access-control">
      <div class="access-header">
        <span class="access-title">Access</span>
        <div class="access-toggle">
          <button type="button" class="${m.accessMode === 'public' ? 'active' : ''}" onclick="tgtSetAccess('${key}', 'public')">Public</button>
          <button type="button" class="${m.accessMode === 'private' ? 'active' : ''}" onclick="tgtSetAccess('${key}', 'private')">Private</button>
        </div>
      </div>
      <p class="access-hint">${accessHint}</p>
      ${m.accessMode === 'private' ? `
      <div class="allowed-users">
        <div class="user-chips">${chipsHtml(m.allowedUsers, 'tgtRemoveUser', key)}</div>
        <div class="chip-add">
          <input type="text" placeholder="@username or user ID"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();tgtAddUser('${key}', this);}">
          <button type="button" class="btn-secondary" onclick="tgtAddUser('${key}', this.previousElementSibling)">+</button>
        </div>
      </div>` : ''}
    </div>

    <div class="flow-diagram">
      <div class="flow-step"><div class="flow-icon">💬</div><div class="flow-label">Message</div></div>
      <div class="flow-arrow">→</div>
      <div class="flow-step"><div class="flow-icon">⚡</div><div class="flow-label">${escapeHtml(toolName)}</div></div>
      <div class="flow-arrow">→</div>
      <div class="flow-step"><div class="flow-icon">📤</div><div class="flow-label">Reply</div></div>
    </div>

    <div class="mcp-info">
      <div class="mcp-info-row"><span class="mcp-info-label">Tool</span><span class="mcp-info-value">${escapeHtml(toolName)}</span></div>
      <div class="mcp-info-row"><span class="mcp-info-label">Endpoint</span><span class="mcp-info-value mcp-info-url">${escapeHtml(urlDisplay)}</span></div>
    </div>

    <button class="btn-edit" onclick="tgtToggleEdit('${key}', this)">
      <span>${m._editOpen ? 'Hide Configuration' : 'Edit Configuration'}</span>
    </button>

    <div class="tgt-edit-form ${m._editOpen ? '' : 'hidden'}">
      <div class="edit-form-content">
        <label>Preset</label>
        <select onchange="tgtApplyPreset('${key}', this.value)">
          <option value=""${m._preset === '' ? ' selected' : ''}>Custom</option>
          <option value="echo"${m._preset === 'echo' ? ' selected' : ''}>Echo (built-in test)</option>
          <option value="beacon"${m._preset === 'beacon' ? ' selected' : ''}>Beacon Discovery</option>
        </select>
        <p class="hint">Select a preset to auto-fill the fields below, or choose Custom</p>

        ${beaconPanel}

        <label>Transport</label>
        <select disabled><option value="http">HTTP (Streamable)</option></select>

        <label>MCP Server URL</label>
        <input type="url" value="${escapeHtml(m.url)}" placeholder="http://localhost:9634/mcp" oninput="tgtField('${key}', 'url', this.value)">
        <p class="hint">Use <code>http://localhost:9634/mcp</code> for the built-in echo server</p>

        <label>Auth Token</label>
        <input type="password" value="${escapeHtml(m.authToken)}" placeholder="Optional bearer token" oninput="tgtField('${key}', 'authToken', this.value)">
        <p class="hint">Required for claude-code-container (same as AUTH_PASSWORD)</p>

        <label>Tool Name</label>
        <input type="text" value="${escapeHtml(m.tool)}" placeholder="echo" oninput="tgtField('${key}', 'tool', this.value)">

        ${m.paramsText.includes('{{template}}') ? `
        <label>Prompt template <span style="font-weight:400;color:#6c757d;">(referenced as {{template}} in Parameters)</span></label>
        <textarea rows="8" oninput="tgtField('${key}', 'promptTemplate', this.value)">${escapeHtml(m.promptTemplate)}</textarea>
        <p class="hint">Use <code>{{text}}</code> for the message. The default tells the LLM it can call <code>get_chat_history</code> with <code>{{chatId}}</code> to pull earlier messages for context. The Parameters JSON below references this once via <code>{{template}}</code>.</p>` : ''}

        <label>Parameters (JSON)</label>
        <textarea oninput="tgtField('${key}', 'paramsText', this.value)">${escapeHtml(m.paramsText)}</textarea>
        <p class="hint">Variables: <code>{{text}}</code>, <code>{{chatId}}</code>, <code>{{userId}}</code>, <code>{{username}}</code>, <code>{{firstName}}</code></p>

        <div class="card-actions">
          <button class="btn-primary" onclick="saveTarget('${key}')">Save changes</button>
          ${isDefault ? '' : `<button class="btn-secondary" onclick="tgtCopyDefault('${key}')">Copy from default</button>`}
          ${isDefault ? '' : `<button class="btn-danger" onclick="removeTarget('${key}')" style="margin-left:auto;">Remove this target</button>`}
        </div>
      </div>
    </div>
  `;
}

function renderDefaultTarget() {
  const el = document.getElementById('default-target-body');
  if (el) el.innerHTML = renderTargetBody(defaultModel, 'default');
}

function renderChatTargets() {
  const list = document.getElementById('chat-targets-list');
  const count = document.getElementById('chat-targets-count');
  if (count) count.textContent = String(chatTargetsState.length);
  if (!list) return;
  if (chatTargetsState.length === 0) {
    list.innerHTML = '<div class="ct-empty">No per-chat targets yet. Every chat uses the Default target above. Click “Add per-chat target” to override specific chats.</div>';
    return;
  }
  list.innerHTML = chatTargetsState.map((m, i) => {
    const nChats = m.chatIds.length;
    const title = nChats ? 'chat ' + escapeHtml(m.chatIds.join(', ')) : 'new target';
    const badge = `${nChats} chat${nChats === 1 ? '' : 's'}`;
    return `
    <div class="card">
      <div class="card-header collapsible" onclick="tgtToggleCard(this)">
        <h2>MCP Target · ${title}</h2>
        <span class="status-badge">${badge}</span>
      </div>
      <div class="ct-body">
        ${renderTargetBody(m, i)}
      </div>
    </div>`;
  }).join('');
}

function renderAllTargets() {
  renderDefaultTarget();
  renderChatTargets();
}

function rerenderTarget(key) {
  if (key === 'default') renderDefaultTarget();
  else renderChatTargets();
}

// Collapse/expand a per-chat card (mirrors toggleCard for the static cards).
function tgtToggleCard(headerEl) {
  headerEl.classList.toggle('collapsed');
  const body = headerEl.parentElement.querySelector('.ct-body');
  if (body) body.classList.toggle('hidden');
}

function tgtToggleEdit(key, btn) {
  const m = getModel(key);
  m._editOpen = !m._editOpen;
  const form = btn.parentElement.querySelector('.tgt-edit-form');
  if (form) form.classList.toggle('hidden');
  const label = btn.querySelector('span');
  if (label) label.textContent = m._editOpen ? 'Hide Configuration' : 'Edit Configuration';
}

// Text fields update the model without a re-render (keeps focus/caret).
function tgtField(key, field, value) {
  const m = getModel(key);
  if (m) m[field] = value;
}

function tgtSetAccess(key, mode) { getModel(key).accessMode = mode; rerenderTarget(key); }

function tgtAddChatId(key, input) {
  const v = (input.value || '').trim();
  if (!v) return;
  if (!/^-?\d+$/.test(v)) { showToast('Chat ID must be numeric (group IDs can be negative)', 'error'); return; }
  const m = getModel(key);
  if (!m.chatIds.includes(v)) m.chatIds.push(v);
  input.value = '';
  rerenderTarget(key);
}

function tgtRemoveChatId(key, v) {
  const m = getModel(key);
  m.chatIds = m.chatIds.filter((x) => x !== v);
  rerenderTarget(key);
}

function tgtAddUser(key, input) {
  const v = (input.value || '').trim();
  if (!v) return;
  if (!/^(@?[A-Za-z][A-Za-z0-9_]{0,31}|\d+)$/.test(v)) { showToast('Enter a numeric user ID or a @username', 'error'); return; }
  const m = getModel(key);
  const norm = v.replace(/^@/, '').toLowerCase();
  if (!(m.allowedUsers || []).some((u) => u.replace(/^@/, '').toLowerCase() === norm)) {
    m.allowedUsers = [...(m.allowedUsers || []), v];
  }
  input.value = '';
  rerenderTarget(key);
}

function tgtRemoveUser(key, v) {
  const m = getModel(key);
  m.allowedUsers = (m.allowedUsers || []).filter((u) => u !== v);
  rerenderTarget(key);
}

function tgtCopyDefault(key) {
  const m = getModel(key);
  m.url = defaultModel.url;
  m.authToken = defaultModel.authToken;
  m.tool = defaultModel.tool;
  m.paramsText = defaultModel.paramsText;
  m.promptTemplate = defaultModel.promptTemplate;
  rerenderTarget(key);
}

// Preset dropdown: Echo fills the built-in test target; Beacon opens the
// discovery panel and scans; Custom leaves the fields untouched.
function tgtApplyPreset(key, preset) {
  const m = getModel(key);
  m._preset = preset;
  if (preset === 'echo') {
    m.url = 'http://localhost:9634/mcp';
    m.authToken = '';
    m.tool = 'echo';
    m.paramsText = JSON.stringify({ message: '{{text}}', chatId: '{{chatId}}', username: '{{username}}' }, null, 2);
    m.promptTemplate = '';
    m._beacon = null; m._claudeStatus = '';
    rerenderTarget(key);
  } else if (preset === 'beacon') {
    tgtScanBeacon(key);
  } else {
    m._beacon = null; m._claudeStatus = '';
    rerenderTarget(key);
  }
}

// Scan the local network for MCP servers (beacon), auto-selecting a Claude/LLM
// tool when one is found — same behaviour as the original panel.
async function tgtScanBeacon(key) {
  const m = getModel(key);
  m._preset = 'beacon';
  m._beaconLoading = true;
  m._claudeStatus = '';
  rerenderTarget(key);
  try {
    const res = await fetch('/api/beacon/discover');
    const { servers } = await res.json();
    m._beacon = servers || [];
    const claude = detectClaudeTool(m._beacon);
    if (claude) {
      m._beaconServerIdx = claude.serverIndex;
      tgtFillFromTool(m, claude.server, claude.tool);
      m._claudeStatus = `Claude connected via beacon — auto-selected ${claude.server.name} / ${claude.tool.name}`;
    } else {
      m._beaconServerIdx = 0;
    }
  } catch (e) {
    m._beacon = [];
    showToast('Discovery failed: ' + e.message, 'error');
  } finally {
    m._beaconLoading = false;
    rerenderTarget(key);
  }
}

function tgtSelectBeaconServer(key, si) {
  getModel(key)._beaconServerIdx = si;
  rerenderTarget(key);
}

// Fill a model's MCP fields from a discovered tool (shared by auto-detect + click).
function tgtFillFromTool(m, server, tool) {
  m.url = server.url;
  m.authToken = (server.auth && server.auth.type === 'bearer' && server.auth.token) ? server.auth.token : '';
  m.tool = tool.name;
  const generated = generateParamsFromSchema(tool.inputSchema);
  const promptParam = findPromptParam(tool.inputSchema);
  if (promptParam) { generated[promptParam] = '{{template}}'; m.promptTemplate = DEFAULT_CLAUDE_PROMPT; }
  m.paramsText = JSON.stringify(generated, null, 2);
}

function tgtPickBeaconTool(key, si, ti) {
  const m = getModel(key);
  tgtFillFromTool(m, m._beacon[si], m._beacon[si].tools[ti]);
  rerenderTarget(key);
}

// Serialize one model into a target config object (throws on validation error).
function buildTargetFromModel(m, includeChatMeta) {
  let params;
  try { params = JSON.parse(m.paramsText || '{}'); }
  catch (e) { throw new Error('invalid JSON in Parameters'); }
  if (typeof params !== 'object' || Array.isArray(params) || params === null) {
    throw new Error('Parameters must be a JSON object');
  }
  if (!(m.url || '').trim()) throw new Error('MCP Server URL is required');
  if (!(m.tool || '').trim()) throw new Error('Tool name is required');
  const t = { transport: 'http', url: m.url.trim(), tool: m.tool.trim(), params };
  if (m.authToken && m.authToken.trim()) t.authToken = m.authToken.trim();
  if (m.promptTemplate && m.promptTemplate.trim() && JSON.stringify(params).includes('{{template}}')) {
    t.promptTemplate = m.promptTemplate;
  }
  if (includeChatMeta) {
    if (!m.chatIds.length) throw new Error('add at least one chat ID');
    t.chatIds = m.chatIds;
    t.accessMode = m.accessMode || 'private';
    t.allowedUsers = m.allowedUsers || [];
  }
  return t;
}

// The config is one document, so any Save serializes the whole UI (Default +
// all per-chat cards) and POSTs it. POST /api/config applies live — no restart.
async function saveAll() {
  let telegram, target, chatTargets;
  try {
    target = buildTargetFromModel(defaultModel, false);
    telegram = { ...currentConfig.telegram, accessMode: defaultModel.accessMode, allowedUsers: defaultModel.allowedUsers };
    chatTargets = chatTargetsState.map((m, i) => {
      try { return buildTargetFromModel(m, true); }
      catch (e) { throw new Error(`Per-chat target #${i + 1}: ${e.message}`); }
    });
  } catch (e) {
    showToast('Failed to save: ' + e.message, 'error');
    return;
  }
  try {
    const cfg = { telegram, target, chatTargets, server: currentConfig.server || { port: 9634 } };
    const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to save');
    showToast('Saved');
    await loadConfig();
    await updateStatus();
  } catch (e) {
    showToast('Failed to save: ' + e.message, 'error');
  }
}

function saveTarget(key) { return saveAll(); }

function addChatTarget() {
  const m = blankModel();
  m._editOpen = true;
  chatTargetsState.push(m);
  renderChatTargets();
}

function removeTarget(key) {
  chatTargetsState.splice(Number(key), 1);
  renderChatTargets();
  saveAll();
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
