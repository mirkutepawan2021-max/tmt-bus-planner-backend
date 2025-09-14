// backend/utils/scheduleCalculator.js

function calculateLegDuration(kilometers, timePerKm) {
    return parseFloat(kilometers || 0) * parseFloat(timePerKm || 0);
}

function parseTimeToMinutes(timeValue) {
    if (typeof timeValue === 'number') return timeValue;
    if (typeof timeValue !== 'string' || !timeValue.includes(':')) {
        const num = Number(timeValue);
        return isNaN(num) ? 0 : num;
    }
    const [hours, minutes] = timeValue.split(':').map(Number);
    return (hours * 60) + minutes;
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
            if (tripStartDayMinutes >= ruleStartTime && tripStartDayMinutes < ruleEndTime) adjustedDuration += timeAdjustment;
        } else {
            if (tripStartDayMinutes >= ruleStartTime || tripStartDayMinutes < ruleEndTime) adjustedDuration += timeAdjustment;
        }
    });
    return adjustedDuration;
}

function generateFullRouteSchedule(routeDetails) {
    const {
        fromTerminal = 'Start', toTerminal = 'End', busesAssigned, numberOfShifts, dutyDurationHours,
        leg1, leg2, serviceStartTime = '00:00', timeAdjustmentRules = [], crewDutyRules = {},
        isTurnoutFromDepot = false, depotName = 'Depot', depotConnections = {}, frequency: frequencyDetails,
        secondShiftStartTime = '', includeGeneralShift = false, generalShift = {}
    } = routeDetails;

    const numBuses = parseInt(busesAssigned, 10) || 0;
    const numTotalShifts = parseInt(numberOfShifts, 10) || 1;
    const customCallingTimes = routeDetails.customCallingTimes || [];
    const dutyHours = parseFloat(dutyDurationHours) || 8;
    const numGeneralBuses = parseInt(generalShift?.numberOfBuses, 10) || 0;

    const baseLeg1Dur = calculateLegDuration(leg1?.kilometers, leg1?.timePerKm);
    const baseLeg2Dur = calculateLegDuration(leg2?.kilometers, leg2?.timePerKm);
    const totalRoundTripDuration = baseLeg1Dur + baseLeg2Dur;

    const totalBusesForFrequency = numBuses + numGeneralBuses;
    let effectiveFrequency;
    if (frequencyDetails?.type === 'dynamic' && frequencyDetails.dynamicMinutes > 0) {
        effectiveFrequency = Number(frequencyDetails.dynamicMinutes);
    } else {
        effectiveFrequency = totalBusesForFrequency > 0 ? Math.ceil(totalRoundTripDuration / totalBusesForFrequency) : 10;
    }

    
    const allDuties = []; // *** SINGLE, CORRECT DECLARATION ***
    const lastDutyEndTimes = new Map();

    // 1. Handle the main fleet of buses
    for (let i = 0; i < numBuses; i++) {
        const busId = i + 1;
        for (let shiftIndex = 0; shiftIndex < numTotalShifts; shiftIndex++) {
             const busId = i + 1;
            const shiftId = shiftIndex + 1;

            const customTime = customCallingTimes.find(
                cct => parseInt(cct.busNumber, 10) === busId && parseInt(cct.shift, 10) === shiftId
            );

            let dutyStart;
            if (customTime?.callingTime) {
                dutyStart = parseTimeToMinutes(customTime.callingTime);
            } else if (i === 0) {
                // First bus in shift: use serviceStartTime or previous shift's end
                if (shiftIndex === 0) {
                    dutyStart = parseTimeToMinutes(serviceStartTime);
                } else {
                    // Find the same bus's duty end in previous shift
                    const prevDuty = allDuties.find(
                        d => d.id === `Bus ${busId} - S${shiftIndex}`
                    );
                    dutyStart = prevDuty ? prevDuty.dutyEndTime : parseTimeToMinutes(serviceStartTime);
                }
            } else {
                // Not first bus in shift: previous bus's (in this shift) actual start + frequency
                dutyStart = prevBusDutyStart + effectiveFrequency;
            }
            prevBusDutyStart = dutyStart;

            const dutyEnd = dutyStart + (dutyHours * 60);
            allDuties.push({ id: `Bus ${busId} - S${shiftId}`, dutyStartTime: dutyStart, dutyEndTime: dutyEnd });
            lastDutyEndTimes.set(busId, dutyEnd);
        }
    }

    // 2. Handle the general shift buses (if any)
    if (numGeneralBuses > 0 && generalShift.startTime) {
        const generalStartTime = parseTimeToMinutes(generalShift.startTime);
        for (let i = 0; i < numGeneralBuses; i++) {
            const dutyStart = generalStartTime + (i * effectiveFrequency);
            const dutyEnd = dutyStart + (dutyHours * 60);
            allDuties.push({ id: `General Bus ${i + 1} - S1`, dutyStartTime: dutyStart, dutyEndTime: dutyEnd });
        }
    }

    allDuties.sort((a, b) => a.dutyStartTime - b.dutyStartTime);
    allDuties.forEach(duty => {
        duty.schedule = [];
        duty.location = isTurnoutFromDepot ? depotName : fromTerminal;
        duty.availableFromTime = duty.dutyStartTime;
        duty.breakTaken = false;
        duty.tripCount = 0;
        duty.isDone = false;
        duty.schedule.push({ type: 'Calling Time', time: formatMinutesToTime(duty.dutyStartTime), rawTime: duty.dutyStartTime });
        duty.schedule.push({ type: 'Preparation', time: formatMinutesToTime(duty.dutyStartTime + 15), rawTime: duty.dutyStartTime + 15 });
        duty.availableFromTime = duty.dutyStartTime + 15;
    });

    if (isTurnoutFromDepot) {
        allDuties.forEach(duty => {
            const timeToStart = parseFloat(depotConnections.timeFromDepotToStart) || 0;
            const arrivalAtStartTime = duty.availableFromTime + timeToStart;
            duty.schedule.push({ type: 'Depot Movement', legs: [{departureTime: formatMinutesToTime(duty.availableFromTime), arrivalTime: formatMinutesToTime(arrivalAtStartTime), rawDepartureTime: duty.availableFromTime}], rawDepartureTime: duty.availableFromTime });
            duty.availableFromTime = arrivalAtStartTime;
            duty.location = fromTerminal;
        });
    }

    let continueScheduling = true;
    while (continueScheduling) {
        const activeBuses = allDuties.filter(b => !b.isDone);
        if (activeBuses.length === 0) { continueScheduling = false; break; }
        activeBuses.sort((a, b) => a.availableFromTime - b.availableFromTime);
        const busToDispatch = activeBuses[0];

        const { location: departureLocation } = busToDispatch;
        if (!fromTerminal || !toTerminal || (departureLocation !== fromTerminal && departureLocation !== toTerminal)) { busToDispatch.isDone = true; continue; }
        
        let newAvailableTime = busToDispatch.availableFromTime;
        
        // --- IMPLEMENTED BREAK LOGIC ---
        if (crewDutyRules.hasBreak && !busToDispatch.breakTaken && busToDispatch.location === crewDutyRules.breakLocation) {
            const dutyStartTime = busToDispatch.dutyStartTime;
            const currentTimeIntoDuty = busToDispatch.availableFromTime - dutyStartTime;
            
            const breakWindowStart = parseTimeToMinutes(crewDutyRules.breakWindowStart);
            const breakWindowEnd = parseTimeToMinutes(crewDutyRules.breakWindowEnd);
            
            if (currentTimeIntoDuty >= breakWindowStart && currentTimeIntoDuty <= breakWindowEnd) {
                const breakDuration = parseTimeToMinutes(crewDutyRules.breakDuration);
                const layoverAfterBreak = parseTimeToMinutes(crewDutyRules.breakLayoverDuration);
                
                const breakStartTime = busToDispatch.availableFromTime;
                const breakEndTime = breakStartTime + breakDuration;

                if (breakEndTime < busToDispatch.dutyEndTime) {
                    busToDispatch.schedule.push({
                        type: 'Break',
                        location: crewDutyRules.breakLocation,
                        startTime: formatMinutesToTime(breakStartTime),
                        endTime: formatMinutesToTime(breakEndTime),
                        rawTime: breakStartTime 
                    });
                    busToDispatch.breakTaken = true;
                    newAvailableTime = breakEndTime + layoverAfterBreak; 
                }
            }
        }
        busToDispatch.availableFromTime = newAvailableTime;
        // --- END OF BREAK LOGIC ---

        const isReturnTrip = departureLocation === toTerminal;
        const currentLegBaseDur = isReturnTrip ? baseLeg2Dur : baseLeg1Dur;
        if (currentLegBaseDur <= 0 && isReturnTrip) { busToDispatch.isDone = true; continue; }

        const lastDepartureTime = Math.max(...allDuties.map(b => b.schedule.filter(e => e.type === 'Trip' && e.legs[0]?.departureLocation === departureLocation).map(e => e.rawDepartureTime)).flat(), -1);
        const idealDepartureTime = (lastDepartureTime > -1) ? lastDepartureTime + effectiveFrequency : busToDispatch.availableFromTime;
        const actualDepartureTime = busToDispatch.availableFromTime;
        const legDuration = applyTimeAdjustments(actualDepartureTime, currentLegBaseDur, timeAdjustmentRules);
        const legEndTime = actualDepartureTime + legDuration;
        const arrivalLocation = isReturnTrip ? fromTerminal : toTerminal;
        
        const checkingInDuration = 15;
        const lastTripEndTimeAllowed = busToDispatch.dutyEndTime - checkingInDuration;
        let timeToReturnToDepot = 0;
        if (isTurnoutFromDepot) { timeToReturnToDepot = arrivalLocation === fromTerminal ? (parseFloat(depotConnections.timeFromStartToDepot) || 0) : (parseFloat(depotConnections.timeFromEndToDepot) || 0); }
        if (legEndTime + timeToReturnToDepot > lastTripEndTimeAllowed) { busToDispatch.isDone = true; continue; }
        
        const legEvent = { legNumber: isReturnTrip ? 2 : 1, departureTime: formatMinutesToTime(actualDepartureTime), rawDepartureTime: actualDepartureTime, departureLocation, arrivalTime: formatMinutesToTime(legEndTime), arrivalLocation };
        const lastTripEvent = busToDispatch.schedule.slice().reverse().find(e => e.type === 'Trip');
        
        if (isReturnTrip && lastTripEvent && lastTripEvent.legs.length === 1) {
            lastTripEvent.legs.push(legEvent);
            lastTripEvent.rawArrivalTime = legEndTime;
        } else {
            busToDispatch.tripCount++;
            busToDispatch.schedule.push({ type: 'Trip', tripNumber: busToDispatch.tripCount, legs: [legEvent], rawDepartureTime: actualDepartureTime, rawArrivalTime: legEndTime });
        }
        
        busToDispatch.location = arrivalLocation;
        busToDispatch.availableFromTime = legEndTime;
    }

    allDuties.forEach(bus => {
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
    allDuties.forEach(bus => {
        const idParts = bus.id.split(' - ');
        const shiftId = idParts[1];
        const busId = idParts[0];
        if (!finalSchedules[shiftId]) finalSchedules[shiftId] = {};
        finalSchedules[shiftId][busId] = bus.schedule;
    });

    return { schedules: finalSchedules, warnings: [] };
}

module.exports = { generateFullRouteSchedule };
