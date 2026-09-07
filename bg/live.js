// bg/live.js
import { log } from "./core.js";

async function execScriptMV3(tabId, func) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func
    });
    return result ?? null;
  } catch {
    return null;
  }
}

(function () {
  const L = {};
  const T = (globalThis.TTM = globalThis.TTM || {});
  const norm = (s) => String(s || "").trim().toLowerCase();
  const uniq = (arr) => [...new Set((arr || []).map(norm).filter(Boolean))];

  let sidebarState = { live: [], streaks: [], at: 0, sourceUrl: "", reports: 0 };
  const sidebarReports = new Map();
  const SIDEBAR_REPORT_TTL_MS = 90_000;
  let helixHealthy = false;
  let gqlHealthy = false;
  let htmlFollowingHealthy = false;
  let lastDetectionMeta = { healthy: true, sources: [], at: 0, probe: { checked: 0, responded: 0, live: [], offline: [], unknown: [] } };
  let currentProbeHealth = { checked: 0, responded: 0, live: [], offline: [], unknown: [] };

  function isRaidSourceUrl(url = "") {
    try { return new URL(String(url || "")).searchParams.get("referrer") === "raid"; }
    catch { return /(?:[?&])referrer=raid(?:&|$)/i.test(String(url || "")); }
  }

  function rebuildSidebarAggregate() {
    const now = Date.now();
    const live = new Set();
    const streakByLogin = new Map();
    let newestAt = 0;
    let newestSourceUrl = "";
    let reports = 0;

    for (const [key, report] of [...sidebarReports.entries()]) {
      if (!report?.at || now - report.at > SIDEBAR_REPORT_TTL_MS) {
        sidebarReports.delete(key);
        continue;
      }
      // Raid pages have repeatedly reported an empty/partial sidebar and used
      // to erase a healthy report from another Twitch tab. Ignore them as a
      // discovery source, while still keeping ordinary Twitch pages aggregated.
      if (isRaidSourceUrl(report.sourceUrl)) continue;
      reports += 1;
      for (const login of report.live || []) live.add(norm(login));
      for (const item of report.streaks || []) {
        const login = norm(item?.login);
        const streak = Number(item?.streak);
        if (login && Number.isFinite(streak)) streakByLogin.set(login, { login, streak });
      }
      if (report.at >= newestAt) {
        newestAt = report.at;
        newestSourceUrl = report.sourceUrl || "";
      }
    }

    sidebarState = {
      live: [...live].filter(Boolean),
      streaks: [...streakByLogin.values()],
      at: newestAt,
      sourceUrl: newestSourceUrl,
      reports
    };
  }

  function updateSidebarState(msg = {}, sourceTabId = null) {
    const key = sourceTabId == null ? `url:${String(msg.sourceUrl || "")}` : `tab:${Number(sourceTabId)}`;
    sidebarReports.set(key, {
      live: uniq(msg.live || []),
      streaks: Array.isArray(msg.streaks) ? msg.streaks : [],
      at: Date.now(),
      sourceUrl: String(msg.sourceUrl || "")
    });
    rebuildSidebarAggregate();
  }

  function getFreshSidebarLive() {
    rebuildSidebarAggregate();
    if (!sidebarState.at || Date.now() - sidebarState.at > SIDEBAR_REPORT_TTL_MS) return [];
    return sidebarState.live.slice();
  }

  function getConfiguredUnion(cfg) {
    return uniq(
      (cfg?.followUnion && cfg.followUnion.length
        ? cfg.followUnion
        : [
            ...(cfg?.favorites || []),
            ...(cfg?.priority || []),
            ...(cfg?.follows || []),
            ...(cfg?.rotation || []),
            ...(cfg?.low_priority || [])
          ])
    );
  }

  function filterConfigured(list, cfg) {
    const allowed = new Set(getConfiguredUnion(cfg));
    return uniq((list || []).filter((x) => allowed.has(norm(x))));
  }

  async function helixGetLiveLogins(cfg) {
    helixHealthy = false;
    const logins = getConfiguredUnion(cfg);
    if (!cfg.client_id || !cfg.access_token || logins.length === 0) return [];

    const headers = {
      "Client-Id": cfg.client_id,
      "Authorization": "Bearer " + cfg.access_token
    };

    const out = new Set();
    const chunk = 100;

    for (let i = 0; i < logins.length; i += chunk) {
      const slice = logins.slice(i, i + chunk);
      const qs = slice.map((l) => "user_login=" + encodeURIComponent(l)).join("&");
      const url = "https://api.twitch.tv/helix/streams?" + qs;

      try {
        const r = await fetch(url, { headers, cache: "no-store" });
        if (!r.ok) {
          log("helix_skip", { status: r.status, checked: slice });
          continue;
        }

        helixHealthy = true;
        const j = await r.json();
        for (const it of (j.data || [])) {
          if (it.user_login) out.add(norm(it.user_login));
          else if (it.user_name) out.add(norm(it.user_name));
        }
      } catch (e) {
        log("helix_error", String(e));
      }
    }

    const result = [...out];
    log("helix_result", { count: result.length, channels: result });
    return result;
  }

  async function fetchText(url, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        signal: controller.signal,
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!r.ok) return "";
      return await r.text();
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  function htmlHasLiveFlags(html) {
    if (!html) return false;

    const checks = [
      // older / JSON-ish Twitch page shapes
      /"isLiveBroadcast"\s*:\s*true/i,
      /"isLive"\s*:\s*true/i,
      /"stream"\s*:\s*{[\s\S]{0,1200}?"type"\s*:\s*"live"/i,
      /"videoPlayerState"\s*:\s*{[\s\S]{0,1200}?"isLive"\s*:\s*true/i,
      /"contentForTheatreMode"\s*:\s*{[\s\S]{0,1200}?"isLive"\s*:\s*true/i,
      /"broadcastSettings"[\s\S]{0,1200}"isLive"\s*:\s*true/i,
      /"streamType"\s*:\s*"live"/i,

      // newer rendered Twitch page markers
      /data-a-target=["']animated-channel-viewers-count["']/i,
      /class=["'][^"']*\blive-time\b[^"']*["']/i,
      /since live stream started/i
    ];

    return checks.some((re) => re.test(html));
  }
  
function htmlLooksOffline(html, login = "") {
  if (!html) return false;

  if (htmlHasLiveFlags(html)) return false;

  const checks = [
    />\s*OFFLINE\s*</i,
    /check out this [\s\S]{0,180}? stream from \d+\s+(minute|minutes|hour|hours|day|days)\s+ago/i,
    /stream from \d+\s+(minute|minutes|hour|hours|day|days)\s+ago/i,
    /data-a-target=["']channel-offline-info["']/i,
    /data-a-target=["']offline-channel-main-content["']/i,
    /player-overlay-offline-channel-text/i
  ];

  if (checks.some((re) => re.test(html))) return true;

  // Twitch's fresh server-rendered channel HTML often has no literal OFFLINE
  // token. When the response positively identifies the requested channel but
  // contains none of the live-broadcast markers above, treat it as offline.
  // Requiring two independent channel-identity signals avoids classifying a
  // generic/error shell as offline.
  const key = norm(login);
  if (!key) return false;
  const lower = String(html).toLowerCase();
  const channelUrl = `https://www.twitch.tv/${key}`;
  const canonical =
    lower.includes(`rel="canonical" href="${channelUrl}"`) ||
    lower.includes(`href="${channelUrl}" rel="canonical"`) ||
    lower.includes(`rel='canonical' href='${channelUrl}'`) ||
    lower.includes(`href='${channelUrl}' rel='canonical'`);
  const personSchema = lower.includes('"@type":"person"') && lower.includes(`"url":"${channelUrl}"`);
  const channelUrlJson = lower.includes(`"url":"${channelUrl}"`);
  const nonLiveTitle = /<meta[^>]+(?:name|property)=["'](?:title|og:title)["'][^>]+content=["'][^"']+ - Twitch["']/i.test(html) &&
                       !/Live on Twitch/i.test(html);

  const identitySignals = [canonical, personSchema || channelUrlJson, nonLiveTitle].filter(Boolean).length;
  return identitySignals >= 2;
}

  async function probeChannelPagesLive(cfg, need) {
    currentProbeHealth = { checked: 0, responded: 0, live: [], offline: [], unknown: [] };
    const priority = Array.isArray(cfg?.priority) ? cfg.priority : [];
    const ordered = uniq([...(priority || []), ...getConfiguredUnion(cfg)]);

    if (ordered.length === 0) {
      log("probe_error", "No configured channels available for probe");
      return [];
    }

    const concurrency = 16;
    const hardCap = ordered.length;
    const live = [];
    let idx = 0;

    log("probe_start", {
      target: hardCap,
      ordered_count: ordered.length,
      ordered
    });

    async function worker() {
      while (idx < hardCap) {
        const i = idx++;
        const login = ordered[i];
        try {
          const html = await fetchText(`https://www.twitch.tv/${login}`);
          currentProbeHealth.checked += 1;
          const responded = !!(html && html.length > 500);
          if (responded) currentProbeHealth.responded += 1;
          const isLive = responded && htmlHasLiveFlags(html);
          const isOffline = responded && htmlLooksOffline(html, login);
          if (isLive && !isOffline) currentProbeHealth.live.push(login);
          else if (isOffline) currentProbeHealth.offline.push(login);
          else currentProbeHealth.unknown.push(login);

          // Keep the normal log compact. Per-channel probe logging created
          // hundreds of entries per minute and buried the recovery/raid events
          // that Diagnose actually needs. Errors still log individually.
          if (isLive && !isOffline) {
            live.push(login);
          }
        } catch (e) {
          log("probe_error", { login, error: String(e) });
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const result = uniq(live);
    log("probe_result", {
      count: result.length,
      channels: result,
      checked: currentProbeHealth.checked,
      responded: currentProbeHealth.responded,
      offline_count: currentProbeHealth.offline.length,
      unknown_count: currentProbeHealth.unknown.length,
      offline_sample: currentProbeHealth.offline.slice(0, 12),
      unknown_sample: currentProbeHealth.unknown.slice(0, 12)
    });
    return result;
  }

  async function htmlFetchFollowing() {
  htmlFollowingHealthy = false;
  try {
    const r = await fetch("https://www.twitch.tv/directory/following/live", {
      credentials: "include",
      cache: "no-cache",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Pragma": "no-cache",
        "Cache-Control": "no-cache"
      },
      mode: "cors"
    });

    if (!r.ok) {
      log("html_following_skip", { status: r.status });
      return [];
    }

    htmlFollowingHealthy = true;
    const h = await r.text();

    const set = new Set();
    let m;

    const p1 = /"broadcaster[_-]?login"\s*:\s*"([^"]+)"/gi;
    const p2 = /data-channel-login="([^"]+)"/gi;
    const p3 = /"login"\s*:\s*"([^"]+)"\s*,\s*"isLiveBroadcast"\s*:\s*true/gi;
    const p4 = /"user[_-]?login"\s*:\s*"([^"]+)"/gi;
    const p5 = /<a[^>]+href="\/([a-z0-9_]+)"[^>]+data-test-selector="ChannelLink"[^>]*>/gi;

    while ((m = p1.exec(h))) set.add(m[1].toLowerCase());
    while ((m = p2.exec(h))) set.add(m[1].toLowerCase());
    while ((m = p3.exec(h))) set.add(m[1].toLowerCase());
    while ((m = p4.exec(h))) set.add(m[1].toLowerCase());
    while ((m = p5.exec(h))) set.add(m[1].toLowerCase());

    const raw = [...set];
    log("html_following_result_raw", { count: raw.length, channels: raw });
    return raw;
  } catch (e) {
    // This is an optional fallback now, so do not surface it as a scary hard error.
    log("html_following_skip", { reason: String(e) });
    return [];
  }
}

  async function getWebOAuthTokenFromConfig(cfg) {
    // A Helix app/user access_token is not automatically a Twitch web OAuth
    // token. Only use fields that are explicitly intended for web GQL auth.
    const direct =
      cfg?.auth_token ||
      cfg?.oauth_token ||
      cfg?.access_token_web ||
      cfg?.access_token_user;

    if (direct) return String(direct);

    try {
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const fromStore =
        all?.auth_token ||
        all?.oauth_token ||
        all?.access_token_web ||
        all?.access_token_user;

      if (fromStore) return String(fromStore);
    } catch {}

    return "";
  }

  async function gqlFollowingLiveLoginsWithToken(userToken) {
    gqlHealthy = false;
    if (!userToken) return [];

    const body = [{
      operationName: "FollowingLive",
      variables: { limit: 100 },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: "9b7b2bb4a8c2d0b70e6d1c4a7dfd2ef9f6ca2b1fb6dcd2c8b9392a9a9a9a9a9a"
        }
      }
    }];

    try {
      const r = await fetch("https://gql.twitch.tv/gql", {
        method: "POST",
        headers: {
          "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko",
          "Content-Type": "application/json",
          "Authorization": "OAuth " + userToken
        },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit"
      });

      if (!r.ok) return [];

      const j = await r.json();
      gqlHealthy = true;
      const data = (Array.isArray(j) ? j[0] : j)?.data;
      const edges = data?.followedLiveUsers?.edges || data?.user?.following?.live?.edges || [];

      const out = new Set();
      for (const e of edges) {
        const login = e?.node?.login || e?.node?.displayName || e?.node?.id;
        if (login) out.add(String(login).toLowerCase());
      }

      const result = [...out];
      log("gql_result_raw", { count: result.length, channels: result });
      return result;
    } catch (e) {
      log("gql_error", String(e));
      return [];
    }
  }

  async function htmlScrapeViaTab() {
  log("html_tab_disabled", "Tab-based following/live scrape disabled to avoid opening background Twitch tabs");
  return [];
}

  L.getLiveNowByConfigSafe = async function (cfg) {
    try {
      const configured = getConfiguredUnion(cfg);
      const followCounts = {
        favorites: Array.isArray(cfg?.favorites) ? cfg.favorites.length : 0,
        priority: Array.isArray(cfg?.priority) ? cfg.priority.length : 0,
        follows: Array.isArray(cfg?.follows) ? cfg.follows.length : 0,
        rotation: Array.isArray(cfg?.rotation) ? cfg.rotation.length : 0,
        low_priority: Array.isArray(cfg?.low_priority) ? cfg.low_priority.length : 0,
        followUnion: Array.isArray(cfg?.followUnion) ? cfg.followUnion.length : 0
      };

      log("live_start", {
        ...followCounts,
        configured,
        client_id: cfg?.client_id ? "present" : "missing",
        access_token: cfg?.access_token ? "present" : "missing"
      });

      const allTwitchTabs = await chrome.tabs.query({ url: ["https://www.twitch.tv/*"] });
      globalThis.TTM_STAB?.onTabsSnapshot?.(allTwitchTabs);

      const found = new Set();
      const healthySources = [];

      const viaSidebar = getFreshSidebarLive();
      if (viaSidebar.length) {
        addFound(viaSidebar, "sidebar_dom");
        healthySources.push("sidebar_dom");
      }

      function addFound(list, source) {
        const filtered = filterConfigured(list, cfg);
        let added = 0;

        for (const login of filtered) {
          const key = norm(login);
          if (!key) continue;
          if (Array.isArray(cfg?.blacklist) && cfg.blacklist.includes(key)) continue;
          if (found.has(key)) continue;

          found.add(key);
          added += 1;
        }

        log("live_merge", {
          source,
          raw_count: Array.isArray(list) ? list.length : 0,
          filtered_count: filtered.length,
          added,
          total: found.size,
          target: "all_configured",
          channels: filtered
        });
      }

      if (configured.length === 0) {
        log("live_check", "No configured channels found");
        return new Set();
      }

      if (cfg?.client_id && cfg?.access_token) {
        log("live_check", "Trying Helix method");
        const viaHelix = await helixGetLiveLogins(cfg);
        if (helixHealthy) healthySources.push("helix");
        if (viaHelix.length > 0) addFound(viaHelix, "helix");
        else log("live_check", "Helix method returned no results");
      }

      const tok = await getWebOAuthTokenFromConfig(cfg);
      if (tok) {
        log("live_check", "Trying GQL method");
        const viaGql = await gqlFollowingLiveLoginsWithToken(tok);
        if (gqlHealthy) healthySources.push("gql");
        if (viaGql.length > 0) addFound(viaGql, "gql");
        else log("live_check", "GQL method returned no results");
      }

      if (configured.length > 0) {
        log("live_check", `Trying probe method (all configured: ${configured.length})`);
        const viaProbe = await probeChannelPagesLive(cfg, configured.length);
        if (currentProbeHealth.responded > 0) healthySources.push("probe");
        if (viaProbe.length > 0) addFound(viaProbe, "probe");
        else log("live_check", "Probe method returned no results");
      }

      if (
        !cfg?.client_id &&
        !cfg?.access_token
      ) {
        log("live_check", "Trying HTML following method");
        const viaHtml = filterConfigured(await htmlFetchFollowing(), cfg);
        if (htmlFollowingHealthy) healthySources.push("html_following");
        if (viaHtml.length > 0) addFound(viaHtml, "html_following");
        else log("live_check", "HTML following method returned no configured results");
      } else {
        log("live_check", "Skipping HTML following method");
      }

      const allowTabScrapeFallback =
      cfg?.debug_allow_tab_scrape_fallback === true ||
      cfg?.debug_allow_tab_scrape_fallback === "true";

      if (allowTabScrapeFallback) {
        log("live_check", "Trying tab scrape fallback (debug-enabled)");
        const viaTab = filterConfigured(await htmlScrapeViaTab(), cfg);
        if (viaTab.length > 0) addFound(viaTab, "html_tab");
        else log("live_check", "Tab scrape method returned no configured results");
      } else {
        log("live_check", "Skipping tab scrape fallback (disabled for normal polling)");
      }

      const result = [...found];
      lastDetectionMeta = {
        healthy: healthySources.length > 0 || currentProbeHealth.responded > 0,
        sources: [...new Set(healthySources)],
        at: Date.now(),
        probe: {
          ...currentProbeHealth,
          live: uniq(currentProbeHealth.live),
          offline: uniq(currentProbeHealth.offline),
          unknown: uniq(currentProbeHealth.unknown)
        },
        sidebar_age_ms: sidebarState.at ? Date.now() - sidebarState.at : null
      };
      log("live_found", {
        count: result.length,
        channels: result,
        configured,
        detection: lastDetectionMeta
      });

      return new Set(result);
    } catch (e) {
      lastDetectionMeta = { healthy: false, sources: [], at: Date.now(), probe: { ...currentProbeHealth }, error: String(e) };
      log("live_error", String(e));
      return new Set();
    }
  };

  L.updateSidebarState = updateSidebarState;
  L.getLastDetectionMeta = () => ({ ...lastDetectionMeta });
  L.getSidebarState = () => {
    rebuildSidebarAggregate();
    return { ...sidebarState, live: sidebarState.live.slice(), streaks: sidebarState.streaks.slice() };
  };

  self.bgLive = L;
})();