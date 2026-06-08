var currentStopId = null;
var currentStopName = ""; 
var currentStopIds = []; 
var currentRouteId = null;
var currentTripId = null;
var currentScreenState = 0; 
var refreshInterval = null;

const KEYS = { REQUEST_TYPE: 0, TARGET_ID: 1, BEARING: 2, DISTANCE: 3, INDEX: 4, TITLE: 5, SUBTITLE: 6 };

Pebble.addEventListener('ready', function(e) {
  fetchNearbyTransit();
  if (!refreshInterval) refreshInterval = setInterval(refreshActiveScreen, 30000);
});

Pebble.addEventListener('appmessage', function(e) {
  var dict = e.payload;
  if (dict[KEYS.REQUEST_TYPE] !== undefined) {
    currentScreenState = dict[KEYS.REQUEST_TYPE];
    if (currentScreenState === 1) {
      currentStopId = dict[KEYS.TARGET_ID];
      if (currentStopId.startsWith("B_")) fetchBusStopDetails(currentStopId.substring(2));
      else if (currentStopId.startsWith("R_")) fetchRailStationDetails(currentStopId.substring(2));
    } else if (currentScreenState === 2) {
      currentRouteId = dict[KEYS.TARGET_ID];
      if (currentRouteId === "RAIL_TRAIN") sendUnavailableMessage("Metro Rail", "Live Only - No Schedule");
      else fetchRouteScheduleAtStop(currentStopId.substring(2), currentRouteId);
    } else if (currentScreenState === 3) {
      currentTripId = dict[KEYS.TARGET_ID];
      fetchTripDetails(currentRouteId, currentTripId, currentStopId.substring(2));
    }
  }
});

function refreshActiveScreen() {
  if (currentScreenState === 0) fetchNearbyTransit();
  else if (currentScreenState === 1 && currentStopId) {
    if (currentStopId.startsWith("B_")) fetchBusStopDetails(currentStopId.substring(2));
    else if (currentStopId.startsWith("R_")) fetchRailStationDetails(currentStopId.substring(2));
  }
  else if (currentScreenState === 2 && currentStopId && currentRouteId && currentRouteId !== "RAIL_TRAIN") {
    fetchRouteScheduleAtStop(currentStopId.substring(2), currentRouteId);
  }
}

// ==========================================
// 🛡️ API QUEUE & MULTI-FETCH HELPERS
// ==========================================
var fetchQueue = [];
var isFetching = false;

function fetchWMATA(url, callback) {
  fetchQueue.push({url: url, callback: callback});
  processFetchQueue();
}

function processFetchQueue() {
  if (isFetching || fetchQueue.length === 0) return;
  isFetching = true;
  var task = fetchQueue.shift();
  var req = new XMLHttpRequest();
  req.open('GET', task.url, true);
  req.setRequestHeader('api_key', '20c44341f61b450d815d3c79e2a593e9');
  req.onload = function() {
    var res = {};
    if (req.status === 200) { try { res = JSON.parse(req.responseText); } catch(e) {} }
    task.callback(res);
    setTimeout(function() { isFetching = false; processFetchQueue(); }, 150); 
  };
  req.onerror = function() { task.callback({}); setTimeout(function() { isFetching = false; processFetchQueue(); }, 150); };
  req.send(null);
}

function fetchGroupSchedules(ids, offsetDays, callback) {
  var results = [];
  var pending = ids.length;
  if (pending === 0) return callback([]);
  
  ids.forEach(function(id) {
    var url = 'https://api.wmata.com/Bus.svc/json/jStopSchedule?StopID=' + id + '&Date=' + getLocalDateString(offsetDays) + '&cb=' + Date.now();
    fetchWMATA(url, function(res) {
      if (res && res.ScheduleArrivals) results = results.concat(res.ScheduleArrivals);
      pending--;
      if (pending === 0) callback(results);
    });
  });
}

function getLocalDateString(offsetDays) {
  var d = new Date(); d.setDate(d.getDate() + offsetDays);
  var yyyy = d.getFullYear(); var mm = d.getMonth() + 1; var dd = d.getDate();
  return yyyy + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
}

// ==========================================
// 📍 TIER 1: UNIFIED NEARBY TRANSIT
// ==========================================
function fetchNearbyTransit() {
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude; var lon = pos.coords.longitude;
    var urlBus = 'https://api.wmata.com/Bus.svc/json/jStops?Lat=' + lat + '&Lon=' + lon + '&Radius=800&cb=' + Date.now();
    var urlRail = 'https://api.wmata.com/Rail.svc/json/jStations';
    var urlTrains = 'https://api.wmata.com/StationPrediction.svc/json/GetPrediction/All';

    fetchWMATA(urlBus, function(busRes) {
      fetchWMATA(urlRail, function(railRes) {
        fetchWMATA(urlTrains, function(trainRes) {
          var unifiedStops = [];
          
          // 1. Group Bus Stops by Name and calculate Centroid
          if (busRes.Stops) {
            var groups = {};
            busRes.Stops.forEach(function(bs) {
              if (!groups[bs.Name]) groups[bs.Name] = { ids: [], latSum: 0, lonSum: 0, count: 0, routes: [], name: bs.Name };
              groups[bs.Name].ids.push(bs.StopID);
              groups[bs.Name].latSum += bs.Lat;
              groups[bs.Name].lonSum += bs.Lon;
              groups[bs.Name].count++;
              bs.Routes.forEach(function(r) { if (!groups[bs.Name].routes.includes(r)) groups[bs.Name].routes.push(r); });
            });

            for (var key in groups) {
              var g = groups[key];
              var cLat = g.latSum / g.count;
              var cLon = g.lonSum / g.count;
              var dist = calculateDistance(lat, lon, cLat, cLon);
              unifiedStops.push({ type: 'BUS', id: "B_" + g.ids[0], stopIds: g.ids, name: g.name, lat: cLat, lon: cLon, dist: dist, routes: g.routes });
            }
          }

          // 2. Process ALL Rail Stations (Distance limit removed)
          if (railRes.Stations) {
            railRes.Stations.forEach(function(rs) {
              var dist = calculateDistance(lat, lon, rs.Lat, rs.Lon);
              unifiedStops.push({ type: 'RAIL', id: "R_" + rs.Code, stopIds: [rs.Code], name: rs.Name + " (Metro)", lat: rs.Lat, lon: rs.Lon, dist: dist });
            });
          }

          // 3. Guarantee the Top 2 Metro Stops Logic
          var railStops = unifiedStops.filter(function(s) { return s.type === 'RAIL'; }).sort(function(a, b) { return a.dist - b.dist; });
          var busStops = unifiedStops.filter(function(s) { return s.type === 'BUS'; }).sort(function(a, b) { return a.dist - b.dist; });
          
          var topStops = [];
          
          // Inject the 2 closest Rail Stations immediately
          if (railStops.length > 0) topStops.push(railStops.shift());
          if (railStops.length > 0) topStops.push(railStops.shift());
          
          // Pool the remaining rail stations and buses together, sort them, and fill the last 3 slots
          var remainingPool = railStops.concat(busStops).sort(function(a, b) { return a.dist - b.dist; });
          while (topStops.length < 5 && remainingPool.length > 0) {
            topStops.push(remainingPool.shift());
          }
          
          // Final sort so they display chronologically by distance on the screen
          topStops.sort(function(a, b) { return a.dist - b.dist; });

          if (topStops.length > 0) {
            var clearDict = {}; clearDict[KEYS.REQUEST_TYPE] = 0; clearDict[KEYS.INDEX] = -1; 
            Pebble.sendAppMessage(clearDict, function() { streamUnifiedData(topStops, lat, lon, trainRes.Trains || [], 0); });
          }
        });
      });
    });
  }, function(err) { console.log("Loc fail"); }, { timeout: 15000, maximumAge: 30000 });
}

function streamUnifiedData(stops, myLat, myLon, allTrains, index) {
  if (index >= stops.length || index >= 5) return;
  var stop = stops[index];
  var distStr = stop.dist > 1320 ? (stop.dist / 5280).toFixed(1) + " mi" : Math.round(stop.dist) + " ft";

  if (stop.type === 'RAIL') {
    var stationTrains = allTrains.filter(function(t) { return t.LocationCode === stop.stopIds[0]; }).slice(0, 5);
    var subLines = [];
    for(var t=0; t<stationTrains.length; t++) {
      var tr = stationTrains[t];
      var mins = (tr.Min === "ARR" || tr.Min === "BRD" || tr.Min === "---") ? tr.Min : tr.Min + " min";
      subLines.push(tr.Line + " " + tr.Destination + " - " + mins);
    }
    if (subLines.length === 0) subLines.push("No trains arriving");
    
    var dict = {}; dict[KEYS.REQUEST_TYPE] = 0; dict[KEYS.INDEX] = index; dict[KEYS.TARGET_ID] = String(stop.id); 
    dict[KEYS.TITLE] = String(stop.name); dict[KEYS.SUBTITLE] = String(distStr + "\n" + subLines.join("\n"));
    Pebble.sendAppMessage(dict, function() { setTimeout(function() { streamUnifiedData(stops, myLat, myLon, allTrains, index + 1); }, 50); });
  } else {
    var urlLive = 'https://api.wmata.com/NextBusService.svc/json/jPredictions?StopID=' + stop.stopIds.join(',') + '&cb=' + Date.now();
    fetchWMATA(urlLive, function(liveRes) {
      fetchGroupSchedules(stop.stopIds, 0, function(schedToday) {
        fetchGroupSchedules(stop.stopIds, 1, function(schedTmrw) {
          var combined = processTransitData(liveRes.Predictions, schedToday, schedTmrw, stop.routes);
          var subLines = [];
          for (var i = 0; i < Math.min(combined.length, 5); i++) subLines.push(combined[i].route + " " + combined[i].headsign + " - " + combined[i].displayTime);
          if (subLines.length === 0) subLines.push("No scheduled buses");
          
          var dict = {}; dict[KEYS.REQUEST_TYPE] = 0; dict[KEYS.INDEX] = index; dict[KEYS.TARGET_ID] = String(stop.id); 
          dict[KEYS.TITLE] = String(stop.name); dict[KEYS.SUBTITLE] = String(distStr + "\n" + subLines.join("\n"));
          Pebble.sendAppMessage(dict, function() { setTimeout(function() { streamUnifiedData(stops, myLat, myLon, allTrains, index + 1); }, 250); });
        });
      });
    });
  }
}

// ==========================================
// 🚌 TIER 2: BUS DETAILS (Grouped Edition)
// ==========================================
function fetchBusStopDetails(primaryId) {
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude; var lon = pos.coords.longitude;
    var urlStops = 'https://api.wmata.com/Bus.svc/json/jStops?Lat=' + lat + '&Lon=' + lon + '&Radius=1000&cb=' + Date.now();
    fetchWMATA(urlStops, function(res) {
      if (res.Stops) {
        var anchorStop = res.Stops.find(function(s) { return s.StopID === primaryId; });
        if (anchorStop) {
          currentStopName = anchorStop.Name; 
          
          var groupIds = []; var latSum = 0; var lonSum = 0; var routes = [];
          res.Stops.forEach(function(s) {
            if (s.Name === currentStopName) {
              groupIds.push(s.StopID);
              latSum += s.Lat; lonSum += s.Lon;
              s.Routes.forEach(function(r) { if(!routes.includes(r)) routes.push(r); });
            }
          });

          currentStopIds = groupIds;

          var cLat = latSum / groupIds.length; var cLon = lonSum / groupIds.length;
          var bearing = calculateBearing(lat, lon, cLat, cLon);
          var dist = calculateDistance(lat, lon, cLat, cLon);
          var distStr = dist > 1320 ? (dist / 5280).toFixed(1) + " mi" : Math.round(dist) + " ft";
          
          var metaDict = {}; metaDict[KEYS.REQUEST_TYPE] = 1; metaDict[KEYS.INDEX] = -1; 
          metaDict[KEYS.BEARING] = Math.round(bearing); metaDict[KEYS.DISTANCE] = distStr; metaDict[KEYS.TITLE] = String(currentStopName); 
          
          Pebble.sendAppMessage(metaDict, function() { 
            var urlLive = 'https://api.wmata.com/NextBusService.svc/json/jPredictions?StopID=' + currentStopIds.join(',') + '&cb=' + Date.now();
            fetchWMATA(urlLive, function(liveRes) {
              fetchGroupSchedules(currentStopIds, 0, function(schedToday) {
                fetchGroupSchedules(currentStopIds, 1, function(schedTmrw) {
                  var combined = processTransitData(liveRes.Predictions, schedToday, schedTmrw, routes);
                  sendPredictionRows(combined, 0);
                });
              });
            });
          });
        }
      }
    });
  });
}

// ==========================================
// 🚆 TIER 2: RAIL DETAILS
// ==========================================
function fetchRailStationDetails(stationCode) {
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude; var lon = pos.coords.longitude;
    var urlRail = 'https://api.wmata.com/Rail.svc/json/jStations';
    fetchWMATA(urlRail, function(res) {
      if (res.Stations) {
        var targetStation = res.Stations.find(function(s) { return s.Code === stationCode; });
        if (targetStation) {
          currentStopName = targetStation.Name;
          var bearing = calculateBearing(lat, lon, targetStation.Lat, targetStation.Lon);
          var dist = calculateDistance(lat, lon, targetStation.Lat, targetStation.Lon);
          var distStr = dist > 1320 ? (dist / 5280).toFixed(1) + " mi" : Math.round(dist) + " ft";

          var metaDict = {}; metaDict[KEYS.REQUEST_TYPE] = 1; metaDict[KEYS.INDEX] = -1; 
          metaDict[KEYS.BEARING] = Math.round(bearing); metaDict[KEYS.DISTANCE] = distStr; 
          metaDict[KEYS.TITLE] = String(currentStopName + " (Metro)"); 

          Pebble.sendAppMessage(metaDict, function() {
            var urlTrains = 'https://api.wmata.com/StationPrediction.svc/json/GetPrediction/' + stationCode;
            fetchWMATA(urlTrains, function(trainRes) {
              var trains = trainRes.Trains || []; var combined = [];
              for(var t=0; t<trains.length; t++) {
                var tr = trains[t];
                var mins = (tr.Min === "ARR" || tr.Min === "BRD" || tr.Min === "---") ? tr.Min : tr.Min + " min";
                combined.push({ route: "RAIL_TRAIN", headsign: tr.Line + " " + tr.Destination, displayTime: mins });
              }
              if(combined.length === 0) combined.push({ route: "RAIL_TRAIN", headsign: "No Trains", displayTime: "--" });
              sendPredictionRows(combined, 0);
            });
          });
        }
      }
    });
  });
}

function sendPredictionRows(preds, index) {
  if (index >= preds.length || index >= 10) return; 
  var p = preds[index];
  var dict = {}; dict[KEYS.REQUEST_TYPE] = 1; dict[KEYS.INDEX] = index;
  dict[KEYS.TARGET_ID] = String(p.route).trim(); dict[KEYS.TITLE] = String(p.route !== "RAIL_TRAIN" ? p.route + " " + p.headsign : p.headsign); 
  dict[KEYS.SUBTITLE] = String(p.displayTime);
  Pebble.sendAppMessage(dict, function() { setTimeout(function() { sendPredictionRows(preds, index + 1); }, 50); }, function() { setTimeout(function() { sendPredictionRows(preds, index); }, 200); });
}

// ==========================================
// 📅 TIER 3: FULL DAY SCHEDULE
// ==========================================
function fetchRouteScheduleAtStop(primaryId, routeId) {
  var groupIds = currentStopIds.length > 0 ? currentStopIds : [primaryId];
  var urlLive = 'https://api.wmata.com/NextBusService.svc/json/jPredictions?StopID=' + groupIds.join(',') + '&cb=' + Date.now();

  fetchWMATA(urlLive, function(liveRes) {
    fetchGroupSchedules(groupIds, 0, function(schedToday) {
      fetchGroupSchedules(groupIds, 1, function(schedTmrw) {
        var safeRouteId = String(routeId).trim().toUpperCase();
        var fullList = []; var now = new Date(); var liveTripIds = {}; 

        var livePreds = liveRes.Predictions || [];
        for (var i = 0; i < livePreds.length; i++) {
          var p = livePreds[i];
          if (p.RouteID && String(p.RouteID).trim().toUpperCase() === safeRouteId) {
            liveTripIds[p.TripID] = true; 
            var mins = (p.Minutes === "0" || p.Minutes === "ARR") ? 0 : parseInt(p.Minutes, 10);
            fullList.push({ rawTime: now.getTime() + (mins * 60000), displayTime: formatTime(p.Minutes) + " (Live)", tripId: p.TripID || safeRouteId, dirText: p.DirectionText });
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

// ==========================================
// 🗺️ TIER 4: TRIP DETAILS
// ==========================================
function fetchTripDetails(routeId, tripId, primaryId) {
  var urlSchedToday = 'https://api.wmata.com/Bus.svc/json/jRouteSchedule?RouteID=' + routeId + '&Date=' + getLocalDateString(0) + '&cb=' + Date.now();
  fetchWMATA(urlSchedToday, function(schedToday) {
    if (findAndSendTrip(schedToday, tripId, primaryId, routeId)) return; 
    var urlSchedTmrw = 'https://api.wmata.com/Bus.svc/json/jRouteSchedule?RouteID=' + routeId + '&Date=' + getLocalDateString(1) + '&cb=' + Date.now();
    fetchWMATA(urlSchedTmrw, function(schedTmrw) {
      if (!findAndSendTrip(schedTmrw, tripId, primaryId, routeId)) {
        sendUnavailableMessage(routeId, "No Trip Data");
      }
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
      if (String(trips[t].TripID).trim() === String(tripId).trim()) {
        targetTrip = trips[t]; headsign = cleanHeadsign(dirs[d].TripHeadsign || trips[t].TripDirectionText); break;
      }
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
          if (groupIds.includes(String(st[s].StopID).trim())) {
            targetTrip = trips2[t2]; headsign = cleanHeadsign(dirs[d2].TripHeadsign || trips2[t2].TripDirectionText) + " (Route)"; break;
          }
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
      var st = targetTrip.StopTimes[i];
      if (groupIds.includes(String(st.StopID).trim())) snapIndex = i;
      
      var displayStr = "--";
      if (exactMatch) { 
        var schedTime = new Date(st.Time.replace('T', ' ').replace(/-/g, '/'));
        var hours = schedTime.getHours(); var ampm = hours >= 12 ? 'p' : 'a'; hours = hours % 12; hours = hours ? hours : 12;
        var m = schedTime.getMinutes(); var cleanMins = m < 10 ? '0' + m : m;
        displayStr = hours + ":" + cleanMins + ampm;
      }
      tripStops.push({ stopName: st.StopName, displayTime: displayStr });
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

// ==========================================
// 🧠 BASE MERGE ENGINE
// ==========================================
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

  for (var k = 0; k < supportedRoutes.length; k++) {
    var routeID = String(supportedRoutes[k]).trim();
    if (!pushedRoutes[routeID]) combined.push({ route: routeID, headsign: "No Service", minutes: 99999, displayTime: "--", tripId: routeID });
  }
  combined.sort(function(a, b) { return a.minutes - b.minutes; }); return combined;
}

function cleanHeadsign(text) { if (!text) return "Unknown"; var idx = text.toLowerCase().indexOf(" to "); return idx !== -1 ? text.substring(idx + 4) : text; }
function formatTime(mins) { return (mins === "0" || mins === "ARR") ? "ARR" : mins + " min"; }
function calculateDistance(lat1, lon1, lat2, lon2) { var R = 20925640; var dLat = (lat2 - lat1) * Math.PI / 180; var dLon = (lon2 - lon1) * Math.PI / 180; var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2); var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); return R * c; }
function calculateBearing(lat1, lon1, lat2, lon2) { var dLon = (lon2 - lon1) * Math.PI / 180; var lat1Rad = lat1 * Math.PI / 180; var lat2Rad = lat2 * Math.PI / 180; var y = Math.sin(dLon) * Math.cos(lat2Rad); var x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon); return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360; }