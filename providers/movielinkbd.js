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

// The web player plays extra languages as a separate audio file synced to the video, which a single
// Nuvio stream can't carry. So we only report which audio the stream has (default) and what else exists.
function audioInfo(pd) {
  var arr = (pd && pd.audio) || [];
  var main = "";
  var others = [];
  if (Array.isArray(arr)) {
    arr.forEach(function (a) {
      if (!a || typeof a !== "object") return;
      var label = String(a.label || a.language || a.lang || "");
      if (!label) return;
      if (a.is_default && !main) main = label;
      else others.push(label);
    });
    if (!main && others.length) main = others.shift();
  }
  return { main: main, others: others };
}

// ---------- build streams for one site entry ----------
// ---------- download files (muxed MKV/MP4, can contain several audio tracks) ----------
function hasFileLinks(html) {
  return /href=["']\/file\/[A-Za-z0-9_\-]{40,}["']/.test(String(html || ""));
}

function stripTags(t) {
  return String(t || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

// anchors like: Download [1080p • 1.3 GB]  ->  [{href, quality, size, ctx}]
function listFileLinks(html) {
  html = String(html || "");
  var out = [];
  var seen = {};
  var re = /<a\b[^>]*href=["'](\/file\/[A-Za-z0-9_\-]{40,})["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    if (seen[m[1]]) continue;
    seen[m[1]] = true;
    var text = stripTags(m[2]);
    var qm = text.match(/\[\s*([^•\]]+?)\s*•\s*([^\]]+?)\s*\]/);
    var before = stripTags(html.slice(Math.max(0, m.index - 300), m.index));
    out.push({
      href: m[1],
      quality: qm ? qm[1].trim() : "",
      size: qm ? qm[2].replace(/\s+/g, "") : "",
      ctx: before + " " + text
    });
  }
  return out;
}

function ctxHasEpisode(ctx, season, episode) {
  var se = new RegExp("S0*" + Number(season) + "\\s*[._ -]?\\s*E0*" + Number(episode) + "(?![0-9])", "i");
  if (se.test(ctx)) return true;
  var ep = new RegExp("(?:^|[^a-z0-9])(?:EP|E|Episode)[ ._-]*0*" + Number(episode) + "(?![0-9])", "i");
  return ep.test(ctx.slice(-120));
}

function fileTags(name) {
  var tags = [];
  [
    [/blu-?ray|bdrip|brrip/i, "BluRay"],
    [/web-?dl/i, "WEB-DL"],
    [/web-?rip/i, "WEBRip"],
    [/hdrip/i, "HDRip"],
    [/x265|hevc|h[ ._]?265/i, "HEVC"],
    [/x264|h[ ._]?264/i, "x264"],
    [/10bit/i, "10-bit"],
    [/\bhdr(10)?\b/i, "HDR"],
    [/esub/i, "ESub"],
    [/atmos/i, "Atmos"]
  ].forEach(function (t) {
    if (t[0].test(name) && tags.indexOf(t[1]) < 0) tags.push(t[1]);
  });
  var dm = name.match(/dual\s*\[([^\]]+)\]/i);
  if (dm) tags.push("Dual Audio (" + dm[1] + ")");
  else if (/dual|multi[ ._-]?audio/i.test(name)) tags.push("Dual Audio");
  return tags;
}

// /file/<t1> -> find FSL button -> /file/<t2> -> direct fsl-cdn /d/ link
async function resolveFile(link, referer) {
  var url1 = SITE + link.href;
  var h1 = await getText(url1);
  var tm = h1.match(/<title>\s*(?:MovieLinkBD\.com\s*-\s*)?([^<]+?)\s*<\/title>/i);
  var name = tm ? tm[1].trim() : "";
  var sm = h1.match(/File Size<\/span>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/i);
  var size = sm ? sm[1].replace(/\s+/g, "") : link.size;

  var tag = h1.match(/<a\b[^>]*data-host=["']fsl["'][^>]*>/i);
  var hm = tag && tag[0].match(/href=["']([^"']+)["']/i);
  if (!hm) return null;
  var href2 = hm[1].replace(/&amp;/g, "&");
  var url2 = /^https?:/i.test(href2) ? href2 : SITE + href2;

  var direct = url2;
  if (!/workers\.dev\/d\//i.test(url2)) {
    var h2 = await getText(url2);
    var dm = h2.replace(/&amp;/g, "&").match(/https?:\/\/[^"'<>\s\\]*workers\.dev\/d\/[^"'<>\s\\]+/i);
    if (!dm) return null;
    direct = dm[0];
  }
  return { url: direct, name: name, size: size, page: url2 };
}

async function buildFiles(pageHtml, pageUrl, p, isTv, season, episode) {
  var links = listFileLinks(pageHtml);
  if (isTv) {
    links = links.filter(function (l) { return ctxHasEpisode(l.ctx, season, episode); });
  }
  if (!links.length) return [];
  var tag = isTv ? "S" + pad(season) + "E" + pad(episode) : "";
  var res = await Promise.all(links.slice(0, 6).map(function (l) {
    return resolveFile(l, pageUrl).then(function (f) {
      if (!f) return null;
      var fname = f.name || "";
      var q = (fname.match(/(2160|1080|720|480)p/i) || [])[0] || l.quality || "";
      var ext = (fname.match(/\.([a-z0-9]{2,4})$/i) || [])[1];
      var d = [];
      if (tag) d.push(tag);
      if (q) d.push(String(q).toLowerCase());
      d = d.concat(fileTags(fname));
      if (f.size) d.push(f.size);
      if (ext) d.push(ext.toUpperCase());
      return {
        name: "MLBD File • " + d.join(" • "),
        title: (p.core || "") + (tag ? " " + tag : "") + "\n" + (fname || f.url.split("/").pop()),
        url: f.url,
        quality: /^\d{3,4}p$/i.test(q) ? String(q).toLowerCase() : (/4k/i.test(l.quality) ? "2160p" : "Unknown"),
        headers: { "Referer": f.page, "Origin": SITE, "User-Agent": UA }
      };
    }).catch(function () { return null; });
  }));
  return res.filter(Boolean);
}

async function buildHls(p, playerUrl, pageHtml, isTv, season, episode, seenIds) {
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

  var au = audioInfo(pd);
  var expanded = masters.map(function (m) {
    return { url: m.url, lang: au.main || String(pd.langs || "") };
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
      title: heading +
        (au.others.length ? "\nOther audio on site: " + au.others.join(", ") : "") +
        (sizes.length && !isTv ? "\nFiles: " + sizes.join(" • ") : ""),
      url: m.url,
      quality: q || "Unknown",
      headers: { "Referer": playerUrl, "Origin": SITE, "User-Agent": UA }
    };
  }));
}

async function buildEntry(p, isTv, season, episode, seenIds) {
  var paths = isTv ? ["/series/", "/movie/"] : ["/movie/", "/series/"];
  var pageHtml = "";
  var pageUrl = "";
  var playerUrl = "";
  for (var i = 0; i < paths.length; i++) {
    var url = SITE + paths[i] + p.slug;
    var html = await getText(url).catch(function () { return ""; });
    var pu = findPlayerUrl(html);
    if (pu || hasFileLinks(html)) { pageHtml = html; pageUrl = url; playerUrl = pu; break; }
  }
  if (!pageHtml) return [];

  var out = [];
  var jobs = [];
  if (playerUrl) jobs.push(buildHls(p, playerUrl, pageHtml, isTv, season, episode, seenIds).catch(function () { return []; }));
  jobs.push(buildFiles(pageHtml, pageUrl, p, isTv, season, episode).catch(function () { return []; }));
  var parts = await Promise.all(jobs);
  parts.forEach(function (x) { out = out.concat(x); });
  return out;
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
