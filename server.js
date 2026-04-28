import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, readFile, readlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || homedir();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4311);
const OPENCLAW_CONFIG = path.join(HOME, ".openclaw/openclaw.json");
const OPENCODE_CONFIG = path.join(HOME, ".config/opencode/opencode.jsonc");
const OPENCODE_AUTH = path.join(HOME, ".local/share/opencode/auth.json");
const OPENCODE_MODEL_STATE = path.join(HOME, ".local/state/opencode/model.json");
const CLAUDE_CONFIG = path.join(HOME, ".claude/settings.json");
const OPENCODE_WEB_LOG = path.join(HOME, ".openclaw/workspace/opencode-web-5175.log");
const CLAUDE_ANTHROPIC_BASE_BY_PROVIDER = {
  deepseek: "https://api.deepseek.com/anthropic",
  zai: "https://api.z.ai/api/anthropic"
};

const GROUP_RULES = [
  { id: "openclaw", name: "OpenClaw / Agents", match: /openclaw|opencode|claude-code|claude/i },
  { id: "multica", name: "Multica", match: /multica/i },
  { id: "deer-flow", name: "Deer Flow", match: /deer-flow/i },
  { id: "ragflow", name: "RAGFlow / Search", match: /ragflow|elastic|elasticsearch/i },
  { id: "blinko", name: "Blinko", match: /blinko/i },
  { id: "database", name: "Databases", match: /postgres|pgvector|5432|15432/i },
  { id: "remote", name: "Remote Access", match: /sshd|xrdp|3389|22/i },
  { id: "system", name: "System", match: /cups|systemd|dbus|resolved|7890|631|53/i }
];

const PORT_HINTS = {
  22: { service: "sshd", group: "Remote Access", kind: "system", purpose: "SSH 远程登录入口。前端网页不可访问。" },
  53: { service: "systemd-resolved", group: "System", kind: "system", purpose: "本机 DNS stub resolver。不是业务网页。" },
  631: { service: "cups", group: "System", kind: "system", purpose: "本机打印服务 CUPS。通常只在本机访问。" },
  1111: { service: "blinko-website", group: "Blinko", kind: "docker" },
  1200: { service: "ragflow-es-01", group: "RAGFlow / Search", kind: "docker" },
  2026: { service: "deer-flow-nginx", group: "Deer Flow", kind: "docker" },
  3000: { service: "Claude Code Rev Web", group: "OpenClaw / Agents", kind: "process" },
  3001: { service: "Next.js web service", group: "OpenClaw / Agents", kind: "process", purpose: "Next.js 前端服务，通常可直接浏览。" },
  3002: { service: "Next.js web service", group: "OpenClaw / Agents", kind: "process", purpose: "Next.js 前端服务，通常可直接浏览。" },
  3301: { service: "multica-frontend-1", group: "Multica", kind: "docker" },
  3727: { service: "claude-code-history", group: "OpenClaw / Agents", kind: "process" },
  4310: { service: "local bun service", group: "OpenClaw / Agents", kind: "process" },
  5175: { service: "opencode web", group: "OpenClaw / Agents", kind: "process" },
  7777: { service: "local web service", group: "Unassigned", kind: "process" },
  7890: { service: "local proxy", group: "System", kind: "system", purpose: "本机代理端口。不是业务网页。" },
  9000: { service: "python http service", group: "Unassigned", kind: "process" },
  9999: { service: "openclaw-gateway", group: "OpenClaw / Agents", kind: "systemd" },
  15432: { service: "multica-postgres-1", group: "Multica", kind: "docker" },
  18081: { service: "multica-backend-1", group: "Multica", kind: "docker" }
};

const SERVICE_PURPOSES = {
  "blinko-website": "Blinko 网页服务，通常可直接浏览。",
  "ragflow-es-01": "RAGFlow 的 Elasticsearch 搜索节点，供后端调用，不是前端网页。",
  "deer-flow-nginx": "Deer Flow 的 Nginx 入口，通常是前端/接口统一入口。",
  "Claude Code Rev Web": "Claude Code 相关的审查/历史网页服务。",
  "multica-frontend-1": "Multica 前端网页容器。",
  "claude-code-history": "Claude Code 历史记录查看服务。",
  "local bun service": "本机 Bun 开发/辅助服务，需要结合命令行确认具体项目。",
  "opencode web": "OpenCode Web 控制台，前端可访问。",
  "local web service": "未登记的本机网页服务，建议后续补服务名。",
  "python http service": "Python 启动的本地 HTTP 服务，可能是临时文件/调试服务。",
  "openclaw-gateway": "OpenClaw 网关与控制台入口。",
  "multica-postgres-1": "Multica PostgreSQL 数据库，供服务连接，不是网页。",
  "multica-backend-1": "Multica 后端 API 服务，根路径可能返回 404，但接口可用。"
};

const NON_HTTP_PORTS = new Set([22, 53, 546, 631, 7890, 5432, 15432, 27017, 3350, 3389, 56825, 60342]);

function run(command, args = [], timeout = 3500) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || "", stderr: stderr || "", code: error?.code ?? 0 });
    });
  });
}

function parseProcess(raw = "") {
  const match = raw.match(/users:\(\("([^"]+)",pid=(\d+),fd=(\d+)\)\)/);
  if (!match) return null;
  return { name: match[1], pid: Number(match[2]), fd: Number(match[3]) };
}

function parseListen(output) {
  const lines = output.split("\n").filter((line) => line.startsWith("LISTEN"));
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    const local = parts[3] || "";
    const process = parseProcess(line);
    const portMatch = local.match(/:(\d+)$/);
    return {
      protocol: "tcp",
      bind: local.replace(/^\[|\]$/g, ""),
      port: portMatch ? Number(portMatch[1]) : null,
      process,
      raw: line
    };
  }).filter((item) => item.port);
}

function parseUdp(output) {
  const lines = output.split("\n").filter((line) => line.startsWith("UNCONN"));
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    const local = parts[3] || "";
    const process = parseProcess(line);
    const portMatch = local.match(/:(\d+)$/);
    return {
      protocol: "udp",
      bind: local.replace(/^\[|\]$/g, ""),
      port: portMatch ? Number(portMatch[1]) : null,
      process,
      raw: line
    };
  }).filter((item) => item.port);
}

function parseDockerPorts(text = "") {
  const ports = [];
  for (const part of text.split(",")) {
    const match = part.trim().match(/(?:(0\.0\.0\.0|\[::\]|127\.0\.0\.1):)?(\d+)->(\d+)\/(tcp|udp)/);
    if (match) {
      ports.push({
        hostIP: match[1]?.replace(/\[|\]/g, "") || "",
        hostPort: Number(match[2]),
        containerPort: Number(match[3]),
        protocol: match[4]
      });
    }
  }
  return ports;
}

function parseDocker(output) {
  return output.split("\n").filter(Boolean).map((line) => {
    const [id, name, image, portsText = ""] = line.split("\t");
    return { id, name, image, portsText, ports: parseDockerPorts(portsText) };
  }).filter((item) => item.id && item.name);
}

function parsePs(output) {
  return output.split("\n").slice(1).filter(Boolean).map((line) => {
    const pid = Number(line.slice(0, 8).trim());
    const ppid = Number(line.slice(9, 17).trim());
    const user = line.slice(18, 32).trim();
    const stat = line.slice(33, 39).trim();
    const command = line.slice(40).trim();
    return { pid, ppid, user, stat, command };
  }).filter((item) => item.pid);
}

function parsePsLong(output) {
  return output.split("\n").slice(1).filter(Boolean).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      user: match[3],
      stat: match[4],
      elapsedSeconds: Number(match[5]),
      command: match[6]
    };
  }).filter(Boolean);
}

async function procDetails(pid) {
  if (!pid) return null;
  const [cwd, cmdline] = await Promise.all([
    readlink(`/proc/${pid}/cwd`).catch(() => ""),
    readFile(`/proc/${pid}/cmdline`, "utf8").then((text) => text.split("\0").filter(Boolean).join(" ")).catch(() => "")
  ]);
  return { cwd, cmdline };
}

function parseSystemd(output) {
  return output.split("\n").map((line) => line.trim()).filter((line) => line.endsWith(".service")).map((line) => {
    const [unit, load, active, sub, ...desc] = line.split(/\s+/);
    return { unit, load, active, sub, description: desc.join(" ") };
  });
}

async function dockerInspect(containers) {
  const inspected = new Map();
  await Promise.all(containers.map(async (container) => {
    const result = await run("docker", ["inspect", container.id], 3500);
    if (!result.ok) return;
    try {
      const data = JSON.parse(result.stdout)[0];
      inspected.set(container.id, {
        workingDir: data?.Config?.WorkingDir || "",
        entrypoint: Array.isArray(data?.Config?.Entrypoint) ? data.Config.Entrypoint.join(" ") : data?.Config?.Entrypoint || "",
        cmd: Array.isArray(data?.Config?.Cmd) ? data.Config.Cmd.join(" ") : data?.Config?.Cmd || "",
        labels: data?.Config?.Labels || {},
        composeProject: data?.Config?.Labels?.["com.docker.compose.project"] || "",
        composeService: data?.Config?.Labels?.["com.docker.compose.service"] || ""
      });
    } catch {
      // Ignore malformed inspect output.
    }
  }));
  return inspected;
}

function inferGroup(record) {
  const text = [
    record.service,
    record.container?.name,
    record.container?.image,
    record.process?.name,
    record.processInfo?.command,
    String(record.port)
  ].filter(Boolean).join(" ");
  const hint = PORT_HINTS[record.port];
  if (hint?.group) return hint.group;
  return GROUP_RULES.find((rule) => rule.match.test(text))?.name || "Unassigned";
}

function inferService(record) {
  const hint = PORT_HINTS[record.port];
  if (hint?.service) return hint.service;
  if (record.container?.name) return record.container.name;
  if (record.process?.name) return record.process.name;
  return `port-${record.port}`;
}

async function probeHttp(port, protocol = "tcp") {
  if (protocol !== "tcp" || NON_HTTP_PORTS.has(port)) {
    return { state: "not-probed", label: "非网页端口", frontend: false };
  }
  for (const scheme of ["http", "https"]) {
    const args = ["-k", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", `${scheme}://127.0.0.1:${port}/`];
    const result = await run("curl", args, 2800);
    const code = Number(result.stdout.trim());
    if (code >= 200 && code < 500) {
      return { state: code < 400 ? "ok" : "warn", label: `${scheme.toUpperCase()} ${code}`, frontend: true, scheme };
    }
  }
  return { state: "down", label: "网页不可达", frontend: false, scheme: "" };
}

function explain(record) {
  const hint = PORT_HINTS[record.port];
  if (hint?.purpose) return hint.purpose;
  if (SERVICE_PURPOSES[record.service]) return SERVICE_PURPOSES[record.service];
  if (record.container) return `Docker 容器 ${record.container.name} 暴露的 ${record.dockerMapping?.containerPort || ""} 端口。`;
  if (record.processInfo?.command) return `由进程 ${record.process?.name || record.processInfo.pid} 监听，命令行为主要线索。`;
  return "系统正在监听该端口，暂未登记具体用途。";
}

async function collectData() {
  const [ss, udp, docker, ps, psLong, systemd] = await Promise.all([
    run("ss", ["-ltnp"]),
    run("ss", ["-lunp"]),
    run("docker", ["ps", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Ports}}"]),
    run("ps", ["-eo", "pid,ppid,user,stat,args"]),
    run("ps", ["-eo", "pid,ppid,user,stat,etimes,args"]),
    run("systemctl", ["--user", "--no-pager", "--type=service", "--state=running"])
  ]);

  const listens = [...parseListen(ss.stdout), ...parseUdp(udp.stdout)];
  const containers = docker.ok ? parseDocker(docker.stdout) : [];
  const processes = parsePs(ps.stdout);
  const longProcesses = parsePsLong(psLong.stdout);
  const units = parseSystemd(systemd.stdout);
  const processByPid = new Map(processes.map((item) => [item.pid, item]));
  const procByPid = new Map(await Promise.all(
    [...new Set(listens.map((listen) => listen.process?.pid).filter(Boolean))]
      .map(async (pid) => [pid, await procDetails(pid)])
  ));
  const inspectByContainer = await dockerInspect(containers);
  const containerByPort = new Map();

  for (const container of containers) {
    for (const port of container.ports) {
      containerByPort.set(`${port.protocol}:${port.hostPort}`, { container, mapping: port });
    }
  }

  const records = await Promise.all(listens.map(async (listen) => {
    const dockerHit = containerByPort.get(`${listen.protocol}:${listen.port}`);
    const processInfo = listen.process?.pid ? processByPid.get(listen.process.pid) : null;
    const proc = listen.process?.pid ? procByPid.get(listen.process.pid) : null;
    const record = {
      port: listen.port,
      protocol: listen.protocol,
      bind: listen.bind,
      process: listen.process,
      processInfo,
      proc,
      container: dockerHit?.container || null,
      dockerInfo: dockerHit?.container ? inspectByContainer.get(dockerHit.container.id) || null : null,
      dockerMapping: dockerHit?.mapping || null,
      service: "",
      group: "",
      status: await probeHttp(listen.port, listen.protocol),
      raw: listen.raw
    };
    record.service = inferService(record);
    record.group = inferGroup(record);
    record.purpose = explain(record);
    return record;
  }));

  const groups = Object.values(records.reduce((acc, record) => {
    acc[record.group] ||= { name: record.group, ports: [], ok: 0, warn: 0, down: 0 };
    acc[record.group].ports.push(record);
    acc[record.group][record.status.state === "ok" ? "ok" : record.status.state === "warn" ? "warn" : "down"]++;
    return acc;
  }, {})).sort((a, b) => a.name.localeCompare(b.name));

  for (const group of groups) {
    group.ports.sort((a, b) => a.port - b.port);
  }

  const longRunning = await collectLongRunning(longProcesses, records, containers);

  return {
    generatedAt: new Date().toISOString(),
    host: { hostname: (await run("hostname")).stdout.trim() },
    groups,
    records: records.sort((a, b) => a.port - b.port),
    longRunning,
    containers,
    systemd: units,
    errors: [
      !docker.ok ? "docker ps failed or Docker is unavailable" : null,
      !systemd.ok ? "systemctl --user failed" : null
    ].filter(Boolean)
  };
}

async function collectLongRunning(processes, records, containers) {
  const listeningByPid = new Map();
  for (const record of records) {
    if (!record.process?.pid) continue;
    if (!listeningByPid.has(record.process.pid)) listeningByPid.set(record.process.pid, []);
    listeningByPid.get(record.process.pid).push(`${record.port}/${record.protocol}`);
  }

  const containerText = containers.map((container) => `${container.name} ${container.image}`).join("\n");
  const candidates = processes.filter((process) => {
    if (process.elapsedSeconds < 3600) return false;
    if (/^\[.*\]$/.test(process.command)) return false;
    return true;
  });

  const detailPairs = await Promise.all(candidates.slice(0, 500).map(async (process) => [process.pid, await procDetails(process.pid)]));
  const detailByPid = new Map(detailPairs);
  const byPid = new Map(candidates.map((process) => {
    const detail = detailByPid.get(process.pid) || {};
    const service = inferProcessService(process, detail, containerText);
    return [process.pid, {
      ...process,
      cwd: detail.cwd || "",
      cmdline: detail.cmdline || process.command,
      service,
      listeningPorts: listeningByPid.get(process.pid) || [],
      children: []
    }];
  }));

  const roots = [];
  for (const process of byPid.values()) {
    const parent = byPid.get(process.ppid);
    if (parent) parent.children.push(process);
    else roots.push(process);
  }

  const sortTree = (items) => {
    items.sort((a, b) => b.elapsedSeconds - a.elapsedSeconds);
    items.forEach((item) => sortTree(item.children));
  };
  sortTree(roots);
  return roots;
}

function inferProcessService(process, detail, containerText) {
  const text = `${process.command} ${detail.cwd || ""}`;
  if (/openclaw/i.test(text)) return "OpenClaw";
  if (/opencode/i.test(text)) return "OpenCode";
  if (/claude-code-history|clauderev|claude/i.test(text)) return "Claude tooling";
  if (/docker-proxy/.test(text)) return "Docker port proxy";
  if (/postgres/i.test(text)) return "PostgreSQL";
  if (/chrome|chromium/i.test(text)) return "Chrome desktop";
  if (/python3 -m http\.server/i.test(text)) return "Python static server";
  if (/bun/i.test(text)) return "Bun web/dev service";
  if (/sshd/i.test(text)) return "SSH";
  if (/xrdp/i.test(text)) return "XRDP";
  if (/systemd|dbus|pipewire|pulseaudio|gvfs|xfce|evolution/i.test(text)) return "Desktop/system service";
  if (containerText && /docker|containerd/i.test(text)) return "Docker runtime";
  return "Unclassified";
}

function redactKey(key = "") {
  if (!key) return { configured: false, value: "" };
  return { configured: true, value: key };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.bak.${stamp}`;
  await copyFile(file, target);
  return target;
}

function normalizeProvider(providerID, provider) {
  return {
    id: providerID,
    baseUrl: provider.baseUrl || provider.baseURL || provider.options?.baseURL || "",
    api: provider.api || "openai-compatible",
    key: redactKey(provider.apiKey || provider.key || ""),
    source: provider.source || "openclaw",
    models: (provider.models || []).map((model) => ({
      id: model.id || model,
      name: model.name || model.id || model,
      contextWindow: model.contextWindow || null,
      reasoning: Boolean(model.reasoning)
    }))
  };
}

function providerModels(provider) {
  return (provider.models || []).map((model) => ({
    id: model.id || model,
    name: model.name || model.id || model,
    contextWindow: model.contextWindow || null,
    reasoning: Boolean(model.reasoning)
  }));
}

function providerBase(provider = {}) {
  return provider.baseUrl || provider.baseURL || provider.options?.baseURL || "";
}

function openCodeBaseUrl(provider = {}) {
  const base = providerBase(provider);
  return base.replace(/\/chat\/completions\/?$/, "");
}

function baseFamily(value = "") {
  if (!value) return "";
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return `${url.hostname.toLowerCase()}/${parts.slice(0, 3).join("/")}`.replace(/\/$/, "");
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

function hasSameBaseFamily(left, right) {
  const a = baseFamily(left);
  const b = baseFamily(right);
  return Boolean(a && b && (a.startsWith(b) || b.startsWith(a)));
}

function isOpenClawAlias(providerID, openclawProviders, opencodeProviders = {}) {
  const authBase = providerBase(opencodeProviders[providerID]);
  for (const [openclawID, provider] of Object.entries(openclawProviders || {})) {
    if (providerID.startsWith(`${openclawID}-`) || providerID.startsWith(`${openclawID}_`) || providerID.startsWith(`${openclawID}.`)) {
      return true;
    }
    if (hasSameBaseFamily(authBase, providerBase(provider))) return true;
  }
  return false;
}

async function getModelData() {
  const [openclaw, opencode, opencodeAuth, opencodeState, claude] = await Promise.all([
    readJson(OPENCLAW_CONFIG).catch(() => ({})),
    readJson(OPENCODE_CONFIG).catch(() => ({})),
    readJson(OPENCODE_AUTH).catch(() => ({})),
    readJson(OPENCODE_MODEL_STATE).catch(() => ({})),
    readJson(CLAUDE_CONFIG).catch(() => ({}))
  ]);
  const warnings = [];
  if (!openclaw.models?.providers) warnings.push(`未读取到 OpenClaw 模型配置：${OPENCLAW_CONFIG}`);

  const providerMap = new Map();
  for (const [id, provider] of Object.entries(openclaw.models?.providers || {})) {
    providerMap.set(id, normalizeProvider(id, provider));
  }
  for (const [id, auth] of Object.entries(opencodeAuth || {})) {
    if (!providerMap.has(id) && !isOpenClawAlias(id, openclaw.models?.providers, opencode.provider)) {
      providerMap.set(id, normalizeProvider(id, { key: auth.key, models: [], source: "opencode-auth-only" }));
    }
  }

  const openclawAgents = [
    { id: "defaults", name: "OpenClaw defaults", model: openclaw.agents?.defaults?.model?.primary || "" },
    ...(openclaw.agents?.list || []).map((agent) => ({
      id: agent.id,
      name: agent.identity?.name || agent.id,
      model: agent.model?.primary || openclaw.agents?.defaults?.model?.primary || ""
    }))
  ];

  return {
    configPaths: {
      openclaw: OPENCLAW_CONFIG,
      opencode: OPENCODE_CONFIG,
      opencodeAuth: OPENCODE_AUTH,
      opencodeState: OPENCODE_MODEL_STATE,
      claude: CLAUDE_CONFIG
    },
    warnings,
    providers: [...providerMap.values()],
    targets: [
      {
        id: "opencode",
        name: "OpenCode CLI",
        currentModel: opencode.model || "",
        allowedModels: null,
        switchable: true,
        note: "真实方式：写 ~/.config/opencode/opencode.jsonc 的 model。新开的 opencode CLI 生效；已运行的 TUI/serve 通常要重启。"
      },
      {
        id: "opencode-web",
        name: "OpenCode Web",
        currentModel: opencodeState.recent?.[0] ? `${opencodeState.recent[0].providerID}/${opencodeState.recent[0].modelID}` : opencode.model || "",
        allowedModels: null,
        switchable: true,
        note: "真实方式：写 ~/.local/state/opencode/model.json 的 recent/favorite/variant，然后重启 5175 的 opencode web 进程。"
      },
      {
        id: "claude",
        name: "Claude Code",
        currentModel: claude.env?.ANTHROPIC_MODEL || "",
        allowedModels: Object.keys(CLAUDE_ANTHROPIC_BASE_BY_PROVIDER).flatMap((providerID) =>
          providerModels(openclaw.models?.providers?.[providerID] || {}).map((model) => `${providerID}/${model.id}`)
        ),
        switchable: true,
        note: "真实方式：写 ~/.claude/settings.json 的 env.ANTHROPIC_BASE_URL/API_KEY/MODEL。Claude Code 只接受 Anthropic-compatible 接口；当前放开 DeepSeek 与 Z.AI。已运行 claude 进程要重启。"
      },
      ...openclawAgents.map((agent) => ({
        id: `openclaw:${agent.id}`,
        name: agent.name,
        currentModel: agent.model,
        allowedModels: null,
        switchable: true,
        note: agent.id === "defaults" ? "真实方式：写 ~/.openclaw/openclaw.json 的 agents.defaults.model.primary，然后重启 OpenClaw gateway。" : `真实方式：写 ~/.openclaw/openclaw.json 中 agent ${agent.id} 的 model.primary，然后重启 OpenClaw gateway。`
      }))
    ]
  };
}

function splitModel(model) {
  const index = model.indexOf("/");
  if (index < 1) throw new Error("model must be provider/model");
  return { providerID: model.slice(0, index), modelID: model.slice(index + 1) };
}

async function syncOpenCodeAuth(providerID, provider, backups) {
  const key = provider?.apiKey || provider?.key || "";
  if (!key) return;
  const auth = await readJson(OPENCODE_AUTH).catch(() => ({}));
  if (auth[providerID]?.key === key && auth[providerID]?.type === "api") return;
  backups.push(await backup(OPENCODE_AUTH));
  auth[providerID] = { ...(auth[providerID] || {}), type: "api", key };
  await writeJson(OPENCODE_AUTH, auth);
}

async function syncOpenCodeProviderConfig(config, providerID, provider) {
  if (!provider) throw new Error(`unknown provider ${providerID}`);
  const models = providerModels(provider);
  if (!models.length) throw new Error(`provider ${providerID} has no registered models`);
  config.provider ||= {};
  config.provider[providerID] = {
    ...(config.provider[providerID] || {}),
    npm: "@ai-sdk/openai-compatible",
    name: provider.name || providerID,
    options: {
      ...(config.provider[providerID]?.options || {}),
      baseURL: openCodeBaseUrl(provider)
    },
    models: Object.fromEntries(models.map((model) => [model.id, {
      name: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
    }]))
  };
}

async function switchModel(target, model) {
  const { providerID, modelID } = splitModel(model);
  const backups = [];
  const openclaw = await readJson(OPENCLAW_CONFIG).catch(() => ({}));
  const provider = openclaw.models?.providers?.[providerID];

  if (target === "opencode") {
    const config = await readJson(OPENCODE_CONFIG).catch(() => ({}));
    backups.push(await backup(OPENCODE_CONFIG));
    config.model = model;
    await syncOpenCodeProviderConfig(config, providerID, provider);
    await writeJson(OPENCODE_CONFIG, config);
    await syncOpenCodeAuth(providerID, provider, backups);
    return { changed: "opencode", applied: "config/provider/auth written; restart running opencode sessions manually", backups };
  }

  if (target === "opencode-web") {
    const state = await readJson(OPENCODE_MODEL_STATE).catch(() => ({ recent: [], favorite: [], variant: {} }));
    backups.push(await backup(OPENCODE_MODEL_STATE));
    const item = { providerID, modelID };
    state.recent = [item, ...(state.recent || []).filter((entry) => `${entry.providerID}/${entry.modelID}` !== model)].slice(0, 8);
    state.favorite = [item, ...(state.favorite || []).filter((entry) => `${entry.providerID}/${entry.modelID}` !== model)];
    state.variant ||= {};
    state.variant[model] = "default";
    const config = await readJson(OPENCODE_CONFIG).catch(() => ({}));
    backups.push(await backup(OPENCODE_CONFIG));
    await syncOpenCodeProviderConfig(config, providerID, provider);
    await syncOpenCodeAuth(providerID, provider, backups);
    await writeJson(OPENCODE_CONFIG, config);
    await writeJson(OPENCODE_MODEL_STATE, state);
    await restartOpenCodeWeb();
    return { changed: "opencode-web", applied: "model-state/config/provider/auth written; opencode web restarted on 5175", backups };
  }

  if (target === "claude") {
    const claude = await readJson(CLAUDE_CONFIG);
    if (!provider) throw new Error(`unknown provider ${providerID}`);
    if (!CLAUDE_ANTHROPIC_BASE_BY_PROVIDER[providerID]) {
      throw new Error(`${providerID} is not registered as Anthropic-compatible for Claude Code`);
    }
    backups.push(await backup(CLAUDE_CONFIG));
    claude.env ||= {};
    claude.env.ANTHROPIC_MODEL = modelID.toLowerCase();
    claude.env.ANTHROPIC_BASE_URL = CLAUDE_ANTHROPIC_BASE_BY_PROVIDER[providerID];
    if (provider.apiKey) claude.env.ANTHROPIC_API_KEY = provider.apiKey;
    await writeJson(CLAUDE_CONFIG, claude);
    return { changed: "claude", applied: "settings-written; restart Claude Code processes to take effect", backups };
  }

  if (target.startsWith("openclaw:")) {
    const agentID = target.split(":")[1];
    backups.push(await backup(OPENCLAW_CONFIG));
    if (agentID === "defaults") {
      openclaw.agents ||= {};
      openclaw.agents.defaults ||= {};
      openclaw.agents.defaults.model = { ...(openclaw.agents.defaults.model || {}), primary: model };
    } else {
      const agent = (openclaw.agents?.list || []).find((item) => item.id === agentID);
      if (!agent) throw new Error(`unknown OpenClaw agent ${agentID}`);
      agent.model = { ...(agent.model || {}), primary: model };
    }
    await writeJson(OPENCLAW_CONFIG, openclaw);
    const restart = await run("openclaw", ["gateway", "restart", "--json"], 20000);
    return { changed: target, applied: restart.ok ? "openclaw config written; gateway restart requested" : `openclaw config written; gateway restart failed: ${restart.stderr || restart.stdout}`, backups };
  }

  throw new Error(`unsupported target ${target}`);
}

async function restartOpenCodeWeb() {
  const pgrep = await run("pgrep", ["-f", "opencode web --port 5175"], 3000);
  const pids = pgrep.stdout.split(/\s+/).map(Number).filter(Boolean);
  if (pids.length) await run("kill", pids.map(String), 3000);
  await new Promise((resolve) => setTimeout(resolve, 800));
  execFile("bash", [
    "-lc",
    `cd ${JSON.stringify(HOME)} && OPENCODE_BIN="$(command -v opencode)" && if [ -n "$OPENCODE_BIN" ]; then setsid "$OPENCODE_BIN" web --port 5175 --hostname 0.0.0.0 > ${JSON.stringify(OPENCODE_WEB_LOG)} 2>&1 < /dev/null & fi`
  ], () => {});
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/services") {
      const data = await collectData();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      const data = await getModelData();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
      return;
    }

    if (url.pathname === "/api/models/switch" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const result = await switchModel(body.target, body.model);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, message: error.message }));
      }
      return;
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(__dirname, "public", path.normalize(requested).replace(/^(\.\.[/\\])+/, ""));
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch (error) {
    res.writeHead(error.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error.code === "ENOENT" ? "Not found" : String(error.stack || error));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`service-port-dashboard listening on http://${HOST}:${PORT}`);
});
