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
        // Standard mode: Total Round Trip / Number of Buses
        baseFrequency = (numBuses ? Math.ceil(totalRoundTripDuration / numBuses) : 12);
    }

    // BREAK RULES
    // User Requirement: Break between 2.5h (150m) and 5h (300m)
    const safetyBreakWindowStart = 150;
    const safetyBreakWindowEnd = 300;

    const breakWindowStart = crewDutyRules?.breakWindowStart
        ? Math.max(parseTimeToMinutes(crewDutyRules.breakWindowStart), safetyBreakWindowStart)
        : safetyBreakWindowStart;

    // We enforce the 5h limit regardless of user input if it's too loose, 
    // but typically we trust the user input unless it's missing. 
    // However, the user explicitly asked to "take care of" the 5h limit.
    const breakWindowEnd = safetyBreakWindowEnd;

    const breakDuration = crewDutyRules?.breakDuration
        ? parseTimeToMinutes(crewDutyRules.breakDuration)
        : 30;
    const breakLocation = crewDutyRules?.breakLocation || fromTerminal;
    const callingStaggerMin = 0; // Constant frequency: no stagger

    // Helper to snap time to the nearest frequency grid
    function snapToGrid(time, start, freq) {
        if (freq <= 0) return time;
        const offset = time - start;
        const remainder = offset % freq;
        if (remainder === 0) return time;
        return time + (freq - remainder);
    }

    // Helper to check for Peak Hours (7-11 AM, 4-8 PM)
    function isPeakHour(timeInMinutes) {
        // 07:00 = 420, 11:00 = 660
        // 16:00 = 960, 20:00 = 1200
        return (timeInMinutes >= 420 && timeInMinutes < 660) ||
            (timeInMinutes >= 960 && timeInMinutes < 1200);
    }

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
            const totalDrift = duty.dutyStartTime - duty.initialDutyStartTime;
            const isFallback = retries >= maxRetries || totalDrift > 15;

            // 1. Reset State for this attempt
            duty.schedule = [];
            duty.location = isTurnoutFromDepot ? depotName : fromTerminal;
            duty.availableFromTime = duty.dutyStartTime;
            duty.breakInserted = false;
            duty.tripCount = 0;
            duty.totalBreakMinutes = 0; // Reset split break tracking

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

                // ---- SMART BREAK & SPLIT LOGIC ----
                // Calculate the Target Departure Time (Grid Slot) to see our available Dwell Time
                let proposedDeparture = prevDeparture === null
                    ? currentTime
                    : Math.max(currentTime, prevDeparture + baseFrequency);
                let targetDeparture = snapToGrid(proposedDeparture, baseStart, baseFrequency);

                // If the target is in the past (due to processing), move to next slot
                if (targetDeparture < currentTime) {
                    targetDeparture += baseFrequency;
                    targetDeparture = snapToGrid(targetDeparture, baseStart, baseFrequency);
                }

                const dwellTime = targetDeparture - currentTime;
                const timeOnDuty = currentTime - duty.dutyStartTime;
                const nextLegDur = (duty.location === fromTerminal ? baseLeg1Dur : baseLeg2Dur);
                const roundTripDur = baseLeg1Dur + baseLeg2Dur;

                // Break Status
                const totalBreakNeeded = breakDuration; // e.g. 30
                const currentBreakTaken = duty.totalBreakMinutes || 0;
                const remainingBreak = totalBreakNeeded - currentBreakTaken;
                const isBreakFullyTaken = remainingBreak <= 0;

                const canStartBreak = timeOnDuty >= 60; // Allow early starts for splitting
                const mustFinishBreak = (timeOnDuty + nextLegDur) > breakWindowEnd;

                // Peak Trap Check
                const willLandInPeak = (
                    ((currentTime + roundTripDur) >= 420 && (currentTime + roundTripDur) < 660) ||
                    ((currentTime + roundTripDur) >= 960 && (currentTime + roundTripDur) < 1200)
                );

                if (!isBreakFullyTaken && duty.location === breakLocation && canStartBreak) {
                    let breakToTake = 0;

                    // Take as much break as needed
                    breakToTake = Math.min(remainingBreak, breakDuration);

                    // If we have something to take, record it
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

                        // If we finished the requirement, mark as done
                        if (duty.totalBreakMinutes >= totalBreakNeeded) {
                            duty.breakInserted = true;
                        }
                    }
                }

                // Proposed Departure - Snap to Grid!
                let nextDepartureTime = prevDeparture === null
                    ? currentTime
                    : Math.max(currentTime, prevDeparture + baseFrequency);

                // Enforce Grid Snapping
                if (prevDeparture !== null) {
                    nextDepartureTime = snapToGrid(nextDepartureTime, baseStart, baseFrequency);
                }

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
                                // Ensure the new time is also on grid
                                actualDepartureTime = snapToGrid(actualDepartureTime, baseStart, baseFrequency);
                                valid = false;
                                break; // Re-check against all because we moved
                            }
                        }
                    }

                    // Extend duty end time by the amount we were forced to wait
                    const forcedDelay = actualDepartureTime - nextDepartureTime;
                    if (forcedDelay > 0) {
                        duty.dutyEndTime += forcedDelay;
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

                // If currentTime is still ahead of nextDepartureTime (due to break),
                // we need to snap currentTime to the next valid grid slot
                if (currentTime > nextDepartureTime) {
                    nextDepartureTime = snapToGrid(currentTime, baseStart, baseFrequency);
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
                if (requiredShift > 10) requiredShift = 10; // Cap shift at 10 mins

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