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
    const {
        fromTerminal = 'Start',
        toTerminal = 'End',
        busesAssigned,
        numberOfShifts,
        dutyDurationHours,
        leg1,
        leg2,
        serviceStartTime = '00:00',
        timeAdjustmentRules = [],
        crewDutyRules = {},
        isTurnoutFromDepot = false,
        depotName = 'Depot',
        depotConnections = {},
        frequency: frequencyDetails,
        hasDynamicSecondShift = false,
        secondShiftStartTime
    } = routeDetails;

    const numBuses = parseInt(busesAssigned, 10) || 1;
    const numShifts = parseInt(numberOfShifts, 10) || 1;
    const dutyHours = parseFloat(dutyDurationHours) || 8;
    const leg1Km = parseFloat(leg1?.kilometers) || 0;
    const leg1Tpk = parseFloat(leg1?.timePerKm) || 0;
    const leg2Km = parseFloat(leg2?.kilometers) || 0;
    const leg2Tpk = parseFloat(leg2?.timePerKm) || 0;

    if (numBuses <= 0) return { schedules: {}, warnings: ["Buses Assigned must be greater than 0."] };

    const baseLeg1Dur = calculateLegDuration(leg1Km, leg1Tpk);
    const baseLeg2Dur = calculateLegDuration(leg2Km, leg2Tpk);
    const totalRoundTripDuration = baseLeg1Dur + baseLeg2Dur;
    
    // --- 1. FREQUENCY LOGIC ---
    let effectiveFrequency;
    if (frequencyDetails?.type === 'dynamic' && frequencyDetails.dynamicMinutes > 0) {
        // If frequency is 'dynamic' and minutes are provided, use that value.
        effectiveFrequency = Number(frequencyDetails.dynamicMinutes);
    } else {
        // Otherwise, calculate the frequency using the standard formula.
        effectiveFrequency = Math.ceil(totalRoundTripDuration / numBuses);
    }
    if (!effectiveFrequency || effectiveFrequency < 1) {
        effectiveFrequency = 10; // Default to 10 minutes if calculation is invalid.
    }

    // --- 2. DYNAMIC SHIFT START TIME LOGIC ---
    const shiftStartTimes = [];
    if (numShifts > 0) {
        shiftStartTimes.push(parseTimeToMinutes(serviceStartTime));
    }
    for (let i = 1; i < numShifts; i++) {
        // Check for the second shift specifically
        if (i === 1 && hasDynamicSecondShift && secondShiftStartTime) {
            // If it's the second shift and dynamic time is set, use it.
            shiftStartTimes.push(parseTimeToMinutes(secondShiftStartTime));
        } else {
            // For all other subsequent shifts (3rd, 4th, etc.), chain them normally.
            const prevShiftStartTime = shiftStartTimes[i - 1];
            shiftStartTimes.push(prevShiftStartTime + (dutyHours * 60));
        }
    }

    let busStates = [];
    shiftStartTimes.forEach((shiftBlockStartTime, shiftIndex) => {
        for (let busIndex = 0; busIndex < numBuses; busIndex++) {
            const dutyStart = shiftBlockStartTime + (busIndex * effectiveFrequency);
            const busState = {
                id: `Bus ${busIndex + 1} - S${shiftIndex + 1}`,
                dutyStartTime: dutyStart,
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
    });
    
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

        const lastDepartureTime = Math.max(...busStates.map(b => b.schedule.filter(e => e.type === 'Trip' && e.legs[0]?.departureLocation === departureLocation).map(e => e.rawDepartureTime)).flat(), -1);
        const idealDepartureTime = (lastDepartureTime > -1) ? lastDepartureTime + effectiveFrequency : busToDispatch.availableFromTime;
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

    const finalSchedules = {};
    busStates.forEach(bus => {
        const [busId, shiftId] = bus.id.split(' - ');
        if (!finalSchedules[shiftId]) finalSchedules[shiftId] = {};
        finalSchedules[shiftId][bus.id] = bus.schedule;
    });

    return { schedules: finalSchedules, warnings: [] };
}


module.exports = { generateFullRouteSchedule };
