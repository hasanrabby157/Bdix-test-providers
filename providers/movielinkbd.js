// MovieLinkBD provider for Nuvio Local Scrapers (movies + series, HLS).
// Flow: TMDB title -> site search-suggest shards -> slug -> /movie|/series/<slug>
//       -> player iframe (/p/<token>) -> window.__PD2 (master playlist per episode)
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

async function getJson(url) {
  var r = await fetchT(url);
  return await r.json();
}

async function getHtml(url, referer) {
  var r = await fetchT(url, { headers: { "Referer": referer || (SITE + "/"), "User-Agent": UA } });
  return await r.text();
}

// ---------- search (site's own suggest shards) ----------
function baseTitle(t) {
  return String(t || "").replace(/\s*[\(\[].*$/, "").trim();
}

function entryYear(e) {
  var m = String(e[0] || "").match(/\((\d{4})\)/);
  return m ? Number(m[1]) : Number(e[4]) || 0;
}

// season range from a title like "S01", "Season 2-5", "Season 1-2 Completed"
function seasonsOf(t) {
  var m = String(t || "").match(/Seasons?\s*0*(\d{1,2})(?:\s*[-–]\s*0*(\d{1,2}))?/i);
  if (m) return [Number(m[1]), Number(m[2] || m[1])];
  m = String(t || "").match(/\bS0*(\d{1,2})(?:\s*[-–]\s*S?0*(\d{1,2}))?\b/);
  if (m) return [Number(m[1]), Number(m[2] || m[1])];
  return null;
}

function isTvEntry(e) {
  var type = String(e[3] || "").toLowerCase();
  return type === "series" || type === "drama" || seasonsOf(e[0]) !== null || /\bEp\s*\d/i.test(e[0]);
}

async function findEntries(title, isTv, year, season) {
  var man = await getJson(SITE + "/search-suggest/manifest?r=" + Math.floor(Math.random() * 100000000));
  var v = man && man.v;
  if (!v) return [];

  var clean = title.replace(/['’`"]/g, "").replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  var words = clean.split(" ").filter(function (w) { return w.length >= 2; })
    .sort(function (a, b) { return b.length - a.length; });
  var prefixes = [];
  words.forEach(function (w) {
    var p = w.slice(0, 2);
    if (prefixes.indexOf(p) < 0 && prefixes.length < 3) prefixes.push(p);
  });

  for (var i = 0; i < prefixes.length; i++) {
    var list = await getJson(SITE + "/search-suggest/" + v + "/" + encodeURIComponent(prefixes[i])).catch(function () { return []; });
    if (!Array.isArray(list)) continue;
    var seen = {};
    var hits = list.filter(function (e) {
      if (!e || !e[1] || seen[e[1]] || e[5]) return false; // skip dupes and 18+ flagged
      seen[e[1]] = true;
      if (isTvEntry(e) !== isTv) return false;
      if (!same(baseTitle(e[0]), title)) return false;
      if (!isTv) {
        var y = entryYear(e);
        return !year || !y || Math.abs(y - year) <= 1;
      }
      var rng = seasonsOf(e[0]);
      return !rng || (season >= rng[0] && season <= rng[1]);
    });
    if (hits.length) return hits;
  }
  return [];
}

// ---------- page parsing ----------
function playerTokens(html) {
  var out = [];
  var re = /\/p\/([A-Za-z0-9_\-]{20,})/g;
  var m;
  while ((m = re.exec(String(html || ""))) !== null) {
    if (out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

function downloadQualities(html) {
  var out = [];
  var re = /Download\s*\[\s*([^\]•]+?)\s*•/g;
  var m;
  while ((m = re.exec(String(html || ""))) !== null) {
    var q = m[1].replace(/-HD$/i, "").trim();
    if (q && out.indexOf(q) < 0) out.push(q);
  }
  return out;
}

// window.__PD2 = {...}; -> parsed object (string-aware brace matching)
function parsePD2(html) {
  html = String(html || "");
  var i = html.indexOf("__PD2");
  if (i < 0) return null;
  var s = html.indexOf("{", i);
  if (s < 0) return null;
  var depth = 0, inStr = false, esc = false;
  for (var k = s; k < html.length; k++) {
    var c = html.charAt(k);
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(s, k + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function qualityRank(list) {
  var best = "";
  var order = ["480p", "720p", "1080p", "4K"];
  list.forEach(function (q) {
    var n = /4k/i.test(q) ? "4K" : (q.match(/(2160|1080|720|480)p/i) || [])[0] || "";
    if (n && order.indexOf(n.toLowerCase() === "4k" ? "4K" : n) > order.indexOf(best)) best = n;
  });
  return best;
}

async function loadPlayers(entry, isTv) {
  var order = isTv ? ["series", "movie"] : ["movie", "series"];
  var html = "";
  var pageUrl = "";
  for (var i = 0; i < order.length && !html; i++) {
    pageUrl = SITE + "/" + order[i] + "/" + entry[1];
    var h = await getHtml(pageUrl).catch(function () { return ""; });
    if (playerTokens(h).length) html = h;
  }
  if (!html) return [];
  var quals = downloadQualities(html);
  var tokens = playerTokens(html).slice(0, 4);
  var out = [];
  for (var j = 0; j < tokens.length; j++) {
    var ph = await getHtml(SITE + "/p/" + tokens[j], pageUrl).catch(function () { return ""; });
    var pd = parsePD2(ph);
    if (pd) out.push({ pd: pd, quals: quals, pageUrl: pageUrl });
  }
  return out;
}

function epSeason(ep, fallbackRange) {
  var m = String(ep.label || "").match(/S0*(\d{1,2})\s*[._ -]*E/i) || String(ep.label || "").match(/Season\s*0*(\d{1,2})/i);
  if (m) return Number(m[1]);
  if (fallbackRange && fallbackRange[0] === fallbackRange[1]) return fallbackRange[0];
  return null;
}

function makeStream(master, pd, quals, heading, prefix, referer) {
  var d = [];
  if (prefix) d.push(prefix);
  d.push("HLS Auto");
  var top = qualityRank(quals);
  if (quals.length) d.push(quals.join("/"));
  if (pd.langs) d.push(String(pd.langs));
  return {
    name: "MLBD • " + d.join(" • "),
    title: heading,
    url: master,
    quality: top || "Unknown",
    headers: { "Referer": SITE + "/", "Origin": SITE, "User-Agent": UA }
  };
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var isTv = mediaType === "tv" || mediaType === "series";
    if (mediaType !== "movie" && !isTv) return [];

    var tm = await getJson("https://api.themoviedb.org/3/" + (isTv ? "tv" : "movie") + "/" + tmdbId + "?api_key=" + TMDB_KEY);
    var title = isTv ? (tm.name || tm.original_name) : (tm.title || tm.original_title);
    if (!title) return [];
    var year = Number(((isTv ? tm.first_air_date : tm.release_date) || "").slice(0, 4)) || 0;

    var entries = await findEntries(title, isTv, year, Number(season) || 1);
    if (!entries.length) return [];

    var tag = isTv ? "S" + pad(season) + "E" + pad(episode) : "";
    var results = await Promise.all(entries.map(async function (entry) {
      try {
        var loaded = await loadPlayers(entry, isTv);
        var out = [];
        var rng = seasonsOf(entry[0]);
        loaded.forEach(function (L) {
          var eps = Array.isArray(L.pd.episodes) ? L.pd.episodes : [];
          if (!isTv) {
            var m = L.pd.master || (eps[0] && eps[0].master);
            if (m) out.push(makeStream(m, L.pd, L.quals, (L.pd.title || entry[0]), "", L.pageUrl));
            return;
          }
          eps.forEach(function (ep) {
            if (!ep || !ep.master) return;
            var n = Number(ep.number), end = Number(ep.num_end) || n;
            if (!(Number(episode) >= n && Number(episode) <= end)) return;
            var es = epSeason(ep, rng);
            if (es !== null && es !== Number(season)) return;
            out.push(makeStream(ep.master, L.pd, L.quals, (L.pd.title || entry[0]) + " " + tag + (ep.label ? " (" + ep.label + ")" : ""), tag, L.pageUrl));
          });
        });
        return out;
      } catch (e) { return []; }
    }));
    return results.reduce(function (a, b) { return a.concat(b); }, []);
  } catch (e) {
    return [];
  }
}

module.exports = { getStreams: getStreams };
