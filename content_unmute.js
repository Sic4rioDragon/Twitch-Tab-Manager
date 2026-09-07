(() => {
  if (window.__TTM_PLAYER_HELPER__) return;
  window.__TTM_PLAYER_HELPER__ = true;

  const $ = (sel) => document.querySelector(sel);

  const state = {
  settings: {
    force_unmute: false,
    unmute_streams: false,
    force_resume: false,
    autoplay_streams: false,
    startup_muted: false
  },
  controlEnabled: true,
  loopStarted: false,
  lastStatusSentAt: 0,
  directUnmuteBlockedUntil: 0,
  playBlockedUntil: 0,
  lastGuardLogAt: 0,
  lastVideoProgressAt: 0,
  lastVideoTime: 0,
  firstNoVideoAt: 0,
  startupMutedVideo: null,
  startupPreMuted: null,
  mutedByTTM: false,
  startupMuteAttempted: false,
  startupChannel: ""
  };

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isOnChannelPage() {
    try {
      const url = new URL(location.href);
      if (url.hostname !== "www.twitch.tv") return false;

      const first = url.pathname.split("/").filter(Boolean)[0] || "";
      const blocked = new Set([
        "directory",
        "p",
        "videos",
        "friends",
        "inventory",
        "drops",
        "settings",
        "messages",
        "login",
        "logout",
        "downloads",
        "moderator"
      ]);

      return !!first && !blocked.has(first);
    } catch {
      return false;
    }
  }

  function isAdPlaying() {
    return !!(
      document.querySelector('[data-test-selector="ad-banner-default-text"]') ||
      document.querySelector('[data-a-player-state="advertising"]')
    );
  }

  function getVideo() {
    return $("video");
  }

  function getMuteButton() {
    return $('[data-a-target="player-mute-unmute-button"]');
  }

  function getPlayButton() {
    return $('[data-a-target="player-play-pause-button"]');
  }

  function getChannelLogin() {
    try {
      const url = new URL(location.href);
      return (url.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
    } catch {
      return "";
    }
  }

  function canSafelyForceUnmute() {
    return !document.hidden && document.hasFocus();
  }
function guardLog(kind, extra = {}) {
  const now = Date.now();
  if (now - state.lastGuardLogAt < 10000) return;
  state.lastGuardLogAt = now;

  try {
    chrome.runtime.sendMessage({
      type: "TTM_PLAYER_STATUS",
      ...collectStatus(),
      guard_event: kind,
      ...extra
    }, () => {});
  } catch {}
}

function canTryDirectUnmute(video) {
  if (!video) return false;
  if (Date.now() < state.directUnmuteBlockedUntil) return false;

  // Avoid poking too early before media is actually ready.
  if (typeof video.readyState === "number" && video.readyState < 2) return false;

  // User-facing tabs may unmute normally. TTM background tabs are browser-tab
  // muted, so once media is already progressing it is safe to restore the
  // Twitch player's own mute state without producing audible output.
  if (canSafelyForceUnmute()) return true;
  return !video.paused && Number(video.currentTime || 0) > 0.25;
}

function isUserGestureUnmuteError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("user didn't interact") ||
    msg.includes("user did not interact") ||
    msg.includes("play() failed") ||
    msg.includes("notallowederror") ||
    msg.includes("paused instead") ||
    msg.includes("element was paused instead")
  );
}

async function safeDirectUnmute(video) {
  if (!canTryDirectUnmute(video)) return false;

  try {
    video.muted = false;
    return !video.muted;
  } catch (err) {
    if (isUserGestureUnmuteError(err)) {
      state.directUnmuteBlockedUntil = Date.now() + (5 * 60 * 1000);
      guardLog("direct_unmute_backoff", { backoffMs: 5 * 60 * 1000 });
      return false;
    }

    state.directUnmuteBlockedUntil = Date.now() + 60000;
    guardLog("direct_unmute_error", { backoffMs: 60000 });
    return false;
  }
}

function canTryPlay(video) {
  if (!video) return false;
  if (Date.now() < state.playBlockedUntil) return false;
  return true;
}

async function safePlay(video) {
  if (!canTryPlay(video)) return false;
  if (!video?.paused) return true;

  try {
    await video.play();
    return !video.paused;
  } catch (err) {
    // Only if Chromium rejects the first unmuted play attempt do we use a
    // temporary media-element mute. This fallback is allowed once per channel
    // page, then the Twitch player is restored immediately after playback
    // starts. The browser TAB remains muted independently the whole time.
    const startupMuteAllowed = !!state.settings?.startup_muted &&
      !state.startupMuteAttempted &&
      Number(video?.currentTime || 0) < 0.25;
    if (isUserGestureUnmuteError(err) && video && startupMuteAllowed) {
      state.startupMuteAttempted = true;
      try {
        state.startupMutedVideo = video;
        state.startupPreMuted = !!video.muted;
        state.mutedByTTM = false;
        if (!video.muted) {
          video.muted = true;
          state.mutedByTTM = true;
        }
        await video.play();
        if (!video.paused) {
          state.playBlockedUntil = 0;
          const restoreVideo = video;
          const shouldRestoreUnmuted = state.mutedByTTM && !state.startupPreMuted;
          setTimeout(() => {
            try {
              if (shouldRestoreUnmuted && restoreVideo.muted) restoreVideo.muted = false;
            } catch {}
            if (state.startupMutedVideo === restoreVideo) {
              state.startupMutedVideo = null;
              state.startupPreMuted = null;
              state.mutedByTTM = false;
            }
          }, 250);
          guardLog("play_muted_background_fallback", {
            backgroundSafe: true,
            temporary: true,
            playerMuteRestoreMs: 250
          });
          return true;
        }
      } catch {}
    }

    const backoffMs = 60000;
    state.playBlockedUntil = Date.now() + backoffMs;
    guardLog("play_backoff", { backoffMs });
    return false;
  }
}

function updateVideoProgress(video) {
  if (!video) {
    if (!state.firstNoVideoAt) state.firstNoVideoAt = Date.now();
    state.lastVideoProgressAt = 0;
    state.lastVideoTime = 0;
    return;
  }

  state.firstNoVideoAt = 0;

  const now = Date.now();
  const currentTime = Number(video.currentTime || 0);

  if (currentTime > state.lastVideoTime + 0.15) {
    state.lastVideoProgressAt = now;
    state.lastVideoTime = currentTime;
    return;
  }

  if (!state.lastVideoProgressAt) {
    state.lastVideoProgressAt = now;
    state.lastVideoTime = currentTime;
  }
}

function isLikelyStuckStarting(video) {
  if (isAdPlaying()) return false;

  if (!video) {
    return !!state.firstNoVideoAt && (Date.now() - state.firstNoVideoAt >= 12000);
  }

  const readyState = Number(video.readyState || 0);
  const currentTime = Number(video.currentTime || 0);
  const stalledFor = state.lastVideoProgressAt ? (Date.now() - state.lastVideoProgressAt) : 0;

  return (
    readyState >= 2 &&
    currentTime < 1.5 &&
    stalledFor >= 12000
  );
}
  async function clickUnmuteIfNeeded() {
    const btn = getMuteButton();
    if (!btn) return false;

    const label = btn.getAttribute("aria-label") || "";
    if (/unmute/i.test(label)) {
      btn.click();
      return true;
    }

    return false;
  }

  async function clickPlayIfNeeded() {
    const btn = getPlayButton();
    if (!btn) return false;

    const label = btn.getAttribute("aria-label") || "";
    if (/play/i.test(label)) {
      btn.click();
      return true;
    }

    return false;
  }

  function collectStatus() {
  const video = getVideo();
  const ad = isAdPlaying();

  return {
    login: getChannelLogin(),
    url: location.href,
    hasVideo: !!video,
    paused: !!video?.paused,
    muted: !!video?.muted,
    volume: typeof video?.volume === "number" ? video.volume : null,
    readyState: typeof video?.readyState === "number" ? video.readyState : -1,
    currentTime: typeof video?.currentTime === "number" ? video.currentTime : 0,
    networkState: typeof video?.networkState === "number" ? video.networkState : -1,
    playerElement: !!document.querySelector('[data-a-target="video-player"], .video-player, video'),
    progressAgeMs: state.lastVideoProgressAt ? Math.max(0, Date.now() - state.lastVideoProgressAt) : -1,
    stalledStart: isLikelyStuckStarting(video),
    adPlaying: ad,
    visible: !document.hidden,
    focused: document.hasFocus()
  };
  }

  function shouldSendStatus(force = false) {
    const now = Date.now();

    if (force) {
      state.lastStatusSentAt = now;
      return true;
    }

    if (now - state.lastStatusSentAt >= 5000) {
      state.lastStatusSentAt = now;
      return true;
    }

    return false;
  }

  async function sendStatus(force = false) {
    if (!isOnChannelPage()) return;
    if (!shouldSendStatus(force)) return;

    try {
      chrome.runtime.sendMessage({
        type: "TTM_PLAYER_STATUS",
        ...collectStatus()
      }, () => {});
    } catch {}
  }

  async function enforceOnce() {
  if (!isOnChannelPage()) return;

  if (isAdPlaying()) {
    await sendStatus();
    return;
  }

  const opts = state.settings || {};
  const video = getVideo();
  const currentChannel = getChannelLogin();

  // Twitch is a SPA and may swap the video element while staying in the same
  // content-script instance. Reset the one-shot startup fallback only when the
  // actual channel changes, never merely because Twitch replaced <video>.
  if (currentChannel && state.startupChannel !== currentChannel) {
    state.startupChannel = currentChannel;
    state.startupMuteAttempted = false;
    state.startupMutedVideo = null;
    state.startupPreMuted = null;
    state.mutedByTTM = false;
    state.playBlockedUntil = 0;
  }

  updateVideoProgress(video);

  // A selected/user-facing Twitch tab is observation-only. The background
  // sends TTM_ENFORCE_PAUSE when a managed tab becomes selected.
  if (!state.controlEnabled) {
    await sendStatus();
    return;
  }

  // Never proactively mute Twitch's player. startup_muted now means only that
  // safePlay() is permitted to use one very short muted-autoplay fallback if an
  // ordinary play() is rejected. If that fallback was still pending, restore
  // the player's prior state as soon as startup mode ends.
  if (!opts.startup_muted && video) {
    const forcePlayerUnmuted = !!(opts.force_unmute || opts.unmute_streams);

    if (state.startupMutedVideo === video && state.mutedByTTM) {
      const desiredMuted = forcePlayerUnmuted ? false : !!state.startupPreMuted;
      try {
        if (video.muted !== desiredMuted) video.muted = desiredMuted;
      } catch {}
      state.startupMutedVideo = null;
      state.startupPreMuted = null;
      state.mutedByTTM = false;
    }

    if (forcePlayerUnmuted) {
      await clickUnmuteIfNeeded();
      await safeDirectUnmute(video);
    }
  }

  if (opts.force_resume || opts.autoplay_streams) {
    await clickPlayIfNeeded();

    if (video?.paused) {
      await safePlay(video);
    }
  }

  if (isLikelyStuckStarting(video)) {
    guardLog("stalled_start_detected", {
      hasVideo: !!video,
      currentTime: Number(video?.currentTime || 0),
      readyState: Number(video?.readyState || -1)
    });

    await clickPlayIfNeeded();

    if (video) {
      await safePlay(video);
    }
  }

  await sendStatus();
}

  async function startLoop() {
    if (state.loopStarted) return;
    state.loopStarted = true;

    while (true) {
      try {
        await enforceOnce();
      } catch {}
      await wait(2500);
    }
  }

  document.addEventListener("visibilitychange", () => {
    enforceOnce().catch(() => {});
  });

  window.addEventListener("focus", () => {
    enforceOnce().catch(() => {});
  });

  window.addEventListener("pageshow", () => {
    enforceOnce().catch(() => {});
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TTM_ENFORCE" && msg?.settings) {
      state.settings = { ...state.settings, ...msg.settings };
      state.controlEnabled = true;
      enforceOnce().catch(() => {});
      startLoop().catch(() => {});
      sendResponse?.({ ok: true });
      return true;
    }

    if (msg?.type === "TTM_ENFORCE_PAUSE") {
      state.controlEnabled = false;
      sendStatus(true).catch(() => {});
      sendResponse?.({ ok: true, paused_control: true });
      return true;
    }

    if (msg?.type === "TTM_ENFORCE_NOW") {
      enforceOnce().catch(() => {});
      sendResponse?.({ ok: true });
      return true;
    }

    if (msg?.type === "TTM_GET_PLAYER_STATUS") {
      sendResponse?.({ ok: true, ...collectStatus() });
      return true;
    }
  });

  startLoop().catch(() => {});
})();