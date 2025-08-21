// backend/utils/scheduleCalculator.js
function calculateLegDuration(kilometers, timePerKm) {
    return kilometers * timePerKm;
}

function parseTimeToMinutes(timeValue) {
    if (typeof timeValue === 'number') return timeValue;
    if (typeof timeValue !== 'string' || !timeValue.includes(':')) {
        const num = Number(timeValue);
        return isNaN(num) ? 0 : num;
    }
    const [hours, minutes] = timeValue.split(':').map(Number);
    return hours * 60 + minutes;
}

function formatMinutesToTime(totalMinutes) {
    totalMinutes = Math.round(totalMinutes);
    const dayMinutes = totalMinutes % 1440;
    const hours = Math.floor(dayMinutes / 60);
    const minutes = dayMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function applyTimeAdjustments(tripStartTimeMinutes, baseTripDurationMinutes, adjustmentRules) {
    let adjustedDuration = baseTripDurationMinutes;
    if (!Array.isArray(adjustmentRules)) return adjustedDuration;
    const tripStartDayMinutes = tripStartTimeMinutes % 1440;

    adjustmentRules.forEach(rule => {
        const ruleStartTime = parseTimeToMinutes(rule.startTime);
        const ruleEndTime = parseTimeToMinutes(rule.endTime);
        const timeAdjustment = parseFloat(rule.timeAdjustment) || 0;
        if (ruleStartTime <= ruleEndTime) {
            if (tripStartDayMinutes >= ruleStartTime && tripStartDayMinutes < ruleEndTime) {
                adjustedDuration += timeAdjustment;
            }
        } else {
            if (tripStartDayMinutes >= ruleStartTime || tripStartDayMinutes < ruleEndTime) {
                adjustedDuration += timeAdjustment;
            }
        }
    });
    return adjustedDuration;
}

function generateFullRouteSchedule(routeDetails) {
    const fromTerminal = routeDetails.fromTerminal || 'Start';
    const toTerminal = routeDetails.toTerminal || 'End';
    const numBuses = parseInt(routeDetails.busesAssigned, 10) || 1;
    const numShifts = parseInt(routeDetails.numberOfShifts, 10) || 1;
    const dutyHours = parseFloat(routeDetails.dutyDurationHours) || 8;
    const leg1Km = parseFloat(routeDetails.leg1?.kilometers) || 0;
    const leg1Tpk = parseFloat(routeDetails.leg1?.timePerKm) || 0;
    const leg2Km = parseFloat(routeDetails.leg2?.kilometers) || 0;
    const leg2Tpk = parseFloat(routeDetails.leg2?.timePerKm) || 0;
    const serviceStartTime = routeDetails.serviceStartTime || '00:00';
    const timeAdjustmentRules = routeDetails.timeAdjustmentRules || [];
    const crewDutyRules = routeDetails.crewDutyRules || {};
    const isTurnoutFromDepot = routeDetails.isTurnoutFromDepot || false;
    const depotName = routeDetails.depotName || 'Depot';
    const depotConnections = routeDetails.depotConnections || {};

    if (numBuses <= 0) return { schedules: {}, warnings: ["Buses Assigned must be greater than 0."] };

    const baseLeg1Dur = calculateLegDuration(leg1Km, leg1Tpk);
    const baseLeg2Dur = calculateLegDuration(leg2Km, leg2Tpk);
    const totalRoundTripDuration = baseLeg1Dur + baseLeg2Dur;
    
    let frequency = Math.ceil(totalRoundTripDuration / numBuses) || 10;
    if (frequency < 1) frequency = 10;

    let busStates = [];
    for (let shiftIndex = 0; shiftIndex < numShifts; shiftIndex++) {
        const shiftBlockStartTime = parseTimeToMinutes(serviceStartTime) + (shiftIndex * dutyHours * 60);
        for (let busIndex = 0; busIndex < numBuses; busIndex++) {
            const dutyStart = shiftBlockStartTime + (busIndex * frequency);
            const busState = {
                id: `Bus ${busIndex + 1} - S${shiftIndex + 1}`,
                dutyStartTime: dutyStart, // Store the original planned start time
                schedule: [],
                location: isTurnoutFromDepot ? depotName : fromTerminal,
                availableFromTime: dutyStart,
                dutyEndTime: dutyStart + (dutyHours * 60),
                breakTaken: false, tripCount: 0, isDone: false,
            };
            busState.schedule.push({ type: 'Calling Time', time: formatMinutesToTime(dutyStart), rawTime: dutyStart });
            busState.schedule.push({ type: 'Preparation', time: formatMinutesToTime(dutyStart + 15), rawTime: dutyStart + 15 });
            busState.availableFromTime = dutyStart + 15;
            busStates.push(busState);
        }
    }
    
    if (isTurnoutFromDepot) {
        busStates.forEach(busState => {
            const timeToStart = parseFloat(depotConnections.timeFromDepotToStart) || 0;
            const arrivalAtStartTime = busState.availableFromTime + timeToStart;
            busState.schedule.push({ type: 'Depot Movement', legs: [{departureTime: formatMinutesToTime(busState.availableFromTime), arrivalTime: formatMinutesToTime(arrivalAtStartTime), rawDepartureTime: busState.availableFromTime}], rawDepartureTime: busState.availableFromTime });
            busState.availableFromTime = arrivalAtStartTime;
            busState.location = fromTerminal;
        });
    }

    let continueScheduling = true;
    while (continueScheduling) {
        const activeBuses = busStates.filter(b => !b.isDone);
        if (activeBuses.length === 0) {
            continueScheduling = false; break;
        }
        activeBuses.sort((a, b) => a.availableFromTime - b.availableFromTime);
        const busToDispatch = activeBuses[0];
        
        const { location: departureLocation } = busToDispatch;
        if (!fromTerminal || !toTerminal || (departureLocation !== fromTerminal && departureLocation !== toTerminal)) {
            busToDispatch.isDone = true; continue;
        }

        const isReturnTrip = departureLocation === toTerminal;
        const currentLegBaseDur = isReturnTrip ? baseLeg2Dur : baseLeg1Dur;
        if (currentLegBaseDur <= 0 && isReturnTrip) { busToDispatch.isDone = true; continue; }

        const dynamicHeadway = Math.max(1, Math.ceil(applyTimeAdjustments(busToDispatch.availableFromTime, totalRoundTripDuration, timeAdjustmentRules) / numBuses));
        const lastDepartureTime = Math.max(...busStates.map(b => b.schedule.filter(e => e.type === 'Trip' && e.legs?.departureLocation === departureLocation).map(e => e.rawDepartureTime)).flat(), -1);
        const idealDepartureTime = (lastDepartureTime > -1) ? lastDepartureTime + dynamicHeadway : busToDispatch.availableFromTime;
        const actualDepartureTime = Math.max(idealDepartureTime, busToDispatch.availableFromTime);
        const legDuration = applyTimeAdjustments(actualDepartureTime, currentLegBaseDur, timeAdjustmentRules);
        const legEndTime = actualDepartureTime + legDuration;
        const arrivalLocation = isReturnTrip ? fromTerminal : toTerminal;
        
        const checkingInDuration = 15;
        const lastTripEndTimeAllowed = busToDispatch.dutyEndTime - checkingInDuration;
        let timeToReturnToDepot = 0;
        if (isTurnoutFromDepot) {
            timeToReturnToDepot = arrivalLocation === fromTerminal 
                ? (parseFloat(depotConnections.timeFromStartToDepot) || 0)
                : (parseFloat(depotConnections.timeFromEndToDepot) || 0);
        }

        if (legEndTime + timeToReturnToDepot > lastTripEndTimeAllowed) {
            busToDispatch.isDone = true; continue;
        }

        const legEvent = { legNumber: isReturnTrip ? 2 : 1, departureTime: formatMinutesToTime(actualDepartureTime), rawDepartureTime: actualDepartureTime, departureLocation, arrivalTime: formatMinutesToTime(legEndTime), arrivalLocation };
        
        const lastTripEvent = busToDispatch.schedule.slice().reverse().find(e => e.type === 'Trip');
        if (isReturnTrip && lastTripEvent && lastTripEvent.legs.length === 1) {
            lastTripEvent.legs.push(legEvent);
            lastTripEvent.rawArrivalTime = legEndTime;
        } else {
            busToDispatch.tripCount++;
            busToDispatch.schedule.push({ type: 'Trip', tripNumber: busToDispatch.tripCount, legs: [legEvent], rawDepartureTime: actualDepartureTime, rawArrivalTime: legEndTime });
        }
        
        let newAvailableTime = legEndTime;
        if (crewDutyRules.hasBreak && !busToDispatch.breakTaken && arrivalLocation === crewDutyRules.breakLocation) {
            const elapsedTime = newAvailableTime - busToDispatch.dutyStartTime;
            if (elapsedTime >= (parseFloat(crewDutyRules.breakWindowStart) || 240) && elapsedTime <= (parseFloat(crewDutyRules.breakWindowEnd) || 360)) {
                const breakDuration = parseFloat(crewDutyRules.breakDuration) || 30;
                const breakEndTime = newAvailableTime + breakDuration;
                if (breakEndTime < busToDispatch.dutyEndTime) {
                    busToDispatch.schedule.push({ type: 'Break', startTime: formatMinutesToTime(newAvailableTime), endTime: formatMinutesToTime(breakEndTime), location: arrivalLocation, rawTime: newAvailableTime });
                    newAvailableTime = breakEndTime;
                    busToDispatch.breakTaken = true;
                }
            }
        }
        busToDispatch.location = arrivalLocation;
        busToDispatch.availableFromTime = newAvailableTime;
    }
    
    // First Pass: Calculate and add final events
    busStates.forEach(bus => {
        let finalAvailableTime = bus.availableFromTime;
        if (isTurnoutFromDepot && bus.location !== depotName) {
            const timeToDepot = bus.location === fromTerminal ? (parseFloat(depotConnections.timeFromStartToDepot) || 0) : (parseFloat(depotConnections.timeFromEndToDepot) || 0);
            const arrivalAtDepotTime = bus.availableFromTime + timeToDepot;
            if (timeToDepot > 0 && arrivalAtDepotTime <= bus.dutyEndTime - 15) {
                 bus.schedule.push({ type: 'Trip to Depot', legs: [{departureTime: formatMinutesToTime(bus.availableFromTime), arrivalTime: formatMinutesToTime(arrivalAtDepotTime), rawDepartureTime: bus.availableFromTime, rawArrivalTime: arrivalAtDepotTime}], rawDepartureTime: bus.availableFromTime });
                 finalAvailableTime = arrivalAtDepotTime;
            }
        }

        const checkingTimeStart = finalAvailableTime;
        const potentialDutyEnd = checkingTimeStart + 15;
        const actualDutyEndTime = Math.min(potentialDutyEnd, bus.dutyEndTime);

        bus.schedule.push({ type: 'Checking Time', time: formatMinutesToTime(checkingTimeStart), rawTime: checkingTimeStart });
        bus.schedule.push({ type: 'Duty End', time: formatMinutesToTime(actualDutyEndTime), rawTime: actualDutyEndTime });
        
        bus.schedule.sort((a,b) => (a.rawTime ?? a.rawDepartureTime) - (b.rawTime ?? b.rawDepartureTime));
    });

    // THE FIX IS HERE: Post-processing pass to correct subsequent shift start times
    const actualEndTimesMap = {};
    busStates.forEach(bus => {
        const endEvent = bus.schedule.find(e => e.type === 'Duty End');
        if (endEvent) {
            actualEndTimesMap[bus.id] = endEvent.rawTime;
        }
    });

    busStates.forEach(bus => {
        const match = bus.id.match(/Bus (\d+) - S(\d+)/);
        if (!match) return;

        const busNumber = parseInt(match[1]);
        const shiftNumber = parseInt(match[2]);

        if (shiftNumber > 1) {
            const prevShiftId = `Bus ${busNumber} - S${shiftNumber - 1}`;
            const prevShiftActualEndTime = actualEndTimesMap[prevShiftId];
            
            if (prevShiftActualEndTime !== undefined) {
                const currentShiftPlannedStartTime = bus.dutyStartTime;
                const timeDifference = currentShiftPlannedStartTime - prevShiftActualEndTime;

                if (timeDifference !== 0) {
                    bus.schedule.forEach(event => {
                        // Correct all raw time values
                        if (event.rawTime !== undefined) event.rawTime -= timeDifference;
                        if (event.rawDepartureTime !== undefined) event.rawDepartureTime -= timeDifference;
                        if (event.rawArrivalTime !== undefined) event.rawArrivalTime -= timeDifference;

                        // Correct all formatted time strings
                        if (event.time) event.time = formatMinutesToTime(parseTimeToMinutes(event.time) - timeDifference);
                        if (event.startTime) event.startTime = formatMinutesToTime(parseTimeToMinutes(event.startTime) - timeDifference);
                        if (event.endTime) event.endTime = formatMinutesToTime(parseTimeToMinutes(event.endTime) - timeDifference);
                        
                        if (event.legs) {
                            event.legs.forEach(leg => {
                                if (leg.departureTime) leg.departureTime = formatMinutesToTime(parseTimeToMinutes(leg.departureTime) - timeDifference);
                                if (leg.arrivalTime) leg.arrivalTime = formatMinutesToTime(parseTimeToMinutes(leg.arrivalTime) - timeDifference);
                            });
                        }
                    });
                }
            }
        }
    });

    const finalSchedules = {};
    busStates.forEach(bus => {
        const [busId, shiftId] = bus.id.split(' - ');
        if (!finalSchedules[shiftId]) finalSchedules[shiftId] = {};
        finalSchedules[shiftId][bus.id] = bus.schedule;
    });
    console.log('Final Schedules:', finalSchedules);
    return { schedules: finalSchedules, warnings: [] };
}

module.exports = { generateFullRouteSchedule };
