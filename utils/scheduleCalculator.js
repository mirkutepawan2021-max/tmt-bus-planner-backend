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
    const baseFrequency = frequencyDetails?.dynamicMinutes > 0
        ? Number(frequencyDetails.dynamicMinutes)
        : (numBuses ? Math.ceil(totalRoundTripDuration / numBuses) : 12);

    const breakWindowStart = crewDutyRules?.breakWindowStart
        ? parseTimeToMinutes(crewDutyRules.breakWindowStart)
        : 3.5 * 60;
    const breakDuration = crewDutyRules?.breakDuration
        ? parseTimeToMinutes(crewDutyRules.breakDuration)
        : 30;
    const breakLocation = crewDutyRules?.breakLocation || fromTerminal;
    const callingStaggerMin = 2;

    // ---- GLOBAL LISTS of Finalized Departures ----
    const globalFromTerminalDepartures = [];
    const globalToTerminalDepartures = [];

    // --- INITIALIZE DUTIES ---
    const allDuties = [];
    for (let i = 0; i < numBuses; i++) {
        const dutyStartS1 = baseStart + i * baseFrequency + i * callingStaggerMin;
        const dutyEndS1 = dutyStartS1 + dutyHours * 60;
        allDuties.push({
            id: `Bus ${i + 1} - S1`,
            initialDutyStartTime: dutyStartS1,
            dutyStartTime: dutyStartS1,
            dutyEndTime: dutyEndS1
        });

        const dutyStartS2 = dutyEndS1;
        const dutyEndS2 = dutyStartS2 + dutyHours * 60;
        allDuties.push({
            id: `Bus ${i + 1} - S2`,
            initialDutyStartTime: dutyStartS2,
            dutyStartTime: dutyStartS2,
            dutyEndTime: dutyEndS2
        });
    }
    allDuties.sort((a, b) => a.dutyStartTime - b.dutyStartTime);

    // ---- MAIN BUS PROCESSING LOOP (Fit and Retry with Fallback) ----
    allDuties.forEach((duty, busIndex) => {
        let retries = 0;
        const maxRetries = 50;
        let isFinalized = false;

        // Loop runs until finalized OR we run out of retries (then we force fit in fallback mode)
        while (!isFinalized) {
            const isFallback = retries >= maxRetries;

            // 1. Reset State for this attempt
            duty.schedule = [];
            duty.location = isTurnoutFromDepot ? depotName : fromTerminal;
            duty.availableFromTime = duty.dutyStartTime;
            duty.breakInserted = false;
            duty.tripCount = 0;

            const currentAttemptDeparturesFrom = [];
            const currentAttemptDeparturesTo = [];

            // 2. Generate Schedule (Calling Time & Prep)
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

            if (isTurnoutFromDepot) {
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

            // 3. Generate Trips
            let prevDeparture = null;
            let conflictFound = false;
            let requiredShift = 0;

            while (true) {
                let currentTime = duty.availableFromTime;

                // Break Logic
                if (
                    !duty.breakInserted &&
                    currentTime >= (duty.dutyStartTime + breakWindowStart) &&
                    duty.location === breakLocation
                ) {
                    duty.schedule.push({
                        type: 'Break',
                        location: breakLocation,
                        startTime: formatMinutesToTime(currentTime),
                        endTime: formatMinutesToTime(currentTime + breakDuration),
                        rawTime: currentTime
                    });
                    duty.availableFromTime = currentTime + breakDuration;
                    duty.breakInserted = true;
                    currentTime = duty.availableFromTime;
                }

                // Proposed Departure
                let nextDepartureTime = prevDeparture === null
                    ? currentTime
                    : Math.max(currentTime, prevDeparture + baseFrequency);

                // ---- CONFLICT CHECK ----
                const existingDepartures = (duty.location === fromTerminal)
                    ? globalFromTerminalDepartures
                    : globalToTerminalDepartures;

                let actualDepartureTime = nextDepartureTime;

                if (isFallback) {
                    // FALLBACK MODE: Force fit by shifting individual trip
                    // Find the next valid slot that respects baseFrequency against ALL existing
                    let valid = false;
                    while (!valid) {
                        valid = true;
                        for (const existingTime of existingDepartures) {
                            if (Math.abs(actualDepartureTime - existingTime) < baseFrequency) {
                                // Conflict! Push forward to valid slot
                                actualDepartureTime = existingTime + baseFrequency;
                                valid = false;
                                break; // Re-check against all because we moved
                            }
                        }
                    }
                    // Update nextDepartureTime to the valid one
                    nextDepartureTime = actualDepartureTime;
                } else {
                    // RETRY MODE: Check for conflict and abort if found
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
                    break; // Stop generating trips, restart duty
                }

                // Calculate Leg Duration
                const legAdj = getWindowAdjustment(adjustmentArray, nextDepartureTime) || 0;
                const baseLegDuration = (duty.location === fromTerminal ? baseLeg1Dur : baseLeg2Dur);
                const legDuration = Math.max(1, baseLegDuration + legAdj);

                const legEndTime = nextDepartureTime + legDuration;
                const arrivalLocation = duty.location === fromTerminal ? toTerminal : fromTerminal;

                // Check Duty End
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

                // Add Trip
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

            // 4. Handle Retry or Finalize
            if (conflictFound && !isFallback) {
                // Apply shift and retry
                if (requiredShift > 30) requiredShift = 30; // Cap shift
                duty.dutyStartTime += requiredShift;
                duty.dutyEndTime += requiredShift;
                retries++;
            } else {
                // Success (or Fallback completion)
                currentAttemptDeparturesFrom.forEach(t => globalFromTerminalDepartures.push(t));
                currentAttemptDeparturesTo.forEach(t => globalToTerminalDepartures.push(t));
                isFinalized = true;
            }
        }

        // Add end-of-duty events
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
            }
        }
        const checkingTimeStart = currentTime;
        const actualDutyEndTime = checkingTimeStart + 15;
        duty.schedule.push({ type: 'Checking Time', time: formatMinutesToTime(checkingTimeStart), rawTime: checkingTimeStart });
        duty.schedule.push({ type: 'Duty End', time: formatMinutesToTime(actualDutyEndTime), rawTime: actualDutyEndTime });
        duty.schedule.sort((a, b) => (a.rawTime ?? a.rawDepartureTime) - (b.rawTime ?? b.rawDepartureTime));
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
