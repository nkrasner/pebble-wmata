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

function shrinkName(name, maxLen) {
  if (!name || name.length <= maxLen) return name;
  var s = "";
  for (var i = 0; i < name.length; i++) { if (i === 0 || name[i].toLowerCase() !== name[i-1].toLowerCase()) s += name[i]; }
  if (s.length <= maxLen) return s;
  var vowels = "aeiouAEIOU"; var firstV = -1, lastV = -1;
  for (var j = 0; j < s.length; j++) { if (vowels.indexOf(s[j]) !== -1) { if (firstV === -1) firstV = j; lastV = j; } }
  var finalStr = "";
  for (var k = 0; k < s.length; k++) {
    if (vowels.indexOf(s[k]) !== -1) { if (k === firstV || k === lastV) finalStr += s[k]; } else { finalStr += s[k]; }
  }
  if (finalStr.length > maxLen) return finalStr.substring(0, maxLen - 2) + "..";
  return finalStr;
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
  dict[KEYS.TITLE] = String(page.name);
  dict[KEYS.SUBTITLE] = String(distStr + "^" + (page.isPinned ? "1" : "0") + "^" + page.type + "^" + ".|.|.~.|.|.~.|.|.~.|.|.~.|.|.");
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
    dict[KEYS.TITLE] = String(page.name);
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
    sTrains = sTrains.slice(0, 5);
    var rows = [];
    for (var t2 = 0; t2 < sTrains.length; t2++) {
      var tr = sTrains[t2];
      rows.push(tr.Line + "|" + shrinkName(tr.Destination, 14) + "|" + tr.Min);
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
        var sBuses = preds.slice(0, 5);
        for (var b = 0; b < sBuses.length; b++) {
          var bs = sBuses[b];
          var bMins = (bs.Minutes === "0" || bs.Minutes === "ARR") ? "ARR" : bs.Minutes;
          rows.push(bs.RouteID + "|" + shrinkName(cleanHeadsign(bs.DirectionText), 14) + "|" + bMins);
        }
        sendPage(rows);
      } else {
        fetchGroupSchedules(page.stopIds, 0, function(schedToday) {
          fetchGroupSchedules(page.stopIds, 1, function(schedTmrw) {
            var combined = processTransitData([], schedToday, schedTmrw, []);
            var rows = [];
            for (var c = 0; c < Math.min(combined.length, 5); c++) {
              rows.push(combined[c].route + "|" + shrinkName(combined[c].headsign, 14) + "|" + combined[c].displayTime);
            }
            if (rows.length === 0) rows.push(" |-- NO DATA --|--");
            sendPage(rows);
          });
        });
      }
    });
  }
}

function fetchGroupSchedules(ids, offsetDays, callback) {
  var results = []; var pending = ids.length;
  if (pending === 0) return callback([]);
  ids.forEach(function(id) {
    fetchWMATA('https://api.wmata.com/Bus.svc/json/jStopSchedule?StopID=' + id + '&Date=' + getLocalDateString(offsetDays) + '&cb=' + Date.now(), function(res) {
      if (res && res.ScheduleArrivals) results = results.concat(res.ScheduleArrivals);
      pending--; if (pending === 0) callback(results);
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
            liveTripIds[lp.TripID] = true; 
            var mins = (lp.Minutes === "0" || lp.Minutes === "ARR") ? 0 : parseInt(lp.Minutes, 10);
            fullList.push({ rawTime: now.getTime() + (mins * 60000), displayTime: formatTime(lp.Minutes) + " (Live)", tripId: lp.TripID || safeRouteId, dirText: lp.DirectionText });
          }
        }

        var allSched = (schedToday || []).concat(schedTmrw || []);
        for (var j = 0; j < allSched.length; j++) {
          var s = allSched[j];
          if (s.RouteID && String(s.RouteID).trim().toUpperCase() === safeRouteId) {
            if (liveTripIds[s.TripID]) continue; 
            var schedTime = new Date(s.ScheduleTime.replace('T', ' ').replace(/-/g, '/'));
            var hours = schedTime.getHours(); var ampm = hours >= 12 ? 'p' : 'a'; hours = hours % 12; hours = hours ? hours : 12;
            var m = schedTime.getMinutes(); var cleanMins = m < 10 ? '0' + m : m;
            var isTomorrow = schedTime.getDate() !== now.getDate();
            var dirChar = s.TripDirectionText ? " " + s.TripDirectionText.charAt(0).toUpperCase() : "";
            fullList.push({ rawTime: schedTime.getTime(), displayTime: (isTomorrow ? "Tmrw " : "") + hours + ":" + cleanMins + ampm + dirChar, tripId: s.TripID || safeRouteId });
          }
        }

        fullList.sort(function(a, b) { return a.rawTime - b.rawTime; });
        if (fullList.length === 0) fullList.push({ displayTime: "No Schedule Data", rawTime: now.getTime(), tripId: safeRouteId });

        var nextIndex = 0;
        for (var k = 0; k < fullList.length; k++) { if (fullList[k].rawTime >= now.getTime()) { nextIndex = k; break; } }

        var headerDict = {}; headerDict[KEYS.REQUEST_TYPE] = 2; headerDict[KEYS.INDEX] = -1;
        var shortName = currentStopName.length > 15 ? currentStopName.substring(0, 15) + "..." : currentStopName;
        headerDict[KEYS.TITLE] = String(safeRouteId + " @ " + shortName); 
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
  var urlSchedToday = 'https://api.wmata.com/Bus.svc/json/jRouteSchedule?RouteID=' + routeId + '&Date=' + getLocalDateString(0) + '&cb=' + Date.now();
  fetchWMATA(urlSchedToday, function(schedToday) {
    if (findAndSendTrip(schedToday, tripId, primaryId, routeId)) return; 
    var urlSchedTmrw = 'https://api.wmata.com/Bus.svc/json/jRouteSchedule?RouteID=' + routeId + '&Date=' + getLocalDateString(1) + '&cb=' + Date.now();
    fetchWMATA(urlSchedTmrw, function(schedTmrw) {
      if (!findAndSendTrip(schedTmrw, tripId, primaryId, routeId)) sendUnavailableMessage(routeId, "No Trip Data");
    });
  });
}

function findAndSendTrip(schedObj, tripId, primaryId, routeId) {
  var dirs = [];
  if (schedObj.Direction0) dirs.push(schedObj.Direction0);
  if (schedObj.Direction1) dirs.push(schedObj.Direction1);
  var targetTrip = null; var headsign = "Trip Details"; var exactMatch = true;
  var groupIds = currentStopIds.length > 0 ? currentStopIds : [primaryId];
  for (var d = 0; d < dirs.length; d++) {
    var trips = dirs[d].Trips || [];
    for (var t = 0; t < trips.length; t++) {
      if (String(trips[t].TripID).trim() === String(tripId).trim()) { targetTrip = trips[t]; headsign = cleanHeadsign(dirs[d].TripHeadsign || trips[t].TripDirectionText); break; }
    }
    if (targetTrip) break;
  }
  if (!targetTrip) {
    exactMatch = false; 
    for (var d2 = 0; d2 < dirs.length; d2++) {
      var trips2 = dirs[d2].Trips || [];
      for (var t2 = 0; t2 < trips2.length; t2++) {
        var st = trips2[t2].StopTimes || [];
        for (var s = 0; s < st.length; s++) {
          if (groupIds.indexOf(String(st[s].StopID).trim()) !== -1) { targetTrip = trips2[t2]; headsign = cleanHeadsign(dirs[d2].TripHeadsign || trips2[t2].TripDirectionText) + " (Route)"; break; }
        }
        if (targetTrip) break;
      }
      if (targetTrip) break;
    }
  }
  if (!targetTrip) return false; 
  var tripStops = []; var snapIndex = 0;
  if (targetTrip.StopTimes) {
    for (var i = 0; i < targetTrip.StopTimes.length; i++) {
      var stop = targetTrip.StopTimes[i];
      if (groupIds.indexOf(String(stop.StopID).trim()) !== -1) snapIndex = i;
      var displayStr = "--";
      if (exactMatch) { 
        var schedTime = new Date(stop.Time.replace('T', ' ').replace(/-/g, '/'));
        var hours = schedTime.getHours(); var ampm = hours >= 12 ? 'p' : 'a'; hours = hours % 12; hours = hours ? hours : 12;
        var m = schedTime.getMinutes(); var cleanMins = m < 10 ? '0' + m : m;
        displayStr = hours + ":" + cleanMins + ampm;
      }
      tripStops.push({ stopName: stop.StopName, displayTime: displayStr });
    }
  }
  var headerDict = {}; headerDict[KEYS.REQUEST_TYPE] = 3; headerDict[KEYS.INDEX] = -1;
  headerDict[KEYS.TITLE] = String(routeId + " • " + headsign); headerDict[KEYS.BEARING] = snapIndex;
  Pebble.sendAppMessage(headerDict, function() { sendTripRows(tripStops, 0); });
  return true; 
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
          var hours = schedTime.getHours(); var ampm = hours >= 12 ? 'p' : 'a'; hours = hours % 12; hours = hours ? hours : 12; 
          var m = schedTime.getMinutes(); var cleanMins = m < 10 ? '0' + m : m;
          var isTomorrow = schedTime.getDate() !== now.getDate();
          displayStr = (isTomorrow ? "Tmrw " : "") + hours + ":" + cleanMins + ampm;
        } else { displayStr = diffMins + "m (Sch)"; }
        combined.push({ route: sch.RouteID, headsign: headsignSched, minutes: diffMins, displayTime: displayStr, tripId: sch.TripID || sch.RouteID });
      }
    }
  }
  combined.sort(function(a, b) { return a.minutes - b.minutes; }); return combined;
}

function cleanHeadsign(text) { if (!text) return "Unknown"; var idx = text.toLowerCase().indexOf(" to "); return idx !== -1 ? text.substring(idx + 4) : text; }
function formatTime(mins) { return (mins === "0" || mins === "ARR") ? "ARR" : mins + " min"; }
function calculateDistance(lat1, lon1, lat2, lon2) { var R = 20925640; var dLat = (lat2 - lat1) * Math.PI / 180; var dLon = (lon2 - lon1) * Math.PI / 180; var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2); var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); return R * c; }