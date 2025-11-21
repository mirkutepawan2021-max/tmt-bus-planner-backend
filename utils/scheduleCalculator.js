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

function isPeakHour(time) {
    const peakWindows = [
        { start: parseTimeToMinutes("07:00"), end: parseTimeToMinutes("11:00") },
        { start: parseTimeToMinutes("18:00"), end: parseTimeToMinutes("20:00") }
    ];
    return peakWindows.some(w => time >= w.start && time < w.end);
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
    const extraLayoverPeak = 3;
    const callingStaggerMin = 2;

    // ---- GLOBAL SETS for All Departures ----
    const globalFromTerminalDepartures = new Set();
    const globalToTerminalDepartures = new Set();

    // --- INITIALIZE DUTIES ---
    const allDuties = [];
    for (let i = 0; i < numBuses; i++) {
        const dutyStartS1 = baseStart + i * baseFrequency + i * callingStaggerMin;
        const dutyEndS1 = dutyStartS1 + dutyHours * 60;
        allDuties.push({ id: `Bus ${i + 1} - S1`, dutyStartTime: dutyStartS1, dutyEndTime: dutyEndS1 });

        const dutyStartS2 = dutyEndS1;
        const dutyEndS2 = dutyStartS2 + dutyHours * 60;
        allDuties.push({ id: `Bus ${i + 1} - S2`, dutyStartTime: dutyStartS2, dutyEndTime: dutyEndS2 });
    }
    allDuties.sort((a, b) => a.dutyStartTime - b.dutyStartTime);

    allDuties.forEach(duty => {
        duty.schedule = [];
        duty.location = isTurnoutFromDepot ? depotName : fromTerminal;
        duty.availableFromTime = duty.dutyStartTime;
        duty.breakInserted = false;
        duty.tripCount = 0;
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
    });

    if (isTurnoutFromDepot) {
        allDuties.forEach(duty => {
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
        });
    }

    // ---- MAIN SCHEDULING LOOP with GLOBAL DEDUPLICATION ----
    allDuties.forEach(duty => {
        let prevDeparture = null;
        while (true) {
            let currentTime = duty.availableFromTime;
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

            let nextDepartureTime = prevDeparture === null
                ? currentTime
                : Math.max(currentTime, prevDeparture + baseFrequency);

            if (isPeakHour(nextDepartureTime)) nextDepartureTime += extraLayoverPeak;

            const legAdj = getWindowAdjustment(adjustmentArray, nextDepartureTime) || 0;
            const baseLegDuration = (duty.location === fromTerminal ? baseLeg1Dur : baseLeg2Dur);
            const legDuration = Math.max(1, baseLegDuration + legAdj);

            // ---- GLOBAL DUPLICATE CHECK (STRICT) ----
            let directionSet = (duty.location === fromTerminal) ? globalFromTerminalDepartures : globalToTerminalDepartures;
            let depTimeStr = formatMinutesToTime(nextDepartureTime);

            while (directionSet.has(depTimeStr)) {
                nextDepartureTime += 1; // Shift by 1 min until unique for all buses
                depTimeStr = formatMinutesToTime(nextDepartureTime);
            }
            directionSet.add(depTimeStr);

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
            if (legEndTime + postBuffer > cutoff)
                break;

            duty.tripCount++;
            duty.schedule.push({
                type: 'Trip',
                tripNumber: duty.tripCount,
                legs: [{
                    legNumber: duty.location === fromTerminal ? 1 : 2,
                    departureTime: depTimeStr,
                    rawDepartureTime: nextDepartureTime,
                    departureLocation: duty.location,
                    arrivalTime: formatMinutesToTime(nextDepartureTime + legDuration),
                    arrivalLocation,
                    legDuration: legDuration
                }],
                rawDepartureTime: nextDepartureTime,
                rawArrivalTime: nextDepartureTime + legDuration,
            });

            prevDeparture = nextDepartureTime;
            duty.location = arrivalLocation;
            duty.availableFromTime = nextDepartureTime + legDuration;
        }
    });

    allDuties.forEach(bus => {
        let currentTime = bus.availableFromTime;
        if (isTurnoutFromDepot && bus.location !== depotName) {
            const timeToDepot = bus.location === fromTerminal
                ? parseFloat(depotConnections.timeFromStartToDepot) || 0
                : parseFloat(depotConnections.timeFromEndToDepot) || 0;
            const arrivalAtDepotTime = currentTime + timeToDepot;
            if (timeToDepot > 0) {
                bus.schedule.push({
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
        bus.schedule.push({ type: 'Checking Time', time: formatMinutesToTime(checkingTimeStart), rawTime: checkingTimeStart });
        bus.schedule.push({ type: 'Duty End', time: formatMinutesToTime(actualDutyEndTime), rawTime: actualDutyEndTime });
        bus.schedule.sort((a, b) => (a.rawTime ?? a.rawDepartureTime) - (b.rawTime ?? b.rawDepartureTime));
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
