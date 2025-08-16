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
        if (ruleStartTime <= ruleEndTime) {
            if (tripStartDayMinutes >= ruleStartTime && tripStartDayMinutes < ruleEndTime) {
                adjustedDuration += rule.timeAdjustment;
            }
        } else {
            if (tripStartDayMinutes >= ruleStartTime || tripStartDayMinutes < ruleEndTime) {
                adjustedDuration += rule.timeAdjustment;
            }
        }
    });
    return adjustedDuration;
}

// --- *** FINAL, TRUE SEQUENTIAL DISPATCHER ENGINE *** ---
function generateFullRouteSchedule(routeDetails) {
    const {
        fromTerminal, toTerminal, leg1, leg2, busesAssigned, numberOfShifts,
        serviceStartTime, dutyDurationHours, timeAdjustmentRules, crewDutyRules
    } = routeDetails;
    
    const overallWarnings = [];
    if (!busesAssigned || busesAssigned <= 0) {
        return { schedules: {}, warnings: ["Buses Assigned must be greater than 0."] };
    }

    const baseLeg1Dur = calculateLegDuration(leg1.kilometers, leg1.timePerKm);
    const baseLeg2Dur = leg2 ? calculateLegDuration(leg2.kilometers, leg2.timePerKm) : 0;
    
    // 1. Initialize Bus States
    let busStates = [];
    for (let i = 0; i < busesAssigned * numberOfShifts; i++) {
        const busNumber = (i % busesAssigned) + 1;
        const shiftNumber = Math.floor(i / busesAssigned) + 1;
        const dutyStart = parseTimeToMinutes(serviceStartTime) + (shiftNumber - 1) * (dutyDurationHours * 60);
        
        const busState = {
            id: `Bus ${busNumber} - S${shiftNumber}`,
            schedule: [],
            location: fromTerminal,
            availableFromTime: dutyStart + 15, // Ready after prep
            dutyStartTime: dutyStart,
            dutyEndTime: dutyStart + (dutyDurationHours * 60),
            breakTaken: false,
            tripCount: 0,
            isDone: false,
        };
        busState.schedule.push({ type: 'Calling Time', time: formatMinutesToTime(dutyStart), rawTime: dutyStart });
        busState.schedule.push({ type: 'Preparation', time: formatMinutesToTime(dutyStart + 15), rawTime: dutyStart + 15 });
        busStates.push(busState);
    }
    
    // 2. Dispatcher Loop
    const lastDepartureTimes = { [fromTerminal]: -1, [toTerminal]: -1 };
    let continueScheduling = true;

    while (continueScheduling) {
        // Find the bus with the absolute earliest availability time
        const nextBusIdx = busStates
            .map((bus, index) => ({ ...bus, index }))
            .filter(b => !b.isDone)
            .sort((a, b) => a.availableFromTime - b.availableFromTime)[0]?.index;

        if (nextBusIdx === undefined) {
            continueScheduling = false;
            break;
        }

        const busToDispatch = busStates[nextBusIdx];
        const departureLocation = busToDispatch.location;
        const arrivalLocation = departureLocation === fromTerminal ? toTerminal : fromTerminal;
        const isReturnTrip = departureLocation === toTerminal;
        
        const baseLegDur = isReturnTrip ? baseLeg2Dur : baseLeg1Dur;
        if (baseLegDur <= 0 && isReturnTrip) {
            busToDispatch.isDone = true;
            continue;
        }
        
        // --- Dynamic Headway & Cascading Delay ---
        const tempDepartureTime = busToDispatch.availableFromTime;
        const tempLeg1 = applyTimeAdjustments(tempDepartureTime, baseLeg1Dur, timeAdjustmentRules);
        const tempLeg2 = baseLeg2Dur > 0 ? applyTimeAdjustments(tempDepartureTime + tempLeg1, baseLeg2Dur, timeAdjustmentRules) : 0;
        const currentRoundTripTime = tempLeg1 + tempLeg2;
        const headway = Math.ceil((currentRoundTripTime > 0 ? currentRoundTripTime : tempLeg1) / busesAssigned);
        
        const idealDepartureTime = (lastDepartureTimes[departureLocation] > -1) ? lastDepartureTimes[departureLocation] + headway : tempDepartureTime;
        const actualDepartureTime = Math.max(idealDepartureTime, busToDispatch.availableFromTime);

        if (actualDepartureTime >= busToDispatch.dutyEndTime) {
            busToDispatch.isDone = true;
            continue;
        }

        lastDepartureTimes[departureLocation] = actualDepartureTime;
        
        // --- Calculate One Leg of the Trip ---
        const legDuration = applyTimeAdjustments(actualDepartureTime, baseLegDur, timeAdjustmentRules);
        const legEndTime = actualDepartureTime + legDuration;
        
        if (legEndTime >= busToDispatch.dutyEndTime) {
             busToDispatch.isDone = true;
             continue;
        }
        
        // --- Add Trip to Schedule ---
        const legEvent = { legNumber: isReturnTrip ? 2 : 1, departureTime: formatMinutesToTime(actualDepartureTime), departureLocation, arrivalTime: formatMinutesToTime(legEndTime), arrivalLocation };
        
        // Group legs into a single trip event
        const lastEvent = busToDispatch.schedule[busToDispatch.schedule.length-1];
        if (isReturnTrip && lastEvent && lastEvent.type === 'Trip' && lastEvent.legs.length === 1) {
            lastEvent.legs.push(legEvent);
            lastEvent.rawArrivalTime = legEndTime;
        } else {
            busToDispatch.tripCount++;
            busToDispatch.schedule.push({ type: 'Trip', tripNumber: busToDispatch.tripCount, legs: [legEvent], rawDepartureTime: actualDepartureTime, rawArrivalTime: legEndTime });
        }
        
        let newAvailableTime = legEndTime;

        // --- Handle Break ---
        if (crewDutyRules.hasBreak && !busToDispatch.breakTaken && arrivalLocation === crewDutyRules.breakLocation) {
            const elapsedTime = newAvailableTime - busToDispatch.dutyStartTime;
            if (elapsedTime >= crewDutyRules.breakWindowStart && elapsedTime <= crewDutyRules.breakWindowEnd) {
                const breakEndTime = newAvailableTime + crewDutyRules.breakDuration;
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
    
    // 3. Finalize Schedules
    busStates.forEach(bus => {
        bus.schedule.sort((a,b) => (a.rawTime || a.rawDepartureTime) - (b.rawTime || b.rawDepartureTime));
        bus.schedule.push({ type: 'Checking Time', time: formatMinutesToTime(bus.dutyEndTime - 15) });
        bus.schedule.push({ type: 'Duty End', time: formatMinutesToTime(bus.dutyEndTime) });
    });

    // 4. Reformat for Frontend
    const finalSchedules = {};
    busStates.forEach(bus => {
        const [busId, shiftId] = bus.id.split(' - ');
        if (!finalSchedules[shiftId]) finalSchedules[shiftId] = {};
        finalSchedules[shiftId][bus.id] = bus.schedule;
    });

    return { schedules: finalSchedules, warnings: overallWarnings };
}

module.exports = { generateFullRouteSchedule };
