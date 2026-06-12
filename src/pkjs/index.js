var currentPages = [];
var pinnedStops = JSON.parse(localStorage.getItem('wmata_pins')) || [];
var refreshInterval = null;

var KEYS = { REQUEST_TYPE: 0, TARGET_ID: 1, BEARING: 2, DISTANCE: 3, INDEX: 4, TITLE: 5, SUBTITLE: 6 };

Pebble.addEventListener('ready', function(e) {
  fetchAllPages();
  if (!refreshInterval) refreshInterval = setInterval(fetchAllPages, 30000);
});

Pebble.addEventListener('appmessage', function(e) {
  var dict = e.payload;
  var reqType = dict[KEYS.REQUEST_TYPE];
  var targetId = dict[KEYS.TARGET_ID];

  if (reqType === 2) {
    var parts = targetId.split('|');
    currentStopId = parts[0];
    currentRouteId = parts[1];
    
    // Find the Stop Name for the Breadcrumb
    for (var p = 0; p < currentPages.length; p++) {
      if (currentPages[p].id === currentStopId) { currentStopName = currentPages[p].name; break; }
    }

    if (currentRouteId === "RAIL_TRAIN") sendUnavailableMessage("Metro Rail", "Live Only - No Schedule");
    else fetchRouteScheduleAtStop(currentStopId.substring(2), currentRouteId);
  } 
  else if (reqType === 3) {
    currentTripId = targetId;
    fetchTripDetails(currentRouteId, currentTripId, currentStopId.substring(2));
  }
  else if (reqType === 4) togglePin(targetId);
  else if (reqType === 5) movePin(targetId, -1); 
  else if (reqType === 6) movePin(targetId, 1);  
});

// Shortening disabled (bigger screen); the watch's trailing ellipsis handles
// overflow. The old vowel-stripping algorithm lives in git history if needed.
function shrinkName(name, maxLen) {
  return name;
}

function togglePin(id) {
  var existingIdx = -1;
  for (var i = 0; i < pinnedStops.length; i++) { if (pinnedStops[i].id === id) { existingIdx = i; break; } }
  if (existingIdx >= 0) {
    pinnedStops.splice(existingIdx, 1);
  } else {
    var pageToPin = null;
    for (var j = 0; j < currentPages.length; j++) { if (currentPages[j].id === id) { pageToPin = currentPages[j]; break; } }
    // ADD TO TOP
    if (pageToPin) pinnedStops.unshift({ id: pageToPin.id, name: pageToPin.name, type: pageToPin.type, stopIds: pageToPin.stopIds });
  }
  localStorage.setItem('wmata_pins', JSON.stringify(pinnedStops));
  fetchAllPages();
}

function movePin(id, direction) {
  var idx = -1;
  for (var i = 0; i < pinnedStops.length; i++) { if (pinnedStops[i].id === id) { idx = i; break; } }
  if (idx < 0 || idx + direction < 0 || idx + direction >= pinnedStops.length) return;
  var temp = pinnedStops[idx]; pinnedStops[idx] = pinnedStops[idx + direction]; pinnedStops[idx + direction] = temp;
  localStorage.setItem('wmata_pins', JSON.stringify(pinnedStops));
  fetchAllPages();
}

var fetchQueue = [];
var LOCK_DURATION_MS = 100;
var lockReleaseAt = 0;
function fetchWMATA(url, callback) { fetchQueue.push({url: url, callback: callback}); processFetchQueue(); }
function processFetchQueue() {
  if (fetchQueue.length === 0) return;
  var now = Date.now();
  if (now < lockReleaseAt) { setTimeout(processFetchQueue, lockReleaseAt - now); return; }
  lockReleaseAt = now + LOCK_DURATION_MS;
  var task = fetchQueue.shift(); var req = new XMLHttpRequest();
  req.open('GET', task.url, true); req.setRequestHeader('api_key', '20c44341f61b450d815d3c79e2a593e9');
  req.onload = function() { var res = {}; if (req.status === 200) { try { res = JSON.parse(req.responseText); } catch(e) {} } task.callback(res); processFetchQueue(); };
  req.onerror = function() { task.callback({}); processFetchQueue(); };
  req.send(null);
  processFetchQueue();
}

function sendAllSkeletons(pages, index, done) {
  if (index >= pages.length || index >= 10) { done(); return; }
  var page = pages[index];
  var distStr = page.dist > 1320 ? (page.dist / 5280).toFixed(1) + " mi" : (page.dist === 99999 ? "Pinned" : Math.round(page.dist) + " ft");
  var dict = {};
  dict[KEYS.REQUEST_TYPE] = 0; dict[KEYS.INDEX] = index; dict[KEYS.TARGET_ID] = String(page.id);
  dict[KEYS.TITLE] = String(shrinkName(page.name, 10));
  dict[KEYS.SUBTITLE] = String(distStr + "^" + (page.isPinned ? "1" : "0") + "^" + page.type + "^" + ".|.|.~.|.|.~.|.|.~.|.|.~.|.|.~.|.|.~.|.|.");
  Pebble.sendAppMessage(dict, function() {
    setTimeout(function() { sendAllSkeletons(pages, index + 1, done); }, 50);
  });
}

function buildFillOrder(pages) {
  var P = pinnedStops.length;
  var N = pages.length - P;
  var order = [];
  var maxLen = Math.max(P, N);
  for (var i = 0; i < maxLen; i++) {
    if (i < N) order.push(P + i);
    if (i < P) order.push(i);
  }
  return order;
}

function streamPageData(pages, allTrains, fillOrder) {
  if (fillOrder.length === 0) return;
  var index = fillOrder[0];
  var remaining = fillOrder.slice(1);
  var page = pages[index];
  var distStr = page.dist > 1320 ? (page.dist / 5280).toFixed(1) + " mi" : (page.dist === 99999 ? "Pinned" : Math.round(page.dist) + " ft");

  function sendPage(rows) {
    var dict = {};
    dict[KEYS.REQUEST_TYPE] = 0; dict[KEYS.INDEX] = index; dict[KEYS.TARGET_ID] = String(page.id);
    dict[KEYS.TITLE] = String(shrinkName(page.name, 10));
    dict[KEYS.SUBTITLE] = String(distStr + "^" + (page.isPinned ? "1" : "0") + "^" + page.type + "^" + rows.join("~"));
    Pebble.sendAppMessage(dict, function() {
      setTimeout(function() { streamPageData(pages, allTrains, remaining); }, 50);
    });
  }

  if (page.type === 'RAIL') {
    var sTrains = [];
    for (var t = 0; t < allTrains.length; t++) {
      if (page.stopIds.indexOf(allTrains[t].LocationCode) !== -1) sTrains.push(allTrains[t]);
    }
    sTrains = sTrains.slice(0, 7);
    var rows = [];
    for (var t2 = 0; t2 < sTrains.length; t2++) {
      var tr = sTrains[t2];
      rows.push(tr.Line + "|" + shrinkName(tr.Destination, 10) + "|" + tr.Min);
    }
    if (rows.length === 0) rows.push(" |-- NO DATA --|--");
    sendPage(rows);
  } else {
    fetchPredictionsForGroup(page.stopIds, function(preds) {
      if (preds.length > 0) {
        preds.sort(function(a, b) {
          var aMin = (a.Minutes === "0" || a.Minutes === "ARR") ? 0 : parseInt(a.Minutes, 10);
          var bMin = (b.Minutes === "0" || b.Minutes === "ARR") ? 0 : parseInt(b.Minutes, 10);
          return aMin - bMin;
        });
        var rows = [];
        var sBuses = preds.slice(0, 7);
        for (var b = 0; b < sBuses.length; b++) {
          var bs = sBuses[b];
          var bMins = (bs.Minutes === "0" || bs.Minutes === "ARR") ? "ARR" : bs.Minutes;
          rows.push(bs.RouteID + "|" + shrinkName(cleanHeadsign(bs.DirectionText), 10) + "|" + bMins);
        }
        sendPage(rows);
      } else {
        fetchGroupSchedules(page.stopIds, 0, function(schedToday) {
          fetchGroupSchedules(page.stopIds, 1, function(schedTmrw) {
            var combined = processTransitData([], schedToday, schedTmrw, []);
            var rows = [];
            for (var c = 0; c < Math.min(combined.length, 7); c++) {
              rows.push(combined[c].route + "|" + shrinkName(combined[c].headsign, 10) + "|" + combined[c].displayTime);
            }
            if (rows.length === 0) rows.push(" |-- NO DATA --|--");
            sendPage(rows);
          });
        });
      }
    });
  }
}

// WMATA's legacy Bus.svc schedule endpoints (jStopSchedule/jRouteSchedule) stopped
// returning data after the June 2025 Better Bus redesign. Schedule data now comes
// from the OneBusAway API behind busETA (buseta.wmata.com). OBA uses internal stop
// IDs, so WMATA stop codes are resolved once via busETA search and cached.
var OBA_API = 'https://buseta.wmata.com/onebusaway-api-webapp/api/where/';
var OBA_KEY = 'TEST'; // OBA default test key; swap if WMATA issues a real one
var obaIdCache = JSON.parse(localStorage.getItem('oba_stop_ids')) || {};

function resolveObaStopId(code, callback) {
  if (obaIdCache[code]) return callback(obaIdCache[code]);
  fetchWMATA('https://buseta.wmata.com/api/search?q=' + code, function(res) {
    var id = null;
    var matches = (res.searchResults && res.searchResults.matches) || [];
    for (var i = 0; i < matches.length; i++) {
      if (String(matches[i].code) === String(code)) { id = matches[i].id; break; }
    }
    if (id) { obaIdCache[code] = id; localStorage.setItem('oba_stop_ids', JSON.stringify(obaIdCache)); }
    callback(id);
  });
}

function toLegacyTimeString(ms) {
  var d = new Date(ms);
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
         pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function fetchGroupSchedules(ids, offsetDays, callback) {
  var results = []; var pending = ids.length;
  if (pending === 0) return callback([]);
  ids.forEach(function(id) {
    resolveObaStopId(id, function(obaId) {
      if (!obaId) { pending--; if (pending === 0) callback(results); return; }
      fetchWMATA(OBA_API + 'schedule-for-stop/' + obaId + '.json?key=' + OBA_KEY + '&date=' + getLocalDateString(offsetDays), function(res) {
        var schedules = (res.data && res.data.entry && res.data.entry.stopRouteSchedules) || [];
        for (var r = 0; r < schedules.length; r++) {
          var routeId = String(schedules[r].routeId).replace(/^\d+_/, '');
          var dirs = schedules[r].stopRouteDirectionSchedules || [];
          for (var d = 0; d < dirs.length; d++) {
            var times = dirs[d].scheduleStopTimes || [];
            for (var t = 0; t < times.length; t++) {
              // Same shape the legacy jStopSchedule ScheduleArrivals had, so
              // processTransitData and the schedule view work unchanged.
              results.push({
                RouteID: routeId,
                TripID: String(times[t].tripId).replace(/^\d+_/, ''),
                TripDirectionText: dirs[d].tripHeadsign || '',
                ScheduleTime: toLegacyTimeString(times[t].departureTime)
              });
            }
          }
        }
        pending--; if (pending === 0) callback(results);
      });
    });
  });
}

function fetchPredictionsForGroup(stopIds, callback) {
  var all = []; var pending = stopIds.length;
  if (pending === 0) { callback([]); return; }
  stopIds.forEach(function(id) {
    fetchWMATA('https://api.wmata.com/NextBusService.svc/json/jPredictions?StopID=' + id + '&cb=' + Date.now(), function(res) {
      if (res && res.Predictions) all = all.concat(res.Predictions);
      pending--; if (pending === 0) callback(all);
    });
  });
}

function getLocalDateString(offsetDays) {
  var d = new Date(); d.setDate(d.getDate() + offsetDays);
  var yyyy = d.getFullYear(); var mm = d.getMonth() + 1; var dd = d.getDate();
  return yyyy + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
}

function fetchAllPages() {
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude; var lon = pos.coords.longitude;
    fetchWMATA('https://api.wmata.com/Bus.svc/json/jStops?Lat=' + lat + '&Lon=' + lon + '&Radius=800&cb=' + Date.now(), function(busRes) {
      fetchWMATA('https://api.wmata.com/Rail.svc/json/jStations', function(railRes) {
        fetchWMATA('https://api.wmata.com/StationPrediction.svc/json/GetPrediction/All', function(trainRes) {
          
          var nearbyStops = [];
          if (busRes.Stops) {
            var groups = {};
            for (var b = 0; b < busRes.Stops.length; b++) {
              var bs = busRes.Stops[b];
              if (!groups[bs.Name]) groups[bs.Name] = { ids: [], latSum: 0, lonSum: 0, count: 0, name: bs.Name };
              groups[bs.Name].ids.push(bs.StopID); groups[bs.Name].latSum += bs.Lat; groups[bs.Name].lonSum += bs.Lon; groups[bs.Name].count++;
            }
            for (var key in groups) {
              var g = groups[key];
              nearbyStops.push({ type: 'BUS', id: "B_" + g.ids[0], stopIds: g.ids, name: g.name, dist: calculateDistance(lat, lon, g.latSum/g.count, g.lonSum/g.count) });
            }
          }

          if (railRes.Stations) {
            for (var r = 0; r < railRes.Stations.length; r++) {
              var rs = railRes.Stations[r];
              nearbyStops.push({ type: 'RAIL', id: "R_" + rs.Code, stopIds: [rs.Code], name: rs.Name, dist: calculateDistance(lat, lon, rs.Lat, rs.Lon) });
            }
          }

          var railStops = nearbyStops.filter(function(s) { return s.type === 'RAIL'; }).sort(function(a, b) { return a.dist - b.dist; });
          var busStops = nearbyStops.filter(function(s) { return s.type === 'BUS'; }).sort(function(a, b) { return a.dist - b.dist; });
          
          var topNearby = [];
          if (railStops.length > 0) topNearby.push(railStops.shift());
          if (railStops.length > 0) topNearby.push(railStops.shift());
          var remainingPool = railStops.concat(busStops).sort(function(a, b) { return a.dist - b.dist; });
          while (topNearby.length < 5 && remainingPool.length > 0) topNearby.push(remainingPool.shift());
          topNearby.sort(function(a, b) { return a.dist - b.dist; });

          currentPages = [];
          for (var p = 0; p < pinnedStops.length; p++) {
            var pin = pinnedStops[p];
            currentPages.push({ id: pin.id, name: pin.name, type: pin.type, stopIds: pin.stopIds, isPinned: true, dist: 99999 });
          }
          // ALLOW DUPLICATES
          for (var n = 0; n < topNearby.length; n++) {
            var nearby = topNearby[n];
            nearby.isPinned = false;
            currentPages.push(nearby);
          }

          var payload = {}; payload[KEYS.REQUEST_TYPE] = 0; payload[KEYS.INDEX] = -1; payload[KEYS.BEARING] = pinnedStops.length;
          payload[KEYS.DISTANCE] = Math.min(currentPages.length, 10);
          Pebble.sendAppMessage(payload, function() {
            sendAllSkeletons(currentPages, 0, function() {
              streamPageData(currentPages, trainRes.Trains || [], buildFillOrder(currentPages));
            });
          });
        });
      });
    });
  }, function(err) { console.log("Loc fail"); }, { timeout: 15000, maximumAge: 30000 });
}

// --- TIER 3/4 SCHEDULING ENGINE ---
var currentStopIds = [];
function fetchRouteScheduleAtStop(primaryId, routeId) {
  var groupIds = [];
  for (var p = 0; p < currentPages.length; p++) { if (currentPages[p].id === "B_" + primaryId) { groupIds = currentPages[p].stopIds; break; } }
  if (groupIds.length === 0) groupIds = [primaryId];
  currentStopIds = groupIds; 

  fetchPredictionsForGroup(groupIds, function(livePreds) {
    fetchGroupSchedules(groupIds, 0, function(schedToday) {
      fetchGroupSchedules(groupIds, 1, function(schedTmrw) {
        var safeRouteId = String(routeId).trim().toUpperCase();
        var fullList = []; var now = new Date(); var liveTripIds = {};
        for (var i = 0; i < livePreds.length; i++) {
          var lp = livePreds[i];
          if (lp.RouteID && String(lp.RouteID).trim().toUpperCase() === safeRouteId) {
            if (lp.TripID && liveTripIds[lp.TripID]) continue; // grouped stops can predict the same bus twice
            liveTripIds[lp.TripID] = true;
            var mins = (lp.Minutes === "0" || lp.Minutes === "ARR") ? 0 : parseInt(lp.Minutes, 10);
            var rawTime = now.getTime() + (mins * 60000);
            fullList.push({ rawTime: rawTime, displayTime: formatClockTime(rawTime) + " (Live)", tripId: lp.TripID || safeRouteId, dirText: lp.DirectionText });
          }
        }
        var liveTimes = fullList.map(function(e) { return e.rawTime; });

        var allSched = (schedToday || []).concat(schedTmrw || []);
        for (var j = 0; j < allSched.length; j++) {
          var s = allSched[j];
          if (s.RouteID && String(s.RouteID).trim().toUpperCase() === safeRouteId) {
            if (liveTripIds[s.TripID]) continue;
            var schedTime = new Date(s.ScheduleTime.replace('T', ' ').replace(/-/g, '/'));
            // A scheduled time within 2 min of a live prediction is the same bus; keep the live entry
            var nearLive = false;
            for (var L = 0; L < liveTimes.length; L++) { if (Math.abs(liveTimes[L] - schedTime.getTime()) < 120000) { nearLive = true; break; } }
            if (nearLive) continue;
            var isTomorrow = schedTime.getDate() !== now.getDate();
            var dirChar = s.TripDirectionText ? " " + s.TripDirectionText.charAt(0).toUpperCase() : "";
            fullList.push({ rawTime: schedTime.getTime(), displayTime: (isTomorrow ? "Tmrw " : "") + formatClockTime(schedTime.getTime()) + dirChar, tripId: s.TripID || safeRouteId });
          }
        }

        fullList.sort(function(a, b) { return a.rawTime - b.rawTime; });
        if (fullList.length === 0) fullList.push({ displayTime: "No Schedule Data", rawTime: now.getTime(), tripId: safeRouteId });

        var nextIndex = 0;
        for (var k = 0; k < fullList.length; k++) { if (fullList[k].rawTime >= now.getTime()) { nextIndex = k; break; } }

        // Only 80 rows fit on the watch; drop all but a few past times so the
        // upcoming ones always make it across (and centering lands correctly)
        var start = nextIndex > 5 ? nextIndex - 5 : 0;
        if (start > 0) { fullList = fullList.slice(start); nextIndex -= start; }

        var headerDict = {}; headerDict[KEYS.REQUEST_TYPE] = 2; headerDict[KEYS.INDEX] = -1;
        headerDict[KEYS.TITLE] = String(safeRouteId + " @ " + shrinkName(currentStopName, 10));
        headerDict[KEYS.BEARING] = nextIndex; 
        
        Pebble.sendAppMessage(headerDict, function() { sendScheduleRows(fullList, 0); });
      });
    });
  });
}

function sendScheduleRows(preds, index) {
  if (index >= preds.length || index >= 80) return; 
  var p = preds[index];
  var dict = {}; dict[KEYS.REQUEST_TYPE] = 2; dict[KEYS.INDEX] = index; dict[KEYS.TARGET_ID] = String(p.tripId); dict[KEYS.SUBTITLE] = String(p.displayTime);
  Pebble.sendAppMessage(dict, function() { setTimeout(function() { sendScheduleRows(preds, index + 1); }, 50); }, function() { setTimeout(function() { sendScheduleRows(preds, index); }, 200); });
}

function fetchTripDetails(routeId, tripId, primaryId) {
  fetchWMATA(OBA_API + 'trip-details/1_' + String(tripId).trim() + '.json?key=' + OBA_KEY, function(res) {
    var entry = res.data && res.data.entry;
    var stopTimes = entry && entry.schedule && entry.schedule.stopTimes;
    if (!stopTimes || stopTimes.length === 0) { sendUnavailableMessage(routeId, "No Trip Data"); return; }

    var refs = res.data.references || {};
    var stopsById = {};
    (refs.stops || []).forEach(function(s) { stopsById[s.id] = s; });
    var headsign = "Trip Details";
    (refs.trips || []).forEach(function(t) { if (t.id === entry.tripId && t.tripHeadsign) headsign = shrinkName(cleanHeadsign(t.tripHeadsign), 10); });

    var groupIds = currentStopIds.length > 0 ? currentStopIds : [primaryId];
    var serviceDate = entry.serviceDate || Date.now();
    var tripStops = []; var snapIndex = 0;
    for (var i = 0; i < stopTimes.length; i++) {
      var stopRef = stopsById[stopTimes[i].stopId] || {};
      if (stopRef.code && groupIds.indexOf(String(stopRef.code).trim()) !== -1) snapIndex = i;
      // arrivalTime is seconds since midnight of the trip's service date
      var when = serviceDate + stopTimes[i].arrivalTime * 1000;
      tripStops.push({ stopName: shrinkName(stopRef.name || "Stop", 10), displayTime: formatClockTime(when) });
    }

    var headerDict = {}; headerDict[KEYS.REQUEST_TYPE] = 3; headerDict[KEYS.INDEX] = -1;
    headerDict[KEYS.TITLE] = String(routeId + " • " + headsign); headerDict[KEYS.BEARING] = snapIndex;
    Pebble.sendAppMessage(headerDict, function() { sendTripRows(tripStops, 0); });
  });
}

function sendTripRows(stops, index) {
  if (index >= stops.length || index >= 80) return; 
  var st = stops[index];
  var dict = {}; dict[KEYS.REQUEST_TYPE] = 3; dict[KEYS.INDEX] = index;
  dict[KEYS.TITLE] = String(st.stopName); dict[KEYS.SUBTITLE] = String(st.displayTime);
  Pebble.sendAppMessage(dict, function() { setTimeout(function() { sendTripRows(stops, index + 1); }, 50); }, function() { setTimeout(function() { sendTripRows(stops, index); }, 200); });
}

function sendUnavailableMessage(routeId, message) {
  var headerDict = {}; headerDict[KEYS.REQUEST_TYPE] = 3; headerDict[KEYS.INDEX] = -1;
  headerDict[KEYS.TITLE] = String(routeId + " • " + message); headerDict[KEYS.BEARING] = 0;
  Pebble.sendAppMessage(headerDict, function() { 
    var dict = {}; dict[KEYS.REQUEST_TYPE] = 3; dict[KEYS.INDEX] = 0;
    dict[KEYS.TITLE] = String("WMATA API Offline"); dict[KEYS.SUBTITLE] = String("--");
    Pebble.sendAppMessage(dict); 
  });
}

function processTransitData(livePreds, schedToday, schedTmrw, supportedRoutes) {
  livePreds = livePreds || []; schedToday = schedToday || []; schedTmrw = schedTmrw || []; supportedRoutes = supportedRoutes || [];
  var allSched = schedToday.concat(schedTmrw);
  var combined = []; var seenRoutes = {}; var pushedRoutes = {}; var now = new Date();

  for (var i = 0; i < livePreds.length; i++) {
    var p = livePreds[i]; var headsign = cleanHeadsign(p.DirectionText);
    var normKey = String(p.RouteID + headsign).toUpperCase().replace(/\s+/g, '');
    if (!seenRoutes[normKey]) {
      seenRoutes[normKey] = true; pushedRoutes[String(p.RouteID).trim()] = true; 
      var mins = (p.Minutes === "0" || p.Minutes === "ARR") ? 0 : parseInt(p.Minutes, 10);
      combined.push({ route: p.RouteID, headsign: headsign, minutes: mins, displayTime: formatTime(p.Minutes), tripId: p.TripID || p.RouteID });
    }
  }

  for (var j = 0; j < allSched.length; j++) {
    var sch = allSched[j];
    if (!sch.RouteID) continue; 
    var schedTime = new Date(sch.ScheduleTime.replace('T', ' ').replace(/-/g, '/'));
    if (schedTime > now) {
      var headsignSched = cleanHeadsign(sch.TripDirectionText);
      var normKeySched = String(sch.RouteID + headsignSched).toUpperCase().replace(/\s+/g, '');
      if (!seenRoutes[normKeySched]) {
        seenRoutes[normKeySched] = true; pushedRoutes[String(sch.RouteID).trim()] = true;
        var diffMs = schedTime - now; var diffMins = Math.floor(diffMs / 60000); var displayStr = "";
        
        if (diffMins > 120) {
          var isTomorrow = schedTime.getDate() !== now.getDate();
          displayStr = (isTomorrow ? "Tmrw " : "") + formatClockTime(schedTime.getTime());
        } else { displayStr = diffMins + "m (Sch)"; }
        combined.push({ route: sch.RouteID, headsign: headsignSched, minutes: diffMins, displayTime: displayStr, tripId: sch.TripID || sch.RouteID });
      }
    }
  }
  combined.sort(function(a, b) { return a.minutes - b.minutes; }); return combined;
}

function cleanHeadsign(text) { if (!text) return "Unknown"; var idx = text.toLowerCase().indexOf(" to "); return idx !== -1 ? text.substring(idx + 4) : text; }
function formatTime(mins) { return (mins === "0" || mins === "ARR") ? "ARR" : mins + " min"; }
function formatClockTime(ms) { var d = new Date(ms); var h = d.getHours(); var ap = h >= 12 ? 'p' : 'a'; h = h % 12; h = h ? h : 12; var m = d.getMinutes(); return h + ":" + (m < 10 ? '0' : '') + m + ap; }
function calculateDistance(lat1, lon1, lat2, lon2) { var R = 20925640; var dLat = (lat2 - lat1) * Math.PI / 180; var dLon = (lon2 - lon1) * Math.PI / 180; var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2); var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); return R * c; }