// backend/utils/scheduleCalculator.js

function calculateLegDuration(kilometers, timePerKm) {
    if (kilometers < 0) { throw new Error("Leg kilometers cannot be negative."); }
    if (timePerKm <= 0) { throw new Error("Time per kilometer must be a positive value."); }
    return kilometers * timePerKm;
}

function parseTimeToMinutes(timeValue) {
    if (typeof timeValue === 'number') return timeValue;
    if (typeof timeValue !== 'string' || !timeValue.includes(':')) {
        const num = Number(timeValue);
        if (!isNaN(num)) return num;
        return 0;
    }
    const [hours, minutes] = timeValue.split(':').map(Number);
    return hours * 60 + minutes;
}

function formatMinutesToTime(totalMinutes) {
    totalMinutes = (totalMinutes % 1440 + 1440) % 1440;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function applyTimeAdjustments(tripStartTimeMinutes, baseTripDurationMinutes, adjustmentRules) {
    let adjustedDuration = baseTripDurationMinutes;
    if (!Array.isArray(adjustmentRules)) { return adjustedDuration; }
    adjustmentRules.forEach(rule => {
        const ruleStartTime = parseTimeToMinutes(rule.startTime);
        const ruleEndTime = parseTimeToMinutes(rule.endTime);
        if (ruleStartTime <= ruleEndTime) {
            if (tripStartTimeMinutes >= ruleStartTime && tripStartTimeMinutes < ruleEndTime) {
                adjustedDuration += rule.timeAdjustment;
            }
        } else {
            if (tripStartTimeMinutes >= ruleStartTime || tripStartTimeMinutes < ruleEndTime) {
                adjustedDuration += rule.timeAdjustment;
            }
        }
    });
    return adjustedDuration;
}

function generateSingleBusDutySchedule(routeDetails, busShiftId, serviceStartTimeMinutes, dutyDurationMinutes) {
    const {
        fromTerminal, toTerminal, leg1, leg2,
        timeAdjustmentRules, crewDutyRules, depotName,
        isTurnoutFromDepot, depotConnections
    } = routeDetails;

    const warnings = []; 
    const targetDutyEndTimeAbsolute = serviceStartTimeMinutes + dutyDurationMinutes;
    const CHECKING_TIME_DURATION = 15;
    const MIN_DUTY_DURATION = 7 * 60;

    let preTripEvents = [];
    let currentBusTime = serviceStartTimeMinutes;
    preTripEvents.push({ type: 'Calling Time', time: formatMinutesToTime(currentBusTime), location: depotName, rawTime: currentBusTime });
    currentBusTime += 15;
    preTripEvents.push({ type: 'Preparation', time: formatMinutesToTime(currentBusTime), location: depotName, rawTime: currentBusTime });

    if (isTurnoutFromDepot) {
        const timeToStart = depotConnections.timeFromDepotToStart || 0;
        preTripEvents.push({ type: 'Depot Movement', subType: 'Departure', time: formatMinutesToTime(currentBusTime), location: depotName, rawTime: currentBusTime });
        currentBusTime += timeToStart;
        preTripEvents.push({ type: 'Depot Movement', subType: 'Arrival', time: formatMinutesToTime(currentBusTime), location: fromTerminal, rawTime: currentBusTime });
    }

    let trips = [];
    let tripCounter = 0;
    while (true) {
        tripCounter++;
        let tripStartTime = currentBusTime;
        const timeToDepotFromStart = isTurnoutFromDepot ? (depotConnections.timeFromStartToDepot || 0) : 0;
        const timeToDepotFromEnd = isTurnoutFromDepot ? (depotConnections.timeFromEndToDepot || 0) : 0;
        const baseLeg1Duration = calculateLegDuration(leg1.kilometers, leg1.timePerKm);
        const baseLeg2Duration = leg2 ? calculateLegDuration(leg2.kilometers, leg2.timePerKm) : 0;
        const adjustedLeg1Dur = applyTimeAdjustments(tripStartTime, baseLeg1Duration, timeAdjustmentRules);
        const leg2StartTime = tripStartTime + adjustedLeg1Dur;
        const adjustedLeg2Dur = baseLeg2Duration > 0 ? applyTimeAdjustments(leg2StartTime, baseLeg2Duration, timeAdjustmentRules) : 0;
        const adjustedRoundTripDur = adjustedLeg1Dur + adjustedLeg2Dur;
        const costOfFullTrip = adjustedRoundTripDur + timeToDepotFromStart + CHECKING_TIME_DURATION;
        const costOfHalfTrip = adjustedLeg1Dur + timeToDepotFromEnd + CHECKING_TIME_DURATION;
        
        let tripEvent = null;
        if (baseLeg2Duration > 0 && (tripStartTime + costOfFullTrip <= targetDutyEndTimeAbsolute)) {
            tripEvent = {
                type: 'Trip', tripNumber: tripCounter,
                legs: [
                    { legNumber: 1, departureTime: formatMinutesToTime(tripStartTime), departureLocation: fromTerminal, arrivalTime: formatMinutesToTime(leg2StartTime), arrivalLocation: toTerminal },
                    { legNumber: 2, departureTime: formatMinutesToTime(leg2StartTime), departureLocation: toTerminal, arrivalTime: formatMinutesToTime(leg2StartTime + adjustedLeg2Dur), arrivalLocation: fromTerminal }
                ],
                rawDepartureTime: tripStartTime, rawArrivalTime: leg2StartTime + adjustedLeg2Dur
            };
        } else if (tripStartTime + costOfHalfTrip <= targetDutyEndTimeAbsolute) {
             tripEvent = {
                type: 'Trip', tripNumber: tripCounter,
                legs: [{ legNumber: 1, departureTime: formatMinutesToTime(tripStartTime), departureLocation: fromTerminal, arrivalTime: formatMinutesToTime(tripStartTime + adjustedLeg1Dur), arrivalLocation: toTerminal }],
                rawDepartureTime: tripStartTime, rawArrivalTime: tripStartTime + adjustedLeg1Dur
            };
        } else {
            break;
        }
        trips.push(tripEvent);
        currentBusTime = tripEvent.rawArrivalTime;
    }

    let combinedEvents = [...preTripEvents, ...trips];
    let breakInserted = false;

    if (crewDutyRules.hasBreak) {
        let breakInsertionIndex = -1;
        let breakStartTime = 0;
        
        for (let i = 0; i < combinedEvents.length; i++) {
            const event = combinedEvents[i];
            if (event.type === 'Trip') {
                for(const leg of event.legs) {
                    const arrivalTime = parseTimeToMinutes(leg.arrivalTime);
                    const elapsedTime = arrivalTime - serviceStartTimeMinutes;
                    
                    if (leg.arrivalLocation === crewDutyRules.breakLocation && 
                        elapsedTime >= crewDutyRules.breakWindowStart && 
                        elapsedTime <= crewDutyRules.breakWindowEnd) 
                    {
                        breakInsertionIndex = i + 1;
                        breakStartTime = arrivalTime;
                        break;
                    }
                }
            }
            if(breakInsertionIndex !== -1) break;
        }
        
        if (breakInsertionIndex !== -1) {
            const breakDuration = crewDutyRules.breakDuration;
            const breakLayover = crewDutyRules.breakLayoverDuration || 0;
            const totalBreakImpact = breakDuration + breakLayover;
            
            const breakEvent = {
                type: 'Break', startTime: formatMinutesToTime(breakStartTime), endTime: formatMinutesToTime(breakStartTime + breakDuration),
                location: crewDutyRules.breakLocation, description: `Break @ ${crewDutyRules.breakLocation}`,
                duration: breakDuration, layover: breakLayover, rawTime: breakStartTime
            };
            
            combinedEvents.splice(breakInsertionIndex, 0, breakEvent);
            
            for (let i = breakInsertionIndex; i < combinedEvents.length; i++) {
                let event = combinedEvents[i];
                 if(i > breakInsertionIndex) {
                    if (event.type === 'Trip') {
                        event.rawDepartureTime += totalBreakImpact;
                        event.rawArrivalTime += totalBreakImpact;
                        event.legs.forEach(leg => {
                            leg.departureTime = formatMinutesToTime(parseTimeToMinutes(leg.departureTime) + totalBreakImpact);
                            leg.arrivalTime = formatMinutesToTime(parseTimeToMinutes(leg.arrivalTime) + totalBreakImpact);
                        });
                    } else if (event.rawTime) {
                        event.rawTime += totalBreakImpact;
                        event.time = formatMinutesToTime(event.rawTime);
                    }
                 }
            }
            breakInserted = true;
        }
    }

    let finalEvents = combinedEvents;
    const lastEvent = finalEvents.length > 0 ? finalEvents[finalEvents.length - 1] : null;
    currentBusTime = lastEvent ? (lastEvent.rawArrivalTime || lastEvent.rawTime || parseTimeToMinutes(lastEvent.endTime)) : currentBusTime;
    let lastKnownLocation = lastEvent ? (lastEvent.legs ? lastEvent.legs[lastEvent.legs.length - 1].arrivalLocation : lastEvent.location) : fromTerminal;

    if (isTurnoutFromDepot && lastKnownLocation !== depotName) {
        const timeToDepotFromStart = depotConnections.timeFromStartToDepot || 0;
        const timeToDepotFromEnd = depotConnections.timeFromEndToDepot || 0;
        const timeToDepotNow = (lastKnownLocation === fromTerminal) ? timeToDepotFromStart : timeToDepotFromEnd;
        if (currentBusTime + timeToDepotNow + CHECKING_TIME_DURATION <= targetDutyEndTimeAbsolute) {
             finalEvents.push({
                type: 'Trip to Depot', description: `Final return to ${depotName} from ${lastKnownLocation}`,
                departureTime: formatMinutesToTime(currentBusTime), departureLocation: lastKnownLocation,
                arrivalTime: formatMinutesToTime(currentBusTime + timeToDepotNow), arrivalLocation: depotName
            });
            currentBusTime += timeToDepotNow;
        }
    }
    
    if (crewDutyRules.hasBreak && !breakInserted) {
        warnings.push(`CRITICAL: A mandatory break could not be scheduled within the required window.`);
    }

    let finalDutyTime = Math.max(currentBusTime + CHECKING_TIME_DURATION, serviceStartTimeMinutes + MIN_DUTY_DURATION);
    finalEvents.push({ type: 'Checking Time', time: formatMinutesToTime(finalDutyTime - CHECKING_TIME_DURATION), location: depotName });
    finalEvents.push({ type: 'Duty End', time: formatMinutesToTime(finalDutyTime), location: depotName });

    return { busShiftId, schedule: finalEvents, warnings };
}

function generateFullRouteSchedule(routeDetails) {
    const { busesAssigned, serviceStartTime, dutyDurationHours, numberOfShifts, leg1, leg2 } = routeDetails;
    const allSchedules = {};
    const overallWarnings = [];

    if (!busesAssigned || !numberOfShifts) {
        overallWarnings.push("Buses Assigned and Number of Shifts must be greater than 0.");
        return { schedules: {}, warnings: overallWarnings };
    }
    
    const baseLeg1Dur = calculateLegDuration(leg1.kilometers, leg1.timePerKm);
    const baseLeg2Dur = leg2 ? calculateLegDuration(leg2.kilometers, leg2.timePerKm) : 0;
    const baseRoundTripDuration = baseLeg1Dur + baseLeg2Dur;
    const frequencyMinutes = Math.ceil((baseRoundTripDuration > 0 ? baseRoundTripDuration : baseLeg1Dur) / busesAssigned);
    let shiftStartTimeMinutes = parseTimeToMinutes(serviceStartTime);
    const dutyDurationMinutes = dutyDurationHours * 60;

    for (let shiftIndex = 0; shiftIndex < numberOfShifts; shiftIndex++) {
        const shiftName = `S${shiftIndex + 1}`;
        allSchedules[shiftName] = {};
        for (let i = 0; i < busesAssigned; i++) {
            const busStartTime = shiftStartTimeMinutes + (i * frequencyMinutes);
            const busShiftId = `Bus ${i + 1} - ${shiftName}`;
            const { schedule, warnings: singleBusWarnings } = generateSingleBusDutySchedule(routeDetails, busShiftId, busStartTime, dutyDurationMinutes);
            allSchedules[shiftName][busShiftId] = schedule;
            if (singleBusWarnings.length > 0) {
                overallWarnings.push(...singleBusWarnings.map(w => `[${busShiftId}] ${w}`));
            }
        }
        shiftStartTimeMinutes += dutyDurationMinutes;
    }
    return { schedules: allSchedules, warnings: overallWarnings };
}

module.exports = { generateFullRouteSchedule };
