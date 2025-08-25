const mongoose = require('mongoose');

// --- Sub-schemas ---
const LegSchema = new mongoose.Schema({
    kilometers: { type: String, required: true },
    timePerKm: { type: String, required: true, default: '5' }
}, { _id: false });

const DepotConnectionsSchema = new mongoose.Schema({
    timeFromDepotToStart: { type: String, default: '' },
    timeFromDepotToEnd: { type: String, default: '' },
    timeFromStartToDepot: { type: String, default: '' },
    timeFromEndToDepot: { type: String, default: '' }
}, { _id: false });

const CrewDutyRulesSchema = new mongoose.Schema({
    hasBreak: { type: Boolean, default: true },
    breakLocation: { type: String, default: '' },
    breakDuration: { type: String, default: '30' },
    breakWindowStart: { type: String, default: '150' },
    breakWindowEnd: { type: String, default: '240' },
    breakLayoverDuration: { type: String, default: '0' }
}, { _id: false });

const TimeAdjustmentRuleSchema = new mongoose.Schema({
    startTime: String,
    endTime: String,
    timeAdjustment: String
});

const FrequencySchema = new mongoose.Schema({
    type: { type: String, enum: ['standard', 'dynamic'], default: 'standard', required: true },
    dynamicMinutes: { type: String, default: '' }
}, { _id: false });


// --- Main Schema ---
const busRouteSchema = new mongoose.Schema({
    routeNumber: { type: String, required: true, trim: true },
    routeName: { type: String, required: true, trim: true },
    fromTerminal: { type: String, required: true },
    toTerminal: { type: String, required: true },
    leg1: LegSchema,
    leg2: LegSchema,
    depotName: { type: String },
    isTurnoutFromDepot: { type: Boolean, default: false },
    depotConnections: DepotConnectionsSchema,
    busesAssigned: { type: String, required: true },
    serviceStartTime: { type: String, default: '06:00' },
    dutyDurationHours: { type: Number, default: 8 },
    numberOfShifts: { type: Number, default: 1 },
    timeAdjustmentRules: [TimeAdjustmentRuleSchema],
    crewDutyRules: CrewDutyRulesSchema,
    frequency: FrequencySchema,
    
    // --- NEW FIELDS ---
    hasDynamicSecondShift: { type: Boolean, default: false },
    secondShiftStartTime: { type: String, default: '' }

}, { 
    timestamps: true,
    minimize: false 
});

module.exports = mongoose.model('BusRoute', busRouteSchema);
