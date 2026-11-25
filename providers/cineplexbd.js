// CinePlexBD provider for Nuvio Local Scrapers (movies). Works on BDIX connections.
var TMDB_KEY = "10d2fc3b3aabcd9b135b95f4b6529580";
var SITE = "http://cineplexbd.net";

function same(a, b) {
  var x = String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  var y = String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return x !== "" && x === y;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
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

async function searchSite(term) {
  var res = await fetchT(SITE + "/search_ajax.php?q=" + encodeURIComponent(term) + "&limit=30");
  var data = await res.json();
  return (data && data.results) || [];
}

// Pull video links (absolute or site-relative) out of the player page HTML
function extractLinks(html) {
  html = String(html || "").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  var re = /(?:https?:\/\/[^"'<>\s\\]+|\/v\/[^"'<>\s\\]+?)\.(?:mp4|mkv|avi|webm|m3u8)(?:\?[^"'<>\s\\]*)?/gi;
  var seen = {};
  var out = [];
  var m;
  while ((m = re.exec(html)) !== null) {
    var u = m[0].replace(/ /g, "%20");
    if (u.charAt(0) === "/") u = SITE + u;
    if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(u)) continue;
    if (seen[u]) continue;
    seen[u] = true;
    out.push(u);
  }
  return out;
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
    [/ddp?[ ._]?5[ ._]?1|5\.1/i, "5.1"]
  ].forEach(function (t) {
    if (t[0].test(text) && tags.indexOf(t[1]) < 0) tags.push(t[1]);
  });
  var q = text.match(/(2160|1080|720|480)p/i);
  return { q: q ? q[1] + "p" : (/4k|uhd/i.test(text) ? "4K" : ""), tags: tags };
}

async function buildMovie(r) {
  var html = await fetchT(SITE + "/player.php?id=" + r.id).then(function (x) { return x.text(); });
  var links = extractLinks(html);
  return links.map(function (u) {
    var file = safeDecode(u.split("?")[0].split("/").pop());
    var info = parseInfo(file + " " + (r.resolution || ""));
    var d = [];
    if (info.q) d.push(info.q);
    d = d.concat(info.tags);
    var ext = file.indexOf(".") >= 0 ? file.split(".").pop().toUpperCase() : "";
    if (ext && ext.length <= 4) d.push(ext);
    var cat = String(r.category || "").trim();
    if (cat) d.push(cat);
    return {
      name: "CPBD • " + d.join(" • "),
      title: r.title + " (" + r.year + ")\n" + file,
      url: u,
      quality: info.q || "Unknown"
    };
  });
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    // Only movies are supported so far
    if (mediaType !== "movie") return [];

    var tmRes = await fetchT("https://api.themoviedb.org/3/movie/" + tmdbId + "?api_key=" + TMDB_KEY);
    var tm = await tmRes.json();
    var title = tm.title || tm.original_title;
    if (!title) return [];
    var year = Number((tm.release_date || "").slice(0, 4)) || 0;

    var clean = title.replace(/['’`"]/g, "").replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    var tries = [clean];
    var words = clean.split(" ").filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (words[0] && words[0] !== clean) tries.push(words[0]);

    var hits = [];
    for (var i = 0; i < tries.length && hits.length === 0; i++) {
      var list = await searchSite(tries[i]).catch(function () { return []; });
      hits = list.filter(function (r) {
        if (r.type && r.type !== "movie") return false;
        if (!same(r.title, title) && !same(r.title, clean)) return false;
        if (!year || !r.year) return true;
        return Math.abs(Number(r.year) - year) <= 1;
      });
    }
    if (!hits.length) return [];

    var results = await Promise.all(hits.map(function (r) {
      return buildMovie(r).catch(function () { return []; });
    }));
    return results.reduce(function (a, b) { return a.concat(b); }, []);
  } catch (e) {
    return [];
  }
}

module.exports = { getStreams: getStreams };
