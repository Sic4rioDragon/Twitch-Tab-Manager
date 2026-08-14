import {
  uniqNames,
  getStoredConfig,
  backupCurrentBrowserConfig,
  writeConfigEverywhere,
  getActiveTabChannel,
  send
} from "./core.js";

export async function addCurrentChannelToConfig(kind) {
  const active = await getActiveTabChannel();
  if (!active.channel) {
    return { ok: false, error: "Open a Twitch channel tab first." };
  }

  const bag = await chrome.storage.local.get(null);
  const cfg = getStoredConfig(bag);
  const ch = active.channel;

  if (kind === "follow" && !cfg.follows.includes(ch)) cfg.follows.push(ch);
  if (kind === "priority" && !cfg.priority.includes(ch)) cfg.priority.push(ch);
  if (kind === "blacklist" && !cfg.blacklist.includes(ch)) cfg.blacklist.push(ch);

  cfg.favorites = uniqNames(cfg.favorites);
  cfg.priority = uniqNames(cfg.priority);
  cfg.follows = uniqNames(cfg.follows);
  cfg.rotation = uniqNames(cfg.rotation);
  cfg.low_priority = uniqNames(cfg.low_priority);
  cfg.blacklist = uniqNames(cfg.blacklist);

  cfg.followUnion = uniqNames([
    ...(cfg.favorites || []),
    ...(cfg.priority || []),
    ...(cfg.follows || []),
    ...(cfg.rotation || []),
    ...(cfg.low_priority || [])
  ]);

  await backupCurrentBrowserConfig(`popup_add_${kind}`);
  await writeConfigEverywhere(cfg);

  const reloadResp = await send("ttm/reload_config");
  if (!reloadResp?.ok) {
    return { ok: false, error: reloadResp?.error || `Updated ${ch}, but reload failed.` };
  }

  return { ok: true, channel: ch };
}

export async function tempAllowCurrentChannel() {
  const active = await getActiveTabChannel();
  if (!active.channel) {
    return { ok: false, error: "Open a Twitch channel tab first." };
  }

  const resp = await send("ttm/temp_allow_channel", { login: active.channel });
  if (resp?.ok) return { ok: true, channel: active.channel };
  return { ok: false, error: resp?.error || "Temp allow failed." };
}