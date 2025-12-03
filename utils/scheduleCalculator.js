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

function getWindowAdjustment(adjustments, timeInMin) {
    if (!adjustments) return 0;
    for (const win of adjustments) {
        const start = parseTimeToMinutes(win.startTime || win.start || '00:00');
        const end = parseTimeToMinutes(win.endTime || win.end || '23:59');
        const adjustment =
            Number(win.timeAdjustment !== undefined
                ? win.timeAdjustment
                : (win.adjustment !== undefined ? win.adjustment : 0)
            );
        if (timeInMin >= start && timeInMin < end) {
            return adjustment;
        }
    }
    return 0;
}

function generateFullRouteSchedule(routeDetails) {
    const {
        fromTerminal = 'A',
        toTerminal = 'B',
        busesAssigned,
        dutyDurationHours,
        leg1,
        leg2,
        serviceStartTime = '04:00',
        crewDutyRules = {},
        isTurnoutFromDepot = false,
        depotName = 'Depot',
        depotConnections = {},
        frequency: frequencyDetails,
        frequencyAdjustments,
        timeAdjustmentRules,
        generalShift = {}
    } = routeDetails;

    const adjustmentArray = timeAdjustmentRules || frequencyAdjustments || [];
    const numBuses = parseInt(busesAssigned, 10) || 0;
    const dutyHours = parseFloat(dutyDurationHours) || 8;
    const baseLeg1Dur = calculateLegDuration(leg1?.kilometers, leg1?.timePerKm) || 30;
    const baseLeg2Dur = calculateLegDuration(leg2?.kilometers, leg2?.timePerKm) || 30;
    const totalRoundTripDuration = baseLeg1Dur + baseLeg2Dur;
    const baseStart = parseTimeToMinutes(serviceStartTime);

    let baseFrequency;
    if (frequencyDetails?.type === 'dynamic' && frequencyDetails.dynamicMinutes > 0) {
        baseFrequency = Number(frequencyDetails.dynamicMinutes);
    } else {
        baseFrequency = (numBuses ? Math.ceil(totalRoundTripDuration / numBuses) : 12);
    }

    const safetyBreakWindowStart = 150;
    const safetyBreakWindowEnd = 300;
    const breakWindowStart = crewDutyRules?.breakWindowStart
        ? Math.max(parseTimeToMinutes(crewDutyRules.breakWindowStart), safetyBreakWindowStart)
        : safetyBreakWindowStart;
    const breakWindowEnd = safetyBreakWindowEnd;
    const breakDuration = crewDutyRules?.breakDuration
        ? parseTimeToMinutes(crewDutyRules.breakDuration)
        : 30;
    const breakLocation = crewDutyRules?.breakLocation || fromTerminal;
    const callingStaggerMin = 0;

    function snapToGrid(time, start, freq) {
        if (freq <= 0) return time;
        const offset = time - start;
        const remainder = offset % freq;
        if (remainder === 0) return time;
        return time + (freq - remainder);
    }

    function isPeakHour(timeInMinutes) {
        return (timeInMinutes >= 420 && timeInMinutes < 660) ||
            (timeInMinutes >= 960 && timeInMinutes < 1200);
    }

    const globalFromTerminalDepartures = [];
    const globalToTerminalDepartures = [];

    // --- PROCESS DUTY FUNCTION ---
    function processDuty(duty) {
        let retries = 0;
        const maxRetries = 50;
        let isFinalized = false;

        while (!isFinalized) {
            const totalDrift = duty.dutyStartTime - duty.initialDutyStartTime;
            const isFallback = retries >= maxRetries || totalDrift > 15;

            duty.schedule = [];
            // Use provided startLocation or default based on turnout
            duty.location = duty.startLocation || (isTurnoutFromDepot ? depotName : fromTerminal);
            duty.availableFromTime = duty.dutyStartTime;
            duty.breakInserted = false;
            duty.tripCount = 0;
            duty.totalBreakMinutes = 0;

            const currentAttemptDeparturesFrom = [];
            const currentAttemptDeparturesTo = [];

            duty.schedule.push({
                type: 'Calling Time',
                time: formatMinutesToTime(duty.dutyStartTime),
                rawTime: duty.dutyStartTime
            });
            duty.schedule.push({
                type: 'Preparation',
                time: formatMinutesToTime(duty.dutyStartTime + 15),
                rawTime: duty.dutyStartTime + 15
            });
            duty.availableFromTime = duty.dutyStartTime + 15;

            if (duty.location === depotName) {
                const timeToStart = parseFloat(depotConnections.timeFromDepotToStart) || 0;
                const arrivalAtStartTime = duty.availableFromTime + timeToStart;
                duty.schedule.push({
                    type: 'Depot Movement',
                    legs: [{
                        departureTime: formatMinutesToTime(duty.availableFromTime),
                        arrivalTime: formatMinutesToTime(arrivalAtStartTime),
                        rawDepartureTime: duty.availableFromTime
                    }],
                    rawDepartureTime: duty.availableFromTime
                });
                duty.availableFromTime = arrivalAtStartTime;
                duty.location = fromTerminal;
            }

            let prevDeparture = null;
            let conflictFound = false;
            let requiredShift = 0;

            while (true) {
                let currentTime = duty.availableFromTime;

                let proposedDeparture = prevDeparture === null
                    ? currentTime
                    : Math.max(currentTime, prevDeparture + baseFrequency);
                let targetDeparture = snapToGrid(proposedDeparture, baseStart, baseFrequency);

                if (targetDeparture < currentTime) {
                    targetDeparture += baseFrequency;
                    targetDeparture = snapToGrid(targetDeparture, baseStart, baseFrequency);
                }

                const dwellTime = targetDeparture - currentTime;
                const timeOnDuty = currentTime - duty.dutyStartTime;
                const nextLegDur = (duty.location === fromTerminal ? baseLeg1Dur : baseLeg2Dur);
                const roundTripDur = baseLeg1Dur + baseLeg2Dur;

                const totalBreakNeeded = breakDuration;
                const currentBreakTaken = duty.totalBreakMinutes || 0;
                const remainingBreak = totalBreakNeeded - currentBreakTaken;
                const isBreakFullyTaken = remainingBreak <= 0;

                const canStartBreak = timeOnDuty >= 60;
                const mustFinishBreak = (timeOnDuty + nextLegDur) > breakWindowEnd;

                if (!isBreakFullyTaken && duty.location === breakLocation && canStartBreak) {
                    let breakToTake = Math.min(remainingBreak, breakDuration);
                    if (breakToTake > 0) {
                        duty.schedule.push({
                            type: 'Break',
                            location: breakLocation,
                            startTime: formatMinutesToTime(currentTime),
                            endTime: formatMinutesToTime(currentTime + breakToTake),
                            duration: breakToTake,
                            rawTime: currentTime
                        });
                        currentTime += breakToTake;
                        duty.totalBreakMinutes = (duty.totalBreakMinutes || 0) + breakToTake;
                        duty.availableFromTime = currentTime;
                        if (duty.totalBreakMinutes >= totalBreakNeeded) {
                            duty.breakInserted = true;
                        }
                    }
                }

                let nextDepartureTime = prevDeparture === null
                    ? currentTime
                    : Math.max(currentTime, prevDeparture + baseFrequency);

                if (prevDeparture !== null) {
                    nextDepartureTime = snapToGrid(nextDepartureTime, baseStart, baseFrequency);
                }

                const existingDepartures = (duty.location === fromTerminal)
                    ? globalFromTerminalDepartures
                    : globalToTerminalDepartures;

                let actualDepartureTime = nextDepartureTime;

                if (isFallback) {
                    let valid = false;
                    while (!valid) {
                        valid = true;
                        for (const existingTime of existingDepartures) {
                            if (Math.abs(actualDepartureTime - existingTime) < baseFrequency) {
                                actualDepartureTime = existingTime + baseFrequency;
                                actualDepartureTime = snapToGrid(actualDepartureTime, baseStart, baseFrequency);
                                valid = false;
                                break;
                            }
                        }
                    }
                    const forcedDelay = actualDepartureTime - nextDepartureTime;
                    if (forcedDelay > 0) {
                        duty.dutyEndTime += forcedDelay;
                    }
                    nextDepartureTime = actualDepartureTime;
                } else {
                    for (const existingTime of existingDepartures) {
                        if (Math.abs(nextDepartureTime - existingTime) < baseFrequency) {
                            const targetTime = existingTime + baseFrequency;
                            if (targetTime > nextDepartureTime) {
                                requiredShift = Math.max(requiredShift, targetTime - nextDepartureTime);
                                conflictFound = true;
                            }
                        }
                    }
                }

                if (conflictFound && !isFallback) {
                    break;
                }

                if (currentTime > nextDepartureTime) {
                    nextDepartureTime = snapToGrid(currentTime, baseStart, baseFrequency);
                }

                const legAdj = getWindowAdjustment(adjustmentArray, nextDepartureTime) || 0;
                const baseLegDuration = (duty.location === fromTerminal ? baseLeg1Dur : baseLeg2Dur);

                // Removed nonPeakAdj logic to enforce fixed running time
                const legDuration = Math.max(1, baseLegDuration + legAdj);
                const legEndTime = nextDepartureTime + legDuration;
                const arrivalLocation = duty.location === fromTerminal ? toTerminal : fromTerminal;

                let timeToReturnToDepot = 0;
                if (isTurnoutFromDepot) {
                    timeToReturnToDepot = arrivalLocation === fromTerminal
                        ? parseFloat(depotConnections.timeFromStartToDepot) || 0
                        : parseFloat(depotConnections.timeFromEndToDepot) || 0;
                }
                const postBuffer = timeToReturnToDepot + 15;
                const cutoff = duty.dutyEndTime;

                if (legEndTime + postBuffer > cutoff) {
                    break;
                }

                duty.tripCount++;
                duty.schedule.push({
                    type: 'Trip',
                    tripNumber: duty.tripCount,
                    legs: [{
                        legNumber: duty.location === fromTerminal ? 1 : 2,
                        departureTime: formatMinutesToTime(nextDepartureTime),
                        rawDepartureTime: nextDepartureTime,
                        departureLocation: duty.location,
                        arrivalTime: formatMinutesToTime(nextDepartureTime + legDuration),
                        arrivalLocation,
                        legDuration: legDuration
                    }],
                    rawDepartureTime: nextDepartureTime,
                    rawArrivalTime: nextDepartureTime + legDuration,
                });

                if (duty.location === fromTerminal) currentAttemptDeparturesFrom.push(nextDepartureTime);
                else currentAttemptDeparturesTo.push(nextDepartureTime);

                prevDeparture = nextDepartureTime;
                duty.location = arrivalLocation;
                duty.availableFromTime = nextDepartureTime + legDuration;
            }

            if (conflictFound && !isFallback) {
                if (requiredShift > 10) requiredShift = 10;
                duty.dutyStartTime += requiredShift;
                duty.dutyEndTime += requiredShift;
                retries++;
            } else {
                currentAttemptDeparturesFrom.forEach(t => globalFromTerminalDepartures.push(t));
                currentAttemptDeparturesTo.forEach(t => globalToTerminalDepartures.push(t));
                isFinalized = true;
            }
        }

        let currentTime = duty.availableFromTime;
        if (isTurnoutFromDepot && duty.location !== depotName) {
            const timeToDepot = duty.location === fromTerminal
                ? parseFloat(depotConnections.timeFromStartToDepot) || 0
                : parseFloat(depotConnections.timeFromEndToDepot) || 0;
            const arrivalAtDepotTime = currentTime + timeToDepot;
            if (timeToDepot > 0) {
                duty.schedule.push({
                    type: 'Trip to Depot',
                    legs: [{
                        departureTime: formatMinutesToTime(currentTime),
                        arrivalTime: formatMinutesToTime(arrivalAtDepotTime),
                        rawDepartureTime: currentTime,
                        rawArrivalTime: arrivalAtDepotTime,
                    }],
                    rawDepartureTime: currentTime,
                });
                currentTime = arrivalAtDepotTime;
                duty.location = depotName; // Update location to Depot
            }
        }
        const checkingTimeStart = currentTime;
        const actualDutyEndTime = checkingTimeStart + 15;
        duty.schedule.push({ type: 'Checking Time', time: formatMinutesToTime(checkingTimeStart), rawTime: checkingTimeStart });
        duty.schedule.push({ type: 'Duty End', time: formatMinutesToTime(actualDutyEndTime), rawTime: actualDutyEndTime });
        duty.schedule.sort((a, b) => (a.rawTime ?? a.rawDepartureTime) - (b.rawTime ?? b.rawDepartureTime));

        // Update duty state for next shift linkage
        duty.availableFromTime = actualDutyEndTime;
        // duty.location is already updated if went to depot, or remains at terminal
    }

    // --- MAIN EXECUTION ---
    const dutiesS1 = [];
    const dutiesS2 = [];

    for (let i = 0; i < numBuses; i++) {
        const dutyStartS1 = baseStart + i * baseFrequency + i * callingStaggerMin;
        const dutyEndS1 = dutyStartS1 + dutyHours * 60;
        dutiesS1.push({
            id: `Bus ${i + 1} - S1`,
            initialDutyStartTime: dutyStartS1,
            dutyStartTime: dutyStartS1,
            dutyEndTime: dutyEndS1,
            busIndex: i,
            startLocation: isTurnoutFromDepot ? depotName : fromTerminal
        });
    }

    // Process S1
    dutiesS1.forEach(duty => processDuty(duty));

    // Initialize and Process S2
    dutiesS1.forEach((dutyS1, i) => {
        // S2 starts exactly when S1 ends (including Checking Time)
        const s1EndTime = dutyS1.availableFromTime;
        const dutyStartS2 = s1EndTime;
        const dutyEndS2 = dutyStartS2 + dutyHours * 60;

        dutiesS2.push({
            id: `Bus ${i + 1} - S2`,
            initialDutyStartTime: dutyStartS2,
            dutyStartTime: dutyStartS2,
            dutyEndTime: dutyEndS2,
            busIndex: i,
            startLocation: dutyS1.location // Start where S1 ended
        });
    });

    dutiesS2.forEach(duty => processDuty(duty));

    const finalSchedules = {};
    [...dutiesS1, ...dutiesS2].forEach(bus => {
        const idParts = bus.id.split(' - ');
        const shiftId = idParts[1];
        const busId = idParts[0];
        if (!finalSchedules[shiftId]) finalSchedules[shiftId] = {};
        finalSchedules[shiftId][busId] = bus.schedule;
    });

    return { schedules: finalSchedules, warnings: [] };
}

module.exports = { generateFullRouteSchedule };