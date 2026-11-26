// MovieLinkBD provider for Nuvio Local Scrapers (movies + series, best-effort for series).
// Flow: TMDB title -> site search index -> title page -> embedded /p/ player -> window.__PD2 -> HLS master.
var TMDB_KEY = "10d2fc3b3aabcd9b135b95f4b6529580";
var SITE = "https://movielinkbd.tv";
var UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

function same(a, b) {
  var x = String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  var y = String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return x !== "" && x === y;
}

function pad(n) {
  n = Number(n);
  return n < 10 ? "0" + n : String(n);
}

// Fetch with a timeout so a slow/unreachable server can't hang the scraper
function fetchT(url, opts, ms) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; reject(new Error("timeout")); } }, ms || 8000);
    fetch(url, opts).then(
      function (r) { if (!done) { done = true; clearTimeout(t); resolve(r); } },
      function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } }
    );
  });
}

async function getText(url, ms) {
  var r = await fetchT(url, { headers: { "User-Agent": UA } }, ms);
  return await r.text();
}

async function getJson(url, ms) {
  var r = await fetchT(url, { headers: { "User-Agent": UA } }, ms);
  return await r.json();
}

// ---------- search (site publishes a prefix-sharded title index) ----------
async function loadShard(v, prefix) {
  var list = await getJson(SITE + "/search-suggest/" + v + "/" + encodeURIComponent(prefix)).catch(function () { return []; });
  return Array.isArray(list) ? list : [];
}

// entry: [title, slug, poster, type, year, flag]
function parseEntry(e) {
  var title = String(e[0] || "");
  var core = title.split(/[\(\[]/)[0].trim();
  var ym = title.match(/\((\d{4})\)/);
  return {
    title: title,
    core: core,
    slug: e[1],
    type: String(e[3] || ""),
    year: ym ? Number(ym[1]) : (Number(e[4]) || 0),
    year2: Number(e[4]) || 0
  };
}

function isSeriesEntry(p) {
  return /series|drama|anime/i.test(p.type) || /\bS\d{1,2}\b|season|\bep\b/i.test(p.title);
}

async function findEntries(title, year, isTv) {
  var man = await getJson(SITE + "/search-suggest/manifest?r=" + Math.floor(Math.random() * 1e8));
  var v = man && man.v;
  if (!v) return [];
  var clean = title.replace(/['’`"]/g, "").replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  var words = clean.toLowerCase().split(" ").filter(function (w) { return w.length >= 2; });
  var order = words.slice().sort(function (a, b) { return b.length - a.length; });
  var seenPrefix = {};
  var hits = [];
  for (var i = 0; i < order.length && i < 3 && hits.length === 0; i++) {
    var prefix = order[i].slice(0, 2);
    if (seenPrefix[prefix]) continue;
    seenPrefix[prefix] = true;
    var list = await loadShard(v, prefix);
    hits = list.map(parseEntry).filter(function (p) {
      if (/18plus/i.test(p.type)) return false;
      if (!same(p.core, title) && !same(p.core, clean)) return false;
      if (isTv) return isSeriesEntry(p);
      if (isSeriesEntry(p)) return false;
      if (!year) return true;
      return Math.abs(p.year - year) <= 1 || Math.abs(p.year2 - year) <= 1;
    });
  }
  return hits;
}

// ---------- page parsing ----------
function findPlayerUrl(html) {
  html = String(html || "").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  var m = html.match(/<iframe[^>]+src=["']([^"']*\/p\/[A-Za-z0-9_\-]{20,})["']/i) ||
          html.match(/(\/p\/[A-Za-z0-9_\-]{30,})/);
  if (!m) return "";
  var u = m[1];
  if (/^https?:\/\//i.test(u)) return u;
  if (u.charAt(0) !== "/") u = "/" + u;
  return SITE + u;
}

function extractPD2(html) {
  html = String(html || "");
  var i = html.indexOf("__PD2");
  if (i >= 0) {
    var s = html.indexOf("{", i);
    if (s >= 0) {
      var depth = 0, inStr = false, esc = false;
      for (var j = s; j < html.length; j++) {
        var c = html.charAt(j);
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(html.slice(s, j + 1)); } catch (e) { break; }
          }
        }
      }
    }
  }
  var mm = html.replace(/\\\//g, "/").match(/"master"\s*:\s*"(https?:[^"]+)"/);
  if (mm) return { master: mm[1], episodes: [], langs: "" };
  return null;
}

function listSizes(html) {
  var out = [];
  var re = /Download\s*\[\s*([^\]•]+?)\s*•\s*([^\]]+?)\s*\]/g;
  var m;
  while ((m = re.exec(String(html || ""))) !== null && out.length < 6) {
    out.push(m[1].trim() + " " + m[2].replace(/\s+/g, "").trim());
  }
  return out;
}

async function bestQuality(masterUrl, referer) {
  try {
    var txt = await (await fetchT(masterUrl, { headers: { "User-Agent": UA, "Referer": referer, "Origin": SITE } }, 6000)).text();
    var best = 0;
    var re = /RESOLUTION=(\d+)x(\d+)/g;
    var m;
    while ((m = re.exec(txt)) !== null) {
      // use width so widescreen/scope encodes (e.g. 1920x800) still count as 1080p
      var w = Number(m[1]);
      var q = w >= 3000 ? 2160 : w >= 1800 ? 1080 : w >= 1200 ? 720 : w >= 800 ? 480 : Number(m[2]);
      if (q > best) best = q;
    }
    return best ? best + "p" : "";
  } catch (e) { return ""; }
}

// ---------- series episode picking ----------
function seasonOfTitle(title) {
  var m = String(title).match(/Season[ ._-]*0*(\d{1,2})(?:\s*-\s*0*(\d{1,2}))?/i) ||
          String(title).match(/\bS0*(\d{1,2})(?:\s*-\s*S?0*(\d{1,2}))?\b/);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2] || m[1]) };
}

function pickEpisodes(pd, entryTitle, season, episode) {
  var eps = (pd && pd.episodes) || [];
  var range = seasonOfTitle(entryTitle);
  if (range && (Number(season) < range.from || Number(season) > range.to)) return [];
  return eps.filter(function (e) {
    if (!e || !e.master) return false;
    var label = String(e.label || "");
    var se = label.match(/S0*(\d{1,2})\s*[._ -]?\s*E0*(\d{1,3})/i) ||
             label.match(/Season[ ._-]*0*(\d{1,2}).*?(?:Ep|Episode|E)[ ._-]*0*(\d{1,3})/i);
    if (se) return Number(se[1]) === Number(season) && Number(se[2]) === Number(episode);
    if (range && range.from !== range.to) return false; // multi-season page without season in labels: can't tell
    var n = Number(e.number) || 0;
    var end = Number(e.num_end) || 0;
    return n === Number(episode) || (end > n && Number(episode) >= n && Number(episode) <= end);
  });
}

// Extra audio tracks that come with their own playlist (e.g. English dub) -> [{label,url}]
function audioTracks(src) {
  var out = [];
  var arr = (src && src.audio) || [];
  if (!Array.isArray(arr)) return out;
  arr.forEach(function (a) {
    var url = "";
    var label = "";
    if (typeof a === "string") {
      if (/^https?:/i.test(a)) url = a;
    } else if (a && typeof a === "object") {
      ["master", "url", "src", "m3u8", "hls", "playlist", "uri", "file"].forEach(function (k) {
        if (!url && typeof a[k] === "string" && /^https?:/i.test(a[k])) url = a[k];
      });
      label = String(a.label || a.name || a.lang || a.language || "");
    }
    if (url) out.push({ label: label, url: url });
  });
  return out;
}

// ---------- build streams for one site entry ----------
async function buildEntry(p, isTv, season, episode, seenIds) {
  var pageHtml = "";
  var paths = isTv ? ["/series/", "/movie/"] : ["/movie/", "/series/"];
  var pageUrl = "";
  var playerUrl = "";
  for (var i = 0; i < paths.length && !playerUrl; i++) {
    pageUrl = SITE + paths[i] + p.slug;
    pageHtml = await getText(pageUrl).catch(function () { return ""; });
    playerUrl = findPlayerUrl(pageHtml);
  }
  if (!playerUrl) return [];

  var playerHtml = await getText(playerUrl);
  var pd = extractPD2(playerHtml);
  if (!pd) return [];
  // The index can list the same title twice; skip content we already handled
  var idKey = pd.id ? String(pd.id) : "";
  if (idKey) {
    if (seenIds[idKey]) return [];
    seenIds[idKey] = true;
  }

  var masters = [];
  if (isTv) {
    pickEpisodes(pd, p.title, season, episode).forEach(function (e) {
      masters.push({ url: e.master, label: e.label, src: e });
    });
  } else {
    var first = (pd.episodes && pd.episodes[0] && pd.episodes[0].master) || pd.master;
    if (pd.master || first) masters.push({ url: pd.master || first, label: "", src: pd });
  }
  if (!masters.length) return [];

  // main audio + any alternate audio tracks that have their own playlist
  var expanded = [];
  masters.forEach(function (m) {
    expanded.push({ url: m.url, lang: String(pd.langs || "") });
    audioTracks(m.src).forEach(function (a) {
      if (a.url !== m.url) expanded.push({ url: a.url, lang: a.label || "Alt audio" });
    });
  });

  var sizes = listSizes(pageHtml);
  var tag = isTv ? "S" + pad(season) + "E" + pad(episode) : "";
  return await Promise.all(expanded.map(async function (m) {
    var q = await bestQuality(m.url, playerUrl);
    var d = [];
    if (tag) d.push(tag);
    d.push(q ? "Auto (up to " + q + ")" : "Auto");
    d.push("HLS");
    if (m.lang) d.push(m.lang);
    var heading = (pd.title || p.core) + (tag ? " " + tag : "");
    return {
      name: "MLBD • " + d.join(" • "),
      title: heading + (sizes.length && !isTv ? "\nFiles: " + sizes.join(" • ") : ""),
      url: m.url,
      quality: q || "Unknown",
      headers: { "Referer": playerUrl, "Origin": SITE, "User-Agent": UA }
    };
  }));
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var isTv = mediaType === "tv" || mediaType === "series";
    if (mediaType !== "movie" && !isTv) return [];

    var tm = await getJson("https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + tmdbId + "?api_key=" + TMDB_KEY);
    var title = isTv ? (tm.name || tm.original_name) : (tm.title || tm.original_title);
    if (!title) return [];
    var year = Number(((isTv ? tm.first_air_date : tm.release_date) || "").slice(0, 4)) || 0;

    var hits = await findEntries(title, isTv ? 0 : year, isTv);
    if (!hits.length) return [];

    var seenIds = {};
    var results = [];
    for (var h = 0; h < hits.slice(0, 4).length; h++) {
      var part = await buildEntry(hits[h], isTv, season, episode, seenIds).catch(function () { return []; });
      results.push(part);
    }
    // Links are signed per request, so identical-looking copies have different URLs: dedupe by what's shown
    var seen = {};
    return results.reduce(function (a, b) { return a.concat(b); }, []).filter(function (x) {
      var key = x.name + "|" + x.title;
      if (seen[key] || seen[x.url]) return false;
      seen[key] = true;
      seen[x.url] = true;
      return true;
    });
  } catch (e) {
    return [];
  }
}

module.exports = { getStreams: getStreams };
