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

  if (reqType === 4) togglePin(targetId);
  else if (reqType === 5) movePin(targetId, -1); 
  else if (reqType === 6) movePin(targetId, 1);  
});

// --- CORE VOWEL/DEDUP ABBREVIATION ---
function shrinkName(name, maxLen) {
  if (!name || name.length <= maxLen) return name;
  
  var s = "";
  for (var i = 0; i < name.length; i++) {
    if (i === 0 || name[i].toLowerCase() !== name[i-1].toLowerCase()) s += name[i];
  }
  if (s.length <= maxLen) return s;

  var vowels = "aeiouAEIOU";
  var firstV = -1, lastV = -1;
  for (var j = 0; j < s.length; j++) {
    if (vowels.indexOf(s[j]) !== -1) {
      if (firstV === -1) firstV = j;
      lastV = j;
    }
  }
  
  var finalStr = "";
  for (var k = 0; k < s.length; k++) {
    if (vowels.indexOf(s[k]) !== -1) {
      if (k === firstV || k === lastV) finalStr += s[k];
    } else {
      finalStr += s[k];
    }
  }
  
  if (finalStr.length > maxLen) return finalStr.substring(0, maxLen - 2) + "..";
  return finalStr;
}

// --- PIN MANAGEMENT (ES5 COMPLIANT) ---
function togglePin(id) {
  var existingIdx = -1;
  for (var i = 0; i < pinnedStops.length; i++) {
    if (pinnedStops[i].id === id) { existingIdx = i; break; }
  }

  if (existingIdx >= 0) {
    pinnedStops.splice(existingIdx, 1);
  } else {
    var pageToPin = null;
    for (var j = 0; j < currentPages.length; j++) {
      if (currentPages[j].id === id) { pageToPin = currentPages[j]; break; }
    }
    if (pageToPin) {
      pinnedStops.push({ id: pageToPin.id, name: pageToPin.name, type: pageToPin.type, stopIds: pageToPin.stopIds });
    }
  }
  localStorage.setItem('wmata_pins', JSON.stringify(pinnedStops));
  fetchAllPages();
}

function movePin(id, direction) {
  var idx = -1;
  for (var i = 0; i < pinnedStops.length; i++) {
    if (pinnedStops[i].id === id) { idx = i; break; }
  }
  if (idx < 0 || idx + direction < 0 || idx + direction >= pinnedStops.length) return;
  
  var temp = pinnedStops[idx];
  pinnedStops[idx] = pinnedStops[idx + direction];
  pinnedStops[idx + direction] = temp;
  
  localStorage.setItem('wmata_pins', JSON.stringify(pinnedStops));
  fetchAllPages();
}

// --- API QUEUE ---
var fetchQueue = [];
var isFetching = false;
function fetchWMATA(url, callback) { fetchQueue.push({url: url, callback: callback}); processFetchQueue(); }
function processFetchQueue() {
  if (isFetching || fetchQueue.length === 0) return;
  isFetching = true;
  var task = fetchQueue.shift();
  var req = new XMLHttpRequest();
  req.open('GET', task.url, true);
  req.setRequestHeader('api_key', '20c44341f61b450d815d3c79e2a593e9');
  req.onload = function() {
    var res = {}; if (req.status === 200) { try { res = JSON.parse(req.responseText); } catch(e) {} }
    task.callback(res); setTimeout(function() { isFetching = false; processFetchQueue(); }, 150); 
  };
  req.onerror = function() { task.callback({}); setTimeout(function() { isFetching = false; processFetchQueue(); }, 150); };
  req.send(null);
}

// --- MASTER DATA BUILDER (ES5 COMPLIANT) ---
function fetchAllPages() {
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude; var lon = pos.coords.longitude;
    var urlBus = 'https://api.wmata.com/Bus.svc/json/jStops?Lat=' + lat + '&Lon=' + lon + '&Radius=800&cb=' + Date.now();
    var urlRail = 'https://api.wmata.com/Rail.svc/json/jStations';
    var urlTrains = 'https://api.wmata.com/StationPrediction.svc/json/GetPrediction/All';

    fetchWMATA(urlBus, function(busRes) {
      fetchWMATA(urlRail, function(railRes) {
        fetchWMATA(urlTrains, function(trainRes) {
          
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
              var dist = calculateDistance(lat, lon, g.latSum/g.count, g.lonSum/g.count);
              nearbyStops.push({ type: 'BUS', id: "B_" + g.ids[0], stopIds: g.ids, name: g.name, dist: dist });
            }
          }

          if (railRes.Stations) {
            for (var r = 0; r < railRes.Stations.length; r++) {
              var rs = railRes.Stations[r];
              var rDist = calculateDistance(lat, lon, rs.Lat, rs.Lon);
              nearbyStops.push({ type: 'RAIL', id: "R_" + rs.Code, stopIds: [rs.Code], name: rs.Name, dist: rDist });
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
            currentPages.push({ id: pin.id, name: pin.name, type: pin.type, stopIds: pin.stopIds, isPinned: true, dist: calculateStopDistance(pin, lat, lon, railRes.Stations, busRes.Stops) });
          }

          for (var n = 0; n < topNearby.length; n++) {
            var nearby = topNearby[n];
            var found = false;
            for (var c = 0; c < currentPages.length; c++) {
              if (currentPages[c].id === nearby.id) { found = true; break; }
            }
            if (!found) {
              nearby.isPinned = false;
              currentPages.push(nearby);
            }
          }

          var payload = {};
          payload[KEYS.REQUEST_TYPE] = 0;
          payload[KEYS.INDEX] = -1;
          payload[KEYS.BEARING] = pinnedStops.length;

          Pebble.sendAppMessage(payload, function() {
            var allBusIdsArr = [];
            for (var idx = 0; idx < currentPages.length; idx++) {
              if (currentPages[idx].type === 'BUS') {
                allBusIdsArr = allBusIdsArr.concat(currentPages[idx].stopIds);
              }
            }
            var allBusIds = allBusIdsArr.join(',');
            
            if (allBusIds.length > 0) {
               fetchWMATA('https://api.wmata.com/NextBusService.svc/json/jPredictions?StopID=' + allBusIds + '&cb=' + Date.now(), function(liveBusRes) {
                 streamPagesToWatch(currentPages, liveBusRes.Predictions || [], trainRes.Trains || [], 0);
               });
            } else {
               streamPagesToWatch(currentPages, [], trainRes.Trains || [], 0);
            }
          });

        });
      });
    });
  }, function(err) { console.log("Loc fail"); }, { timeout: 15000, maximumAge: 30000 });
}

function calculateStopDistance(page, myLat, myLon, railStats, busStats) {
    return 99999; 
}

function streamPagesToWatch(pages, allBuses, allTrains, index) {
  if (index >= pages.length || index >= 10) return;
  var page = pages[index];
  var distStr = page.dist > 1320 ? (page.dist / 5280).toFixed(1) + " mi" : (page.dist === 99999 ? "Pinned" : Math.round(page.dist) + " ft");

  var rows = [];
  if (page.type === 'RAIL') {
    var sTrains = [];
    for (var t1 = 0; t1 < allTrains.length; t1++) {
      if (page.stopIds.indexOf(allTrains[t1].LocationCode) !== -1) sTrains.push(allTrains[t1]);
    }
    sTrains = sTrains.slice(0, 5);
    
    for (var t2 = 0; t2 < sTrains.length; t2++) {
      var tr = sTrains[t2];
      var tMins = (tr.Min === "ARR" || tr.Min === "BRD" || tr.Min === "---") ? tr.Min : tr.Min;
      rows.push(tr.Line + "|" + shrinkName(tr.Destination, 14) + "|" + tMins);
    }
  } else {
    var sBuses = [];
    for (var b1 = 0; b1 < allBuses.length; b1++) {
      if (page.stopIds.indexOf(allBuses[b1].StopID) !== -1) sBuses.push(allBuses[b1]);
    }
    sBuses = sBuses.slice(0, 5);
    
    for (var b2 = 0; b2 < sBuses.length; b2++) {
      var bs = sBuses[b2];
      var bMins = (bs.Minutes === "0" || bs.Minutes === "ARR") ? "ARR" : bs.Minutes;
      var headsign = shrinkName(cleanHeadsign(bs.DirectionText), 14);
      rows.push(bs.RouteID + "|" + headsign + "|" + bMins);
    }
  }
  if (rows.length === 0) rows.push(" |-- NO DATA --|--");

  var dict = {}; 
  dict[KEYS.REQUEST_TYPE] = 0; 
  dict[KEYS.INDEX] = index; 
  dict[KEYS.TARGET_ID] = String(page.id); 
  dict[KEYS.TITLE] = String(page.name); 
  dict[KEYS.SUBTITLE] = String(distStr + "^" + (page.isPinned ? "1" : "0") + "^" + page.type + "^" + rows.join("~"));
  
  Pebble.sendAppMessage(dict, function() { setTimeout(function() { streamPagesToWatch(pages, allBuses, allTrains, index + 1); }, 50); });
}

function cleanHeadsign(text) { if (!text) return "Unknown"; var idx = text.toLowerCase().indexOf(" to "); return idx !== -1 ? text.substring(idx + 4) : text; }
function calculateDistance(lat1, lon1, lat2, lon2) { var R = 20925640; var dLat = (lat2 - lat1) * Math.PI / 180; var dLon = (lon2 - lon1) * Math.PI / 180; var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2); var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); return R * c; }