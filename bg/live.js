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

  function getConfiguredUnion(cfg) {
    return uniq(
      (cfg?.followUnion && cfg.followUnion.length
        ? cfg.followUnion
        : [...(cfg?.follows || []), ...(cfg?.priority || [])])
    );
  }

  function filterConfigured(list, cfg) {
    const allowed = new Set(getConfiguredUnion(cfg));
    return uniq((list || []).filter((x) => allowed.has(norm(x))));
  }

  async function helixGetLiveLogins(cfg) {
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

  async function fetchText(url) {
    try {
      const r = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!r.ok) return "";
      return await r.text();
    } catch {
      return "";
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
  
function htmlLooksOffline(html) {
  if (!html) return false;

  if (htmlHasLiveFlags(html)) return false;

  const checks = [
    />\s*OFFLINE\s*</i,
    /check out this [\s\S]{0,180}? stream from \d+\s+(minute|minutes|hour|hours|day|days)\s+ago/i,
    /stream from \d+\s+(minute|minutes|hour|hours|day|days)\s+ago/i,
    /data-a-target=["']channel-offline-info["']/i,
    /data-a-target=["']offline-channel-main-content["']/i
  ];

  return checks.some((re) => re.test(html));
}

  async function probeChannelPagesLive(cfg, need) {
    const priority = Array.isArray(cfg?.priority) ? cfg.priority : [];
    const ordered = uniq([...(priority || []), ...getConfiguredUnion(cfg)]);

    if (ordered.length === 0) {
      log("probe_error", "No configured channels available for probe");
      return [];
    }

    const concurrency = 6;
    const hardCap = Math.min(Math.max(need || 4, 1), ordered.length);
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
          const isLive = htmlHasLiveFlags(html);
          const isOffline = htmlLooksOffline(html);

          log("probe_channel", {
            login,
            isLive,
            isOffline,
            html_len: html.length
          });

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
    log("probe_result", { count: result.length, channels: result });
    return result;
  }

  async function htmlFetchFollowing() {
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
    const direct =
      cfg?.auth_token ||
      cfg?.oauth_token ||
      cfg?.access_token_web ||
      cfg?.access_token_user ||
      cfg?.access_token;

    if (direct) return String(direct);

    try {
      const all = await new Promise((r) => chrome.storage.local.get(null, r));
      const fromStore =
        all?.auth_token ||
        all?.oauth_token ||
        all?.access_token_web ||
        all?.access_token_user ||
        all?.access_token;

      if (fromStore) return String(fromStore);
    } catch {}

    return "";
  }

  async function gqlFollowingLiveLoginsWithToken(userToken) {
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
        follows: Array.isArray(cfg?.follows) ? cfg.follows.length : 0,
        priority: Array.isArray(cfg?.priority) ? cfg.priority.length : 0,
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

      const capNum = Math.max(1, Number(cfg?.max_tabs || 4) || 4);
      const found = new Set();

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
          if (found.size >= capNum) break;
        }

        log("live_merge", {
          source,
          raw_count: Array.isArray(list) ? list.length : 0,
          filtered_count: filtered.length,
          added,
          total: found.size,
          target: capNum,
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
        if (viaHelix.length > 0) addFound(viaHelix, "helix");
        else log("live_check", "Helix method returned no results");
      }

      const tok = await getWebOAuthTokenFromConfig(cfg);
      if (found.size < capNum && tok) {
        log("live_check", "Trying GQL method");
        const viaGql = await gqlFollowingLiveLoginsWithToken(tok);
        if (viaGql.length > 0) addFound(viaGql, "gql");
        else log("live_check", "GQL method returned no results");
      }

      if (found.size < capNum && configured.length > 0) {
        log("live_check", `Trying probe method (cap: ${capNum})`);
        const viaProbe = await probeChannelPagesLive(cfg, configured.length);
        if (viaProbe.length > 0) addFound(viaProbe, "probe");
        else log("live_check", "Probe method returned no results");
      }

      if (
        found.size < capNum &&
        !cfg?.client_id &&
        !cfg?.access_token
      ) {
        log("live_check", "Trying HTML following method");
        const viaHtml = filterConfigured(await htmlFetchFollowing(), cfg);
        if (viaHtml.length > 0) addFound(viaHtml, "html_following");
        else log("live_check", "HTML following method returned no configured results");
      } else {
        log("live_check", "Skipping HTML following method");
      }

      const allowTabScrapeFallback =
      cfg?.debug_allow_tab_scrape_fallback === true ||
      cfg?.debug_allow_tab_scrape_fallback === "true";

      if (found.size < capNum && allowTabScrapeFallback) {
        log("live_check", "Trying tab scrape fallback (debug-enabled)");
        const viaTab = filterConfigured(await htmlScrapeViaTab(), cfg);
        if (viaTab.length > 0) addFound(viaTab, "html_tab");
        else log("live_check", "Tab scrape method returned no configured results");
      } else if (found.size < capNum) {
        log("live_check", "Skipping tab scrape fallback (disabled for normal polling)");
      }

      const result = [...found];
      log("live_found", {
        count: result.length,
        channels: result,
        configured
      });

      return new Set(result);
    } catch (e) {
      log("live_error", String(e));
      return new Set();
    }
  };

  self.bgLive = L;
})();