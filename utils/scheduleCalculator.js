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
    
    let effectiveFrequency;
    if (frequencyDetails?.type === 'dynamic' && frequencyDetails.dynamicMinutes > 0) {
        effectiveFrequency = Number(frequencyDetails.dynamicMinutes);
    } else {
        effectiveFrequency = Math.ceil(totalRoundTripDuration / numBuses);
    }
    if (!effectiveFrequency || effectiveFrequency < 1) {
        effectiveFrequency = 10;
    }

    const allScheduledBusStates = [];
    const lastShiftActualEndTimes = new Map(); // K: busNumber, V: actual end time in minutes

    // --- NEW LOGIC: Process each shift sequentially ---
    for (let shiftIndex = 0; shiftIndex < numShifts; shiftIndex++) {
        const currentShiftBusStates = [];

        // PART 1: Initialize the duties for the current shift
        for (let busIndex = 0; busIndex < numBuses; busIndex++) {
            const busNumber = busIndex + 1;
            let dutyStartTime;

            if (shiftIndex === 0) {
                // First shift starts based on service time and frequency
                dutyStartTime = parseTimeToMinutes(serviceStartTime) + (busIndex * effectiveFrequency);
            } else {
                if (shiftIndex === 1 && hasDynamicSecondShift && secondShiftStartTime) {
                    // Dynamic logic for the second shift
                    const shiftBlockStartTime = parseTimeToMinutes(secondShiftStartTime);
                    dutyStartTime = shiftBlockStartTime + (busIndex * effectiveFrequency);
                } else {
                    // Normal logic: Start immediately after the previous shift's ACTUAL recorded end time
                    dutyStartTime = lastShiftActualEndTimes.get(busNumber) || 0;
                    // Failsafe in case a previous end time wasn't recorded
                    if (dutyStartTime === 0) {
                        const prevShift = allScheduledBusStates.find(b => b.id === `Bus ${busNumber} - S${shiftIndex}`);
                        dutyStartTime = prevShift ? prevShift.dutyEndTime : 0;
                    }
                }
            }

            const busState = {
                id: `Bus ${busNumber} - S${shiftIndex + 1}`,
                dutyStartTime: dutyStartTime,
                dutyEndTime: dutyStartTime + (dutyHours * 60),
                schedule: [],
                location: isTurnoutFromDepot ? depotName : fromTerminal,
                availableFromTime: dutyStartTime,
                breakTaken: false, tripCount: 0, isDone: false,
            };
            busState.schedule.push({ type: 'Calling Time', time: formatMinutesToTime(dutyStartTime), rawTime: dutyStartTime });
            busState.schedule.push({ type: 'Preparation', time: formatMinutesToTime(dutyStartTime + 15), rawTime: dutyStartTime + 15 });
            busState.availableFromTime = dutyStartTime + 15;
            currentShiftBusStates.push(busState);
        }

        // PART 2: Run the scheduling simulation for ONLY the current shift
        if (isTurnoutFromDepot) {
            currentShiftBusStates.forEach(busState => {
                const timeToStart = parseFloat(depotConnections.timeFromDepotToStart) || 0;
                const arrivalAtStartTime = busState.availableFromTime + timeToStart;
                busState.schedule.push({ type: 'Depot Movement', legs: [{departureTime: formatMinutesToTime(busState.availableFromTime), arrivalTime: formatMinutesToTime(arrivalAtStartTime), rawDepartureTime: busState.availableFromTime}], rawDepartureTime: busState.availableFromTime });
                busState.availableFromTime = arrivalAtStartTime;
                busState.location = fromTerminal;
            });
        }
        
        let continueScheduling = true;
        while (continueScheduling) {
            const activeBuses = currentShiftBusStates.filter(b => !b.isDone);
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

            const lastDepartureTime = Math.max(...currentShiftBusStates.map(b => b.schedule.filter(e => e.type === 'Trip' && e.legs[0]?.departureLocation === departureLocation).map(e => e.rawDepartureTime)).flat(), -1);
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

        // PART 3: Finalize the current shift and record actual end times
        currentShiftBusStates.forEach(bus => {
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
            
            // Record the actual end time for the next shift to use
            const busNumber = parseInt(bus.id.match(/Bus (\d+)/)[1]);
            lastShiftActualEndTimes.set(busNumber, actualDutyEndTime);
        });

        // Add the fully scheduled buses for this shift to the main list
        allScheduledBusStates.push(...currentShiftBusStates);
    }

    // PART 4: Format final output
    const finalSchedules = {};
    allScheduledBusStates.forEach(bus => {
        const [busId, shiftId] = bus.id.split(' - ');
        if (!finalSchedules[shiftId]) finalSchedules[shiftId] = {};
        finalSchedules[shiftId][bus.id] = bus.schedule;
    });

    return { schedules: finalSchedules, warnings: [] };
}

module.exports = { generateFullRouteSchedule };
