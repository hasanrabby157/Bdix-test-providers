// CinePlexBD provider for Nuvio Local Scrapers (movies + series). Works on BDIX connections.
var TMDB_KEY = "10d2fc3b3aabcd9b135b95f4b6529580";
var SITE = "http://cineplexbd.net";

function same(a, b) {
  var x = String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  var y = String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return x !== "" && x === y;
}

function pad(n) {
  n = Number(n);
  return n < 10 ? "0" + n : String(n);
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

function fmtSize(bytes) {
  bytes = Number(bytes);
  if (!bytes || bytes < 1) return "";
  var gb = bytes / 1073741824;
  if (gb >= 1) return gb.toFixed(2).replace(/\.?0+$/, "") + "GB";
  return Math.round(bytes / 1048576) + "MB";
}

// Fetch with a timeout so a slow/unreachable (non-BDIX) server can't hang the scraper
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

async function getText(url) {
  var r = await fetchT(url);
  return await r.text();
}

async function searchSite(term) {
  var res = await fetchT(SITE + "/search_ajax.php?q=" + encodeURIComponent(term) + "&limit=30");
  var data = await res.json();
  return (data && data.results) || [];
}

// Ask the server for the file size (Range request, then HEAD). Direct files only.
async function probeSize(url) {
  try {
    var r = await fetchT(url, { headers: { Range: "bytes=0-0" } }, 4000);
    var cr = (r.headers && r.headers.get && r.headers.get("content-range")) || "";
    var m = cr.match(/\/(\d+)\s*$/);
    if (m) return fmtSize(Number(m[1]));
  } catch (e) {}
  try {
    var h = await fetchT(url, { method: "HEAD" }, 4000);
    var cl = (h.headers && h.headers.get && h.headers.get("content-length")) || "";
    if (cl && Number(cl) > 1048576) return fmtSize(Number(cl));
  } catch (e) {}
  return "";
}

// Pull video links (absolute or site-relative, mp4/mkv or HLS) out of page HTML
function extractLinks(html) {
  html = String(html || "").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  var re = /(?:https?:\/\/[^"'<>\\]+?|\/(?:v|hls)\/[^"'<>\\]+?)\.(?:mp4|mkv|avi|webm)(?:\/master\.m3u8)?(?:\?[^"'<>\s\\]*)?/gi;
  var seen = {};
  var out = [];
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = m[0].replace(/ /g, "%20");
    if (u.charAt(0) === "/") u = SITE + u;
    if (/\/\/images?\d*\.|\/posters?\//i.test(u)) continue;
    if (seen[u]) continue;
    seen[u] = true;
    out.push(u);
  }
  return out;
}

function fileOf(u) {
  var parts = u.split("?")[0].split("/");
  var last = parts.pop();
  if (/^master\.m3u8$/i.test(last)) last = parts.pop();
  return safeDecode(last);
}

function parseInfo(text) {
  var tags = [];
  [
    [/blu-?ray|bdrip|brrip/i, "BluRay"],
    [/web-?dl/i, "WEB-DL"],
    [/web-?rip/i, "WEBRip"],
    [/hdrip/i, "HDRip"],
    [/dvdrip/i, "DVDRip"],
    [/hdcam|camrip|\bcam\b/i, "CAM"],
    [/x265|hevc|h[ ._]?265/i, "HEVC"],
    [/x264|h[ ._]?264/i, "x264"],
    [/10bit/i, "10-bit"],
    [/\bhdr(10)?\b/i, "HDR"],
    [/dual[ ._-]?audio|\bdual\b/i, "Dual Audio"],
    [/\bHC\b|hardcoded/i, "HC Subs"],
    [/esub/i, "ESub"],
    [/atmos/i, "Atmos"],
    [/ddp?[ ._]?5[ ._]?1|\b6CH\b|5\.1/i, "5.1"]
  ].forEach(function (t) {
    if (t[0].test(text) && tags.indexOf(t[1]) < 0) tags.push(t[1]);
  });
  var q = text.match(/(2160|1080|720|480)p/i);
  return { q: q ? q[1] + "p" : (/4k|uhd/i.test(text) ? "4K" : ""), tags: tags };
}

function seasonEpisodeOf(url) {
  var dec = safeDecode(url);
  var file = fileOf(url);
  var m = file.match(/S(\d{1,2})\s*[._ -]?\s*E(\d{1,3})/i);
  if (m) return { s: Number(m[1]), e: Number(m[2]) };
  var sf = dec.match(/Season[ ._-]*0*(\d{1,2})/i);
  var ef = file.match(/(?:^|[^a-z0-9])E(?:p|pisode)?[ ._-]*0*(\d{1,3})(?![0-9])/i) ||
           file.match(/(?:^|[^0-9])0*(\d{1,2})x0*(\d{1,3})(?![0-9])/i);
  if (sf && ef) return { s: Number(sf[1]), e: Number(ef[ef.length - 1]) };
  return null;
}

async function makeStream(u, r, heading, prefix) {
  var file = fileOf(u);
  var hls = /\.m3u8(\?|$)/i.test(u);
  var info = parseInfo(file + " " + (r.resolution || ""));
  var d = [];
  if (prefix) d.push(prefix);
  if (info.q) d.push(info.q);
  d = d.concat(info.tags);
  if (hls) {
    d.push("HLS");
  } else {
    var size = await probeSize(u);
    if (size) d.push(size);
    var ext = file.indexOf(".") >= 0 ? file.split(".").pop().toUpperCase() : "";
    if (ext && ext.length <= 4) d.push(ext);
  }
  var cat = String(r.category || "").trim();
  if (cat) d.push(cat);
  return {
    name: "CPBD • " + d.join(" • "),
    title: heading + "\n" + file,
    url: u,
    quality: info.q || "Unknown"
  };
}

async function buildMovie(r) {
  var html = await getText(SITE + "/player.php?id=" + r.id);
  var links = extractLinks(html);
  return await Promise.all(links.map(function (u) {
    return makeStream(u, r, r.title + " (" + r.year + ")", "");
  }));
}

async function buildSeries(r, season, episode) {
  var tag = "S" + pad(season) + "E" + pad(episode);
  var pages = [SITE + "/watch.php?id=" + r.id + "&season=" + Number(season), SITE + "/watch.php?id=" + r.id];
  var picked = [];
  for (var i = 0; i < pages.length && picked.length === 0; i++) {
    var html = await getText(pages[i]).catch(function () { return ""; });
    picked = extractLinks(html).filter(function (u) {
      var se = seasonEpisodeOf(u);
      return se && se.s === Number(season) && se.e === Number(episode);
    });
  }
  return await Promise.all(picked.map(function (u) {
    return makeStream(u, r, r.title + " " + tag, tag);
  }));
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var isTv = mediaType === "tv" || mediaType === "series";
    if (mediaType !== "movie" && !isTv) return [];

    var tmRes = await fetchT("https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + tmdbId + "?api_key=" + TMDB_KEY);
    var tm = await tmRes.json();
    var title = isTv ? (tm.name || tm.original_name) : (tm.title || tm.original_title);
    if (!title) return [];
    var dateStr = isTv ? tm.first_air_date : tm.release_date;
    var year = Number((dateStr || "").slice(0, 4)) || 0;

    var clean = title.replace(/['’`"]/g, "").replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    var tries = [clean];
    var words = clean.split(" ").filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (words[0] && words[0] !== clean) tries.push(words[0]);

    var hits = [];
    for (var i = 0; i < tries.length && hits.length === 0; i++) {
      var list = await searchSite(tries[i]).catch(function () { return []; });
      hits = list.filter(function (r) {
        var rIsTv = r.type === "series" || r.type === "tv";
        if (rIsTv !== isTv) return false;
        if (!same(r.title, title) && !same(r.title, clean)) return false;
        if (isTv || !year || !r.year) return true;
        return Math.abs(Number(r.year) - year) <= 1;
      });
    }
    if (!hits.length) return [];

    var results = await Promise.all(hits.map(function (r) {
      var p = isTv ? buildSeries(r, season, episode) : buildMovie(r);
      return p.catch(function () { return []; });
    }));
    return results.reduce(function (a, b) { return a.concat(b); }, []);
  } catch (e) {
    return [];
  }
}

module.exports = { getStreams: getStreams };
