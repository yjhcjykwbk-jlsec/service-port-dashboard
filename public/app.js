const state = {
  data: null,
  models: null,
  activeGroup: "all",
  query: "",
  view: "services"
};

const content = document.querySelector("#content");
const groupNav = document.querySelector("#groupNav");
const search = document.querySelector("#search");
const refresh = document.querySelector("#refresh");
const servicesTab = document.querySelector("#servicesTab");
const modelsTab = document.querySelector("#modelsTab");
const processesTab = document.querySelector("#processesTab");

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function statusClass(status) {
  return status?.state || "not-probed";
}

function matches(record) {
  const groupOk = state.activeGroup === "all" || record.group === state.activeGroup;
  if (!groupOk) return false;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  return [
    record.port,
    record.service,
    record.group,
    record.bind,
    record.process?.name,
    record.process?.pid,
    record.processInfo?.command,
    record.proc?.cwd,
    record.proc?.cmdline,
    record.container?.name,
    record.container?.image,
    record.dockerInfo?.workingDir,
    record.dockerInfo?.cmd,
    record.dockerInfo?.composeProject,
    record.dockerInfo?.composeService
  ].filter(Boolean).join(" ").toLowerCase().includes(query);
}

function renderSummary(data) {
  document.querySelector("#portCount").textContent = String(data.records.length);
  document.querySelector("#groupCount").textContent = String(data.groups.length);
  document.querySelector("#containerCount").textContent = String(data.containers.length);
  document.querySelector("#updatedAt").textContent = new Date(data.generatedAt).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function renderNav(data) {
  groupNav.replaceChildren();
  const all = el("button", `chip ${state.activeGroup === "all" ? "active" : ""}`, `全部 ${data.records.length}`);
  all.addEventListener("click", () => {
    state.activeGroup = "all";
    render();
  });
  groupNav.append(all);

  for (const group of data.groups) {
    const button = el("button", `chip ${state.activeGroup === group.name ? "active" : ""}`, `${group.name} ${group.ports.length}`);
    button.addEventListener("click", () => {
      state.activeGroup = group.name;
      render();
    });
    groupNav.append(button);
  }
}

function fact(label, value, options = {}) {
  if (!value) return null;
  const row = el("div", "fact");
  row.append(el("span", "", label));
  if (options.href) {
    const link = el("a", "open-link", String(value));
    link.href = options.href;
    link.target = "_blank";
    link.rel = "noreferrer";
    row.append(link);
  } else {
    row.append(el("code", "", String(value)));
  }
  return row;
}

function frontendUrl(record) {
  if (!record.status?.frontend) return "";
  const scheme = record.status.scheme || "http";
  const host = window.location.hostname || "127.0.0.1";
  return `${scheme}://${host}:${record.port}/`;
}

function secretFact(label, value) {
  if (!value) return null;
  const row = el("div", "fact");
  row.append(el("span", "", label));
  const wrap = el("div", "secret-wrap");
  wrap.append(el("code", "secret-value", value));
  const copy = el("button", "mini-button", "复制");
  copy.addEventListener("click", async () => {
    const ok = await copyText(value);
    copy.textContent = ok ? "已复制" : "手动复制";
    if (!ok) showManualCopy(value);
    setTimeout(() => {
      copy.textContent = "复制";
    }, 1400);
  });
  wrap.append(copy);
  row.append(wrap);
  return row;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to legacy copy.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

function showManualCopy(value) {
  let modal = document.querySelector("#manualCopy");
  if (!modal) {
    modal = el("div", "manual-copy");
    modal.id = "manualCopy";
    const panel = el("div", "manual-panel");
    panel.append(el("strong", "", "浏览器禁止自动复制，请手动长按/全选复制"));
    const textarea = document.createElement("textarea");
    textarea.id = "manualCopyText";
    panel.append(textarea);
    const close = el("button", "mini-button", "关闭");
    close.addEventListener("click", () => modal.remove());
    panel.append(close);
    modal.append(panel);
    document.body.append(modal);
  }
  const textarea = modal.querySelector("#manualCopyText");
  textarea.value = value;
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
}

function renderPort(record) {
  const card = el("article", "port-card");
  const head = el("div", "port-head");
  const left = el("div");
  left.append(el("div", "port-num", String(record.port)));
  left.append(el("div", "service", record.service));
  head.append(left);
  head.append(el("span", `badge ${statusClass(record.status)}`, record.status?.label || "unknown"));

  const facts = el("div", "facts");
  [
    fact("用途", record.purpose),
    fact("前端", record.status?.frontend ? "可访问/可探测" : "不可直接作为网页访问"),
    fact("打开", frontendUrl(record), { href: frontendUrl(record) }),
    fact("绑定", record.bind),
    fact("协议", record.protocol),
    fact("进程", record.process ? `${record.process.name} pid=${record.process.pid}` : "docker-proxy / kernel"),
    fact("启动目录", record.proc?.cwd),
    fact("启动参数", record.proc?.cmdline || record.processInfo?.command),
    fact("容器", record.container ? `${record.container.name} (${record.container.image})` : ""),
    fact("映射", record.dockerMapping ? `${record.dockerMapping.hostPort}->${record.dockerMapping.containerPort}/${record.dockerMapping.protocol}` : ""),
    fact("容器目录", record.dockerInfo?.workingDir),
    fact("容器命令", record.dockerInfo ? `${record.dockerInfo.entrypoint || ""} ${record.dockerInfo.cmd || ""}`.trim() : ""),
    fact("Compose", record.dockerInfo?.composeProject ? `${record.dockerInfo.composeProject}/${record.dockerInfo.composeService}` : "")
  ].filter(Boolean).forEach((item) => facts.append(item));

  card.append(head, facts, el("div", "raw", record.raw));
  return card;
}

function renderGroup(group, records) {
  const section = el("section", "group");
  const header = el("header", "group-header");
  const title = el("div", "group-title");
  title.append(el("h2", "", group));
  title.append(el("span", "count", `${records.length} ports`));
  header.append(title);
  header.append(el("span", "count", `ok ${records.filter((item) => item.status.state === "ok").length} · warn ${records.filter((item) => item.status.state === "warn").length}`));

  const grid = el("div", "ports");
  records.forEach((record) => grid.append(renderPort(record)));
  section.append(header, grid);
  return section;
}

function render() {
  if (state.view === "models") {
    renderModels();
    return;
  }
  if (state.view === "processes") {
    renderProcesses();
    return;
  }
  if (!state.data) return;
  groupNav.hidden = false;
  renderSummary(state.data);
  renderNav(state.data);

  const filtered = state.data.records.filter(matches);
  if (!filtered.length) {
    content.replaceChildren(el("div", "empty", "没有匹配的服务端口。"));
    return;
  }

  const grouped = filtered.reduce((acc, record) => {
    acc[record.group] ||= [];
    acc[record.group].push(record);
    return acc;
  }, {});

  content.replaceChildren(...Object.keys(grouped).sort().map((group) => renderGroup(group, grouped[group])));
}

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  return `${hours}h ${minutes}m`;
}

function renderProcessNode(process, depth = 0) {
  const node = el("div", "process-node");
  node.style.setProperty("--depth", String(depth));
  const line = el("div", "process-line");
  line.append(el("span", "pid", String(process.pid)));
  line.append(el("span", "process-service", process.service));
  line.append(el("span", "process-age", formatDuration(process.elapsedSeconds)));
  if (process.listeningPorts?.length) line.append(el("span", "process-ports", process.listeningPorts.join(", ")));
  node.append(line);
  const meta = el("div", "process-meta");
  [
    fact("PPID/用户", `${process.ppid} / ${process.user} / ${process.stat}`),
    fact("cwd", process.cwd),
    fact("启动参数", process.cmdline || process.command)
  ].filter(Boolean).forEach((item) => meta.append(item));
  node.append(meta);
  process.children?.forEach((child) => node.append(renderProcessNode(child, depth + 1)));
  return node;
}

function flattenCount(nodes) {
  return nodes.reduce((sum, node) => sum + 1 + flattenCount(node.children || []), 0);
}

function renderProcesses() {
  if (!state.data) return;
  groupNav.hidden = true;
  renderSummary(state.data);
  const roots = state.data.longRunning || [];
  const panel = el("section", "panel");
  panel.append(el("h2", "", `运行超过 1 小时的进程树 (${flattenCount(roots)})`));
  const tree = el("div", "process-tree");
  if (!roots.length) tree.append(el("div", "empty", "没有运行超过 1 小时的非内核进程。"));
  roots.forEach((process) => tree.append(renderProcessNode(process)));
  panel.append(tree);
  content.replaceChildren(panel);
}

function allModels(data) {
  return data.providers.flatMap((provider) => provider.models.map((model) => ({
    provider: provider.id,
    id: `${provider.id}/${model.id}`,
    label: `${provider.id}/${model.name}`,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow
  })));
}

function modelsForTarget(data, target, all) {
  if (!target.allowedModels?.length) return all;
  const allowed = new Set(target.allowedModels.map((item) => item.toLowerCase()));
  return all.filter((model) => allowed.has(model.id.toLowerCase()));
}

function renderModels() {
  groupNav.hidden = true;
  if (!state.models) {
    content.replaceChildren(el("div", "loading", "正在读取模型供应商、OpenCode、Claude、OpenClaw 配置..."));
    loadModels();
    return;
  }

  const modelOptions = allModels(state.models);
  const layout = el("div", "model-layout");

  const providers = el("section", "panel");
  providers.append(el("h2", "", "供应商登记"));
  if (state.models.warnings?.length) providers.append(el("div", "message", state.models.warnings.join("；")));
  if (state.models.configPaths) {
    providers.append(el("div", "provider-meta", `配置路径：OpenClaw ${state.models.configPaths.openclaw} · OpenCode ${state.models.configPaths.opencode} · Claude ${state.models.configPaths.claude}`));
  }
  const providerList = el("div", "provider-list");
  state.models.providers.forEach((provider) => {
    const row = el("article", "provider");
    row.append(el("strong", "", provider.id));
    row.append(el("div", "provider-meta", `source: ${provider.source || "openclaw"}`));
    row.append(el("div", "provider-meta", `base: ${provider.baseUrl || "未登记"}`));
    row.append(el("div", "provider-meta", `models: ${provider.models.map((model) => model.id).join(", ") || "未登记"}`));
    row.append(secretFact("apikey", provider.key.configured ? provider.key.value : "未配置"));
    providerList.append(row);
  });
  providers.append(providerList);

  const targets = el("section", "panel");
  targets.append(el("h2", "", "模型切换"));
  const picker = el("div", "model-picker");
  const message = el("div", "message", "切换会先写备份文件；Claude/OpenClaw 进程可能需要重启后完全生效。");
  state.models.targets.forEach((target) => {
    const row = el("div", "switch-row");
    const left = el("div", "target-meta");
    left.append(el("strong", "", target.name));
    left.append(el("div", "", `当前：${target.currentModel || "未设置"}`));
    left.append(el("div", "", target.note));
    const targetModels = modelsForTarget(state.models, target, modelOptions);
    const select = el("select");
    targetModels.forEach((model) => {
      const option = el("option", "", model.label);
      option.value = model.id;
      if (model.id.toLowerCase() === String(target.currentModel || "").toLowerCase()) option.selected = true;
      select.append(option);
    });
    if (!targetModels.length) {
      const option = el("option", "", "无可切换模型");
      option.value = "";
      select.append(option);
      select.disabled = true;
    }
    const button = el("button", "", "切换");
    button.addEventListener("click", async () => {
      if (!select.value) return;
      if (!confirm(`确认把 ${target.name} 切换到 ${select.value}？`)) return;
      button.disabled = true;
      button.textContent = "切换中";
      try {
        const response = await fetch("/api/models/switch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: target.id, model: select.value })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || `HTTP ${response.status}`);
        message.textContent = `${target.name} 已切换到 ${select.value}。动作：${result.applied || "已写入"}。备份：${(result.backups || []).join(", ")}`;
        await loadModels(false);
      } catch (error) {
        message.textContent = `切换失败：${error.message}`;
      } finally {
        button.disabled = false;
        button.textContent = "切换";
      }
    });
    row.append(left, select, button);
    picker.append(row);
  });
  picker.append(message);
  targets.append(picker);

  layout.append(providers, targets);
  content.replaceChildren(layout);
}

async function load() {
  refresh.disabled = true;
  refresh.textContent = "扫描中";
  if (!state.data) content.replaceChildren(el("div", "loading", "正在扫描监听端口、进程、Docker 容器和 systemd 服务..."));
  try {
    const response = await fetch("/api/services", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    render();
  } catch (error) {
    content.replaceChildren(el("div", "empty", `加载失败：${error.message}`));
  } finally {
    refresh.disabled = false;
    refresh.textContent = "刷新";
  }
}

async function loadModels(shouldRender = true) {
  try {
    const response = await fetch("/api/models", { cache: "no-store" });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
    state.models = JSON.parse(text);
    if (shouldRender) render();
  } catch (error) {
    content.replaceChildren(el("div", "empty", `加载模型配置失败：${error.message}`));
  }
}

search.addEventListener("input", () => {
  state.query = search.value;
  render();
});

refresh.addEventListener("click", load);
servicesTab.addEventListener("click", () => {
  state.view = "services";
  servicesTab.classList.add("active");
  modelsTab.classList.remove("active");
  processesTab.classList.remove("active");
  render();
});
modelsTab.addEventListener("click", () => {
  state.view = "models";
  modelsTab.classList.add("active");
  servicesTab.classList.remove("active");
  processesTab.classList.remove("active");
  render();
});
processesTab.addEventListener("click", () => {
  state.view = "processes";
  processesTab.classList.add("active");
  servicesTab.classList.remove("active");
  modelsTab.classList.remove("active");
  render();
});
load();
setInterval(load, 30000);
